/**
 * MemoryStore — the hippocampus engine.
 *
 * Layers (CLS): buffer → episodic → semantic → persona.
 * All writes are minimal fact units; duplicates reinforce instead of growing the
 * table, contradictions become pending conflicts instead of overwriting settled
 * knowledge, and replay decays, archives, consolidates and forgets.
 */

import { randomBytes } from 'node:crypto'
import path from 'node:path'
import {
  ARCHIVE_BELOW,
  DEFAULTS,
  DEFAULT_IMPORTANCE,
  DELETE_GRACE_DAYS,
  KIND_LABELS,
  KINDS,
  MAX_IMPORTANCE,
  MIN_IMPORTANCE,
  PENDING_DELETE_BELOW,
  PENDING_DELETE_MS,
  SCHEMA_VERSION,
  STATUS_LABELS,
  VERSION,
} from './constants.js'
import {
  contentHash,
  cleanContent,
  detectConflict,
  indexText,
  hasEpisodicNumberMarker,
  isStrictExpansion,
  normalize,
  similarityTokens,
  summarize,
  tokenSimilarity,
} from './text.js'
import {
  dbSizeBytes,
  getMeta,
  openDatabase,
  openStorageDatabase,
  parseJson,
  rowToMemory,
  setMeta,
  withTransaction,
} from './db.js'
import { effectiveWeight, inferImportance, retrievalScore, buildWhy, weightBreakdown, daysSince } from './scoring.js'
import { defaultDbPath } from './paths.js'

const ACTIVE_STATUSES = ['active', 'conflict']

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const out = []
  for (const raw of tags) {
    const tag = String(raw ?? '').trim().replace(/^#/, '')
    if (!tag) continue
    const normalized = tag.slice(0, 40)
    if (!out.includes(normalized)) out.push(normalized)
    if (out.length >= 16) break
  }
  return out
}

function normalizeEntities(entities) {
  if (!Array.isArray(entities)) return []
  return entities
    .map((entry) => String(entry ?? '').trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 24)
}

export function assertNamespace(namespace) {
  const value = String(namespace ?? DEFAULTS.namespace)
  // "." and ".." would be normalized away by URL parsers, making the namespace
  // unreachable through /api/namespaces/{name}; reject them up front.
  if (value === '.' || value === '..' || !/^[\w.\-:\u4e00-\u9fff]{1,64}$/u.test(value)) {
    throw new Error(`invalid namespace: ${value}`)
  }
  return value
}

function normalizeContent(content) {
  const clean = cleanContent(content)
  if (!clean) throw new Error('content is required')
  if (clean.length > 4000) throw new Error('content is too long (max 4000 chars); store one minimal fact per memory')
  return clean
}

/**
 * @typedef {object} AddInput
 * @property {string} content
 * @property {'buffer'|'episodic'|'semantic'|'persona'} [kind]
 * @property {number} [importance]
 * @property {number} [confidence]
 * @property {string[]} [tags]
 * @property {string[]} [entities]
 * @property {string} [summary]
 * @property {string} [namespace]
 * @property {string} [source]
 * @property {string} [sourceSession]
 * @property {boolean} [confirmed]
 * @property {string} [supersedes]
 * @property {string} [mergeInto]
 * @property {'auto'|'force'|'new'|'merge'|'reject'} [dedupe]
 * @property {Record<string, unknown>} [metadata]
 */

export class MemoryStore {
  /**
   * @param {{ dbPath?: string, storage?: object, db?: object, namespace?: string,
   *   now?: () => number, retrievalLimit?: number }} [options]
   */
  constructor(options = {}) {
    this.namespace = assertNamespace(options.namespace ?? DEFAULTS.namespace)
    this.now = options.now ?? Date.now
    this.retrievalLimit = clamp(toNumber(options.retrievalLimit, DEFAULTS.retrievalLimit), 1, 50)
    if (options.db) {
      this.db = options.db
    } else if (options.storage) {
      this.db = openStorageDatabase(options.storage, { now: this.now, applicationName: 'dsh-hippocampus' })
    } else {
      this.db = openDatabase(options.dbPath ?? defaultDbPath(), { now: this.now })
    }
    this.dbPath = options.dbPath ?? options.storage?.dbPath ?? this.db.displayPath ?? defaultDbPath()
    this.dialect = this.db.dialect ?? 'sqlite'
    this.dataDir = options.storage?.dataDir ?? (this.dialect === 'sqlite' && this.dbPath ? path.dirname(this.dbPath) : undefined)
    this.fts = getMeta(this.db, 'fts_enabled') !== '0'
    this.closed = false
    // Monotonic write counter shared by every process using this database.
    this.changeSeq = Number(getMeta(this.db, 'change_seq') ?? 0) || 0
    this.namespaceCache = new Map()
    this.namespaceCacheAt = 0
  }

  bump() {
    try {
      const row = this.dialect === 'postgres'
        ? this.db.prepare("UPDATE meta SET value = (CAST(value AS BIGINT) + 1)::text WHERE key = 'change_seq' RETURNING value").get()
        : this.db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'change_seq' RETURNING value").get()
      if (row?.value !== undefined) this.changeSeq = Number(row.value)
      else this.changeSeq += 1
    } catch {
      this.changeSeq += 1
    }
    return this.changeSeq
  }

  /** Read the shared revision so caches also expire for writes made by peers. */
  refreshChangeSeq() {
    try {
      const value = Number(getMeta(this.db, 'change_seq') ?? 0) || 0
      if (value > this.changeSeq) this.changeSeq = value
    } catch {
      // keep the local value
    }
    return this.changeSeq
  }

  /** Per-namespace policy (read-only / archived / autoRecall / retention). */
  namespacePolicy(namespace) {
    const now = this.now()
    if (now - this.namespaceCacheAt > 2000) {
      this.namespaceCache.clear()
      this.namespaceCacheAt = now
    }
    if (this.namespaceCache.has(namespace)) return this.namespaceCache.get(namespace)
    let row
    try {
      row = this.db.prepare('SELECT * FROM namespaces WHERE name = ?').get(namespace)
    } catch {
      row = undefined
    }
    const policy = {
      description: row?.description ?? '',
      color: row?.color ?? '',
      archived: Boolean(row?.archived),
      readOnly: Boolean(row?.read_only),
      autoRecall: row?.auto_recall === null || row?.auto_recall === undefined ? null : Boolean(row.auto_recall),
      retentionDays: row?.retention_days === null || row?.retention_days === undefined ? null : Number(row.retention_days),
      embeddingProvider: row?.embedding_provider ?? null,
      softLimit: row?.soft_limit === null || row?.soft_limit === undefined ? null : Number(row.soft_limit),
    }
    this.namespaceCache.set(namespace, policy)
    return policy
  }

  invalidateNamespaceCache() {
    this.namespaceCache.clear()
    this.namespaceCacheAt = 0
  }

  /** Read-only / archived namespaces reject memory mutations. */
  assertWritable(namespace) {
    const policy = this.namespacePolicy(namespace)
    if (!policy.readOnly && !policy.archived) return
    const error = new Error(
      policy.archived ? `namespace ${namespace} is archived (read-only)` : `namespace ${namespace} is read-only`,
    )
    error.status = 403
    throw error
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------------------
  // low level helpers
  // ---------------------------------------------------------------------------

  insertFts(memory) {
    if (!this.fts) return
    const tokens = indexText(`${memory.content} ${(memory.tags ?? []).join(' ')}`)
    if (this.dialect === 'postgres') {
      this.db
        .prepare("INSERT INTO memory_fts (memory_id, tokens) VALUES (?, to_tsvector('simple', ?)) ON CONFLICT (memory_id) DO UPDATE SET tokens = excluded.tokens")
        .run(memory.id, tokens)
      return
    }
    this.db
      .prepare('INSERT INTO memory_fts (memory_id, tokens) VALUES (?, ?)')
      .run(memory.id, tokens)
  }

  deleteFts(memoryId) {
    if (!this.fts) return
    this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId)
  }

  deleteVectors(memoryId) {
    this.db.prepare('DELETE FROM embeddings WHERE memory_id = ?').run(memoryId)
    this.db.prepare('DELETE FROM embedding_index WHERE memory_id = ?').run(memoryId)
  }

  updateFts(memory) {
    if (!this.fts) return
    this.deleteFts(memory.id)
    this.insertFts(memory)
  }

  logEvent(memoryId, action, detail = {}) {
    this.db
      .prepare('INSERT INTO events (memory_id, action, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(memoryId ?? null, action, JSON.stringify(detail), this.now())
  }

  getRow(id) {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
  }

  getMemory(id) {
    return rowToMemory(this.getRow(id))
  }

  recalcWeight(memory) {
    return effectiveWeight(memory, this.now())
  }

  insertRow({
    id,
    kind,
    content,
    summary = '',
    importance = DEFAULT_IMPORTANCE[kind] ?? 3,
    confidence = 0.7,
    accessCount = 0,
    lastAccessAt,
    createdAt,
    updatedAt,
    source = null,
    sourceSession = null,
    namespace = this.namespace,
    tags = [],
    entities = [],
    status = 'active',
    confirmed = false,
    conflictWith = null,
    supersededBy = null,
    consolidatedInto = null,
    purgeAfter = null,
    metadata = {},
  }) {
    const now = this.now()
    const memory = {
      id,
      kind,
      content,
      summary,
      importance,
      confidence,
      weight: effectiveWeight({ kind, importance, lastAccessAt, updatedAt, createdAt }, now),
      accessCount,
      lastAccessAt: lastAccessAt ?? now,
      createdAt: createdAt ?? now,
      updatedAt: updatedAt ?? now,
      source,
      sourceSession,
      namespace,
      tags,
      entities,
      status,
      confirmed,
      conflictWith,
      supersededBy,
      consolidatedInto,
      purgeAfter,
      metadata,
    }
    this.db
      .prepare(
        `INSERT INTO memories (
          id, kind, content, summary, importance, confidence, weight, access_count,
          last_access_at, created_at, updated_at, source, source_session, namespace,
          tags, entities, status, confirmed, conflict_with, superseded_by,
          consolidated_into, purge_after, content_hash, norm_content, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.kind,
        memory.content,
        memory.summary,
        memory.importance,
        memory.confidence,
        memory.weight,
        memory.accessCount,
        memory.lastAccessAt,
        memory.createdAt,
        memory.updatedAt,
        memory.source,
        memory.sourceSession,
        memory.namespace,
        JSON.stringify(memory.tags),
        JSON.stringify(memory.entities),
        memory.status,
        memory.confirmed ? 1 : 0,
        memory.conflictWith,
        memory.supersededBy,
        memory.consolidatedInto,
        memory.purgeAfter,
        contentHash(content),
        normalize(content),
        JSON.stringify(memory.metadata),
      )
    this.insertFts(memory)
    return memory
  }

  /**
   * Candidate rows by lexical overlap. FTS5 first, LIKE fallback for one-char
   * queries or builds without FTS.
   */
  candidates(query, { namespace, statuses = ACTIVE_STATUSES, limit = 250 } = {}) {
    const tokens = similarityTokens(query)
    const results = []
    if (this.fts && tokens.length) {
      const ftsQuery = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ')
      try {
        const rows = this.dialect === 'postgres'
          ? this.db
            .prepare(
              `SELECT m.* FROM memory_fts f
               JOIN memories m ON m.id = f.memory_id
               WHERE f.tokens @@ websearch_to_tsquery('simple', ?)
                 AND m.namespace = ?
                 AND m.status IN (${statuses.map(() => '?').join(',')})
               ORDER BY ts_rank_cd(f.tokens, websearch_to_tsquery('simple', ?)) DESC
               LIMIT ?`,
            )
            .all(ftsQuery, namespace, ...statuses, ftsQuery, limit)
          : this.db
            .prepare(
              `SELECT m.* FROM memory_fts f
               JOIN memories m ON m.id = f.memory_id
               WHERE memory_fts MATCH ?
                 AND m.namespace = ?
                 AND m.status IN (${statuses.map(() => '?').join(',')})
               ORDER BY bm25(memory_fts)
               LIMIT ?`,
            )
            .all(ftsQuery, namespace, ...statuses, limit)
        results.push(...rows)
      } catch {
        // fall through to LIKE
      }
    }
    if (results.length < limit) {
      const seen = new Set(results.map((row) => row.id))
      const needle = normalize(query)
      const likeTerms = [...new Set([needle, ...tokens])].filter((term) => term.length >= 1).slice(0, 8)
      if (likeTerms.length) {
        const clauses = likeTerms.map(() => 'norm_content LIKE ?').join(' OR ')
        const rows = this.db
          .prepare(
            `SELECT * FROM memories
             WHERE namespace = ? AND status IN (${statuses.map(() => '?').join(',')})
               AND (${clauses})
             ORDER BY updated_at DESC
             LIMIT ?`,
          )
          .all(namespace, ...statuses, ...likeTerms.map((term) => `%${term}%`), limit - results.length)
        for (const row of rows) if (!seen.has(row.id)) results.push(row)
      }
    }
    return results.map(rowToMemory)
  }

  findDuplicate(content, namespace) {
    const hash = contentHash(content)
    const row = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE namespace = ? AND content_hash = ? AND status IN ('active', 'conflict', 'archived', 'pending_delete')
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'conflict' THEN 1 WHEN 'pending_delete' THEN 2 ELSE 3 END,
                  updated_at DESC LIMIT 1`,
      )
      .get(namespace, hash)
    return rowToMemory(row)
  }

  findSimilar(content, namespace, limit = 8) {
    const pool = this.candidates(content, { namespace, statuses: ['active', 'conflict'], limit: 120 })
    const newTokens = similarityTokens(content)
    return pool
      .map((memory) => ({ memory, score: tokenSimilarity(newTokens, similarityTokens(memory.content)) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  reinforce(memory, newImportance, newTags, source, newConfidence, confirmed) {
    const tags = [...new Set([...(memory.tags ?? []), ...newTags])].slice(0, 16)
    const importance = Math.max(memory.importance, newImportance)
    const confidence = Math.max(memory.confidence, newConfidence ?? memory.confidence)
    const now = this.now()
    const weight = effectiveWeight({ ...memory, importance, lastAccessAt: now }, now)
    this.db
      .prepare(
        `UPDATE memories SET importance = ?, confidence = ?, weight = ?, tags = ?,
         confirmed = ?, access_count = access_count + 1, last_access_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        importance,
        confidence,
        weight,
        JSON.stringify(tags),
        memory.confirmed || confirmed ? 1 : 0,
        now,
        now,
        memory.id,
      )
    const updated = this.getMemory(memory.id)
    // Tags may have been added; keep the FTS index in sync.
    this.updateFts(updated)
    this.logEvent(memory.id, 'reinforce', { source, importance })
    return updated
  }

  createConflict(memoryA, memoryB, reason, source) {
    const id = makeId('cf')
    this.db
      .prepare(
        `INSERT INTO conflicts (id, memory_a, memory_b, reason, status, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, memoryA.id, memoryB.id, reason, this.now())
    this.logEvent(memoryB.id, 'conflict', { conflictId: id, with: memoryA.id, reason, source })
    return { id, memoryA: memoryA.id, memoryB: memoryB.id, reason, status: 'open', createdAt: this.now() }
  }

  // ---------------------------------------------------------------------------
  // add
  // ---------------------------------------------------------------------------

  /**
   * Encode one minimal fact.
   * @param {AddInput} input
   */
  add(input = {}) {
    const content = normalizeContent(input.content)
    const kind = input.kind ?? 'episodic'
    if (!KINDS.includes(kind)) throw new Error(`invalid kind: ${kind} (expected ${KINDS.join('/')})`)
    const namespace = assertNamespace(input.namespace ?? this.namespace)
    this.assertWritable(namespace)
    const tags = normalizeTags(input.tags)
    const entities = normalizeEntities(input.entities)
    const importance = inferImportance(kind, content, input.importance)
    const confidence = clamp(toNumber(input.confidence, 0.7), 0, 1)
    const dedupe = input.dedupe ?? 'auto'
    if (!['auto', 'force', 'new', 'merge', 'reject'].includes(dedupe)) {
      throw new Error(`invalid dedupe mode: ${dedupe}`)
    }
    const source = input.source ?? 'api'
    const explicitConfirm = input.confirmed === true
    const confirmed = explicitConfirm || kind === 'persona'

    return this.trackWrite(() => withTransaction(this.db, () => {
      // Serialise concurrent adds in one namespace across PostgreSQL instances,
      // otherwise two writers could both miss the same duplicate and insert it.
      if (this.dialect === 'postgres') {
        this.db.prepare("SELECT pg_advisory_xact_lock(hashtext(?)::bigint)").get(`hippocampus:add:${namespace}`)
      }
      // 0. explicit merge target wins over automatic dedupe
      if (input.mergeInto) {
        const target = this.getMemory(input.mergeInto)
        if (!target) throw new Error(`mergeInto target not found: ${input.mergeInto}`)
        if (target.namespace !== namespace) throw new Error('mergeInto target is in a different namespace')
        if (target.status !== 'active') throw new Error('mergeInto target must be an active memory')
        const conflict = detectConflict(target.content, content, { kind })
        if (conflict.conflict) {
          return this.createConflictResult(target, content, kind, importance, confidence, tags, entities, namespace, source, input, conflict.reason)
        }
        const merged = this.mergeInto(target, content, importance, confidence, tags, source)
        return { action: 'merged', memory: merged, message: '已合并到指定记忆。' }
      }

      // 1. exact duplicate -> reinforce
      const exact = this.findDuplicate(content, namespace)
      if (exact && dedupe !== 'force' && dedupe !== 'new') {
        if (dedupe === 'reject') {
          return {
            action: 'duplicate',
            memory: this.publicMemory(exact),
            message: '已存在完全相同的记忆，按 reject 模式未写入。',
          }
        }
        const conflict = detectConflict(exact.content, content, { kind })
        if (conflict.conflict) {
          return this.createConflictResult(exact, content, kind, importance, confidence, tags, entities, namespace, source, input, conflict.reason)
        }
        if (exact.status === 'archived' || exact.status === 'pending_delete') this.restore(exact.id)
        const memory = this.reinforce(this.getMemory(exact.id), importance, tags, source, confidence, confirmed)
        return {
          action: 'reinforced',
          memory,
          message: `与已有记忆一致，已强化权重、合并标签，未新增重复条目（${memory.id}）。`,
        }
      }

      // 2. near-duplicate / expansion -> reinforce, merge, or conflict
      if (dedupe === 'auto' || dedupe === 'merge' || dedupe === 'reject') {
        const similar = this.findSimilar(content, namespace)
        const best = similar[0]
        const distinctEpisode = Boolean(
          best &&
          dedupe === 'auto' &&
          ['episodic', 'buffer'].includes(kind) &&
          normalize(best.memory.content) !== normalize(content) &&
          (hasEpisodicNumberMarker(normalize(best.memory.content)) || hasEpisodicNumberMarker(normalize(content))),
        )
        if (best && best.memory.status === 'conflict') {
          // Do not stack facts on an unconfirmed memory.
          const created = this.insertFact({ content, kind, importance, confidence, tags, entities, namespace, source, input, confirmed })
          return {
            action: 'created',
            memory: created,
            related: [{ id: best.memory.id, status: best.memory.status, similarity: Number(best.score.toFixed(2)) }],
            message: '存在待确认的相似记忆；本条已单独写入，请先处理冲突再固化。',
          }
        }
        // Strict expansions are merged even at high similarity: the new fact
        // contains the old one plus detail, so keeping both would be redundant.
        const expansion =
          best &&
          (isStrictExpansion(best.memory.content, content) || dedupe === 'merge' || input.mergeInto === best.memory.id)
        if (best && expansion && !distinctEpisode && best.score >= DEFAULTS.mergeThreshold && best.memory.status === 'active') {
          if (dedupe === 'reject') {
            return {
              action: 'duplicate',
              memory: best.memory,
              similarity: Number(best.score.toFixed(2)),
              message: '存在可合并的相似记忆，按 reject 模式未写入。',
            }
          }
          const conflict = detectConflict(best.memory.content, content, { kind })
          if (conflict.conflict) {
            return this.createConflictResult(best.memory, content, kind, importance, confidence, tags, entities, namespace, source, input, conflict.reason)
          }
          const merged = this.mergeInto(best.memory, content, importance, confidence, tags, source)
          return {
            action: 'merged',
            memory: merged,
            similarity: Number(best.score.toFixed(2)),
            message: '新信息是既有记忆的补充，已合并为一条并丰富字段。',
          }
        }
        // A contradiction can land far below the duplicate threshold (the same
        // fact with an opposite predicate: "过敏" vs "不过敏"). Check every
        // candidate; detectConflict() itself stays conservative and only fires
        // on strong evidence.
        if (best && best.memory.status === 'active') {
          const conflict = detectConflict(best.memory.content, content, { kind })
          if (conflict.conflict) {
            return this.createConflictResult(best.memory, content, kind, importance, confidence, tags, entities, namespace, source, input, conflict.reason)
          }
        }
        if (best && !distinctEpisode && best.score >= DEFAULTS.dedupeThreshold) {
          const conflict = detectConflict(best.memory.content, content, { kind })
          if (conflict.conflict) {
            return this.createConflictResult(best.memory, content, kind, importance, confidence, tags, entities, namespace, source, input, conflict.reason)
          }
          if (dedupe === 'reject') {
            return {
              action: 'duplicate',
              memory: best.memory,
              message: `已存在相似记忆（相似度 ${(best.score * 100).toFixed(0)}%），按 reject 模式未写入。`,
            }
          }
          const memory = this.reinforce(best.memory, importance, tags, source, confidence, confirmed)
          return {
            action: 'reinforced',
            memory,
            similarity: Number(best.score.toFixed(2)),
            message: '检测到重复记忆，已强化既有条目而非新增。',
          }
        }
      }

      // 3. explicit supersede (settled knowledge replacement must be confirmed)
      if (input.supersedes) {
        const old = this.getMemory(input.supersedes)
        if (!old) throw new Error(`supersedes target not found: ${input.supersedes}`)
        if (old.namespace !== namespace) throw new Error('supersedes target is in a different namespace')
        if (!explicitConfirm && (old.kind === 'semantic' || old.kind === 'persona')) {
          return this.createConflictResult(old, content, kind, importance, confidence, tags, entities, namespace, source, input, '新信息与已固化记忆冲突，尚未确认')
        }
        const memory = this.insertFact({ content, kind, importance, confidence, tags, entities, namespace, source, input, confirmed })
        this.supersede(old.id, memory.id)
        return {
          action: 'superseded',
          memory,
          superseded: old.id,
          message: '旧记忆已标记为被取代（保留审计记录）。',
        }
      }

      // 4. plain create
      const memory = this.insertFact({ content, kind, importance, confidence, tags, entities, namespace, source, input, confirmed })
      const related = this.findSimilar(content, namespace, 3).filter((entry) => entry.memory.id !== memory.id)
      return {
        action: 'created',
        memory,
        ...(related.length
          ? { related: related.map((entry) => ({ id: entry.memory.id, similarity: Number(entry.score.toFixed(2)) })) }
          : {}),
        message: '已写入一条新记忆。',
      }
    }))
  }

  trackWrite(fn) {
    const result = fn()
    this.bump()
    return result
  }

  /**
   * Record one automatic-recall hit (called by the DSH pre-step hook).
   * Kept in the meta table so the panel / memory_stats can show that the
   * plugin is actually being used, without logging every read as an event.
   */
  recordAutoRecall({ count = 0, chars = 0 } = {}) {
    const now = this.now()
    const total = (Number(getMeta(this.db, 'auto_recall_count')) || 0) + 1
    const hits = (Number(getMeta(this.db, 'auto_recall_hits')) || 0) + Math.max(0, Number(count) || 0)
    const lastCount = Math.max(0, Number(count) || 0)
    const lastChars = Math.max(0, Number(chars) || 0)
    withTransaction(this.db, () => {
      setMeta(this.db, 'auto_recall_count', String(total))
      setMeta(this.db, 'auto_recall_hits', String(hits))
      setMeta(this.db, 'auto_recall_last_at', String(now))
      setMeta(this.db, 'auto_recall_last_count', String(lastCount))
      setMeta(this.db, 'auto_recall_last_chars', String(lastChars))
    })
    this.bump()
    return { count: total, hits, lastAt: now, lastCount, lastChars }
  }

  recordAutoCapture({ count = 0, chars = 0 } = {}) {
    const now = this.now()
    const total = (Number(getMeta(this.db, 'auto_capture_count')) || 0) + 1
    const hits = (Number(getMeta(this.db, 'auto_capture_hits')) || 0) + Math.max(0, Number(count) || 0)
    withTransaction(this.db, () => {
      setMeta(this.db, 'auto_capture_count', String(total))
      setMeta(this.db, 'auto_capture_hits', String(hits))
      setMeta(this.db, 'auto_capture_last_at', String(now))
      setMeta(this.db, 'auto_capture_last_count', String(Math.max(0, Number(count) || 0)))
      setMeta(this.db, 'auto_capture_last_chars', String(Math.max(0, Number(chars) || 0)))
    })
    this.bump()
    return { count: total, hits, lastAt: now }
  }

  insertFact({ content, kind, importance, confidence, tags, entities, namespace, source, input, confirmed }) {
    const memory = this.insertRow({
      id: makeId('mem'),
      kind,
      content,
      summary: cleanContent(input.summary) || summarize(content),
      importance,
      confidence,
      source,
      sourceSession: input.sourceSession ?? null,
      namespace,
      tags,
      entities,
      confirmed,
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    })
    this.logEvent(memory.id, 'add', { source, kind })
    return this.publicMemory(memory)
  }

  createConflictResult(existing, content, kind, importance, confidence, tags, entities, namespace, source, input, reason) {
    const memory = this.insertRow({
      id: makeId('mem'),
      kind,
      content,
      summary: cleanContent(input.summary) || summarize(content),
      importance: Math.max(importance, existing.importance),
      confidence: Math.min(confidence, 0.6),
      source,
      sourceSession: input.sourceSession ?? null,
      namespace,
      tags,
      entities,
      status: 'conflict',
      confirmed: false,
      conflictWith: existing.id,
      metadata: { ...(input.metadata ?? {}), conflictReason: reason },
    })
    const conflict = this.createConflict(existing, memory, reason, source)
    this.logEvent(memory.id, 'add_conflict', { with: existing.id, reason })
    return {
      action: 'conflict',
      memory: this.publicMemory(memory),
      existing: this.publicMemory(existing),
      conflict,
      message: `新信息与既有记忆冲突（${reason}），已单独保存为待确认条目，未覆盖旧记忆。请用 memory_update 确认后再固化。`,
    }
  }

  mergeInto(target, content, importance, confidence, tags, source) {
    const mergedContent = cleanContent(target.content).endsWith(content) ? target.content : `${target.content}；补充：${content}`
    if (mergedContent.length > 4000) throw new Error('merged content exceeds 4000 chars; store as a separate memory')
    const mergedTags = [...new Set([...(target.tags ?? []), ...tags])].slice(0, 16)
    const mergedImportance = Math.max(target.importance, importance)
    const now = this.now()
    const weight = effectiveWeight({ ...target, importance: mergedImportance, lastAccessAt: now }, now)
    this.db
      .prepare(
        `UPDATE memories SET content = ?, summary = ?, importance = ?, confidence = ?, weight = ?,
         tags = ?, access_count = access_count + 1, last_access_at = ?, updated_at = ?,
         content_hash = ?, norm_content = ? WHERE id = ?`,
      )
      .run(
        mergedContent,
        summarize(mergedContent),
        mergedImportance,
        Math.max(target.confidence, confidence),
        weight,
        JSON.stringify(mergedTags),
        now,
        now,
        contentHash(mergedContent),
        normalize(mergedContent),
        target.id,
      )
    const updated = rowToMemory(this.getRow(target.id))
    this.updateFts(updated)
    this.logEvent(target.id, 'merge', { source, added: content })
    return this.publicMemory(updated)
  }

  dismissConflicts(memoryId) {
    this.db
      .prepare(
        "UPDATE conflicts SET status = 'dismissed', resolved_at = ? WHERE status = 'open' AND (memory_a = ? OR memory_b = ?)",
      )
      .run(this.now(), memoryId, memoryId)
  }

  supersede(oldId, newId) {
    const now = this.now()
    this.db
      .prepare("UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(newId, now, oldId)
    this.db
      .prepare(
        "UPDATE conflicts SET status = 'resolved_new', resolved_at = ? WHERE status = 'open' AND (memory_a = ? OR memory_b = ?)",
      )
      .run(now, oldId, oldId)
    this.logEvent(oldId, 'supersede', { by: newId })
  }

  // ---------------------------------------------------------------------------
  // search / get
  // ---------------------------------------------------------------------------

  publicMemory(memory, extra = {}) {
    const { weight: weightOverride, ...rest } = extra
    return {
      id: memory.id,
      kind: memory.kind,
      kindLabel: KIND_LABELS[memory.kind] ?? memory.kind,
      content: memory.content,
      summary: memory.summary,
      importance: Number(memory.importance.toFixed(2)),
      confidence: Number(memory.confidence.toFixed(2)),
      weight: Number((weightOverride ?? memory.weight).toFixed(3)),
      accessCount: memory.accessCount,
      lastAccessAt: memory.lastAccessAt,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      tags: memory.tags,
      entities: memory.entities,
      status: memory.status,
      statusLabel: STATUS_LABELS[memory.status] ?? memory.status,
      confirmed: memory.confirmed,
      conflictWith: memory.conflictWith,
      supersededBy: memory.supersededBy,
      source: memory.source,
      sourceSession: memory.sourceSession,
      namespace: memory.namespace,
      consolidatedInto: memory.consolidatedInto,
      purgeAfter: memory.purgeAfter ?? null,
      metadata: memory.metadata,
      ...rest,
    }
  }

  /**
   * Paginated listing for the management UI / REST.
   * @param {{ namespace?: string, kinds?: string[], statuses?: string[], limit?: number,
   *   offset?: number, order?: 'recent'|'created'|'important'|'updated',
   *   includeArchived?: boolean, includePending?: boolean }} [options]
   */
  list(options = {}) {
    const namespace = options.namespace === '*' ? '*' : assertNamespace(options.namespace ?? this.namespace)
    const limit = clamp(toNumber(options.limit, 50), 1, 500)
    const offset = Math.max(0, Math.floor(toNumber(options.offset, 0)))
    const kinds = Array.isArray(options.kinds) && options.kinds.length ? options.kinds.filter((kind) => KINDS.includes(kind)) : null
    let statuses = Array.isArray(options.statuses) && options.statuses.length ? options.statuses : ['active']
    if (options.includeArchived && !statuses.includes('archived')) statuses = [...statuses, 'archived', 'superseded']
    if (options.includePending && !statuses.includes('conflict')) statuses = [...statuses, 'conflict', 'pending_delete']
    const order = options.order ?? 'recent'
    const conditions = [`status IN (${statuses.map(() => '?').join(',')})`]
    const params = [...statuses]
    if (namespace !== '*') {
      conditions.push('namespace = ?')
      params.push(namespace)
    }
    if (kinds) {
      conditions.push(`kind IN (${kinds.map(() => '?').join(',')})`)
      params.push(...kinds)
    }
    const tags = Array.isArray(options.tags) ? options.tags.map((tag) => String(tag).trim()).filter(Boolean) : []
    if (tags.length) {
      // Tags are stored as a JSON array; match any requested exact element,
      // escaping LIKE wildcards so a tag containing % or _ cannot widen it.
      const clauses = []
      for (const tag of tags) {
        const escaped = tag.replace(/[\\%_]/g, '\\$&')
        clauses.push("tags LIKE ? ESCAPE '\\'")
        params.push(`%"${escaped}"%`)
      }
      conditions.push(`(${clauses.join(' OR ')})`)
    }
    const where = conditions.join(' AND ')
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(...params).n
    let orderBy
    if (order === 'important') orderBy = 'importance DESC, updated_at DESC'
    else if (order === 'created') orderBy = 'created_at DESC'
    else if (order === 'updated') orderBy = 'updated_at DESC'
    else orderBy = 'COALESCE(last_access_at, created_at) DESC'
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
    const now = this.now()
    return {
      items: rows.map((row) => {
        const memory = rowToMemory(row)
        return this.publicMemory(memory, { weight: effectiveWeight(memory, now) })
      }),
      total,
      limit,
      offset,
      namespace,
    }
  }

  /** Fetch public memories by id, preserving the input order. */
  getMany(ids) {
    const unique = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))].slice(0, 2000)
    if (!unique.length) return []
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${unique.map(() => '?').join(',')})`)
      .all(...unique)
    const byId = new Map(rows.map((row) => [row.id, rowToMemory(row)]))
    const now = this.now()
    return unique
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((memory) => this.publicMemory(memory, { weight: effectiveWeight(memory, now) }))
  }

  /**
   * Recall the smallest set of relevant memories.
   * @param {string} query
   * @param {{ limit?: number, offset?: number, kinds?: string[], minImportance?: number, namespace?: string,
   *   namespaces?: string[], includeArchived?: boolean, includePending?: boolean,
   *   mode?: 'relevance'|'recent'|'important', explain?: boolean, updateAccess?: boolean,
   *   tags?: string[], extraIds?: string[], vectorScores?: Map<string, number>|Record<string, number>,
   *   vectorWeight?: number }} [options]
   */
  search(query, options = {}) {
    const mode = options.mode ?? 'relevance'
    if (!['relevance', 'recent', 'important'].includes(mode)) throw new Error(`invalid mode: ${mode}`)
    const text = String(query ?? '').trim()
    if (text.length > 1000) throw new Error('query is too long (max 1000 chars)')
    if (!text && mode === 'relevance') {
      throw new Error('query is required for relevance search; use mode=recent/important for browsing')
    }
    const namespace = options.namespace === '*' ? '*' : assertNamespace(options.namespace ?? this.namespace)
    const limit = clamp(toNumber(options.limit, this.retrievalLimit), 1, 50)
    const kinds = Array.isArray(options.kinds) && options.kinds.length ? options.kinds.filter((k) => KINDS.includes(k)) : null
    const minImportance = clamp(toNumber(options.minImportance, 0), 0, MAX_IMPORTANCE)
    const statuses = ['active']
    if (options.includePending) statuses.push('conflict', 'pending_delete')
    if (options.includeArchived) statuses.push('archived', 'superseded')
    const offset = Math.max(0, Math.floor(toNumber(options.offset, 0)))
    const vectorWeight = clamp(toNumber(options.vectorWeight, 0.35), 0, 1)
    const vectorScores =
      options.vectorScores instanceof Map
        ? options.vectorScores
        : new Map(Object.entries(options.vectorScores ?? {}).map(([key, value]) => [key, Number(value)]))
    const allowedNamespaces = Array.isArray(options.namespaces) && options.namespaces.length
      ? new Set(options.namespaces)
      : null

    let rows
    if (mode === 'recent') {
      rows = this.db
        .prepare(
          `SELECT * FROM memories WHERE status IN (${statuses.map(() => '?').join(',')})
           ${namespace === '*' ? '' : 'AND namespace = ?'}
           ORDER BY COALESCE(last_access_at, created_at) DESC LIMIT ?`,
        )
        .all(...statuses, ...(namespace === '*' ? [] : [namespace]), limit * 4)
    } else if (mode === 'important') {
      rows = this.db
        .prepare(
          `SELECT * FROM memories WHERE status IN (${statuses.map(() => '?').join(',')})
           ${namespace === '*' ? '' : 'AND namespace = ?'}
           ORDER BY importance DESC, updated_at DESC LIMIT ?`,
        )
        .all(...statuses, ...(namespace === '*' ? [] : [namespace]), limit * 4)
    } else {
      if (namespace === '*') {
        // Cross-namespace lexical search: gather candidates per namespace.
        const namespaces = this.db.prepare('SELECT DISTINCT namespace FROM memories').all().map((row) => row.namespace)
        rows = []
        for (const ns of namespaces) {
          rows.push(...this.candidates(text, { namespace: ns, statuses, limit: 120 }))
        }
      } else {
        rows = this.candidates(text, { namespace, statuses, limit: 250 })
      }
    }

    const now = this.now()
    let memories = rows.map((row) => (Array.isArray(row.tags) ? row : rowToMemory(row)))

    // Hybrid retrieval: vector-only candidates and the lexical hit list are
    // merged by id before scoring.
    if (Array.isArray(options.extraIds) && options.extraIds.length) {
      const seen = new Set(memories.map((memory) => memory.id))
      const extraIds = options.extraIds.slice(0, 500)
      const extraParams = [...extraIds, ...statuses]
      const extraNamespace = namespace === '*' ? '' : ' AND namespace = ?'
      if (namespace !== '*') extraParams.push(namespace)
      const extraRows = this.db
        .prepare(
          `SELECT * FROM memories WHERE id IN (${extraIds.map(() => '?').join(',')})
           AND status IN (${statuses.map(() => '?').join(',')})${extraNamespace}`,
        )
        .all(...extraParams)
      for (const row of extraRows) {
        const memory = rowToMemory(row)
        if (!seen.has(memory.id)) {
          memories.push(memory)
          seen.add(memory.id)
        }
      }
    }
    const byId = new Map()
    for (const memory of memories) if (!byId.has(memory.id)) byId.set(memory.id, memory)
    memories = [...byId.values()]
      .filter((memory) => !kinds || kinds.includes(memory.kind))
      .filter((memory) => memory.importance >= minImportance)
      .filter((memory) => !allowedNamespaces || allowedNamespaces.has('*') || allowedNamespaces.has(memory.namespace))
      .filter((memory) => !options.tags?.length || options.tags.some((tag) => memory.tags.includes(tag)))

    if (mode === 'relevance') {
      memories = memories
        .map((memory) => {
          const weight = effectiveWeight(memory, now)
          const base = retrievalScore(text, memory, now, weight)
          const vector = vectorScores.get(memory.id)
          const score =
            vector === undefined || !Number.isFinite(vector)
              ? base
              : clamp(base * (1 - vectorWeight) + clamp(vector, 0, 1) * vectorWeight, 0, 1)
          return { memory, weight, score, vector: Number.isFinite(vector) ? vector : undefined }
        })
        .filter((entry) => entry.score >= DEFAULTS.recallMinScore)
        .sort((a, b) => b.score - a.score)
    } else {
      memories = memories
        .map((memory) => {
          const weight = effectiveWeight(memory, now)
          const score = retrievalScore('', memory, now, weight)
          return { memory, weight, score }
        })
        .sort((a, b) =>
          mode === 'recent'
            ? (b.memory.lastAccessAt ?? b.memory.createdAt) - (a.memory.lastAccessAt ?? a.memory.createdAt)
            : b.memory.importance - a.memory.importance,
        )
    }

    const picked = memories.slice(offset, offset + limit)
    const annotated = picked.map((entry) => ({
      entry,
      why:
        options.explain === false
          ? undefined
          : [buildWhy(text, entry.memory, now), entry.vector !== undefined ? `向量相似度 ${(entry.vector * 100).toFixed(0)}%` : null]
              .filter(Boolean)
              .join('；'),
      // Age at recall time, before this access refreshes lastAccessAt.
      ageDays: Number(daysSince(entry.memory.lastAccessAt ?? entry.memory.createdAt, now).toFixed(2)),
    }))

    if (options.updateAccess !== false && picked.length) {
      withTransaction(this.db, () => {
        const stmt = this.db.prepare(
          'UPDATE memories SET access_count = access_count + 1, last_access_at = ?, weight = ? WHERE id = ?',
        )
        for (const entry of picked) {
          entry.memory.accessCount += 1
          entry.memory.lastAccessAt = now
          stmt.run(now, entry.weight, entry.memory.id)
        }
      })
    }

    const result = annotated.map(({ entry, why, ageDays }) =>
      this.publicMemory(entry.memory, {
        weight: entry.weight,
        score: Number(entry.score.toFixed(3)),
        ...(entry.vector !== undefined ? { vectorScore: Number(entry.vector.toFixed(3)) } : {}),
        ageDays,
        ...(why ? { why } : {}),
      }),
    )

    return {
      query: text,
      mode,
      namespace,
      offset,
      count: result.length,
      memories: result,
      ...(result.length === 0 ? { message: '无匹配记忆（不编造记忆）。' } : {}),
    }
  }

  /**
   * Read one memory. Reading a pending-delete memory restores it (the 7-day
   * grace window: any access saves it).
   */
  get(id, options = {}) {
    if (!id) throw new Error('id is required')
    const memory = this.getMemory(id)
    if (!memory) return { found: false, id, message: '记忆不存在' }
    let restored = false
    const policy = this.namespacePolicy(memory.namespace)
    if (memory.status === 'pending_delete' && options.restore !== false && !policy.readOnly && !policy.archived) {
      const now = this.now()
      this.db
        .prepare("UPDATE memories SET status = 'active', purge_after = NULL, last_access_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, id)
      this.logEvent(id, 'restore', {})
      memory.status = 'active'
      memory.purgeAfter = null
      memory.lastAccessAt = now
      restored = true
    }
    if (options.updateAccess !== false) {
      this.db.prepare('UPDATE memories SET access_count = access_count + 1, last_access_at = ? WHERE id = ?').run(this.now(), id)
      memory.accessCount += 1
      memory.lastAccessAt = this.now()
    }
    const conflicts = this.db
      .prepare("SELECT * FROM conflicts WHERE status = 'open' AND (memory_a = ? OR memory_b = ?) ORDER BY created_at DESC")
      .all(id, id)
      .map((row) => ({ ...row }))
    if (restored) this.bump()
    return { found: true, memory: this.publicMemory(memory, { weight: effectiveWeight(memory, this.now()) }), conflicts, restored }
  }

  // ---------------------------------------------------------------------------
  // update / archive / delete
  // ---------------------------------------------------------------------------

  update(id, patch = {}) {
    if (!id) throw new Error('id is required')
    const existing = this.getMemory(id)
    if (!existing) throw new Error(`memory not found: ${id}`)
    this.assertWritable(existing.namespace)
    if (existing.status === 'superseded') throw new Error('superseded memory is read-only; add a new memory instead')

    const next = { ...existing }
    const changed = []
    if (patch.content !== undefined) {
      const content = normalizeContent(patch.content)
      if (content !== existing.content) {
        next.content = content
        next.summary = summarize(content)
        changed.push('content')
      }
    }
    if (patch.kind !== undefined) {
      if (!KINDS.includes(patch.kind)) throw new Error(`invalid kind: ${patch.kind}`)
      if ((patch.kind === 'semantic' || patch.kind === 'persona') && patch.confirmed !== true && !existing.confirmed) {
        throw new Error(`promoting to ${patch.kind} requires confirmed=true (or confirm with memory_update first)`)
      }
      next.kind = patch.kind
      changed.push('kind')
    }
    if (patch.importance !== undefined) {
      next.importance = clamp(toNumber(patch.importance, existing.importance), MIN_IMPORTANCE, MAX_IMPORTANCE)
      changed.push('importance')
    }
    if (patch.confidence !== undefined) {
      next.confidence = clamp(toNumber(patch.confidence, existing.confidence), 0, 1)
      changed.push('confidence')
    }
    if (patch.tags !== undefined) {
      next.tags = normalizeTags(patch.tags)
      changed.push('tags')
    }
    if (patch.entities !== undefined) {
      next.entities = normalizeEntities(patch.entities)
      changed.push('entities')
    }
    if (patch.summary !== undefined) {
      next.summary = cleanContent(patch.summary).slice(0, 500) || summarize(next.content)
      changed.push('summary')
    }
    if (patch.confirmed !== undefined) {
      next.confirmed = Boolean(patch.confirmed)
      changed.push('confirmed')
    }
    if (patch.metadata !== undefined && patch.metadata && typeof patch.metadata === 'object') {
      next.metadata = { ...next.metadata, ...patch.metadata }
      changed.push('metadata')
    }
    if (patch.status !== undefined) {
      if (!['active', 'archived', 'conflict', 'pending_delete'].includes(patch.status)) {
        throw new Error(`invalid status transition: ${patch.status}`)
      }
      if (patch.status === 'pending_delete' && next.kind === 'persona') {
        throw new Error('persona memories can only be deleted through memory_delete with force=true')
      }
      next.status = patch.status
      changed.push('status')
    }

    // Conflict resolution: confirm the new fact and retire the old one.
    if (patch.supersede) {
      if (patch.status && patch.status !== 'active') {
        throw new Error('supersede is only valid when activating the new memory (status=active)')
      }
      const old = this.getMemory(patch.supersede)
      if (!old) throw new Error(`supersede target not found: ${patch.supersede}`)
      if (old.namespace !== next.namespace) throw new Error('supersede target is in a different namespace')
      if (patch.supersede === id) throw new Error('a memory cannot supersede itself')
      if (!next.confirmed) throw new Error('resolving a conflict requires confirmed=true')
      next.status = 'active'
      next.conflictWith = null
      changed.push('conflict')
    }

    if (existing.status === 'conflict' && next.status === 'active' && !next.confirmed) {
      throw new Error('resolving a conflict requires confirmed=true')
    }
    // Confirming a conflict without naming the counterpart still retires the
    // old fact: the user accepted the new one, and two active contradictions
    // must not survive.
    const autoSupersede =
      existing.status === 'conflict' &&
      next.status === 'active' &&
      next.confirmed &&
      !patch.supersede &&
      existing.conflictWith
        ? existing.conflictWith
        : null
    if (!changed.length) return { updated: false, memory: this.publicMemory(existing), message: '没有需要更新的字段' }

    const now = this.now()
    const weight = effectiveWeight({ ...next, lastAccessAt: now }, now)
    withTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE memories SET content = ?, summary = ?, kind = ?, importance = ?, confidence = ?,
           weight = ?, tags = ?, entities = ?, status = ?, confirmed = ?, conflict_with = ?,
           purge_after = ?, updated_at = ?, content_hash = ?, norm_content = ?, metadata = ? WHERE id = ?`,
        )
        .run(
          next.content,
          next.summary,
          next.kind,
          next.importance,
          next.confidence,
          weight,
          JSON.stringify(next.tags),
          JSON.stringify(next.entities),
          next.status,
          next.confirmed ? 1 : 0,
          next.conflictWith ?? null,
          next.status === 'pending_delete' ? (next.purgeAfter ?? now + PENDING_DELETE_MS) : null,
          now,
          contentHash(next.content),
          normalize(next.content),
          JSON.stringify(next.metadata ?? {}),
          id,
        )
      const updated = rowToMemory(this.getRow(id))
      this.updateFts(updated)
      if (patch.supersede) this.supersede(patch.supersede, id)
      else if (autoSupersede) this.supersede(autoSupersede, id)
      if (next.status === 'active' && next.confirmed && existing.status === 'conflict') {
        this.db
          .prepare("UPDATE conflicts SET status = 'resolved_new', resolved_at = ? WHERE status = 'open' AND (memory_a = ? OR memory_b = ?)")
          .run(now, id, id)
      } else if ((next.status === 'archived' || next.status === 'pending_delete') && existing.status === 'conflict') {
        this.dismissConflicts(id)
      }
      this.logEvent(id, 'update', { fields: changed, source: patch.source ?? 'api' })
    })
    this.bump()
    return { updated: true, memory: this.publicMemory(this.getMemory(id)), changed, message: '记忆已更新。' }
  }

  archive(id, options = {}) {
    const existing = this.getMemory(id)
    if (!existing) throw new Error(`memory not found: ${id}`)
    this.assertWritable(existing.namespace)
    if (existing.status === 'archived') return { archived: false, memory: this.publicMemory(existing), message: '已经是归档状态' }
    const now = this.now()
    this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(now, id)
    if (existing.status === 'conflict') this.dismissConflicts(id)
    this.logEvent(id, 'archive', { reason: options.reason ?? null })
    this.bump()
    return { archived: true, memory: this.publicMemory(this.getMemory(id)), message: '已归档（默认检索不再返回，可恢复）。' }
  }

  remove(id, options = {}) {
    const existing = this.getMemory(id)
    if (!existing) return { removed: false, id, message: '记忆不存在' }
    this.assertWritable(existing.namespace)
    if (existing.kind === 'persona' && !options.force) {
      throw new Error('persona memories require force=true to delete; archive instead if unsure')
    }
    if (options.hard) {
      if (!options.confirm) {
        throw new Error('hard delete requires confirm=true; without it the memory is soft-deleted with a 7-day grace period')
      }
      return withTransaction(this.db, () => {
        this.deleteFts(id)
        this.deleteVectors(id)
        this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
        this.db
          .prepare("UPDATE conflicts SET status = 'dismissed', resolved_at = ? WHERE status = 'open' AND (memory_a = ? OR memory_b = ?)")
          .run(this.now(), id, id)
        this.logEvent(id, 'delete_hard', {})
        this.bump()
        return { removed: true, hard: true, id, message: '记忆已永久移除（事件日志保留审计）。' }
      })
    }
    if (existing.status === 'pending_delete') {
      this.bump()
      return {
        removed: true,
        hard: false,
        id,
        purgeAfter: existing.purgeAfter,
        message: `已在待删除列表，将于 ${new Date(existing.purgeAfter).toISOString()} 后永久移除；期间访问可恢复。`,
      }
    }
    const purgeAfter = this.now() + PENDING_DELETE_MS
    this.db
      .prepare("UPDATE memories SET status = 'pending_delete', purge_after = ?, updated_at = ? WHERE id = ?")
      .run(purgeAfter, this.now(), id)
    if (existing.status === 'conflict') this.dismissConflicts(id)
    this.logEvent(id, 'delete_soft', { purgeAfter })
    this.bump()
    return {
      removed: true,
      hard: false,
      id,
      purgeAfter,
      graceDays: DELETE_GRACE_DAYS,
      message: `已进入待删除列表，保留 ${DELETE_GRACE_DAYS} 天冷静期；期间访问会自动恢复，到期由回放永久移除。`,
    }
  }

  // ---------------------------------------------------------------------------
  // replay / consolidation / forgetting
  // ---------------------------------------------------------------------------

  /**
   * Sleep-like replay: decay, archive, forget, consolidate similar episodes,
   * and report unresolved conflicts.
   * @param {{ dryRun?: boolean, namespace?: string, force?: boolean }} [options]
   */
  /**
   * Replay with a cross-process lease. Without it, several horizontally scaled
   * API/DSH processes could consolidate the same episodes into duplicate
   * semantic memories at the same time.
   */
  replay(options = {}) {
    if (options.dryRun) return this._replay(options)
    return this.withMaintenanceLease('replay', 30 * 60_000, () => this._replay(options))
  }

  /**
   * Acquire a named lease through one atomic upsert. Expired leases can be
   * taken over; an active lease held by another process returns `{skipped}`.
   */
  withMaintenanceLease(name, ttlMs, fn) {
    const owner = makeId(`lease_${String(name).replace(/[^a-z0-9_-]/gi, '_')}`)
    const now = this.now()
    let acquired = false
    try {
      const row = this.db
        .prepare(
          `INSERT INTO leases (name, owner, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
           WHERE leases.expires_at < ? OR leases.owner = ?
           RETURNING owner`,
        )
        .get(name, owner, now + ttlMs, now, owner)
      acquired = row?.owner === owner
    } catch {
      // Older SQLite files may not have the leases table yet; openDatabase adds
      // it on the next start. Run the maintenance task without a lease rather
      // than making replay permanently unavailable.
      acquired = true
    }
    if (!acquired) {
      return { ok: true, skipped: true, reason: `另一进程正在执行 ${name} 维护任务`, name }
    }
    try {
      return fn()
    } finally {
      try {
        this.db.prepare('UPDATE leases SET expires_at = 0 WHERE name = ? AND owner = ?').run(name, owner)
      } catch {
        // lease will expire on its own
      }
    }
  }

  _replay(options = {}) {
    const dryRun = Boolean(options.dryRun)
    const namespace = options.namespace === '*' ? '*' : assertNamespace(options.namespace ?? this.namespace)
    const now = this.now()
    const rows = this.db
      .prepare(`SELECT * FROM memories ${namespace === '*' ? '' : 'WHERE namespace = ?'}`)
      .all(...(namespace === '*' ? [] : [namespace]))
      .map(rowToMemory)

    const actions = { archived: [], pendingDelete: [], purged: [], consolidated: [] }
    let conflictsOpen = 0

    const apply = (fn) => {
      if (!dryRun) fn()
    }
    const policyCache = new Map()
    const policyFor = (namespace) => {
      if (!policyCache.has(namespace)) policyCache.set(namespace, this.namespacePolicy(namespace))
      return policyCache.get(namespace)
    }

    for (const memory of rows) {
      if (memory.status !== 'active' && memory.status !== 'archived') continue
      const policy = policyFor(memory.namespace)
      if (policy.readOnly || policy.archived) continue
      // Per-namespace retention: older active memories are archived (recoverable).
      if (
        memory.status === 'active' &&
        policy.retentionDays > 0 &&
        daysSince(memory.createdAt, now) > policy.retentionDays
      ) {
        actions.archived.push({ id: memory.id, kind: memory.kind, weight: 0, reason: 'retention' })
        apply(() => {
          this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(now, memory.id)
          this.logEvent(memory.id, 'replay_retention', { retentionDays: policy.retentionDays })
        })
        continue
      }
      const weight = effectiveWeight(memory, now)
      const staleDays = daysSince(memory.lastAccessAt ?? memory.updatedAt, now)

      // 1. near-worthless traces go to the 7-day pending-delete list first;
      //    otherwise they would be archived and never become eligible again.
      //    Archived junk can still graduate to deletion.
      const deleteThreshold = PENDING_DELETE_BELOW[memory.kind] ?? 0
      if (deleteThreshold > 0 && weight < deleteThreshold && memory.confidence < 0.6 && staleDays > 60) {
        actions.pendingDelete.push({ id: memory.id, weight: Number(weight.toFixed(3)) })
        apply(() => {
          this.db
            .prepare("UPDATE memories SET status = 'pending_delete', purge_after = ?, updated_at = ? WHERE id = ?")
            .run(now + PENDING_DELETE_MS, now, memory.id)
          this.logEvent(memory.id, 'replay_pending_delete', { weight })
        })
        continue
      }

      // 2. archive stale low-weight buffer/episodic traces (active only)
      const archiveThreshold = ARCHIVE_BELOW[memory.kind] ?? 0
      const archiveAge = memory.kind === 'buffer' ? 3 : 30
      if (memory.status === 'active' && archiveThreshold > 0 && weight < archiveThreshold && staleDays > archiveAge) {
        actions.archived.push({ id: memory.id, kind: memory.kind, weight: Number(weight.toFixed(3)) })
        apply(() => {
          this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(now, memory.id)
          this.logEvent(memory.id, 'replay_archive', { weight })
        })
      }
    }

    // 3. purge expired pending-delete rows
    for (const memory of rows) {
      if (memory.status !== 'pending_delete') continue
      const purgeAfter = memory.purgeAfter ?? (memory.updatedAt + PENDING_DELETE_MS)
      if (purgeAfter <= now) {
        actions.purged.push(memory.id)
        apply(() =>
          withTransaction(this.db, () => {
            this.deleteFts(memory.id)
            this.deleteVectors(memory.id)
            this.db.prepare('DELETE FROM memories WHERE id = ?').run(memory.id)
            this.logEvent(memory.id, 'replay_purge', {})
          }),
        )
      }
    }

    // 4. consolidate similar episodic memories into semantic knowledge
    const archivedIds = new Set(actions.archived.map((entry) => entry.id))
    const pendingIds = new Set(actions.pendingDelete.map((entry) => entry.id))
    const candidates = rows.filter(
      (memory) =>
        memory.status === 'active' &&
        memory.kind === 'episodic' &&
        !memory.consolidatedInto &&
        !archivedIds.has(memory.id) &&
        !pendingIds.has(memory.id) &&
        !policyFor(memory.namespace).readOnly &&
        !policyFor(memory.namespace).archived &&
        daysSince(memory.createdAt, now) >= DEFAULTS.replayMinAgeDays,
    )
    // Never merge episodes across namespaces: the synthesized semantic memory
    // must stay in the namespace where the episodes live.
    const candidatesByNamespace = new Map()
    for (const memory of candidates) {
      const bucket = candidatesByNamespace.get(memory.namespace) ?? []
      bucket.push(memory)
      candidatesByNamespace.set(memory.namespace, bucket)
    }
    const clusters = []
    for (const bucket of candidatesByNamespace.values()) {
      clusters.push(...clusterEpisodes(bucket, DEFAULTS.replayMinCluster))
    }
    for (const cluster of clusters) {
      const signature = contentHash(cluster.map((memory) => memory.id).sort().join('|')).slice(0, 24)
      const duplicate = this.db
        .prepare("SELECT id FROM memories WHERE kind = 'semantic' AND metadata LIKE ? LIMIT 1")
        .get(`%${signature}%`)
      if (duplicate) continue
      const synthesis = synthesizeCluster(cluster, now)
      actions.consolidated.push({ signature, members: cluster.map((m) => m.id), content: synthesis.content })
      apply(() =>
        withTransaction(this.db, () => {
          const semantic = this.insertRow({
            id: makeId('mem'),
            kind: 'semantic',
            content: synthesis.content,
            summary: summarize(synthesis.content),
            importance: synthesis.importance,
            confidence: 0.55,
            source: 'replay',
            namespace: cluster[0].namespace,
            tags: synthesis.tags,
            entities: [],
            status: 'active',
            confirmed: false,
            metadata: {
              replay: true,
              signature,
              consolidatedFrom: cluster.map((m) => m.id),
              consolidatedAt: now,
            },
          })
          this.logEvent(semantic.id, 'replay_consolidate', { members: cluster.map((m) => m.id) })
          for (const member of cluster) {
            const metadata = { ...(member.metadata ?? {}), consolidatedInto: semantic.id }
            this.db
              .prepare('UPDATE memories SET consolidated_into = ?, metadata = ?, updated_at = ? WHERE id = ?')
              .run(semantic.id, JSON.stringify(metadata), now, member.id)
            this.logEvent(member.id, 'replay_member', { consolidatedInto: semantic.id })
          }
        }),
      )
    }

    conflictsOpen = this.db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'open'").get().n
    if (!dryRun) {
      // Keep the audit trail useful without letting it grow forever.
      this.db.prepare('DELETE FROM events WHERE created_at < ?').run(now - 365 * 86_400_000)
      setMeta(this.db, 'last_replay_at', String(now))
      setMeta(this.db, 'schema_version', String(SCHEMA_VERSION))
      this.bump()
    }

    return {
      ok: true,
      dryRun,
      namespace,
      at: now,
      archived: actions.archived.length,
      pendingDelete: actions.pendingDelete.length,
      purged: actions.purged.length,
      consolidated: actions.consolidated.length,
      conflictsOpen,
      details: actions,
      message: dryRun ? '演练完成，未写入任何改动。' : '回放完成：已衰减、归档、清理并尝试巩固。',
    }
  }

  // ---------------------------------------------------------------------------
  // stats / export / import
  // ---------------------------------------------------------------------------

  stats(options = {}) {
    const now = this.now()
    const namespaces = Array.isArray(options.namespaces) && options.namespaces.length && !options.namespaces.includes('*')
      ? options.namespaces
      : null
    const rows = (namespaces
      ? this.db.prepare(`SELECT * FROM memories WHERE namespace IN (${namespaces.map(() => '?').join(',')})`).all(...namespaces)
      : this.db.prepare('SELECT * FROM memories').all()
    ).map(rowToMemory)
    const byKind = {}
    const byStatus = {}
    const byNamespace = {}
    const tags = new Map()
    for (const memory of rows) {
      byKind[memory.kind] = (byKind[memory.kind] ?? 0) + 1
      byStatus[memory.status] = (byStatus[memory.status] ?? 0) + 1
      byNamespace[memory.namespace] = (byNamespace[memory.namespace] ?? 0) + 1
      for (const tag of memory.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1)
    }
    const active = rows.filter((memory) => memory.status === 'active')
    // Avoid Math.min(...arr): spreading a large row set exceeds V8's argument
    // limit and would throw RangeError on big banks.
    let oldestAt = null
    let newestAt = null
    for (const memory of rows) {
      if (oldestAt === null || memory.createdAt < oldestAt) oldestAt = memory.createdAt
      if (newestAt === null || memory.createdAt > newestAt) newestAt = memory.createdAt
    }
    // Scope the open-conflict count with the same namespace filter as the rows;
    // otherwise restricted callers could infer activity in other spaces.
    const conflictRow = namespaces
      ? this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM conflicts c JOIN memories m ON m.id = c.memory_a
           WHERE c.status = 'open' AND m.namespace IN (${namespaces.map(() => '?').join(',')})`,
        )
        .get(...namespaces)
      : this.db.prepare("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'open'").get()
    const conflicts = Number(conflictRow?.n ?? 0)
    return {
      ok: true,
      version: VERSION,
      schemaVersion: SCHEMA_VERSION,
      dbPath: this.dbPath,
      dbSizeBytes: this.dialect === 'postgres' ? this.db.sizeBytes() : dbSizeBytes(this.dbPath),
      namespace: this.namespace,
      totals: {
        all: rows.length,
        active: active.length,
        archived: byStatus.archived ?? 0,
        pendingDelete: byStatus.pending_delete ?? 0,
        conflict: byStatus.conflict ?? 0,
        superseded: byStatus.superseded ?? 0,
      },
      byKind,
      byStatus,
      byNamespace,
      openConflicts: conflicts,
      topTags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, count]) => ({ tag, count })),
      weightByKind: weightBreakdown(active, now),
      lastReplayAt: Number(getMeta(this.db, 'last_replay_at') ?? 0) || null,
      autoRecall: {
        count: Number(getMeta(this.db, 'auto_recall_count') ?? 0) || 0,
        hits: Number(getMeta(this.db, 'auto_recall_hits') ?? 0) || 0,
        lastAt: Number(getMeta(this.db, 'auto_recall_last_at') ?? 0) || null,
        lastCount: Number(getMeta(this.db, 'auto_recall_last_count') ?? 0) || 0,
        lastChars: Number(getMeta(this.db, 'auto_recall_last_chars') ?? 0) || 0,
      },
      autoCapture: {
        count: Number(getMeta(this.db, 'auto_capture_count') ?? 0) || 0,
        hits: Number(getMeta(this.db, 'auto_capture_hits') ?? 0) || 0,
        lastAt: Number(getMeta(this.db, 'auto_capture_last_at') ?? 0) || null,
        lastCount: Number(getMeta(this.db, 'auto_capture_last_count') ?? 0) || 0,
        lastChars: Number(getMeta(this.db, 'auto_capture_last_chars') ?? 0) || 0,
      },
      createdAt: Number(getMeta(this.db, 'created_at') ?? 0) || null,
      oldestAt,
      newestAt,
    }
  }

  listConflicts(status = 'open') {
    const rows = this.db
      .prepare('SELECT * FROM conflicts WHERE (? = \'all\' OR status = ?) ORDER BY created_at DESC LIMIT 100')
      .all(status, status)
    return rows.map((row) => {
      const a = this.getMemory(row.memory_a)
      const b = this.getMemory(row.memory_b)
      return {
        id: row.id,
        status: row.status,
        reason: row.reason,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        a: a ? { id: a.id, kind: a.kind, content: a.content, importance: a.importance, namespace: a.namespace } : null,
        b: b ? { id: b.id, kind: b.kind, content: b.content, importance: b.importance, namespace: b.namespace } : null,
      }
    })
  }

  exportAll(namespace) {
    const ns = namespace === '*' ? '*' : namespace ?? this.namespace
    const memories = this.db
      .prepare(`SELECT * FROM memories ${ns === '*' ? '' : 'WHERE namespace = ?'} ORDER BY created_at ASC`)
      .all(...(ns === '*' ? [] : [ns]))
      .map(rowToMemory)
    const conflicts = this.db.prepare('SELECT * FROM conflicts ORDER BY created_at ASC').all()
    let namespaces = []
    let namespaceRegistry = []
    try {
      namespaces = this.db
        .prepare(`SELECT * FROM namespaces ${ns === '*' ? '' : 'WHERE name = ?'} ORDER BY name`)
        .all(...(ns === '*' ? [] : [ns]))
      namespaceRegistry = parseJson(getMeta(this.db, 'namespace_registry'), [])
    } catch {
      // old databases before schema v4
    }
    return {
      format: 'hippocampus-memory',
      version: SCHEMA_VERSION,
      appVersion: VERSION,
      exportedAt: this.now(),
      namespace: ns,
      memories,
      conflicts,
      namespaces,
      namespaceRegistry,
    }
  }

  /** Import rows only; the caller owns the transaction. */
  _importRows(snapshot, options = {}) {
    const items = Array.isArray(snapshot.memories) ? snapshot.memories : []
    let imported = 0
    let skipped = 0
    if (this.dialect === 'postgres') {
      this.db.prepare("SELECT pg_advisory_xact_lock(hashtext('hippocampus:import')::bigint)").get()
    }
    for (const item of items) {
        const content = normalizeContent(item.content)
        const namespace = assertNamespace(item.namespace ?? this.namespace)
        if (!options.ignorePolicies) this.assertWritable(namespace)
        if (options.skipExisting !== false && this.findDuplicate(content, namespace)) {
          skipped += 1
          continue
        }
        let id = typeof item.id === 'string' && !this.getRow(item.id) ? item.id : makeId('mem')
        this.insertRow({
          id,
          kind: KINDS.includes(item.kind) ? item.kind : 'episodic',
          content,
          summary: cleanContent(item.summary) || summarize(content),
          importance: clamp(toNumber(item.importance, DEFAULT_IMPORTANCE.episodic), MIN_IMPORTANCE, MAX_IMPORTANCE),
          confidence: clamp(toNumber(item.confidence, 0.7), 0, 1),
          accessCount: Math.max(0, Math.floor(toNumber(item.accessCount, 0))),
          lastAccessAt: item.lastAccessAt ?? null,
          createdAt: item.createdAt ?? this.now(),
          updatedAt: item.updatedAt ?? this.now(),
          source: item.source ?? 'import',
          sourceSession: item.sourceSession ?? null,
          namespace,
          tags: normalizeTags(item.tags),
          entities: normalizeEntities(item.entities),
          status: ['active', 'conflict', 'archived', 'pending_delete', 'superseded'].includes(item.status) ? item.status : 'active',
          confirmed: Boolean(item.confirmed),
          conflictWith: item.conflictWith ?? null,
          supersededBy: item.supersededBy ?? null,
          consolidatedInto: item.consolidatedInto ?? null,
          purgeAfter: item.purgeAfter ?? null,
          metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
        })
        imported += 1
    }
    for (const conflict of Array.isArray(snapshot.conflicts) ? snapshot.conflicts : []) {
        if (!conflict?.id || !conflict.memory_a || !conflict.memory_b) continue
        if (!this.getRow(conflict.memory_a) || !this.getRow(conflict.memory_b)) continue
        this.db
          .prepare(
            this.dialect === 'postgres'
              ? `INSERT INTO conflicts (id, memory_a, memory_b, reason, status, created_at, resolved_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`
              : `INSERT OR IGNORE INTO conflicts (id, memory_a, memory_b, reason, status, created_at, resolved_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            conflict.id,
            conflict.memory_a,
            conflict.memory_b,
            String(conflict.reason ?? 'imported conflict'),
            conflict.status ?? 'open',
            conflict.created_at ?? this.now(),
            conflict.resolved_at ?? null,
          )
    }
    return { imported, skipped, total: items.length }
  }

  importAll(snapshot, options = {}) {
    if (!snapshot || snapshot.format !== 'hippocampus-memory') throw new Error('not a hippocampus-memory export')
    if (Number(snapshot.version) > SCHEMA_VERSION) throw new Error('export is newer than this build')
    let result
    withTransaction(this.db, () => {
      result = this._importRows(snapshot, options)
    })
    this.bump()
    return { ok: true, ...result }
  }

  /**
   * Replace the entire memory bank from a snapshot (used by backup restore).
   * Auth users/keys/audit are intentionally untouched; events are rebuilt empty.
   */
  restoreAll(snapshot, options = {}) {
    if (!snapshot || snapshot.format !== 'hippocampus-memory') throw new Error('not a hippocampus-memory export')
    if (Number(snapshot.version) > SCHEMA_VERSION) throw new Error('export is newer than this build')
    if (!Array.isArray(snapshot.memories)) throw new Error('backup has no memories array; refusing to replace data')
    let result
    withTransaction(this.db, () => {
      for (const table of ['memory_fts', 'embeddings', 'embedding_index', 'conflicts', 'events', 'leases', 'memories']) {
        try {
          this.db.prepare(`DELETE FROM ${table}`).run()
        } catch {
          // memory_fts is absent when FTS5 is unavailable
        }
      }
      if (Array.isArray(snapshot.namespaces)) {
        this.db.prepare('DELETE FROM namespaces').run()
        const insert = this.db.prepare(
          `INSERT INTO namespaces
             (name, description, color, archived, read_only, retention_days, auto_recall,
              embedding_provider, soft_limit, created_at, updated_at, settings)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO NOTHING`,
        )
        for (const row of snapshot.namespaces) {
          if (!row || typeof row.name !== 'string') continue
          let name
          try {
            name = assertNamespace(row.name)
          } catch {
            continue
          }
          const settings = typeof row.settings === 'string' ? row.settings : JSON.stringify(row.settings ?? {})
          const archived = row.archived ?? row.archivedFlag
          const readOnly = row.read_only ?? row.readOnly
          const autoRecall = row.auto_recall ?? row.autoRecall
          insert.run(
            name,
            row.description ?? '',
            row.color ?? '',
            Number(archived) ? 1 : 0,
            Number(readOnly) ? 1 : 0,
            row.retention_days ?? row.retentionDays ?? null,
            autoRecall === null || autoRecall === undefined ? null : Number(autoRecall) ? 1 : 0,
            row.embedding_provider ?? row.embeddingProvider ?? null,
            row.soft_limit ?? row.softLimit ?? null,
            row.created_at ?? row.createdAt ?? this.now(),
            row.updated_at ?? row.updatedAt ?? this.now(),
            settings,
          )
        }
      }
      const registry = Array.isArray(snapshot.namespaceRegistry)
        ? snapshot.namespaceRegistry
        : (Array.isArray(snapshot.namespaces) ? snapshot.namespaces.map((row) => row.name) : null)
      if (Array.isArray(registry)) {
        const clean = []
        for (const name of registry) {
          try {
            clean.push(assertNamespace(name))
          } catch {
            // ignore malformed names from an untrusted snapshot
          }
        }
        this.db
          .prepare("INSERT INTO meta (key, value) VALUES ('namespace_registry', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify([...new Set(clean)].sort()))
      }
      result = this._importRows(snapshot, { ...options, skipExisting: false, ignorePolicies: true })
    })
    this.invalidateNamespaceCache()
    this.bump()
    return { ok: true, ...result, namespaces: Array.isArray(snapshot.namespaces) ? snapshot.namespaces.length : 0 }
  }

  restore(id) {
    const memory = this.getMemory(id)
    if (!memory) throw new Error(`memory not found: ${id}`)
    this.assertWritable(memory.namespace)
    if (memory.status !== 'pending_delete' && memory.status !== 'archived') {
      return { restored: false, memory: this.publicMemory(memory), message: '当前状态无需恢复' }
    }
    const now = this.now()
    this.db
      .prepare("UPDATE memories SET status = 'active', purge_after = NULL, last_access_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id)
    this.logEvent(id, 'restore', { from: memory.status })
    this.bump()
    return { restored: true, memory: this.publicMemory(this.getMemory(id)), message: '已恢复为有效记忆。' }
  }
}

/**
 * Greedy clustering of episodic memories by token similarity or shared tags.
 * @param {ReturnType<typeof rowToMemory>[]} memories
 * @param {number} minSize
 */
export function clusterEpisodes(memories, minSize = 3) {
  const remaining = new Set(memories.map((memory) => memory.id))
  const byId = new Map(memories.map((memory) => [memory.id, memory]))
  const clusters = []
  for (const seed of memories) {
    if (!remaining.has(seed.id)) continue
    const cluster = [seed]
    remaining.delete(seed.id)
    const seedTokens = similarityTokens(seed.content)
    for (const other of memories) {
      if (!remaining.has(other.id)) continue
      const sim = tokenSimilarity(seedTokens, similarityTokens(other.content))
      const sharedTags = seed.tags.filter((tag) => other.tags.includes(tag)).length
      // Two shared explicit tags are a strong topical signal; one shared tag
      // still needs some lexical overlap to avoid merging unrelated events.
      if (sim >= 0.5 || (sharedTags >= 2 && sim >= 0.12) || (sharedTags >= 1 && sim >= 0.25)) {
        cluster.push(other)
        remaining.delete(other.id)
      }
    }
    if (cluster.length >= minSize) clusters.push(cluster)
  }
  return clusters
}

/** Deterministic extractive synthesis for a cluster of episodes. */
export function synthesizeCluster(cluster, now = Date.now()) {
  const tagCounts = new Map()
  for (const memory of cluster) for (const tag of memory.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  const sharedTags = [...tagCounts.entries()].filter(([, count]) => count >= Math.ceil(cluster.length / 2)).map(([tag]) => tag)
  const tokenCounts = new Map()
  for (const memory of cluster) {
    for (const token of new Set(similarityTokens(memory.content))) {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1)
    }
  }
  const topicTokens = [...tokenCounts.entries()]
    .filter(([token, count]) => count >= Math.ceil(cluster.length / 2) && token.length >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 4)
    .map(([token]) => token)
  const topic = sharedTags.length ? sharedTags.join('、') : topicTokens.join('、') || '同类事件'
  const samples = [...cluster]
    .sort((a, b) => b.importance - a.importance || a.createdAt - b.createdAt)
    .slice(0, 3)
    .map((memory) => summarize(memory.content, 60).replace(/[。！？!?；;，,]+$/u, ''))
  const avgImportance = cluster.reduce((sum, memory) => sum + memory.importance, 0) / cluster.length
  const content = `【回放提炼】${topic}：同类情景反复出现 ${cluster.length} 次。典型情况：${samples.join('；')}。（由 ${cluster.length} 条情景记忆自动归纳，待验证）`
  return {
    content,
    tags: [...new Set([...sharedTags, 'replay', 'consolidated'])].slice(0, 8),
    importance: clamp(avgImportance + 1, 3, 8),
    topic,
  }
}
