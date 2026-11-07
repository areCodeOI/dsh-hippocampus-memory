/**
 * Importance, decay and retrieval scoring.
 *
 * Weight = original importance × e^(−λ_kind × days since last access).
 * Importance is a property of the fact; weight is how much it still matters.
 */

import {
  DECAY,
  DEFAULT_IMPORTANCE,
  MAX_IMPORTANCE,
  MIN_IMPORTANCE,
  KIND_LABELS,
} from './constants.js'
import { similarityTokens, matchedTerms, normalize } from './text.js'

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Hybrid-retrieval vector weight from the environment.
 *
 * `0` is a valid value (disable vector blending), so `Number(raw) || 0.35`
 * would silently ignore it. Invalid or missing values fall back to 0.35.
 */
export function vectorWeightFromEnv(env = process.env) {
  const raw = env?.HIPPOCAMPUS_VECTOR_WEIGHT
  if (raw === undefined || raw === null || raw === '') return 0.35
  const value = Number(raw)
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0.35
}

const STRONG_CUES = [
  '记住', '牢记', '别忘', '重要', '必须', '永远', '永久', '千万', '务必',
  '密码', '账号', '账户', '身份证', '手机号', '地址', '过敏', '病史', '身体',
  '偏好', '禁忌', '底线', '原则', '习惯', '生日', '纪念日',
  'remember', 'always', 'never', 'important', 'password', 'allergic', 'birthday',
]

/** Heuristic importance when the caller omits it. */
export function inferImportance(kind, content, explicit) {
  if (explicit !== undefined && explicit !== null && Number.isFinite(Number(explicit))) {
    return clamp(Number(explicit), MIN_IMPORTANCE, MAX_IMPORTANCE)
  }
  let base = DEFAULT_IMPORTANCE[kind] ?? 3
  const norm = normalize(content)
  if (STRONG_CUES.some((cue) => norm.includes(cue))) base += 2
  if (kind === 'persona') base = Math.max(base, 8)
  if (kind === 'semantic') base = Math.max(base, 6)
  return clamp(base, MIN_IMPORTANCE, MAX_IMPORTANCE)
}

export function daysSince(timestamp, now = Date.now()) {
  if (!timestamp) return 0
  return Math.max(0, (now - timestamp) / 86_400_000)
}

/** Current decayed weight of a memory in [0.05, 10]. */
export function effectiveWeight(memory, now = Date.now()) {
  const kind = memory.kind ?? 'episodic'
  const lambda = DECAY[kind] ?? DECAY.episodic
  const last = memory.lastAccessAt ?? memory.updatedAt ?? memory.createdAt ?? now
  const weight = (memory.importance ?? 3) * Math.exp(-lambda * daysSince(last, now))
  return clamp(weight, 0.05, MAX_IMPORTANCE)
}

/** 0..1 recency, slow enough that month-old semantic memories stay relevant. */
export function recencyFactor(memory, now = Date.now()) {
  const last = memory.lastAccessAt ?? memory.updatedAt ?? memory.createdAt ?? now
  return Math.exp(-daysSince(last, now) / 120)
}

const KIND_BOOST = { buffer: 0.3, episodic: 0.6, semantic: 0.9, persona: 1 }

/**
 * Lexical relevance in [0,1]. Coverage (how much of the query is present) is
 * primary; an exact substring of the query adds a bonus; a multi-term match
 * adds a little more.
 */
export function lexicalScore(query, memory) {
  const q = similarityTokens(query)
  if (!q.length) return 0
  const haystack = `${memory.content} ${(memory.tags ?? []).join(' ')}`
  const mem = new Set(similarityTokens(haystack))
  let matched = 0
  for (const token of q) if (mem.has(token)) matched += 1
  const coverage = matched / q.length
  const phrase = normalize(query)
  const exact = phrase.length >= 2 && normalize(haystack).includes(phrase) ? 0.2 : 0
  const multi = matched >= 2 ? 0.08 : 0
  return clamp(coverage * 0.85 + exact + multi, 0, 1)
}

/**
 * Final retrieval score in [0,1]. Lexical relevance dominates; decayed weight,
 * recency, confidence and the memory layer are tie-breakers.
 */
export function retrievalScore(query, memory, now = Date.now(), weightOverride) {
  const weight = weightOverride ?? effectiveWeight(memory, now)
  const lexical = query ? lexicalScore(query, memory) : 0
  const kindBoost = KIND_BOOST[memory.kind] ?? 0.5
  const score = query
    ? 0.55 * lexical + 0.22 * (weight / 10) + 0.1 * recencyFactor(memory, now) + 0.08 * (memory.confidence ?? 0.7) + 0.05 * kindBoost
    : 0.5 * (weight / 10) + 0.25 * recencyFactor(memory, now) + 0.15 * (memory.confidence ?? 0.7) + 0.1 * kindBoost
  return clamp(score, 0, 1)
}

function humanAge(timestamp, now) {
  const days = daysSince(timestamp, now)
  if (days < 1 / 24) return '刚刚'
  if (days < 1) return `${Math.round(days * 24)} 小时前`
  if (days < 30) return `${Math.round(days)} 天前`
  if (days < 365) return `${Math.round(days / 30)} 个月前`
  return `${(days / 365).toFixed(1)} 年前`
}

/** One-line, human-readable reason for a recall result. */
export function buildWhy(query, memory, now = Date.now()) {
  const parts = []
  if (query) {
    const terms = matchedTerms(query, memory.content)
    if (terms.length) parts.push(`匹配「${terms.join('、')}」`)
  }
  parts.push(`重要性 ${(memory.importance ?? 0).toFixed(1)}/10`)
  parts.push(`${KIND_LABELS[memory.kind] ?? memory.kind}`)
  if (memory.lastAccessAt) parts.push(`${humanAge(memory.lastAccessAt, now)}访问过`)
  else parts.push(`${humanAge(memory.createdAt, now)}写入`)
  if ((memory.confidence ?? 1) < 0.8) parts.push(`置信度 ${Math.round((memory.confidence ?? 0) * 100)}%`)
  if (memory.status === 'conflict') parts.push('待确认冲突，未必为真')
  return parts.join('；')
}

/** Effective weight grouped by layer, for stats. */
export function weightBreakdown(memories, now = Date.now()) {  const out = {}
  for (const memory of memories) {
    const bucket = (out[memory.kind] ??= { count: 0, total: 0, avg: 0 })
    bucket.count += 1
    bucket.total += effectiveWeight(memory, now)
  }
  for (const bucket of Object.values(out)) {
    bucket.total = Number(bucket.total.toFixed(2))
    bucket.avg = Number((bucket.total / bucket.count).toFixed(2))
  }
  return out
}
