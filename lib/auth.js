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

/**
 * Forms, password managers and IME input can add leading/trailing whitespace
 * that the user never sees. Trim before hashing and verifying so a password
 * created once can always be entered again. (Full-width characters are NOT
 * rewritten: they are legitimate distinct characters.)
 */
function normalizePassword(password) {
  return String(password ?? '').trim()
}

function hashPassword(password) {
  const value = normalizePassword(password)
  if (value.length < 8 || value.length > 200) throw new Error('password must be 8-200 characters (outer spaces are ignored)')
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(value, salt, 64).toString('hex')
  return `scrypt$${salt}$${hash}`
}

function verifyPassword(password, stored) {
  const [algorithm, salt, expected] = String(stored ?? '').split('$')
  if (algorithm !== 'scrypt' || !salt || !expected) return false
  const wanted = Buffer.from(expected, 'hex')
  if (!wanted.length) return false
  // Try the normalized value first; the raw one keeps hashes created before
  // trimming was introduced working instead of locking those users out.
  const normalized = normalizePassword(password)
  const raw = String(password ?? '')
  const candidates = normalized === raw ? [normalized] : [normalized, raw]
  for (const candidate of candidates) {
    try {
      const actual = scryptSync(candidate, salt, 64)
      if (actual.length === wanted.length && timingSafeEqual(actual, wanted)) return true
    } catch {
      return false
    }
  }
  return false
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function normalizeNamespaces(value) {
  // Reject numbers/objects instead of silently treating them as "*": a
  // malformed key row or API body must not escalate to full access.
  if (!Array.isArray(value) && typeof value !== 'string') {
    throw new Error('namespaces must be an array or comma-separated string')
  }
  const list = Array.isArray(value) ? value : value.split(',')
  const result = []
  for (const raw of list) {
    const ns = String(raw ?? '').trim()
    if (!ns) continue
    if (ns !== '*' && !/^[\w.\-:\u4e00-\u9fff]{1,64}$/u.test(ns)) throw new Error(`invalid namespace: ${ns}`)
    if (!result.includes(ns)) result.push(ns)
    if (result.length >= 32) break
  }
  // An explicit empty list means "no namespace access", not "all namespaces".
  // Returning ['*'] here used to silently escalate a key to full access.
  return result
}

export class AuthService {
  constructor({ db, bootstrapToken = null, mode = process.env.HIPPOCAMPUS_AUTH ?? 'auto', now = () => Date.now() } = {}) {
    this.db = db
    this.now = now
    this.bootstrapToken = bootstrapToken || null
    this.mode = mode
    if (!['auto', 'required', 'open'].includes(this.mode)) this.mode = 'auto'
    this.required = this.mode === 'required' || Boolean(this.bootstrapToken)
    this.requiredCached = this.required
    this.requiredCheckedAt = 0
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

  /**
   * Whether requests (loopback included) must present a credential.
   *
   * The users table can change outside this process (SQLite edits, another
   * instance, a restored backup). A 2-second TTL keeps that state consistent
   * without issuing a SELECT on every request.
   */
  currentRequired() {
    if (this.mode === 'required' || this.bootstrapToken) return true
    const now = this.now()
    // now < checkedAt also invalidates when a test/clock jump moves backwards.
    if (!this.requiredCheckedAt || now - this.requiredCheckedAt > 2000 || now < this.requiredCheckedAt) {
      this.requiredCached = this.hasUsers()
      this.requiredCheckedAt = now
    }
    return Boolean(this.requiredCached)
  }

  refreshRequired() {
    // Mem0-style: once an admin account exists, auth is on (loopback included).
    // Before first-run setup, loopback may still administer the local plugin so
    // the setup page can create the admin.
    this.requiredCheckedAt = 0
    this.requiredCached = this.currentRequired()
    this.required = this.requiredCached
    return this.required
  }

  get authRequired() {
    return this.currentRequired()
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
    this.requiredCached = true
    this.requiredCheckedAt = now
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

  /** Public user list for the admin reset UI; never includes hashes. */
  listUsers() {
    return this.db
      .prepare('SELECT id, email, role, created_at, updated_at FROM users ORDER BY created_at ASC')
      .all()
      .map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
  }

  findUser({ userId, email } = {}) {
    if (userId) return this.db.prepare('SELECT * FROM users WHERE id = ?').get(String(userId))
    if (email) return this.db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email))
    return null
  }

  /**
   * Store a new password hash and revoke sessions. `keepSessionId` keeps the
   * session that performed the change (self-service), while an admin reset
   * revokes every session of the target user.
   */
  setPassword(userId, password, { keepSessionId = null } = {}) {
    // Validate/hash before the UPDATE so a short password cannot half-apply.
    const passwordHash = hashPassword(password)
    const now = this.now()
    const updated = this.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, now, String(userId))
    if (!Number(updated.changes ?? 0)) {
      const error = new Error('user not found')
      error.status = 404
      throw error
    }
    const revoked = keepSessionId
      ? this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(String(userId), String(keepSessionId))
      : this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(String(userId))
    const active = this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(String(userId))
    return {
      ok: true,
      userId: String(userId),
      revokedSessions: Number(revoked.changes ?? 0),
      activeSessions: Number(active?.n ?? 0),
      passwordUpdatedAt: now,
    }
  }

  /** Self-service change: requires the current password. */
  changePassword({ userId, currentPassword, newPassword, keepSessionId = null } = {}) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(String(userId ?? ''))
    if (!row) {
      const error = new Error('user not found')
      error.status = 404
      throw error
    }
    if (!verifyPassword(currentPassword, row.password_hash)) {
      const error = new Error('current password is incorrect')
      error.status = 401
      throw error
    }
    return this.setPassword(row.id, newPassword, { keepSessionId })
  }

  /** Admin reset by user id or email; revokes every session of that user. */
  resetPassword({ userId, email, password } = {}) {
    const row = this.findUser({ userId, email })
    if (!row) {
      const error = new Error('user not found')
      error.status = 404
      throw error
    }
    return this.setPassword(row.id, password)
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
            sessionId: session.id,
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
      let namespaces
      try {
        namespaces = normalizeNamespaces(JSON.parse(row.namespaces || '["*"]'))
      } catch {
        return { ok: false, reason: 'invalid key namespaces' }
      }
      if (!namespaces.length) return { ok: false, reason: 'key has no namespace access' }
      return {
        ok: true,
        auth: {
          actor: row.name || row.id,
          role: row.role,
          namespaces,
          type: 'api-key',
          keyId: row.id,
        },
      }
    }
    if (!this.currentRequired() && isLoopback && this.mode !== 'required') {
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
    const normalizedNamespaces = normalizeNamespaces(namespaces)
    if (!normalizedNamespaces.length) throw new Error('key must allow at least one namespace or *')
    const secret = `hk_${randomBytes(32).toString('base64url')}`
    const id = `key_${randomBytes(6).toString('hex')}`
    const created = this.now()
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, role, namespaces, created_at, last_used_at, expires_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
      )
      .run(id, trimmedName, hashKey(secret), role, JSON.stringify(normalizedNamespaces), created, expiresAt)
    return {
      id,
      name: trimmedName,
      role,
      namespaces: normalizedNamespaces,
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
      .map((row) => {
        let namespaces = []
        try {
          namespaces = normalizeNamespaces(JSON.parse(row.namespaces || '["*"]'))
        } catch {
          // A corrupted key row is shown as having no access; verify() rejects it.
        }
        return {
          id: row.id,
          name: row.name,
          role: row.role,
          namespaces,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          expiresAt: row.expires_at,
          revoked: Boolean(row.revoked),
        }
      })
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
