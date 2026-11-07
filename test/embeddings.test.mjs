import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { EmbeddingService } from '../lib/embeddings.js'
import { bandKeys, cosine, normalizeVector, vectorFromBlob, vectorToBlob } from '../lib/vector.js'

const dirs = []
const servers = []

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-'))
  dirs.push(dir)
  return new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
}

function vectorFor(text) {
  if (String(text).includes('猫')) return [1, 0, 0, 0]
  if (String(text).includes('狗')) return [0.8, 0.2, 0, 0]
  if (String(text).includes('Kestrel')) return [0, 1, 0, 0]
  return [0, 0, 1, 0]
}

async function mockEmbeddingServer() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const text = body.input ?? body.prompt ?? ''
      const vector = vectorFor(text)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url.includes('/api/embeddings')) res.end(JSON.stringify({ embedding: vector }))
      else res.end(JSON.stringify({ data: [{ embedding: vector }] }))
    })
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

function makeService(base) {
  return new EmbeddingService({
    providers: [
      { id: 'openai-mock', kind: 'openai', model: 'mock-1', baseUrl: `${base}/v1`, apiKey: 'test', dim: 4, timeoutMs: 5000 },
      { id: 'ollama-mock', kind: 'ollama', model: 'mock-ollama', baseUrl: base, dim: 4, timeoutMs: 5000 },
    ],
  })
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('vector: fp32 round-trip, cosine and deterministic simhash bands', () => {
  const { vector, norm } = normalizeVector([3, 4, 0, 0])
  assert.equal(norm, 1)
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-6)
  const restored = vectorFromBlob(vectorToBlob(vector))
  assert.ok(Math.abs(cosine(vector, restored, 1, 1) - 1) < 1e-6)
  assert.deepEqual(bandKeys(vector), bandKeys(vector))
  assert.equal(bandKeys(vector).length, 4)
  assert.notDeepEqual(bandKeys(vector), bandKeys(Float32Array.from([-vector[0], -vector[1], 0, 0])))
})

test('embeddings: index multiple providers and search by vector similarity', async () => {
  const base = await mockEmbeddingServer()
  const store = tempStore()
  const service = makeService(base)
  const cat = store.add({ content: '用户养了一只猫叫 Mochi。', kind: 'semantic', confirmed: true })
  const project = store.add({ content: '项目 Kestrel 使用 PostgreSQL。', kind: 'semantic', confirmed: true })
  await service.indexMemory(store, cat.memory.id)
  await service.indexMemory(store, project.memory.id)

  const rows = store.db.prepare('SELECT DISTINCT provider, model FROM embeddings ORDER BY provider').all()
  assert.deepEqual(rows.map((row) => row.provider), ['ollama-mock', 'openai-mock'])
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 4)

  const search = await service.search(store, '猫')
  assert.ok(search.scores.has(cat.memory.id))
  assert.ok(search.scores.get(cat.memory.id) > 0.9)
  assert.ok(!search.scores.has(project.memory.id) || search.scores.get(project.memory.id) < 0.1)
  assert.equal(search.providers.length, 2)

  await service.search(store, '猫')
  const stats = service.embeddingsStats(store)
  assert.equal(stats.enabled, true)
  assert.equal(stats.providers[0].indexed, 2)
  assert.equal(service.queryCache.stats().hits > 0, true)
  store.close()
})

test('embeddings: backfill indexes missing memories and reports coverage', async () => {
  const base = await mockEmbeddingServer()
  const store = tempStore()
  const service = makeService(base)
  store.add({ content: '用户养了一只猫。', kind: 'semantic', confirmed: true })
  store.add({ content: '项目 Kestrel 部署在 10.0.0.7。', kind: 'semantic', confirmed: true })
  const progress = []
  const result = await service.backfill(store, { limit: 10, onProgress: (value) => progress.push(value) })
  assert.equal(result.indexed, 2) // memories processed; each is indexed for both providers
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n, 4)
  assert.ok(progress.length > 0)
  const stats = service.embeddingsStats(store)
  assert.equal(stats.providers[0].coverage, 1)
  store.close()
})

test('embeddings: disabled service is a no-op', async () => {
  const store = tempStore()
  const service = EmbeddingService.fromEnv({ env: {} })
  assert.equal(service.enabled, false)
  assert.deepEqual(await service.search(store, 'anything'), { scores: new Map(), providers: [], version: 0 })
  assert.equal((await service.backfill(store, {})).indexed, 0)
  store.close()
})
