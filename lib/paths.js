/**
 * Filesystem and storage-location resolution.
 *
 * Priority for SQLite:
 *   1. explicit `dbPath` / `HIPPOCAMPUS_DB` / `--db`
 *   2. explicit `dataDir` / `HIPPOCAMPUS_DATA_DIR` -> `<dataDir>/memory.db`
 *   3. legacy `$DSH_HOME/hippocampus/memory.db` (so v0.2 data is not lost)
 *   4. plugin-relative `.data/hippocampus/memory.db` (default)
 *   5. `$DSH_HOME/hippocampus/memory.db` when the plugin directory is read-only
 *
 * `storageLocation: "dsh"` forces option 5; `"plugin"` forces option 4.
 * PostgreSQL is selected with `storage: "postgres"` + `pgUrl` (or
 * `HIPPOCAMPUS_STORAGE=postgres` / `HIPPOCAMPUS_PG_URL`).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export function pluginRoot() {
  return ROOT
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function stripFileProtocol(value) {
  if (typeof value !== 'string') return value
  return value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value
}

/** Expand `~` and resolve relative paths against the current directory. */
export function expandPath(input) {
  if (!input) return undefined
  let value = stripFileProtocol(String(input)).trim()
  if (!value) return undefined
  if (value === '~') value = os.homedir()
  else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2))
  return path.resolve(value)
}

/** Relative data directories are resolved against the plugin root, not cwd. */
export function expandDataDir(input) {
  if (!input) return undefined
  let value = stripFileProtocol(String(input)).trim()
  if (!value) return undefined
  if (value === '~') value = os.homedir()
  else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value)
}

export function legacyDbPath() {
  return path.join(dshHome(), 'hippocampus', 'memory.db')
}

function writableDirectory(target) {
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    fs.accessSync(target, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Where a new SQLite database should live when no explicit file is given.
 * Defaults to `<plugin>/.data/hippocampus` (user request), then falls back to
 * `$DSH_HOME/hippocampus` if the plugin checkout is read-only.
 */
export function defaultDataDir({ location = process.env.HIPPOCAMPUS_DATA_LOCATION ?? 'plugin' } = {}) {
  const mode = String(location || 'plugin').toLowerCase()
  if (mode === 'dsh' || mode === 'framework') return path.join(dshHome(), 'hippocampus')
  const pluginData = path.join(ROOT, '.data', 'hippocampus')
  if (writableDirectory(pluginData)) return pluginData
  const dshData = path.join(dshHome(), 'hippocampus')
  if (writableDirectory(dshData)) return dshData
  return pluginData
}

export function defaultDbPath(options = {}) {
  return path.join(defaultDataDir(options), 'memory.db')
}

export function resolveDbPath(explicit, options = {}) {
  const direct = explicit ?? process.env.HIPPOCAMPUS_DB
  if (direct) return expandPath(direct)
  const configuredDataDir = options.dataDir ?? process.env.HIPPOCAMPUS_DATA_DIR
  if (configuredDataDir) return path.join(expandDataDir(configuredDataDir), 'memory.db')
  // Preserve data created by v0.2 (which lived under DSH_HOME) unless the user
  // explicitly selected a new data directory / location.
  if (fs.existsSync(legacyDbPath())) return legacyDbPath()
  return path.join(defaultDataDir(options), 'memory.db')
}

function sanitizeConnectionString(value) {
  try {
    const parsed = new URL(value)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return String(value).replace(/:\/\/([^:/@]+):([^@]+)@/, '://$1:***@')
  }
}

/**
 * Resolve the configured persistence backend.
 * @param {{ storage?: string, dbPath?: string, dataDir?: string, pgUrl?: string,
 *   pgSchema?: string, dataLocation?: string, pgPoolMax?: number,
 *   pgStatementTimeoutMs?: number, pgvector?: boolean }} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveStorageConfig(config = {}, env = process.env) {
  const pgUrl = config.pgUrl || env.HIPPOCAMPUS_PG_URL
  const requested = String(config.storage || env.HIPPOCAMPUS_STORAGE || (pgUrl ? 'postgres' : 'sqlite')).toLowerCase()
  if (requested === 'postgres' || requested === 'postgresql' || requested === 'pg') {
    if (!pgUrl) throw new Error('storage=postgres requires pgUrl or HIPPOCAMPUS_PG_URL')
    return {
      driver: 'postgres',
      url: pgUrl,
      dbPath: sanitizeConnectionString(pgUrl),
      schema: config.pgSchema || env.HIPPOCAMPUS_PG_SCHEMA || 'public',
      pgvector: config.pgvector ?? env.HIPPOCAMPUS_PGVECTOR !== 'false',
      poolMax: Number(config.pgPoolMax ?? env.HIPPOCAMPUS_PG_POOL_MAX) || 4,
      statementTimeoutMs: Number(config.pgStatementTimeoutMs ?? env.HIPPOCAMPUS_PG_STATEMENT_TIMEOUT_MS) || 30_000,
      dataDir: expandDataDir(config.dataDir || env.HIPPOCAMPUS_DATA_DIR),
    }
  }
  const dataDir = expandDataDir(config.dataDir || env.HIPPOCAMPUS_DATA_DIR)
  const dbPath = resolveDbPath(config.dbPath, {
    dataDir,
    location: config.dataLocation || env.HIPPOCAMPUS_DATA_LOCATION,
  })
  return { driver: 'sqlite', dbPath, dataDir: dataDir ?? path.dirname(dbPath) }
}

/** Human-readable backend name for config/status endpoints. */
export function storageLabel(storage) {
  if (!storage) return 'sqlite'
  return storage.driver === 'postgres' ? `postgres${storage.pgvector ? '+pgvector' : ''}` : 'sqlite'
}
