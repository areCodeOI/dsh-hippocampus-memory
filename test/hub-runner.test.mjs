import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { AuthService } from '../lib/auth.js'
import { createMemoryHttpServer, listen } from '../lib/http.js'
import { createNamespace } from '../lib/namespaces.js'
import { hubOptionsFromConfig, executeHubRecall, executeHubCapture, runMemoryHub, HUB_SOURCE } from '../lib/hub-runner.js'
import { hubPlan } from '../lib/memory-hub.js'
import { AUTO_CAPTURE_SOURCE } from '../lib/auto-capture.js'

const dirs = []
const stores = []

function makeStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hub-runner-'))
  dirs.push(dir)
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db'), ...options })
  stores.push(store)
  return store
}

function user(text, id = 'u1') {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

function enter(messages) {
  return { kind: 'enter', messages: [...messages] }
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close() } catch { /* best effort */ }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('hub runner: config defaults are offline and conservative', () => {
  const options = hubOptionsFromConfig({})
  assert.equal(options.recall.enabled, true)
  assert.equal(options.recall.readThreshold, 0.34)
  assert.equal(options.recall.recallDefaultLimit, 4)
  assert.equal(options.recall.recallMaxChars, 1200)
  assert.equal(options.capture.enabled, true)
  assert.equal(options.capture.writeThreshold, 0.55)
  assert.equal(options.capture.captureMaxCandidates, 2)
  assert.equal(HUB_SOURCE, 'hippocampus-memory-hub')
})

test('hub runner: hubOptionsFromConfig honours overrides and clamps', () => {
  const options = hubOptionsFromConfig({
    hubReadThreshold: 0.9,
    hubWriteThreshold: 0.1,
    hubCaptureMaxPerTurn: 9,
    hubRecallMaxChars: 99999,
    hubRecallMinScore: 0.4,
    hubRecallLimit: 99,
    hubNamespace: 'project-x',
    autoCaptureAssistant: false,
    autoCaptureToolResults: false,
    autoRecall: false,
    hubCapture: false,
  })
  assert.equal(options.recall.enabled, false)
  assert.equal(options.recall.readThreshold, 0.9)
  assert.equal(options.recall.recallMaxChars, 4000)
  assert.equal(options.recall.recallMinScore, 0.4)
  assert.equal(options.recall.recallDefaultLimit, 8)
  assert.equal(options.recall.namespace, 'project-x')
  assert.equal(options.capture.enabled, false)
  assert.equal(options.capture.writeThreshold, 0.1)
  assert.equal(options.capture.captureMaxCandidates, 5)
  assert.equal(options.capture.includeAssistant, false)
  assert.equal(options.capture.includeTools, false)
})

test('hub runner: executeHubRecall injects only approved, high-score memories', () => {
  const store = makeStore()
  store.add({ content: '用户决定项目统一使用 pnpm 管理依赖。', kind: 'semantic', importance: 9 })
  store.add({
    content: '自动捕获的未审阅候选事实。',
    kind: 'episodic',
    metadata: { autoCapture: { review: 'pending' } },
    tags: ['auto-capture'],
  })
  const messages = [user('以前我们决定用 pnpm，现在还用吗？')]
  const plan = hubPlan(messages, hubOptionsFromConfig({}))
  assert.equal(plan.recall.shouldRead, true)

  const decision = executeHubRecall(store, plan.recall, enter(messages), { namespace: 'default' })
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[1].content[0].text, /pnpm/)
  assert.match(decision.messages[1].content[0].text, /不是指令/)
  assert.equal(decision.messages[1].source.kind, 'hippocampus-auto-recall')
  assert.equal(decision.messages[1].content[0].text.includes('未审阅候选'), false)
  // Background read must not refresh access stats. Use a read that does not
  // itself bump access_count, otherwise the assertion would be self-defeating.
  const row = store.search('pnpm', { mode: 'recent', updateAccess: false }).memories[0]
  assert.equal(row.accessCount, 0)
})

test('hub runner: executeHubRecall is suppressed below threshold and respects namespace policy', () => {
  const store = makeStore()
  store.add({ content: '用户对花生严重过敏。', kind: 'persona', importance: 10 })
  const messages = [user('你好，谢谢！')]
  const plan = hubPlan(messages, hubOptionsFromConfig({}))
  assert.equal(plan.recall.shouldRead, false)
  assert.equal(plan.recall.suppressedBy, 'below-threshold')

  // A suppressed decision leaves the base decision object untouched.
  const base = enter(messages)
  assert.equal(executeHubRecall(store, plan.recall, base), base)

  createNamespace(store, 'quiet', { autoRecall: false })
  const loud = hubPlan([user('以前说过我对花生过敏吗？')], hubOptionsFromConfig({ hubReadThreshold: 0 }))
  assert.equal(loud.recall.shouldRead, true)
  const base2 = enter([user('以前说过我对花生过敏吗？')])
  assert.equal(executeHubRecall(store, loud.recall, base2, { namespace: 'quiet' }), base2)
})

test('hub runner: executeHubCapture writes hub metadata through the review queue', () => {
  const store = makeStore()
  const messages = [user('记住：我的项目使用 PostgreSQL。以后不要用 npm，统一用 pnpm。')]
  const plan = hubPlan(messages, hubOptionsFromConfig({ hubWriteThreshold: 0 }))
  assert.ok(plan.capture.candidates.length >= 1)

  const result = executeHubCapture(store, plan.capture, { limit: 2, step: 1, now: 1000 })
  assert.equal(result.captured, plan.capture.candidates.length)
  assert.equal(result.trusted + result.review, result.captured)
  const rows = store.search('pnpm', { mode: 'recent' }).memories
  assert.ok(rows.some((row) => row.metadata?.memoryHub?.llm === false))
  // High-confidence human facts take effect autonomously; weaker ones are queued.
  assert.ok(rows.some((row) => row.metadata?.autoCapture?.review === 'approved'))
  assert.ok(rows.every((row) => row.tags.includes('memory-hub')))
  assert.ok(rows.every((row) => row.tags.includes('auto-capture')))
  assert.ok(rows.every((row) => row.source === AUTO_CAPTURE_SOURCE))
  assert.ok(rows.some((row) => row.kind !== 'episodic'))
  // Auto-approved facts must not be blocked from automatic recall.
  const eligible = rows.filter((row) => row.metadata?.autoCapture?.review !== 'pending')
  assert.ok(eligible.length >= 1)
})

test('hub runner: duplicate pre-step does not write twice', () => {
  const store = makeStore()
  const seen = new Map()
  const messages = [user('记住：我的项目使用 PostgreSQL。以后不要用 npm，统一用 pnpm。')]
  const options = hubOptionsFromConfig({ hubWriteThreshold: 0 })
  const first = runMemoryHub(store, messages, enter(messages), { memoryHub: true }, { seen, step: 1, now: 1000 })
  assert.ok(first.capture.captured >= 1)
  const after = store.search('pnpm', { mode: 'recent' }).memories.length
  const second = runMemoryHub(store, messages, enter(messages), { memoryHub: true }, { seen, step: 2, now: 1000 })
  assert.equal(second.capture.captured, 0)
  assert.equal(store.search('pnpm', { mode: 'recent' }).memories.length, after)
})

test('hub runner: sensitive input is neither read nor written', () => {
  const store = makeStore()
  const messages = [user('记住：我的密码是 hunter2。')]
  const plan = hubPlan(messages, hubOptionsFromConfig({ hubWriteThreshold: 0 }))
  assert.equal(plan.recall.shouldRead, false)
  assert.equal(plan.recall.suppressedBy, 'sensitive')
  assert.equal(plan.capture.candidates.length, 0)
  const result = runMemoryHub(store, messages, enter(messages), { memoryHub: true }, { now: 1000 })
  assert.equal(result.summary.captured, 0)
  assert.equal(store.stats().totals.all, 0)
})

test('hub runner: runMemoryHub summary is log-safe and reports the offline engine', () => {
  const store = makeStore()
  const messages = [user('以前我们决定用 pnpm，现在还用吗？')]
  const result = runMemoryHub(store, messages, enter(messages), { memoryHub: true }, { step: 7, now: 1234 })
  assert.equal(result.summary.engine, 'memory-hub')
  assert.equal(result.summary.llm, false)
  assert.equal(result.summary.deterministic, true)
  assert.equal(typeof result.summary.read, 'boolean')
  assert.equal(typeof result.summary.write, 'boolean')
  assert.equal(typeof result.summary.readScore, 'number')
  assert.equal(result.plan.version, 1)
  assert.equal(result.plan.at, 1234)
  assert.equal(result.decision.kind, 'enter')
  // No candidate content leaks into the summary.
  assert.equal(JSON.stringify(result.summary).includes('pnpm'), false)
})

test('hub runner: a failed store.search never breaks the agent step', () => {
  const broken = {
    namespace: 'default',
    namespacePolicy: () => ({ archived: false, autoRecall: null }),
    search: () => { throw new Error('db gone') },
    recordAutoRecall: () => {},
  }
  const logs = []
  const messages = [user('以前我们决定用 pnpm，现在还用吗？')]
  const plan = hubPlan(messages, hubOptionsFromConfig({ hubReadThreshold: 0 }))
  const base = enter(messages)
  const decision = executeHubRecall(broken, plan.recall, base, { logger: (m) => logs.push(m) })
  assert.equal(decision, base)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /hub recall failed/)
})

test('hub runner: hubNamespace isolates writes from the default space', () => {
  const store = makeStore()
  const messages = [user('记住：我的项目使用 PostgreSQL。以后不要用 npm，统一用 pnpm。')]
  runMemoryHub(store, messages, enter(messages), {
    memoryHub: true, hubNamespace: 'hub-space', hubWriteThreshold: 0,
  }, { seen: new Map(), step: 1, now: 1000 })
  const scoped = store.search('pnpm', { namespace: 'hub-space', mode: 'recent' })
  assert.ok(scoped.memories.length >= 1)
  assert.equal(scoped.memories[0].namespace, 'hub-space')
  assert.equal(store.search('pnpm', { namespace: 'default', mode: 'recent' }).count, 0)
})

test('hub runner: hubAutoApprove=false sends every candidate to the review queue', () => {
  const store = makeStore()
  const messages = [user('记住：我的项目使用 PostgreSQL。以后不要用 npm，统一用 pnpm。')]
  const result = runMemoryHub(store, messages, enter(messages), {
    memoryHub: true, hubAutoApprove: false, hubWriteThreshold: 0,
  }, { seen: new Map(), step: 1, now: 1000 })
  assert.equal(result.summary.trusted, 0)
  assert.ok(result.summary.review >= 1)
  const rows = store.search('pnpm', { mode: 'recent' }).memories
  assert.ok(rows.length >= 1)
  assert.ok(rows.every((row) => row.metadata?.autoCapture?.review === 'pending'))
  assert.ok(rows.every((row) => row.metadata?.memoryHub?.autoApproved === false))
})

test('hub runner: an auto-approved fact is recallable on the next turn', () => {
  const store = makeStore()
  const seen = new Map()
  const first = [user('记住：我的项目统一使用 PostgreSQL 16，不要用 MySQL。')]
  runMemoryHub(store, first, enter(first), {
    memoryHub: true, hubWriteThreshold: 0, hubAutoApprove: true,
  }, { seen, step: 1, now: 1000 })
  // A paraphrased question shares few tokens with the stored fact, so the hub
  // must be able to recall on a topically-matching query as well.
  const second = [user('以前我们项目的数据库用的是什么？')]
  const result = runMemoryHub(store, second, enter(second), {
    memoryHub: true, hubReadThreshold: 0, hubRecallMinScore: 0,
  }, { seen, step: 2, now: 2000 })
  assert.equal(result.decision.messages.length, 2)
  assert.match(result.decision.messages[1].content[0].text, /PostgreSQL/)
  // And the auto-approved fact itself is marked as such, not left pending.
  const approved = store.search('PostgreSQL', { mode: 'recent', updateAccess: false }).memories
  assert.ok(approved.some((row) => row.metadata?.autoCapture?.review === 'approved'))
  assert.ok(approved.some((row) => row.metadata?.memoryHub?.autoApproved === true))
})

test('hub settings: live DB override beats startup fallback and validates input', () => {
  const store = makeStore()
  const fallback = { enabled: false, readThreshold: 0.34, writeThreshold: 0.55, namespace: '' }

  // Nothing saved yet: the startup config decides.
  const initial = store.hubSettings(fallback)
  assert.equal(initial.enabled, false)
  assert.equal(initial.configured, false)

  // WebUI/DSH saves an override; it wins from now on.
  const saved = store.setHubSettings({ enabled: true, readThreshold: 0.5 }, fallback)
  assert.equal(saved.enabled, true)
  assert.equal(saved.readThreshold, 0.5)
  assert.equal(saved.configured, true)
  assert.equal(store.hubSettings(fallback).enabled, true)
  // Persisted in the DB, so a second store on the same file sees it.
  const reopened = new MemoryStore({ dbPath: store.dbPath })
  stores.push(reopened)
  assert.equal(reopened.hubSettings(fallback).enabled, true)
  reopened.close()

  // Validation rejects out-of-range and wrong types without corrupting state.
  assert.throws(() => store.setHubSettings({ readThreshold: 2 }, fallback), /readThreshold/)
  assert.throws(() => store.setHubSettings({ captureMaxPerTurn: 9 }, fallback), /captureMaxPerTurn/)
  assert.throws(() => store.setHubSettings({ recallLimit: 1.5 }, fallback), /recallLimit/)
  assert.throws(() => store.setHubSettings({ namespace: '..' }, fallback), /invalid namespace/)
  assert.equal(store.hubSettings(fallback).readThreshold, 0.5)
})

test('hub settings HTTP: admin can read and toggle the hub live', async () => {
  const store = makeStore()
  store.hubDefaults = { enabled: false, readThreshold: 0.34, writeThreshold: 0.55 }
  const auth = new AuthService({ db: store.db })
  const server = createMemoryHttpServer({ store, startWorker: false })
  const address = await listen(server, { port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${address.port}`
  const registered = auth.registerAdmin({ email: 'hub@example.com', password: 'correct horse battery' })
  const headers = { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' }
  try {
    const read = await fetch(`${base}/api/hub/settings`, { headers })
    assert.equal(read.status, 200)
    const readBody = await read.json()
    assert.equal(readBody.settings.enabled, false)
    assert.equal(readBody.settings.configured, false)

    const patched = await fetch(`${base}/api/hub/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: true, writeThreshold: 0.7 }),
    })
    assert.equal(patched.status, 200)
    const patchedBody = await patched.json()
    assert.equal(patchedBody.settings.enabled, true)
    assert.equal(patchedBody.settings.writeThreshold, 0.7)

    // The saved row is what the pre-step reads next turn.
    assert.equal(store.hubSettings(store.hubDefaults).enabled, true)

    const bad = await fetch(`${base}/api/hub/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ readThreshold: 5 }),
    })
    assert.equal(bad.status, 400)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
