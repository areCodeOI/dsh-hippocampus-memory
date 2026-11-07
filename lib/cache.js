/**
 * Small dependency-free TTL + LRU cache used for search results, query
 * embeddings, graph payloads and similar hot reads.
 */

export class TtlLruCache {
  constructor({ name = 'cache', maxEntries = 500, ttlMs = 30_000 } = {}) {
    this.name = name
    this.maxEntries = Math.max(1, maxEntries)
    this.ttlMs = Math.max(0, ttlMs)
    this.map = new Map()
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  get(key) {
    const entry = this.map.get(key)
    if (!entry) {
      this.misses += 1
      return undefined
    }
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key)
      this.misses += 1
      return undefined
    }
    // Refresh recency.
    this.map.delete(key)
    this.map.set(key, entry)
    this.hits += 1
    return entry.value
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs })
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
      this.evictions += 1
    }
    return value
  }

  delete(key) {
    return this.map.delete(key)
  }

  clear() {
    this.map.clear()
  }

  stats() {
    const total = this.hits + this.misses
    return {
      name: this.name,
      entries: this.map.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total ? Number((this.hits / total).toFixed(4)) : 0,
    }
  }
}

/** Deterministic JSON key for cache lookups (object key order normalized). */
export function cacheKey(value) {
  return JSON.stringify(value, (_key, inner) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
    }
    return inner
  })
}
