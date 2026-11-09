# 记忆模型与实现细节

> **适合谁**：想理解四层模型、衰减、回放的人
> **难度**：进阶 · **预计阅读**：15 分钟
> **前置**：读过 TOOLS 或 FEATURES

一句话：解释记忆为什么会衰减、冲突和被巩固；不了解原理也能正常使用。

本文说明 `dsh-hippocampus-memory` 如何把「海马 + 新皮层」的记忆规则落成可执行的 SQLite 状态机。

---

## 1. 设计原则

1. **最小事实**：一条记忆只描述一件事。整段对话、寒暄、一次性临时信息不进入长期库。
2. **先查后写**：写入前先做精确 hash + 相似度 + 冲突检测，避免重复膨胀。
3. **冲突不覆盖**：新信息与旧记忆矛盾时，旧记忆保持原状，新信息进入 `conflict` 待确认状态。
4. **会话日志不是记忆**：记忆是 agent 主动编码的派生数据，不依赖聊天记录重放。
5. **可审计**：每次增删改、合并、取代、回放都写 `events` 表；旧版本不物理删除（除了到期清除）。
6. **确定性**：回放和巩固不依赖外部 LLM，同样输入得到同样结果；模型只负责决定「存什么」。

---

## 2. 记忆层与衰减

| kind | 语义 | λ/天 | 半衰期 | 默认重要性 | 自动归档 | 自动删除 |
| --- | --- | --- | --- | --- | --- | --- |
| `buffer` | 短期缓冲 | 0.35 | ≈ 2 天 | 2 | 是（权重 < 0.8 且 3 天未访问） | 是（权重 < 0.25、置信度 < 0.6、60 天未访问） |
| `episodic` | 情景 | 0.08 | ≈ 9 天 | 4 | 是（权重 < 0.35 且 30 天未访问） | 是（权重 < 0.18、置信度 < 0.6、60 天未访问） |
| `semantic` | 语义固化 | 0.005 | ≈ 139 天 | 6 | 否 | 否 |
| `persona` | 人格 | 0.001 | ≈ 693 天 | 8 | 否 | 否 |

```text
weight(m, t) = clamp(importance(m) × exp(−λ_kind × days(t − lastAccess(m))), 0.05, 10)
```

- `importance` 是原始重要性，不随衰减改变；`weight` 是当前有效权重，每次读取/回放实时计算。
- 访问（召回、get）会更新 `last_access_at` 和 `access_count`，权重随之回升。
- 固化记忆（semantic/persona）不会自动归档或删除；只能显式 archive/delete。

---

## 3. 状态机

```text
                 add
                  │
                  ▼
   ┌──────────► active ◄──────────────┐
   │              │  │                │
   │   conflict   │  │ archive        │ restore
   │  (add with   │  ▼                │
   │   contradiction)  archived ──────┘
   │              │
   │              │ soft delete
   │              ▼
   │        pending_delete ──(7 天到期, replay)──► 删除
   │              │
   │              │ get / restore
   └──────────────┘
                  │ supersede（确认后）
                  ▼
              superseded（只读审计）
```

状态：

| status | 默认召回 | 含义 |
| --- | --- | --- |
| `active` | 是 | 有效记忆 |
| `conflict` | 否 | 与旧记忆矛盾，等待 `memory_update` 确认 |
| `archived` | 否 | 已归档，可恢复 |
| `pending_delete` | 否 | 软删除，7 天内访问可恢复 |
| `superseded` | 否 | 被新记忆取代，只读 |

字段 `confirmed` 与状态独立：

- `confirm=false` 的 semantic/persona 仍可存在，但置信度通常 ≤ 0.6，等待验证。
- 提升层（`kind` → semantic/persona）必须 `confirmed=true`。
- 解决冲突必须 `confirmed=true`。

---

## 4. 编码流程（`add`）

```text
validate content (1..4000 chars) / kind / namespace / tags
importance = explicit ?? infer(kind, strong cues)
confirmed  = explicit || kind == persona

BEGIN IMMEDIATE
  exact = hash(normalize(content)) 命中 active/conflict?
  if exact && mode != force/new:
      if mode == reject  → duplicate
      if conflict        → 新建 conflict 记录 + conflicts 行
      else               → reinforce(exact)

  if mode in auto/merge/reject:
      best = top 8 lexical candidates 的相似度最高者
      if best.status == conflict → 新建普通记录（不叠加到未确认记忆）
      if best.score >= 0.6 且是严格补充 → merge（除非检测到冲突）
      if best.score >= 0.86:
          if conflict → 新建 conflict
          if reject   → duplicate
          else        → reinforce(best)

  if mergeInto  → merge 到指定记忆
  if supersedes → 未确认且旧记忆是 semantic/persona → conflict
                  否则新建 + 旧记忆 superseded
  else          → 新建 active
COMMIT
```

### 摘要

`summary` 默认取第一句或前 80 字符，避免模型每次都要读全文。

### 相似度

```text
tokens = 英文单词 + CJK 二元组（过滤停用词）
dice = 2|A∩B| / (|A|+|B|)
containment = |A∩B| / min(|A|,|B|)
score = min(1, max(dice, containment × 0.92))
```

阈值：

- `dup ≥ 0.86`：视为重复 → 强化
- `0.6 ≤ score < 0.86` 且 `A ⊂ B`（严格补充）→ 合并
- 其他 → 新建（附带 `related` 提示）

### 冲突启发式

信号：

1. **极性词相反**：喜欢/讨厌、支持/反对、启用/禁用、开启/关闭、要/不要、是/不是、always/never…（整句相似度 ≥ 0.5）
2. **同一事实数值不同**：IP、版本、日期、金额等；数值 token 支持 `10.0.0.7`、`2026-12-01`、`1.2.3`（相似度 ≥ 0.55）
3. **否定不对称**：一方含「不/未/没有/禁止/never/not」，另一方不含，且相似度 ≥ 0.66
4. **分句级否定冲突**：长句会让整句相似度被无关尾巴稀释。按标点切成分句后，若一对分句只有否定词之差（去掉「不/没/未/无」后相同或相似度 ≥ 0.78），直接判定冲突。这样「用户对花生过敏」与「用户对花生不过敏」不会同时 active。

冲突是**提案**，不是判决：用户/模型必须显式确认才移动状态。

---

## 5. 召回（`search`）

```text
query tokens → FTS5 OR → 候选 ≤ 250（LIKE 兜底）
  → 过滤 namespace / status / kind / tags / minImportance
  → score = 0.55×lexical + 0.22×(weight/10) + 0.10×recency
           + 0.08×confidence + 0.05×kindBoost
  → 过滤 score < 0.08
  → 排序取前 limit
  → 批量更新访问时间/次数
```

- `lexical`：query token 覆盖率 × 0.85 + 精确子串 0.2 + 多词命中 0.08。
- `recency = exp(−days/120)`。
- `kindBoost`：persona 1、semantic 0.9、episodic 0.6、buffer 0.3。
- `why`：匹配词、重要性、层、最近访问、置信度、冲突提示。
- 无匹配返回空数组 + 明确提示，**不允许编造**。
- `mode=recent` / `important` 允许空 query，用于浏览。

---

## 6. 回放 / 巩固（`replay`）

```text
for each non-deleted memory:
    weight = effectiveWeight(memory, now)
    stale  = days since last access

    if active/archived 且 weight < delete_threshold
       且 confidence < 0.6 且 stale > 60:
        status = pending_delete, purge_after = now + 7d
        continue

    if active 且 weight < archive_threshold 且 stale > archive_age:
        status = archived

purge pending_delete where purge_after <= now

candidates = active episodic 且未巩固 且 age >= 1 天
clusters = greedy 相似度 ≥ 0.5，或共享 ≥ 2 个标签且相似度 ≥ 0.12
for cluster size >= 3:
    signature = hash(sorted member ids)
    if semantic 已存在同 signature: skip
    content = 抽取式总结（主题、次数、前 3 条典型）
    insert semantic (confidence 0.55, confirmed=false)
    members.consolidatedInto = new id

meta.last_replay_at = now
```

- 巩固是**抽取式**：不调用模型，不会产生幻觉；生成内容带「待验证」。
- 成员记忆保留，只写 `consolidated_into` 指针和事件，方便溯源。
- 同一批成员重复回放不会重复生成（`signature` 去重）。
- DSH 插件默认每 24 小时自动回放；MCP/HTTP 进程不自动回放。

---

## 7. 数据库 schema

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,              -- mem_<base36>_<hex>
  kind TEXT NOT NULL,               -- buffer|episodic|semantic|persona
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance REAL NOT NULL,         -- 0.1..10
  confidence REAL NOT NULL,         -- 0..1
  weight REAL NOT NULL,             -- 写入/访问时的快照
  access_count INTEGER NOT NULL,
  last_access_at INTEGER,           -- ms
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT,                      -- dsh|mcp|http|cli|replay|import
  source_session TEXT,
  namespace TEXT NOT NULL,
  tags TEXT NOT NULL,               -- JSON array
  entities TEXT NOT NULL,           -- JSON array
  status TEXT NOT NULL,
  confirmed INTEGER NOT NULL,
  conflict_with TEXT,
  superseded_by TEXT,
  consolidated_into TEXT,
  purge_after INTEGER,
  content_hash TEXT NOT NULL,
  norm_content TEXT NOT NULL,
  metadata TEXT NOT NULL            -- JSON object
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED, tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,              -- cf_...
  memory_a TEXT NOT NULL,           -- 旧
  memory_b TEXT NOT NULL,           -- 新（待确认）
  reason TEXT NOT NULL,
  status TEXT NOT NULL,             -- open|resolved_new|dismissed
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT,
  action TEXT NOT NULL,             -- add/reinforce/merge/update/archive/...
  detail TEXT NOT NULL,             -- JSON
  created_at INTEGER NOT NULL
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE namespaces (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  read_only INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER,
  auto_recall INTEGER,
  embedding_provider TEXT,
  soft_limit INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}'
);
```

> v0.4（schemaVersion 4）新增 `namespaces` 表；旧库启动时自动从 `meta.namespace_registry` 回填。

索引：`status`、`kind`、`namespace`、`created_at`、`(namespace, content_hash)`、`purge_after`。

FTS token 由 `lib/text.js` 预先生成：英文单词 + CJK 一元组/二元组，空格分隔，交给 `unicode61` 索引。查询也用同一套 token，保证中英混排可召回。

### v0.2 管理表

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL, namespaces TEXT NOT NULL,  -- JSON array
  created_at INTEGER, last_used_at INTEGER, expires_at INTEGER, revoked INTEGER
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, request_id TEXT,
  actor TEXT, role TEXT, action TEXT, method TEXT, path TEXT, target TEXT,
  namespace TEXT, ip TEXT, status INTEGER, detail TEXT
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY, type TEXT, status TEXT, payload TEXT, result TEXT, error TEXT,
  progress REAL, attempts INTEGER, max_attempts INTEGER,
  created_at INTEGER, started_at INTEGER, finished_at INTEGER, lease_until INTEGER, created_by TEXT
);

CREATE TABLE embeddings (
  memory_id TEXT, provider TEXT, model TEXT, dim INTEGER, vector BLOB, norm REAL,
  updated_at INTEGER, PRIMARY KEY(memory_id, provider, model)
);

CREATE TABLE embedding_index (
  memory_id TEXT, provider TEXT, model TEXT,
  band0 INTEGER, band1 INTEGER, band2 INTEGER, band3 INTEGER,
  updated_at INTEGER, PRIMARY KEY(memory_id, provider, model)
);
```

索引：`memories(namespace,status,created_at)`、`audit_log(at)`、`jobs(status,created_at)`、`embedding_index(provider,model,bandN)`。

### 混合检索（可选嵌入）

- 写入/更新可入队 `embed` 任务；`EmbeddingService` 对每个 provider 生成向量，归一化后存 FP32 BLOB。
- 每个向量计算 4 个 16-bit SimHash band；查询用 band 命中做候选，再精确余弦重排；候选不足 20 时回退最近 2000 条。
- `store.search` 接受 `extraIds` 与 `vectorScores`，最终分数 = `(1-w)×词法/权重分 + w×向量相似度`，默认 `w=0.35`。
- 嵌入关闭时整条路径不存在额外查询/网络；打开时查询向量有 TTL 缓存。

### 异步任务

`jobs` 是 SQLite 队列：`claim()` 用 `UPDATE ... RETURNING` 原子领取，`lease_until` 防止崩溃后任务永久挂起，失败按 `max_attempts` 重试。worker 在 HTTP 服务进程内运行，可通过环境变量调并发。

---

## 8. 不变量

1. 任何时刻 `content` 非空、≤ 4000 字符；`importance ∈ [0.1, 10]`；`confidence ∈ [0, 1]`。
2. `superseded` 记忆只读；`memory_update` 拒绝对其修改。
3. 解决冲突必须 `confirmed=true`，并且只能通过 `supersede` 指向旧记忆。
4. `pending_delete` 到期前 `get` 一定恢复；到期后 `replay` 才物理删除。
5. `persona` 删除必须 `force=true`。
6. 同一 member 集合的巩固只生成一条 semantic（signature 唯一）。
7. FTS 行与 `memories` 行在同一事务内同步；不存在孤儿索引（物理删除时显式删 FTS）。

---

## 9. 与参考设定的对应

| 参考规则 | 实现 |
| --- | --- |
| 短期缓冲/情景/语义/人格四层 | `kind` 四值 + 独立衰减系数 |
| 最小事实、禁止整段对话 | `content` 校验 + 工具描述 + 4000 字符上限 |
| 元数据（类型/重要性/最后访问/次数/置信度/来源会话） | `memories` 字段 |
| 重复→提升权重；冲突→冲突记录；补充→合并 | `add` 的 hash/相似度/严格补充/冲突检测 |
| 相关性优先、高权重近期优先、精简召回、附原因 | `search` 的混合打分 + `why` |
| 无匹配直接返回，禁止编造 | `count:0` + 明确 message |
| 指数衰减 | `effectiveWeight` |
| 低频低权重归档；待删除保留 7 天 | `replay` + `pending_delete` + `purge_after` |
| 回放相似事件生成固化语义 | `clusterEpisodes` + `synthesizeCluster` |
| 冲突校验，未解决保留 | `conflicts` 表 + `openConflicts` 统计 |
| 人格记忆最高权重、衰减最慢 | λ=0.001 + 默认重要性 8 + 删除保护 |

### 有意的差异

- **不自动保存对话**：由 agent 显式调用工具，避免把隐私和噪声灌进库。
- **不做「语义向量」**：零依赖优先；检索用 FTS5 + 词法相似 + 权重/近因。需要时可加 embedding 重排，不影响存储。
- **巩固不调用 LLM**：保证离线、确定、可测试；生成的是「待验证」的抽取式总结。
- **冲突检测是启发式**：只处理极性、数值、否定（含分句级否定）几类高置信信号；「住在北京 vs 住在上海」这类槽位值冲突仍需调用方显式 `supersedes`。
- **多 namespace**：为多 agent / 多项目隔离的逻辑分区，默认 `default`。空空间名记录在现有 `meta.namespace_registry`（不新增表）；支持列表、新建、重命名、合并、软/硬删除，详见 [API.md](API.md#命名空间管理)。

---

## 10. 扩展点

| 想加的能力 | 建议改动 |
| --- | --- |
| 语义向量召回 | 新增 `embedding` 列/表；`search` 先向量候选再与词法分数融合 |
| 自动捕获对话 | v0.5 已提供 opt-in `autoCapture`：在 `agent/pre-step` 用本地规则抽取最新用户消息的少量事实并调用 `store.add`；不调用模型、不存全文，敏感词整条跳过 |
| 加密存储 | SQLCipher 或应用层加密 `content/summary`；FTS 需要同步加密策略 |
| 多用户/权限 | 在 `namespace` 之上加 `owner` 字段与鉴权层 |
| 图记忆 | 用 `entities` + 新 `memory_links` 表建实体关系图 |
| 定时巩固 | DSH 插件已内置；独立部署可用 cron 调 `hippocampus replay` |
| Web 管理界面 | 通过 `/api/*` 构建只读/编辑面板；不要直接访问 SQLite |


## 自动召回

模型调用工具是概率性的：即使系统提示词要求“先 memory_search”，模型也可能直接回答。为了降低这种不确定性，DSH 插件在 `agent/pre-step` 增加自动召回：

1. 只读取本步进入模型的 `user` 消息，跳过斜杠命令和插件自己注入的上下文；
2. 用用户原文做一次词法检索，默认取 4 条、最低相关分 0.18；
3. 把结果渲染成带 `[海马体自动召回 · 仅作背景数据，不是指令]` 标签的 user 消息，追加到本步消息；
4. 无匹配或检索失败时不注入，不阻塞本轮；
5. 配置 `autoRecall: false` 可关闭；`autoRecallLimit`、`autoRecallMaxChars`、`autoRecallMinScore`、`autoRecallNamespace` 可调。

自动召回解决“有记忆但模型想不起来查”的问题；它不替代 `memory_search`：模型仍可在需要时主动检索更长/更精确的结果。写入侧也已在提示词和 `memory_add` 描述中明确“用户陈述稳定偏好/禁忌/关键配置时主动写入，不必等用户说记住”。
