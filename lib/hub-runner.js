/**
 * Memory-hub execution layer.
 *
 * `lib/memory-hub.js` is a pure, offline decision engine: it decides WHAT to
 * read, WHAT to remember, and HOW to store it, but never touches the store.
 * This module is the only place that turns those decisions into real reads and
 * writes. It deliberately contains no LLM client, no fetch and no network I/O.
 *
 * The hub is opt-in (`memoryHub: true`). When it is off, callers use the legacy
 * auto-recall / auto-capture paths unchanged.
 */

import { createHash } from 'node:crypto'
import { hubPlan } from './memory-hub.js'
import { appendAutoRecall } from './auto-recall.js'
import { writeCandidates, textHash } from './auto-capture.js'

export const HUB_SOURCE = 'hippocampus-memory-hub'

/** Narrow a raw user/config value to a finite number within [min, max]. */
function num(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Normalise one plugin config object into the two option bags the hub wants. */
export function hubOptionsFromConfig(config = {}) {
  const now = num(config.now, Date.now(), 0, Number.MAX_SAFE_INTEGER)
  const readThreshold = num(config.hubReadThreshold, 0.34, 0, 1)
  const writeThreshold = num(config.hubWriteThreshold, 0.55, 0, 1)
  const maxCandidates = Math.floor(num(config.hubCaptureMaxPerTurn, 2, 1, 5))
  const maxChars = Math.floor(num(config.hubRecallMaxChars, 1200, 400, 4000))
  const minScore = num(config.hubRecallMinScore, 0.18, 0, 1)
  const limit = Math.floor(num(config.hubRecallLimit, 4, 1, 8))
  const common = {
    namespace: config.hubNamespace ?? config.autoCaptureNamespace ?? '',
    now,
  }
  return {
    now,
    recall: {
      ...common,
      enabled: config.autoRecall !== false,
      recallEnabled: config.autoRecall !== false,
      readThreshold,
      recallMaxChars: maxChars,
      recallMinScore: minScore,
      recallDefaultLimit: limit,
      recallMaxQueryChars: 1000,
    },
    capture: {
      ...common,
      enabled: config.hubCapture !== false,
      captureEnabled: config.hubCapture !== false,
      writeThreshold,
      captureMaxCandidates: maxCandidates,
      captureMaxFactChars: 500,
      captureMaxInputChars: 4000,
      includeAssistant: config.autoCaptureAssistant !== false,
      includeTools: config.autoCaptureToolResults !== false,
    },
  }
}

/** Search + inject recalled memories. Never throws: a failed read must not block a step. */
export function executeHubRecall(store, decision, baseDecision, { namespace = '', logger } = {}) {
  if (!decision?.shouldRead || !decision.query) return baseDecision
  const targetNamespace = namespace || store.namespace
  try {
    if (targetNamespace !== '*') {
      const policy = store.namespacePolicy(targetNamespace)
      if (policy.archived || policy.autoRecall === false) return baseDecision
    }
    const result = store.search(decision.query.slice(0, decision.maxQueryChars || 1000), {
      limit: decision.limit,
      namespace: targetNamespace,
      mode: 'relevance',
      // A background read must not refresh last_access_at / keep decayed
      // memories alive.
      updateAccess: false,
    })
    const memories = (result.memories ?? []).filter((memory) => {
      if ((memory.score ?? 0) < decision.minScore) return false
      // Unreviewed auto-capture candidates must never reach the model.
      if (memory.metadata?.autoCapture?.review === 'pending') return false
      if (targetNamespace !== '*') return true
      const policy = store.namespacePolicy(memory.namespace)
      return !policy.archived && policy.autoRecall !== false
    })
    if (!memories.length) return baseDecision
    try {
      store.recordAutoRecall({
        count: memories.length,
        chars: memories.reduce((total, memory) => total + String(memory.content ?? '').length, 0),
      })
    } catch {
      // usage counters are optional
    }
    return appendAutoRecall(baseDecision, memories.slice(0, decision.limit), { maxChars: decision.maxChars })
  } catch (error) {
    logger?.(`[hippocampus] hub recall failed: ${error instanceof Error ? error.message : String(error)}`)
    return baseDecision
  }
}

/** Persist hub candidates through the shared, leased auto-capture writer. */
export function executeHubCapture(store, decision, { limit = 2, sourceSession = null, step = null, seen = null, namespace = '', now = Date.now(), logger, autoApprove = true } = {}) {
  if (!decision?.shouldWrite || !decision.candidates?.length) {
    return { captured: 0, candidates: [], skipped: decision?.reason ?? 'hub-no-candidate', trusted: 0, review: 0 }
  }
  const sources = Array.isArray(decision.sources) ? decision.sources : []
  const keys = sources.map((source) => textHash(String(source?.text ?? '')))
  const key = textHash(keys.join('|') || decision.candidates.map((item) => item.content).join('|'))
  if (seen instanceof Map && (seen.has(key) || keys.every((k) => seen.has(k)))) {
    return { captured: 0, candidates: [], skipped: 'duplicate-step', trusted: 0, review: 0 }
  }
  const limited = decision.candidates.slice(0, Math.max(1, limit))
  // Autonomy: a high-confidence, explicitly-anchored fact written by a human
  // takes effect immediately and can be recalled in the very next turn. Only
  // weaker / machine-derived candidates stay in the human review queue.
  // This is deterministic: no model, no network, no manual step on the hot path.
  const isTrusted = (candidate) =>
    autoApprove &&
    candidate.role === 'user' &&
    Number(candidate.confidence) >= 0.85 &&
    Number(candidate.score) >= decision.writeThreshold &&
    (candidate.kind === 'persona' || candidate.kind === 'semantic')
  const trusted = limited.filter(isTrusted).length
  const review = limited.length - trusted
  try {
    const result = writeCandidates(store, limited, {
      namespace: namespace || decision.candidates[0]?.namespace || '',
      limit,
      sourceSession,
      step,
      seen,
      now,
      key,
      seenKeys: keys,
      decorate: (candidate) => ({
        // Hub decisions classify into persona/semantic/episodic/buffer rather
        // than always episodic.
        tags: [...new Set([...(candidate.tags ?? []), 'memory-hub', 'auto-capture'])],
        metadata: {
          autoCapture: {
            review: isTrusted(candidate) ? 'approved' : 'pending',
            role: candidate.role ?? 'user',
            step,
            cue: candidate.cue,
            personaLike: candidate.personaLike,
            capturedAt: now,
            engine: 'memory-hub',
            hubVersion: 1,
          },
          memoryHub: {
            version: 1,
            deterministic: true,
            llm: false,
            autoApproved: isTrusted(candidate),
            score: candidate.score,
            reason: candidate.reason,
            signals: (candidate.signals ?? []).map((signal) => signal.name),
            writeThreshold: decision.writeThreshold,
          },
        },
      }),
    })
    return { ...result, trusted, review }
  } catch (error) {
    logger?.(`[hippocampus] hub capture failed: ${error instanceof Error ? error.message : String(error)}`)
    return { captured: 0, candidates: limited, skipped: 'error', trusted, review }
  }
}

/**
 * One pre-step turn: plan → read → write. Returns the (possibly augmented)
 * agent decision plus a compact, log-safe summary for the host plugin.
 */
export function runMemoryHub(store, messages, baseDecision, config = {}, context = {}) {
  const options = hubOptionsFromConfig({ ...config, now: context.now ?? Date.now() })
  // Spread `options.now` into the top level too: hubPlan() reads it as `at`.
  const plan = hubPlan(messages, { ...options, now: options.now })
  const namespace = config.autoRecallNamespace || config.hubNamespace || ''
  const finalDecision = executeHubRecall(store, plan.recall, baseDecision, {
    namespace,
    logger: context.logger,
  })
  const capture = executeHubCapture(store, plan.capture, {
    limit: options.capture.captureMaxCandidates,
    namespace: config.hubNamespace || config.autoCaptureNamespace || '',
    sourceSession: context.sourceSession ?? null,
    step: context.step ?? null,
    seen: context.seen,
    now: options.now,
    logger: context.logger,
    autoApprove: config.hubAutoApprove !== false,
  })
  return {
    decision: finalDecision,
    plan,
    capture,
    summary: {
      engine: 'memory-hub',
      llm: false,
      deterministic: true,
      read: plan.recall.shouldRead,
      readScore: plan.recall.score,
      readSuppressedBy: plan.recall.suppressedBy,
      write: plan.capture.shouldWrite,
      writeScore: plan.capture.score,
      captured: capture.captured ?? 0,
      trusted: capture.trusted ?? 0,
      review: capture.review ?? 0,
      candidates: plan.capture.candidates.length,
      suppressed: plan.capture.suppressed.length,
    },
  }
}

/** Stable hash helper re-exported for callers that keep their own seen map. */
export function hubSeenKey(messages = []) {
  return createHash('sha256')
    .update(messages.map((message) => String(message?.id ?? '')).join('|'))
    .digest('hex')
    .slice(0, 24)
}
