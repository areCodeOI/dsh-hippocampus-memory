# 配置与部署

> **适合谁**：部署者、想调路径/端口/数据库的人
> **难度**：进阶 · **预计阅读**：10 分钟
> **前置**：会用命令行、能改环境变量

一句话：默认零配置就能用；要改数据位置、端口、数据库或嵌入时才需要本文。

本文说明数据位置、配置项、权限与嵌入、异步任务以及部署扩容。

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
- **水平扩容**：把 `storage` 设为 `postgres`（`pgUrl` 指向共享 PostgreSQL，可选 pgvector），多个 DSH/HTTP/MCP 实例共享同一份记忆；任务队列使用 `SKIP LOCKED`，回放使用跨进程租约，变更序号由数据库统一递增。详见 [OPERATIONS.md](OPERATIONS.md#8-postgresql-水平扩容)。
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
        autoCapture: false         # 实验性：本地规则自动捕获用户明确陈述的少量稳定事实
        autoCaptureNamespace: ''   # 空 = 默认 namespace；不支持 *
        autoCaptureMaxPerTurn: 2   # 每条用户消息最多捕获几条候选
        namespace: default         # 默认记忆空间
        injectPrompt: true         # 是否注入记忆使用规范
        autoReplay: true           # 后台自动回放
        replayIntervalHours: 24    # 回放间隔
        retrievalLimit: 5          # 默认召回条数
        promptLanguage: auto       # auto | zh | en
        # 默认开启；首次打开 WebUI 创建管理员（邮箱+密码）。不需要时改为 false。
        httpEnabled: true
        httpHost: 127.0.0.1
        httpPort: 7337
        httpToken: ''              # 可选 bootstrap admin token；WebUI 用管理员账号
        corsOrigins: []            # 额外允许的浏览器 Origin；桌面壳 dsh-app:/dsh: 默认放行
```

### 桌面端、CORS 与数据位置

- DSH 桌面端页面 origin 是 `dsh-app://app`，不是 `http://127.0.0.1:<port>`。
  v0.3.0 默认放行 `dsh-app:` / `dsh:` 协议；其他来源用 `corsOrigins`
  （数组或逗号分隔字符串）或 `HIPPOCAMPUS_CORS_ORIGINS` 追加，两者合并。
- 端口被占用时服务先按 3 次 × 300ms 退避重试；确认端口上已有健康的海马体实例时
  直接复用（日志会写明），不会悄悄失败。实际端口可在面板/WebUI 和
  `/api/public-config` 的 `port` 字段看到。
- `dataLocation: plugin`（默认）把数据库放在插件目录内，适合独立安装；如果是
  git checkout + `link:` 安装，建议改为 `dsh` 或显式 `dbPath`，避免
  `git clean`/重装目录时丢失记忆。插件启动日志会打印实际 `dbPath`。

dsh-go 的插件详情 →「设置」会直接读取这里的 `Config` schema，可改
`httpEnabled`、`httpPort`、`namespace`、`autoRecall`、`autoCapture`、`injectPrompt`、
`autoReplay`、`retrievalLimit`；保存后按 App 提示重启/生效。

### 自动捕获（实验性，默认关闭）

`autoCapture: true` 时，插件在 `agent/pre-step` 用**本地确定性规则**从最新一条用户消息中抽取少量
明确陈述（例如“记住/以后/不要/我喜欢/项目使用/部署在”），以 `episodic`、`confirmed:false` 写入，
标签 `auto-capture`，不调用模型、不保存整段对话。每轮最多 `autoCaptureMaxPerTurn` 条；跳过 slash 命令、
代码块、问题和含密码/token/身份证等敏感词的整条消息。首次使用建议先观察标签为 `auto-capture` 的记忆，
确认噪声可接受后再长期开启。该功能不会自动写入 `persona`，也不会绕过 namespace 的只读/归档策略。

要覆盖配置，不要改 profile 的 `package.json`；在 `$DSH_PROFILE_DIR/cordis.patch.yml` 末尾加一个同 id 的覆盖行即可（Loader 会用完整 `config` 替换原行）：

```yaml
- id: hippocampus-memory
  config:
    namespace: default
    retrievalLimit: 8
    autoReplay: true
```

也可以直接改本目录的 `cordis.patch.yml`（本地安装是 link，改动重启 DSH 后生效）。

### 命名空间管理

- 空间是隐式的：写入首条记忆时创建；也可以在 WebUI「记忆空间」页或 CLI 预留空空间。
- 默认空间由 `namespace` 配置决定；重命名/删除/合并默认空间需要先改配置，或显式 `force=true`。
- 重命名会同步 API key 的空间白名单和排队任务；历史审计保留旧名称。
- v0.4 起使用 `namespaces` 表保存空间元数据与轻量策略（schemaVersion 4）；旧库启动时自动从 `meta.namespace_registry` 迁移，无需手工操作。
- 每空间可配 `description/color/readOnly/archived/retentionDays/autoRecall/embeddingProvider/softLimit/settings`：
  `readOnly`/`archived` 拒绝新的记忆写入；`retentionDays` 由回放归档过期记忆；`autoRecall:false` 跳过自动召回。
- 危险空间操作默认先自动写逻辑备份（见 [API.md](API.md#备份与恢复)），可用 `--no-backup` 关闭。
- namespace 是逻辑分区，不是加密/权限边界；硬隔离请用独立 DB 或 PostgreSQL schema。

```bash
node bin/hippocampus.mjs namespace list
node bin/hippocampus.mjs namespace create project-kestrel
node bin/hippocampus.mjs namespace rename project-kestrel project-kepler
node bin/hippocampus.mjs namespace merge project-kepler default
node bin/hippocampus.mjs namespace delete project-kepler                    # 7 天冷静期
node bin/hippocampus.mjs namespace delete project-kepler --hard --confirm    # 永久删除
```

WebUI 对应页面与 HTTP 接口见 [API.md](API.md#命名空间管理)。

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
| `HIPPOCAMPUS_CORS_ORIGINS` | 额外允许的浏览器跨源 Origin（逗号分隔；`*` 放开，慎用） |
| `HIPPOCAMPUS_BACKUP_BEFORE_NAMESPACE` | 危险空间操作前自动备份，默认 `1`；`0` 关闭 |
| `HIPPOCAMPUS_BACKUP_KEEP` | 逻辑备份保留份数，默认 20 |
| `HIPPOCAMPUS_BACKUP_DIR` | PostgreSQL 模式的备份目录；SQLite 固定为数据库同目录 `backups/` |
| `HIPPOCAMPUS_MAINTENANCE_HOURS` | 每日 maintenance 调度间隔（小时，默认 24；`0` 关闭） |
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
- 多实例/多机器：PostgreSQL + 可选 pgvector；详见 [OPERATIONS.md](OPERATIONS.md#8-postgresql-水平扩容)。
- 列表分页、搜索上限、图谱节点上限、异步任务和缓存都是为大数据量准备的；不会一次性把全库塞进浏览器。
- 水平扩展通过 PostgreSQL + 可选 pgvector 实现；图数据可选 projection/postgres，或通过 `registerGraphProvider()` 接入外部图数据库。部署细节见 [OPERATIONS.md](OPERATIONS.md#8-postgresql-水平扩容)。
- PostgreSQL 下多实例同时跑 worker/回放是安全的（`SKIP LOCKED` + `leases`）；SQLite 写入仍以单机磁盘为限。
