/**
 * Optional embedding pipeline with multiple OpenAI-compatible / Ollama
 * providers. Embeddings are stored as FP32 BLOBs with 4×16-bit SimHash bands so
 * SQLite can return approximate candidates for cosine re-ranking.
 */

import { createHash } from 'node:crypto'
import { TtlLruCache, cacheKey } from './cache.js'
import { bandKeys, cosine, normalizeVector, vectorFromBlob, vectorToBlob } from './vector.js'

function pgVectorLiteral(vector) {
  return `[${Array.from(vector, (value) => Number(value).toFixed(7)).join(',')}]`
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

function resolveKey(entry, env) {
  if (entry.apiKey) return entry.apiKey
  if (entry.apiKeyEnv && env[entry.apiKeyEnv]) return env[entry.apiKeyEnv]
  return null
}

function normalizeProvider(entry, env) {
  const kind = entry.kind ?? entry.provider ?? 'openai'
  if (!['openai', 'ollama'].includes(kind)) throw new Error(`unsupported embedding provider: ${kind}`)
  const model = String(entry.model ?? (kind === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small'))
  const baseUrl = String(
    entry.baseUrl ??
      entry.base_url ??
      (kind === 'ollama' ? env.HIPPOCAMPUS_OLLAMA_URL ?? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'),
  ).replace(/\/+$/, '')
  return {
    id: String(entry.id ?? `${kind}:${model}`),
    kind,
    model,
    baseUrl,
    apiKey: resolveKey(entry, env),
    dim: Number(entry.dim) || null,
    timeoutMs: Number(entry.timeoutMs) || 15_000,
    weight: Number(entry.weight) || 1,
    enabled: entry.enabled !== false,
  }
}

export function providersFromEnv(env = process.env) {
  if (env.HIPPOCAMPUS_EMBEDDINGS) {
    let parsed
    try {
      parsed = JSON.parse(env.HIPPOCAMPUS_EMBEDDINGS)
    } catch (error) {
      throw new Error(`HIPPOCAMPUS_EMBEDDINGS is not valid JSON: ${error.message}`)
    }
    if (!Array.isArray(parsed)) throw new Error('HIPPOCAMPUS_EMBEDDINGS must be a JSON array')
    return parsed.map((entry) => normalizeProvider(entry, env)).filter((provider) => provider.enabled)
  }
  const kind = env.HIPPOCAMPUS_EMBEDDING_PROVIDER
  if (!kind || kind === 'none') return []
  return [
    normalizeProvider(
      {
        kind,
        model: env.HIPPOCAMPUS_EMBEDDING_MODEL,
        baseUrl: env.HIPPOCAMPUS_EMBEDDING_BASE_URL,
        apiKey: env.HIPPOCAMPUS_EMBEDDING_API_KEY,
        apiKeyEnv: 'HIPPOCAMPUS_EMBEDDING_API_KEY',
        dim: env.HIPPOCAMPUS_EMBEDDING_DIM,
      },
      env,
    ),
  ]
}

export class EmbeddingService {
  /**
   * @param {{ providers?: ReturnType<typeof providersFromEnv>, fetchImpl?: typeof fetch,
   *   queryCache?: TtlLruCache }} [options]
   */
  constructor({ providers = [], fetchImpl = globalThis.fetch, queryCache } = {}) {
    this.providers = providers
    this.fetchImpl = fetchImpl
    this.version = 0
    this.queryCache = queryCache ?? new TtlLruCache({ name: 'embedding-query', maxEntries: 500, ttlMs: 10 * 60_000 })
    this.lastError = null
  }

  static fromEnv({ env = process.env, fetchImpl } = {}) {
    return new EmbeddingService({ providers: providersFromEnv(env), fetchImpl })
  }

  get enabled() {
    return this.providers.length > 0
  }

  describe() {
    return {
      enabled: this.enabled,
      version: this.version,
      providers: this.providers.map(({ id, kind, model, baseUrl, dim }) => ({ id, kind, model, baseUrl, dim })),
    }
  }

  async embedText(provider, text) {
    const key = cacheKey([provider.id, hashText(text)])
    const cached = this.queryCache.get(key)
    if (cached) return cached
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs)
    try {
      let vector
      if (provider.kind === 'ollama') {
        const response = await this.fetchImpl(`${provider.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: provider.model, prompt: text }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Ollama embeddings HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
        const body = await response.json()
        vector = body.embedding ?? body.embeddings?.[0]
      } else {
        const headers = { 'content-type': 'application/json' }
        if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`
        const response = await this.fetchImpl(`${provider.baseUrl}/embeddings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: provider.model, input: text }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`embedding HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
        const body = await response.json()
        vector = body.data?.[0]?.embedding ?? body.embedding ?? body.embeddings?.[0]
      }
      if (!Array.isArray(vector) || !vector.length) throw new Error('embedding response contained no vector')
      if (provider.dim && vector.length !== provider.dim) {
        throw new Error(`embedding dimension ${vector.length} != configured ${provider.dim}`)
      }
      const normalized = normalizeVector(vector)
      this.queryCache.set(key, normalized)
      this.lastError = null
      return normalized
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async embedQuery(text) {
    if (!this.enabled) return []
    const results = []
    for (const provider of this.providers) {
      try {
        const { vector } = await this.embedText(provider, text)
        results.push({ provider, vector })
      } catch (error) {
        results.push({ provider, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }

  async indexMemory(store, memoryId) {
    if (!this.enabled) return { indexed: 0 }
    const memory = store.getMemory(memoryId)
    if (!memory) throw new Error(`memory not found: ${memoryId}`)
    const text = `${memory.content} ${memory.summary}`.trim()
    let indexed = 0
    for (const provider of this.providers) {
      const { vector, norm } = await this.embedText(provider, text)
      const bands = bandKeys(vector)
      const pgvector = store.db.dialect === 'postgres' && store.db.pgvector
      if (pgvector) {
        store.db
          .prepare(
            `INSERT INTO embeddings (memory_id, provider, model, dim, vector, norm, updated_at, embedding)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?::vector)
             ON CONFLICT(memory_id, provider, model) DO UPDATE SET
               dim = excluded.dim, vector = excluded.vector, norm = excluded.norm,
               embedding = excluded.embedding, updated_at = excluded.updated_at`,
          )
          .run(memoryId, provider.id, provider.model, vector.length, vectorToBlob(vector), norm, Date.now(), pgVectorLiteral(vector))
      } else {
        store.db
          .prepare(
            `INSERT INTO embeddings (memory_id, provider, model, dim, vector, norm, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(memory_id, provider, model) DO UPDATE SET
               dim = excluded.dim, vector = excluded.vector, norm = excluded.norm, updated_at = excluded.updated_at`,
          )
          .run(memoryId, provider.id, provider.model, vector.length, vectorToBlob(vector), norm, Date.now())
      }
      store.db
        .prepare(
          `INSERT INTO embedding_index (memory_id, provider, model, band0, band1, band2, band3, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(memory_id, provider, model) DO UPDATE SET
             band0 = excluded.band0, band1 = excluded.band1, band2 = excluded.band2,
             band3 = excluded.band3, updated_at = excluded.updated_at`,
        )
        .run(memoryId, provider.id, provider.model, ...bands, Date.now())
      indexed += 1
    }
    this.version += 1
    return { indexed, providers: this.providers.map((provider) => provider.id) }
  }

  async search(store, query, { namespace, candidateLimit = 600 } = {}) {
    if (!this.enabled) return { scores: new Map(), providers: [], version: this.version }
    const scores = new Map()
    const usedProviders = []
    const errors = []
    for (const provider of this.providers) {
      let embedded
      try {
        embedded = await this.embedText(provider, query)
      } catch (error) {
        errors.push({ provider: provider.id, error: error instanceof Error ? error.message : String(error) })
        continue
      }
      const bands = bandKeys(embedded.vector)
      const vectorLiteral = pgVectorLiteral(embedded.vector)
      if (store.db.dialect === 'postgres' && store.db.pgvector) {
        try {
          let exactNamespace = ''
          const exactParams = [vectorLiteral, provider.id, provider.model]
          if (namespace && namespace !== '*') {
            exactNamespace = 'AND m.namespace = ?'
            exactParams.push(namespace)
          }
          exactParams.push(vectorLiteral, candidateLimit)
          const exact = store.db
            .prepare(
              `SELECT e.memory_id, 1 - (e.embedding <=> ?::vector) AS similarity
               FROM embeddings e JOIN memories m ON m.id = e.memory_id
               WHERE e.provider = ? AND e.model = ? AND m.status = 'active'
                 AND e.embedding IS NOT NULL ${exactNamespace}
               ORDER BY e.embedding <=> ?::vector
               LIMIT ?`,
            )
            .all(...exactParams)
          if (exact.length) {
            usedProviders.push(provider.id)
            for (const row of exact) {
              const similarity = Math.max(0, Number(row.similarity) || 0)
              const previous = scores.get(row.memory_id)
              if (!previous || similarity > previous.similarity) {
                scores.set(row.memory_id, { similarity, provider: provider.id, model: provider.model })
              }
            }
            continue
          }
        } catch (error) {
          errors.push({ provider: provider.id, error: `pgvector exact search failed, using SimHash: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
      const params = [provider.id, provider.model]
      let namespaceClause = ''
      if (namespace && namespace !== '*') {
        namespaceClause = 'AND m.namespace = ?'
        params.push(namespace)
      }
      let rows = store.db
        .prepare(
          `SELECT e.memory_id, e.vector, e.norm
           FROM embedding_index i
           JOIN embeddings e ON e.memory_id = i.memory_id AND e.provider = i.provider AND e.model = i.model
           JOIN memories m ON m.id = i.memory_id
           WHERE i.provider = ? AND i.model = ? AND m.status = 'active' ${namespaceClause}
             AND (i.band0 = ? OR i.band1 = ? OR i.band2 = ? OR i.band3 = ?)
           LIMIT ?`,
        )
        .all(...params, ...bands, candidateLimit)
      if (rows.length < 20) {
        const fallbackParams = [provider.id, provider.model]
        let fallbackNamespace = ''
        if (namespace && namespace !== '*') {
          fallbackNamespace = 'AND m.namespace = ?'
          fallbackParams.push(namespace)
        }
        rows = store.db
          .prepare(
            `SELECT e.memory_id, e.vector, e.norm
             FROM embeddings e JOIN memories m ON m.id = e.memory_id
             WHERE e.provider = ? AND e.model = ? AND m.status = 'active' ${fallbackNamespace}
             LIMIT 2000`,
          )
          .all(...fallbackParams)
      }
      usedProviders.push(provider.id)
      for (const row of rows) {
        const vector = vectorFromBlob(row.vector)
        const similarity = Math.max(0, cosine(embedded.vector, vector, embedded.norm, row.norm))
        const previous = scores.get(row.memory_id)
        if (!previous || similarity > previous.similarity) {
          scores.set(row.memory_id, { similarity, provider: provider.id, model: provider.model })
        }
      }
    }
    return {
      scores: new Map([...scores.entries()].map(([id, value]) => [id, value.similarity])),
      details: scores,
      providers: usedProviders,
      errors,
      version: this.version,
    }
  }

  async backfill(store, { limit = 500, namespace, onProgress, signal } = {}) {
    if (!this.enabled) return { indexed: 0, failed: 0, skipped: 0, providers: [] }
    let indexed = 0
    let failed = 0
    const providers = []
    for (const provider of this.providers) {
      providers.push(provider.id)
      const params = [provider.id, provider.model]
      let namespaceClause = ''
      if (namespace && namespace !== '*') {
        namespaceClause = 'AND m.namespace = ?'
        params.push(namespace)
      }
      const pgvectorMissing = store.db.dialect === 'postgres' && store.db.pgvector ? 'OR e.embedding IS NULL' : ''
      const rows = store.db
        .prepare(
          `SELECT m.id FROM memories m
           LEFT JOIN embeddings e ON e.memory_id = m.id AND e.provider = ? AND e.model = ?
           WHERE (e.memory_id IS NULL ${pgvectorMissing}) AND m.status IN ('active', 'conflict', 'archived') ${namespaceClause}
           ORDER BY m.updated_at DESC LIMIT ?`,
        )
        .all(...params, limit)
      for (let index = 0; index < rows.length; index += 1) {
        if (signal?.aborted) break
        try {
          await this.indexMemory(store, rows[index].id)
          indexed += 1
        } catch {
          failed += 1
        }
        onProgress?.((index + 1) / rows.length)
      }
    }
    return { indexed, failed, skipped: Math.max(0, limit - indexed - failed), providers }
  }

  embeddingsStats(store) {
    const memoryCount = store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status IN ('active', 'conflict', 'archived')").get().n
    const providers = this.providers.map((provider) => {
      const count = store.db
        .prepare('SELECT COUNT(*) AS n FROM embeddings WHERE provider = ? AND model = ?')
        .get(provider.id, provider.model).n
      return {
        id: provider.id,
        kind: provider.kind,
        model: provider.model,
        baseUrl: provider.baseUrl,
        dim: provider.dim,
        indexed: count,
        coverage: memoryCount ? Number((count / memoryCount).toFixed(3)) : 0,
      }
    })
    return { enabled: this.enabled, version: this.version, memoryCount, providers, lastError: this.lastError }
  }
}
