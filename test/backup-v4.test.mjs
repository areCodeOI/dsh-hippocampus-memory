import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { listNamespaces, createNamespace, updateNamespace, mergeNamespaces } from '../lib/namespaces.js'
import { createBackup, listBackups, restoreBackup } from '../lib/backup.js'
import { createRuntime } from '../lib/runtime.js'
import { callTool } from '../lib/tools.js'

const dirs = []
const stores = []

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-v4-'))
  dirs.push(dir)
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  stores.push(store)
  return { store, dir }
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

test('schema v4: namespaces table is created and meta registry is migrated', () => {
  const { store, dir } = makeStore()
  store.add({ content: 'legacy namespace memory', kind: 'semantic', namespace: 'legacy-a', confirmed: true })
  store.db.exec('DROP TABLE namespaces')
  store.db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run()
  store.db
    .prepare("INSERT INTO meta (key, value) VALUES ('namespace_registry', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(['legacy-a', 'legacy-b']))
  store.close()

  const reopened = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  try {
    assert.equal(reopened.stats().schemaVersion, 4)
    const names = reopened.db.prepare('SELECT name FROM namespaces ORDER BY name').all().map((row) => row.name)
    assert.deepEqual(names, ['legacy-a', 'legacy-b'])
    const list = listNamespaces(reopened).namespaces
    assert.equal(list.find((item) => item.name === 'legacy-a').total, 1)
    assert.equal(list.find((item) => item.name === 'legacy-b').reserved, true)
  } finally {
    reopened.close()
  }
})

test('namespace policy: read-only blocks writes and retention archives through replay', () => {
  const { store } = makeStore()
  createNamespace(store, 'locked', { description: 'read only', readOnly: true })
  assert.throws(() => store.add({ content: 'blocked', namespace: 'locked' }), /read-only/)
  updateNamespace(store, 'locked', { readOnly: false })
  const added = store.add({ content: 'allowed after unlock', kind: 'semantic', namespace: 'locked', confirmed: true })
  assert.equal(added.action, 'created')

  createNamespace(store, 'short-retention', { retentionDays: 1 })
  const old = store.add({ content: 'old memory', kind: 'semantic', namespace: 'short-retention', confirmed: true })
  store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(Date.now() - 3 * 86_400_000, old.memory.id)
  const result = store.replay({ namespace: 'short-retention' })
  assert.ok(result.archived >= 1)
  assert.equal(store.getMemory(old.memory.id).status, 'archived')
})

test('backup/restore: logical snapshot includes memories and namespace metadata', () => {
  const { store, dir } = makeStore()
  createNamespace(store, 'project-a', { description: 'A project', color: '#123456' })
  store.add({ content: 'snapshot memory one', kind: 'semantic', namespace: 'project-a', confirmed: true })
  updateNamespace(store, 'project-a', { readOnly: true })
  store.add({ content: 'snapshot memory two', kind: 'semantic', namespace: 'default', confirmed: true })
  const backupDir = path.join(dir, 'backups')
  const backup = createBackup(store, { backupDir, label: 'test' })
  assert.ok(fs.existsSync(backup.file))
  if (process.platform !== 'win32') assert.equal(fs.statSync(backup.file).mode & 0o777, 0o600)
  assert.equal(listBackups({ backupDir }).backups.length, 1)

  store.add({ content: 'after backup', kind: 'semantic', namespace: 'default', confirmed: true })
  const dry = restoreBackup({ store, backupDir, name: backup.name, dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.snapshot.memories, 2)
  const restored = restoreBackup({ store, backupDir, name: backup.name, dryRun: false })
  assert.equal(restored.dryRun, false)
  assert.equal(restored.restored.imported, 2)
  assert.equal(store.stats().totals.all, 2)
  const project = listNamespaces(store).namespaces.find((item) => item.name === 'project-a')
  assert.equal(project.description, 'A project')
  assert.equal(project.color, '#123456')
  assert.equal(project.readOnly, true)
  assert.ok(restored.preRestoreBackup.name)
})

test('namespace jobs: merge runs through the job queue and reports progress', async () => {
  const { store } = makeStore()
  store.add({ content: 'job source memory', kind: 'semantic', namespace: 'source', confirmed: true })
  store.add({ content: 'job target memory', kind: 'semantic', namespace: 'target', confirmed: true })
  const runtime = createRuntime({ store, startWorker: false })
  const job = runtime.jobs.enqueue('namespace_merge', { namespace: 'source', from: 'source', into: 'target' }, { createdBy: 'test' })
  const finished = await runtime.jobs.runOnce(runtime.handlers)
  assert.equal(finished.id, job.id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.progress, 1)
  assert.equal(finished.result.into, 'target')
  assert.equal(store.list({ namespace: 'target' }).total, 2)
  assert.equal(listNamespaces(store).namespaces.some((item) => item.name === 'source'), false)
})

test('memory_namespace tool is read-only and scoped by caller namespaces', async () => {
  const { store } = makeStore()
  createNamespace(store, 'project-a', { description: 'visible' })
  store.add({ content: 'project a', kind: 'semantic', namespace: 'project-a', confirmed: true })
  store.add({ content: 'secret', kind: 'semantic', namespace: 'secret', confirmed: true })
  const scoped = await callTool(store, 'memory_namespace', {}, { namespaces: ['project-a'] })
  assert.deepEqual(scoped.namespaces.map((item) => item.name), ['project-a'])
  const all = await callTool(store, 'memory_namespace', { includeArchived: true }, {})
  assert.ok(all.namespaces.some((item) => item.name === 'secret'))
})
