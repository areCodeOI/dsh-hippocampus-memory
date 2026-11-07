# 海马体长期记忆 · dsh-hippocampus-memory

给 agent 的**跨会话长期记忆**，按「海马体 + 新皮层」互补学习系统（CLS）设计：
短期缓冲、情景、语义固化、人格四层记忆，默认存在本地 SQLite；需要多实例共享时切换到 PostgreSQL + pgvector。支持衰减、回放巩固、冲突管理与 7 天遗忘冷静期。

同一套存储同时以四种方式对外：

| 通道 | 使用方 | 入口 |
| --- | --- | --- |
| DSH 插件工具 | DeepSeek Harness 里的 agent | `memory_add` / `memory_search` / … 八个工具 |
| MCP stdio server | Claude Desktop/Code、Cursor、Cline、任何 MCP 客户端 | `bin/hippocampus-mcp.mjs` |
| HTTP / REST | Python、Go、PHP、Java、Node、curl……任何语言、任何模型 | `bin/hippocampus-http.mjs`（`/mcp` + `/api/*`） |
| WebUI | 人类管理员 | `http://127.0.0.1:7337/`（记忆库、星图、树、审计、任务、权限） |

本地优先：默认零外部服务，Node.js 22.13+ 自带的 `node:sqlite` 即可运行。需要水平扩容时配置 PostgreSQL（可选 pgvector）；此时只增加 `pg` 这一个纯 JS 依赖。向量嵌入是**可选**的：配置 OpenAI 兼容 / Ollama provider 后自动升级为混合检索；不配置时仍是完全离线的 FTS5 词法检索。

---

## 目录

- [特性](#特性)
- [v0.2 可视化与运维](#v02-可视化与运维)
- [记忆模型](#记忆模型)
- [快速开始](#快速开始)
  - [1. 安装为 DSH 插件](#1-安装为-dsh-插件)
  - [2. 接入 MCP 客户端](#2-接入-mcp-客户端)
  - [3. 启动 WebUI / HTTP 服务](#3-启动-webui--http-服务)
  - [4. 命令行](#4-命令行)
- [八个记忆工具](#八个记忆工具)
- [记忆规则（编码 / 查重 / 冲突 / 召回 / 回放）](#记忆规则编码--查重--冲突--召回--回放)
- [权限、审计与嵌入](#权限审计与嵌入)
- [异步任务与监控](#异步任务与监控)
- [数据与持久化](#数据与持久化)
- [配置项](#配置项)
- [部署与扩容](#部署与扩容)
- [其他语言调用示例](#其他语言调用示例)
- [架构](#架构)
- [隐私与安全](#隐私与安全)
- [测试](#测试)
- [常见问题](#常见问题)

---

## 特性

- **四层记忆**：`buffer` 短期缓冲 → `episodic` 情景 → `semantic` 语义固化 → `persona` 人格，衰减系数各不相同。
- **最小事实原则**：一条记忆只存一件事；写入前自动查重，重复就强化，补充就合并，冲突就挂起等确认。
- **不会无脑覆盖**：冲突信息单独存为 `conflict` 状态，保留旧记忆；确认后旧记忆标记 `superseded`，审计可追。
- **睡眠回放**：按指数衰减重算权重，归档低价值记忆，把多条相似情景提炼成一条语义记忆，清理过期待删除项。
- **7 天遗忘冷静期**：软删除后 7 天内被访问会自动恢复，到期才永久移除；人格记忆默认拒绝删除。
- **中文检索**：内置中英混排分词（CJK 二元组 + 英文单词）；SQLite 用 FTS5，PostgreSQL 用 `tsvector` + GIN，无需分词服务。
- **四种接入方式共用一份数据**：DSH 插件、MCP 进程、HTTP 进程可以同时读写同一个 WAL 数据库（跨机器时共享 PostgreSQL）。
- **可迁移**：`export` / `import` JSON 快照，换机器、备份、审计都方便。
- **自动召回**：DSH `agent/pre-step` 在每轮用户输入后自动检索相关记忆，并注入带来源标记的上下文；不再依赖模型主动想起调用 `memory_search`。
- **可水平扩容**：`storage: postgres` + 共享 PostgreSQL；`SKIP LOCKED` 任务队列、跨进程回放租约、数据库级 `change_seq`；pgvector 精确向量检索失败时自动回退 SimHash。
- **默认零第三方依赖**：SQLite 模式没有 native addon、没有云服务；只有启用 PostgreSQL 时才需要纯 JS 的 `pg` 包。

## v0.2 可视化与运维

v0.2 在 v0.1 的四层记忆内核上增加了完整的自托管管理面：

- **WebUI**：Vue 3 + Element Plus 重做的现代观测台，包含总览、记忆库、记忆星图、记忆树、异步任务、审计日志、设置与权限七个页面。
- **DSH 原生入口**：侧边栏「插件」旁的「记忆」按钮，打开 DSH 风格的管理面板；设置页也增加「记忆」分区。
- **记忆星图**：Canvas 力导向图；节点按记忆层着色、大小按重要性，边表示巩固链、冲突、共享标签与词法相似度；支持拖拽、滚轮缩放、点击查看详情。
- **记忆树**：按 `namespace → 记忆层 → 记忆` 展开，支持内容过滤与详情抽屉。
- **REST API**：分页列表、图谱投影、异步任务、审计、API key、指标、导出导入。
- **权限**：API key + `reader` / `writer` / `admin` 三级角色 + namespace 限制；bootstrap token；本机自动管理员。
- **审计**：`audit_log` 记录操作者、角色、动作、路径、IP、状态、请求 ID 与详情。
- **多模型嵌入**：OpenAI 兼容与 Ollama provider 可并配；FP32 + 4×16-bit SimHash 近似召回，异步回填；未配置时零开销。
- **缓存**：搜索结果、图谱、查询向量 TTL+LRU；写操作按 `changeSeq` 失效。
- **异步任务**：SQLite/PostgreSQL 任务队列 + lease + 重试 + 进度；PG 模式用 `FOR UPDATE SKIP LOCKED`，支持回放、嵌入回填、备份、维护。
- **监控**：`/health`、`/ready`、`/api/monitor`、Prometheus `/metrics`，以及 UI 运行状态卡。
- **可配置监听**：`--host 127.0.0.1|0.0.0.0|::`、`--port`，或环境变量；DSH 插件也可选择随进程启动 HTTP 服务。

## 记忆模型

| 层 | 名称 | 存什么 | 默认重要性 | 衰减 λ/天 | 半衰期 |
| --- | --- | --- | --- | --- | --- |
| `buffer` | 短期缓冲 | 本次会话临时指令、临时偏好、未验证猜测 | 2 | 0.35 | ≈ 2 天 |
| `episodic` | 情景记忆 | 何时/何地发生了什么、工具调用、报错踩坑、历史选择 | 4 | 0.08 | ≈ 9 天 |
| `semantic` | 语义固化 | 多次验证后的稳定知识、固定事实、长期项目配置 | 6 | 0.005 | ≈ 139 天 |
| `persona` | 人格记忆 | 用户稳定习惯、审美、偏好、禁忌、身体情况、底层诉求 | 8 | 0.001 | ≈ 693 天 |

权重公式：

```text
weight = 原始重要性 × e^(−λ_kind × 距上次访问天数)
```

- **重要性**是事实本身的属性（0.1–10）；**权重**是它现在还有多重要。
- 召回排序 ≈ 55% 文本相关 + 22% 当前权重 + 10% 近因 + 8% 置信度 + 5% 层权重。
- 回放时：低权重旧 `buffer`/`episodic` 归档；长期无访问、低置信度的垃圾进入待删除；`semantic`/`persona` 不自动删除。

## 快速开始

要求：**Node.js ≥ 22.13**（需要内置 `node:sqlite`，本项目已在 Node 24 上测试）。

```bash
cd /path/to/dsh-hippocampus-memory
node bin/hippocampus.mjs --help
npm test          # 61 个测试
```

默认数据库路径：`<插件目录>/.data/hippocampus/memory.db`；如果插件目录只读则回退 `$DSH_HOME/hippocampus/memory.db`。旧版 `$DSH_HOME/hippocampus/memory.db` 会自动兼容。
可以用 `--db`、`HIPPOCAMPUS_DB` 或插件配置 `dbPath` 覆盖。

### 1. 安装为 DSH 插件

本目录就是一个 DSH bundle（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`）。
在 DSH 会话里让 agent 执行：

```text
plugin_manager(action="install_bundle", target="/absolute/path/to/dsh-hippocampus-memory")
```

安装后当前 profile 会多一行 `hippocampus-memory`，注册八个 `memory_*` 工具、注入一段简短记忆规范，
并在 DSH 侧边栏「插件」旁增加「记忆」入口；重启/刷新 DSH 后出现（DSH 设置页也会多一个「记忆」分区）。
本地目录安装是 **link**：请把本目录放在一个长期稳定的位置，不要安装后删除或移动，否则插件会失效。
升级本地代码后，若插件管理提示 `restart-required`，重启一次 DSH 即可加载新模块；WebUI/REST 进程可独立运行最新代码。
`httpEnabled` 默认 `true`：插件会尝试随 DSH 进程启动 WebUI/REST（默认 `127.0.0.1:7337`）；若端口已被独立服务占用，会记录警告并继续使用已有服务。
插件配置可以在 profile 的 `cordis.patch.yml` 里用同 id 覆盖（见[配置项](#配置项)），或直接改本目录的 `cordis.patch.yml` 后重启 DSH。

安装后自检：

```text
memory_stats  →  totals.all 应为 0（新库）
memory_add    →  {"content":"用户偏好简体中文。","kind":"persona","importance":9}
memory_search →  {"query":"语言偏好"}
```

> 插件与 MCP/HTTP 进程使用同一个数据库文件，所以从 DSH 写入的记忆，Claude/Cursor 通过 MCP 也能立刻搜到。

### 2. 接入 MCP 客户端

MCP server 走 stdio，一行一个 JSON-RPC 消息；日志只写 stderr，不会污染协议。

```json
{
  "mcpServers": {
    "hippocampus": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-hippocampus-memory/bin/hippocampus-mcp.mjs"],
      "env": {
        "HIPPOCAMPUS_DB": "/absolute/path/to/memory.db"
      }
    }
  }
}
```

Windows 把 `command` 换成 `node.exe` 的绝对路径；Termux/Android 上 `node` 可能不在 GUI 的 PATH 中，建议直接写 Node 绝对路径。

不同客户端的配置文件位置：

| 客户端 | 配置 |
| --- | --- |
| Claude Desktop | `claude_desktop_config.json` → `mcpServers` |
| Claude Code | `.mcp.json` 或 `claude mcp add` |
| Cursor | `.cursor/mcp.json` → `mcpServers` |
| Cline / Roo Code | MCP Servers 面板 → Edit JSON |
| 自研客户端 | 任意 MCP SDK 的 stdio transport |

接入后客户端会看到：

- 8 个工具：`memory_add`、`memory_search`、`memory_get`、`memory_update`、`memory_archive`、`memory_delete`、`memory_replay`、`memory_stats`
- 3 个只读资源：`memory://stats`、`memory://recent`、`memory://conflicts`
- 1 个提示词：`hippocampus_memory_protocol`（把记忆使用规范注入模型）
- `initialize.instructions` 里自带中英文记忆协议，模型第一次连接就知道该怎么用

协议细节与完整会话示例见 [docs/MCP.md](docs/MCP.md)。

### 3. 启动 WebUI / HTTP 服务

```bash
# 默认 127.0.0.1:7337；--db 可指定别的库
node bin/hippocampus-http.mjs --port 7337
# 浏览器打开 http://127.0.0.1:7337/

# 需要跨机访问时再设 token（强烈建议）
HIPPOCAMPUS_TOKEN=change-me node bin/hippocampus-http.mjs --host 0.0.0.0 --port 7337

# 也可以完全自定义：IPv6 / 任意端口 / 外部链接
node bin/hippocampus-http.mjs --host 0.0.0.0 --port 18080
```

> 没有配置 `HIPPOCAMPUS_TOKEN` 时，本机回环访问自动以 admin 进入 UI；非回环访问仍然必须带 API key。生产环境建议设置 token 或 `HIPPOCAMPUS_AUTH=required`，并放在反向代理/TLS 后面。

```bash
# 写入
curl -s http://127.0.0.1:7337/api/memories \
  -H 'content-type: application/json' \
  -d '{"content":"项目 Kestrel 的生产服务器是 10.0.0.7。","kind":"semantic","importance":8,"confirmed":true}'

# 召回
curl -s 'http://127.0.0.1:7337/api/memories/search?q=Kestrel%20服务器&limit=3'

# 统计
curl -s http://127.0.0.1:7337/api/stats

# 同一个服务也接受 MCP JSON-RPC
curl -s http://127.0.0.1:7337/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

完整 REST 列表见 [docs/API.md](docs/API.md)。

### 4. 命令行

```bash
MEM=bin/hippocampus.mjs

node $MEM add "用户对花生过敏，严重时需立即就医。" --kind persona --importance 10 --tags 健康,过敏
node $MEM search "过敏" --limit 3
node $MEM search --mode recent                 # 最近访问
node $MEM stats
node $MEM replay --dry-run                     # 预览衰减/归档/巩固
node $MEM replay
node $MEM conflicts
node $MEM export backup.json
node $MEM import backup.json
node $MEM tool memory_add '{"content":"用户的猫叫 Mochi。","kind":"semantic","confirmed":true}'
node $MEM migrate --from-db /var/lib/hippocampus/memory.db --to-pg-url 'postgres://...'
node $MEM serve-http --port 7337
node $MEM serve-mcp
```

加 `--db /path/memory.db` 使用指定库；`--storage postgres --pg-url ...` 切共享库；加 `--json` 输出完整 JSON。

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

八个工具之外，HTTP/UI 还提供图谱、树、任务、审计、key、指标等管理端点（见 [docs/API.md](docs/API.md)）。

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

## 数据与持久化

```text
<plugin>/.data/hippocampus/memory.db      主库（SQLite，WAL；默认）
$DSH_HOME/hippocampus/memory.db          旧版/回退位置（自动兼容）
<db>.db-wal / <db>.db-shm                WAL 与共享内存
```

表结构：

| 表 | 内容 |
| --- | --- |
| `memories` | 记忆主表（内容、层、重要性、置信度、权重、状态、冲突链、来源、标签、元数据） |
| `memory_fts` | SQLite FTS5 / PostgreSQL `tsvector` 全文索引（预分词后的中英 token） |
| `conflicts` | 冲突记录与解决状态 |
| `events` | 追加式事件日志（add / reinforce / merge / update / archive / delete / replay…） |
| `meta` | schema 版本、创建时间、上次回放时间、共享 change_seq |
| `leases` | 跨进程维护租约（回放/导入） |
| `jobs` / `audit_log` / `api_keys` | 异步任务、审计、API key |

- **长期**：文件落盘，跨会话、跨重启、跨 DSH 升级保留。
- **并发**：WAL 模式允许同一台机器上的 DSH 插件、MCP 进程、HTTP 进程同时读写；写操作串行、有 15 秒 busy timeout。
- **水平扩容**：把 `storage` 设为 `postgres`（`pgUrl` 指向共享 PostgreSQL，可选 pgvector），多个 DSH/HTTP/MCP 实例共享同一份记忆；任务队列使用 `SKIP LOCKED`，回放使用跨进程租约，变更序号由数据库统一递增。详见 [docs/OPERATIONS.md](docs/OPERATIONS.md#postgresql-水平扩容)。
- **默认位置**：SQLite 新库默认在 `<插件目录>/.data/hippocampus/memory.db`；旧版 `$DSH_HOME/hippocampus/memory.db` 自动兼容。也可用 `dataDir` / `HIPPOCAMPUS_DATA_DIR` / `--data-dir` 指定。
- **备份**：

```bash
node bin/hippocampus.mjs export backup.json
node bin/hippocampus.mjs import backup.json
# SQLite：直接复制 memory.db（先停写更稳妥）
# PostgreSQL：pg_dump -Fc "$HIPPOCAMPUS_PG_URL" -f hippocampus.dump
```

- **迁移**：`HIPPOCAMPUS_DB=/new/path/memory.db` 或 `--db`。
- **导出**：CLI `export`、HTTP `GET /api/export`；MCP 通过 `memory_*` 工具读写，资源只读。
- **重置**：停止所有写入进程后删除 `memory.db*` 即可；建议先 export。

## 配置项

插件行在包内的 `cordis.patch.yml`；默认配置：

```yaml
- insert:
    - id: hippocampus-memory
      name: dsh-hippocampus-memory
      config:
        storage: ''                # sqlite | postgres；空 = 有 pgUrl 时 postgres
        dbPath: ''                 # 空 = <plugin>/.data/hippocampus/memory.db（旧 $DSH_HOME 库优先）
        dataDir: ''                # 指定目录，优先于默认位置
        dataLocation: plugin       # plugin | dsh
        pgUrl: ''                  # postgres://user:pass@host:5432/hippocampus
        pgSchema: public
        pgvector: true             # 扩展不可用时自动回退 SimHash
        pgPoolMax: 4
        graphProvider: projection  # projection | postgres
        autoRecall: true           # 每轮自动召回并注入上下文
        autoRecallLimit: 4
        autoRecallMaxChars: 1200
        autoRecallMinScore: 0.18
        autoRecallNamespace: ''    # 空 = 当前 namespace；* = 全部
        namespace: default         # 默认记忆空间
        injectPrompt: true         # 是否注入记忆使用规范
        autoReplay: true           # 后台自动回放
        replayIntervalHours: 24    # 回放间隔
        retrievalLimit: 5          # 默认召回条数
        promptLanguage: auto       # auto | zh | en
        # 随 DSH 进程启动 WebUI/REST/MCP-over-HTTP
        httpEnabled: true
        httpHost: 127.0.0.1
        httpPort: 7337
        httpToken: ''              # 空 = 本机自动管理员
```

要覆盖配置，不要改 profile 的 `package.json`；在 `$DSH_PROFILE_DIR/cordis.patch.yml` 末尾加一个同 id 的覆盖行即可（Loader 会用完整 `config` 替换原行）：

```yaml
- id: hippocampus-memory
  config:
    namespace: default
    retrievalLimit: 8
    autoReplay: true
```

也可以直接改本目录的 `cordis.patch.yml`（本地安装是 link，改动重启 DSH 后生效）。

环境变量（MCP / HTTP / CLI）：

| 变量 | 作用 |
| --- | --- |
| `HIPPOCAMPUS_DB` | SQLite 数据库路径 |
| `HIPPOCAMPUS_STORAGE` | `sqlite` / `postgres` |
| `HIPPOCAMPUS_PG_URL` | PostgreSQL 连接串（设置后自动切 postgres） |
| `HIPPOCAMPUS_PG_SCHEMA` | PostgreSQL schema，默认 public |
| `HIPPOCAMPUS_DATA_DIR` | SQLite 数据目录 |
| `HIPPOCAMPUS_DATA_LOCATION` | `plugin`（默认）/ `dsh` |
| `HIPPOCAMPUS_GRAPH_PROVIDER` | `projection` / `postgres` |
| `HIPPOCAMPUS_NAMESPACE` | 默认 namespace |
| `HIPPOCAMPUS_PORT` / `HIPPOCAMPUS_HOST` | HTTP 监听地址 |
| `HIPPOCAMPUS_TOKEN` | bootstrap admin token；设置后所有请求都要认证 |
| `HIPPOCAMPUS_AUTH` | `auto`（默认）/ `required`（回环也要认证）/ `open` |
| `HIPPOCAMPUS_WEB_ROOT` | 自定义 WebUI 静态目录 |
| `HIPPOCAMPUS_RATE_LIMIT` / `HIPPOCAMPUS_RATE_WINDOW_MS` | 每 key/IP 限流 |
| `HIPPOCAMPUS_METRICS_PUBLIC` | `1` 时 `/metrics` 不需要 token |
| `HIPPOCAMPUS_EMBEDDING_PROVIDER` | `openai` / `ollama` / `none` |
| `HIPPOCAMPUS_EMBEDDING_BASE_URL` | OpenAI 兼容端点或 Ollama 地址 |
| `HIPPOCAMPUS_EMBEDDING_API_KEY` / `_MODEL` / `_DIM` | 单 provider 配置 |
| `HIPPOCAMPUS_EMBEDDINGS` | 多 provider JSON 数组，见下文 |
| `HIPPOCAMPUS_JOB_CONCURRENCY` / `_INTERVAL_MS` | 后台 worker |
| `HIPPOCAMPUS_VECTOR_WEIGHT` | 混合检索中向量权重，默认 0.35 |
| `DSH_HOME` | 默认数据目录来源 |
| `DSH_LANG` / `LANG` | 自动选择提示词语言 |

## 权限、审计与嵌入

### API key 与角色

| 角色 | 能力 |
| --- | --- |
| `reader` | 搜索、列表、读取、图谱、树、统计、导出 |
| `writer` | reader + 写入、更新、归档、软删除、回放、任务 |
| `admin` | 全部：硬删除、导入、审计、API key、配置、备份、维护 |

在 UI「设置与权限 → 新建 key」或 `POST /api/keys` 创建；完整 key 只返回一次，服务端只存 SHA-256 hash。
`HIPPOCAMPUS_TOKEN` 是 bootstrap admin token；API key 可限制 namespace 列表（如 `["project-a","default"]`）。

### 审计

所有写操作、key 管理、任务、权限拒绝都会写入 `audit_log`：时间、request id、actor、role、action、method/path、target、namespace、IP、HTTP 状态、detail。UI「审计日志」可按 action/actor 过滤并分页。

### 多模型嵌入

单 provider：

```bash
HIPPOCAMPUS_EMBEDDING_PROVIDER=openai \
HIPPOCAMPUS_EMBEDDING_BASE_URL=https://api.openai.com/v1 \
HIPPOCAMPUS_EMBEDDING_API_KEY=sk-... \
HIPPOCAMPUS_EMBEDDING_MODEL=text-embedding-3-small \
HIPPOCAMPUS_EMBEDDING_DIM=1536 \
node bin/hippocampus-http.mjs --port 7337
```

多 provider（同时索引多个模型；混合检索取各模型的最高相似度）：

```bash
HIPPOCAMPUS_EMBEDDINGS='[
  {"id":"openai-small","kind":"openai","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","model":"text-embedding-3-small","dim":1536},
  {"id":"local-bge","kind":"ollama","baseUrl":"http://127.0.0.1:11434","model":"bge-m3","dim":1024}
]' node bin/hippocampus-http.mjs --port 7337
```

写入/更新后，HTTP 服务会自动入队 `embed` 任务；DSH 插件与 stdio MCP 在配置 provider 后会同步索引新记忆。历史数据用 UI「异步任务 → 嵌入回填」或 `POST /api/jobs {"type":"embed_backfill"}`。检索时若查询 embedding 可用，会把词法候选与 SimHash 近邻合并，按 `HIPPOCAMPUS_VECTOR_WEIGHT` 加权。未配置 provider 时嵌入完全关闭，不产生网络请求。

## 异步任务与监控

任务类型：`replay`、`embed`、`embed_backfill`、`backup`、`maintenance`、`graph`、`tree`。任务存 SQLite/PostgreSQL，可跨进程/重启恢复；SQLite 用原子 `UPDATE ... RETURNING`，PostgreSQL 用 `FOR UPDATE SKIP LOCKED`，多 worker 不会重复领取；长任务每 30 秒续租。

```bash
curl -s -X POST http://127.0.0.1:7337/api/jobs \
  -H 'content-type: application/json' \
  -d '{"type":"embed_backfill","payload":{"limit":1000}}'

curl -s http://127.0.0.1:7337/api/jobs?limit=10
curl -s http://127.0.0.1:7337/api/monitor
curl -s http://127.0.0.1:7337/metrics
```

Prometheus 指标包括：HTTP 请求/延迟、进程内存、各层记忆数、DB 大小、冲突数、任务状态、缓存命中、嵌入覆盖。UI 总览页也会展示 RSS、缓存、队列、速率限制。

## 其他语言调用示例

### Python（REST）

```python
import requests

BASE = "http://127.0.0.1:7337"

requests.post(f"{BASE}/api/memories", json={
    "content": "用户偏好深色主题。",
    "kind": "persona",
    "importance": 8,
    "tags": ["ui"],
}).raise_for_status()

hits = requests.get(f"{BASE}/api/memories/search", params={"q": "主题偏好", "limit": 3}).json()
for memory in hits["memories"]:
    print(memory["kind"], memory["content"], "|", memory["why"])
```

### Go

```go
body := strings.NewReader(`{"content":"用户的时区是 Asia/Shanghai。","kind":"persona","importance":9}`)
resp, err := http.Post("http://127.0.0.1:7337/api/memories", "application/json", body)
// ...
resp, err = http.Get("http://127.0.0.1:7337/api/memories/search?q=" + url.QueryEscape("时区"))
```

### PHP

```php
$ctx = stream_context_create(['http' => [
  'method'  => 'POST',
  'header'  => "content-type: application/json\r\n",
  'content' => json_encode(['content' => '用户喜欢喝拿铁。', 'kind' => 'persona']),
]]);
file_get_contents('http://127.0.0.1:7337/api/memories', false, $ctx);
```

### 任意 MCP 客户端

用官方 SDK 建立 stdio 连接后：

```text
tools/call  memory_add     {"content":"...","kind":"episodic"}
tools/call  memory_search  {"query":"...","limit":5}
```

MCP 客户端的模型不需要知道 SQLite 或本项目内部结构，只需要这 8 个工具。

## 架构

```text
dsh-hippocampus-memory/
├── index.js              DSH Host 插件：注册工具 + 系统提示词 + 定时回放
├── cordis.patch.yml      DSH bundle 行
├── lib/
│   ├── constants.js      四层/状态/衰减系数/阈值
│   ├── text.js           中英分词、相似度、冲突启发式、摘要
│   ├── scoring.js        重要性推断、指数衰减、召回打分、why
│   ├── db.js             SQLite/PostgreSQL 打开、schema、行映射、事务
│   ├── store.js          MemoryStore：add/search/list/get/update/archive/remove/replay/export/import
│   ├── tools.js          8 个工具定义 + DSH/MCP 共用 handler + 系统提示词
│   ├── mcp.js            JSON-RPC / MCP 方法分发、resources、prompts
│   ├── http.js           HTTP 路由、REST、MCP-over-HTTP、静态 UI、OpenAPI
│   ├── runtime.js        auth/audit/cache/jobs/embeddings 运行时装配 + job handlers
│   ├── auth.js           API key、角色、namespace、bootstrap
│   ├── audit.js          审计日志
│   ├── jobs.js           异步任务队列（SQLite lease；PG SKIP LOCKED）
│   ├── embeddings.js     OpenAI 兼容 / Ollama 多 provider + 混合召回
│   ├── vector.js         FP32、余弦、SimHash bands
│   ├── graph.js          星图/树投影
│   ├── cache.js          TTL+LRU
│   ├── metrics.js        Prometheus / 监控快照
│   ├── ratelimit.js      固定窗口限流
│   ├── paths.js          数据目录 / SQLite / PostgreSQL 配置解析
│   ├── pg-sync.js        同步 PG 门面（兼容现有 MemoryStore 调用）
│   ├── pg-worker.mjs     worker 线程中的 async pg 连接池
│   ├── pg-schema.js      PostgreSQL / pgvector schema
│   └── exec.js           跨平台 node 可执行文件解析（Termux 兼容）
├── client.js            DSH Web Client：侧边栏「记忆」+ 主面板 + 设置分区
├── web/                 Vue 3 + Element Plus 构建产物（index.html / assets）
├── webapp/              WebUI 源码（Vue SFC + Vite；构建后输出到 web/）
├── bin/
│   ├── hippocampus.mjs       CLI
│   ├── hippocampus-mcp.mjs   MCP stdio server
│   └── hippocampus-http.mjs  HTTP + WebUI server
├── test/                 store / mcp / http / auth / jobs / embeddings 测试
├── docs/                 UI、API、MCP、安全、运维、参考项目
├── locale/, icon.svg     插件展示元数据
└── package.json
```

数据流：

```text
DSH agent / MCP client / HTTP client / CLI
        │
        ├── tools.js（统一参数与 handler）
        ├── mcp.js / http.js（协议适配）
        ▼
    MemoryStore（业务规则） + Auth/Audit/Jobs/Embeddings/Cache
        ▼
   存储适配器（storage: sqlite | postgres）
        ├── SQLite（WAL + FTS5 + SimHash）
        └── PostgreSQL（pg + pgvector + tsvector + SKIP LOCKED 任务队列）
```

## 部署与扩容

### 单机自托管

```bash
# 推荐：token + 明确监听 + 持久目录
export HIPPOCAMPUS_DB=/srv/hippocampus/data/memory.db
export HIPPOCAMPUS_TOKEN='<long-random-token>'
node bin/hippocampus-http.mjs --host 127.0.0.1 --port 7337
```

反向代理（Nginx/Caddy）负责 TLS 与外部鉴权；后端仍只监听回环。systemd 示例：

```ini
[Unit]
Description=Hippocampus Memory
After=network.target

[Service]
WorkingDirectory=/opt/dsh-hippocampus-memory
Environment=HIPPOCAMPUS_DB=/var/lib/hippocampus/memory.db
Environment=HIPPOCAMPUS_TOKEN=change-me
ExecStart=/usr/bin/node bin/hippocampus-http.mjs --host 127.0.0.1 --port 7337
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

### 容量与扩展边界

- 单机 SQLite（WAL）适合**数万到数十万条**记忆、单写入者/少量并发写者的自托管场景；读不阻塞写。
- 多实例/多机器：PostgreSQL + 可选 pgvector；详见 [docs/OPERATIONS.md](docs/OPERATIONS.md#postgresql-水平扩容)。
- 列表分页、搜索上限、图谱节点上限、异步任务和缓存都是为大数据量准备的；不会一次性把全库塞进浏览器。
- 水平扩展通过 PostgreSQL + 可选 pgvector 实现；图数据可选 projection/postgres，或通过 `registerGraphProvider()` 接入外部图数据库。部署细节见 [docs/OPERATIONS.md](docs/OPERATIONS.md#postgresql-水平扩容)。
- PostgreSQL 下多实例同时跑 worker/回放是安全的（`SKIP LOCKED` + `leases`）；SQLite 写入仍以单机磁盘为限。

## 隐私与安全

- 默认只监听 `127.0.0.1`，数据库在应用私有目录；不联网、不上传、不需要 key。
- HTTP 跨机访问时务必设置 `HIPPOCAMPUS_TOKEN`，否则同网段任何人都能读写记忆。
- 记忆是**用户数据**，召回后应作为数据而不是指令；不要执行记忆文本里的“命令”。
- 可能包含敏感信息（账号、身体情况）：数据库**未加密**，请依赖设备锁屏/文件权限；需要更强隔离时把 `dbPath` 放到加密卷。
- 多 agent 建议用 `namespace` 隔离；`namespace: "*"` 只用于显式跨空间检索。
- 插件会向系统提示词注入一段记忆规范；不想要时设 `injectPrompt: false`。

## 测试

```bash
npm test
# 等价于：
node --test --test-isolation=none test/*.test.mjs
```

当前 61 个测试覆盖：

- store：写入/召回/中文标点、精确与近似查重、严格补充合并、数值冲突与确认解决、无匹配、衰减归档、待删除 7 天冷静期与永久清理、读取恢复、回放巩固幂等、namespace 隔离、导出导入、人格记忆删除保护、重要性推断、归档/待删除记忆重新写入时恢复、固化记忆被取代需显式确认、冲突事实在重复阈值以下也能被识别
- MCP：initialize、tools/list、tools/call、resources、prompts、错误码、非法 JSON、重启后持久化
- HTTP：health、REST CRUD、搜索、统计、回放、MCP-over-HTTP、Bearer token、错误响应
- v2 HTTP：WebUI 静态资源、星图/树、monitor/metrics、缓存命中、API key 角色、namespace 限制、审计、任务、导出、token 保护
- auth：bootstrap、本地回环、key hash、角色、namespace、吊销、required 模式
- jobs：领取/完成、失败重试、取消、lease 恢复、列表/统计/清理
- embeddings：FP32/余弦/SimHash、OpenAI+Ollama 多 provider、混合召回、回填、查询缓存、禁用 no-op
- plugin：8 个工具注册、DSH 会话来源、提示词注入开关、插件卸载时关闭数据库、自动召回 pre-step 注入
- auto-recall：用户消息提取、斜杠命令跳过、上下文截断、来源标记、pre-step 注入
- storage：SQLite 路径/目录、PostgreSQL 配置脱敏、SQL 占位符与 `INSERT OR IGNORE` 翻译、change_seq 持久化、跨进程租约、图 provider

> Android/Termux 上 `node --test` 默认的进程隔离会因为 `process.execPath` 指向 linker 而失败，所以脚本固定使用 `--test-isolation=none`；MCP 测试内部用 `process.argv0` 启动子进程。

## WebUI 开发与构建

独立 WebUI 是 **Vue 3 + Element Plus + Vite** 的 SPA，源码在 `webapp/`，构建产物在 `web/`（运行时不需要 Node 构建工具链）。

```bash
cd webapp
npm install
node node_modules/vite/bin/vite.js build --outDir ../web --emptyOutDir
```

Android/Termux 上如果 `node_modules` 位于 `/storage` 会因 linker namespace 无法加载 Rollup native 模块：请在应用私有目录（如 `$TMPDIR/webapp-build`）安装依赖并构建，再把 `web/` 同步回包目录。构建脚本与说明见 `webapp/` 和 [docs/UI.md](docs/UI.md)。

不希望用 Vue 也可以只替换 `web/` 下的静态文件；后端只依赖 `/api/*`，不依赖前端框架。

## 文档

- [docs/UI.md](docs/UI.md) — WebUI 页面、星图/树交互、登录与权限
- [docs/API.md](docs/API.md) — REST 路由、分页、图谱、任务、审计、key
- [docs/MCP.md](docs/MCP.md) — MCP stdio/HTTP 接入
- [docs/MEMORY-MODEL.md](docs/MEMORY-MODEL.md) — 四层模型、回放、schema、混合检索
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — systemd、反向代理、备份恢复、扩容边界
- [docs/SECURITY.md](docs/SECURITY.md) — 信任边界、角色、API key、审计、加固清单
- [docs/REFERENCES.md](docs/REFERENCES.md) — 参考的开源项目与设计取舍

## 常见问题

**Q：为什么默认不用向量数据库？**
A：本地优先：SQLite FTS5 + 二元组 + 重要性/近因加权在中文短事实场景已经够用。需要语义召回时配置嵌入 provider 即可；SQLite 用 BLOB + SimHash 分桶，PostgreSQL 可选 pgvector 精确余弦。

**Q：为什么 `memory_search` 返回空？**
A：说明库里没有相关记忆。这不代表模型可以编造；按规范应直接告诉用户「没有相关记忆」。

**Q：为什么重复写入没有增加条数？**
A：查重命中后强化旧记忆（权重、访问次数、标签），这是设计目标：控制记忆库膨胀。

**Q：冲突为什么不自动取新的？**
A：规范要求「没有证据不覆盖固化记忆」。新信息先挂 `conflict`，确认后才取代旧条目，旧条目保留 `superseded` 审计。

**Q：多个进程同时写会锁吗？**
A：SQLite 用 WAL + `busy_timeout=15000`，正常并发没问题；极高写入频率或跨机器请切 PostgreSQL，多实例共享。

**Q：能存英文/日文吗？**
A：可以。分词对英文按单词、CJK 按二元组；记忆内容建议统一简体中文（人格/语义），但检索支持中英混排。

**Q：Node 版本不够？**
A：`node:sqlite` 需要 ≥ 22.13（22.5–22.12 需 `--experimental-sqlite`）。低于此版本请升级 Node。

---

MIT License. 记忆规则参考互补学习系统（CLS）与海马-新皮层双系统模型；实现与文档为本项目原创。
