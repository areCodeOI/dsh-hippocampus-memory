/**
 * SQLite-backed async job queue with leases and retries.
 *
 * Jobs survive process restarts. Multiple server processes may run workers
 * against the same database; `claim()` uses an atomic UPDATE ... RETURNING, so
 * one job is handed to exactly one worker. Long jobs renew their lease.
 */

import { randomBytes } from 'node:crypto'
import { parseJson } from './db.js'

export class JobQueue {
  constructor({ db, now = () => Date.now(), intervalMs = 1000, concurrency = 1, leaseMs = 10 * 60_000 } = {}) {
    this.db = db
    this.dialect = db.dialect ?? 'sqlite'
    this.now = now
    this.intervalMs = intervalMs
    this.concurrency = Math.max(1, concurrency)
    this.leaseMs = leaseMs
    this.timer = null
    this.handlers = {}
    this.running = new Map()
    this.stopped = true
  }

  enqueue(type, payload = {}, { createdBy = null, maxAttempts = 3 } = {}) {
    const id = `job_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO jobs (id, type, status, payload, result, error, progress, attempts, max_attempts,
         created_at, created_by) VALUES (?, ?, 'queued', ?, NULL, NULL, 0, 0, ?, ?, ?)`,
      )
      .run(id, String(type), JSON.stringify(payload ?? {}), Math.max(1, maxAttempts), now, createdBy)
    return this.get(id)
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    return row ? this.rowToJob(row) : undefined
  }

  list({ status, type, limit = 50, offset = 0 } = {}) {
    const conditions = []
    const params = []
    if (status) {
      conditions.push('status = ?')
      params.push(status)
    }
    if (type) {
      conditions.push('type = ?')
      params.push(type)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs ${where}`).get(...params).n
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0))
    return { items: rows.map((row) => this.rowToJob(row)), total, limit, offset }
  }

  stats() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.n]))
    const byType = Object.fromEntries(
      this.db.prepare('SELECT type, COUNT(*) AS n FROM jobs GROUP BY type').all().map((row) => [row.type, row.n]),
    )
    return { byStatus, byType, running: this.running.size, active: (byStatus.queued ?? 0) + (byStatus.running ?? 0) }
  }

  rowToJob(row) {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      payload: parseJson(row.payload, {}),
      result: parseJson(row.result, null),
      error: row.error ?? null,
      progress: row.progress,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      leaseUntil: row.lease_until,
      createdBy: row.created_by,
    }
  }

  claim() {
    const now = this.now()
    // Cheap read first: an idle queue must not take the SQLite write lock (and
    // fsync) on every 1s poll from every process.
    const pending = this.db
      .prepare("SELECT 1 AS one FROM jobs WHERE status = 'queued' AND (lease_until IS NULL OR lease_until <= ?) LIMIT 1")
      .get(now)
    if (!pending) return undefined
    // PostgreSQL's SKIP LOCKED is what makes N workers across N server
    // processes safe: they never race for the same queued job. `lease_until`
    // on a queued row is the retry backoff gate set by fail().
    const select = this.dialect === 'postgres'
      ? `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1,
           lease_until = ?, progress = 0, error = NULL
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued'
                     AND (lease_until IS NULL OR lease_until <= ?)
                     ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`
      : `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1,
           lease_until = ?, progress = 0, error = NULL
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued'
                     AND (lease_until IS NULL OR lease_until <= ?)
                     ORDER BY created_at ASC LIMIT 1)
         RETURNING *`
    const row = this.db.prepare(select).get(now, now + this.leaseMs, now)
    return row ? this.rowToJob(row) : undefined
  }

  progress(id, fraction) {
    const value = Math.max(0, Math.min(1, Number(fraction) || 0))
    this.db.prepare('UPDATE jobs SET progress = ?, lease_until = ? WHERE id = ? AND status = ?').run(value, this.now() + this.leaseMs, id, 'running')
  }

  complete(id, result = null) {
    this.db
      .prepare("UPDATE jobs SET status = 'succeeded', result = ?, progress = 1, finished_at = ?, lease_until = NULL, error = NULL WHERE id = ?")
      .run(JSON.stringify(result ?? null), this.now(), id)
  }

  fail(id, error, { retry = true } = {}) {
    const job = this.get(id)
    if (!job || job.status === 'cancelled') return
    const message = error instanceof Error ? error.message : String(error)
    if (retry && job.attempts < job.maxAttempts) {
      // Exponential backoff with a 60s cap. Without it a permanently failing
      // job is retried every worker tick on every process (retry storm).
      const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1))
      this.db
        .prepare("UPDATE jobs SET status = 'queued', error = ?, lease_until = ? WHERE id = ?")
        .run(message, this.now() + backoffMs, id)
      return
    }
    this.db
      .prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, lease_until = NULL WHERE id = ?")
      .run(message, this.now(), id)
  }

  cancel(id) {
    const now = this.now()
    const job = this.get(id)
    if (!job) return false
    if (job.status === 'queued') {
      this.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, lease_until = NULL WHERE id = ?").run(now, id)
      return true
    }
    if (job.status === 'running' && this.running.has(id)) {
      this.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, lease_until = NULL WHERE id = ?").run(now, id)
      this.running.get(id).abort()
      return true
    }
    return false
  }

  recover() {
    const now = this.now()
    const result = this.db
      .prepare("UPDATE jobs SET status = 'queued', lease_until = NULL WHERE status = 'running' AND lease_until < ?")
      .run(now)
    return Number(result.changes ?? 0)
  }

  register(handlers = {}) {
    Object.assign(this.handlers, handlers)
    return this
  }

  start(handlers = {}) {
    if (!this.stopped) return this
    this.register(handlers)
    this.stopped = false
    this.recover()
    const tick = () => {
      if (this.stopped) return
      while (this.running.size < this.concurrency) {
        const job = this.claim()
        if (!job) break
        void this.execute(job)
      }
    }
    this.timer = setInterval(tick, this.intervalMs)
    this.timer.unref?.()
    tick()
    return this
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const controller of this.running.values()) controller.abort()
    return this
  }

  async execute(job) {
    const controller = new AbortController()
    this.running.set(job.id, controller)
    let heartbeat = null
    try {
      const handler = this.handlers[job.type]
      if (!handler) throw new Error(`no handler registered for job type: ${job.type}`)
      heartbeat = setInterval(() => {
        try {
          this.db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ? AND status = ?').run(this.now() + this.leaseMs, job.id, 'running')
        } catch {
          // ignore heartbeat failures
        }
      }, 30_000)
      heartbeat.unref?.()
      const result = await handler(job, {
        signal: controller.signal,
        progress: (fraction) => this.progress(job.id, fraction),
        queue: this,
      })
      const current = this.get(job.id)
      if (current?.status === 'cancelled') return
      this.complete(job.id, result ?? { ok: true })
    } catch (error) {
      const current = this.get(job.id)
      if (current?.status === 'cancelled') return
      this.fail(job.id, error)
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      this.running.delete(job.id)
    }
  }

  async runOnce(handlers = {}) {
    this.register(handlers)
    const job = this.claim()
    if (!job) return null
    await this.execute(job)
    return this.get(job.id)
  }

  prune(days = 30) {
    const cutoff = this.now() - Math.max(1, days) * 86_400_000
    const result = this.db
      .prepare("DELETE FROM jobs WHERE status IN ('succeeded', 'failed', 'cancelled') AND finished_at < ?")
      .run(cutoff)
    return Number(result.changes ?? 0)
  }
}
