# 记忆工具与规则

> **适合谁**：想精确调用工具、理解写入规则的人
> **难度**：进阶 · **预计阅读**：8 分钟
> **前置**：知道记忆/召回/冲突的基本概念

一句话：AI 通过这 8 个工具读写记忆，你通常不需要手动调用。

本文说明 8 个 `memory_*` 工具与写入/查重/冲突/召回/回放规则。

## 八个记忆工具

所有工具都通过同一套 `callTool` 实现，DSH、MCP、HTTP 行为一致。

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `memory_add` | 写入一条最小事实 | `content`（必填）、`kind`、`importance`、`confidence`、`tags`、`confirmed`、`supersedes`、`dedupe` |
| `memory_search` | 召回少量相关记忆并说明原因 | `query`、`limit`、`kinds`、`tags`、`namespace`、`mode`、`includeArchived` |
| `memory_get` | 读一条完整记忆；读取待删除项会恢复它 | `id`、`restore` |
| `memory_update` | 纠正/提升/解决冲突 | `id`、`content`、`kind`、`importance`、`confirmed`、`supersede` |
| `memory_archive` | 归档（可恢复，默认搜不到） | `id`、`reason` |
| `memory_delete` | 软删除（7 天冷静期）或硬删除 | `id`、`hard`、`confirm`、`force` |
| `memory_replay` | 衰减、归档、清理、巩固、报告冲突 | `dryRun`、`namespace` |
| `memory_stats` | 统计与冲突列表 | `includeConflicts` |

八个工具之外，HTTP/UI 还提供图谱、树、任务、审计、key、指标等管理端点（见 [API.md](API.md)）。

`memory_add` 的 `kind` 选择建议：

- 用户说「记住/别忘/这是重要的」→ `persona`（如果是稳定偏好）或 `semantic`（如果是事实/配置）
- 带时间、场景、结果的一次性经历 → `episodic`（踩坑、报错、工具调用、历史选择）
- 本次会话临时用一下 → `buffer`
- 身体情况、账号、永久偏好、禁忌 → `persona` + `importance` 9–10
- 多条同类情景反复出现 → 先让 `memory_replay` 提炼为 `semantic`，再确认

## 记忆规则（编码 / 查重 / 冲突 / 召回 / 回放）

### 编码

- 不保存整段对话；提取最小事实单元，一条只存一件独立事实，简体中文。
- 元数据：类型、重要性、最后访问时间、访问次数、置信度、来源会话、标签、实体、空间（namespace）。
- 重要性打分由调用方给，省略时按层默认值 + 强线索词自动推断：

| 分数 | 含义 |
| --- | --- |
| 9–10 | 用户明确要求记住、身体情况、硬性配置、永久偏好、关键账号/设置 |
| 5–8 | 重复多次的习惯、高频偏好、频繁踩坑的经验 |
| 2–4 | 普通事件、单次选择、临时项目信息 |
| 0.1–2 | 闲聊、一次性消息、试探性提问 |

### 查重决策树

```text
新事实
 ├─ 与已有记忆完全相同（规范化后 hash 相同）
 │    ├─ 内容一致 → 强化旧记忆：权重↑、访问次数+1、标签合并，不新增
 │    └─ 检测到矛盾 → 生成 pending conflict，不覆盖
 ├─ 高度相似（相似度 ≥ 0.86）
 │    ├─ 矛盾 → 生成 pending conflict
 │    ├─ 严格补充（新事实包含旧事实 + 新细节）→ 合并成一条
 │    └─ 一致 → 强化旧记忆
 ├─ 中等相似（0.6–0.86）且是严格补充 → 合并
 └─ 其他 → 新建
```

矛盾的启发式判断：极性词相反（喜欢/讨厌、启用/禁用…）、同一事实数值不同（IP、版本、日期、金额）、一方有否定词另一方没有。

### 冲突处理

```text
memory_search("Kestrel 服务器 IP")  →  返回旧记忆
memory_add(新 IP)                  →  action=conflict，新条目 status=conflict，旧条目不变
memory_update(新条目 id, {status:"active", confirmed:true, supersede:旧条目 id})
                                   →  新条目生效，旧条目 superseded，冲突关闭
```

未确认的冲突不会参与默认召回；需要排查时用 `memory_stats(includeConflicts:true)` 或 `memory://conflicts`。

### 召回

- 按当前任务上下文取最相关的少量记忆（默认 5 条），返回 `why` 说明为什么召回。
- 默认过滤：已归档、被取代、待删除、待确认冲突。
- 没有匹配就返回 `count: 0` 和「无匹配记忆」，**禁止编造**。
- 召回本身会刷新访问时间（`memory_get` 读取待删除项会恢复它）。

### 回放 / 睡眠巩固

`memory_replay`（插件默认每 24 小时自动跑一次，覆盖所有 namespace）：

1. **衰减**：按层系数重算权重。
2. **清理**：低权重、低置信度、60 天以上无访问的垃圾 → 待删除（7 天冷静期）；到期永久删除。
3. **归档**：低权重旧 `buffer`/`episodic` → `archived`（可恢复）；`semantic`/`persona` 不自动归档。
4. **巩固**：把 ≥3 条相似且共享标签的情景记忆提炼成一条 `semantic` 记忆，保留来源链接，重复回放不会重复生成。
5. **报告冲突**：未解决冲突数量写入结果，等待确认。

巩固是**抽取式**的（不调用 LLM）：`【回放提炼】<主题>：同类情景反复出现 N 次。典型情况：…（待验证）`。确认后再用 `memory_update` 提升置信度。
