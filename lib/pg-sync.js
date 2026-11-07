/**
 * Synchronous façade over a PostgreSQL pool running in a worker thread.
 *
 * The memory engine's public API is synchronous (node:sqlite). Keeping that
 * contract lets the existing store, auth, audit and job code run on PostgreSQL
 * unchanged while a separate worker owns the async `pg` pool. Calls from one
 * store are serialised; run multiple HTTP server instances for concurrency.
 */

import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { SCHEMA_VERSION } from './constants.js'
import { pgBaseSchema, validateSchemaName } from './pg-schema.js'

const HEADER = 16
const MAX_BYTES = 16 * 1024 * 1024

function decode(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(decode)
  if (typeof value === 'object') {
    if (typeof value.__pgb64 === 'string') return Buffer.from(value.__pgb64, 'base64')
    const output = {}
    for (const [key, item] of Object.entries(value)) output[key] = decode(item)
    return output
  }
  return value
}

function encode(value) {
  if (value === null || value === undefined) return value
  if (Buffer.isBuffer(value)) return { __pgb64: value.toString('base64') }
  if (value instanceof Uint8Array) return { __pgb64: Buffer.from(value).toString('base64') }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(encode)
  if (typeof value === 'object') {
    const output = {}
    for (const [key, item] of Object.entries(value)) output[key] = encode(item)
    return output
  }
  return value
}

function displayUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return String(url).replace(/:\/\/([^:/@]+):([^@]+)@/, '://$1:***@')
  }
}

/** Replace SQLite `?` placeholders with PostgreSQL `$n`, ignoring literals. */
export function translatePlaceholders(sql) {
  let output = ''
  let index = 0
  let quote = null
  let lineComment = false
  let blockComment = false
  let dollarTag = null
  let placeholder = 0
  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]
    if (lineComment) {
      output += char
      if (char === '\n') lineComment = false
      index += 1
      continue
    }
    if (blockComment) {
      output += char
      if (char === '*' && next === '/') {
        output += '/'
        index += 2
        blockComment = false
      } else {
        index += 1
      }
      continue
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        output += dollarTag
        index += dollarTag.length
        dollarTag = null
      } else {
        output += char
        index += 1
      }
      continue
    }
    if (quote) {
      output += char
      if (char === quote) {
        if (next === quote) {
          output += next
          index += 2
          continue
        }
        quote = null
      }
      index += 1
      continue
    }
    if (char === '-' && next === '-') {
      output += '--'
      index += 2
      lineComment = true
      continue
    }
    if (char === '/' && next === '*') {
      output += '/*'
      index += 2
      blockComment = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      output += char
      index += 1
      continue
    }
    if (char === '$') {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index))
      if (match) {
        dollarTag = match[0]
        output += dollarTag
        index += dollarTag.length
        continue
      }
    }
    if (char === '?') {
      index += 1
      placeholder += 1
      output += `$${placeholder}`
      continue
    }
    output += char
    index += 1
  }
  return output
}

export function translateSql(sql) {
  let text = String(sql)
  if (/^\s*PRAGMA\b/i.test(text)) return null
  if (/^\s*BEGIN\s+IMMEDIATE/i.test(text)) return text.replace(/^\s*BEGIN\s+IMMEDIATE/i, 'BEGIN')
  if (/^\s*VACUUM\b/i.test(text)) {
    throw new Error('VACUUM is SQLite-only; PostgreSQL backups use the JSON export job')
  }
  let ignore = false
  text = text.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i, () => {
    ignore = true
    return 'INSERT INTO'
  })
  text = translatePlaceholders(text)
  if (ignore && !/\bON\s+CONFLICT\b/i.test(text)) {
    const semicolon = /;\s*$/.test(text)
    text = text.replace(/;\s*$/, '')
    text += ' ON CONFLICT DO NOTHING'
    if (semicolon) text += ';'
  }
  return text
}

export class PgSyncDatabase {
  constructor(options = {}) {
    if (!options.url) throw new Error('PostgreSQL url is required')
    this.dialect = 'postgres'
    this.storageKind = 'postgres'
    this.schema = validateSchemaName(options.schema ?? 'public')
    this.displayPath = displayUrl(options.url)
    this.dbPath = this.displayPath
    this.closed = false
    this.workerError = null
    this.ftsEnabled = true
    this.pgvector = false
    this.version = null
    this.buffer = new SharedArrayBuffer(HEADER + MAX_BYTES)
    this.control = new Int32Array(this.buffer, 0, 4)
    this.data = new Uint8Array(this.buffer, HEADER)
    this.worker = new Worker(new URL('./pg-worker.mjs', import.meta.url), {
      workerData: {
        url: options.url,
        sab: this.buffer,
        poolMax: options.poolMax ?? 4,
        statementTimeoutMs: options.statementTimeoutMs ?? 30_000,
        applicationName: options.applicationName ?? 'dsh-hippocampus',
        schema: this.schema,
      },
    })
    this.worker.on('error', (error) => {
      this.workerError = error
      Atomics.store(this.control, 0, 2)
      Atomics.notify(this.control, 0)
    })
    this.worker.on('exit', () => {
      this.closed = true
    })
    this.waitReady(options.connectTimeoutMs ?? 15_000)
    this.version = this.scalar('SELECT current_setting(\'server_version\') AS value')
  }

  waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const state = Atomics.load(this.control, 0)
      if (state === 3) {
        Atomics.store(this.control, 0, 0)
        return
      }
      if (state === 2) {
        const error = this.readResponse()
        throw new Error(error.error || 'PostgreSQL worker failed to start')
      }
      if (this.workerError) throw new Error(`PostgreSQL worker error: ${this.workerError.message}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('PostgreSQL worker did not become ready in time')
      Atomics.wait(this.control, 0, state, Math.min(remaining, 250))
    }
  }

  readResponse() {
    const length = Atomics.load(this.control, 1)
    if (length <= 0 || length > MAX_BYTES) throw new Error('invalid PostgreSQL worker response length')
    const text = Buffer.from(this.data.buffer, this.data.byteOffset, length).toString('utf8')
    Atomics.store(this.control, 0, 0)
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error(`invalid PostgreSQL worker response: ${error.message}`)
    }
  }

  execute(sql, params = []) {
    if (this.closed) throw new Error('PostgreSQL store is closed')
    if (this.workerError) throw new Error(`PostgreSQL worker error: ${this.workerError.message}`)
    const text = translateSql(sql)
    if (text === null) return { rows: [], rowCount: 0, changes: 0 }
    const request = Buffer.from(JSON.stringify({ sql: text, params: params.map(encode) }), 'utf8')
    if (request.length > MAX_BYTES) throw new Error('PostgreSQL request exceeds sync bridge buffer')
    this.data.set(request)
    Atomics.store(this.control, 1, request.length)
    Atomics.store(this.control, 0, 1)
    this.worker.postMessage({ request: true })
    const deadline = Date.now() + 60_000
    while (true) {
      const state = Atomics.load(this.control, 0)
      if (state === 2) {
        const response = this.readResponse()
        if (!response.ok) {
          const error = new Error(response.error || 'PostgreSQL query failed')
          error.code = response.code
          throw error
        }
        return {
          rows: (Array.isArray(response.rows) ? response.rows : []).map(decode),
          rowCount: Number(response.rowCount ?? 0),
          changes: Number(response.rowCount ?? 0),
        }
      }
      if (this.workerError) throw new Error(`PostgreSQL worker error: ${this.workerError.message}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('PostgreSQL query timed out in sync bridge')
      Atomics.wait(this.control, 0, state, Math.min(remaining, 250))
    }
  }

  prepare(sql) {
    return {
      run: (...params) => {
        const result = this.execute(sql, params)
        return { changes: result.changes, rows: result.rows, rowCount: result.rowCount }
      },
      get: (...params) => this.execute(sql, params).rows[0],
      all: (...params) => this.execute(sql, params).rows,
    }
  }

  exec(sql) {
    const text = String(sql).trim()
    if (!text) return this
    if (/^PRAGMA\b/i.test(text)) return this
    this.execute(text, [])
    return this
  }

  scalar(sql, params = []) {
    const row = this.execute(sql, params).rows[0]
    if (!row) return undefined
    const values = Object.values(row)
    return values.length ? values[0] : undefined
  }

  sizeBytes() {
    try {
      return Number(this.scalar('SELECT pg_database_size(current_database()) AS bytes') ?? 0)
    } catch {
      return 0
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.worker.postMessage({ shutdown: true })
    } catch {
      // ignore
    }
  }
}

/** Open PostgreSQL, install schema and return the sync database facade. */
export function openPgDatabase(options = {}) {
  try {
    createRequire(import.meta.url).resolve('pg')
  } catch {
    throw new Error('storage=postgres requires the optional pg package; run `npm install pg` or install the plugin bundle with dependencies')
  }
  const db = new PgSyncDatabase(options)
  try {
    const schema = validateSchemaName(options.schema ?? 'public')
  let pgvector = false
  if (options.pgvector !== false) {
    try {
      db.execute('CREATE EXTENSION IF NOT EXISTS vector')
      pgvector = true
    } catch (error) {
      // pgvector is optional; the portable SimHash index still works.
      console.warn('[hippocampus] pgvector unavailable, falling back to SimHash:', error instanceof Error ? error.message : String(error))
    }
  }
  db.execute(`CREATE SCHEMA IF NOT EXISTS "${schema.replaceAll('"', '""')}"`)
  db.execute(pgBaseSchema({ pgvector, schema }))
  if (pgvector) {
    try {
      db.execute("ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS embedding vector")
    } catch (error) {
      console.warn('[hippocampus] pgvector column unavailable:', error instanceof Error ? error.message : String(error))
      pgvector = false
    }
  }
  db.pgvector = pgvector
  db.ftsEnabled = true
  const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value
  if (!current) {
    const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    insert.run('schema_version', String(SCHEMA_VERSION))
    insert.run('created_at', String(Date.now()))
    insert.run('fts_enabled', '1')
    insert.run('change_seq', '0')
    insert.run('storage_driver', 'postgres')
  } else if (Number(current) > SCHEMA_VERSION) {
    db.close()
    throw new Error(`memory database schema ${current} is newer than this build (${SCHEMA_VERSION}); upgrade dsh-hippocampus-memory`)
  } else if (Number(current) < SCHEMA_VERSION) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION))
  }
  const upsert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  if (db.prepare('SELECT value FROM meta WHERE key = ?').get('change_seq') === undefined) upsert.run('change_seq', '0')
  if (db.prepare('SELECT value FROM meta WHERE key = ?').get('created_at') === undefined) upsert.run('created_at', String(Date.now()))
  if (db.prepare('SELECT value FROM meta WHERE key = ?').get('fts_enabled') === undefined) upsert.run('fts_enabled', '1')
  upsert.run('storage_driver', 'postgres')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
