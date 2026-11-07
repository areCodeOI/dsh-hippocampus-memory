/**
 * PostgreSQL schema for the shared hippocampus backend.
 *
 * Timestamps are BIGINT (milliseconds); SQLite INTEGER maps to 64-bit here so
 * 2025+ epoch values do not overflow int4. Vectors are kept both as bytea (for
 * the portable SimHash index and SQLite-compatible code paths) and, when the
 * pgvector extension is available, as a native `vector` column for exact
 * cosine search.
 */

export function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

export function validateSchemaName(value) {
  const name = String(value ?? 'public').trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid PostgreSQL schema: ${name}`)
  return name
}

export function pgBaseSchema({ pgvector = false, schema = 'public' } = {}) {
  const s = quoteIdent(validateSchemaName(schema))
  return `
CREATE SCHEMA IF NOT EXISTS ${s};
SET search_path TO ${s}, public;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  importance DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  weight DOUBLE PRECISION NOT NULL,
  access_count BIGINT NOT NULL DEFAULT 0,
  last_access_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  source TEXT,
  source_session TEXT,
  namespace TEXT NOT NULL DEFAULT 'default',
  tags TEXT NOT NULL DEFAULT '[]',
  entities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  confirmed BIGINT NOT NULL DEFAULT 0,
  conflict_with TEXT,
  superseded_by TEXT,
  consolidated_into TEXT,
  purge_after BIGINT,
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
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  memory_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_memory ON events(memory_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'reader',
  namespaces TEXT NOT NULL DEFAULT '["*"]',
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  expires_at BIGINT,
  revoked BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  request_id TEXT,
  actor TEXT,
  role TEXT,
  action TEXT NOT NULL,
  method TEXT,
  path TEXT,
  target TEXT,
  namespace TEXT,
  ip TEXT,
  status BIGINT,
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
  progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  attempts BIGINT NOT NULL DEFAULT 0,
  max_attempts BIGINT NOT NULL DEFAULT 3,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  lease_until BIGINT,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(status, lease_until);

CREATE TABLE IF NOT EXISTS embeddings (
  memory_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dim BIGINT NOT NULL,
  vector BYTEA NOT NULL,
  norm DOUBLE PRECISION NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(memory_id, provider, model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_provider_model ON embeddings(provider, model);

CREATE TABLE IF NOT EXISTS embedding_index (
  memory_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  band0 BIGINT NOT NULL,
  band1 BIGINT NOT NULL,
  band2 BIGINT NOT NULL,
  band3 BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(memory_id, provider, model)
);
CREATE INDEX IF NOT EXISTS idx_embedding_band0 ON embedding_index(provider, model, band0);
CREATE INDEX IF NOT EXISTS idx_embedding_band1 ON embedding_index(provider, model, band1);
CREATE INDEX IF NOT EXISTS idx_embedding_band2 ON embedding_index(provider, model, band2);
CREATE INDEX IF NOT EXISTS idx_embedding_band3 ON embedding_index(provider, model, band3);

CREATE TABLE IF NOT EXISTS memory_fts (
  memory_id TEXT PRIMARY KEY,
  tokens TSVECTOR NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_fts_tokens ON memory_fts USING GIN(tokens);
`
}

export function pgVectorSchemaReady() {
  return 'SELECT 1'
}
