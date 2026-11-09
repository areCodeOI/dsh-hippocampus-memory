import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { createNamespace } from '../lib/namespaces.js'
import {
  AUTO_CAPTURE_SOURCE,
  captureUserMessage,
  extractCaptureCandidates,
  hasSensitiveData,
  latestUserText,
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
    { role: 'user', content: [{ type: 'text', text: '我习惯用 pnpm。' }] },
  ]
  assert.equal(latestUserText(messages), '我习惯用 pnpm。')
  const result = captureUserMessage(store, messages)
  assert.equal(result.captured, 1)
  assert.equal(store.list({ namespace: 'default' }).items[0].content, '我习惯用 pnpm')
})
