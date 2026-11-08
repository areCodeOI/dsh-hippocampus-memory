#!/usr/bin/env node
/**
 * Optional PostgreSQL integration test (skipped when HIPPOCAMPUS_TEST_PG_URL is
 * not set or the optional pg package is absent). CI runs this with a postgres
 * service; local runs stay SQLite-only.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { MemoryStore } from '../lib/store.js'
import { createNamespace, updateNamespace, renameNamespace, mergeNamespaces, deleteNamespace } from '../lib/namespaces.js'
import { createBackup, restoreBackup } from '../lib/backup.js'

const url = process.env.HIPPOCAMPUS_TEST_PG_URL
if (!url) {
  console.log('SKIP PostgreSQL integration: HIPPOCAMPUS_TEST_PG_URL is not set')
  process.exit(0)
}
try {
  createRequire(import.meta.url).resolve('pg')
} catch {
  console.log('SKIP PostgreSQL integration: optional pg package is not installed')
  process.exit(0)
}

const schema = `hippo_ci_${Date.now()}_${process.pid}`
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pg-'))
const backupDir = path.join(dir, 'backups')
const storage = { driver: 'postgres', url, schema, pgvector: false, poolMax: 2, statementTimeoutMs: 15000 }
let store = new MemoryStore({ storage, namespace: 'default' })
let passed = 0
function ok(label) {
  passed += 1
  console.log('✔', label)
}

try {
  store.add({ content: 'PG 默认空间记忆。', kind: 'semantic', confirmed: true })
  createNamespace(store, 'project-a', { description: 'pg project', color: '#abcdef' })
  store.add({ content: 'PG 项目空间记忆。', kind: 'semantic', namespace: 'project-a', confirmed: true })
  ok('PG create/write')

  updateNamespace(store, 'project-a', { readOnly: true })
  assert.throws(() => store.add({ content: 'blocked', namespace: 'project-a' }), /read-only/)
  updateNamespace(store, 'project-a', { readOnly: false })
  ok('PG read-only policy')

  const backup = createBackup(store, { backupDir, label: 'pg-test' })
  store.add({ content: 'PG 备份后新增。', kind: 'semantic', namespace: 'project-a', confirmed: true })
  const restored = restoreBackup({ store, backupDir, name: backup.name, dryRun: false })
  assert.equal(restored.dryRun, false)
  assert.equal(store.stats().totals.all, 2)
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE namespace = 'project-a'").get().n), 1)
  ok('PG backup/restore')

  const renamed = renameNamespace(store, 'project-a', 'project-b', { backup: false })
  assert.equal(renamed.moved, 1)
  mergeNamespaces(store, 'project-b', 'default', { backup: false })
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE namespace = 'project-b'").get().n), 0)
  ok('PG rename/merge')

  createNamespace(store, 'temp', {})
  const soft = deleteNamespace(store, 'temp', { backup: false })
  assert.equal(soft.hard, false)
  ok('PG delete')

  // Simulate a v3 database, then reopen and verify the v4 migration.
  store.db.execute('DROP TABLE namespaces')
  store.db.execute("UPDATE meta SET value = '3' WHERE key = 'schema_version'")
  store.db.execute(
    `INSERT INTO meta (key, value) VALUES ('namespace_registry', '["legacy-pg"]') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
  store.close()
  store = new MemoryStore({ storage, namespace: 'default' })
  assert.equal(store.stats().schemaVersion, 4)
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM namespaces WHERE name = 'legacy-pg'").get().n), 1)
  ok('PG v3→v4 migration')
  console.log(`PostgreSQL integration passed: ${passed} checks`)
} finally {
  try {
    store.db.execute('SET search_path TO public')
    store.db.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } catch {
    // best effort
  }
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
