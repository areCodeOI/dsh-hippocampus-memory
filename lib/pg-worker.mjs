/**
 * Worker-thread PostgreSQL bridge.
 *
 * The memory engine is intentionally synchronous (the SQLite path is built on
 * node:sqlite). This worker owns the async pg pool and answers the main thread
 * through a SharedArrayBuffer, so the same MemoryStore / Auth / JobQueue code
 * can run against PostgreSQL without rewriting every call site.
 *
 * It is a compatibility bridge, not a high-QPS query proxy: one store serialises
 * its own queries, while horizontal scaling comes from running several API
 * server processes against the same PostgreSQL cluster.
 */

import { parentPort, workerData } from 'node:worker_threads'
import pg from 'pg'

const HEADER = 16
const { url, sab, poolMax, statementTimeoutMs, applicationName, schema } = workerData
const control = new Int32Array(sab, 0, 4)
const data = new Uint8Array(sab, HEADER)
const MAX_BYTES = data.byteLength

pg.types.setTypeParser(20, (value) => Number(value))
pg.types.setTypeParser(1700, (value) => Number(value))

const pool = new pg.Pool({
  connectionString: url,
  max: Math.max(1, Number(poolMax) || 4),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  application_name: applicationName || 'dsh-hippocampus',
  options: `-c statement_timeout=${Math.max(1000, Number(statementTimeoutMs) || 30_000)} -c search_path="${schema || 'public'}",public`,
})
pool.on('error', (error) => {
  // An idle client error must not crash the worker. The next query will
  // surface a connection error if PostgreSQL is really unavailable.
  try {
    parentPort?.postMessage({ type: 'log', level: 'warn', message: `pg idle client error: ${error.message}` })
  } catch {
    // ignore
  }
})

let txClient = null
let pending = false

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

function writeResponse(payload) {
  const text = JSON.stringify(payload)
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > MAX_BYTES) {
    const fallback = Buffer.from(JSON.stringify({
      ok: false,
      error: `PostgreSQL result exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)} MiB sync bridge buffer`,
    }))
    data.set(fallback)
    Atomics.store(control, 1, fallback.length)
  } else {
    data.set(bytes)
    Atomics.store(control, 1, bytes.length)
  }
  Atomics.store(control, 0, 2)
  Atomics.notify(control, 0)
}

async function query(sql, params) {
  const client = txClient ?? await pool.connect()
  try {
    const raw = params.length ? await client.query({ text: sql, values: params }) : await client.query(sql)
    // A multi-statement simple query returns an array of results; the last one
    // carries the command status. DDL in the schema bootstrap hits this path.
    const result = Array.isArray(raw) ? raw[raw.length - 1] : raw
    return {
      ok: true,
      rows: (result?.rows ?? []).map((row) => encode(row)),
      rowCount: Number(result?.rowCount ?? 0),
      command: result?.command,
    }
  } finally {
    if (!txClient) client.release()
  }
}

async function begin() {
  if (txClient) throw new Error('PostgreSQL transaction already open in this store')
  txClient = await pool.connect()
  try {
    await txClient.query('BEGIN')
    return { ok: true, rows: [], rowCount: 0, command: 'BEGIN' }
  } catch (error) {
    txClient.release()
    txClient = null
    throw error
  }
}

async function end(command) {
  if (!txClient) return { ok: true, rows: [], rowCount: 0, command }
  const client = txClient
  try {
    await client.query(command)
    return { ok: true, rows: [], rowCount: 0, command }
  } finally {
    txClient = null
    client.release()
  }
}

function firstKeyword(sql) {
  return String(sql).trim().split(/\s+/, 1)[0]?.toUpperCase() ?? ''
}

async function handleRequest() {
  const length = Atomics.load(control, 1)
  if (length <= 0 || length > MAX_BYTES) throw new Error('invalid sync bridge request length')
  const text = Buffer.from(data.buffer, data.byteOffset, length).toString('utf8')
  const request = JSON.parse(text)
  const sql = String(request.sql ?? '')
  const params = (request.params ?? []).map(decode)
  const keyword = firstKeyword(sql)
  if (keyword === 'BEGIN' || /^BEGIN\s+IMMEDIATE/i.test(sql)) return begin()
  if (keyword === 'COMMIT') return end('COMMIT')
  if (keyword === 'ROLLBACK') return end('ROLLBACK')
  return query(sql, params)
}

parentPort.on('message', async (message) => {
  if (message?.shutdown) {
    try {
      if (txClient) {
        try { await txClient.query('ROLLBACK') } catch { /* ignore */ }
        txClient.release()
        txClient = null
      }
      await pool.end()
    } finally {
      process.exit(0)
    }
    return
  }
  if (!message?.request || pending) return
  pending = true
  try {
    const response = await handleRequest()
    writeResponse(response)
  } catch (error) {
    writeResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code ?? null,
    })
  } finally {
    pending = false
  }
})

try {
  // Fail fast on bad credentials / unreachable hosts.
  await pool.query('SELECT 1')
  Atomics.store(control, 0, 3)
  Atomics.notify(control, 0)
} catch (error) {
  const text = Buffer.from(JSON.stringify({
    ok: false,
    error: `PostgreSQL connection failed: ${error instanceof Error ? error.message : String(error)}`,
    code: error?.code ?? null,
  }))
  data.set(text)
  Atomics.store(control, 1, text.length)
  Atomics.store(control, 0, 2)
  Atomics.notify(control, 0)
  setTimeout(() => process.exit(1), 50)
}
