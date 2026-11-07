#!/usr/bin/env node
/**
 * Hippocampus Memory — MCP server over stdio.
 *
 * MCP stdio framing: one JSON-RPC message per line on stdin, one JSON reply per
 * line on stdout. Diagnostics go to stderr so they never corrupt the protocol.
 *
 * Usage:
 *   hippocampus-mcp [--db /path/memory.db] [--namespace default]
 *
 * Example client config (Claude Desktop / Cursor / Cline / any MCP client):
 *   { "mcpServers": { "hippocampus": {
 *       "command": "node",
 *       "args": ["/path/to/dsh-hippocampus-memory/bin/hippocampus-mcp.mjs"]
 *   } } }
 */

import { parseArgs } from 'node:util'
import { MemoryStore } from '../lib/store.js'
import { createMcpServer, parseMessage } from '../lib/mcp.js'
import { resolveStorageConfig } from '../lib/paths.js'
import { EmbeddingService } from '../lib/embeddings.js'

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    storage: { type: 'string' },
    'pg-url': { type: 'string' },
    'pg-schema': { type: 'string' },
    'data-dir': { type: 'string' },
    'pgvector': { type: 'boolean' },
    namespace: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stderr.write(
    'usage: hippocampus-mcp [--db <path>] [--storage sqlite|postgres] [--pg-url <url>] [--namespace <name>]\n' +
      'stdio MCP server (newline-delimited JSON-RPC). Logs go to stderr.\n',
  )
  process.exit(0)
}

const storage = resolveStorageConfig({
  storage: values.storage,
  dbPath: values.db,
  dataDir: values['data-dir'],
  pgUrl: values['pg-url'],
  pgSchema: values['pg-schema'],
  pgvector: values.pgvector,
})
const store = new MemoryStore({
  storage,
  namespace: values.namespace ?? process.env.HIPPOCAMPUS_NAMESPACE ?? 'default',
})
let embeddings = null
try {
  embeddings = EmbeddingService.fromEnv()
} catch (error) {
  process.stderr.write(`[hippocampus-mcp] embeddings disabled: ${error.message}\n`)
}
const server = createMcpServer({ store, embeddings, indexOnWrite: true })

let buffer = ''
let chain = Promise.resolve()
let closed = false

function shutdown(code = 0) {
  if (closed) return
  closed = true
  chain.finally(() => {
    store.close()
    process.exit(code)
  })
}

async function handleLine(line) {
  const { message, error } = parseMessage(line)
  if (error) {
    process.stdout.write(`${JSON.stringify(error)}\n`)
    return
  }
  try {
    const response = await server.handle(message)
    if (response !== null && response !== undefined) {
      process.stdout.write(`${JSON.stringify(response)}\n`)
    }
  } catch (handleError) {
    process.stderr.write(`[hippocampus-mcp] ${handleError?.stack ?? handleError}\n`)
  }
}

// A client closing its end must not crash the server.
process.stdout.on('error', (error) => {
  if (error?.code !== 'EPIPE') process.stderr.write(`[hippocampus-mcp] stdout: ${error}\n`)
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) chain = chain.then(() => handleLine(line))
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => {
  if (buffer.trim()) chain = chain.then(() => handleLine(buffer.trim()))
  chain.finally(() => shutdown(0))
})
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('uncaughtException', (error) => {
  process.stderr.write(`[hippocampus-mcp] fatal: ${error?.stack ?? error}\n`)
  shutdown(1)
})
