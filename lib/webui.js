import { createMemoryHttpServer, listen } from './http.js'

function originFor(host, port) {
  const value = String(host || '127.0.0.1')
  const bindable = value === '0.0.0.0' || value === '::' || value === '[::]' ? '127.0.0.1' : value
  const hostPart = bindable.includes(':') && !bindable.startsWith('[') ? `[${bindable}]` : bindable
  return `http://${hostPart}:${port}`
}

/**
 * Lazily starts the WebUI/REST server. Authentication is handled by the
 * Mem0-style admin account/session in lib/auth.js; an explicit bootstrap token
 * is still honoured for API/programmatic access.
 */
export function createWebUiService({ store, host = '127.0.0.1', port = 7337, token, storage, graphProvider, logger = console } = {}) {
  let server = null
  let starting = null
  let stopped = false
  let origin = null
  let link = null

  async function start() {
    if (stopped) throw new Error('WebUI service has been stopped')
    if (link) return { origin, link }
    if (starting) return starting
    starting = (async () => {
      const candidate = createMemoryHttpServer({
        store,
        token: token && String(token).trim() ? String(token).trim() : undefined,
        host,
        port,
        storage,
        graphProvider,
      })
      try {
        const address = await listen(candidate, { port, host })
        if (stopped) {
          candidate.close()
          throw new Error('WebUI service has been stopped')
        }
        server = candidate
        origin = originFor(host, address.port)
        link = `${origin}/`
        logger.warn(`[hippocampus] Web UI + REST listening on ${origin}`)
        return { origin, link }
      } catch (error) {
        try {
          candidate.close()
        } catch {
          // ignore
        }
        starting = null
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
  }

  return { start, stop, get running() { return Boolean(server) }, get link() { return link }, get origin() { return origin } }
}
