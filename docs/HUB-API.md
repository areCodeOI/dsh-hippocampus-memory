# 记忆中枢（Memory Hub）API 契约 v1

> 本文件是**实现契约**，由队长维护。实现者（`lib/memory-hub.js`）与测试者
> （`test/memory-hub.test.mjs`）必须以本文件为唯一对齐依据。
>
> 目标：一个**纯本地、确定性、零网络、零外置 LLM** 的决策层，自主回答三个问题：
> **该记什么 / 怎么记 / 什么时候读**。
> 它只产出「决策计划」，**不碰数据库、不发 fetch、不调 `extractWithLlm`**。
> 真正的读写由 `lib/hub-runner.js` 执行。

## 0. 硬性约束

1. `lib/memory-hub.js` 的 import 只允许：`node:crypto`（可选）、`./auto-capture.js`、`./auto-recall.js`。
   **禁止** `fetch`、`http`、`https`、`child_process`、任何 OpenAI/LLM 模块、任何 `process.env` 读取。
2. 所有导出函数必须是**纯函数**：相同输入 + 相同 `now` → 相同输出；不写文件、不写 DB、不改全局状态。
3. 不得修改 `lib/auto-capture.js` / `lib/auto-recall.js`（队长负责它们的小改）。
4. 常量必须 `Object.freeze`，默认参数对象不得被修改。

## 1. 导出清单（名称与签名固定）

```js
export const HUB_VERSION = 1
export const HUB_DEFAULTS           // frozen object，见 §2
export const HUB_SIGNALS            // frozen array，见 §3
export const AUTO_CAPTURE_TAG       // 重导出 'auto-capture'（便于 runner 单点引用）

export function analyzeText(text)                       // → Analysis，见 §4
export function classifyFact(analysis, role = 'user')  // → Classification，见 §5
export function cleanFact(value)                       // → string
export function decideRecall(input, options = {})      // → RecallDecision，见 §6
export function decideCapture(messages, options = {})  // → CaptureDecision，见 §7
export function hubPlan(messages, options = {})        // → Plan，见 §8
export function hubSystemPrompt(language = 'zh')       // → string，见 §9
```

## 2. `HUB_DEFAULTS`（冻结）

```js
{
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
}
```

## 3. `HUB_SIGNALS`（冻结数组，顺序与权重固定）

每项 `{ name, label, weight, pattern }`（`pattern` 为 RegExp，`u` 标志，大小写不敏感用 `i`）：

| # | name | label | weight | 匹配要点 |
|---|---|---|---|---|
| 1 | `self` | 涉及用户本人 | `0.30` | 我/我的/本人/咱/俺/我们/`\bi\b`/`\bmy\b`/`\bme\b`/`\bwe\b` |
| 2 | `history` | 回指历史/既往 | `0.32` | 以前/之前/上次/历史/曾经/记得/还记得/之前说/过往/继续用/`previous`/`last time`/`remember`/`as mentioned` |
| 3 | `preference` | 偏好/禁忌/健康 | `0.28` | 偏好/喜欢/不喜欢/讨厌/习惯/忌口/过敏/禁忌/不能吃/我一般/我总是/我从不/`prefer`/`like`/`hate`/`allergic`/`never`/`always` |
| 4 | `project` | 项目/配置/环境 | `0.20` | 项目/仓库/配置/部署/端口/数据库/框架/路径/环境/依赖/`npm`/`pnpm`/`yarn`/`node`/`repo`/`config`/`deploy`/`database`/`port`/`postgres` |
| 5 | `decision` | 决定/约定/变更 | `0.18` | 决定/采用/改为/改成/统一/约定/规则/切换/结论/根因/`decided`/`switched`/`we use`/`now uses` |
| 6 | `continuation` | 承接上文/继续 | `0.25` | 继续/接着/刚才/上面/那个/这个/再说说/`continue`/`go on` |
| 7 | `question` | 疑问需要背景 | `0.12` | `[?？]`/什么/怎么/为什么/如何/哪/谁/是否/能不能/可不可以/多少/`[吗呢]\s*$` |
| 8 | `explicit` | 显式要求记住 | `0.35` | 记住/记一下/请记/别忘/不要忘/永远/永久/必须/一定要/禁止/从现在开始/以后/今后/下次/`remember`/`from now on`/`never`/`always` |
| 9 | `event` | 带时间/结果的事件 | `0.16` | 今天/昨天/上次/刚才/已修复/已发布/已部署/测试通过/失败/成功/`\d+(\.\d+)+`/`exit code 0`/`tests? pass`/`fixed`/`released`/`deployed`/`failed` |
| 10 | `greeting` | 纯寒暄 | `-0.35` | 你好/您好/嗨/哈喽/早上好/晚上好/谢谢/多谢/在吗/`\bhi\b`/`\bhello\b`/`\bthanks\b` |
| 11 | `uncertain` | 不确定措辞 | `-0.08` | 可能/也许/大概/似乎/好像/或许/不确定/`maybe`/`perhaps`/`probably`/`might` |
| 12 | `transient` | 一次性/临时 | `-0.20` | 这次/临时/顺便/试一下/暂且/先这样/一次性/`temporarily`/`just this once` |

**注意**：`pattern` 用 `String.prototype.match` 找首个命中作为 `evidence`；`history` 与 `continuation`
可同时命中（各自计权），`explicit` 与 `preference` 也可同时命中。

## 4. `analyzeText(text)` → `Analysis`

先把 text 转为字符串、trim；把 ` ```...``` ` 内容**替换成空格**得到 `codeFree`；
`clean` = `codeFree.replace(/\s+/g,' ').trim()`（保留标点）。

```js
{
  text: string,            // 原始 String(text ?? '')
  clean: string,           // 去代码块、折叠空白后的分析文本
  length: number,          // clean.length
  codeFreeLength: number,  // 去代码块后（未折叠空白）字符数
  hasCode: boolean,        // 出现过 ``` 块
  pureCode: boolean,       // hasCode && clean.length < 4
  hasCommand: boolean,     // clean.startsWith('/')
  hasSensitive: boolean,   // hasSensitiveData(clean)，从 auto-capture.js 导入
  hasQuestion: boolean,    // /[?？]/ 或 INTERROGATIVE 命中
  matched: [               // 按 HUB_SIGNALS 顺序，仅命中的项
    { name, label, weight, evidence }   // evidence = 首个匹配片段，截 40 字
  ],
  scores: { [name]: weight, ... },     // 仅命中项，键与 matched 一致
  score: number,           // clamp(BASE + Σ weights, 0, 1)，见下
  signals: <matched 的同一数组引用>,
}
```

- `BASE = 0.15`，**仅当** `clean.length >= 2 && !pureCode` 时计入；否则 `BASE = 0`。
- `score` 四舍五入到 **3 位小数**（`Number(x.toFixed(3))`）。
- `hasSensitive` 只做标记，**不**在这里阻断（由 `decideRecall`/`decideCapture` 决定）。
- `INTERROGATIVE` 复用语义：`/(?:什么|怎么|为什么|如何|哪|谁|是否|能不能|可不可以|多少)|[吗呢]\s*$/u`。

## 5. `classifyFact(analysis, role = 'user')` → `Classification`

按下列优先级**自上而下，首个命中即返回**（用 `analysis.scores` 的键判断）：

| 优先 | 条件 | kind | importance | confidence | tags | reason |
|---|---|---|---|---|---|---|
| 1 | `preference` **且** `HEALTH_RE.test(analysis.clean)` | `persona` | `9` | `0.92` | `['hub','persona','健康']` | 健康/禁忌属人格层 |
| 2 | `preference` 且 `self` | `persona` | `8` | `0.88` | `['hub','persona','偏好']` | 稳定偏好属人格层 |
| 3 | `explicit` 且 `project` | `semantic` | `9` | `0.90` | `['hub','semantic','约定']` | 显式要求的项目约定 |
| 4 | `explicit` | `persona` | `9` | `0.90` | `['hub','persona','显式要求']` | 用户明确要求长期记住 |
| 5 | `project` 且 (`decision` 或 `event`) | `semantic` | `7` | `0.82` | `['hub','semantic','项目']` | 项目稳定事实 |
| 6 | `decision` 且 `role !== 'user'` | `episodic` | `6` | `0.70` | `['hub','episodic','结论']` | 助手/工具的结论属事件 |
| 7 | `event` 或 `role !== 'user'` | `episodic` | `role==='tool' ? 6 : 5` | `0.70` | `['hub','episodic','事件']` | 带时间/结果的独立事件 |
| 8 | `decision` | `semantic` | `6` | `0.72` | `['hub','semantic','决定']` | 已作出的决定 |
| 9 | 兜底 | `buffer` | `3` | `0.55` | `['hub','buffer']` | 信息不足，暂放短期缓冲 |

`HEALTH_RE = /(?:过敏|忌口|病史|身体|不能吃|不能喝|禁忌|慢性|药物|病史|乳糖|花生|坚果|海鲜|青霉素|我对[^，。；\n]{1,20}过敏)/u`

**后处理**（必须执行）：
- `importance`：`explicit` 命中 `+1`；`transient` 命中 `−2`；最后 `clamp(0.1, 10)`，保留 1 位小数。
- `confidence`：`uncertain` 命中 `−0.15`；最后 `clamp(0.3, 0.95)`，保留 2 位小数。
- `score` = `analysis.score`（3 位小数）。

返回对象固定字段：
```js
{ kind, importance, confidence, tags, reason, score, personaLike: kind === 'persona' }
```

## 6. `decideRecall(input, options = {})` → `RecallDecision`

- `input` 为 `string` 或 `{ text, ... }`；取 `text`，其余字段忽略。
- `options` 合并顺序：`HUB_DEFAULTS` → 调用方覆盖。识别键：
  `enabled, recallMaxQueryChars, recallDefaultLimit, recallMaxChars, recallMinScore,
   readThreshold, namespace, now`。
  （`limit`/`minScore`/`maxChars` 由上述键映射，见返回。）

判定**按序短路**，`suppressedBy` 取第一个成立的值：

| 序 | 条件 | suppressedBy |
|---|---|---|
| 1 | `enabled === false \|\| recallEnabled === false` | `'disabled'` |
| 2 | `analysis.hasCommand` | `'command'` |
| 3 | `analysis.hasSensitive` | `'sensitive'` |
| 4 | `analysis.pureCode` | `'pure-code'` |
| 5 | `analysis.length < 2` | `'too-short'` |
| 6 | `analysis.score < readThreshold` | `'below-threshold'` |
| 7 | 否则 | `null`（`shouldRead = true`） |

**开关双键兼容（实现者必须遵守）**：调用方（`lib/hub-runner.js`）只传 `enabled`；
`HUB_DEFAULTS` 只提供 `recallEnabled: true`。因此禁用条件必须是
`enabled === false || recallEnabled === false`，两者任一为 false 即禁用；
`enabled === undefined`（HUB_DEFAULTS 未含此键）视为启用。
`pureCode` 必须排在 `too-short` 之前，因为纯代码块的 `clean.length` 常为 0/1，
否则 `pure-code` 永远不可达。

`query`：`analysis.clean` 去掉已有的自动召回注入块。注入块同时含两个标记时，
**先**按 `[海马体自动召回` 截到其之前，**再**按 `以上是历史数据` 取其后，
最后把两个标记整段从结果中清掉（实现可自由选择顺序，唯一硬约束是
`query` **不得包含任一标记、不得包含注入的假记忆文本**，且真实用户文本尽量保留）。
再 `.slice(0, recallMaxQueryChars)`；`shouldRead === false` 时 `query = ''`。

返回对象（**所有字段必须存在**）：
```js
{
  shouldRead: boolean,
  query: string,
  limit: number,            // = options.recallDefaultLimit（clamp 1..8）
  minScore: number,         // = options.recallMinScore
  maxChars: number,         // = options.recallMaxChars
  maxQueryChars: number,    // = options.recallMaxQueryChars
  namespace: string,        // = options.namespace ?? ''
  kindBias: null,           // v1 恒为 null：不按层过滤，避免漏召回
  score: number,            // analysis.score
  readThreshold: number,
  reason: string,           // 中文自解释，见下
  suppressedBy: string|null,
  signals: analysis.matched,
  engine: { llm: false, deterministic: true, version: 1 },
}
```

`reason` 规则：
- `shouldRead` → `` `命中${signals.map(s=>s.label).join('/')||'上下文'}信号，需要历史记忆` ``
- `'disabled'` → `'中枢召回已关闭'`
- `'command'` → `'斜杠命令是控制输入，不召回'`
- `'too-short'` → `'输入过短，无召回必要'`
- `'sensitive'` → `'疑似密钥/PII，不用于检索'`
- `'pure-code'` → `'纯代码块，无召回必要'`
- `'below-threshold'` → `'上下文信号不足（纯寒暄/闲聊），不召回'`

## 7. `decideCapture(messages, options = {})` → `CaptureDecision`

- `options` 合并：`HUB_DEFAULTS` → 覆盖。识别键：
  `enabled, captureEnabled, captureMaxCandidates, captureMaxFactChars, captureMaxInputChars,
   writeThreshold, namespace, includeAssistant, includeTools, now`。
  禁用条件为 `enabled === false || captureEnabled === false`（同 §6 的双键兼容）。
  `includeAssistant` / `includeTools` **不在 HUB_DEFAULTS 中**，默认由
  `collectCaptureSources` 的签名默认值决定（均为 true）；调用方显式传 false 时必须透传。
- 用 `collectCaptureSources(messages, { includeAssistant, includeTools, maxMessages: 6 })`
  （从 `auto-capture.js` 导入）得到 `sources`。
- `userText = latestUserText(messages)`（从 `auto-capture.js` 导入）。
- 若 `!userText` → 返回空决策（见末尾「空决策」）。

**分句**：对每个 `source.text`：
1. `slice(0, captureMaxInputChars)`
2. 去掉 ` ```...``` `
3. `role === 'tool'` 按 `/\n+/u` 分行；否则按 `/[^。！？!?；;\n]+[。！？!?；;]?/gu` 分句
4. 每句 `cleanFact()`，`cleanFact` 行为：
   - 去行首 `[\\s\\-*•\\d.、)）]+`
   - 折叠空白
   - 去前缀 `(?:请)?(?:记住|记一下|请记下|请记|remember|please remember|note that)[:：,，\s]*`（`i`）
   - 去首尾 `[,，:：;；\s]+`
   - 去尾部 `[。！？!?；;]+`
   - trim

**逐句过滤**（命中即记入 `suppressed`，`reason` 固定为下列字符串）：

| 序 | 条件 | reason |
|---|---|---|
| 1 | `content.length < 4` | `'too-short'` |
| 2 | `content.length > captureMaxFactChars` | `'too-long'` |
| 3 | `hasSensitiveData(content)` | `'sensitive'` |
| 4 | 是问句（`/[?？]\s*$/` 或 `INTERROGATIVE.test`）且**无** `explicit` 信号 | `'question'` |
| 5 | `uncertain` 信号且**无** `explicit` 信号 | `'uncertain'` |
| 6 | 该轮内已出现相同 `content.toLowerCase()` | `'duplicate'` |
| 7 | `source.role === 'assistant'`/`'tool'` 且句子无任何 `HUB_SIGNALS` 正权重命中 | `'no-signal'` |

过滤后对每句跑 `analyzeText(content)` → `classifyFact(analysis, source.role)`，
组装 candidate：

```js
{
  content,                       // cleanFact 后
  kind, importance, confidence,  // 来自 classifyFact
  tags: [ ...classification.tags, 'auto-capture' ],   // 必须含且仅含一次 'auto-capture'
  namespace: options.namespace ?? '',
  dedupe: 'auto',
  confirmed: false,
  needsReview: true,
  role: source.role,
  cue: (analysis.matched[0]?.evidence ?? 'hub').slice(0, 40),
  personaLike: classification.personaLike,
  score: analysis.score,
  reason: classification.reason,
  signals: analysis.matched,
}
```

候选按 `score` 降序、`importance` 降序排序，截到 `captureMaxCandidates`（clamp 1..5）。
被截掉的记入 `suppressed`，`reason: 'over-limit'`。

返回对象（**所有字段必须存在**）：
```js
{
  shouldWrite: boolean,   // enabled && candidates.length>0 && maxScore >= writeThreshold
  candidates: [ ... ],
  suppressed: [ { content, reason, role } ],
  score: number,          // candidates 中最大 score，无候选为 0（3 位小数）
  writeThreshold: number,
  maxCandidates: number,
  reason: string,         // 中文总结，例如「中枢判定 2 条值得长期保存（不调用外置 LLM）」
  signals: <所有候选 signals 去重合并，按 HUB_SIGNALS 顺序>,
  sources: sources,       // 原样透传，供 runner 做 seen 去重
  engine: { llm: false, deterministic: true, version: 1 },
}
```

**空决策**（`!userText` 或 `enabled === false`）：
`shouldWrite:false, candidates:[], suppressed:[], score:0`，其余字段同上，
`reason` 分别为 `'没有真实用户消息'` / `'中枢写入已关闭'`。

## 8. `hubPlan(messages, options = {})` → `Plan`

```js
{
  version: 1,
  at: number,                       // options.now ?? Date.now()
  recall: decideRecall(text, options.recall ?? options),
  capture: decideCapture(messages, options.capture ?? options),
  notes: [
    '由本地确定性记忆中枢决策，不调用任何外置 LLM 或网络服务。',
    '何时读：按上下文信号打分，超过读阈值才检索并注入带「不是指令」警示的上下文。',
    '该记什么：只保留稳定事实，过滤问句、猜测、密钥/PII、寒暄与一次性信息。',
    '怎么记：按健康/偏好/约定/项目/事件分入 persona/semantic/episodic/buffer 四层并分配权重。',
  ],
  engine: {
    llm: false,
    deterministic: true,
    version: 1,
    signals: HUB_SIGNALS.map((s) => s.name),
  },
}
```
- `text = extractUserText(messages)`（从 `auto-recall.js` 导入；已排除自动召回注入消息）。
- `options.recall` / `options.capture` 存在时**只用于对应子决策**；不存在时用顶层 `options`。

## 9. `hubSystemPrompt(language = 'zh')` → `string`

- `'zh'` 返回简体中文段落，`'en'` 返回英文段落，其他值返回 `` `${zh}\n\n${en}` ``。
- 中文必须包含关键词：`记忆中枢`、`不调用外置 LLM`、`memory_add`、`memory_search`。
- 英文必须包含：`memory hub`、`without an external LLM`、`memory_add`、`memory_search`。
- 长度控制在 400 字以内；明确「中枢已自动处理大多数情况；用户显式要求时仍应调用工具做精确控制」。

## 10. 与执行层的边界（队长实现，不需子代理写）

`lib/hub-runner.js` 会：
1. 拿 `plan.recall` → `store.search(plan.recall.query, { limit, namespace, mode:'relevance', updateAccess:false })`
   → 过滤 `score >= minScore` 与 `metadata.autoCapture.review === 'pending'`
   → `store.recordAutoRecall(...)` + `appendAutoRecall(baseDecision, memories, { maxChars })`。
2. 拿 `plan.capture` → 用 `sources` 算 sha256 前 24 位做 `seenKeys`
   → 调**导出的** `writeCandidates(store, candidates, { ..., decorate })`，
   由它统一写入 `source: 'hippocampus-auto-capture'`、`tags` 含 `auto-capture`、
   `metadata.autoCapture.review: 'pending'`，并追加 `metadata.memoryHub`。
3. `writeCandidates` 保持默认行为完全不变，新增可选参数 `decorate(candidate) → object`。

## 11. 实时设置（WebUI / DSH，免重启）

中枢开关与阈值存在数据库 meta 表 `memory_hub_settings`，读写接口：

- `GET  /api/hub/settings` → `{ ok, settings }`（admin）
- `PATCH /api/hub/settings` → `{ ok, settings }`（admin，部分字段更新）

`settings` 字段：`enabled, readThreshold, writeThreshold, capture, autoApprove,
captureMaxPerTurn, recallLimit, recallMaxChars, recallMinScore, namespace, configured`。

优先级：**DB 已保存 > 启动 Config > HUB_DEFAULTS**。`lib/index.js` 的 pre-step
每轮调用 `store.hubSettings(store.hubDefaults)`，所以 WebUI 保存后下一步对话立即生效。
`store.setHubSettings` 对 0–1 阈值、1–5/1–8 的整数上限和 namespace 合法性做校验，
非法输入抛错（HTTP 返回 400），不会写入半套配置。

> DSH 设置页的 `memoryHub` 等字段是**启动默认值**；WebUI 保存过之后以数据库为准。
> 没有 HTTP/WebUI 的纯命令行/MCP 部署仍可直接用 YAML 配置。
