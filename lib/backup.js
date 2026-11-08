/**
 * Logical memory backups.
 *
 * A backup is a JSON snapshot of the memory bank (memories, conflicts and
 * namespace metadata), not auth data. It is portable between SQLite and
 * PostgreSQL and can be restored while the HTTP server is running.
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SCHEMA_VERSION } from './constants.js'

export function defaultBackupDir(store) {
  if (store.dialect === 'postgres') {
    return path.join(store.dataDir ?? process.env.HIPPOCAMPUS_BACKUP_DIR ?? process.cwd(), 'backups')
  }
  return path.join(path.dirname(store.dbPath), 'backups')
}

function safeLabel(label) {
  return String(label || 'manual')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'manual'
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function backupFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^memory-.*\.json$/.test(name))
      .map((name) => {
        const file = path.join(dir, name)
        try {
          const stat = fs.lstatSync(file)
          if (!stat.isFile()) return null
          return { name, file, size: stat.size, createdAt: stat.mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

function prune(dir, keep) {
  const limit = Math.max(1, Number(keep) || 20)
  let removed = 0
  for (const entry of backupFiles(dir).slice(limit)) {
    try {
      fs.rmSync(entry.file, { force: true })
      removed += 1
    } catch {
      // best effort
    }
  }
  return removed
}

export function createBackup(store, { backupDir, label = 'manual', keep } = {}) {
  const dir = backupDir ?? defaultBackupDir(store)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // best effort on filesystems without POSIX modes
  }
  const name = `memory-${stamp()}-${randomBytes(3).toString('hex')}-${safeLabel(label)}.json`
  const file = path.join(dir, name)
  const tmp = `${file}.tmp`
  const snapshot = { ...store.exportAll('*'), reason: label, createdAt: Date.now() }
  try {
    fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 })
    fs.renameSync(tmp, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // best effort
    }
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    throw error
  }
  const pruned = prune(dir, keep ?? process.env.HIPPOCAMPUS_BACKUP_KEEP)
  return { name, file, size: fs.statSync(file).size, createdAt: snapshot.createdAt, reason: label, pruned }
}

export function listBackups({ backupDir, store } = {}) {
  const dir = backupDir ?? (store ? defaultBackupDir(store) : null)
  if (!dir) return { ok: true, dir: null, backups: [] }
  const backups = backupFiles(dir).map((entry) => ({
    name: entry.name,
    size: entry.size,
    createdAt: entry.createdAt,
  }))
  return { ok: true, dir, backups, total: backups.length }
}

export function resolveBackup({ backupDir, store, name }) {
  const dir = backupDir ?? (store ? defaultBackupDir(store) : null)
  if (!dir) throw Object.assign(new Error('backup directory is not configured'), { status: 400 })
  const base = String(name ?? '')
  if (!base || path.basename(base) !== base || !/^memory-.*\.json$/.test(base)) {
    throw Object.assign(new Error(`invalid backup name: ${base}`), { status: 400 })
  }
  const file = path.resolve(dir, base)
  if (!file.startsWith(`${path.resolve(dir)}${path.sep}`)) {
    throw Object.assign(new Error('invalid backup path'), { status: 400 })
  }
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    throw Object.assign(new Error(`backup not found: ${base}`), { status: 404 })
  }
  if (!stat.isFile()) throw Object.assign(new Error('backup path is not a regular file'), { status: 400 })
  return file
}

export function readBackup({ backupDir, store, name }) {
  const file = resolveBackup({ backupDir, store, name })
  let snapshot
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw Object.assign(new Error('backup file is not valid JSON'), { status: 400 })
  }
  if (!snapshot || snapshot.format !== 'hippocampus-memory') {
    throw Object.assign(new Error('not a hippocampus-memory backup'), { status: 400 })
  }
  if (!Array.isArray(snapshot.memories)) {
    throw Object.assign(new Error('backup has no memories array; refusing to replace data'), { status: 400 })
  }
  if (Number(snapshot.version) > SCHEMA_VERSION) {
    throw Object.assign(new Error('backup is newer than this build; upgrade first'), { status: 400 })
  }
  return { file, snapshot }
}

export function restoreBackup({ store, backupDir, name, dryRun = true } = {}) {
  const { file, snapshot } = readBackup({ backupDir, store, name })
  const stats = store.stats()
  const summary = {
    backup: { name: path.basename(file), size: fs.statSync(file).size, exportedAt: snapshot.exportedAt ?? null },
    snapshot: {
      memories: Array.isArray(snapshot.memories) ? snapshot.memories.length : 0,
      conflicts: Array.isArray(snapshot.conflicts) ? snapshot.conflicts.length : 0,
      namespaces: Array.isArray(snapshot.namespaces) ? snapshot.namespaces.length : 0,
      version: snapshot.version ?? null,
    },
    current: {
      memories: stats.totals.all,
      namespaces: Object.keys(stats.byNamespace ?? {}).length,
    },
  }
  if (dryRun) return { ok: true, dryRun: true, ...summary }
  let activeJobs = 0
  try {
    activeJobs = Number(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')").get()?.n ?? 0)
  } catch {
    activeJobs = 0
  }
  if (activeJobs > 0) {
    throw Object.assign(
      new Error(`restore refused: ${activeJobs} queued/running jobs; wait for or cancel jobs first`),
      { status: 409 },
    )
  }
  const preRestore = createBackup(store, { backupDir, label: 'pre-restore' })
  const restored = store.restoreAll(snapshot, { ignorePolicies: true })
  return { ok: true, dryRun: false, ...summary, restored, preRestoreBackup: { name: preRestore.name, size: preRestore.size } }
}

export function deleteBackup({ backupDir, store, name }) {
  const file = resolveBackup({ backupDir, store, name })
  fs.rmSync(file, { force: true })
  return { ok: true, name: path.basename(file) }
}
