/**
 * In-process metrics: HTTP counters/latency plus gauges for memory, jobs,
 * cache and database size. Exposes Prometheus text and a JSON snapshot.
 */

import { VERSION } from './constants.js'

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]

function labelString(labels) {
  const entries = Object.entries(labels ?? {}).filter(([, value]) => value !== undefined && value !== null)
  if (!entries.length) return ''
  return `{${entries
    .map(([key, value]) => `${key}="${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`)
    .join(',')}}`
}

export class Metrics {
  constructor({ startedAt = Date.now() } = {}) {
    this.startedAt = startedAt
    this.counters = new Map()
    this.gauges = new Map()
    this.http = new Map()
    this.latency = LATENCY_BUCKETS.map((bucket) => ({ bucket, count: 0 }))
    this.latencyCount = 0
    this.latencySum = 0
  }

  inc(name, labels = {}, delta = 1) {
    const key = `${name}${labelString(labels)}`
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta)
    return this
  }

  set(name, labels = {}, value = 0) {
    this.gauges.set(`${name}${labelString(labels)}`, Number(value))
    return this
  }

  observeHttp({ method = 'GET', route = 'unknown', status = 200, durationMs = 0 }) {
    const key = `${method}|${route}|${status}`
    this.http.set(key, (this.http.get(key) ?? 0) + 1)
    this.inc('http_requests_total', { method, route, status })
    this.latencyCount += 1
    this.latencySum += durationMs / 1000
    for (const entry of this.latency) if (durationMs / 1000 <= entry.bucket) entry.count += 1
  }

  snapshot(extra = {}) {
    const mem = process.memoryUsage()
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      requests: Object.fromEntries(
        [...this.http.entries()].map(([key, count]) => {
          const [method, route, status] = key.split('|')
          return [`${method} ${route} ${status}`, count]
        }),
      ),
      latency: {
        count: this.latencyCount,
        averageMs: this.latencyCount ? Number(((this.latencySum / this.latencyCount) * 1000).toFixed(2)) : 0,
      },
      process: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
      },
      ...extra,
    }
  }

  renderPrometheus(extraLines = []) {
    const lines = [
      '# HELP hippocampus_info Build information',
      '# TYPE hippocampus_info gauge',
      `hippocampus_info{version="${VERSION}"} 1`,
      '# HELP hippocampus_uptime_seconds Process uptime',
      '# TYPE hippocampus_uptime_seconds gauge',
      `hippocampus_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`,
      '# HELP hippocampus_http_requests_total HTTP requests',
      '# TYPE hippocampus_http_requests_total counter',
    ]
    for (const [key, count] of this.counters) {
      if (key.startsWith('http_requests_total')) lines.push(`hippocampus_${key} ${count}`)
    }
    lines.push('# HELP hippocampus_http_request_duration_seconds HTTP request latency')
    lines.push('# TYPE hippocampus_http_request_duration_seconds histogram')
    for (const entry of this.latency) lines.push(`hippocampus_http_request_duration_seconds_bucket{le="${entry.bucket}"} ${entry.count}`)
    lines.push(`hippocampus_http_request_duration_seconds_bucket{le="+Inf"} ${this.latencyCount}`)
    lines.push(`hippocampus_http_request_duration_seconds_sum ${this.latencySum.toFixed(6)}`)
    lines.push(`hippocampus_http_request_duration_seconds_count ${this.latencyCount}`)
    lines.push('# HELP hippocampus_process_memory_bytes Process memory')
    lines.push('# TYPE hippocampus_process_memory_bytes gauge')
    const mem = process.memoryUsage()
    for (const [name, value] of Object.entries(mem)) {
      lines.push(`hippocampus_process_memory_bytes{type="${name}"} ${value}`)
    }
    for (const [key, value] of this.gauges) {
      lines.push(`hippocampus_${key} ${value}`)
    }
    lines.push(...extraLines)
    return `${lines.join('\n')}\n`
  }
}
