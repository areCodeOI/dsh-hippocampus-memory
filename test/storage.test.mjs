import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { defaultDataDir, pluginRoot, resolveStorageConfig } from '../lib/paths.js'
import { translatePlaceholders, translateSql } from '../lib/pg-sync.js'
import { buildGraph, resolveGraphProvider } from '../lib/graph.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hippocampus-storage-'))
}

test('storage: explicit SQLite path wins', () => {
  const dir = tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const storage = resolveStorageConfig({ dbPath })
  assert.equal(storage.driver, 'sqlite')
  assert.equal(storage.dbPath, dbPath)
})

test('storage: explicit dataDir is resolved and used', () => {
  const dir = tempDir()
  const storage = resolveStorageConfig({ dataDir: dir })
  assert.equal(storage.driver, 'sqlite')
  assert.equal(storage.dbPath, path.join(dir, 'memory.db'))
})

test('storage: PostgreSQL config from pgUrl and redacts password', () => {
  const storage = resolveStorageConfig({ storage: 'postgres', pgUrl: 'postgres://user:secret@db.example:5432/memory' })
  assert.equal(storage.driver, 'postgres')
  assert.match(storage.dbPath, /PostgreSQL|postgres/)
  assert.doesNotMatch(storage.dbPath, /secret/)
  assert.equal(storage.schema, 'public')
})

test('storage: PostgreSQL without a URL fails clearly', () => {
  assert.throws(() => resolveStorageConfig({ storage: 'postgres' }), /requires pgUrl|HIPPOCAMPUS_PG_URL/)
})

test('storage: plugin data directory is absolute and namespaced', () => {
  const dir = defaultDataDir({ location: 'plugin' })
  assert.ok(path.isAbsolute(dir))
  assert.ok(dir.includes('.data') || dir.includes('hippocampus'))
  assert.equal(path.isAbsolute(pluginRoot()), true)
})

test('SQL bridge: placeholders skip string literals and comments', () => {
  assert.equal(translatePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2')
  assert.equal(translatePlaceholders("SELECT '?' AS q, ? AS x -- ?\n"), "SELECT '?' AS q, $1 AS x -- ?\n")
  assert.equal(translatePlaceholders('SELECT * FROM t WHERE tag = ?::vector'), 'SELECT * FROM t WHERE tag = $1::vector')
})

test('SQL bridge: INSERT OR IGNORE becomes a PostgreSQL upsert', () => {
  const sql = translateSql('INSERT OR IGNORE INTO conflicts (id) VALUES (?)')
  assert.match(sql, /^INSERT INTO conflicts/)
  assert.match(sql, /ON CONFLICT DO NOTHING/)
  assert.match(sql, /\$1/)
})

test('SQL bridge: SQLite-only statements are rejected or skipped', () => {
  assert.equal(translateSql('PRAGMA journal_mode = WAL'), null)
  assert.equal(translateSql('BEGIN IMMEDIATE'), 'BEGIN')
  assert.throws(() => translateSql('VACUUM INTO ?'), /SQLite-only/)
})

test('store: change sequence persists across reopen and write leases block peers', () => {
  const dir = tempDir()
  const dbPath = path.join(dir, 'memory.db')
  const store = new MemoryStore({ dbPath, now: () => 1_800_000_000_000 })
  store.add({ content: '存储层测试事实', kind: 'semantic', namespace: 'default', dedupe: 'new' })
  const seq = store.changeSeq
  assert.ok(seq > 0)
  const first = store.withMaintenanceLease('test-lock', 60_000, () => {
    const second = store.withMaintenanceLease('test-lock', 60_000, () => 'should-not-run')
    assert.equal(second.skipped, true)
    return 'acquired'
  })
  assert.equal(first, 'acquired')
  store.close()
  const reopened = new MemoryStore({ dbPath })
  assert.ok(reopened.changeSeq >= seq)
  reopened.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('graph: providers are explicit and postgres requires postgres storage', () => {
  const dir = tempDir()
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  store.add({ content: '图 provider 测试', kind: 'semantic', namespace: 'default', dedupe: 'new' })
  assert.equal(resolveGraphProvider(store, 'projection'), 'projection')
  assert.throws(() => resolveGraphProvider(store, 'postgres'), /requires storage=postgres/)
  const graph = buildGraph(store, { provider: 'projection', namespace: 'default' })
  assert.equal(graph.provider, 'projection')
  assert.equal(graph.nodes.length, 1)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
