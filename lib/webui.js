import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemoryHttpServer, listen } from './http.js'

const TOKEN_BYTES = 32

function chmod(target, mode) {
  try {
    fs.chmodSync(target, mode)
  } catch {
    // FUSE / Windows may not support the exact mode; best effort.
  }
}

function tokenHome(dshHome) {
  return dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function loadOrCreateToken(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= TOKEN_BYTES * 2) return existing
  } catch {
    // missing/unreadable: create below
  }
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  chmod(path.dirname(file), 0o700)
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= TOKEN_BYTES * 2) return existing
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
  }
  chmod(file, 0o600)
  return token
}

function originFor(host, port) {
  const value = String(host || '127.0.0.1')
  const bindable = value === '0.0.0.0' || value === '::' || value === '[::]' ? '127.0.0.1' : value
  const hostPart = bindable.includes(':') && !bindable.startsWith('[') ? `[${bindable}]` : bindable
  return `http://${hostPart}:${port}`
}

/**
 * Lazily starts the WebUI/REST server and owns the first-run token.
 *
 * The token is stored under $DSH_HOME (0600), never in the repo or a URL
 * query. The panel copies a link whose token lives in the URL fragment; the
 * browser stores it in sessionStorage and clears the hash immediately.
 */
export function createWebUiService({ store, host = '127.0.0.1', port = 7337, token, dshHome, storage, graphProvider, logger = console } = {}) {
  const tokenFile = path.join(tokenHome(dshHome), 'hippocampus', 'webui-token')
  let server = null
  let starting = null
  let stopped = false
  let origin = null
  let link = null

  function resolveToken() {
    if (token && String(token).trim()) return String(token).trim()
    return loadOrCreateToken(tokenFile)
  }

  async function start() {
    if (stopped) throw new Error('WebUI service has been stopped')
    if (link) return { origin, link, tokenFile }
    if (starting) return starting
    starting = (async () => {
      const secret = resolveToken()
      const candidate = createMemoryHttpServer({
        store,
        token: secret,
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
        link = `${origin}/#token=${encodeURIComponent(secret)}`
        logger.warn(`[hippocampus] Web UI + REST listening on ${origin} (token in panel link)`)
        return { origin, link, tokenFile }
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

  return { start, stop, tokenFile, get running() { return Boolean(server) }, get link() { return link }, get origin() { return origin } }
}
