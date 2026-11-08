import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'

const dirs = []

function makeStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-store-'))
  dirs.push(dir)
  let clock = options.now ?? Date.now()
  const store = new MemoryStore({
    dbPath: path.join(dir, 'memory.db'),
    namespace: options.namespace ?? 'default',
    now: () => clock,
    retrievalLimit: 5,
  })
  return {
    store,
    dir,
    advance(days) {
      clock += days * 86_400_000
    },
    get now() {
      return clock
    },
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('add + search: stores one fact, preserves Chinese punctuation, explains recall', () => {
  const { store } = makeStore()
  const added = store.add({
    content: '用户对花生过敏，严重时需立即就医。',
    kind: 'persona',
    importance: 10,
    tags: ['健康', '过敏'],
    sourceSession: 'session-a',
  })
  assert.equal(added.action, 'created')
  assert.equal(added.memory.content, '用户对花生过敏，严重时需立即就医。')
  assert.equal(added.memory.importance, 10)
  assert.equal(added.memory.confirmed, true)
  assert.deepEqual(added.memory.tags, ['健康', '过敏'])

  const result = store.search('花生过敏', { limit: 3 })
  assert.equal(result.count, 1)
  assert.equal(result.memories[0].id, added.memory.id)
  assert.match(result.memories[0].why, /花生过敏/)
  assert.ok(result.memories[0].score > 0.5)
  assert.equal(result.memories[0].accessCount, 1)
  store.close()
})

test('dedupe: exact and near duplicates reinforce instead of growing the bank', () => {
  const { store } = makeStore()
  const first = store.add({ content: '用户喜欢喝拿铁咖啡。', kind: 'persona', importance: 7 })
  const second = store.add({ content: '用户喜欢喝拿铁咖啡。', kind: 'persona', importance: 8, tags: ['饮品'] })
  assert.equal(second.action, 'reinforced')
  assert.equal(second.memory.id, first.memory.id)
  assert.equal(second.memory.accessCount, 1)
  assert.equal(second.memory.importance, 8)
  assert.deepEqual(second.memory.tags, ['饮品'])
  assert.equal(store.stats().totals.all, 1)
  assert.equal(store.search('拿铁').count, 1)
  store.close()
})

test('expansion: additional detail merges into the existing memory', () => {
  const { store } = makeStore()
  const first = store.add({ content: '项目 Kestrel 使用 PostgreSQL 数据库。', kind: 'semantic', confirmed: true })
  const second = store.add({
    content: '项目 Kestrel 使用 PostgreSQL 数据库，版本是 16。',
    kind: 'semantic',
    confirmed: true,
  })
  assert.equal(second.action, 'merged')
  assert.equal(second.memory.id, first.memory.id)
  assert.match(second.memory.content, /补充/)
  assert.match(second.memory.content, /版本是 16/)
  assert.equal(store.stats().totals.all, 1)
  store.close()
})

test('conflict: a negated allergy fact is pending instead of a second active fact', () => {
  const { store } = makeStore()
  const old = store.add({
    content: '用户对花生过敏，严重时需立即就医。',
    kind: 'persona',
    importance: 10,
  })
  assert.equal(old.action, 'created')
  const flipped = store.add({
    content: '用户对花生不过敏，可以放心吃花生酱。',
    kind: 'persona',
    importance: 10,
  })
  assert.equal(flipped.action, 'conflict')
  assert.equal(flipped.memory.status, 'conflict')
  assert.match(flipped.conflict.reason, /否定/)
  assert.equal(store.get(old.memory.id).memory.content, '用户对花生过敏，严重时需立即就医。')
  assert.equal(store.stats().openConflicts, 1)
  assert.equal(store.search('花生过敏').count, 1, 'only the affirmative fact stays active')
  // Unrelated negations stay independent facts.
  assert.equal(store.add({ content: '项目不使用 Redis 缓存。', kind: 'semantic' }).action, 'created')
  assert.equal(store.add({ content: '服务端口固定为 7337。', kind: 'semantic' }).action, 'created')
  assert.equal(store.stats().openConflicts, 1)
  store.close()
})

test('conflict: contradictory numeric facts are not overwritten', () => {
  const { store } = makeStore()
  const old = store.add({
    content: '项目 Kestrel 的生产服务器 IP 是 10.0.0.7。',
    kind: 'semantic',
    importance: 8,
    confirmed: true,
  })
  const next = store.add({
    content: '项目 Kestrel 的生产服务器 IP 是 10.0.0.9。',
    kind: 'semantic',
    importance: 8,
  })
  assert.equal(next.action, 'conflict')
  assert.equal(next.memory.status, 'conflict')
  assert.equal(next.memory.confirmed, false)
  assert.match(next.conflict.reason, /10\.0\.0\.7.*10\.0\.0\.9/)
  assert.equal(store.get(old.memory.id).memory.content, '项目 Kestrel 的生产服务器 IP 是 10.0.0.7。')
  assert.equal(store.stats().openConflicts, 1)
  assert.equal(store.search('Kestrel 服务器').count, 1, 'conflict entries are hidden by default')

  const resolved = store.update(next.memory.id, {
    status: 'active',
    confirmed: true,
    supersede: old.memory.id,
  })
  assert.equal(resolved.updated, true)
  assert.equal(store.get(old.memory.id).memory.status, 'superseded')
  assert.equal(store.get(next.memory.id).memory.status, 'active')
  assert.equal(store.stats().openConflicts, 0)
  store.close()
})

test('search: no match returns an explicit empty result, never a fabricated memory', () => {
  const { store } = makeStore()
  store.add({ content: '用户喜欢喝拿铁咖啡。', kind: 'persona' })
  const result = store.search('量子计算火箭发动机')
  assert.equal(result.count, 0)
  assert.deepEqual(result.memories, [])
  assert.match(result.message, /无匹配记忆/)
  store.close()
})

test('decay: stale buffer memories are archived, junk is purged after the grace period', () => {
  const { store, advance } = makeStore()
  const archived = store.add({ content: '临时记一下：这次先用紫色主题。', kind: 'buffer', importance: 1, confidence: 0.3 })
  advance(40)
  let replay = store.replay({})
  assert.equal(replay.archived, 1)
  assert.equal(store.get(archived.memory.id).memory.status, 'archived')
  assert.equal(store.search('紫色主题').count, 0)
  assert.equal(store.search('紫色主题', { includeArchived: true }).count, 1)

  advance(70)
  replay = store.replay({})
  assert.equal(replay.pendingDelete, 1)
  assert.equal(store.get(archived.memory.id, { restore: false }).memory.status, 'pending_delete')

  advance(8)
  replay = store.replay({})
  assert.equal(replay.purged, 1)
  assert.equal(store.get(archived.memory.id).found, false)
  store.close()
})

test('restore: reading a pending-delete memory rescues it', () => {
  const { store } = makeStore()
  const memory = store.add({ content: '旧密码提示词是海马体。', kind: 'episodic', importance: 3 })
  const removed = store.remove(memory.memory.id)
  assert.equal(removed.hard, false)
  assert.ok(removed.purgeAfter > Date.now() - 1000)
  const restored = store.get(memory.memory.id)
  assert.equal(restored.found, true)
  assert.equal(restored.restored, true)
  assert.equal(restored.memory.status, 'active')
  store.close()
})

test('replay: consolidates similar episodes into one semantic memory, idempotently', () => {
  const { store, advance } = makeStore()
  for (const content of [
    '服务器上传大包时连接被重置，重试后成功。',
    '部署时上传 200MB 包连接重置，改用分片上传成功。',
    '大文件上传又遇到连接重置，改用 rsync 分片后正常。',
  ]) {
    store.add({ content, kind: 'episodic', importance: 5, confidence: 0.8, tags: ['部署', '上传'] })
  }
  advance(2)
  const replay = store.replay({})
  assert.equal(replay.consolidated, 1)
  const stats = store.stats()
  assert.equal(stats.byKind.semantic, 1)
  assert.equal(stats.byKind.episodic, 3)

  const semantic = store.search('上传 连接 重置', { kinds: ['semantic'] })
  assert.equal(semantic.count, 1)
  assert.match(semantic.memories[0].content, /【回放提炼】/)
  assert.match(semantic.memories[0].content, /部署|上传|连接/)

  advance(2)
  const again = store.replay({})
  assert.equal(again.consolidated, 0, 'consolidation must not duplicate itself')
  assert.equal(store.stats().byKind.semantic, 1)
  store.close()
})

test('namespace: agents can keep separate memory spaces', () => {
  const { store } = makeStore({ namespace: 'agent-a' })
  store.add({ content: 'agent-a 的项目代号是 Aurora。', kind: 'semantic', namespace: 'agent-a', confirmed: true })
  store.add({ content: 'agent-b 的项目代号是 Borealis。', kind: 'semantic', namespace: 'agent-b', confirmed: true })

  assert.equal(store.search('项目代号', { namespace: 'agent-a' }).count, 1)
  assert.equal(store.search('项目代号', { namespace: 'agent-b' }).count, 1)
  assert.equal(store.search('Aurora', { namespace: 'agent-b' }).count, 0)
  assert.equal(store.search('Aurora', { namespace: '*' }).count, 1)
  assert.equal(store.stats().byNamespace['agent-b'], 1)
  store.close()
})

test('export/import: a JSON snapshot can rebuild the bank', () => {
  const { store } = makeStore()
  store.add({ content: '用户的时区是 Asia/Shanghai。', kind: 'persona', importance: 9 })
  store.add({ content: '项目 Kestrel 的数据库是 PostgreSQL 16。', kind: 'semantic', confirmed: true })
  const snapshot = store.exportAll()
  assert.equal(snapshot.format, 'hippocampus-memory')
  assert.equal(snapshot.memories.length, 2)

  const second = makeStore()
  const result = second.store.importAll(snapshot)
  assert.equal(result.imported, 2)
  assert.equal(second.store.stats().totals.all, 2)
  assert.equal(second.store.search('时区').count, 1)
  assert.equal(second.store.search('PostgreSQL').count, 1)
  store.close()
  second.store.close()
})

test('persona memories require an explicit force to delete', () => {
  const { store } = makeStore()
  const memory = store.add({ content: '用户讨厌香菜。', kind: 'persona', importance: 9 })
  assert.throws(() => store.remove(memory.memory.id), /force=true/)
  const removed = store.remove(memory.memory.id, { hard: true, confirm: true, force: true })
  assert.equal(removed.hard, true)
  assert.equal(store.get(memory.memory.id).found, false)
  store.close()
})

test('importance defaults are inferred by layer and strong cues', () => {
  const { store } = makeStore()
  const buffer = store.add({ content: '这次先用蓝色主题。', kind: 'buffer' })
  const persona = store.add({ content: '用户的生日是 3 月 14 日。', kind: 'persona' })
  const semantic = store.add({ content: '项目 Kestrel 用 Node.js 24。', kind: 'semantic', confirmed: true })
  assert.equal(buffer.memory.importance, 2)
  assert.ok(persona.memory.importance >= 8)
  assert.ok(semantic.memory.importance >= 6)
  store.close()
})

test('re-add: writing an archived or pending-delete fact restores it instead of duplicating', () => {
  const { store, advance } = makeStore()
  const memory = store.add({ content: '用户喜欢喝乌龙茶。', kind: 'semantic', importance: 7, confirmed: true })
  store.archive(memory.memory.id)
  assert.equal(store.get(memory.memory.id).memory.status, 'archived')
  const again = store.add({ content: '用户喜欢喝乌龙茶。', kind: 'semantic', importance: 7, confirmed: true })
  assert.equal(again.action, 'reinforced')
  assert.equal(again.memory.id, memory.memory.id)
  assert.equal(again.memory.status, 'active')
  assert.equal(store.stats().totals.archived, 0)

  store.remove(memory.memory.id)
  assert.equal(store.get(memory.memory.id, { restore: false }).memory.status, 'pending_delete')
  const third = store.add({ content: '用户喜欢喝乌龙茶。', kind: 'semantic', importance: 7, confirmed: true })
  assert.equal(third.memory.id, memory.memory.id)
  assert.equal(third.memory.status, 'active')
  assert.equal(store.stats().totals.pendingDelete, 0)
  store.close()
})

test('update: reactivating a pending-delete memory clears its purge deadline', () => {
  const { store } = makeStore()
  const memory = store.add({ content: '这条稍后要恢复。', kind: 'episodic', importance: 3 })
  store.remove(memory.memory.id)
  const reactivated = store.update(memory.memory.id, { status: 'active' })
  assert.equal(reactivated.memory.status, 'active')
  assert.equal(reactivated.memory.purgeAfter, null)
  assert.equal(store.search('稍后要恢复').count, 1)
  store.close()
})

test('supersede: settled knowledge is not replaced without explicit confirmation', () => {
  const { store } = makeStore()
  const old = store.add({ content: '项目 Kestrel 的数据库是 PostgreSQL。', kind: 'semantic', confirmed: true })
  const conflict = store.add({
    content: '项目 Kestrel 的数据库是 MySQL。',
    kind: 'persona',
    supersedes: old.memory.id,
    dedupe: 'force',
  })
  assert.equal(conflict.action, 'conflict')
  assert.equal(store.get(old.memory.id).memory.status, 'active', 'old settled memory stays active')
  store.close()
})

test('conflict: confirming a pending fact without naming the counterpart retires the old one', () => {
  const { store } = makeStore()
  const old = store.add({ content: '项目 Kestrel 的端口是 8080。', kind: 'semantic', importance: 7, confirmed: true })
  const pending = store.add({ content: '项目 Kestrel 的端口是 9090。', kind: 'semantic', importance: 7 })
  assert.equal(pending.action, 'conflict')
  store.update(pending.memory.id, { status: 'active', confirmed: true })
  assert.equal(store.get(old.memory.id).memory.status, 'superseded')
  assert.equal(store.get(pending.memory.id).memory.status, 'active')
  assert.equal(store.stats().openConflicts, 0)
  store.close()
})

test('list/getMany: paginated management reads and hybrid vector candidates', () => {
  const { store } = makeStore()
  const cat = store.add({ content: '用户养了一只猫。', kind: 'semantic', confirmed: true })
  const dog = store.add({ content: '用户养了一只狗。', kind: 'semantic', confirmed: true })
  const page = store.list({ limit: 1, offset: 0, namespace: 'default' })
  assert.equal(page.items.length, 1)
  assert.equal(page.total, 2)
  assert.equal(store.getMany([cat.memory.id, dog.memory.id]).length, 2)

  const hybrid = store.search('完全无关的查询词', {
    extraIds: [cat.memory.id],
    vectorScores: new Map([[cat.memory.id, 0.95]]),
    updateAccess: false,
  })
  assert.equal(hybrid.count, 1)
  assert.equal(hybrid.memories[0].id, cat.memory.id)
  assert.ok(hybrid.memories[0].vectorScore > 0.9)

  const other = store.add({ content: '另一个空间的秘密。', kind: 'semantic', namespace: 'other', confirmed: true })
  const isolated = store.search('完全无关的查询词', {
    namespace: 'default',
    extraIds: [other.memory.id],
    vectorScores: new Map([[other.memory.id, 0.99]]),
    updateAccess: false,
  })
  assert.equal(isolated.count, 0, 'vector extras must respect namespace isolation')
  store.close()
})

test('stats: records automatic recall usage counters', () => {
  const { store, now } = makeStore()
  assert.equal(store.stats().autoRecall.count, 0)
  store.recordAutoRecall({ count: 2, chars: 120 })
  const stats = store.stats()
  assert.equal(stats.autoRecall.count, 1)
  assert.equal(stats.autoRecall.hits, 2)
  assert.equal(stats.autoRecall.lastCount, 2)
  assert.equal(stats.autoRecall.lastChars, 120)
  assert.equal(stats.autoRecall.lastAt, now)
  store.recordAutoRecall({ count: 1 })
  assert.equal(store.stats().autoRecall.count, 2)
  assert.equal(store.stats().autoRecall.hits, 3)
  store.close()
})

test('conflicts: episodic dates/sequence numbers are separate events, not numeric conflicts', () => {
  const { store } = makeStore()
  const first = store.add({
    content: '2026-11-01 部署时 7337 端口被占用，临时改用 7451。',
    kind: 'episodic',
    importance: 5,
  })
  const second = store.add({
    content: '2026-11-02 部署时 7337 端口被占用，临时改用 7451。',
    kind: 'episodic',
    importance: 5,
  })
  assert.notEqual(first.action, 'conflict')
  assert.notEqual(second.action, 'conflict')
  assert.equal(store.stats().openConflicts, 0)
  assert.equal(store.stats().totals.all, 2, 'different days are different events')

  const a = store.add({ content: 'Kestrel 服务器 IP 是 10.0.0.1。', kind: 'semantic', importance: 7 })
  const b = store.add({ content: 'Kestrel 服务器 IP 是 10.0.0.2。', kind: 'semantic', importance: 7 })
  assert.notEqual(a.action, 'conflict')
  assert.equal(b.action, 'conflict', 'semantic IP change is still a conflict')
  assert.equal(store.stats().openConflicts, 1)
  store.close()
})
