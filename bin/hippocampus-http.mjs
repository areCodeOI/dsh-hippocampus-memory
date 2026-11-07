#!/usr/bin/env node
/**
 * Hippocampus Memory — HTTP server.
 *
 * Serves MCP over POST /mcp and a plain REST API under /api/* so any language or
 * model can read/write memory with curl or fetch.
 *
 *   hippocampus-http [--db path] [--port 7337] [--host 127.0.0.1] [--token T]
 */

import { parseArgs } from 'node:util'
import { MemoryStore } from '../lib/store.js'
import { createMemoryHttpServer, listen } from '../lib/http.js'
import { resolveStorageConfig, storageLabel } from '../lib/paths.js'

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    storage: { type: 'string' },
    'pg-url': { type: 'string' },
    'pg-schema': { type: 'string' },
    'data-dir': { type: 'string' },
    'data-location': { type: 'string' },
    'pgvector': { type: 'boolean' },
    'graph-provider': { type: 'string' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    token: { type: 'string' },
    namespace: { type: 'string' },
    'web-root': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stdout.write(
    'usage: hippocampus-http [--db <path>] [--storage sqlite|postgres] [--pg-url <url>]\n' +
      '                         [--data-dir <dir>] [--port 7337] [--host 127.0.0.1] [--token <token>]\n' +
      '  --graph-provider projection|postgres\n' +
      '  POST /mcp                 MCP JSON-RPC (Streamable HTTP, JSON response)\n' +
      '  GET  /api/memories/search?q=...\n' +
      '  POST /api/memories        add a memory\n' +
      '  GET  /api/stats | /api/tools | /openapi.json\n',
  )
  process.exit(0)
}

const storage = resolveStorageConfig({
  storage: values.storage,
  dbPath: values.db,
  dataDir: values['data-dir'],
  dataLocation: values['data-location'],
  pgUrl: values['pg-url'],
  pgSchema: values['pg-schema'],
  pgvector: values.pgvector,
})
const store = new MemoryStore({
  storage,
  namespace: values.namespace ?? process.env.HIPPOCAMPUS_NAMESPACE ?? 'default',
})
const token = values.token ?? process.env.HIPPOCAMPUS_TOKEN
const port = Number(values.port ?? process.env.HIPPOCAMPUS_PORT ?? 7337)
const host = values.host ?? process.env.HIPPOCAMPUS_HOST ?? '127.0.0.1'
const server = createMemoryHttpServer({
  store,
  token,
  host,
  port,
  webRoot: values['web-root'] ?? process.env.HIPPOCAMPUS_WEB_ROOT,
  storage,
})

if (!token && host !== '127.0.0.1' && host !== 'localhost') {
  process.stderr.write(
    '[hippocampus-http] WARNING: listening on a non-loopback address without HIPPOCAMPUS_TOKEN; anyone who can reach this port can read and write memory.\n',
  )
}

try {
  const address = await listen(server, { port, host })
  const displayHost = String(address.address).includes(':') ? `[${address.address}]` : address.address
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      service: 'hippocampus-memory',
      url: `http://${displayHost}:${address.port}`,
      mcp: `http://${displayHost}:${address.port}/mcp`,
      dbPath: store.dbPath,
      storage: storageLabel(storage),
      auth: token ? 'bearer-token' : 'none (loopback)',
    })}\n`,
  )
} catch (error) {
  process.stderr.write(`[hippocampus-http] failed to listen: ${error?.message ?? error}\n`)
  store.close()
  process.exit(1)
}

function shutdown() {
  server.close(() => {
    store.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
