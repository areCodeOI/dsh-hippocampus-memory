import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { createMemoryHttpServer, listen } from '../lib/http.js'
import { VERSION } from '../lib/constants.js'

const cleanups = []

async function startServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-v2-http-'))
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  const server = createMemoryHttpServer({ store, startWorker: false, ...options })
  const address = await listen(server, { port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve))
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { base, store }
}

async function jsonFetch(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options)
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data, headers: response.headers }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

test('v2 HTTP: UI assets, graph, tree, monitor, metrics and cache', async () => {
  const { base, store } = await startServer()
  store.add({ content: '用户对花生过敏。', kind: 'persona', importance: 10, tags: ['健康'] })
  store.add({ content: 'Kestrel 使用 PostgreSQL 16。', kind: 'semantic', importance: 7, tags: ['kestrel'] })

  const index = await fetch(`${base}/`)
  const html = await index.text()
  assert.equal(index.status, 200)
  assert.match(html, /海马体记忆/)
  const script = html.match(/src="([^"]+\.js)"/)?.[1]
  const style = html.match(/href="([^"]+\.css)"/)?.[1]
  assert.ok(script, 'built Vue entry is referenced')
  assert.ok(style, 'built Element Plus stylesheet is referenced')
  assert.equal((await fetch(`${base}${script}`)).status, 200)
  assert.equal((await fetch(`${base}${style}`)).status, 200)

  const graph = await jsonFetch(base, '/api/graph?namespace=default')
  assert.equal(graph.status, 200)
  assert.ok(graph.data.nodes.length >= 2)
  assert.ok(Array.isArray(graph.data.edges))

  const tree = await jsonFetch(base, '/api/tree?namespace=default')
  assert.equal(tree.status, 200)
  assert.equal(tree.data.namespaces[0].name, 'default')

  const monitor = await jsonFetch(base, '/api/monitor')
  assert.equal(monitor.status, 200)
  assert.ok(monitor.data.memory.totals.all >= 2)

  const metrics = await fetch(`${base}/metrics`)
  const metricsText = await metrics.text()
  assert.equal(metrics.status, 200)
  assert.match(metricsText, /hippocampus_memories_total/)
  assert.ok(metricsText.includes(`hippocampus_info{version="${VERSION}"}`))

  const search = await jsonFetch(base, '/api/memories/search?q=花生')
  assert.equal(search.data.count, 1)
  await jsonFetch(base, '/api/memories/search?q=花生')
  const monitor2 = await jsonFetch(base, '/api/monitor')
  assert.ok(monitor2.data.cache.search.hits >= 1)

  const memories = await jsonFetch(base, '/api/memories?limit=1')
  assert.equal(memories.data.items.length, 1)
  assert.equal(memories.data.total, 2)
})

test('v2 HTTP: API keys, roles, audit and MCP authorization', async () => {
  const { base, store } = await startServer()
  store.add({ content: '用户的猫叫 Mochi。', kind: 'semantic', confirmed: true })

  const created = await jsonFetch(base, '/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'reader-ui', role: 'reader', namespaces: ['default'] }),
  })
  assert.equal(created.status, 201)
  assert.match(created.data.key, /^hk_/)
  const readerKey = created.data.key

  const readerSearch = await jsonFetch(base, '/api/memories/search?q=Mochi', {
    headers: { authorization: `Bearer ${readerKey}` },
  })
  assert.equal(readerSearch.status, 200)
  assert.equal(readerSearch.data.count, 1)

  const readerWrite = await jsonFetch(base, '/api/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${readerKey}` },
    body: JSON.stringify({ content: 'reader 不应该能写', namespace: 'default' }),
  })
  assert.equal(readerWrite.status, 403)

  const readerOtherNamespace = await jsonFetch(base, '/api/memories?namespace=other', {
    headers: { authorization: `Bearer ${readerKey}` },
  })
  assert.equal(readerOtherNamespace.status, 403)

  const mcpCall = await jsonFetch(base, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${readerKey}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory_add', arguments: { content: 'mcp reader should fail' } },
    }),
  })
  assert.equal(mcpCall.status, 200)
  assert.equal(mcpCall.data.result.isError, true)
  assert.match(mcpCall.data.result.content[0].text, /requires writer role/)

  const audit = await jsonFetch(base, '/api/audit?limit=20')
  assert.equal(audit.status, 200)
  assert.ok(audit.data.items.some((entry) => entry.action === 'key.create'))
  assert.ok(audit.data.items.some((entry) => entry.action === 'request.denied'))
})

test('v2 HTTP: jobs API and export', async () => {
  const { base, store } = await startServer()
  store.add({ content: '导出测试记忆。', kind: 'buffer' })
  const job = await jsonFetch(base, '/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'replay', payload: { namespace: '*' } }),
  })
  assert.equal(job.status, 202)
  assert.equal(job.data.job.type, 'replay')
  const jobs = await jsonFetch(base, '/api/jobs?limit=10')
  assert.equal(jobs.data.items.length, 1)

  const exported = await jsonFetch(base, '/api/export')
  assert.equal(exported.data.format, 'hippocampus-memory')
  assert.equal(exported.data.memories.length, 1)
})

test('v2 HTTP: bearer token protects management endpoints but not health/assets', async () => {
  const { base } = await startServer({ token: 'secret-token' })
  assert.equal((await fetch(`${base}/health`)).status, 200)
  assert.equal((await fetch(`${base}/api/stats`)).status, 401)
  assert.equal((await fetch(`${base}/api/public-config`)).status, 200)
  const authorized = await fetch(`${base}/api/stats`, { headers: { authorization: 'Bearer secret-token' } })
  assert.equal(authorized.status, 200)
  const metrics = await fetch(`${base}/metrics?token=secret-token`)
  assert.equal(metrics.status, 200)
})

test('v2 HTTP: metrics declare every exposed metric type', async () => {
  const { base } = await startServer()
  await fetch(`${base}/api/memories/search?q=x`)
  const text = await (await fetch(`${base}/metrics`)).text()
  for (const metric of ['hippocampus_cache_hits', 'hippocampus_cache_misses', 'hippocampus_memories_total', 'hippocampus_jobs']) {
    assert.match(text, new RegExp(`# TYPE ${metric} `), `${metric} must declare TYPE`)
  }
})

test('v2 HTTP: CORS only reflects loopback origins unless allow-listed', async () => {
  const { base } = await startServer()
  const evil = await fetch(`${base}/api/stats`, { headers: { origin: 'https://evil.example' } })
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'foreign origin must not be readable')
  const local = await fetch(`${base}/api/stats`, { headers: { origin: 'http://127.0.0.1:3080' } })
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3080')
  assert.equal(local.headers.get('vary'), 'origin')
  const preflight = await fetch(`${base}/api/stats`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:3080' } })
  assert.equal(preflight.status, 204)
})

test('v2 HTTP: /api/overview returns the sidebar panel snapshot', async () => {
  const { base, store } = await startServer()
  store.add({ content: '总览聚合测试记忆。', kind: 'semantic', importance: 6 })
  const overview = await jsonFetch(base, '/api/overview')
  assert.equal(overview.status, 200)
  assert.equal(overview.data.ok, true)
  assert.equal(overview.data.stats.totals.all, 1)
  assert.equal(overview.data.recent.length, 1)
  assert.ok(overview.data.port > 0)
  assert.equal(typeof overview.data.dbPath, 'string')
})

test('v2 HTTP: desktop shell origin passes preflight, reads and writes', async () => {
  const { base } = await startServer()
  const origin = 'dsh-app://app'
  const preflight = await fetch(`${base}/api/config`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/)

  const config = await fetch(`${base}/api/public-config`, { headers: { origin } })
  assert.equal(config.status, 200)
  assert.equal(config.headers.get('access-control-allow-origin'), origin)

  // Bad credentials are a business 401, not the cross-site 403.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'bad password' }),
  })
  assert.equal(login.status, 401)
  assert.equal(login.headers.get('access-control-allow-origin'), origin)
  assert.match((await login.json()).error.message, /invalid email or password/)

  // A write from the desktop shell must not be treated as cross-site.
  const write = await fetch(`${base}/api/memories`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ content: '桌面壳写入的语义记忆。', kind: 'semantic' }),
  })
  assert.equal(write.status, 201)

  // Foreign web origins stay unreadable and cannot write.
  const evil = await fetch(`${base}/api/public-config`, { headers: { origin: 'https://evil.example' } })
  assert.equal(evil.headers.get('access-control-allow-origin'), null)
  const evilWrite = await fetch(`${base}/api/memories`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'cross-site write' }),
  })
  assert.equal(evilWrite.status, 403)
})

test('v2 HTTP: corsOrigins option allow-lists exact origins in addition to the desktop default', async () => {
  const { base } = await startServer({ corsOrigins: ['https://trusted.example'] })
  const trusted = await fetch(`${base}/api/public-config`, { headers: { origin: 'https://trusted.example' } })
  assert.equal(trusted.headers.get('access-control-allow-origin'), 'https://trusted.example')
  const other = await fetch(`${base}/api/public-config`, { headers: { origin: 'https://other.example' } })
  assert.equal(other.headers.get('access-control-allow-origin'), null)
  const desktop = await fetch(`${base}/api/public-config`, { headers: { origin: 'dsh-app://app' } })
  assert.equal(desktop.headers.get('access-control-allow-origin'), 'dsh-app://app')
})

test('v2 HTTP: password change, admin reset and session revocation', async () => {
  const { base } = await startServer()
  const registered = await jsonFetch(base, '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct horse battery' }),
  })
  assert.equal(registered.status, 201)
  const session = { authorization: `Bearer ${registered.data.token}`, 'content-type': 'application/json' }

  const users = await jsonFetch(base, '/api/users', { headers: session })
  assert.equal(users.status, 200)
  assert.equal(users.data.users.length, 1)
  const userId = users.data.users[0].id
  assert.equal('password_hash' in users.data.users[0], false)

  const wrong = await jsonFetch(base, '/api/auth/password', {
    method: 'POST',
    headers: session,
    body: JSON.stringify({ currentPassword: 'wrong password', newPassword: 'new password 123' }),
  })
  assert.equal(wrong.status, 401)

  const changed = await jsonFetch(base, '/api/auth/password', {
    method: 'POST',
    headers: session,
    body: JSON.stringify({ currentPassword: 'correct horse battery', newPassword: '  new password 123  ' }),
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.data.ok, true)

  const oldLogin = await jsonFetch(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct horse battery' }),
  })
  assert.equal(oldLogin.status, 401)
  const newLogin = await jsonFetch(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'new password 123' }),
  })
  assert.equal(newLogin.status, 200)
  const admin = { authorization: `Bearer ${newLogin.data.token}`, 'content-type': 'application/json' }

  // API keys cannot change a password; a signed-in session is required.
  const key = await jsonFetch(base, '/api/keys', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: 'cli', role: 'admin' }),
  })
  const keyChange = await jsonFetch(base, '/api/auth/password', {
    method: 'POST',
    headers: { authorization: `Bearer ${key.data.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'new password 123', newPassword: 'another password 789' }),
  })
  assert.equal(keyChange.status, 403)

  const reset = await jsonFetch(base, `/api/users/${userId}/password`, {
    method: 'PATCH',
    headers: admin,
    body: JSON.stringify({ password: 'reset password 456' }),
  })
  assert.equal(reset.status, 200)
  assert.ok(reset.data.revokedSessions >= 1)
  assert.equal((await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${newLogin.data.token}` } })).status, 401)
  const finalLogin = await jsonFetch(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'reset password 456' }),
  })
  assert.equal(finalLogin.status, 200)
})

test('v2 HTTP: setup-status recomputes after users are deleted', async () => {
  const { base, store } = await startServer()
  const empty = await jsonFetch(base, '/api/auth/setup-status')
  assert.equal(empty.data.needsSetup, true)
  assert.equal(empty.data.authRequired, false)

  const registered = await jsonFetch(base, '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct horse battery' }),
  })
  assert.equal(registered.status, 201)
  const ready = await jsonFetch(base, '/api/auth/setup-status')
  assert.equal(ready.data.needsSetup, false)
  assert.equal(ready.data.authRequired, true)

  store.db.exec('DELETE FROM sessions; DELETE FROM users;')
  const cleared = await jsonFetch(base, '/api/auth/setup-status')
  assert.equal(cleared.data.needsSetup, true)
  assert.equal(cleared.data.authRequired, false)

  const again = await jsonFetch(base, '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'second@example.com', password: 'another password' }),
  })
  assert.equal(again.status, 201)
})
