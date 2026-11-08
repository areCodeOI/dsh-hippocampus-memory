import { createMemoryHttpServer, listen } from './http.js'

function originFor(host, port) {
  const value = String(host || '127.0.0.1')
  const bindable = value === '0.0.0.0' || value === '::' || value === '[::]' ? '127.0.0.1' : value
  const hostPart = bindable.includes(':') && !bindable.startsWith('[') ? `[${bindable}]` : bindable
  return `http://${hostPart}:${port}`
}

/** Ask an already-listening instance whether it is really this service. */
async function probeExisting(host, port) {
  const base = originFor(host, port)
  const timeout = AbortSignal.timeout(1500)
  try {
    const health = await fetch(`${base}/health`, { signal: timeout })
    if (!health.ok) return null
    const data = await health.json().catch(() => ({}))
    if (data?.service !== 'hippocampus-memory') return null
    const publicConfig = await fetch(`${base}/api/public-config`, { signal: timeout })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
    return { version: data.version ?? publicConfig?.version ?? null }
  } catch {
    return null
  }
}

/**
 * Lazily starts the WebUI/REST server. Authentication is handled by the
 * Mem0-style admin account/session in lib/auth.js; an explicit bootstrap token
 * is still honoured for API/programmatic access.
 *
 * If the port is already served by another hippocampus instance (a reloading
 * fiber, a CLI `serve-http`, or the same DB opened by an MCP process) the
 * service reuses it and reports `external: true` rather than failing silently.
 */
export function createWebUiService({
  store,
  host = '127.0.0.1',
  port = 7337,
  token,
  storage,
  graphProvider,
  corsOrigins,
  logger = console,
} = {}) {
  let server = null
  let starting = null
  let stopped = false
  let origin = null
  let link = null
  let external = null
  let actualPort = null

  async function start() {
    if (stopped) throw new Error('WebUI service has been stopped')
    if (link) return { origin, link, ...(external ? { external: true, port: actualPort } : {}) }
    if (starting) return starting
    starting = (async () => {
      const candidate = createMemoryHttpServer({
        store,
        token: token && String(token).trim() ? String(token).trim() : undefined,
        host,
        port,
        storage,
        graphProvider,
        corsOrigins,
      })
      try {
        const address = await listen(candidate, { port, host })
        if (stopped) {
          candidate.close()
          throw new Error('WebUI service has been stopped')
        }
        server = candidate
        actualPort = address.port
        origin = originFor(host, address.port)
        link = `${origin}/`
        logger.warn(`[hippocampus] Web UI + REST listening on ${origin}`)
        return { origin, link, port: actualPort }
      } catch (error) {
        try {
          candidate.close()
        } catch {
          // ignore
        }
        starting = null
        // EADDRINUSE after retries: either a stale socket or another instance.
        // Reusing a healthy hippocampus service is better than a dead panel.
        if (error?.code === 'EADDRINUSE') {
          const running = await probeExisting(host, port)
          if (running) {
            external = running
            actualPort = port
            origin = originFor(host, port)
            link = `${origin}/`
            logger.warn(
              `[hippocampus] port ${port} is already served by hippocampus ${running.version ?? ''}; reusing ${origin}`,
            )
            return { origin, link, external: true, port: actualPort }
          }
        }
        throw error
      }
    })()
    return starting
  }

  function stop() {
    stopped = true
    try {
      server?.close()
    } catch {
      // ignore
    }
    server = null
    starting = null
    origin = null
    link = null
    external = null
    actualPort = null
  }

  return {
    start,
    stop,
    get running() {
      return Boolean(server || external)
    },
    get external() {
      return Boolean(external)
    },
    get port() {
      return actualPort
    },
    get link() {
      return link
    },
    get origin() {
      return origin
    },
  }
}
