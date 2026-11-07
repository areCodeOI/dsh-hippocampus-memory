/**
 * Append-only audit log for the management API.
 *
 * The `memories`-level `events` table remains the domain history (add, merge,
 * replay...). This table records who called which HTTP/MCP operation, from
 * where, with what outcome.
 */

import { parseJson } from './db.js'

export class AuditLog {
  constructor(db, { now = () => Date.now(), maxDetailBytes = 8000 } = {}) {
    this.db = db
    this.now = now
    this.maxDetailBytes = maxDetailBytes
  }

  record(entry = {}) {
    try {
      let detail = entry.detail
      if (detail !== undefined && typeof detail !== 'string') detail = JSON.stringify(detail)
      if (typeof detail === 'string' && detail.length > this.maxDetailBytes) {
        detail = `${detail.slice(0, this.maxDetailBytes)}…`
      }
      this.db
        .prepare(
          `INSERT INTO audit_log
           (at, request_id, actor, role, action, method, path, target, namespace, ip, status, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.now(),
          entry.requestId ?? null,
          entry.actor ?? null,
          entry.role ?? null,
          entry.action ?? 'unknown',
          entry.method ?? null,
          entry.path ?? null,
          entry.target ?? null,
          entry.namespace ?? null,
          entry.ip ?? null,
          entry.status ?? null,
          detail ?? '{}',
        )
    } catch (error) {
      // Auditing must never take the data plane down.
      console.error('[hippocampus] audit write failed:', error instanceof Error ? error.message : String(error))
    }
  }

  list({ limit = 50, offset = 0, action, actor, since, until } = {}) {
    const conditions = []
    const params = []
    if (action) {
      conditions.push('action = ?')
      params.push(action)
    }
    if (actor) {
      conditions.push('actor = ?')
      params.push(actor)
    }
    if (since) {
      conditions.push('at >= ?')
      params.push(Number(since))
    }
    if (until) {
      conditions.push('at <= ?')
      params.push(Number(until))
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params).n
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
    const safeOffset = Math.max(0, Number(offset) || 0)
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, safeLimit, safeOffset)
    return {
      items: rows.map((row) => ({
        id: row.id,
        at: row.at,
        requestId: row.request_id,
        actor: row.actor,
        role: row.role,
        action: row.action,
        method: row.method,
        path: row.path,
        target: row.target,
        namespace: row.namespace,
        ip: row.ip,
        status: row.status,
        detail: parseJson(row.detail, {}),
      })),
      total,
      limit: safeLimit,
      offset: safeOffset,
    }
  }

  prune(days = 180) {
    const cutoff = this.now() - Math.max(1, days) * 86_400_000
    const result = this.db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff)
    return Number(result.changes ?? 0)
  }
}
