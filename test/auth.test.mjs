import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { AuthService, checkNamespace, checkRole } from '../lib/auth.js'

const dirs = []

function makeAuth(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-auth-'))
  dirs.push(dir)
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  const auth = new AuthService({ db: store.db, ...options })
  return { auth, store }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('auth: loopback is local admin only when no bootstrap token is configured', () => {
  const { auth, store } = makeAuth()
  assert.equal(auth.authRequired, false)
  const local = auth.verify(null, { isLoopback: true })
  assert.equal(local.ok, true)
  assert.equal(local.auth.role, 'admin')
  assert.equal(local.auth.type, 'local')
  const remote = auth.verify(null, { isLoopback: false })
  assert.equal(remote.ok, false)
  store.close()
})

test('auth: bootstrap token is admin and forces authentication', () => {
  const { auth, store } = makeAuth({ bootstrapToken: 'secret-bootstrap' })
  assert.equal(auth.authRequired, true)
  const verified = auth.verify('secret-bootstrap', { isLoopback: true })
  assert.equal(verified.ok, true)
  assert.equal(verified.auth.role, 'admin')
  assert.equal(verified.auth.type, 'bootstrap')
  assert.equal(auth.verify('wrong', { isLoopback: true }).ok, false)
  store.close()
})

test('auth: API keys carry roles and namespace restrictions and can be revoked', () => {
  const { auth, store } = makeAuth({ bootstrapToken: 'root' })
  const reader = auth.createKey({ name: 'reader', role: 'reader', namespaces: ['project-a'] })
  const writer = auth.createKey({ name: 'writer', role: 'writer' })
  assert.match(reader.key, /^hk_/)
  assert.notEqual(reader.key, writer.key)
  assert.equal(auth.listKeys().length, 2)

  const verified = auth.verify(reader.key, { isLoopback: false })
  assert.equal(verified.ok, true)
  assert.equal(verified.auth.role, 'reader')
  assert.deepEqual(verified.auth.namespaces, ['project-a'])
  assert.equal(checkRole(verified.auth, 'reader'), true)
  assert.equal(checkRole(verified.auth, 'writer'), false)
  assert.equal(checkNamespace(verified.auth, 'project-a'), true)
  assert.equal(checkNamespace(verified.auth, 'project-b'), false)

  // The plaintext key is never stored.
  const row = store.db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(reader.id)
  assert.notEqual(row.key_hash, reader.key)
  assert.equal(row.key_hash.length, 64)

  assert.equal(auth.revokeKey(reader.id), true)
  assert.equal(auth.verify(reader.key, { isLoopback: false }).ok, false)
  assert.equal(auth.verify(writer.key, { isLoopback: false }).ok, true)
  store.close()
})

test('auth: required mode also protects loopback', () => {
  const { auth, store } = makeAuth({ mode: 'required' })
  assert.equal(auth.verify(null, { isLoopback: true }).ok, false)
  const key = auth.createKey({ name: 'ops', role: 'admin' })
  assert.equal(auth.verify(key.key, { isLoopback: true }).ok, true)
  store.close()
})

test('auth: creating a key does not lock out the local UI', () => {
  const { auth, store } = makeAuth()
  auth.createKey({ name: 'local-first', role: 'reader' })
  assert.equal(auth.verify(null, { isLoopback: true }).ok, true)
  assert.equal(auth.verify(null, { isLoopback: false }).ok, false)
  store.close()
})

test('auth: first admin setup creates a revocable session, then login works', () => {
  const { auth, store } = makeAuth()
  assert.equal(auth.setupRequired(), true)
  assert.equal(auth.verify(null, { isLoopback: true }).ok, true)
  const created = auth.registerAdmin({ email: 'Admin@Example.com', password: 'correct horse battery' })
  assert.match(created.token, /^hs_/)
  assert.equal(created.user.email, 'admin@example.com')
  assert.equal(auth.setupRequired(), false)
  assert.equal(auth.authRequired, true)
  assert.equal(auth.verify(null, { isLoopback: true }).ok, false)
  const verified = auth.verify(created.token, { isLoopback: true })
  assert.equal(verified.ok, true)
  assert.equal(verified.auth.type, 'session')
  assert.equal(verified.auth.role, 'admin')

  assert.throws(() => auth.registerAdmin({ email: 'other@example.com', password: 'another password' }), /already/)
  assert.throws(() => auth.login({ email: 'admin@example.com', password: 'wrong password' }), /invalid/)
  const login = auth.login({ email: 'admin@example.com', password: 'correct horse battery' })
  assert.match(login.token, /^hs_/)
  assert.equal(auth.logout(login.token), true)
  assert.equal(auth.verify(login.token, { isLoopback: true }).ok, false)
  store.close()
})

test('auth: passwords are trimmed and change/reset revoke the right sessions', () => {
  const { auth, store } = makeAuth()
  const created = auth.registerAdmin({ email: 'trim@example.com', password: '  correct horse battery  ' })
  // Outer whitespace is ignored on both registration and login.
  assert.equal(auth.login({ email: 'trim@example.com', password: 'correct horse battery' }).user.email, 'trim@example.com')
  assert.equal(auth.login({ email: 'trim@example.com', password: '  correct horse battery  ' }).user.email, 'trim@example.com')

  const sessionId = auth.verify(created.token, { isLoopback: true }).auth.sessionId
  assert.ok(sessionId, 'session auth exposes its id for keep-current-session')
  assert.throws(
    () => auth.changePassword({ userId: created.user.id, currentPassword: 'wrong', newPassword: 'new password 123' }),
    /current password/,
  )
  const changed = auth.changePassword({
    userId: created.user.id,
    currentPassword: 'correct horse battery',
    newPassword: '  new password 123  ',
    keepSessionId: sessionId,
  })
  assert.equal(changed.ok, true)
  assert.ok(changed.revokedSessions >= 2, 'other sessions created by the two logins are revoked')
  assert.equal(auth.verify(created.token, { isLoopback: true }).ok, true, 'the changing session stays valid')
  assert.throws(() => auth.login({ email: 'trim@example.com', password: 'correct horse battery' }), /invalid/)
  assert.equal(auth.login({ email: 'trim@example.com', password: 'new password 123' }).user.email, 'trim@example.com')

  const reset = auth.resetPassword({ email: 'trim@example.com', password: 'reset password 456' })
  assert.ok(reset.revokedSessions >= 1)
  assert.equal(auth.verify(created.token, { isLoopback: true }).ok, false, 'admin reset revokes every session')
  assert.equal(auth.login({ email: 'trim@example.com', password: 'reset password 456' }).user.email, 'trim@example.com')
  const listed = auth.listUsers()
  assert.equal(listed[0].email, 'trim@example.com')
  assert.equal('password_hash' in listed[0], false)
  store.close()
})

test('auth: refreshRequired notices users removed out of band', () => {
  const { auth, store } = makeAuth()
  assert.equal(auth.authRequired, false)
  auth.registerAdmin({ email: 'again@example.com', password: 'password 123' })
  assert.equal(auth.authRequired, true)
  store.db.exec('DELETE FROM sessions; DELETE FROM users;')
  assert.equal(auth.refreshRequired(), false)
  assert.equal(auth.authRequired, false)
  assert.equal(auth.verify(null, { isLoopback: true }).ok, true)
  store.close()
})
