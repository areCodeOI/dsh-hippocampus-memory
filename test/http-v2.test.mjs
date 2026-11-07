import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { createMemoryHttpServer, listen } from '../lib/http.js'

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
  assert.match(metricsText, /hippocampus_info\{version="0\.2\.0"\}/)

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
