/**
 * Fixed-window rate limiter keyed by API key / IP.
 * Local, dependency-free; suitable for a single-node self-hosted deployment.
 */

export class RateLimiter {
  constructor({ limit = 600, windowMs = 60_000 } = {}) {
    this.limit = Math.max(1, Number(limit) || 600)
    this.windowMs = Math.max(1000, Number(windowMs) || 60_000)
    this.buckets = new Map()
    this.timer = setInterval(() => this.cleanup(), Math.max(10_000, this.windowMs)).unref?.() ?? null
  }

  take(key) {
    const now = Date.now()
    let bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs }
      this.buckets.set(key, bucket)
    }
    bucket.count += 1
    const allowed = bucket.count <= this.limit
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }

  cleanup() {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  stats() {
    return { buckets: this.buckets.size, limit: this.limit, windowMs: this.windowMs }
  }
}
