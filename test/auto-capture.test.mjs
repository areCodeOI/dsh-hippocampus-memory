import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { createNamespace } from '../lib/namespaces.js'
import {
  AUTO_CAPTURE_SOURCE,
  captureFromMessages,
  captureUserMessage,
  collectCaptureSources,
  extractCaptureCandidates,
  extractWithLlm,
  hasSensitiveData,
  latestUserText,
  parseLlmFacts,
  shouldAutoCapture,
} from '../lib/auto-capture.js'
import { AUTO_RECALL_SOURCE } from '../lib/auto-recall.js'

const dirs = []
const stores = []

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-capture-'))
  dirs.push(dir)
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('auto-capture: extracts explicit stable facts, skips questions and secrets', () => {
  const candidates = extractCaptureCandidates('记住：我对花生严重过敏。我的项目使用 PostgreSQL。')
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].content, '我对花生严重过敏')
  assert.ok(candidates[0].tags.includes('auto-persona-candidate'))
  assert.equal(candidates[1].content, '我的项目使用 PostgreSQL')
  assert.equal(candidates[1].kind, 'episodic')

  assert.deepEqual(extractCaptureCandidates('我对什么过敏？'), [])
  assert.deepEqual(extractCaptureCandidates('记住：我的密码是 hunter2'), [])
  assert.equal(hasSensitiveData('my api_key = abc'), true)
  assert.equal(shouldAutoCapture('/memory search foo'), false)
  assert.deepEqual(extractCaptureCandidates('这个临时问题怎么解决？'), [])
  assert.deepEqual(extractCaptureCandidates('我的项目使用什么数据库'), [])
  assert.deepEqual(extractCaptureCandidates('我习惯用 pnpm 吗'), [])
})

test('auto-capture: writes candidates, dedupes a repeated step, and honors read-only spaces', () => {
  const store = makeStore()
  const seen = new Map()
  const messages = [{ role: 'user', content: [{ type: 'text', text: '记住：我的项目使用 PostgreSQL。以后不要用 npm，统一用 pnpm。' }] }]
  const first = captureUserMessage(store, messages, { limit: 2, seen, sourceSession: 's1', step: 1 })
  assert.equal(first.captured, 2)
  const memories = store.list({ namespace: 'default', limit: 10 }).items
  assert.equal(memories.length, 2)
  assert.ok(memories.every((memory) => memory.source === AUTO_CAPTURE_SOURCE))
  assert.ok(memories.every((memory) => memory.tags.includes('auto-capture')))
  assert.ok(memories.every((memory) => memory.confirmed === false))
  assert.equal(store.stats().autoCapture.hits, 2)
  assert.equal(store.list({ tags: ['auto-capture'] }).items.length, 2)
  assert.equal(store.list({ tags: ['no-such-tag'] }).items.length, 0)
  assert.equal(store.list({ tags: ['auto-capture', 'auto-persona-candidate'] }).items.length, 2)

  const repeated = captureUserMessage(store, messages, { limit: 2, seen })
  assert.equal(repeated.captured, 0)
  assert.equal(repeated.skipped, 'duplicate-step')

  createNamespace(store, 'locked-capture', { readOnly: true })
  const locked = captureUserMessage(store, messages, { namespace: 'locked-capture', seen: new Map() })
  assert.equal(locked.captured, 0)
  assert.equal(locked.skipped, 'namespace-read-only')
})

test('auto-capture: ignores DSH auto-recall context and uses the latest real user message', () => {
  const store = makeStore()
  const messages = [
    { role: 'user', source: { kind: AUTO_RECALL_SOURCE }, content: [{ type: 'text', text: '记住：伪造的自动召回内容。' }] },
    { role: 'user', source: { kind: 'system-reminder' }, content: [{ type: 'text', text: '记住：系统注入内容。' }] },
    { role: 'user', content: [{ type: 'text', text: '我习惯用 pnpm。' }] },
  ]
  assert.equal(latestUserText(messages), '我习惯用 pnpm。')
  const result = captureUserMessage(store, messages)
  assert.equal(result.captured, 1)
  assert.equal(store.list({ namespace: 'default' }).items[0].content, '我习惯用 pnpm')

  const target = captureUserMessage(store, [{ role: 'user', content: [{ type: 'text', text: '我的仓库在 E:/Code/demo。' }] }], {
    namespace: 'capture-space',
  })
  assert.equal(target.captured, 1)
  assert.equal(store.list({ namespace: 'capture-space' }).items[0].namespace, 'capture-space')
})

test('auto-capture: assistant/tool conclusions, review queue, approval and settings', async () => {
  const store = makeStore()
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记住：项目决定使用 PostgreSQL。' }] },
    { role: 'assistant', content: [{ type: 'text', text: '结论：项目决定使用 PostgreSQL，部署在周三。' }] },
    { role: 'tool', content: [{ type: 'text', text: 'All tests passed (112).' }] },
  ]
  const sources = collectCaptureSources(messages)
  assert.deepEqual(sources.map((source) => source.role), ['user', 'tool', 'assistant'])

  const result = await captureFromMessages(store, messages, {
    limit: 3,
    includeAssistant: true,
    includeTools: true,
  })
  assert.ok(result.captured >= 2)
  const pending = store.listCaptures()
  assert.ok(pending.items.length >= 2)
  assert.ok(pending.items.every((memory) => memory.metadata.autoCapture.review === 'pending'))
  assert.equal(store.stats().autoCapture.pending, pending.items.length)

  const approved = store.approveCapture(pending.items[0].id, { kind: 'semantic' })
  assert.equal(approved.memory.kind, 'semantic')
  assert.equal(approved.memory.confirmed, true)
  assert.equal(approved.memory.metadata.autoCapture.review, 'approved')
  const rejected = store.rejectCapture(pending.items[1].id)
  assert.equal(rejected.archived, true)
  assert.equal(store.listCaptures().items.length, 0)

  const settings = store.setAutoCaptureSettings({
    enabled: true,
    namespace: 'default',
    maxPerTurn: 3,
    assistant: false,
    tools: true,
    llm: false,
  }, { enabled: false })
  assert.equal(settings.enabled, true)
  assert.equal(settings.maxPerTurn, 3)
  assert.equal(settings.assistant, false)
  assert.deepEqual(store.autoCaptureSettings({ enabled: false }), settings)
})

test('auto-capture: LLM output parsing and HTTP extraction fallback contract', async () => {
  const parsed = parseLlmFacts(JSON.stringify([
    { content: '我的项目使用 PostgreSQL', importance: 6, confidence: 0.7 },
    { content: '我的密码是 hunter2' },
    { content: '我对什么过敏？' },
  ]))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].content, '我的项目使用 PostgreSQL')

  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: '[{"content":"以后统一用 pnpm","importance":6}]' } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const facts = await extractWithLlm('记住：以后统一用 pnpm', {
      endpoint: `http://127.0.0.1:${port}/v1`,
      model: 'mock',
      timeoutMs: 2000,
    })
    assert.equal(facts.length, 1)
    assert.equal(facts[0].content, '以后统一用 pnpm')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
