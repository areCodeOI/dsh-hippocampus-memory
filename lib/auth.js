/**
 * API-key authentication and role/namespace authorization.
 *
 * Roles are hierarchical: reader < writer < admin.
 *   reader  — search, list, graph, stats, audit? (no)
 *   writer  — reader + add/update/archive/soft-delete/jobs
 *   admin   — everything: keys, hard delete, import, audit, settings
 *
 * Bootstrap: when HIPPOCAMPUS_TOKEN is set it is an admin bearer token and all
 * requests require authentication. With no token and no keys, loopback requests
 * run as a local admin so the bundled UI works out of the box; set
 * HIPPOCAMPUS_AUTH=required to force authentication even on loopback.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const ROLES = { reader: 1, writer: 2, admin: 3 }

export function roleAtLeast(role, required) {
  return (ROLES[role] ?? 0) >= (ROLES[required] ?? 0)
}

function hashKey(key) {
  return createHash('sha256').update(String(key)).digest('hex')
}

function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (email.length < 3 || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('invalid email')
  }
  return email
}

function hashPassword(password) {
  const value = String(password ?? '')
  if (value.length < 8 || value.length > 200) throw new Error('password must be 8-200 characters')
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(value, salt, 64).toString('hex')
  return `scrypt$${salt}$${hash}`
}

function verifyPassword(password, stored) {
  const [algorithm, salt, expected] = String(stored ?? '').split('$')
  if (algorithm !== 'scrypt' || !salt || !expected) return false
  try {
    const actual = scryptSync(String(password ?? ''), salt, 64)
    const wanted = Buffer.from(expected, 'hex')
    return actual.length === wanted.length && timingSafeEqual(actual, wanted)
  } catch {
    return false
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function normalizeNamespaces(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : ['*']
  const result = []
  for (const raw of list) {
    const ns = String(raw ?? '').trim()
    if (!ns) continue
    if (ns !== '*' && !/^[\w.\-:\u4e00-\u9fff]{1,64}$/u.test(ns)) throw new Error(`invalid namespace: ${ns}`)
    if (!result.includes(ns)) result.push(ns)
    if (result.length >= 32) break
  }
  return result.length ? result : ['*']
}

export class AuthService {
  constructor({ db, bootstrapToken = null, mode = process.env.HIPPOCAMPUS_AUTH ?? 'auto', now = () => Date.now() } = {}) {
    this.db = db
    this.now = now
    this.bootstrapToken = bootstrapToken || null
    this.mode = mode
    if (!['auto', 'required', 'open'].includes(this.mode)) this.mode = 'auto'
    this.required = this.mode === 'required' || Boolean(this.bootstrapToken)
    if (!this.required) this.refreshRequired()
  }

  hasUsers() {
    try {
      return Boolean(this.db.prepare('SELECT 1 FROM users LIMIT 1').get())
    } catch {
      return false
    }
  }

  setupRequired() {
    return !this.hasUsers()
  }

  refreshRequired() {
    // Mem0-style: once an admin account exists, auth is on (loopback included).
    // Before first-run setup, loopback may still administer the local plugin so
    // the setup page can create the admin.
    this.required = this.mode === 'required' || Boolean(this.bootstrapToken) || this.hasUsers()
    return this.required
  }

  get authRequired() {
    return this.required
  }

  userPublic(row) {
    return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at }
  }

  createSession(userId) {
    const token = `hs_${randomBytes(32).toString('base64url')}`
    const now = this.now()
    this.db
      .prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`sess_${randomBytes(6).toString('hex')}`, userId, hashKey(token), now, now + SESSION_TTL_MS, now)
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
    } catch {
      // best effort
    }
    return token
  }

  registerAdmin({ email, password } = {}) {
    if (this.hasUsers()) {
      const error = new Error('setup already completed')
      error.status = 409
      throw error
    }
    const normalized = normalizeEmail(email)
    const passwordHash = hashPassword(password)
    const now = this.now()
    const id = `usr_${randomBytes(6).toString('hex')}`
    this.db
      .prepare('INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, normalized, passwordHash, 'admin', now, now)
    this.required = true
    const token = this.createSession(id)
    return { token, user: this.userPublic({ id, email: normalized, role: 'admin', created_at: now }), expiresIn: SESSION_TTL_MS }
  }

  login({ email, password } = {}) {
    const normalized = normalizeEmail(email)
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(normalized)
    if (!row || !verifyPassword(password, row.password_hash)) {
      const error = new Error('invalid email or password')
      error.status = 401
      throw error
    }
    const token = this.createSession(row.id)
    return { token, user: this.userPublic(row), expiresIn: SESSION_TTL_MS }
  }

  logout(token) {
    if (!token) return false
    const result = this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashKey(token))
    return Number(result.changes ?? 0) > 0
  }

  /** Returns `{ok, auth, reason}`. `auth` has actor/role/namespaces/type. */
  verify(token, { isLoopback = false } = {}) {
    if (token) {
      if (this.bootstrapToken && safeEqual(token, this.bootstrapToken)) {
        return {
          ok: true,
          auth: { actor: 'bootstrap', role: 'admin', namespaces: ['*'], type: 'bootstrap', keyId: null },
        }
      }
      const session = this.db
        .prepare(
          'SELECT s.*, u.email, u.role AS user_role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
        )
        .get(hashKey(token), this.now())
      if (session) {
        try {
          this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(this.now(), session.id)
        } catch {
          // metadata update is best effort
        }
        return {
          ok: true,
          auth: {
            actor: session.email,
            role: session.user_role || 'admin',
            namespaces: ['*'],
            type: 'session',
            userId: session.user_id,
            keyId: null,
          },
        }
      }
      const row = this.db
        .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0')
        .get(hashKey(token))
      if (!row) return { ok: false, reason: 'invalid key' }
      if (row.expires_at && row.expires_at <= this.now()) return { ok: false, reason: 'key expired' }
      // Update last-used lazily (once a minute) to avoid a write on every call.
      if (!row.last_used_at || this.now() - row.last_used_at > 60_000) {
        try {
          this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(this.now(), row.id)
        } catch {
          // read path must not fail because the audit metadata could not be updated
        }
      }
      return {
        ok: true,
        auth: {
          actor: row.name || row.id,
          role: row.role,
          namespaces: normalizeNamespaces(JSON.parse(row.namespaces || '["*"]')),
          type: 'api-key',
          keyId: row.id,
        },
      }
    }
    if (!this.required && isLoopback && this.mode !== 'required') {
      return {
        ok: true,
        auth: { actor: 'local', role: 'admin', namespaces: ['*'], type: 'local', keyId: null },
      }
    }
    return { ok: false, reason: 'missing token' }
  }

  createKey({ name, role = 'reader', namespaces = ['*'], expiresAt = null } = {}) {
    if (!ROLES[role]) throw new Error(`invalid role: ${role}`)
    const trimmedName = String(name ?? '').trim().slice(0, 80)
    if (!trimmedName) throw new Error('key name is required')
    const secret = `hk_${randomBytes(32).toString('base64url')}`
    const id = `key_${randomBytes(6).toString('hex')}`
    const created = this.now()
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, role, namespaces, created_at, last_used_at, expires_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
      )
      .run(id, trimmedName, hashKey(secret), role, JSON.stringify(normalizeNamespaces(namespaces)), created, expiresAt)
    return {
      id,
      name: trimmedName,
      role,
      namespaces: normalizeNamespaces(namespaces),
      createdAt: created,
      expiresAt,
      key: secret,
      message: '这是唯一一次显示完整 key；请立即保存。',
    }
  }

  listKeys() {
    return this.db
      .prepare('SELECT id, name, role, namespaces, created_at, last_used_at, expires_at, revoked FROM api_keys ORDER BY created_at DESC')
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        namespaces: normalizeNamespaces(JSON.parse(row.namespaces || '["*"]')),
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        revoked: Boolean(row.revoked),
      }))
  }

  revokeKey(id) {
    const result = this.db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id)
    this.refreshRequired()
    return Number(result.changes ?? 0) > 0
  }
}

export function checkRole(auth, required) {
  return Boolean(auth) && roleAtLeast(auth.role, required)
}

export function checkNamespace(auth, namespace) {
  if (!auth) return false
  if (!namespace) return true
  const namespaces = auth.namespaces ?? ['*']
  return namespaces.includes('*') || namespaces.includes(namespace)
}

export function isLoopbackAddress(address) {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
