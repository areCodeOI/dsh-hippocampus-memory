/**
 * Namespace management.
 *
 * Namespaces are implicit partitions of the `memories` table: there is no
 * namespaces table, and the schema stays at version 3. To let operators reserve
 * an empty space (and to keep the list stable across renames) names without
 * memories are recorded in the existing `meta` table under
 * `namespace_registry`.
 *
 * All multi-row mutations run in one transaction. A rename also rewrites
 * API-key allow-lists and queued job payloads so access/background work follows
 * the new name. Audit rows are historical and are intentionally left untouched.
 */

import { withTransaction, parseJson } from './db.js'
import { assertNamespace } from './store.js'
import { DELETE_GRACE_DAYS, PENDING_DELETE_MS } from './constants.js'

const REGISTRY_KEY = 'namespace_registry'

function fail(status, message) {
  const error = new Error(message)
  error.status = status
  throw error
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function readRegistry(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(REGISTRY_KEY)
  if (!row) return []
  const parsed = parseJson(row.value, [])
  return Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string') : []
}

function writeRegistry(db, names) {
  const unique = [...new Set(names)].filter(Boolean).sort()
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(REGISTRY_KEY, JSON.stringify(unique))
}

function hasMemories(db, name) {
  return Boolean(db.prepare('SELECT 1 FROM memories WHERE namespace = ? LIMIT 1').get(name))
}

function reserved(db, name) {
  return readRegistry(db).includes(name)
}

function exists(db, name) {
  return hasMemories(db, name) || reserved(db, name)
}

function renameApiKeys(db, from, to) {
  let changed = 0
  for (const row of db.prepare('SELECT id, namespaces FROM api_keys').all()) {
    const list = parseJson(row.namespaces, ['*'])
    if (!Array.isArray(list) || list.includes('*') || !list.includes(from)) continue
    const next = [...new Set(list.map((name) => (name === from ? to : name)))]
    db.prepare('UPDATE api_keys SET namespaces = ? WHERE id = ?').run(JSON.stringify(next), row.id)
    changed += 1
  }
  return changed
}

function rewriteJobs(db, from, to) {
  let changed = 0
  for (const row of db.prepare('SELECT id, payload FROM jobs').all()) {
    const payload = parseJson(row.payload, {})
    if (!payload || payload.namespace !== from) continue
    payload.namespace = to
    db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(JSON.stringify(payload), row.id)
    changed += 1
  }
  return changed
}

function deleteJobs(db, namespace, memoryIds) {
  let deleted = 0
  for (const row of db.prepare('SELECT id, status, payload FROM jobs').all()) {
    if (row.status === 'running') continue
    const payload = parseJson(row.payload, {})
    const targetsNamespace = payload?.namespace === namespace
    const targetsMemory = Boolean(payload?.memoryId && memoryIds.has(payload.memoryId))
    if (!targetsNamespace && !targetsMemory) continue
    db.prepare('DELETE FROM jobs WHERE id = ?').run(row.id)
    deleted += 1
  }
  return deleted
}

function kindEntry() {
  return { persona: 0, semantic: 0, episodic: 0, buffer: 0 }
}

/** Aggregate per-namespace stats without loading every memory row. */
function aggregate(db) {
  const map = new Map()
  const entry = (name) => {
    if (!map.has(name)) {
      map.set(name, {
        name,
        total: 0,
        active: 0,
        conflict: 0,
        archived: 0,
        pendingDelete: 0,
        superseded: 0,
        openConflicts: 0,
        byKind: kindEntry(),
        firstAt: null,
        lastAt: null,
        updatedAt: null,
        reserved: false,
      })
    }
    return map.get(name)
  }
  for (const row of db.prepare(
    'SELECT namespace, COUNT(*) AS total, MIN(created_at) AS first_at, MAX(created_at) AS last_at, MAX(updated_at) AS updated_at FROM memories GROUP BY namespace',
  ).all()) {
    const item = entry(row.namespace)
    item.total = num(row.total)
    item.firstAt = row.first_at === null ? null : num(row.first_at)
    item.lastAt = row.last_at === null ? null : num(row.last_at)
    item.updatedAt = row.updated_at === null ? null : num(row.updated_at)
  }
  const statusKey = { pending_delete: 'pendingDelete' }
  for (const row of db.prepare('SELECT namespace, status, COUNT(*) AS n FROM memories GROUP BY namespace, status').all()) {
    entry(row.namespace)[statusKey[row.status] ?? row.status] = num(row.n)
  }
  for (const row of db.prepare('SELECT namespace, kind, COUNT(*) AS n FROM memories GROUP BY namespace, kind').all()) {
    const item = entry(row.namespace)
    if (item.byKind[row.kind] !== undefined) item.byKind[row.kind] = num(row.n)
  }
  for (const row of db.prepare(
    "SELECT m.namespace AS namespace, COUNT(*) AS n FROM conflicts c JOIN memories m ON m.id = c.memory_a WHERE c.status = 'open' GROUP BY m.namespace",
  ).all()) {
    entry(row.namespace).openConflicts = num(row.n)
  }
  for (const name of readRegistry(db)) {
    entry(name).reserved = true
  }
  return map
}

/**
 * List namespaces visible to the caller.
 * `allowed` is the auth namespace list; `*` means all.
 */
export function listNamespaces(store, { allowed = ['*'] } = {}) {
  const all = [...aggregate(store.db).values()]
  // Always show the configured default, even before its first write.
  if (!all.some((item) => item.name === store.namespace)) {
    all.push({
      name: store.namespace,
      total: 0,
      active: 0,
      conflict: 0,
      archived: 0,
      pendingDelete: 0,
      superseded: 0,
      openConflicts: 0,
      byKind: kindEntry(),
      firstAt: null,
      lastAt: null,
      updatedAt: null,
      reserved: false,
    })
  }
  const visible = !allowed || allowed.includes('*') ? all : all.filter((item) => allowed.includes(item.name))
  visible.sort((a, b) => {
    if (a.name === store.namespace) return -1
    if (b.name === store.namespace) return 1
    return b.total - a.total || a.name.localeCompare(b.name)
  })
  return {
    ok: true,
    default: store.namespace,
    protected: store.namespace,
    total: visible.length,
    namespaces: visible,
  }
}

/** Reserve a name. Writing the first memory also creates a namespace. */
export function createNamespace(store, name) {
  if (name === undefined || name === null || String(name).trim() === '') fail(400, 'namespace name is required')
  const value = assertNamespace(name)
  if (exists(store.db, value)) {
    return { ok: true, created: false, name: value, message: 'namespace already exists' }
  }
  withTransaction(store.db, () => {
    writeRegistry(store.db, [...readRegistry(store.db), value])
  })
  return { ok: true, created: true, name: value, message: 'namespace created' }
}

/** Rename a namespace and move all references that must follow it. */
export function renameNamespace(store, from, to, { force = false } = {}) {
  if (to === undefined || to === null || String(to).trim() === '') fail(400, 'target namespace name is required')
  const source = assertNamespace(from)
  const target = assertNamespace(to)
  if (source === target) fail(400, 'source and target namespace are the same')
  if (source === store.namespace && !force) {
    fail(400, 'refusing to rename the configured default namespace; update the plugin config first or pass force=true')
  }
  if (!exists(store.db, source)) fail(404, `namespace not found: ${source}`)
  if (exists(store.db, target)) fail(409, `target namespace already exists: ${target}`)
  return withTransaction(store.db, () => {
    const now = store.now()
    const moved = store.db.prepare('UPDATE memories SET namespace = ?, updated_at = ? WHERE namespace = ?').run(target, now, source)
    const apiKeys = renameApiKeys(store.db, source, target)
    const jobs = rewriteJobs(store.db, source, target)
    const registry = [...readRegistry(store.db).filter((name) => name !== source), target]
    writeRegistry(store.db, registry)
    store.bump()
    return {
      ok: true,
      from: source,
      to: target,
      moved: num(moved.changes),
      apiKeys,
      jobs,
    }
  })
}

function mergeIntoRow(db, source, target, now) {
  const tags = [...new Set([...parseJson(source.tags, []), ...parseJson(target.tags, [])])]
  const entities = [...new Set([...parseJson(source.entities, []), ...parseJson(target.entities, [])])]
  const metadata = { ...parseJson(target.metadata, {}), ...parseJson(source.metadata, {}) }
  const lastAccessAt = Math.max(num(source.last_access_at), num(target.last_access_at)) || null
  db.prepare(
    `UPDATE memories SET importance = ?, confidence = ?, weight = ?, access_count = ?, last_access_at = ?,
       tags = ?, entities = ?, metadata = ?, updated_at = ? WHERE id = ?`,
  ).run(
    Math.max(num(source.importance), num(target.importance)),
    Math.max(num(source.confidence), num(target.confidence)),
    Math.max(num(source.weight), num(target.weight)),
    num(source.access_count) + num(target.access_count),
    lastAccessAt,
    JSON.stringify(tags),
    JSON.stringify(entities),
    JSON.stringify(metadata),
    now,
    target.id,
  )
}

/**
 * Move every memory from `from` into `into`.
 * Exact active duplicates are consolidated into the target record (tags,
 * entities, importance, confidence, weight, access counters) instead of
 * creating a second copy of the same fact.
 */
export function mergeNamespaces(store, from, into, { force = false } = {}) {
  if (into === undefined || into === null || String(into).trim() === '') fail(400, 'target namespace name is required')
  const source = assertNamespace(from)
  const target = assertNamespace(into)
  if (source === target) fail(400, 'source and target namespace are the same')
  if (source === store.namespace && !force) {
    fail(400, 'refusing to merge the configured default namespace; update the plugin config first or pass force=true')
  }
  if (!exists(store.db, source)) fail(404, `namespace not found: ${source}`)
  return withTransaction(store.db, () => {
    const now = store.now()
    const sourceRows = store.db.prepare('SELECT * FROM memories WHERE namespace = ?').all(source)
    const targetActive = new Map(
      store.db
        .prepare("SELECT * FROM memories WHERE namespace = ? AND status = 'active'")
        .all(target)
        .map((row) => [row.content_hash, row]),
    )
    let moved = 0
    let deduped = 0
    for (const row of sourceRows) {
      const duplicate = row.status === 'active' ? targetActive.get(row.content_hash) : null
      if (duplicate && duplicate.id !== row.id) {
        mergeIntoRow(store.db, row, duplicate, now)
        store.deleteFts(row.id)
        store.deleteVectors(row.id)
        store.db.prepare('DELETE FROM memories WHERE id = ?').run(row.id)
        store.db
          .prepare("UPDATE conflicts SET status = 'dismissed', resolved_at = ? WHERE status = 'open' AND (memory_a = ? OR memory_b = ?)")
          .run(now, row.id, row.id)
        store.db
          .prepare(
            `UPDATE memories SET
               conflict_with = CASE WHEN conflict_with = ? THEN ? ELSE conflict_with END,
               superseded_by = CASE WHEN superseded_by = ? THEN ? ELSE superseded_by END,
               consolidated_into = CASE WHEN consolidated_into = ? THEN ? ELSE consolidated_into END`,
          )
          .run(row.id, duplicate.id, row.id, duplicate.id, row.id, duplicate.id)
        store.logEvent(duplicate.id, 'namespace_merge_dedupe', { from: source, sourceId: row.id })
        deduped += 1
      } else {
        store.db.prepare('UPDATE memories SET namespace = ?, updated_at = ? WHERE id = ?').run(target, now, row.id)
        moved += 1
      }
    }
    const apiKeys = renameApiKeys(store.db, source, target)
    const jobs = rewriteJobs(store.db, source, target)
    writeRegistry(store.db, [...readRegistry(store.db).filter((name) => name !== source), target])
    store.bump()
    return {
      ok: true,
      from: source,
      into: target,
      moved,
      deduped,
      apiKeys,
      jobs,
    }
  })
}

/**
 * Delete a namespace.
 * Default is a reversible 7-day soft delete (same grace period as a single
 * memory); `hard` permanently removes memories, vectors and non-running jobs.
 * Persona memories require `force` for the permanent path.
 */
export function deleteNamespace(store, name, { hard = false, confirm = false, force = false } = {}) {
  const value = assertNamespace(name)
  if (value === store.namespace && !force) {
    fail(400, 'refusing to delete the configured default namespace; update the plugin config first or pass force=true')
  }
  if (!exists(store.db, value)) fail(404, `namespace not found: ${value}`)
  const rows = store.db.prepare('SELECT id, kind, status FROM memories WHERE namespace = ?').all(value)
  const personas = rows.filter((row) => row.kind === 'persona').length
  if (hard) {
    if (!confirm) fail(400, 'hard delete requires confirm=true')
    if (personas > 0 && !force) fail(409, `namespace contains ${personas} persona memories; pass force=true to delete them`)
    return withTransaction(store.db, () => {
      const now = store.now()
      for (const row of rows) {
        store.deleteFts(row.id)
        store.deleteVectors(row.id)
        store.db.prepare('DELETE FROM memories WHERE id = ?').run(row.id)
        store.db
          .prepare("UPDATE conflicts SET status = 'dismissed', resolved_at = ? WHERE status = 'open' AND (memory_a = ? OR memory_b = ?)")
          .run(now, row.id, row.id)
      }
      const jobs = deleteJobs(store.db, value, new Set(rows.map((row) => row.id)))
      writeRegistry(store.db, readRegistry(store.db).filter((entry) => entry !== value))
      store.bump()
      return {
        ok: true,
        hard: true,
        namespace: value,
        deleted: rows.length,
        personas,
        jobs,
      }
    })
  }
  const now = store.now()
  const purgeAfter = now + PENDING_DELETE_MS
  return withTransaction(store.db, () => {
    let pending = 0
    for (const row of rows) {
      if (row.status === 'pending_delete') continue
      store.db
        .prepare("UPDATE memories SET status = 'pending_delete', purge_after = ?, updated_at = ? WHERE id = ?")
        .run(purgeAfter, now, row.id)
      pending += 1
    }
    for (const row of rows) {
      store.db
        .prepare("UPDATE conflicts SET status = 'dismissed', resolved_at = ? WHERE status = 'open' AND (memory_a = ? OR memory_b = ?)")
        .run(now, row.id, row.id)
    }
    store.logEvent(null, 'namespace_delete_soft', { namespace: value, memories: rows.length, purgeAfter })
    writeRegistry(store.db, readRegistry(store.db).filter((entry) => entry !== value))
    store.bump()
    return {
      ok: true,
      hard: false,
      namespace: value,
      pending,
      memories: rows.length,
      personas,
      purgeAfter,
      graceDays: DELETE_GRACE_DAYS,
    }
  })
}
