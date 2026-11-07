/**
 * Zero-dependency MCP server for the hippocampus memory.
 *
 * Implements the JSON-RPC methods MCP clients need: initialize, tools/list,
 * tools/call, resources/list, resources/read, prompts/list, prompts/get, ping.
 * Transport framing (stdio newline-delimited JSON or HTTP POST) lives in the
 * `bin/` entry points; this module is transport-free.
 */

import { VERSION } from './constants.js'
import { callTool, mcpToolDefinitions, memorySystemPrompt } from './tools.js'

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const SERVER_INFO = {
  name: 'hippocampus-memory',
  title: 'Hippocampus Memory',
  version: VERSION,
}

const RESOURCES = [
  {
    uri: 'memory://stats',
    name: 'Memory statistics',
    description: 'Counts by layer/status, database path, last replay time.',
    mimeType: 'application/json',
  },
  {
    uri: 'memory://recent',
    name: 'Recently used memories',
    description: 'The 10 most recently accessed memories (read-only, does not refresh access time).',
    mimeType: 'application/json',
  },
  {
    uri: 'memory://conflicts',
    name: 'Open conflicts',
    description: 'Unresolved contradictions waiting for confirmation.',
    mimeType: 'application/json',
  },
]

export class McpError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

export const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function fail(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}

/**
 * @param {{ store: import('./store.js').MemoryStore, instructions?: string }} options
 */
export function createMcpServer({ store, instructions = memorySystemPrompt('auto'), authorize = null, authorizeResource = null, embeddings = null, indexOnWrite = false }) {
  const tools = mcpToolDefinitions()

  async function dispatch(method, params = {}) {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
        return {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
            prompts: { listChanged: false },
            logging: {},
          },
          serverInfo: SERVER_INFO,
          instructions,
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools }
      case 'tools/call': {
        const name = params?.name
        if (typeof name !== 'string' || !name) throw new McpError(ERROR_CODES.INVALID_PARAMS, 'tools/call requires a tool name')
        const args = params?.arguments ?? {}
        if (typeof args !== 'object' || Array.isArray(args)) {
          throw new McpError(ERROR_CODES.INVALID_PARAMS, 'tool arguments must be an object')
        }
        try {
          const denied = authorize ? await authorize(name, args) : null
          if (denied) {
            return {
              content: [{ type: 'text', text: `Error: ${denied}` }],
              isError: true,
            }
          }
          let callArgs = args
          let embeddingInfo = null
          if (name === 'memory_search' && embeddings?.enabled && args.query && (args.mode ?? 'relevance') === 'relevance') {
            const vector = await embeddings.search(store, args.query, { namespace: args.namespace ?? store.namespace })
            embeddingInfo = { providers: vector.providers, errors: vector.errors, candidates: vector.scores.size }
            callArgs = {
              ...args,
              extraIds: [...vector.scores.keys()],
              vectorScores: vector.scores,
              vectorWeight: Number(process.env.HIPPOCAMPUS_VECTOR_WEIGHT) || 0.35,
            }
          }
          let value = await callTool(store, name, callArgs, { source: 'mcp' })
          if (embeddings?.enabled && indexOnWrite && (name === 'memory_add' || name === 'memory_update') && value?.memory?.id) {
            await embeddings.indexMemory(store, value.memory.id)
          }
          if (embeddingInfo && value && typeof value === 'object') value = { ...value, embedding: embeddingInfo }
          return {
            content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
            isError: false,
          }
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
          }
        }
      }
      case 'resources/list':
        return { resources: RESOURCES }
      case 'resources/read': {
        const uri = params?.uri
        const resourceDenied = authorizeResource ? await authorizeResource(uri) : null
        if (resourceDenied) throw new McpError(ERROR_CODES.INVALID_PARAMS, resourceDenied)
        if (uri === 'memory://stats') {
          return {
            contents: [
              { uri, mimeType: 'application/json', text: JSON.stringify(store.stats(), null, 2) },
            ],
          }
        }
        if (uri === 'memory://recent') {
          const result = store.search('', { mode: 'recent', limit: 10, updateAccess: false, explain: false })
          return {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }],
          }
        }
        if (uri === 'memory://conflicts') {
          return {
            contents: [
              { uri, mimeType: 'application/json', text: JSON.stringify(store.listConflicts('open'), null, 2) },
            ],
          }
        }
        throw new McpError(ERROR_CODES.INVALID_PARAMS, `unknown resource: ${uri}`)
      }
      case 'prompts/list':
        return {
          prompts: [
            {
              name: 'hippocampus_memory_protocol',
              title: 'Hippocampus memory protocol',
              description: 'Operating rules for using the memory tools correctly.',
              arguments: [],
            },
          ],
        }
      case 'prompts/get':
        return {
          description: 'Operating rules for using the memory tools correctly.',
          messages: [{ role: 'user', content: { type: 'text', text: instructions } }],
        }
      case 'logging/setLevel':
        return {}
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined
      default:
        throw new McpError(ERROR_CODES.METHOD_NOT_FOUND, `method not found: ${method}`)
    }
  }

  /**
   * Handle one JSON-RPC message. Returns null for notifications, or a batch
   * response array when the input was a batch.
   */
  async function handle(message) {
    if (Array.isArray(message)) {
      if (message.length === 0) return fail(null, ERROR_CODES.INVALID_REQUEST, 'empty batch')
      const responses = []
      for (const entry of message) {
        const response = await handleOne(entry)
        if (response) responses.push(response)
      }
      return responses.length ? responses : null
    }
    return handleOne(message)
  }

  async function handleOne(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return fail(message?.id, ERROR_CODES.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request')
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
    const id = message.id
    if (typeof message.method !== 'string') {
      if (!hasId) return null
      return fail(id, ERROR_CODES.INVALID_REQUEST, 'method must be a string')
    }
    try {
      const result = await dispatch(message.method, message.params ?? {})
      if (!hasId) return null
      if (result === undefined) return ok(id, {})
      return ok(id, result)
    } catch (error) {
      if (!hasId) return null
      if (error instanceof McpError) return fail(id, error.code, error.message, error.data)
      return fail(id, ERROR_CODES.INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
    }
  }

  return { handle, dispatch, tools, instructions }
}

/**
 * Parse one JSON-RPC line, producing a parse-error response id null when the
 * payload is not valid JSON.
 */
export function parseMessage(line) {
  try {
    return { message: JSON.parse(line) }
  } catch (error) {
    return {
      error: fail(null, ERROR_CODES.PARSE_ERROR, 'parse error', error instanceof Error ? error.message : String(error)),
    }
  }
}
