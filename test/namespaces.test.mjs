import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { AuthService } from '../lib/auth.js'
import { createMemoryHttpServer, listen } from '../lib/http.js'
import { listNamespaces, createNamespace, renameNamespace, mergeNamespaces, deleteNamespace } from '../lib/namespaces.js'

const cleanups = []

function makeStore(namespace = 'default') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ns-test-'))
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db'), namespace })
  const auth = new AuthService({ db: store.db })
  cleanups.push(() => {
    try { store.close() } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { store, auth }
}

async function startServer(store) {
  const server = createMemoryHttpServer({ store, startWorker: false })
  const address = await listen(server, { port: 0, host: '127.0.0.1' })
  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${address.port}`
}

async function jsonFetch(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, options)
  return { status: response.status, data: await response.json().catch(() => ({})) }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test('namespaces: reserve, list, rename memories/keys/jobs', () => {
  const { store, auth } = makeStore()
  assert.equal(createNamespace(store, 'project-a').created, true)
  assert.equal(createNamespace(store, 'project-a').created, false)
  assert.throws(() => createNamespace(store, '..'), /invalid namespace/)
  assert.throws(() => createNamespace(store, '.'), /invalid namespace/)
  store.add({ content: '项目 A 使用 PostgreSQL。', kind: 'semantic', namespace: 'project-a', confirmed: true })
  store.add({ content: '项目 A 的部署窗口是周三。', kind: 'semantic', namespace: 'project-a', confirmed: true })
  const key = auth.createKey({ name: 'project-key', role: 'admin', namespaces: ['project-a'] })
  store.db.prepare('INSERT INTO jobs (id, type, status, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'job_ns_1', 'replay', 'queued', JSON.stringify({ namespace: 'project-a' }), Date.now(),
  )

  const listed = listNamespaces(store)
  const item = listed.namespaces.find((entry) => entry.name === 'project-a')
  assert.equal(item.total, 2)
  assert.equal(item.byKind.semantic, 2)

  const renamed = renameNamespace(store, 'project-a', 'project-b')
  assert.equal(renamed.moved, 2)
  assert.equal(renamed.apiKeys, 1)
  assert.equal(renamed.jobs, 1)
  assert.equal(store.list({ namespace: 'project-b' }).total, 2)
  assert.deepEqual(auth.listKeys().find((entry) => entry.id === key.id).namespaces, ['project-b'])
  assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM jobs WHERE id = ?').get('job_ns_1').payload).namespace, 'project-b')
  assert.equal(listNamespaces(store).namespaces.some((entry) => entry.name === 'project-a'), false)
})

test('namespaces: merge migrates memories and dedupes exact active facts', () => {
  const { store } = makeStore()
  store.add({ content: '项目使用 PostgreSQL 16。', kind: 'semantic', namespace: 'default', confirmed: true, importance: 7, tags: ['infra'] })
  store.add({ content: '用户对花生过敏。', kind: 'semantic', namespace: 'default', confirmed: true, importance: 5 })
  store.add({ content: '项目使用 PostgreSQL 16。', kind: 'semantic', namespace: 'project-a', confirmed: true, importance: 9, tags: ['db'] })
  store.add({ content: '用户对花生过敏。', kind: 'persona', namespace: 'project-a', confirmed: true, importance: 10 })
  store.add({ content: '项目部署窗口是周三。', kind: 'semantic', namespace: 'project-a', confirmed: true })

  const result = mergeNamespaces(store, 'project-a', 'default')
  assert.equal(result.deduped, 2)
  assert.equal(result.moved, 1)
  const rows = store.list({ namespace: 'default', limit: 10 }).items
  assert.equal(rows.length, 3)
  const merged = rows.find((row) => row.content.includes('PostgreSQL'))
  assert.equal(merged.importance, 9)
  assert.deepEqual([...merged.tags].sort(), ['db', 'infra'])
  const allergy = rows.find((row) => row.content.includes('花生'))
  assert.equal(allergy.kind, 'persona', 'merge must not downgrade persona to semantic')
  assert.equal(listNamespaces(store).namespaces.some((entry) => entry.name === 'project-a'), false)
})

test('namespaces: soft and hard delete, persona/default protection', () => {
  const { store } = makeStore()
  store.add({ content: '普通项目记忆。', kind: 'semantic', namespace: 'temp', confirmed: true })
  store.add({ content: '用户对花生过敏。', kind: 'persona', namespace: 'temp', confirmed: true })
  assert.throws(() => deleteNamespace(store, 'default'), /configured default/)
  assert.throws(() => deleteNamespace(store, 'temp', { hard: true }), /confirm=true/)
  assert.throws(() => deleteNamespace(store, 'temp', { hard: true, confirm: true }), /persona/)
  const soft = deleteNamespace(store, 'temp')
  assert.equal(soft.hard, false)
  assert.equal(soft.pending, 2)
  assert.ok(soft.purgeAfter > Date.now())

  store.add({ content: '另一条普通记忆。', kind: 'semantic', namespace: 'temp2', confirmed: true })
  const hard = deleteNamespace(store, 'temp2', { hard: true, confirm: true })
  assert.equal(hard.deleted, 1)
  assert.equal(store.list({ namespace: 'temp2' }).total, 0)
  assert.equal(listNamespaces(store).namespaces.some((entry) => entry.name === 'temp2'), false)
})

test('namespaces HTTP: list/create/rename/merge/delete with roles and stats', async () => {
  const { store, auth } = makeStore()
  const base = await startServer(store)
  const registered = auth.registerAdmin({ email: 'admin@example.com', password: 'correct horse battery' })
  const admin = { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }
  const reader = auth.createKey({ name: 'reader', role: 'reader', namespaces: ['default'] })
  const readerHeaders = { authorization: `Bearer ${reader.key}`, 'content-type': 'application/json' }

  store.add({ content: 'default 空间的记忆。', kind: 'semantic', namespace: 'default', confirmed: true })
  const created = await jsonFetch(base, '/api/namespaces', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'project-a' }) })
  assert.equal(created.status, 201)

  store.add({ content: '项目 A 的记忆。', kind: 'semantic', namespace: 'project-a', confirmed: true })
  store.add({ content: 'secret 空间的记忆。', kind: 'semantic', namespace: 'secret', confirmed: true })
  store.add({ content: '用户对花生过敏。', kind: 'persona', namespace: 'secret', confirmed: true })
  store.add({ content: '用户对花生不过敏。', kind: 'persona', namespace: 'secret', confirmed: true })
  const overview = await jsonFetch(base, '/api/overview?namespace=project-a', { headers: admin })
  assert.equal(overview.data.selectedNamespace, 'project-a')
  assert.equal(overview.data.stats.totals.all, 1)
  const list = await jsonFetch(base, '/api/namespaces', { headers: admin })
  assert.equal(list.status, 200)
  const item = list.data.namespaces.find((entry) => entry.name === 'project-a')
  assert.equal(item.total, 1)
  assert.equal(list.data.default, 'default')

  const readerList = await jsonFetch(base, '/api/namespaces', { headers: readerHeaders })
  assert.equal(readerList.data.namespaces.some((entry) => entry.name === 'project-a'), false)
  assert.equal(readerList.data.default, 'default')
  const readerCreate = await jsonFetch(base, '/api/namespaces', { method: 'POST', headers: readerHeaders, body: JSON.stringify({ name: 'nope' }) })
  assert.equal(readerCreate.status, 403)

  // A restricted key must not learn an unreadable default namespace name.
  const restricted = auth.createKey({ name: 'restricted', role: 'admin', namespaces: ['project-a'] })
  const restrictedHeaders = { authorization: `Bearer ${restricted.key}`, 'content-type': 'application/json' }
  const restrictedList = await jsonFetch(base, '/api/namespaces', { headers: restrictedHeaders })
  assert.equal(restrictedList.data.default, null)
  assert.deepEqual(restrictedList.data.namespaces.map((entry) => entry.name), ['project-a'])

  // Summary endpoints must not reveal the unreadable default namespace name.
  const restrictedStats = await jsonFetch(base, '/api/stats', { headers: restrictedHeaders })
  assert.equal(restrictedStats.data.namespace, undefined)
  assert.equal(restrictedStats.data.openConflicts, 0)
  const restrictedMonitor = await jsonFetch(base, '/api/monitor', { headers: restrictedHeaders })
  assert.equal(restrictedMonitor.data.memory.namespace, undefined)
  assert.equal(restrictedMonitor.data.memory.openConflicts, 0)
  const restrictedOverview = await jsonFetch(base, '/api/overview?namespace=project-a', { headers: restrictedHeaders })
  assert.equal(restrictedOverview.data.namespace, undefined)
  assert.equal(restrictedOverview.data.stats.namespace, undefined)
  assert.equal(restrictedOverview.data.stats.openConflicts, 0)
  const restrictedToolStats = await jsonFetch(base, '/api/tools/memory_stats', { method: 'POST', headers: restrictedHeaders, body: '{}' })
  assert.equal(restrictedToolStats.data.namespace, undefined)
  assert.equal((await jsonFetch(base, '/api/stats', { headers: readerHeaders })).data.namespace, 'default')

  // A namespace-scoped admin cannot mint a wildcard/out-of-scope key.
  const escapeKey = await jsonFetch(base, '/api/keys', {
    method: 'POST',
    headers: restrictedHeaders,
    body: JSON.stringify({ name: 'escape', role: 'reader' }),
  })
  assert.equal(escapeKey.status, 403)
  const scopedKey = await jsonFetch(base, '/api/keys', {
    method: 'POST',
    headers: restrictedHeaders,
    body: JSON.stringify({ name: 'scoped', role: 'reader', namespaces: ['project-a'] }),
  })
  assert.equal(scopedKey.status, 201)
  assert.deepEqual(scopedKey.data.namespaces, ['project-a'])

  // Reader stats (HTTP tool + MCP) must not expose counts from other spaces.
  const toolStats = await jsonFetch(base, '/api/tools/memory_stats', { method: 'POST', headers: readerHeaders, body: '{}' })
  assert.equal(toolStats.status, 200)
  assert.equal(toolStats.data.byNamespace.secret, undefined)
  assert.equal(toolStats.data.byNamespace.default, 1)
  const toolConflicts = await jsonFetch(base, '/api/tools/memory_stats', {
    method: 'POST',
    headers: readerHeaders,
    body: JSON.stringify({ includeConflicts: true }),
  })
  assert.equal(toolConflicts.data.openConflicts, 0)
  assert.deepEqual(toolConflicts.data.conflicts, [])
  const mcpStats = await jsonFetch(base, '/mcp', {
    method: 'POST',
    headers: readerHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } }),
  })
  assert.equal(mcpStats.status, 200)
  assert.equal(mcpStats.data.result.structuredContent.byNamespace.secret, undefined)

  const renamed = await jsonFetch(base, '/api/namespaces/project-a', { method: 'PATCH', headers: admin, body: JSON.stringify({ to: 'project-b' }) })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.data.to, 'project-b')

  const merged = await jsonFetch(base, '/api/namespaces/project-b/merge', { method: 'POST', headers: admin, body: JSON.stringify({ into: 'default' }) })
  assert.equal(merged.status, 200)
  assert.equal(merged.data.moved, 1)

  const protectedDelete = await jsonFetch(base, '/api/namespaces/default?hard=true&confirm=true', { method: 'DELETE', headers: admin })
  assert.equal(protectedDelete.status, 400)

  const temp = await jsonFetch(base, '/api/namespaces', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'temp' }) })
  assert.equal(temp.status, 201)
  const soft = await jsonFetch(base, '/api/namespaces/temp', { method: 'DELETE', headers: admin })
  assert.equal(soft.status, 200)
  assert.equal(soft.data.hard, false)

  const audit = await jsonFetch(base, '/api/audit?limit=20', { headers: admin })
  assert.ok(audit.data.items.some((entry) => entry.action === 'namespace.rename'))
  assert.ok(audit.data.items.some((entry) => entry.action === 'namespace.delete'))
})
