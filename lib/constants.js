/**
 * Shared vocabulary for the hippocampus memory model.
 *
 * The four layers follow the complementary learning systems (CLS) idea:
 * a fast, volatile hippocampal buffer; episodic traces; slowly consolidated
 * semantic knowledge; and near-permanent persona preferences.
 */

export const KINDS = /** @type {const} */ (['buffer', 'episodic', 'semantic', 'persona'])

export const KIND_LABELS = {
  buffer: '短期缓冲',
  episodic: '情景记忆',
  semantic: '语义固化',
  persona: '人格记忆',
}

export const KIND_HINTS = {
  buffer: '最近会话的临时事件、临时偏好、未验证猜测；生命周期最短。',
  episodic: '带时间与场景的独立事件：何时、何地、发生了什么、结果如何；可回放复盘。',
  semantic: '多次验证后提炼出的稳定知识、长期偏好、固定事实；不轻易消失。',
  persona: '用户稳定习惯、审美、禁忌、底层诉求；权重最高，衰减最慢。',
}

export const STATUSES = /** @type {const} */ (['active', 'conflict', 'archived', 'pending_delete', 'superseded'])

export const STATUS_LABELS = {
  active: '有效',
  conflict: '待确认冲突',
  archived: '已归档',
  pending_delete: '待删除（7 天冷静期）',
  superseded: '已被新记忆取代',
}

/**
 * Exponential decay coefficients (per day). Chosen so that a buffer memory
 * loses ~70% of its weight in three days, an episodic one in ~25 days, and a
 * semantic/persona memory stays effectively stable for months.
 */
export const DECAY = {
  buffer: 0.35,
  episodic: 0.08,
  semantic: 0.005,
  persona: 0.001,
}

/** Default importance when the caller does not supply one (0.1 – 10 scale). */
export const DEFAULT_IMPORTANCE = {
  buffer: 2,
  episodic: 4,
  semantic: 6,
  persona: 8,
}

export const MAX_IMPORTANCE = 10
export const MIN_IMPORTANCE = 0.1

/** Weight thresholds used by replay/forgetting. */
export const ARCHIVE_BELOW = {
  buffer: 0.8,
  episodic: 0.35,
  semantic: 0,
  persona: 0,
}

export const PENDING_DELETE_BELOW = {
  buffer: 0.25,
  episodic: 0.18,
  semantic: 0,
  persona: 0,
}

export const DELETE_GRACE_DAYS = 7

export const DEFAULTS = {
  retrievalLimit: 5,
  recallMinScore: 0.08,
  dedupeThreshold: 0.86,
  mergeThreshold: 0.6,
  replayMinCluster: 3,
  replayMinAgeDays: 1,
  replayIntervalHours: 24,
  namespace: 'default',
  promptLanguage: 'auto',
}

export const PENDING_DELETE_MS = DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000

export const VERSION = '0.6.0'
export const SCHEMA_VERSION = 4
