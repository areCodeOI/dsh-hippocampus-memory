import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { createMemoryHttpServer, listen } from '../lib/http.js'

const cleanups = []

async function startServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-http-test-'))
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db'), namespace: 'default' })
  const server = createMemoryHttpServer({ store, token: options.token })
  const address = await listen(server, { port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve))
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { base, store }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

test('HTTP: health, add, search, stats and REST resources', async () => {
  const { base } = await startServer()
  const health = await fetch(`${base}/health`).then((response) => response.json())
  assert.equal(health.ok, true)

  const added = await fetch(`${base}/api/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: '项目 Kestrel 的部署窗口是每周三 02:00。',
      kind: 'semantic',
      importance: 7,
      confirmed: true,
      tags: ['kestrel', '部署'],
    }),
  })
  assert.equal(added.status, 201)
  const created = await added.json()
  assert.equal(created.action, 'created')
  const id = created.memory.id

  const search = await fetch(`${base}/api/memories/search?q=${encodeURIComponent('部署窗口')}`).then((response) => response.json())
  assert.equal(search.count, 1)
  assert.equal(search.memories[0].id, id)

  const got = await fetch(`${base}/api/memories/${id}`).then((response) => response.json())
  assert.equal(got.found, true)

  const patched = await fetch(`${base}/api/memories/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ importance: 9 }),
  }).then((response) => response.json())
  assert.equal(patched.memory.importance, 9)

  const stats = await fetch(`${base}/api/stats?includeConflicts=true`).then((response) => response.json())
  assert.equal(stats.totals.all, 1)
  assert.deepEqual(stats.conflicts, [])

  const replay = await fetch(`${base}/api/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: true }),
  }).then((response) => response.json())
  assert.equal(replay.ok, true)
  assert.equal(replay.dryRun, true)

  const conflicts = await fetch(`${base}/api/conflicts`).then((response) => response.json())
  assert.deepEqual(conflicts.conflicts, [])

  const exported = await fetch(`${base}/api/export`).then((response) => response.json())
  assert.equal(exported.format, 'hippocampus-memory')
  assert.equal(exported.memories.length, 1)
})

test('HTTP: MCP endpoint, tool listing and generic tool calls', async () => {
  const { base } = await startServer()
  const init = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } },
    }),
  }).then((response) => response.json())
  assert.equal(init.result.serverInfo.name, 'hippocampus-memory')

  const call = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'memory_add', arguments: { content: '用户偏好深色主题。', kind: 'persona', importance: 8 } },
    }),
  }).then((response) => response.json())
  assert.equal(call.result.structuredContent.action, 'created')

  const tools = await fetch(`${base}/api/tools`).then((response) => response.json())
  assert.equal(tools.tools.length, 9)

  const direct = await fetch(`${base}/api/tools/memory_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '深色主题' }),
  }).then((response) => response.json())
  assert.equal(direct.count, 1)

  const openapi = await fetch(`${base}/openapi.json`).then((response) => response.json())
  assert.equal(openapi.openapi, '3.1.0')
  assert.ok(openapi.paths['/api/memories/search'])
})

test('HTTP: bearer token protects data endpoints but not health', async () => {
  const { base } = await startServer({ token: 'secret-token' })
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)

  const denied = await fetch(`${base}/api/stats`)
  assert.equal(denied.status, 401)

  const allowed = await fetch(`${base}/api/stats`, { headers: { authorization: 'Bearer secret-token' } })
  assert.equal(allowed.status, 200)
})

test('HTTP: invalid requests return structured errors', async () => {
  const { base } = await startServer()
  const badBody = await fetch(`${base}/api/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  })
  assert.equal(badBody.status, 400)
  const parsed = await badBody.json()
  assert.match(parsed.error.message, /invalid JSON/)

  const missing = await fetch(`${base}/api/memories/mem_missing`)
  assert.equal(missing.status, 404)

  const noRoute = await fetch(`${base}/nope`)
  assert.equal(noRoute.status, 404)
})

test('HTTP: read-only endpoints reject non-GET methods with 405', async () => {
  const { base } = await startServer()
  for (const [method, path] of [
    ['PUT', '/api/stats'],
    ['POST', '/api/export'],
    ['DELETE', '/api/config'],
    ['PUT', '/api/memories/search?q=x'],
  ]) {
    const response = await fetch(`${base}${path}`, { method })
    assert.equal(response.status, 405, `${method} ${path}`)
    assert.match(response.headers.get('allow') ?? '', /GET/)
  }
  // The legitimate verb still works.
  assert.equal((await fetch(`${base}/api/stats`)).status, 200)
})

test('HTTP: GET /mcp answers 405 and the server keeps serving (no crash)', async () => {
  const { base } = await startServer()
  const response = await fetch(`${base}/mcp`)
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'POST')
  assert.match(await response.text(), /JSON-RPC/)
  // Regression for ERR_HTTP_HEADERS_SENT: the process used to die here.
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  const stats = await fetch(`${base}/api/stats`)
  assert.equal(stats.status, 200)
})
