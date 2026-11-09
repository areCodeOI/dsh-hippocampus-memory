/**
 * Opt-in auto-capture lite.
 *
 * Captures a small number of explicit, stable user statements from the latest
 * user message. It is intentionally local and deterministic: no model call, no
 * whole-conversation dump, and no secret-looking text. The caller still owns
 * the opt-in flag and the target namespace.
 */

import { createHash } from 'node:crypto'
import { AUTO_RECALL_SOURCE } from './auto-recall.js'

export const AUTO_CAPTURE_SOURCE = 'hippocampus-auto-capture'
export const AUTO_CAPTURE_TAG = 'auto-capture'

const MAX_INPUT = 4000
const MAX_FACT = 500
const SEEN_TTL_MS = 2 * 60 * 1000

const SENSITIVE =
  /(?:password|passwd|pwd|api[_-]?key|access[_-]?token|client[_-]?secret|secret|private[_-]?key|bearer\s+[a-z0-9._~+/-]{16,}|ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9]{16,}|akia[0-9a-z]{16}|私钥|密码|口令|验证码|身份证|银行卡|信用卡|cvv)/i

const CUE =
  /(?:记住|记一下|请记|以后|今后|从现在开始|下次|别再|不要再|不要|必须|一定要|禁止|我喜欢|我不喜欢|我讨厌|我习惯|我偏好|我对[^，。；\n]{1,24}过敏|我不能|我需要|我的[^，。；\n]{1,24}(?:是|在|用)|我们用|我一般|我总是|我从不|项目(?:用|使用|叫|在)|仓库(?:在|是)|部署(?:在|到|用)|配置(?:是|为)|决定(?:用|采用|改成)|约定|统一(?:用|使用)|规则(?:是|为)|端口(?:是|为)|数据库(?:是|用)|remember|from now on|always|never|i prefer|i like|i hate|i(?:'| a)m allergic|we use|we decided|deploy|config(?:ured)?)/i

const PERSONA_CUE =
  /(?:过敏|喜欢|不喜欢|讨厌|习惯|偏好|忌口|不要|别再|禁止|必须|一定|我不能|我从不|i prefer|i like|i hate|allergic|never|always)/i

const IMPERATIVE =
  /(?:记住|记一下|请记|以后|今后|从现在开始|下次|别再|不要再|不要|必须|一定要|禁止|remember|from now on|never|always)/i

const UNCERTAIN = /(?:可能|也许|大概|似乎|好像|或许|maybe|perhaps|probably|might)/i

export function latestUserText(messages = []) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    if (message.source?.kind === AUTO_RECALL_SOURCE) continue
    const parts = []
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    const text = parts.join('\n').trim()
    if (text) return text.slice(0, MAX_INPUT)
  }
  return ''
}

function cleanFact(value) {
  return String(value ?? '')
    .replace(/^[\s\-*•\d.、)）]+/u, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:请)?(?:记住|记一下|请记下|请记|remember|please remember|note that)[:：,，\s]*/i, '')
    .replace(/^[,，:：;；\s]+|[,，:：;；\s]+$/g, '')
    .replace(/[。！？!?；;]+$/u, '')
    .trim()
}

/** One message is skipped entirely if it looks like it carries a credential. */
export function hasSensitiveData(text) {
  return SENSITIVE.test(String(text ?? ''))
}

export function shouldAutoCapture(text) {
  const value = String(text ?? '').trim()
  return value.length >= 4 && !value.startsWith('/') && !hasSensitiveData(value)
}

/**
 * Extract up to `limit` conservative candidate facts from one user message.
 * Returns plain objects so the caller can decide what to persist.
 */
export function extractCaptureCandidates(text, { limit = 2, maxChars = MAX_FACT } = {}) {
  const raw = String(text ?? '').slice(0, MAX_INPUT)
  if (!shouldAutoCapture(raw)) return []
  const withoutCode = raw.replace(/```[\s\S]*?```/g, ' ').trim()
  const parts = withoutCode.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? []
  const out = []
  const seen = new Set()
  for (const part of parts) {
    if (out.length >= Math.max(1, limit)) break
    const rawPart = part.trim()
    const question = /[?？]\s*$/.test(rawPart)
    const content = cleanFact(rawPart)
    if (content.length < 4 || content.length > maxChars) continue
    if (!CUE.test(content)) continue
    if (!IMPERATIVE.test(content) && question) continue
    if (!IMPERATIVE.test(content) && UNCERTAIN.test(content)) continue
    if (hasSensitiveData(content)) continue
    const key = content.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const personaLike = PERSONA_CUE.test(content)
    out.push({
      content,
      kind: 'episodic',
      importance: personaLike ? 7 : 5,
      confidence: 0.55,
      tags: [AUTO_CAPTURE_TAG, ...(personaLike ? ['auto-persona-candidate'] : [])],
      cue: (CUE.exec(content)?.[0] ?? '').slice(0, 40),
      personaLike,
    })
  }
  return out
}

function textHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}

function pruneSeen(seen, now) {
  if (!(seen instanceof Map) || seen.size <= 200) return
  for (const [key, at] of seen) {
    if (now - at > SEEN_TTL_MS) seen.delete(key)
  }
}

/**
 * Capture from the latest real user message. This is deliberately best-effort:
 * capture failures must never break the model step.
 */
export function captureUserMessage(store, messages, options = {}) {
  const {
    namespace = '',
    limit = 2,
    sourceSession = null,
    step = null,
    seen = null,
    now = Date.now(),
  } = options
  const text = latestUserText(messages)
  if (!shouldAutoCapture(text)) return { captured: 0, candidates: [], skipped: 'not-capturable' }
  pruneSeen(seen, now)
  const key = textHash(text)
  if (seen instanceof Map && seen.has(key)) return { captured: 0, candidates: [], skipped: 'duplicate-step' }
  const candidates = extractCaptureCandidates(text, { limit })
  if (!candidates.length) {
    if (seen instanceof Map) seen.set(key, now)
    return { captured: 0, candidates: [], skipped: 'no-candidate' }
  }
  const target = namespace && namespace !== '*' ? namespace : store.namespace
  const policy = store.namespacePolicy(target)
  if (policy.readOnly || policy.archived) {
    return { captured: 0, candidates, skipped: 'namespace-read-only' }
  }
  let captured = 0
  let chars = 0
  for (const candidate of candidates) {
    try {
      const result = store.add({
        content: candidate.content,
        kind: candidate.kind,
        importance: candidate.importance,
        confidence: candidate.confidence,
        tags: candidate.tags,
        namespace: target,
        source: AUTO_CAPTURE_SOURCE,
        sourceSession,
        confirmed: false,
        dedupe: 'auto',
        metadata: {
          autoCapture: {
            step,
            cue: candidate.cue,
            personaLike: candidate.personaLike,
          },
        },
      })
      if (result?.action !== 'rejected') {
        captured += 1
        chars += candidate.content.length
      }
    } catch {
      // Best effort: a single rejected capture must not affect the step.
    }
  }
  if (seen instanceof Map) seen.set(key, now)
  if (captured > 0) {
    try {
      store.recordAutoCapture({ count: captured, chars })
    } catch {
      // counters are optional
    }
  }
  return { captured, candidates, skipped: captured ? null : 'store-rejected' }
}
