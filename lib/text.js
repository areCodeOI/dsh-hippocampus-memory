/**
 * Language-agnostic text utilities.
 *
 * Chinese has no spaces, and SQLite's built-in tokenizers are weak for CJK, so
 * we normalize and pre-segment text ourselves:
 *   - Latin/number runs become word tokens;
 *   - CJK runs become unigrams (for single-character queries) and bigrams
 *     (the meaningful unit for Chinese retrieval).
 *
 * Index tokens and similarity tokens are deliberately different: indexing keeps
 * unigrams so a one-character query can match, while similarity uses bigrams so
 * unrelated sentences do not look alike.
 */

import { createHash } from 'node:crypto'

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const WORD_RUN = /[a-z0-9][a-z0-9_+#.-]*/g

const STOPWORDS = new Set([
  // English function words
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is',
  'are', 'was', 'were', 'be', 'been', 'this', 'that', 'it', 'as', 'by',
  'from', 'at', 'my', 'me', 'i', 'you', 'we', 'they', 'he', 'she',
  // Chinese function words (negations are intentionally kept)
  '的', '了', '是', '在', '和', '与', '及', '或', '我', '你', '他', '她', '它',
  '我们', '你们', '他们', '这', '那', '这些', '那些', '有', '就', '也', '很',
  '都', '要', '会', '着', '过', '而', '但', '但是', '因为', '所以', '如果',
  '然后', '一个', '一下', '什么', '怎么', '可以', '这个', '那个', '已经',
  '还是', '只是', '被', '把', '给', '对', '从', '到', '里', '上', '下', '中',
  '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '请', '帮我', '一个',
])

const CJK_STOP_CHARS = new Set('的了是在和与及或我你他她它这那有就也很都要会着过而但被把给对从到里上下中吗呢吧啊呀哦嗯请'.split(''))

/** NFKC-normalize, lowercase, collapse whitespace. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\uFEFF]/g, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

/** Collapse whitespace and trim, preserving case and punctuation. */
export function cleanContent(text) {
  // Preserve the user's original punctuation (NFKC would turn Chinese full-width
  // commas into ASCII commas); only strip invisible characters and whitespace.
  return String(text ?? '')
    .replace(/[\u200b-\u200f\uFEFF]/g, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

function addRunTokens(run, out, { unigrams }) {
  if (run.length === 1) {
    if (!CJK_STOP_CHARS.has(run)) out.add(run)
    return
  }
  for (let i = 0; i < run.length - 1; i += 1) {
    const bg = run.slice(i, i + 2)
    if (!CJK_STOP_CHARS.has(bg[0]) || !CJK_STOP_CHARS.has(bg[1])) out.add(bg)
  }
  if (unigrams) {
    for (const ch of run) if (!CJK_STOP_CHARS.has(ch)) out.add(ch)
  }
}

/**
 * Tokens used to build and query the FTS index.
 * @param {string} text
 * @returns {string[]}
 */
export function searchTokens(text) {
  const norm = normalize(text)
  const out = new Set()
  for (const m of norm.matchAll(WORD_RUN)) {
    const tok = m[0].replace(/[.-]+$/, '')
    if (tok.length >= 2 && !STOPWORDS.has(tok)) out.add(tok)
  }
  for (const m of norm.matchAll(CJK_RUN)) addRunTokens(m[0], out, { unigrams: true })
  return [...out].sort()
}

/**
 * Tokens used for similarity / dedupe / conflict detection.
 * @param {string} text
 * @returns {string[]}
 */
export function similarityTokens(text) {
  const norm = normalize(text)
  const out = new Set()
  for (const m of norm.matchAll(WORD_RUN)) {
    const tok = m[0].replace(/[.-]+$/, '')
    if (tok.length >= 1 && !STOPWORDS.has(tok)) out.add(tok)
  }
  for (const m of norm.matchAll(CJK_RUN)) addRunTokens(m[0], out, { unigrams: false })
  return [...out]
}

/** Sorted, space-joined tokens suitable for a `unicode61` FTS column. */
export function indexText(text) {
  return searchTokens(text).join(' ')
}

/** Stable content hash for exact-duplicate detection. */
export function contentHash(text) {
  return createHash('sha256').update(normalize(text)).digest('hex').slice(0, 32)
}

/**
 * Similarity in [0,1], combining Dice and containment so a strict superset
 * (the same fact with extra detail) scores high while two loosely related
 * sentences do not.
 * @param {string[]} a
 * @param {string[]} b
 */
export function tokenSimilarity(a, b) {
  if (!a.length || !b.length) return 0
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter += 1
  const dice = (2 * inter) / (sa.size + sb.size)
  const containment = inter / Math.min(sa.size, sb.size)
  return Math.min(1, Math.max(dice, containment * 0.92))
}

/** Similarity between two raw strings. */
export function similarity(a, b) {
  return tokenSimilarity(similarityTokens(a), similarityTokens(b))
}

/** True when `a`'s token set is a subset of `b`'s (a is the shorter, older fact). */
export function isStrictExpansion(a, b) {
  const sa = new Set(similarityTokens(a))
  const sb = new Set(similarityTokens(b))
  if (!sa.size || sa.size >= sb.size) return false
  for (const t of sa) if (!sb.has(t)) return false
  return sa.size / sb.size >= 0.5
}

const OPPOSITE_PAIRS = [
  ['喜欢', '讨厌'], ['喜爱', '厌恶'], ['支持', '反对'], ['赞成', '反对'],
  ['启用', '禁用'], ['开启', '关闭'], ['打开', '关闭'], ['接受', '拒绝'],
  ['要', '不要'], ['能', '不能'], ['可以', '不可以'], ['是', '不是'],
  ['同意', '不同意'], ['推荐', '不推荐'], ['like', 'hate'], ['love', 'hate'],
  ['enable', 'disable'], ['enabled', 'disabled'], ['always', 'never'],
  ['yes', 'no'], ['true', 'false'], ['allow', 'deny'],
]

const NEGATION = /(不|别|勿|未|没有|无需|禁止|停止|避免|never|not|no\b|don't|do not|avoid|disable)/
// Capture IPs, versions, dates and plain numbers as one unit so 10.0.0.7 is not
// reported as three unrelated numbers.
const NUMBER = /\d+(?:[.:/-]\d+)*/g

function hasOppositePair(a, b) {
  for (const [x, y] of OPPOSITE_PAIRS) {
    if ((a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x))) {
      return `${x} / ${y}`
    }
  }
  return null
}

/**
 * Heuristic contradiction check between two descriptions of the same thing.
 * Deliberately conservative: a flagged conflict is only a proposal for the user
 * to confirm, never an automatic overwrite.
 *
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {{ conflict: boolean, reason?: string }}
 */
export function detectConflict(oldContent, newContent) {
  const oldNorm = normalize(oldContent)
  const newNorm = normalize(newContent)
  if (oldNorm === newNorm) return { conflict: false }
  const sim = similarity(oldNorm, newNorm)
  if (sim < 0.5) return { conflict: false }

  const pair = hasOppositePair(oldNorm, newNorm)
  if (pair) return { conflict: true, reason: `极性相反（${pair}）` }

  const oldNums = (oldNorm.match(NUMBER) ?? []).sort()
  const newNums = (newNorm.match(NUMBER) ?? []).sort()
  const numbersDiffer = oldNums.length > 0 && newNums.length > 0 && oldNums.join(',') !== newNums.join(',')
  if (numbersDiffer && sim >= 0.55) {
    return { conflict: true, reason: `同一事实中的数值不同（${oldNums.join('/')} vs ${newNums.join('/')}）` }
  }

  const oldNeg = NEGATION.test(oldNorm)
  const newNeg = NEGATION.test(newNorm)
  if (oldNeg !== newNeg && sim >= 0.66) {
    return { conflict: true, reason: '一方含否定表述，另一方不含' }
  }

  return { conflict: false }
}

/** First sentence or a safe truncation, for summaries and replay. */
export function summarize(text, max = 80) {
  const cleaned = cleanContent(text)
  if (cleaned.length <= max) return cleaned
  const sentenceEnd = cleaned.search(/[。！？!?；;\n]/)
  if (sentenceEnd > 8 && sentenceEnd <= max) return cleaned.slice(0, sentenceEnd + 1)
  return `${cleaned.slice(0, max - 1).trimEnd()}…`
}

/** Split a long fact into sentences (used by consolidation). */
export function sentences(text) {
  return cleanContent(text)
    .split(/(?<=[。！？!?；;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Ranking tokens shared by a query and a memory, used for the "why recalled"
 * explanation. Bigrams are preferred over unigrams so explanations read well.
 */
export function matchedTerms(query, content, max = 5) {
  const qn = normalize(query)
  const cn = normalize(content)
  if (!qn) return []
  if (qn.length >= 2 && cn.includes(qn)) return [qn]
  // Prefer whole words / contiguous CJK segments that appear verbatim, so the
  // explanation reads "花生过敏" instead of the overlapping bigrams "花生、生过".
  const segments = qn.split(/[^\p{Script=Han}\p{L}\p{N}]+/u).filter((part) => part.length >= 2)
  const verbatim = []
  for (const segment of segments) {
    if (!cn.includes(segment)) continue
    if (verbatim.some((entry) => entry.includes(segment) || segment.includes(entry))) continue
    verbatim.push(segment)
  }
  if (verbatim.length) return verbatim.slice(0, max)
  const q = similarityTokens(query)
  const c = new Set(similarityTokens(content))
  const unique = [...new Set(q.filter((t) => c.has(t) && t.length >= 2))]
  if (unique.length) return unique.slice(0, max)
  return q.filter((t) => c.has(t)).slice(0, max)
}
