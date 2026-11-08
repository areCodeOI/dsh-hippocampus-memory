/**
 * Default async job handlers and a runtime assembler shared by the HTTP server
 * (and available to custom deployments).
 */

import fs from 'node:fs'
import path from 'node:path'
import { Metrics } from './metrics.js'
import { TtlLruCache } from './cache.js'
import { AuditLog } from './audit.js'
import { AuthService } from './auth.js'
import { EmbeddingService } from './embeddings.js'
import { JobQueue } from './jobs.js'
import { RateLimiter } from './ratelimit.js'
import { buildGraph, buildTree } from './graph.js'
import { defaultBackupDir } from './backup.js'
import { renameNamespace, mergeNamespaces, deleteNamespace } from './namespaces.js'

export function createJobHandlers({ store, embeddings, audit, jobs, backupDir, graphProvider = 'projection' } = {}) {
  return {
    async replay(job, { progress }) {
      progress?.(0.1)
      const result = store.replay({ namespace: job.payload?.namespace ?? '*' })
      progress?.(1)
      return result
    },
    async embed(job) {
      if (!embeddings?.enabled) return { skipped: true, reason: 'embeddings disabled' }
      const memoryId = job.payload?.memoryId
      if (!memoryId) throw new Error('embed job requires payload.memoryId')
      return embeddings.indexMemory(store, memoryId)
    },
    async embed_backfill(job, { progress, signal }) {
      if (!embeddings?.enabled) return { skipped: true, reason: 'embeddings disabled' }
      return embeddings.backfill(store, {
        namespace: job.payload?.namespace,
        limit: Number(job.payload?.limit) || 500,
        signal,
        onProgress: progress,
      })
    },
    async backup(job, { progress }) {
      progress?.(0.1)
      const dir = backupDir ?? defaultBackupDir(store)
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      if (store.dialect === 'postgres') {
        // PostgreSQL backups should normally be taken with pg_dump / a managed
        // snapshot. This portable logical export is enough for the UI and keeps
        // the API server dependency-free.
        const target = path.join(dir, `memory-${stamp}.json`)
        fs.writeFileSync(target, JSON.stringify(store.exportAll('*'), null, 2), { mode: 0o600 })
        progress?.(1)
        return { file: target, size: fs.statSync(target).size, format: 'json', createdAt: Date.now() }
      }
      const target = path.join(dir, `memory-${stamp}.db`)
      // VACUUM INTO produces a consistent snapshot even while other reader /
      // writer processes are connected.
      store.db.prepare('VACUUM INTO ?').run(target)
      try {
        fs.chmodSync(target, 0o600)
      } catch {
        // best effort on filesystems without POSIX modes
      }
      progress?.(1)
      const size = fs.statSync(target).size
      return { file: target, size, createdAt: Date.now() }
    },
    async maintenance(job, { progress }) {
      progress?.(0.2)
      const auditPruned = audit?.prune(job.payload?.auditDays ?? 180) ?? 0
      const jobsPruned = jobs?.prune(job.payload?.jobDays ?? 30) ?? 0
      const replay = store.replay({ namespace: job.payload?.namespace ?? '*' })
      progress?.(1)
      return { auditPruned, jobsPruned, replay }
    },
    async namespace_rename(job, { progress, signal }) {
      return renameNamespace(store, job.payload?.from, job.payload?.to, {
        force: Boolean(job.payload?.force),
        backup: process.env.HIPPOCAMPUS_BACKUP_BEFORE_NAMESPACE !== '0',
        backupDir,
        progress,
        signal,
        meta: job.payload?.meta ?? {},
      })
    },
    async namespace_merge(job, { progress, signal }) {
      return mergeNamespaces(store, job.payload?.from, job.payload?.into, {
        force: Boolean(job.payload?.force),
        backup: process.env.HIPPOCAMPUS_BACKUP_BEFORE_NAMESPACE !== '0',
        backupDir,
        progress,
        signal,
      })
    },
    async namespace_delete(job, { progress, signal }) {
      return deleteNamespace(store, job.payload?.namespace ?? job.payload?.name, {
        hard: Boolean(job.payload?.hard),
        confirm: Boolean(job.payload?.confirm),
        force: Boolean(job.payload?.force),
        backup: process.env.HIPPOCAMPUS_BACKUP_BEFORE_NAMESPACE !== '0',
        backupDir,
        progress,
        signal,
      })
    },
    async graph(job, { progress }) {
      progress?.(0.5)
      const graph = buildGraph(store, {
        provider: job.payload?.provider ?? graphProvider,
        namespace: job.payload?.namespace ?? 'default',
        limit: job.payload?.limit ?? 200,
        includeArchived: Boolean(job.payload?.includeArchived),
      })
      progress?.(1)
      return graph
    },
    async tree(job, { progress }) {
      progress?.(0.5)
      const tree = buildTree(store, {
        provider: job.payload?.provider ?? graphProvider,
        namespace: job.payload?.namespace ?? 'default',
        limit: job.payload?.limit ?? 500,
        includeArchived: Boolean(job.payload?.includeArchived),
      })
      progress?.(1)
      return tree
    },
  }
}

export function createRuntime({
  store,
  token = process.env.HIPPOCAMPUS_TOKEN,
  env = process.env,
  startWorker = true,
  options = {},
} = {}) {
  const metrics = options.metrics ?? new Metrics()
  const cache = options.cache ?? new TtlLruCache({ name: 'search', maxEntries: 500, ttlMs: 30_000 })
  const graphCache = options.graphCache ?? new TtlLruCache({ name: 'graph', maxEntries: 40, ttlMs: 15_000 })
  const audit = options.audit ?? new AuditLog(store.db)
  const auth =
    options.auth ??
    new AuthService({
      db: store.db,
      bootstrapToken: token,
      mode: env.HIPPOCAMPUS_AUTH ?? 'auto',
    })
  let embeddings = options.embeddings
  if (!embeddings) {
    try {
      embeddings = EmbeddingService.fromEnv({ env })
    } catch (error) {
      console.error('[hippocampus] invalid embedding configuration; embeddings disabled:', error instanceof Error ? error.message : String(error))
      embeddings = new EmbeddingService({ providers: [] })
    }
  }
  const jobs =
    options.jobs ??
    new JobQueue({
      db: store.db,
      concurrency: Number(env.HIPPOCAMPUS_JOB_CONCURRENCY) || 1,
      intervalMs: Number(env.HIPPOCAMPUS_JOB_INTERVAL_MS) || 1000,
    })
  const rateLimiter =
    options.rateLimiter ??
    new RateLimiter({
      limit: Number(env.HIPPOCAMPUS_RATE_LIMIT) || 600,
      windowMs: Number(env.HIPPOCAMPUS_RATE_WINDOW_MS) || 60_000,
    })
  const backupDir = options.backupDir ?? defaultBackupDir(store)
  const handlers = createJobHandlers({ store, embeddings, audit, jobs, backupDir, graphProvider: options.graphProvider })
  if (startWorker) jobs.start(handlers)
  return { store, metrics, cache, graphCache, audit, auth, embeddings, jobs, handlers, rateLimiter, backupDir }
}
