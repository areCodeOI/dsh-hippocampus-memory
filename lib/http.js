/**
 * HTTP management server for the hippocampus memory.
 *
 *   GET  /                     Web UI (memory explorer, star map, tree, audit, jobs)
 *   POST /mcp                  MCP JSON-RPC (Streamable HTTP, JSON response mode)
 *   /api/*                     REST API for any language
 *   GET  /health /ready        liveness / readiness
 *   GET  /metrics              Prometheus exposition
 *
 * Authentication: Bearer token or X-Api-Key. With no token and no API keys,
 * loopback requests run as a local admin. HIPPOCAMPUS_AUTH=required forces auth.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { VERSION } from './constants.js'
import { createMcpServer, parseMessage } from './mcp.js'
import { TOOL_DEFS, callTool } from './tools.js'
import { createRuntime } from './runtime.js'
import { checkNamespace, checkRole } from './auth.js'
import { buildGraph, buildTree, resolveGraphProvider } from './graph.js'
import { cacheKey } from './cache.js'
import { vectorWeightFromEnv } from './scoring.js'

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url))
const MAX_BODY = 5 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

class HttpError extends Error {
  constructor(status, message, code = status) {
    super(message)
    this.status = status
    this.code = code
  }
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(value))
}

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function list(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (Array.isArray(value)) return value.map(String)
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function bearerToken(req) {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice(7).trim()
  const apiKey = req.headers['x-api-key']
  return apiKey ? String(apiKey) : null
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('cross-origin-resource-policy', 'same-origin')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()')
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  )
}

/**
 * Endpoints that only make sense for one HTTP verb. Checked before routing so
 * e.g. `PUT /api/stats` cannot be answered with a 200 by a GET handler.
 */
const FIXED_METHODS = new Map([
  ['/health', ['GET']],
  ['/ready', ['GET']],
  ['/metrics', ['GET']],
  ['/api/auth/check', ['GET']],
  ['/api/public-config', ['GET']],
  ['/api/info', ['GET']],
  ['/api/monitor', ['GET']],
  ['/api/stats', ['GET']],
  ['/api/memories/search', ['GET']],
  ['/api/conflicts', ['GET']],
  ['/api/export', ['GET']],
  ['/api/graph', ['GET']],
  ['/api/tree', ['GET']],
  ['/api/audit', ['GET']],
  ['/api/config', ['GET']],
  ['/api/tools', ['GET']],
  ['/openapi.json', ['GET']],
])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Hostname without port/brackets; undefined for malformed input. */
function bareHost(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  if (raw.includes('://')) {
    try {
      return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    } catch {
      return undefined
    }
  }
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end > 0) return raw.slice(1, end).toLowerCase()
  }
  return raw.replace(/:\d+$/, '').toLowerCase()
}

function isIpLiteralHost(host) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true
  // IPv6 only; reject arbitrary host:port strings that merely contain a colon.
  return host.includes(':') && /^[0-9a-f:.]+$/i.test(host) && host.split(':').length >= 3
}

function configuredList(name) {
  return String(process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * DNS rebinding defense: a browser page on attacker.test can resolve to
 * 127.0.0.1 and send same-origin requests whose Host header is attacker.test.
 * Only loopback names, IP literals and explicitly allowed hostnames are served.
 */
function isTrustedHost(req, allowedHosts) {
  const raw = req.headers.host
  if (!raw) return true // non-browser HTTP/1.0 callers without Host
  const host = bareHost(raw)
  if (!host) return false
  if (LOOPBACK_HOSTS.has(host) || isIpLiteralHost(host)) return true
  return allowedHosts.has(host)
}

/** Reflect a CORS origin only when it is a local tool or explicitly allowed. */
function allowedOrigins() {
  return configuredList('HIPPOCAMPUS_CORS_ORIGINS')
}

function isAllowedOrigin(req, origin) {
  let parsed
  try {
    parsed = new URL(String(origin))
  } catch {
    return false
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (LOOPBACK_HOSTS.has(host)) return true
  const requestHost = bareHost(req.headers.host)
  // Same host (reverse proxy / WebUI) is same-site even if the port differs.
  if (requestHost && host === requestHost) return true
  const configured = allowedOrigins()
  return configured.includes('*') || configured.includes(String(origin))
}

function corsOrigin(req, origin) {
  return origin && isAllowedOrigin(req, origin) ? String(origin) : null
}

/**
 * Browser CSRF defense. CORS only hides responses; a cross-site form/fetch can
 * still perform a write. State-changing requests from a browser origin that is
 * not loopback/allowed are rejected even if the loopback admin shortcut applies.
 */
function isCrossSiteRequest(req) {
  const origin = req.headers.origin
  if (origin) return !isAllowedOrigin(req, origin)
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return true
  // No Origin and no Fetch Metadata: older browsers; content-type enforcement
  // still blocks form/text writes below.
  return false
}

function send(req, res, status, body, contentType, extraHeaders = {}) {
  // A response can only be written once. Request handlers are defensive, but a
  // future double-write must not take down the whole process: finish whatever
  // is still writable and drop the duplicate.
  if (res.writableEnded) return
  if (res.headersSent) {
    try {
      res.end()
    } catch {
      // ignore errors on an already-finished response
    }
    return
  }
  let payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''))
  const headers = {
    'content-type': contentType,
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  }
  const accept = String(req.headers['accept-encoding'] ?? '')
  if (payload.length > 1024 && /(^|,)\s*gzip\b/.test(accept)) {
    payload = gzipSync(payload)
    headers['content-encoding'] = 'gzip'
    headers['content-length'] = payload.length
    headers.vary = 'accept-encoding'
  }
  res.writeHead(status, headers)
  res.end(payload)
}

function json(req, res, status, value, extraHeaders = {}) {
  send(req, res, status, JSON.stringify(value, null, 2), 'application/json; charset=utf-8', extraHeaders)
}

function text(req, res, status, value, extraHeaders = {}) {
  send(req, res, status, value, 'text/plain; charset=utf-8', extraHeaders)
}

function sendError(req, res, error) {
  const status = error instanceof HttpError ? error.status : /not found|不存在/i.test(String(error?.message)) ? 404 : 400
  json(req, res, status, {
    error: {
      code: error instanceof HttpError ? error.code : status,
      message: error instanceof Error ? error.message : String(error),
    },
  })
}

function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new HttpError(413, 'request body too large', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      // A cross-site <form> or sendBeacon can send text/plain or urlencoded
      // without a CORS preflight; requiring JSON makes those simple requests
      // fail at 415 even when the body is empty.
      const type = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
      const isJson = type === 'application/json' || type.endsWith('+json')
      if (!isJson && (type || raw.trim())) {
        return reject(new HttpError(415, 'content-type must be application/json', 415))
      }
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new HttpError(400, `invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function requireRole(auth, role) {
  if (!checkRole(auth, role)) throw new HttpError(403, `requires ${role} role`, 'forbidden')
}

function requireNamespace(auth, namespace) {
  if (!checkNamespace(auth, namespace)) throw new HttpError(403, `no access to namespace: ${namespace}`, 'forbidden')
}

function resolveNamespace(auth, store, requested) {
  const allowed = auth?.namespaces ?? ['*']
  if (requested === '*' && !allowed.includes('*')) throw new HttpError(403, 'namespace wildcard is not allowed for this key', 'forbidden')
  if (requested) {
    requireNamespace(auth, requested)
    return requested
  }
  if (allowed.includes('*')) return store.namespace
  return allowed[0]
}

function toolRole(name, args = {}) {
  if (name === 'memory_search' || name === 'memory_get' || name === 'memory_stats') return 'reader'
  if (name === 'memory_add' || name === 'memory_update' || name === 'memory_archive') return 'writer'
  if (name === 'memory_replay') return 'writer'
  if (name === 'memory_delete') return args.hard || args.force ? 'admin' : 'writer'
  return 'admin'
}

function authorizeTool(store, auth, name, args = {}) {
  const role = toolRole(name, args)
  if (!checkRole(auth, role)) return `requires ${role} role`
  const allowed = auth?.namespaces ?? ['*']
  if (!allowed.includes('*') && ['memory_add', 'memory_search', 'memory_replay'].includes(name) && !args.namespace) {
    // Fill the key's first allowed namespace instead of silently using the
    // server default namespace, which the key may not own.
    args.namespace = allowed[0]
  }
  if (args.namespace && !checkNamespace(auth, args.namespace)) return `no access to namespace: ${args.namespace}`
  if ((name === 'memory_get' || name === 'memory_update' || name === 'memory_archive' || name === 'memory_delete') && args.id) {
    const memory = store.getMemory(args.id)
    if (memory && !checkNamespace(auth, memory.namespace)) return `no access to namespace: ${memory.namespace}`
  }
  return null
}

function resolveStatic(requestPath, webRoot) {
  if (requestPath === '/' || requestPath === '/ui' || requestPath === '/ui/' || requestPath === '/index.html') {
    return { file: path.join(webRoot, 'index.html'), mime: MIME['.html'] }
  }
  const allowed = ['/app.js', '/styles.css', '/favicon.svg'].includes(requestPath)
  const asset = requestPath.startsWith('/assets/')
  if (!allowed && !asset) return null
  const relative = requestPath.replace(/^\/+/, '')
  const file = path.resolve(webRoot, relative)
  if (!file.startsWith(`${path.resolve(webRoot)}${path.sep}`)) return null
  return { file, mime: MIME[path.extname(file)] ?? 'application/octet-stream' }
}

async function serveStatic(req, res, requestPath, webRoot) {
  const target = resolveStatic(requestPath, webRoot)
  if (!target) return false
  try {
    const data = await fs.promises.readFile(target.file)
    const ext = path.extname(target.file)
    send(req, res, 200, data, target.mime, {
      'cache-control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=300',
    })
    return true
  } catch {
    return false
  }
}

function metricsLines(store, runtime) {
  const lines = []
  try {
    const stats = store.stats()
    lines.push('# HELP hippocampus_memories_total Memories by kind and status')
    lines.push('# TYPE hippocampus_memories_total gauge')
    for (const [kind, count] of Object.entries(stats.byKind)) {
      lines.push(`hippocampus_memories_total{kind="${kind}"} ${count}`)
    }
    lines.push('# HELP hippocampus_memories_status Memories by status')
    lines.push('# TYPE hippocampus_memories_status gauge')
    for (const [status, count] of Object.entries(stats.byStatus)) {
      lines.push(`hippocampus_memories_status{status="${status}"} ${count}`)
    }
    lines.push('# HELP hippocampus_db_size_bytes Database size')
    lines.push('# TYPE hippocampus_db_size_bytes gauge')
    lines.push(`hippocampus_db_size_bytes ${stats.dbSizeBytes}`)
    lines.push('# HELP hippocampus_conflicts_open Open conflicts')
    lines.push('# TYPE hippocampus_conflicts_open gauge')
    lines.push(`hippocampus_conflicts_open ${stats.openConflicts}`)
    const jobStats = runtime.jobs.stats()
    lines.push('# HELP hippocampus_jobs Jobs by status')
    lines.push('# TYPE hippocampus_jobs gauge')
    for (const [status, count] of Object.entries(jobStats.byStatus)) {
      lines.push(`hippocampus_jobs{status="${status}"} ${count}`)
    }
    const searchCache = runtime.cache.stats()
    lines.push('# HELP hippocampus_cache_hits Cache hits')
    lines.push('# TYPE hippocampus_cache_hits counter')
    lines.push(`hippocampus_cache_hits{cache="search"} ${searchCache.hits}`)
    lines.push('# HELP hippocampus_cache_misses Cache misses')
    lines.push('# TYPE hippocampus_cache_misses counter')
    lines.push(`hippocampus_cache_misses{cache="search"} ${searchCache.misses}`)
    if (runtime.embeddings.enabled) {
      const embeddings = runtime.embeddings.embeddingsStats(store)
      lines.push('# HELP hippocampus_embeddings_indexed Indexed embeddings per provider')
      lines.push('# TYPE hippocampus_embeddings_indexed gauge')
      for (const provider of embeddings.providers) {
        lines.push(`hippocampus_embeddings_indexed{provider="${provider.id}",model="${provider.model}"} ${provider.indexed}`)
      }
    }
  } catch {
    // metrics must never fail the scrape
  }
  return lines
}

/**
 * Build the HTTP server.
 * @param {{ store: import('./store.js').MemoryStore, token?: string, runtime?: object,
 *   webRoot?: string, cors?: boolean, startWorker?: boolean, config?: object }} options
 */
export function createMemoryHttpServer(options = {}) {
  const { store } = options
  if (!store) throw new Error('createMemoryHttpServer requires a store')
  const runtime = options.runtime ?? createRuntime({
    store,
    token: options.token,
    startWorker: options.startWorker !== false,
    options,
  })
  const { metrics, cache, graphCache, audit, auth, embeddings, jobs, rateLimiter } = runtime
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT
  const cors = options.cors !== false
  const allowedHosts = new Set()
  for (const entry of [options.host, ...(options.allowedHosts ?? []), ...configuredList('HIPPOCAMPUS_ALLOWED_HOSTS')]) {
    const host = bareHost(entry)
    if (host) allowedHosts.add(host)
  }
  const startedAt = Date.now()
  const metricsPublic = String(process.env.HIPPOCAMPUS_METRICS_PUBLIC ?? '') === '1'
  const requestedGraphProvider = options.graphProvider ?? process.env.HIPPOCAMPUS_GRAPH_PROVIDER ?? 'projection'
  let graphProvider = 'projection'
  try {
    graphProvider = resolveGraphProvider(store, requestedGraphProvider)
  } catch (error) {
    console.warn(`[hippocampus] graph provider "${requestedGraphProvider}" unavailable; using projection:`, error instanceof Error ? error.message : String(error))
  }
  const serverConfig = {
    version: VERSION,
    dbPath: store.dbPath,
    port: options.port ?? null,
    host: options.host ?? null,
    authRequired: auth.authRequired,
    embeddings: embeddings.describe(),
    worker: Boolean(options.startWorker !== false),
    graphProvider,
    storage: {
      driver: store.dialect ?? 'sqlite',
      pgvector: Boolean(store.db?.pgvector),
      schema: store.db?.schema ?? null,
      dataDir: store.dataDir ?? null,
    },
  }

  async function route(req, res, url, requestPath, authInfo) {
    const method = req.method ?? 'GET'
    const params = url.searchParams

    if (requestPath === '/api/auth/check') {
      return json(req, res, 200, { ok: true, auth: authInfo, authRequired: auth.authRequired, config: serverConfig })
    }

    if (requestPath === '/api/info') {
      return json(req, res, 200, {
        ok: true,
        service: 'hippocampus-memory',
        version: VERSION,
        dbPath: store.dbPath,
        storage: {
          driver: store.dialect ?? 'sqlite',
          pgvector: Boolean(store.db?.pgvector),
          schema: store.db?.schema ?? null,
        },
        endpoints: {
          mcp: '/mcp',
          ui: '/',
          tools: '/api/tools',
          search: '/api/memories/search?q=...',
          graph: '/api/graph',
          tree: '/api/tree',
          stats: '/api/stats',
          metrics: '/metrics',
          openapi: '/openapi.json',
        },
      })
    }

    if (requestPath === '/api/monitor') {
      requireRole(authInfo, 'reader')
      return json(req, res, 200, {
        ...metrics.snapshot({
          cache: { search: cache.stats(), graph: graphCache.stats(), embeddings: embeddings.queryCache.stats() },
          jobs: jobs.stats(),
          rateLimiter: rateLimiter.stats(),
          embeddings: embeddings.embeddingsStats(store),
          memory: store.stats({ namespaces: (authInfo.namespaces ?? ['*']).includes('*') ? null : authInfo.namespaces }),
        }),
        uptimeMs: Date.now() - startedAt,
      })
    }

    if (requestPath === '/api/stats') {
      requireRole(authInfo, 'reader')
      const statsNamespaces = (authInfo.namespaces ?? ['*']).includes('*') ? null : authInfo.namespaces
      const stats = store.stats({ namespaces: statsNamespaces })
      if (bool(params.get('includeConflicts'))) {
        stats.conflicts = store.listConflicts('open').filter((conflict) =>
          !statsNamespaces || [conflict.a?.namespace, conflict.b?.namespace].some((namespace) => namespace && statsNamespaces.includes(namespace)),
        )
      }
      return json(req, res, 200, stats)
    }

    if (requestPath === '/api/memories/search' && method === 'GET') {
      requireRole(authInfo, 'reader')
      const query = params.get('q') ?? params.get('query') ?? ''
      const namespace = resolveNamespace(authInfo, store, params.get('namespace') ?? undefined)
      const searchOptions = {
        limit: num(params.get('limit'), undefined),
        mode: params.get('mode') ?? (query ? 'relevance' : 'recent'),
        kinds: list(params.get('kinds') ?? params.get('kind')),
        tags: list(params.get('tags')),
        minImportance: num(params.get('minImportance'), undefined),
        namespace,
        includeArchived: bool(params.get('includeArchived')),
        includePending: bool(params.get('includePending')),
        explain: params.has('explain') ? bool(params.get('explain')) : true,
        // A cross-site GET cannot read the response (CORS), but must not
        // refresh decay/access counters either.
        updateAccess: !req.crossSite,
      }
      const key = cacheKey({ type: 'search', seq: store.refreshChangeSeq(), emb: embeddings.version, query, options: searchOptions })
      let result = cache.get(key)
      if (!result) {
        if (embeddings.enabled && !req.crossSite && query && searchOptions.mode === 'relevance') {
          const vector = await embeddings.search(store, query, { namespace })
          result = store.search(query, {
            ...searchOptions,
            extraIds: [...vector.scores.keys()],
            vectorScores: vector.scores,
            vectorWeight: vectorWeightFromEnv(),
          })
          result.embedding = {
            providers: vector.providers,
            errors: vector.errors,
            candidates: vector.scores.size,
          }
        } else {
          result = store.search(query, searchOptions)
        }
        cache.set(key, result, 15_000)
      }
      return json(req, res, 200, result)
    }

    if (requestPath === '/api/memories' && method === 'GET') {
      requireRole(authInfo, 'reader')
      const namespace = resolveNamespace(authInfo, store, params.get('namespace') ?? undefined)
      const status = params.get('status') ?? 'active'
      const result = store.list({
        namespace,
        limit: num(params.get('limit'), 50),
        offset: num(params.get('offset'), 0),
        order: params.get('order') ?? 'recent',
        kinds: list(params.get('kinds') ?? params.get('kind')),
        statuses: status === 'all' ? undefined : [status],
        includeArchived: bool(params.get('includeArchived')) || status === 'archived' || status === 'all',
        includePending: bool(params.get('includePending')) || status === 'all',
      })
      return json(req, res, 200, result)
    }

    if (requestPath === '/api/memories' && method === 'POST') {
      requireRole(authInfo, 'writer')
      const body = await readBody(req)
      const namespace = resolveNamespace(authInfo, store, body.namespace ?? undefined)
      const result = store.add({ ...body, namespace, source: 'http' })
      const job = embeddings.enabled && result.memory ? jobs.enqueue('embed', { memoryId: result.memory.id }, { createdBy: authInfo.actor }) : null
      res.audit = { action: 'memory.add', target: result.memory?.id, namespace, detail: { action: result.action, kind: result.memory?.kind } }
      return json(req, res, 201, { ...result, ...(job ? { embeddingJob: job.id } : {}) })
    }

    const idMatch = requestPath.match(/^\/api\/memories\/([\w.-]+)$/)
    if (idMatch) {
      const id = idMatch[1]
      const memory = store.getMemory(id)
      if (!memory) {
        if (method === 'GET') return json(req, res, 404, { found: false, id, message: '记忆不存在' })
        throw new HttpError(404, `memory not found: ${id}`)
      }
      requireNamespace(authInfo, memory.namespace)
      if (method === 'GET') {
        requireRole(authInfo, 'reader')
        // GET must not restore/refresh on a cross-site request: a browser can
        // trigger a GET via <img> even when it cannot read the response.
        const restore = req.crossSite ? false : params.has('restore') ? bool(params.get('restore')) : undefined
        return json(req, res, 200, store.get(id, { restore, updateAccess: !req.crossSite }))
      }
      if (method === 'PATCH' || method === 'PUT') {
        requireRole(authInfo, 'writer')
        const body = await readBody(req)
        const result = store.update(id, body)
        const job = embeddings.enabled && result.updated && (result.changed?.includes('content') || result.changed?.includes('tags'))
          ? jobs.enqueue('embed', { memoryId: id }, { createdBy: authInfo.actor })
          : null
        res.audit = { action: 'memory.update', target: id, namespace: memory.namespace, detail: { fields: result.changed } }
        return json(req, res, 200, { ...result, ...(job ? { embeddingJob: job.id } : {}) })
      }
      if (method === 'DELETE') {
        const hard = bool(params.get('hard'))
        requireRole(authInfo, hard ? 'admin' : 'writer')
        if (hard && !bool(params.get('confirm'))) throw new HttpError(400, 'hard delete requires confirm=true')
        const result = store.remove(id, { hard, confirm: bool(params.get('confirm')), force: bool(params.get('force')) })
        res.audit = { action: hard ? 'memory.delete_hard' : 'memory.delete', target: id, namespace: memory.namespace }
        return json(req, res, 200, result)
      }
      return text(req, res, 405, 'use GET, PATCH or DELETE')
    }

    const actionMatch = requestPath.match(/^\/api\/memories\/([\w.-]+)\/(archive|restore)$/)
    if (actionMatch) {
      if (method !== 'POST') return text(req, res, 405, 'use POST')
      requireRole(authInfo, 'writer')
      const id = actionMatch[1]
      const memory = store.getMemory(id)
      if (!memory) throw new HttpError(404, `memory not found: ${id}`)
      requireNamespace(authInfo, memory.namespace)
      const result = actionMatch[2] === 'archive' ? store.archive(id, await readBody(req)) : store.restore(id)
      res.audit = { action: `memory.${actionMatch[2]}`, target: id, namespace: memory.namespace }
      return json(req, res, 200, result)
    }

    if (requestPath === '/api/replay' && method === 'POST') {
      requireRole(authInfo, 'writer')
      const body = await readBody(req)
      const async = bool(body.async) || bool(params.get('async'))
      const replayNamespace = resolveNamespace(authInfo, store, body.namespace ?? undefined)
      res.audit = { action: 'memory.replay', namespace: replayNamespace, detail: { async } }
      if (async) {
        const job = jobs.enqueue('replay', { namespace: replayNamespace }, { createdBy: authInfo.actor })
        return json(req, res, 202, { ok: true, async: true, job })
      }
      return json(req, res, 200, store.replay({ dryRun: Boolean(body.dryRun), namespace: replayNamespace }))
    }

    if (requestPath === '/api/conflicts' && method === 'GET') {
      requireRole(authInfo, 'reader')
      const allowed = authInfo.namespaces ?? ['*']
      const conflicts = store.listConflicts(params.get('status') ?? 'open').filter((conflict) => {
        if (allowed.includes('*')) return true
        return [conflict.a?.namespace, conflict.b?.namespace].some((namespace) => namespace && allowed.includes(namespace))
      })
      return json(req, res, 200, { conflicts })
    }

    if (requestPath === '/api/export' && method === 'GET') {
      requireRole(authInfo, 'reader')
      const exportNamespace = resolveNamespace(authInfo, store, params.get('namespace') ?? undefined)
      return json(req, res, 200, store.exportAll(exportNamespace))
    }

    if (requestPath === '/api/import' && method === 'POST') {
      requireRole(authInfo, 'admin')
      const body = await readBody(req, 20 * 1024 * 1024)
      const result = store.importAll(body, { skipExisting: body.skipExisting !== false })
      res.audit = { action: 'memory.import', detail: { imported: result.imported } }
      if (embeddings.enabled) jobs.enqueue('embed_backfill', { limit: 2000 }, { createdBy: authInfo.actor })
      return json(req, res, 200, result)
    }

    if (requestPath === '/api/graph' && method === 'GET') {
      requireRole(authInfo, 'reader')
      const namespace = resolveNamespace(authInfo, store, params.get('namespace') ?? undefined)
      const graphOptions = {
        provider: graphProvider,
        namespace,
        limit: num(params.get('limit'), 200),
        includeArchived: bool(params.get('includeArchived')),
        includePending: params.has('includePending') ? bool(params.get('includePending')) : true,
        similarity: params.has('similarity') ? bool(params.get('similarity')) : true,
      }
      const key = cacheKey({ type: 'graph', provider: graphProvider, seq: store.refreshChangeSeq(), options: graphOptions })
      let result = graphCache.get(key)
      if (!result) {
        result = buildGraph(store, graphOptions)
        graphCache.set(key, result, 15_000)
      }
      return json(req, res, 200, result)
    }

    if (requestPath === '/api/tree' && method === 'GET') {
      requireRole(authInfo, 'reader')
      const namespace = resolveNamespace(authInfo, store, params.get('namespace') ?? undefined)
      const result = buildTree(store, {
        provider: graphProvider,
        namespace,
        limit: num(params.get('limit'), 500),
        includeArchived: bool(params.get('includeArchived')),
        includePending: params.has('includePending') ? bool(params.get('includePending')) : true,
      })
      return json(req, res, 200, result)
    }

    if (requestPath === '/api/jobs' && method === 'GET') {
      requireRole(authInfo, 'reader')
      const result = jobs.list({ status: params.get('status') ?? undefined, type: params.get('type') ?? undefined, limit: num(params.get('limit'), 50), offset: num(params.get('offset'), 0) })
      const allowed = authInfo.namespaces ?? ['*']
      if (!allowed.includes('*')) {
        result.items = result.items.filter((job) => {
          if (job.payload?.namespace && !allowed.includes(job.payload.namespace)) return false
          if (job.payload?.memoryId) {
            const memory = store.getMemory(job.payload.memoryId)
            return Boolean(memory && allowed.includes(memory.namespace))
          }
          return ['backup', 'maintenance'].includes(job.type) ? false : Boolean(job.payload?.namespace)
        })
        result.total = result.items.length
      }
      return json(req, res, 200, result)
    }

    if (requestPath === '/api/jobs' && method === 'POST') {
      requireRole(authInfo, 'writer')
      const body = await readBody(req)
      const allowed = ['replay', 'embed', 'embed_backfill', 'backup', 'maintenance', 'graph', 'tree']
      if (!allowed.includes(body.type)) throw new HttpError(400, `unsupported job type: ${body.type}`)
      if (['backup', 'maintenance'].includes(body.type)) requireRole(authInfo, 'admin')
      if (body.payload !== undefined && (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload))) {
        throw new HttpError(400, 'job payload must be an object')
      }
      const payload = body.payload ?? {}
      if (payload.namespace) requireNamespace(authInfo, payload.namespace)
      if (payload.memoryId) {
        const memory = store.getMemory(payload.memoryId)
        if (!memory) throw new HttpError(404, `memory not found: ${payload.memoryId}`)
        requireNamespace(authInfo, memory.namespace)
      }
      if (!(authInfo.namespaces ?? ['*']).includes('*') && ['replay', 'embed_backfill', 'graph', 'tree'].includes(body.type) && !payload.namespace) {
        payload.namespace = (authInfo.namespaces ?? ['default'])[0]
      }
      const job = jobs.enqueue(body.type, payload, { createdBy: authInfo.actor })
      res.audit = { action: `job.${body.type}`, target: job.id, detail: { payload: body.payload } }
      return json(req, res, 202, { ok: true, job })
    }

    const jobMatch = requestPath.match(/^\/api\/jobs\/([\w.-]+)(?:\/(cancel))?$/)
    if (jobMatch) {
      const job = jobs.get(jobMatch[1])
      if (!job) throw new HttpError(404, `job not found: ${jobMatch[1]}`)
      if (jobMatch[2]) {
        requireRole(authInfo, 'admin')
        if (method !== 'POST') return text(req, res, 405, 'use POST')
        const cancelled = jobs.cancel(job.id)
        res.audit = { action: 'job.cancel', target: job.id }
        return json(req, res, cancelled ? 200 : 409, { ok: cancelled, job: jobs.get(job.id) })
      }
      requireRole(authInfo, 'reader')
      const allowed = authInfo.namespaces ?? ['*']
      if (!allowed.includes('*')) {
        const payload = job.payload ?? {}
        const visible = payload.namespace
          ? allowed.includes(payload.namespace)
          : payload.memoryId
            ? allowed.includes(store.getMemory(payload.memoryId)?.namespace)
            : false
        if (!visible) throw new HttpError(403, 'no access to this job', 'forbidden')
      }
      return json(req, res, 200, { job })
    }

    if (requestPath === '/api/audit' && method === 'GET') {
      requireRole(authInfo, 'admin')
      return json(req, res, 200, audit.list({
        limit: num(params.get('limit'), 50),
        offset: num(params.get('offset'), 0),
        action: params.get('action') ?? undefined,
        actor: params.get('actor') ?? undefined,
        since: params.get('since') ? Number(params.get('since')) : undefined,
        until: params.get('until') ? Number(params.get('until')) : undefined,
      }))
    }

    if (requestPath === '/api/keys' && method === 'GET') {
      requireRole(authInfo, 'admin')
      return json(req, res, 200, { keys: auth.listKeys(), required: auth.authRequired })
    }

    if (requestPath === '/api/keys' && method === 'POST') {
      requireRole(authInfo, 'admin')
      const body = await readBody(req)
      const key = auth.createKey({
        name: body.name,
        role: body.role,
        namespaces: body.namespaces,
        expiresAt: body.expiresAt ?? null,
      })
      res.audit = { action: 'key.create', target: key.id, detail: { role: key.role, namespaces: key.namespaces } }
      return json(req, res, 201, key)
    }

    const keyMatch = requestPath.match(/^\/api\/keys\/([\w.-]+)$/)
    if (keyMatch && method === 'DELETE') {
      requireRole(authInfo, 'admin')
      const revoked = auth.revokeKey(keyMatch[1])
      res.audit = { action: 'key.revoke', target: keyMatch[1] }
      return json(req, res, revoked ? 200 : 404, { ok: revoked, id: keyMatch[1] })
    }

    if (requestPath === '/api/config' && method === 'GET') {
      requireRole(authInfo, 'admin')
      return json(req, res, 200, {
        ...serverConfig,
        authRequired: auth.authRequired,
        cache: { search: cache.stats(), graph: graphCache.stats(), embeddings: embeddings.queryCache.stats() },
        jobs: jobs.stats(),
        rateLimiter: rateLimiter.stats(),
        embeddings: embeddings.describe(),
        webRoot,
      })
    }

    if (requestPath === '/api/tools' && method === 'GET') {
      requireRole(authInfo, 'reader')
      return json(req, res, 200, {
        tools: TOOL_DEFS.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })),
      })
    }

    const toolMatch = requestPath.match(/^\/api\/tools\/([\w-]+)$/)
    if (toolMatch) {
      if (method !== 'POST') return text(req, res, 405, 'use POST')
      requireRole(authInfo, 'reader')
      const name = toolMatch[1]
      const args = await readBody(req)
      const denied = authorizeTool(store, authInfo, name, args)
      if (denied) throw new HttpError(403, denied, 'forbidden')
      const result = await callTool(store, name, args, { source: 'http' })
      if (embeddings.enabled && (name === 'memory_add' || name === 'memory_update') && result?.memory) {
        jobs.enqueue('embed', { memoryId: result.memory.id }, { createdBy: authInfo.actor })
      }
      res.audit = { action: `tool.${name}`, target: result?.memory?.id ?? args.id, namespace: result?.memory?.namespace ?? args.namespace }
      return json(req, res, 200, result)
    }

    if (requestPath === '/api/replay' || requestPath === '/api/import') {
      return text(req, res, 405, 'method not allowed')
    }

    throw new HttpError(404, `no route: ${method} ${requestPath}`)
  }

  async function handleRequest(req, res) {
    const started = performance.now()
    const requestId = randomUUID()
    res.setHeader('x-request-id', requestId)
    securityHeaders(res)
    if (!isTrustedHost(req, allowedHosts)) {
      return json(req, res, 421, {
        error: {
          code: 421,
          message: 'untrusted Host header (DNS rebinding protection); add it to HIPPOCAMPUS_ALLOWED_HOSTS for a reverse proxy',
        },
      })
    }
    if (cors) {
      // Only reflect origins that are local tools (loopback) or explicitly
      // allow-listed. A wildcard here would let any website read the local
      // memory bank through the loopback admin shortcut.
      const origin = req.headers.origin
      const allowedOrigin = origin ? corsOrigin(req, origin) : null
      if (allowedOrigin) {
        res.setHeader('access-control-allow-origin', allowedOrigin)
        res.setHeader('vary', 'origin')
        res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
        res.setHeader('access-control-allow-headers', 'content-type,authorization,x-api-key')
        res.setHeader('access-control-expose-headers', 'x-request-id,x-ratelimit-limit,x-ratelimit-remaining')
      }
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const requestPath = url.pathname.replace(/\/+$/, '') || '/'
    if (requestPath.startsWith('/api/') || requestPath === '/mcp') {
      // Memory contents and keys must not sit in browser/proxy caches.
      res.setHeader('cache-control', 'no-store')
    }
    const method = req.method ?? 'GET'
    const crossSite = isCrossSiteRequest(req)
    req.crossSite = crossSite
    if (STATE_METHODS.has(method) && crossSite) {
      return json(req, res, 403, {
        error: {
          code: 403,
          message: 'cross-site request blocked; use a JSON API client, a loopback origin, or add the origin to HIPPOCAMPUS_CORS_ORIGINS',
        },
      })
    }
    const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)

    res.on('finish', () => {
      metrics.observeHttp({ method, route: requestPath.replace(/\/[\w.-]{6,}/g, '/:id'), status: res.statusCode, durationMs: performance.now() - started })
      if (res.audit) {
        audit.record({
          requestId,
          actor: res.audit.actor ?? res.authInfo?.actor,
          role: res.audit.role ?? res.authInfo?.role,
          action: res.audit.action,
          method,
          path: requestPath,
          target: res.audit.target,
          namespace: res.audit.namespace,
          ip: req.socket.remoteAddress,
          status: res.statusCode,
          detail: res.audit.detail,
        })
      } else if (requestPath.startsWith('/api') && res.statusCode >= 400) {
        audit.record({
          requestId,
          actor: res.authInfo?.actor ?? 'anonymous',
          role: res.authInfo?.role,
          action: 'request.denied',
          method,
          path: requestPath,
          ip: req.socket.remoteAddress,
          status: res.statusCode,
        })
      }
    })

    if (method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }

    // Read-only endpoints must not silently accept writes. Answer 405 with the
    // Allow header so API clients (and tests) see the real contract.
    const allowedMethods = FIXED_METHODS.get(requestPath)
    if (allowedMethods && !allowedMethods.includes(method)) {
      res.setHeader('allow', allowedMethods.join(', '))
      return text(req, res, 405, `method not allowed: ${method} ${requestPath}`)
    }

    // Public routes: health, readiness, UI assets, public config.
    if (requestPath === '/health') {
      return json(req, res, 200, { ok: true, service: 'hippocampus-memory', version: VERSION })
    }
    if (requestPath === '/ready') {
      try {
        store.db.prepare('SELECT 1').get()
        return json(req, res, 200, { ok: true, ready: true })
      } catch (error) {
        return json(req, res, 503, { ok: false, ready: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (requestPath === '/api/public-config') {
      return json(req, res, 200, {
        ok: true,
        version: VERSION,
        authRequired: auth.authRequired,
        embeddings: embeddings.describe(),
        storage: {
          driver: store.dialect ?? 'sqlite',
          pgvector: Boolean(store.db?.pgvector),
        },
        graphProvider,
        ui: true,
        limits: { rate: rateLimiter.stats() },
      })
    }
    if (method === 'GET') {
      const served = await serveStatic(req, res, requestPath, webRoot).catch(() => false)
      if (served) return
    }

    if (requestPath === '/metrics' && metricsPublic) {
      const body = metrics.renderPrometheus(metricsLines(store, runtime))
      return send(req, res, 200, body, 'text/plain; version=0.0.4; charset=utf-8')
    }

    // Metrics may be scraped with a query token or a bearer header.
    const queryToken = requestPath === '/metrics' ? url.searchParams.get('token') : null
    const token = bearerToken(req) ?? queryToken
    const verification = auth.verify(token, { isLoopback })
    if (!verification.ok) {
      return json(req, res, 401, { error: { code: 401, message: `unauthorized: ${verification.reason}` } }, { 'www-authenticate': 'Bearer' })
    }
    const authInfo = verification.auth
    res.authInfo = authInfo

    if (requestPath === '/metrics') {
      if (!metricsPublic) requireRole(authInfo, 'admin')
      const body = metrics.renderPrometheus(metricsLines(store, runtime))
      return send(req, res, 200, body, 'text/plain; version=0.0.4; charset=utf-8')
    }

    // Rate-limit loopback too: a local webpage/app must not be able to spin
    // the synchronous SQLite path at will. Health/metrics stay cheap and open
    // for probes.
    if (!['/health', '/ready', '/metrics'].includes(requestPath)) {
      const rate = rateLimiter.take(authInfo.keyId ?? req.socket.remoteAddress ?? authInfo.actor)
      res.setHeader('x-ratelimit-limit', String(rate.limit))
      res.setHeader('x-ratelimit-remaining', String(rate.remaining))
      if (!rate.allowed) {
        res.setHeader('retry-after', String(rate.retryAfterSeconds))
        res.audit = { action: 'request.rate_limited', actor: authInfo.actor, role: authInfo.role }
        return json(req, res, 429, { error: { code: 429, message: 'rate limit exceeded' } })
      }
    }

    if (requestPath === '/mcp') {
      if (method !== 'POST') {
        return text(req, res, 405, 'MCP Streamable HTTP endpoint: send POST with a JSON-RPC message', { allow: 'POST' })
      }
      let message
      try {
        message = await readBody(req)
      } catch (error) {
        const parsed = parseMessage('{bad')
        return json(req, res, 200, parsed.error)
      }
      const mcp = createMcpServer({
        store,
        authorize: (name, args) => authorizeTool(store, authInfo, name, args),
        embeddings,
        indexOnWrite: true,
        authorizeResource: (uri) => {
          if (!checkRole(authInfo, 'reader')) return 'requires reader role'
          if (!(authInfo.namespaces ?? ['*']).includes('*')) return 'resources are only available to wildcard-namespace keys'
          return null
        },
      })
      const response = await mcp.handle(message)
      res.audit = { action: 'mcp.request', actor: authInfo.actor, role: authInfo.role }
      if (response === null) {
        res.writeHead(202)
        return res.end()
      }
      return json(req, res, 200, response)
    }

    if (requestPath === '/openapi.json' && method === 'GET') {
      return json(req, res, 200, openApiDocument(store))
    }

    try {
      await route(req, res, url, requestPath, authInfo)
    } catch (error) {
      if (!res.headersSent) {
        sendError(req, res, error)
      } else {
        try {
          res.end()
        } catch {
          // ignore a broken socket
        }
      }
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      // One bad request must never take down the service. If a partial
      // response was already written, close the socket; otherwise answer 500.
      if (res.headersSent || res.writableEnded) {
        try {
          res.destroy()
        } catch {
          // ignore
        }
        return
      }
      try {
        sendError(req, res, error)
      } catch {
        try {
          res.destroy()
        } catch {
          // ignore
        }
      }
    })
  })

  // Slowloris / stalled-body bounds. Node defaults are minutes; a local
  // browser page should not be able to pin sockets indefinitely.
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000

  server.on('clientError', (error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {
      // ignore
    }
  })

  // docs/OPERATIONS.md promises a daily maintenance pass (audit/jobs pruning
  // plus replay). Without a scheduler those tables only grow. Runs the same
  // maintenance job the API exposes; a no-op when the worker is disabled.
  const maintenanceHours = Number(options.autoMaintenanceHours ?? process.env.HIPPOCAMPUS_MAINTENANCE_HOURS ?? 24)
  let maintenanceTimer = null
  if (options.startWorker !== false && Number.isFinite(maintenanceHours) && maintenanceHours > 0) {
    maintenanceTimer = setInterval(() => {
      try {
        jobs.enqueue('maintenance', {}, { createdBy: 'scheduler' })
      } catch {
        // the queue is best-effort; a failed enqueue must not crash the server
      }
    }, Math.min(maintenanceHours * 3_600_000, 2_147_483_647))
    maintenanceTimer.unref?.()
  }

  server.on('close', () => {
    if (maintenanceTimer) clearInterval(maintenanceTimer)
    try {
      jobs.stop()
      rateLimiter.stop()
    } catch {
      // best effort
    }
  })

  return server
}

export function listen(server, { port = 7337, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      const address = server.address()
      resolve(address && typeof address === 'object' ? address : { address: host, port })
    })
  })
}

export function openApiDocument(store) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Hippocampus Memory API',
      version: VERSION,
      description: 'Long-term agent memory: four layers, SQLite persistence, hybrid retrieval, graph, audit, jobs.',
    },
    servers: [{ url: 'http://127.0.0.1:7337' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': { get: { summary: 'Liveness', security: [] } },
      '/ready': { get: { summary: 'Readiness', security: [] } },
      '/metrics': { get: { summary: 'Prometheus metrics', tags: ['ops'] } },
      '/mcp': { post: { summary: 'MCP JSON-RPC endpoint', tags: ['mcp'] } },
      '/api/tools': { get: { summary: 'List memory tools', tags: ['tools'] } },
      '/api/tools/{name}': { post: { summary: 'Call a memory tool', tags: ['tools'], parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/api/memories/search': {
        get: {
          summary: 'Recall memories (lexical + optional embeddings)',
          tags: ['memories'],
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'mode', in: 'query', schema: { type: 'string', enum: ['relevance', 'recent', 'important'] } },
            { name: 'namespace', in: 'query', schema: { type: 'string' } },
          ],
        },
      },
      '/api/memories': {
        get: { summary: 'List memories with pagination', tags: ['memories'] },
        post: { summary: 'Add a memory', tags: ['memories'] },
      },
      '/api/memories/{id}': {
        get: { summary: 'Get one memory', tags: ['memories'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
        patch: { summary: 'Update one memory', tags: ['memories'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
        delete: { summary: 'Soft/hard delete one memory', tags: ['memories'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
      },
      '/api/graph': { get: { summary: 'Star-map graph projection', tags: ['visualization'] } },
      '/api/tree': { get: { summary: 'Memory tree projection', tags: ['visualization'] } },
      '/api/jobs': { get: { summary: 'List async jobs', tags: ['jobs'] }, post: { summary: 'Enqueue an async job', tags: ['jobs'] } },
      '/api/jobs/{id}': { get: { summary: 'Get one job', tags: ['jobs'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
      '/api/audit': { get: { summary: 'Audit log (admin)', tags: ['security'] } },
      '/api/keys': { get: { summary: 'List API keys (admin)', tags: ['security'] }, post: { summary: 'Create API key (admin)', tags: ['security'] } },
      '/api/monitor': { get: { summary: 'Runtime monitor snapshot', tags: ['ops'] } },
      '/api/replay': { post: { summary: 'Run decay/archive/consolidation', tags: ['maintenance'] } },
      '/api/stats': { get: { summary: 'Memory bank statistics', tags: ['maintenance'] } },
      '/api/conflicts': { get: { summary: 'Open conflicts', tags: ['maintenance'] } },
      '/api/export': { get: { summary: 'Export a JSON snapshot', tags: ['maintenance'] } },
      '/api/import': { post: { summary: 'Import a JSON snapshot (admin)', tags: ['maintenance'] } },
    },
    'x-memory-db': store.dbPath,
  }
}
