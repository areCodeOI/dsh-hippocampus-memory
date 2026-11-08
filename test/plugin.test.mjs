import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { apply, resolveLanguage } from '../index.js'
import { TOOL_DEFS, TOOL_NAMES } from '../lib/tools.js'
import { DatabaseSync } from 'node:sqlite'

const dirs = []
const disposers = []

function fakeContext() {
  const tools = new Map()
  const sections = []
  const effects = []
  const handlers = new Map()
  const ctx = {
    effect(fn) {
      const disposable = fn()
      effects.push(disposable)
      return disposable
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    inject(_names, callback) {
      callback({
        systemPrompt: {
          section(definition) {
            sections.push(definition)
            return () => {}
          },
        },
        effect(fn) {
          const disposable = fn()
          effects.push(disposable)
          return disposable
        },
      })
    },
  }
  disposers.push(() => {
    for (const effect of [...effects].reverse()) {
      try {
        if (typeof effect === 'function') effect()
        else if (typeof effect?.dispose === 'function') effect.dispose()
      } catch {
        // cleanup is best effort
      }
    }
  })
  return { ctx, tools, sections, effects, handlers }
}

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-plugin-'))
  dirs.push(dir)
  return path.join(dir, 'memory.db')
}

afterEach(() => {
  // Windows returns EPERM when rm -rf hits an open SQLite handle: dispose the
  // plugin/store first, then delete the temp directory.
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      dispose()
    } catch {
      // best effort
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('plugin: registers all memory tools and executes with the DSH session id', async () => {
  const { ctx, tools, sections } = fakeContext()
  const dbPath = tempDb()
  apply(ctx, { dbPath, autoReplay: false, injectPrompt: true, promptLanguage: 'zh' })

  assert.deepEqual([...tools.keys()], TOOL_NAMES)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'hippocampus:memory-protocol')
  assert.match(sections[0].text, /memory_search/)

  const add = tools.get('memory_add')
  const added = await add.execute(
    { content: '用户在 DSH 里偏好简体中文回答。', kind: 'persona', importance: 8 },
    { agent: { id: 'session-abc' } },
  )
  assert.equal(added.action, 'created')
  assert.equal(added.memory.source, 'dsh')
  assert.equal(added.memory.sourceSession, 'session-abc')

  const search = await tools.get('memory_search').execute(
    { query: '偏好 简体中文' },
    { agent: { id: 'session-abc' } },
  )
  assert.equal(search.count, 1)
  assert.equal(search.memories[0].importance, 8)

  const rendered = add.output.render({}, added)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /session-abc/)

  const stats = await tools.get('memory_stats').execute({}, {})
  assert.equal(stats.totals.all, 1)
})

test('plugin: auto-recall injects relevant memories before the model answers', async () => {
  const { ctx, tools, handlers } = fakeContext()
  const dbPath = tempDb()
  apply(ctx, { dbPath, autoReplay: false, injectPrompt: false, autoRecall: true })
  const added = await tools.get('memory_add').execute(
    { content: '用户对花生严重过敏，必须避免含花生食品。', kind: 'persona', importance: 10 },
    {},
  )
  assert.equal(added.action, 'created')
  const handler = handlers.get('agent/pre-step')
  assert.equal(typeof handler, 'function')
  const user = {
    id: 'u-auto',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '晚上吃点什么？我对什么过敏？' }],
  }
  const decision = await handler(
    { messages: [user], step: 1 },
    async () => ({ kind: 'enter', messages: [user] }),
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[1].content[0].text, /花生/)
  assert.equal(decision.messages[1].source.kind, 'hippocampus-auto-recall')

  // The injection is recorded so the panel can show that recall is in use.
  const db = new DatabaseSync(dbPath)
  const meta = db.prepare("SELECT value FROM meta WHERE key = 'auto_recall_count'").get()
  const last = db.prepare("SELECT value FROM meta WHERE key = 'auto_recall_last_count'").get()
  db.close()
  assert.ok(Number(meta?.value) >= 1)
  assert.ok(Number(last?.value) >= 1)
})

test('plugin: can disable prompt injection while keeping the tools', () => {
  const { ctx, tools, sections } = fakeContext()
  apply(ctx, { dbPath: tempDb(), autoReplay: false, injectPrompt: false })
  assert.equal(tools.size, TOOL_NAMES.length)
  assert.equal(sections.length, 0)
})

test('plugin: tools are disposed and the database is closed with the plugin', async () => {
  const { ctx, tools, effects } = fakeContext()
  apply(ctx, { dbPath: tempDb(), autoReplay: false, injectPrompt: false })
  const add = tools.get('memory_add')
  await add.execute({ content: '临时记忆。', kind: 'buffer' }, {})
  for (const effect of effects) if (typeof effect === 'function') effect()
  assert.equal(tools.size, 0)
  await assert.rejects(add.execute({ content: '写不进去了。' }, {}))
})

test('plugin: promptLanguage auto resolves en for English locales and defaults to zh', () => {
  assert.equal(resolveLanguage({ promptLanguage: 'auto' }, { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveLanguage({ promptLanguage: 'auto' }, { DSH_LANG: 'en-US', LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(resolveLanguage({ promptLanguage: 'auto' }, { LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(resolveLanguage({ promptLanguage: 'auto' }, { LANG: 'C.UTF-8' }), 'zh')
  assert.equal(resolveLanguage({ promptLanguage: 'en' }, { LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(resolveLanguage({ promptLanguage: 'zh' }, { LANG: 'en_US.UTF-8' }), 'zh')
})

test('plugin: auto-recall does not refresh access stats and survives long messages', async () => {
  const { ctx, tools, handlers } = fakeContext()
  const dbPath = tempDb()
  apply(ctx, { dbPath, autoReplay: false, injectPrompt: false, autoRecall: true })
  const added = await tools.get('memory_add').execute(
    { content: '用户对花生严重过敏，必须避免含花生食品。', kind: 'persona', importance: 10 },
    {},
  )
  assert.equal(added.action, 'created')
  const readAccess = () => {
    const db = new DatabaseSync(dbPath)
    const row = db.prepare('SELECT access_count, last_access_at FROM memories LIMIT 1').get()
    db.close()
    return row
  }
  const before = readAccess()
  const handler = handlers.get('agent/pre-step')
  const user = {
    id: 'u-long',
    role: 'user',
    source: { kind: 'user' },
    // 1500 chars: store.search rejects >1000, so auto-recall must trim.
    content: [{ type: 'text', text: `我对坚果过敏吗？请结合历史说明。${'这是很长的上下文内容。'.repeat(120)}` }],
  }
  const decision = await handler({ messages: [user], step: 1 }, async () => ({ kind: 'enter', messages: [user] }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[1].content[0].text, /花生/)

  // A background recall is not a user access: no decay refresh.
  const after = readAccess()
  assert.equal(after.access_count, 0)
  assert.equal(after.last_access_at, before.last_access_at)
})

test('plugin: tool schemas avoid minimum/maximum for provider compatibility', () => {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    assert.equal('minimum' in node, false)
    assert.equal('maximum' in node, false)
    for (const value of Object.values(node)) walk(value)
  }
  for (const definition of Object.values(TOOL_DEFS)) walk(definition.parameters)
})
