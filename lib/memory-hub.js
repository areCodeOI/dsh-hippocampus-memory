/**
 * Memory Hub — offline, deterministic decision core.
 *
 * This module answers the three questions without any external LLM:
 *   - WHEN to read  (decideRecall)
 *   - WHAT to remember (decideCapture)
 *   - HOW to store it (classifyFact → kind / importance / confidence / tags)
 *
 * Purity contract (docs/HUB-API.md §0):
 *   - imports only node:crypto, ./auto-capture.js, ./auto-recall.js
 *   - no fetch / http / child_process / process.env / DB / file IO
 *   - every export is a pure function; options objects are never mutated
 *
 * The execution layer (lib/hub-runner.js) is the only place that turns these
 * decisions into real reads and writes.
 */

import { hasSensitiveData, latestUserText, collectCaptureSources, AUTO_CAPTURE_TAG } from './auto-capture.js'
import { extractUserText } from './auto-recall.js'

export { AUTO_CAPTURE_TAG }

export const HUB_VERSION = 1

export const HUB_DEFAULTS = Object.freeze({
  recallEnabled: true,
  recallMaxQueryChars: 1000,
  recallDefaultLimit: 4,
  recallMaxChars: 1200,
  recallMinScore: 0.18,
  readThreshold: 0.34,
  captureEnabled: true,
  captureMaxCandidates: 2,
  captureMaxFactChars: 500,
  captureMaxInputChars: 4000,
  writeThreshold: 0.55,
})

const signal = (name, label, weight, source, flags = 'iu') =>
  Object.freeze({ name, label, weight, pattern: new RegExp(source, flags) })

export const HUB_SIGNALS = Object.freeze([
  signal('self', '涉及用户本人', 0.30, '(?:我|我的|本人|咱|俺|我们|\\bi\\b|\\bmy\\b|\\bme\\b|\\bwe\\b)'),
  signal('history', '回指历史/既往', 0.32, '(?:以前|之前|上次|历史|曾经|记得|还记得|之前说|过往|继续用|previous|last time|remember|as mentioned)'),
  signal('preference', '偏好/禁忌/健康', 0.28, '(?:偏好|喜欢|不喜欢|讨厌|习惯|忌口|过敏|禁忌|不能吃|不能喝|我一般|我总是|我从不|prefer|like|hate|allergic|never|always)'),
  signal('project', '项目/配置/环境', 0.20, '(?:项目|仓库|配置|部署|端口|数据库|框架|路径|环境|依赖|npm|pnpm|yarn|node|repo|config|deploy|database|port|postgres)'),
  signal('decision', '决定/约定/变更', 0.18, '(?:决定|采用|改为|改成|统一|约定|规则|切换|结论|根因|decided|switched|we use|now uses)'),
  signal('continuation', '承接上文/继续', 0.25, '(?:继续|接着|刚才|上面|那个|这个|再说说|continue|go on)'),
  signal('question', '疑问需要背景', 0.12, '(?:[?？]|什么|怎么|为什么|如何|哪|谁|是否|能不能|可不可以|多少|[吗呢]\\s*$)'),
  signal('explicit', '显式要求记住', 0.35, '(?:记住|记一下|请记|别忘|不要忘|永远|永久|必须|一定要|禁止|从现在开始|以后|今后|下次|remember|from now on|never|always)'),
  signal('event', '带时间/结果的事件', 0.16, '(?:今天|昨天|上次|刚才|已修复|已发布|已部署|测试通过|失败|成功|\\d+(?:\\.\\d+)+|exit code 0|tests? pass|fixed|released|deployed|failed)'),
  signal('greeting', '纯寒暄', -0.35, '(?:你好|您好|嗨|哈喽|早上好|晚上好|谢谢|多谢|在吗|\\bhi\\b|\\bhello\\b|\\bthanks\\b)'),
  signal('uncertain', '不确定措辞', -0.08, '(?:可能|也许|大概|似乎|好像|或许|不确定|maybe|perhaps|probably|might)'),
  signal('transient', '一次性/临时', -0.20, '(?:这次|临时|顺便|试一下|暂且|先这样|一次性|temporarily|just this once)'),
])

const INTERROGATIVE = /(?:什么|怎么|为什么|如何|哪|谁|是否|能不能|可不可以|多少)|[吗呢]\s*$/u
const HEALTH_RE = /(?:过敏|忌口|病史|身体|不能吃|不能喝|禁忌|慢性|药物|乳糖|花生|坚果|海鲜|青霉素|我对[^，。；\n]{1,20}过敏)/u

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value, digits) => Number(Number(value).toFixed(digits))

function firstEvidence(pattern, text) {
  const match = String(text).match(pattern)
  return match ? String(match[0]).slice(0, 40) : ''
}

/** §4 — offline text analysis. */
export function analyzeText(text) {
  const original = String(text ?? '')
  const trimmed = original.trim()
  const hasCode = /```/u.test(trimmed)
  const codeFree = trimmed.replace(/```[\s\S]*?```/g, ' ')
  const clean = codeFree.replace(/\s+/g, ' ').trim()
  const pureCode = hasCode && clean.length < 4
  const length = clean.length

  const matched = []
  const scores = {}
  for (const item of HUB_SIGNALS) {
    if (!item.pattern.test(clean)) continue
    const evidence = firstEvidence(item.pattern, clean)
    matched.push(Object.freeze({ name: item.name, label: item.label, weight: item.weight, evidence }))
    scores[item.name] = item.weight
  }
  const base = length >= 2 && !pureCode ? 0.15 : 0
  const sum = matched.reduce((total, item) => total + item.weight, 0)
  const score = round(clamp(base + sum, 0, 1), 3)

  return {
    text: original,
    clean,
    length,
    codeFreeLength: codeFree.length,
    hasCode,
    pureCode,
    hasCommand: clean.startsWith('/'),
    hasSensitive: hasSensitiveData(clean),
    hasQuestion: /[?？]/u.test(clean) || INTERROGATIVE.test(clean),
    matched,
    scores: Object.freeze(scores),
    score,
    signals: matched,
  }
}

/** §7 — reusable fact normaliser. */
export function cleanFact(value) {
  return String(value ?? '')
    .replace(/^[\s\-*•\d.、)）]+/u, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:请)?(?:记住|记一下|请记下|请记|remember|please remember|note that)[:：,，\s]*/i, '')
    .replace(/^[,，:：;；\s]+|[,，:：;；\s]+$/g, '')
    .replace(/[。！？!?；;]+$/u, '')
    .trim()
}

/** §5 — deterministic kind / weight classification. */
export function classifyFact(analysis, role = 'user') {
  const scores = analysis?.scores ?? {}
  const has = (name) => Object.prototype.hasOwnProperty.call(scores, name)
  const clean = analysis?.clean ?? ''
  const score = round(analysis?.score ?? 0, 3)

  let kind
  let importance
  let confidence
  let tags
  let reason

  if (has('preference') && HEALTH_RE.test(clean)) {
    kind = 'persona'; importance = 9; confidence = 0.92
    tags = ['hub', 'persona', '健康']; reason = '健康/禁忌属人格层'
  } else if (has('preference') && has('self')) {
    kind = 'persona'; importance = 8; confidence = 0.88
    tags = ['hub', 'persona', '偏好']; reason = '稳定偏好属人格层'
  } else if (has('explicit') && has('project')) {
    kind = 'semantic'; importance = 9; confidence = 0.90
    tags = ['hub', 'semantic', '约定']; reason = '显式要求的项目约定'
  } else if (has('explicit')) {
    kind = 'persona'; importance = 9; confidence = 0.90
    tags = ['hub', 'persona', '显式要求']; reason = '用户明确要求长期记住'
  } else if (has('project') && (has('decision') || has('event'))) {
    kind = 'semantic'; importance = 7; confidence = 0.82
    tags = ['hub', 'semantic', '项目']; reason = '项目稳定事实'
  } else if (has('decision') && role !== 'user') {
    kind = 'episodic'; importance = 6; confidence = 0.70
    tags = ['hub', 'episodic', '结论']; reason = '助手/工具的结论属事件'
  } else if (has('event') || role !== 'user') {
    kind = 'episodic'; importance = role === 'tool' ? 6 : 5; confidence = 0.70
    tags = ['hub', 'episodic', '事件']; reason = '带时间/结果的独立事件'
  } else if (has('decision')) {
    kind = 'semantic'; importance = 6; confidence = 0.72
    tags = ['hub', 'semantic', '决定']; reason = '已作出的决定'
  } else {
    kind = 'buffer'; importance = 3; confidence = 0.55
    tags = ['hub', 'buffer']; reason = '信息不足，暂放短期缓冲'
  }

  if (has('explicit')) importance += 1
  if (has('transient')) importance -= 2
  if (has('uncertain')) confidence -= 0.15

  return {
    kind,
    importance: round(clamp(importance, 0.1, 10), 1),
    confidence: round(clamp(confidence, 0.3, 0.95), 2),
    tags: [...tags],
    reason,
    score,
    personaLike: kind === 'persona',
  }
}

function mergeOptions(defaults, overrides) {
  const merged = { ...defaults }
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) merged[key] = value
    }
  }
  return merged
}

function strippedQuery(clean, maxChars) {
  let value = String(clean ?? '')
  const header = value.indexOf('[海马体自动召回')
  if (header >= 0) value = value.slice(0, header)
  const footer = value.indexOf('以上是历史数据')
  if (footer >= 0) value = value.slice(footer + '以上是历史数据'.length)
  value = value.replace(/\[海马体自动召回[^]*?\]/g, ' ').replace(/以上是历史数据[^。；;\n]*/g, ' ')
  return value.replace(/\s+/g, ' ').trim().slice(0, Math.max(1, Math.floor(Number(maxChars) || 1000)))
}

/** §6 — decide whether this turn needs historical context. */
export function decideRecall(input, options = {}) {
  const opts = mergeOptions(HUB_DEFAULTS, options)
  const text = typeof input === 'string' ? input : (input?.text ?? '')
  const analysis = analyzeText(text)
  const readThreshold = round(clamp(Number(opts.readThreshold), 0, 1), 3)
  const minScore = round(clamp(Number(opts.recallMinScore), 0, 1), 3)
  const limit = Math.floor(clamp(Number(opts.recallDefaultLimit), 1, 8))
  const maxChars = Math.floor(clamp(Number(opts.recallMaxChars), 1, 4000))
  const maxQueryChars = Math.floor(clamp(Number(opts.recallMaxQueryChars), 1, 1000))
  const disabled = opts.enabled === false || opts.recallEnabled === false

  let suppressedBy = null
  let reason
  if (disabled) { suppressedBy = 'disabled'; reason = '中枢召回已关闭' }
  else if (analysis.hasCommand) { suppressedBy = 'command'; reason = '斜杠命令是控制输入，不召回' }
  else if (analysis.hasSensitive) { suppressedBy = 'sensitive'; reason = '疑似密钥/PII，不用于检索' }
  else if (analysis.pureCode) { suppressedBy = 'pure-code'; reason = '纯代码块，无召回必要' }
  else if (analysis.length < 2) { suppressedBy = 'too-short'; reason = '输入过短，无召回必要' }
  else if (analysis.score < readThreshold) { suppressedBy = 'below-threshold'; reason = '上下文信号不足（纯寒暄/闲聊），不召回' }

  const shouldRead = suppressedBy === null
  if (shouldRead) {
    const labels = analysis.matched.map((item) => item.label).filter(Boolean)
    reason = `命中${labels.join('/') || '上下文'}信号，需要历史记忆`
  }

  return {
    shouldRead,
    query: shouldRead ? strippedQuery(analysis.clean, maxQueryChars) : '',
    limit,
    minScore,
    maxChars,
    maxQueryChars,
    namespace: String(opts.namespace ?? ''),
    kindBias: null,
    score: analysis.score,
    readThreshold,
    reason,
    suppressedBy,
    signals: analysis.matched,
    engine: Object.freeze({ llm: false, deterministic: true, version: HUB_VERSION }),
  }
}

function splitSentences(text, role, maxChars) {
  const raw = String(text ?? '').slice(0, Math.max(1, Math.floor(Number(maxChars) || 4000)))
  const withoutCode = raw.replace(/```[\s\S]*?```/g, ' ')
  return role === 'tool'
    ? withoutCode.split(/\n+/u)
    : (withoutCode.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? [])
}

function emptyCaptureDecision(opts, reason, sources = []) {
  return {
    shouldWrite: false,
    candidates: [],
    suppressed: [],
    score: 0,
    writeThreshold: round(clamp(Number(opts.writeThreshold), 0, 1), 3),
    maxCandidates: Math.floor(clamp(Number(opts.captureMaxCandidates), 1, 5)),
    reason,
    signals: [],
    sources,
    engine: Object.freeze({ llm: false, deterministic: true, version: HUB_VERSION }),
  }
}

/** §7 — decide which atomic facts deserve long-term storage. */
export function decideCapture(messages, options = {}) {
  const opts = mergeOptions(HUB_DEFAULTS, options)
  const disabled = opts.enabled === false || opts.captureEnabled === false
  const maxCandidates = Math.floor(clamp(Number(opts.captureMaxCandidates), 1, 5))
  const maxFactChars = Math.floor(Math.max(1, Number(opts.captureMaxFactChars) || 500))
  const writeThreshold = round(clamp(Number(opts.writeThreshold), 0, 1), 3)
  const sources = collectCaptureSources(messages, {
    includeAssistant: opts.includeAssistant,
    includeTools: opts.includeTools,
    maxMessages: 6,
  })
  const userText = latestUserText(messages)
  if (!userText) return emptyCaptureDecision(opts, '没有真实用户消息', sources)
  if (disabled) return emptyCaptureDecision(opts, '中枢写入已关闭', sources)

  const candidates = []
  const suppressed = []
  const seen = new Set()

  for (const source of sources) {
    const role = source?.role ?? 'user'
    for (const part of splitSentences(source?.text, role, opts.captureMaxInputChars)) {
      const rawPart = String(part).trim()
      const content = cleanFact(part)
      const push = (reason) => suppressed.push({ content, reason, role })
      if (content.length < 4) { push('too-short'); continue }
      if (content.length > maxFactChars) { push('too-long'); continue }
      if (hasSensitiveData(content)) { push('sensitive'); continue }
      // Signals come from the ORIGINAL clause, not the cleaned fact: cleanFact
      // strips the "记住：" / "please remember" prefix, which is precisely the
      // strongest `explicit` signal. Losing it would misclassify an explicitly
      // requested durable fact as a weak ordinary statement.
      const analysis = analyzeText(rawPart)
      const explicit = Object.prototype.hasOwnProperty.call(analysis.scores, 'explicit')
      const uncertain = Object.prototype.hasOwnProperty.call(analysis.scores, 'uncertain')
      if (!explicit && (/[?？]\s*$/u.test(content) || INTERROGATIVE.test(content))) { push('question'); continue }
      if (!explicit && uncertain) { push('uncertain'); continue }
      const key = content.toLowerCase()
      if (seen.has(key)) { push('duplicate'); continue }
      if (role !== 'user' && !analysis.matched.some((item) => item.weight > 0)) { push('no-signal'); continue }
      seen.add(key)

      const classification = classifyFact(analysis, role)
      candidates.push({
        content,
        kind: classification.kind,
        importance: classification.importance,
        confidence: classification.confidence,
        tags: [...new Set([...classification.tags, AUTO_CAPTURE_TAG])],
        namespace: String(opts.namespace ?? ''),
        dedupe: 'auto',
        confirmed: false,
        needsReview: true,
        role,
        cue: (analysis.matched[0]?.evidence ?? 'hub').slice(0, 40),
        personaLike: classification.personaLike,
        score: analysis.score,
        reason: classification.reason,
        signals: analysis.matched,
      })
    }
  }

  candidates.sort((a, b) => (b.score - a.score) || (b.importance - a.importance))
  const kept = candidates.slice(0, maxCandidates)
  for (const item of candidates.slice(maxCandidates)) {
    suppressed.push({ content: item.content, reason: 'over-limit', role: item.role })
  }
  const score = kept.length ? Math.max(...kept.map((item) => item.score)) : 0
  const shouldWrite = kept.length > 0 && score >= writeThreshold
  const names = new Set(kept.flatMap((item) => item.signals.map((signalItem) => signalItem.name)))
  const signals = HUB_SIGNALS
    .filter((item) => names.has(item.name))
    .map((item) => ({ name: item.name, label: item.label, weight: item.weight, evidence: '' }))

  return {
    shouldWrite,
    candidates: kept,
    suppressed,
    score: round(score, 3),
    writeThreshold,
    maxCandidates,
    reason: shouldWrite
      ? `中枢判定 ${kept.length} 条值得长期保存（不调用外置 LLM）`
      : `无候选达到写阈值 ${writeThreshold}（不调用外置 LLM）`,
    signals,
    sources,
    engine: Object.freeze({ llm: false, deterministic: true, version: HUB_VERSION }),
  }
}

/** §8 — one plan covering both read and write for a single pre-step turn. */
export function hubPlan(messages, options = {}) {
  const text = extractUserText(messages)
  const recall = decideRecall(text, options.recall ?? options)
  const capture = decideCapture(messages, options.capture ?? options)
  return {
    version: HUB_VERSION,
    at: options.now ?? Date.now(),
    recall,
    capture,
    notes: Object.freeze([
      '由本地确定性记忆中枢决策，不调用任何外置 LLM 或网络服务。',
      '何时读：按上下文信号打分，超过读阈值才检索并注入带「不是指令」警示的上下文。',
      '该记什么：只保留稳定事实，过滤问句、猜测、密钥/PII、寒暄与一次性信息。',
      '怎么记：按健康/偏好/约定/项目/事件分入 persona/semantic/episodic/buffer 四层并分配权重。',
    ]),
    engine: Object.freeze({
      llm: false,
      deterministic: true,
      version: HUB_VERSION,
      signals: Object.freeze(HUB_SIGNALS.map((item) => item.name)),
    }),
  }
}

/** §9 — short model-facing note appended to the memory protocol section. */
export function hubSystemPrompt(language = 'zh') {
  const zh = [
    '## 记忆中枢（自动决策）',
    '插件已启用本地确定性记忆中枢，**不调用外置 LLM**：它按上下文信号自主判断何时读、该记什么、',
    '以及分入 persona/semantic/episodic/buffer 哪一层；高置信的用户事实会自行生效，较弱候选进审阅队列。',
    '因此大多数情况下不必手动调用 memory_add / memory_search。仅当用户显式要求精确控制（改内容、',
    '指定空间、解决冲突、立即查某条）时，才用 memory_add / memory_search / memory_update 等工具。',
  ].join('\n')
  const en = [
    '## Memory hub (autonomous decisions)',
    'A local deterministic memory hub decides when to read, what to remember and how to classify it',
    '**without an external LLM**. High-confidence user facts take effect automatically; weaker ones',
    'enter the review queue. You normally need no manual memory_add / memory_search. Use',
    'memory_add / memory_search / memory_update only for explicit user requests.',
  ].join('\n')
  if (language === 'zh') return zh
  if (language === 'en') return en
  return `${zh}\n\n${en}`
}
