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
import { createBackup } from './backup.js'
import { DELETE_GRACE_DAYS, PENDING_DELETE_MS } from './constants.js'

const REGISTRY_KEY = 'namespace_registry'
const KIND_RANK = { buffer: 1, episodic: 2, semantic: 3, persona: 4 }

function abortError() {
  const error = new Error('namespace operation cancelled')
  error.name = 'AbortError'
  return error
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError()
}

const META_TEXT_LIMITS = { description: 500, color: 32, embeddingProvider: 64 }

function emptyMeta() {
  return {
    description: '',
    color: '',
    archived: false,
    readOnly: false,
    retentionDays: null,
    autoRecall: null,
    embeddingProvider: null,
    softLimit: null,
    settings: {},
  }
}

function namespaceRows(db) {
  try {
    return db.prepare('SELECT * FROM namespaces').all()
  } catch {
    return []
  }
}

function namespaceRow(db, name) {
  try {
    return db.prepare('SELECT * FROM namespaces WHERE name = ?').get(name)
  } catch {
    return undefined
  }
}

function rowMeta(row) {
  if (!row) return emptyMeta()
  return {
    description: row.description ?? '',
    color: row.color ?? '',
    archived: Boolean(Number(row.archived)),
    readOnly: Boolean(Number(row.read_only)),
    retentionDays: row.retention_days === null || row.retention_days === undefined ? null : Number(row.retention_days),
    autoRecall: row.auto_recall === null || row.auto_recall === undefined ? null : Boolean(Number(row.auto_recall)),
    embeddingProvider: row.embedding_provider ?? null,
    softLimit: row.soft_limit === null || row.soft_limit === undefined ? null : Number(row.soft_limit),
    settings: parseJson(row.settings, {}),
    createdAt: Number(row.created_at ?? 0) || null,
    updatedAt: Number(row.updated_at ?? 0) || null,
  }
}

function toBool(value) {
  if (typeof value === 'string') return !/^(0|false|no|off|)$/i.test(value.trim())
  return Boolean(value)
}

function mergeMeta(base, patch = {}) {
  const next = { ...emptyMeta(), ...base }
  for (const [field, limit] of Object.entries(META_TEXT_LIMITS)) {
    if (patch[field] !== undefined) next[field] = String(patch[field] ?? '').slice(0, limit)
  }
  if (patch.archived !== undefined) next.archived = toBool(patch.archived)
  if (patch.readOnly !== undefined) next.readOnly = toBool(patch.readOnly)
  if (patch.retentionDays !== undefined) {
    if (patch.retentionDays === null) next.retentionDays = null
    else {
      const days = Number(patch.retentionDays)
      if (!Number.isInteger(days) || days < 0 || days > 3650) fail(400, 'retentionDays must be 0-3650 or null')
      next.retentionDays = days || null
    }
  }
  if (patch.autoRecall !== undefined) {
    next.autoRecall = patch.autoRecall === null ? null : toBool(patch.autoRecall)
  }
  if (patch.softLimit !== undefined) {
    if (patch.softLimit === null) next.softLimit = null
    else {
      const limit = Number(patch.softLimit)
      if (!Number.isInteger(limit) || limit < 0) fail(400, 'softLimit must be a non-negative integer or null')
      next.softLimit = limit || null
    }
  }
  if (patch.settings !== undefined) {
    if (!patch.settings || typeof patch.settings !== 'object' || Array.isArray(patch.settings)) fail(400, 'settings must be an object')
    const serialized = JSON.stringify(patch.settings)
    if (serialized.length > 8192) fail(400, 'settings is too large (max 8 KiB)')
    next.settings = patch.settings
  }
  return next
}

function upsertNamespace(db, name, patch, now) {
  const existing = namespaceRow(db, name)
  const meta = mergeMeta(existing ? rowMeta(existing) : emptyMeta(), patch)
  db.prepare(
    `INSERT INTO namespaces
       (name, description, color, archived, read_only, retention_days, auto_recall,
        embedding_provider, soft_limit, created_at, updated_at, settings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description, color = excluded.color, archived = excluded.archived,
       read_only = excluded.read_only, retention_days = excluded.retention_days,
       auto_recall = excluded.auto_recall, embedding_provider = excluded.embedding_provider,
       soft_limit = excluded.soft_limit, updated_at = excluded.updated_at, settings = excluded.settings`,
  ).run(
    name,
    meta.description,
    meta.color,
    meta.archived ? 1 : 0,
    meta.readOnly ? 1 : 0,
    meta.retentionDays,
    meta.autoRecall === null ? null : meta.autoRecall ? 1 : 0,
    meta.embeddingProvider,
    meta.softLimit,
    existing?.created_at ?? now,
    now,
    JSON.stringify(meta.settings),
  )
  return meta
}

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
  const names = namespaceRows(db).map((row) => row.name)
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(REGISTRY_KEY)
  const parsed = row ? parseJson(row.value, []) : []
  if (Array.isArray(parsed)) names.push(...parsed.filter((name) => typeof name === 'string'))
  return [...new Set(names)]
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
  return Boolean(namespaceRow(db, name)) || readRegistry(db).includes(name)
}

function exists(db, name) {
  return hasMemories(db, name) || reserved(db, name)
}

function keyScopes(raw) {
  const parsed = parseJson(raw, [])
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed === 'string') return parsed.split(',').map((name) => name.trim()).filter(Boolean)
  return []
}

function renameApiKeys(db, from, to) {
  let changed = 0
  for (const row of db.prepare('SELECT id, namespaces FROM api_keys').all()) {
    const list = keyScopes(row.namespaces)
    if (list.includes('*') || !list.includes(from)) continue
    const next = [...new Set(list.map((name) => (name === from ? to : name)))]
    db.prepare('UPDATE api_keys SET namespaces = ? WHERE id = ?').run(JSON.stringify(next), row.id)
    changed += 1
  }
  return changed
}

function dropApiKeyScope(db, namespace) {
  let changed = 0
  for (const row of db.prepare('SELECT id, namespaces FROM api_keys').all()) {
    const list = keyScopes(row.namespaces)
    if (list.includes('*') || !list.includes(namespace)) continue
    const next = list.filter((name) => name !== namespace)
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

function zeroEntry(name) {
  return {
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
    hasSettings: false,
    namespaceArchived: false,
    ...emptyMeta(),
  }
}

/** Aggregate per-namespace stats without loading every memory row. */
function aggregate(db, allowed = null) {
  const scopes = Array.isArray(allowed) ? allowed : typeof allowed === 'string' ? allowed.split(',') : allowed
  const scope = scopes && !scopes.includes('*') ? scopes : null
  if (scope && !scope.length) return new Map()
  const where = scope ? `WHERE namespace IN (${scope.map(() => '?').join(',')})` : ''
  const scopeParams = scope ?? []
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
    `SELECT namespace, COUNT(*) AS total, MIN(created_at) AS first_at, MAX(created_at) AS last_at, MAX(updated_at) AS updated_at FROM memories ${where} GROUP BY namespace`,
  ).all(...scopeParams)) {
    const item = entry(row.namespace)
    item.total = num(row.total)
    item.firstAt = row.first_at === null ? null : num(row.first_at)
    item.lastAt = row.last_at === null ? null : num(row.last_at)
    item.updatedAt = row.updated_at === null ? null : num(row.updated_at)
  }
  const statusKey = { pending_delete: 'pendingDelete' }
  for (const row of db.prepare(`SELECT namespace, status, COUNT(*) AS n FROM memories ${where} GROUP BY namespace, status`).all(...scopeParams)) {
    entry(row.namespace)[statusKey[row.status] ?? row.status] = num(row.n)
  }
  for (const row of db.prepare(`SELECT namespace, kind, COUNT(*) AS n FROM memories ${where} GROUP BY namespace, kind`).all(...scopeParams)) {
    const item = entry(row.namespace)
    if (item.byKind[row.kind] !== undefined) item.byKind[row.kind] = num(row.n)
  }
  const conflictScope = scope ? `AND m.namespace IN (${scope.map(() => '?').join(',')})` : ''
  for (const row of db.prepare(
    `SELECT m.namespace AS namespace, COUNT(*) AS n FROM conflicts c JOIN memories m ON m.id = c.memory_a
     WHERE c.status = 'open' ${conflictScope} GROUP BY m.namespace`,
  ).all(...scopeParams)) {
    entry(row.namespace).openConflicts = num(row.n)
  }
  for (const name of readRegistry(db)) {
    if (scope && !scope.includes(name)) continue
    const item = entry(name)
    // "reserved" means the name exists without any memories yet. Once data is
    // written the registry entry is just bookkeeping, not a UI "预留" badge.
    item.reserved = item.total === 0
  }
  return map
}

/**
 * List namespaces visible to the caller.
 * `allowed` is the auth namespace list; `*` means all.
 */
export function listNamespaces(store, { allowed = ['*'] } = {}) {
  const scopes = Array.isArray(allowed) ? allowed : typeof allowed === 'string' ? allowed.split(',') : ['*']
  const all = [...aggregate(store.db, scopes).values()]
  const byName = new Map(all.map((item) => [item.name, item]))
  const scope = scopes && !scopes.includes('*') ? scopes : null
  const tableRows = namespaceRows(store.db)
  const tableNames = new Set(tableRows.map((row) => row.name))
  for (const row of tableRows) {
    if (scope && !scope.includes(row.name)) continue
    let item = byName.get(row.name)
    if (!item) {
      item = zeroEntry(row.name)
      all.push(item)
      byName.set(row.name, item)
    }
    const meta = rowMeta(row)
    // Keep "archived" as the memory-status count for API compatibility; the
    // namespace-level flag lives in namespaceArchived.
    const memoryArchived = item.archived
    Object.assign(item, meta, {
      archived: memoryArchived,
      namespaceArchived: meta.archived,
      hasSettings: true,
      reserved: item.total === 0,
    })
  }
  // Legacy names that only exist in meta.namespace_registry.
  for (const name of readRegistry(store.db)) {
    if (tableNames.has(name)) continue
    if (scope && !scope.includes(name)) continue
    let item = byName.get(name)
    if (!item) {
      item = zeroEntry(name)
      all.push(item)
      byName.set(name, item)
    }
    item.reserved = item.total === 0
  }
  // Always show the configured default, even before its first write.
  if (!byName.has(store.namespace)) all.push(zeroEntry(store.namespace))
  const visible = !scopes || scopes.includes('*') ? all : all.filter((item) => scopes.includes(item.name))
  visible.sort((a, b) => {
    if (a.name === store.namespace) return -1
    if (b.name === store.namespace) return 1
    return b.total - a.total || a.name.localeCompare(b.name)
  })
  // A restricted key must not learn the name of a namespace it cannot read.
  const canSeeDefault = !scopes || scopes.includes('*') || scopes.includes(store.namespace)
  return {
    ok: true,
    default: canSeeDefault ? store.namespace : null,
    protected: canSeeDefault ? store.namespace : null,
    total: visible.length,
    namespaces: visible,
  }
}

/** Reserve a name. Writing the first memory also creates a namespace. */
export function createNamespace(store, name, meta = {}) {
  if (name === undefined || name === null || String(name).trim() === '') fail(400, 'namespace name is required')
  const value = assertNamespace(name)
  if (exists(store.db, value)) {
    const row = namespaceRow(store.db, value)
    return { ok: true, created: false, name: value, message: 'namespace already exists', namespace: row ? rowMeta(row) : null }
  }
  return withTransaction(store.db, () => {
    const namespace = upsertNamespace(store.db, value, meta, store.now())
    writeRegistry(store.db, [...readRegistry(store.db), value])
    store.bump()
    store.invalidateNamespaceCache?.()
    return { ok: true, created: true, name: value, message: 'namespace created', namespace }
  })
}

/** Update description/color/policy fields without renaming the namespace. */
export function updateNamespace(store, name, patch = {}) {
  const value = assertNamespace(name)
  if (!exists(store.db, value)) fail(404, `namespace not found: ${value}`)
  return withTransaction(store.db, () => {
    if (!exists(store.db, value)) fail(404, `namespace not found: ${value}`)
    const namespace = upsertNamespace(store.db, value, patch, store.now())
    writeRegistry(store.db, [...readRegistry(store.db), value])
    store.bump()
    store.invalidateNamespaceCache?.()
    return { ok: true, name: value, namespace }
  })
}

/** Rename a namespace and move all references that must follow it. */
export function renameNamespace(store, from, to, { force = false, backup = true, backupDir, signal, progress, meta = {} } = {}) {
  if (to === undefined || to === null || String(to).trim() === '') fail(400, 'target namespace name is required')
  const source = assertNamespace(from)
  const target = assertNamespace(to)
  if (source === target) fail(400, 'source and target namespace are the same')
  if (source === store.namespace && !force) {
    fail(400, 'refusing to rename the configured default namespace; update the plugin config first or pass force=true')
  }
  if (!exists(store.db, source)) fail(404, `namespace not found: ${source}`)
  if (exists(store.db, target)) fail(409, `target namespace already exists: ${target}`)
  assertNotAborted(signal)
  return withTransaction(store.db, () => {
    const now = store.now()
    // Re-check under the write lock: another request may have created the
    // target (or removed the source) between the optimistic check and BEGIN.
    if (!exists(store.db, source)) fail(404, `namespace not found: ${source}`)
    if (exists(store.db, target)) fail(409, `target namespace already exists: ${target}`)
    // Take the snapshot inside the write transaction so concurrent writes
    // cannot slip in between the backup and the destructive mutation.
    const backupInfo = backup ? createBackup(store, { backupDir, label: `before-rename-${source}` }) : null
    assertNotAborted(signal)
    progress?.(0.2)
    const moved = store.db.prepare('UPDATE memories SET namespace = ?, updated_at = ? WHERE namespace = ?').run(target, now, source)
    assertNotAborted(signal)
    progress?.(0.45)
    const apiKeys = renameApiKeys(store.db, source, target)
    progress?.(0.6)
    const jobs = rewriteJobs(store.db, source, target)
    if (namespaceRow(store.db, source)) {
      store.db.prepare('UPDATE namespaces SET name = ?, updated_at = ? WHERE name = ?').run(target, now, source)
      if (meta && Object.keys(meta).length) upsertNamespace(store.db, target, meta, now)
    } else {
      upsertNamespace(store.db, target, meta, now)
    }
    const registry = [...readRegistry(store.db).filter((name) => name !== source), target]
    writeRegistry(store.db, registry)
    store.bump()
    store.invalidateNamespaceCache?.()
    progress?.(1)
    return {
      ok: true,
      from: source,
      to: target,
      moved: num(moved.changes),
      apiKeys,
      jobs,
      backup: backupInfo ? { name: backupInfo.name, size: backupInfo.size, createdAt: backupInfo.createdAt } : null,
    }
  })
}

function mergeIntoRow(db, source, target, now) {
  const tags = [...new Set([...parseJson(source.tags, []), ...parseJson(target.tags, [])])]
  const entities = [...new Set([...parseJson(source.entities, []), ...parseJson(target.entities, [])])]
  const metadata = { ...parseJson(target.metadata, {}), ...parseJson(source.metadata, {}) }
  const lastAccessAt = Math.max(num(source.last_access_at), num(target.last_access_at)) || null
  // Keep the stronger memory layer: merging a persona fact into a semantic row
  // must not silently downgrade it. Same for confirmed status.
  const kind = (KIND_RANK[source.kind] ?? 0) > (KIND_RANK[target.kind] ?? 0) ? source.kind : target.kind
  const confirmed = num(source.confirmed) || num(target.confirmed) ? 1 : 0
  db.prepare(
    `UPDATE memories SET kind = ?, confirmed = ?, importance = ?, confidence = ?, weight = ?,
       access_count = ?, last_access_at = ?, tags = ?, entities = ?, metadata = ?, updated_at = ? WHERE id = ?`,
  ).run(
    kind,
    confirmed,
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
export function mergeNamespaces(store, from, into, { force = false, backup = true, backupDir, signal, progress } = {}) {
  if (into === undefined || into === null || String(into).trim() === '') fail(400, 'target namespace name is required')
  const source = assertNamespace(from)
  const target = assertNamespace(into)
  if (source === target) fail(400, 'source and target namespace are the same')
  if (source === store.namespace && !force) {
    fail(400, 'refusing to merge the configured default namespace; update the plugin config first or pass force=true')
  }
  if (!exists(store.db, source)) fail(404, `namespace not found: ${source}`)
  assertNotAborted(signal)
  return withTransaction(store.db, () => {
    const now = store.now()
    if (!exists(store.db, source)) fail(404, `namespace not found: ${source}`)
    const backupInfo = backup ? createBackup(store, { backupDir, label: `before-merge-${source}` }) : null
    assertNotAborted(signal)
    progress?.(0.1)
    const sourceRows = store.db.prepare('SELECT * FROM memories WHERE namespace = ?').all(source)
    const targetActive = new Map(
      store.db
        .prepare("SELECT * FROM memories WHERE namespace = ? AND status = 'active'")
        .all(target)
        .map((row) => [row.content_hash, row]),
    )
    let moved = 0
    let deduped = 0
    let index = 0
    for (const row of sourceRows) {
      assertNotAborted(signal)
      index += 1
      progress?.(0.1 + (sourceRows.length ? (index / sourceRows.length) * 0.7 : 0.7))
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
    store.db.prepare('DELETE FROM namespaces WHERE name = ?').run(source)
    upsertNamespace(store.db, target, {}, now)
    writeRegistry(store.db, [...readRegistry(store.db).filter((name) => name !== source), target])
    store.bump()
    store.invalidateNamespaceCache?.()
    progress?.(1)
    return {
      ok: true,
      from: source,
      into: target,
      moved,
      deduped,
      apiKeys,
      jobs,
      backup: backupInfo ? { name: backupInfo.name, size: backupInfo.size, createdAt: backupInfo.createdAt } : null,
    }
  })
}

/**
 * Delete a namespace.
 * Default is a reversible 7-day soft delete (same grace period as a single
 * memory); `hard` permanently removes memories, vectors and non-running jobs.
 * Persona memories require `force` for the permanent path.
 */
export function deleteNamespace(store, name, { hard = false, confirm = false, force = false, backup = true, backupDir, signal, progress } = {}) {
  const value = assertNamespace(name)
  if (value === store.namespace && !force) {
    fail(400, 'refusing to delete the configured default namespace; update the plugin config first or pass force=true')
  }
  if (!exists(store.db, value)) fail(404, `namespace not found: ${value}`)
  if (hard) {
    if (!confirm) fail(400, 'hard delete requires confirm=true')
    assertNotAborted(signal)
    return withTransaction(store.db, () => {
      const now = store.now()
      if (!exists(store.db, value)) fail(404, `namespace not found: ${value}`)
      const backupInfo = backup ? createBackup(store, { backupDir, label: `before-delete-${value}` }) : null
      assertNotAborted(signal)
      progress?.(0.1)
      const rows = store.db.prepare('SELECT id, kind, status FROM memories WHERE namespace = ?').all(value)
      const personas = rows.filter((row) => row.kind === 'persona').length
      if (personas > 0 && !force) fail(409, `namespace contains ${personas} persona memories; pass force=true to delete them`)
      let index = 0
      for (const row of rows) {
        assertNotAborted(signal)
        index += 1
        progress?.(0.1 + (rows.length ? (index / rows.length) * 0.7 : 0.7))
        store.deleteFts(row.id)
        store.deleteVectors(row.id)
        store.db.prepare('DELETE FROM memories WHERE id = ?').run(row.id)
        store.db
          .prepare("UPDATE conflicts SET status = 'dismissed', resolved_at = ? WHERE status = 'open' AND (memory_a = ? OR memory_b = ?)")
          .run(now, row.id, row.id)
      }
      const jobs = deleteJobs(store.db, value, new Set(rows.map((row) => row.id)))
      const apiKeys = dropApiKeyScope(store.db, value)
      store.db.prepare('DELETE FROM namespaces WHERE name = ?').run(value)
      writeRegistry(store.db, readRegistry(store.db).filter((entry) => entry !== value))
      store.bump()
      store.invalidateNamespaceCache?.()
      progress?.(1)
      return {
        ok: true,
        hard: true,
        namespace: value,
        deleted: rows.length,
        personas,
        jobs,
        apiKeys,
        backup: backupInfo ? { name: backupInfo.name, size: backupInfo.size, createdAt: backupInfo.createdAt } : null,
      }
    })
  }
  assertNotAborted(signal)
  return withTransaction(store.db, () => {
    const now = store.now()
    if (!exists(store.db, value)) fail(404, `namespace not found: ${value}`)
    const backupInfo = backup ? createBackup(store, { backupDir, label: `before-delete-${value}` }) : null
    assertNotAborted(signal)
    progress?.(0.1)
    const rows = store.db.prepare('SELECT id, kind, status FROM memories WHERE namespace = ?').all(value)
    const personas = rows.filter((row) => row.kind === 'persona').length
    const purgeAfter = now + PENDING_DELETE_MS
    let pending = 0
    let index = 0
    for (const row of rows) {
      assertNotAborted(signal)
      index += 1
      progress?.(0.1 + (rows.length ? (index / rows.length) * 0.7 : 0.7))
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
    const apiKeys = dropApiKeyScope(store.db, value)
    store.logEvent(null, 'namespace_delete_soft', { namespace: value, memories: rows.length, purgeAfter, apiKeys })
    store.db.prepare('DELETE FROM namespaces WHERE name = ?').run(value)
    writeRegistry(store.db, readRegistry(store.db).filter((entry) => entry !== value))
    store.bump()
    store.invalidateNamespaceCache?.()
    progress?.(1)
    return {
      ok: true,
      hard: false,
      namespace: value,
      pending,
      memories: rows.length,
      personas,
      apiKeys,
      purgeAfter,
      graceDays: DELETE_GRACE_DAYS,
      backup: backupInfo ? { name: backupInfo.name, size: backupInfo.size, createdAt: backupInfo.createdAt } : null,
    }
  })
}
