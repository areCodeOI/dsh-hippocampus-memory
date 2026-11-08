/**
 * SQLite storage for the hippocampus memory.
 *
 * Uses the built-in `node:sqlite` module (Node >= 22.13, no native addon), WAL
 * journaling for concurrent readers (the DSH host, an MCP server and an HTTP
 * server can all use the same file), and an FTS5 index over pre-segmented
 * tokens so Chinese retrieval works.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION } from './constants.js'
import { openPgDatabase } from './pg-sync.js'
import { defaultDbPath } from './paths.js'

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  importance REAL NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  weight REAL NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT,
  source_session TEXT,
  namespace TEXT NOT NULL DEFAULT 'default',
  tags TEXT NOT NULL DEFAULT '[]',
  entities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  confirmed INTEGER NOT NULL DEFAULT 0,
  conflict_with TEXT,
  superseded_by TEXT,
  consolidated_into TEXT,
  purge_after INTEGER,
  content_hash TEXT NOT NULL,
  norm_content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(namespace, content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_purge ON memories(purge_after);
CREATE INDEX IF NOT EXISTS idx_memories_ns_status_created ON memories(namespace, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_kind_status ON memories(kind, status);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  memory_a TEXT NOT NULL,
  memory_b TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_memory ON events(memory_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'reader',
  namespaces TEXT NOT NULL DEFAULT '["*"]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  request_id TEXT,
  actor TEXT,
  role TEXT,
  action TEXT NOT NULL,
  method TEXT,
  path TEXT,
  target TEXT,
  namespace TEXT,
  ip TEXT,
  status INTEGER,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  progress REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);

CREATE TABLE IF NOT EXISTS embeddings (
  memory_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  norm REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(memory_id, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model ON embeddings(provider, model);

CREATE TABLE IF NOT EXISTS embedding_index (
  memory_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  band0 INTEGER NOT NULL,
  band1 INTEGER NOT NULL,
  band2 INTEGER NOT NULL,
  band3 INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(memory_id, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_embedding_band0 ON embedding_index(provider, model, band0);
CREATE INDEX IF NOT EXISTS idx_embedding_band1 ON embedding_index(provider, model, band1);
CREATE INDEX IF NOT EXISTS idx_embedding_band2 ON embedding_index(provider, model, band2);
CREATE INDEX IF NOT EXISTS idx_embedding_band3 ON embedding_index(provider, model, band3);
`

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);
`

/**
 * @param {string} dbPath
 * @param {{ now?: () => number }} [options]
 */
function restrictPermissions(target, mode) {
  try {
    fs.chmodSync(target, mode)
  } catch {
    // Android shared storage / FUSE may reject chmod; best effort only.
  }
}

export function openDatabase(dbPath, options = {}) {
  const resolved = path.resolve(dbPath)
  const dir = path.dirname(resolved)
  fs.mkdirSync(dir, { recursive: true })
  restrictPermissions(dir, 0o700)
  const db = new DatabaseSync(resolved)
  restrictPermissions(resolved, 0o600)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    // FULL costs one fsync per write but keeps the last committed memory even
    // on sudden power loss; memory writes are infrequent enough to afford it.
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA busy_timeout = 15000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA cache_size = -20000')
    db.exec('PRAGMA temp_store = MEMORY')
    db.exec('PRAGMA journal_size_limit = 67108864')
  } catch {
    // Some filesystems (e.g. FUSE-mounted shared storage) reject WAL; the
    // default rollback journal still works, just with less concurrency.
  }
  // WAL/SHM may be created lazily; tighten them when present.
  for (const suffix of ['-wal', '-shm']) restrictPermissions(`${resolved}${suffix}`, 0o600)
  let ftsEnabled = true
  try {
    db.exec(BASE_SCHEMA)
    db.exec(FTS_SCHEMA)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/fts5|no such module/i.test(message)) {
      ftsEnabled = false
      db.exec(BASE_SCHEMA)
    } else {
      throw error
    }
  }
  db.ftsEnabled = ftsEnabled
  setMeta(db, 'fts_enabled', ftsEnabled ? '1' : '0')
  if (getMeta(db, 'change_seq') === undefined) setMeta(db, 'change_seq', '0')
  const current = getMeta(db, 'schema_version')
  if (!current) {
    setMeta(db, 'schema_version', String(SCHEMA_VERSION))
    setMeta(db, 'created_at', String((options.now ?? Date.now)()))
    setMeta(db, 'fts_enabled', ftsEnabled ? '1' : '0')
  } else if (Number(current) > SCHEMA_VERSION) {
    throw new Error(
      `memory database schema ${current} is newer than this build (${SCHEMA_VERSION}); upgrade dsh-hippocampus-memory`,
    )
  } else if (Number(current) < SCHEMA_VERSION) {
    // Additive migrations only: every table above uses IF NOT EXISTS, so an
    // older database gains the new management tables in place.
    setMeta(db, 'schema_version', String(SCHEMA_VERSION))
  }
  return db
}

/**
 * Open the configured storage backend. `storage.driver` is `sqlite` or
 * `postgres`; SQLite keeps the existing synchronous node:sqlite path.
 * @param {{driver?: string, dbPath?: string, url?: string, schema?: string,
 *   pgvector?: boolean, poolMax?: number, statementTimeoutMs?: number}} storage
 * @param {{ now?: () => number }} [options]
 */
export function openStorageDatabase(storage = {}, options = {}) {
  if (storage.driver === 'postgres') {
    return openPgDatabase({
      url: storage.url,
      schema: storage.schema,
      pgvector: storage.pgvector,
      poolMax: storage.poolMax,
      statementTimeoutMs: storage.statementTimeoutMs,
      applicationName: options.applicationName,
    })
  }
  return openDatabase(storage.dbPath ?? defaultDbPath(), options)
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row?.value
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value))
}

/** Run `fn` inside an immediate transaction, rolling back on throw. */
export function withTransaction(db, fn) {
  db.exec(db.dialect === 'postgres' ? 'BEGIN' : 'BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // ignore rollback failure, surface the original error
    }
    throw error
  }
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** Map a `memories` row to the public memory object. */
export function rowToMemory(row) {
  if (!row) return undefined
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    summary: row.summary,
    importance: row.importance,
    confidence: row.confidence,
    weight: row.weight,
    accessCount: row.access_count,
    lastAccessAt: row.last_access_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source ?? null,
    sourceSession: row.source_session ?? null,
    namespace: row.namespace,
    tags: parseJson(row.tags, []),
    entities: parseJson(row.entities, []),
    status: row.status,
    confirmed: Boolean(row.confirmed),
    conflictWith: row.conflict_with ?? null,
    supersededBy: row.superseded_by ?? null,
    consolidatedInto: row.consolidated_into ?? null,
    purgeAfter: row.purge_after ?? null,
    metadata: parseJson(row.metadata, {}),
  }
}

export function dbSizeBytes(dbPath) {
  let total = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(`${dbPath}${suffix}`).size
    } catch {
      // file may not exist
    }
  }
  return total
}
