/**
 * Memory graph / tree projections for the management UI.
 *
 * Nodes are memories; edges represent consolidation, conflicts, shared tags and
 * lexical similarity. The graph is intentionally capped so a large bank cannot
 * lock the browser or the server.
 */

import { KIND_LABELS } from './constants.js'
import { tokenSimilarity, similarityTokens } from './text.js'

/**
 * Graph providers are deliberately pluggable. `projection` computes the graph
 * in-process from whichever storage backend is active. `postgres` asks the
 * PostgreSQL store for the same projection (useful when a deployment wants to
 * make the database the source of graph topology). A graph database adapter can
 * be added with registerGraphProvider() without touching the HTTP/UI layers.
 */
const GRAPH_PROVIDERS = new Map()

export function registerGraphProvider(name, builder) {
  const key = String(name ?? '').trim().toLowerCase()
  if (!key) throw new Error('graph provider name is required')
  if (typeof builder !== 'function') throw new Error('graph provider builder must be a function')
  GRAPH_PROVIDERS.set(key, builder)
  return () => GRAPH_PROVIDERS.delete(key)
}

export function availableGraphProviders() {
  return [...GRAPH_PROVIDERS.keys()]
}

export function resolveGraphProvider(store, requested) {
  const name = String(requested || process.env.HIPPOCAMPUS_GRAPH_PROVIDER || 'projection').toLowerCase()
  if (!GRAPH_PROVIDERS.has(name)) throw new Error(`unknown graph provider: ${name} (available: ${availableGraphProviders().join(', ')})`)
  if (name === 'postgres' && store.dialect !== 'postgres') {
    throw new Error('graphProvider=postgres requires storage=postgres')
  }
  return name
}

function projectionBuilder(store, options) {
  return buildProjection(store, options)
}

function postgresBuilder(store, options) {
  // The PostgreSQL provider currently uses the same topology computation but
  // runs it against the PostgreSQL-backed store. Keeping the boundary explicit
  // lets a future recursive-SQL or Neo4j provider implement the same contract.
  return buildProjection(store, options)
}

registerGraphProvider('projection', projectionBuilder)
registerGraphProvider('postgres', postgresBuilder)

export function buildGraph(store, { provider = 'projection', namespace = 'default', limit = 200, includeArchived = false, includePending = true, similarity = true } = {}) {
  const name = String(provider || 'projection').toLowerCase()
  const builder = GRAPH_PROVIDERS.get(name)
  if (!builder) throw new Error(`unknown graph provider: ${name}`)
  if (name === 'postgres' && store.dialect !== 'postgres') throw new Error('graphProvider=postgres requires storage=postgres')
  return builder(store, { namespace, limit, includeArchived, includePending, similarity, provider: name })
}

function buildProjection(store, { provider = 'projection', namespace = 'default', limit = 200, includeArchived = false, includePending = true, similarity = true } = {}) {
  const safeLimit = Math.min(500, Math.max(10, Number(limit) || 200))
  const list = store.list({
    namespace,
    limit: safeLimit,
    offset: 0,
    order: 'important',
    includeArchived,
    includePending,
  })
  const nodes = list.items.map((memory) => ({
    id: memory.id,
    label: memory.summary || memory.content.slice(0, 80),
    content: memory.content,
    kind: memory.kind,
    kindLabel: memory.kindLabel,
    status: memory.status,
    statusLabel: memory.statusLabel,
    importance: memory.importance,
    weight: memory.weight,
    confidence: memory.confidence,
    tags: memory.tags,
    namespace: memory.namespace,
    accessCount: memory.accessCount,
    createdAt: memory.createdAt,
    lastAccessAt: memory.lastAccessAt,
    conflictWith: memory.conflictWith,
    consolidatedInto: memory.consolidatedInto,
    supersededBy: memory.supersededBy,
    size: 4 + Math.round(memory.importance * 1.4) + (memory.kind === 'persona' ? 3 : 0),
  }))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = new Map()
  const addEdge = (source, target, type, weight = 1) => {
    if (!byId.has(source) || !byId.has(target) || source === target) return
    const key = `${source}|${target}|${type}`
    const reverse = `${target}|${source}|${type}`
    if (edges.has(reverse)) return
    if (!edges.has(key)) edges.set(key, { source, target, type, weight: Number(weight.toFixed(3)) })
  }

  for (const node of nodes) {
    if (node.consolidatedInto) addEdge(node.id, node.consolidatedInto, 'consolidation', 1.2)
    if (node.conflictWith) addEdge(node.id, node.conflictWith, 'conflict', 1.5)
    if (node.supersededBy) addEdge(node.id, node.supersededBy, 'supersede', 0.8)
  }

  // Shared tags: connect each node to at most two neighbours per tag.
  const byTag = new Map()
  for (const node of nodes) {
    for (const tag of node.tags) {
      const bucket = byTag.get(tag) ?? []
      bucket.push(node)
      byTag.set(tag, bucket)
    }
  }
  for (const [tag, bucket] of byTag) {
    if (bucket.length < 2 || bucket.length > 40) continue
    for (let index = 0; index < bucket.length; index += 1) {
      for (let offset = 1; offset <= 2; offset += 1) {
        const peer = bucket[(index + offset) % bucket.length]
        addEdge(bucket[index].id, peer.id, 'tag', 0.4)
        void tag
      }
    }
  }

  if (similarity && nodes.length <= 300) {
    const tokens = new Map(nodes.map((node) => [node.id, similarityTokens(node.content)]))
    const perNode = new Map()
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        const score = tokenSimilarity(tokens.get(a.id), tokens.get(b.id))
        if (score < 0.45) continue
        const countA = perNode.get(a.id) ?? 0
        const countB = perNode.get(b.id) ?? 0
        if (countA >= 3 && countB >= 3) continue
        addEdge(a.id, b.id, 'similar', score)
        perNode.set(a.id, countA + 1)
        perNode.set(b.id, countB + 1)
      }
    }
  }

  return {
    nodes,
    edges: [...edges.values()],
    total: list.total,
    truncated: list.total > nodes.length,
    limit: safeLimit,
    namespace,
    provider,
    generatedAt: Date.now(),
    stats: {
      nodes: nodes.length,
      edges: edges.size,
      byKind: nodes.reduce((acc, node) => ({ ...acc, [node.kind]: (acc[node.kind] ?? 0) + 1 }), {}),
      byStatus: nodes.reduce((acc, node) => ({ ...acc, [node.status]: (acc[node.status] ?? 0) + 1 }), {}),
    },
  }
}

export function buildTree(store, { provider = 'projection', namespace = 'default', limit = 500, includeArchived = false, includePending = true } = {}) {
  const graph = buildGraph(store, { provider, namespace, limit, includeArchived, includePending, similarity: false })
  const namespaces = new Map()
  for (const node of graph.nodes) {
    const bucket = namespaces.get(node.namespace) ?? { name: node.namespace, count: 0, kinds: new Map() }
    bucket.count += 1
    const kind = bucket.kinds.get(node.kind) ?? { kind: node.kind, label: KIND_LABELS[node.kind] ?? node.kind, count: 0, nodes: [] }
    kind.count += 1
    kind.nodes.push(node)
    bucket.kinds.set(node.kind, kind)
    namespaces.set(node.namespace, bucket)
  }
  return {
    namespaces: [...namespaces.values()].map((bucket) => ({
      name: bucket.name,
      count: bucket.count,
      kinds: [...bucket.kinds.values()].map((kind) => ({
        ...kind,
        nodes: kind.nodes.sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt),
      })),
    })),
    total: graph.total,
    truncated: graph.truncated,
  }
}
