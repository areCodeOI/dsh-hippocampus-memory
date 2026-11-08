# 自托管部署与运维

> **适合谁**：负责部署、备份、扩容的运维/维护者
> **难度**：进阶 · **预计阅读**：15 分钟
> **前置**：基本 Linux/Node 使用经验

目标形态：单机或水平扩容、可选反向代理、SQLite 或 PostgreSQL 持久化、WebUI/REST/MCP 共用一个库。

## 1. 目录与进程

推荐的目录布局：

```text
/opt/dsh-hippocampus-memory/            代码/静态资源（只读）
/opt/dsh-hippocampus-memory/.data/     SQLite 默认位置（插件相对；可写）
/var/lib/hippocampus/memory.db         显式 dataDir 时的数据库（600，可写）
/var/lib/hippocampus/backups/          备份
```

进程：

- `bin/hippocampus-http.mjs`：WebUI + REST + MCP over HTTP + 后台 job worker。
- `bin/hippocampus-mcp.mjs`：stdio MCP（由客户端启动，不自带 worker）。
- `bin/hippocampus.mjs`：CLI / 维护命令。
- DSH 插件：Host 内工具 + 定时回放；可选 `httpEnabled` 随进程启动 HTTP 服务。

SQLite：建议只让一个长期进程启动 worker（HTTP 服务或 DSH 插件中的一个）；多个 worker 也安全（lease + 原子 claim），但会增加写竞争。
PostgreSQL：每个 HTTP/DSH 实例都可以启动 worker，`SKIP LOCKED` 保证任务只被领取一次；这是水平扩容的推荐形态。

## 2. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HIPPOCAMPUS_DB` | `<plugin>/.data/hippocampus/memory.db` | SQLite 文件路径 |
| `HIPPOCAMPUS_DATA_DIR` | 插件 `.data/hippocampus` | SQLite 目录 |
| `HIPPOCAMPUS_DATA_LOCATION` | `plugin` | `plugin` / `dsh` |
| `HIPPOCAMPUS_STORAGE` | `sqlite` | `sqlite` / `postgres` |
| `HIPPOCAMPUS_PG_URL` | 空 | PostgreSQL 连接串 |
| `HIPPOCAMPUS_PG_SCHEMA` | `public` | PostgreSQL schema |
| `HIPPOCAMPUS_PGVECTOR` | `true` | 尝试 pgvector，失败回退 SimHash |
| `HIPPOCAMPUS_PG_POOL_MAX` | `4` | worker 连接池上限 |
| `HIPPOCAMPUS_GRAPH_PROVIDER` | `projection` | `projection` / `postgres` |
| `HIPPOCAMPUS_HOST` | `127.0.0.1` | 监听地址 |
| `HIPPOCAMPUS_PORT` | `7337` | 监听端口 |
| `HIPPOCAMPUS_TOKEN` | 空 | bootstrap admin token；设置后强制认证 |
| `HIPPOCAMPUS_AUTH` | `auto` | `auto` / `required` / `open` |
| `HIPPOCAMPUS_RATE_LIMIT` | `600` | 每窗口请求数 |
| `HIPPOCAMPUS_RATE_WINDOW_MS` | `60000` | 窗口毫秒 |
| `HIPPOCAMPUS_CORS_ORIGINS` | 空 | 额外允许的浏览器跨源 Origin（逗号分隔；`*` 放开） |
| `HIPPOCAMPUS_MAINTENANCE_HOURS` | `24` | 每日 maintenance 间隔（小时；`0` 关闭，随 HTTP 服务 worker 调度） |
| `HIPPOCAMPUS_JOB_CONCURRENCY` | `1` | worker 并发 |
| `HIPPOCAMPUS_JOB_INTERVAL_MS` | `1000` | worker 轮询间隔 |
| `HIPPOCAMPUS_METRICS_PUBLIC` | 空 | `1` 时 `/metrics` 免认证 |
| `HIPPOCAMPUS_WEB_ROOT` | 包内 `web/` | UI 静态目录 |
| `HIPPOCAMPUS_EMBEDDING_*` / `HIPPOCAMPUS_EMBEDDINGS` | 空 | 嵌入 provider |
| `HIPPOCAMPUS_VECTOR_WEIGHT` | `0.35` | 混合检索向量权重 |
| `DSH_HOME` / `DSH_LANG` | — | DSH 兼容 |

## 3. systemd

```ini
[Unit]
Description=Hippocampus Memory
After=network.target

[Service]
Type=simple
User=hippocampus
Group=hippocampus
WorkingDirectory=/opt/dsh-hippocampus-memory
Environment=HIPPOCAMPUS_DB=/var/lib/hippocampus/memory.db
Environment=HIPPOCAMPUS_TOKEN=replace-with-long-random-token
Environment=HIPPOCAMPUS_HOST=127.0.0.1
Environment=HIPPOCAMPUS_PORT=7337
ExecStart=/usr/bin/node bin/hippocampus-http.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/hippocampus
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hippocampus
curl -s http://127.0.0.1:7337/ready
```

## 4. 反向代理与 TLS

### Caddy

```caddy
memory.example.com {
  encode gzip
  request_body {
    max_size 25MB
  }
  reverse_proxy 127.0.0.1:7337
}
```

### Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name memory.example.com;
  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:7337;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
  }
}
```

> 如果代理把来源改写成 `127.0.0.1`，服务端的“回环自动管理员”会把外部请求当本地管理员。生产环境请设置 `HIPPOCAMPUS_TOKEN` 或 `HIPPOCAMPUS_AUTH=required`，不要依赖来源地址。

## 5. 备份与恢复

### 逻辑导出（推荐跨版本/跨机器）

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:7337/api/export > backup-$(date +%F).json

# 恢复（admin）
curl -s -X POST http://127.0.0.1:7337/api/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data-binary @backup.json
```

### 物理备份

SQLite：UI/API 的 `backup` 任务会在数据库同级的 `backups/` 下执行 `VACUUM INTO`，得到一致性快照。
PostgreSQL：用 `pg_dump -Fc` 或云厂商快照；应用内 `backup` 任务在 PG 模式写 JSON 逻辑快照。

```bash
pg_dump -Fc "$HIPPOCAMPUS_PG_URL" -f hippocampus-$(date +%F).dump
```

SQLite 备份任务：

```bash
curl -s -X POST http://127.0.0.1:7337/api/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"backup","payload":{}}'
```

也可以停机后复制 `memory.db`（连同 `-wal`/`-shm` 一起，或先 checkpoint）。**不要**在写入过程中只复制主文件而丢掉 WAL。

恢复：

```bash
systemctl stop hippocampus
cp /var/lib/hippocampus/backups/memory-....db /var/lib/hippocampus/memory.db
rm -f /var/lib/hippocampus/memory.db-wal /var/lib/hippocampus/memory.db-shm
systemctl start hippocampus
```

### 恢复演练

建议每月至少一次：导出 → 在临时目录 `--db` 启动服务 → 搜索/图谱验证 → 删除临时库。

## 6. 监控

- 存活：`GET /health`（不需要 token）。
- 就绪：`GET /ready`（DB 查询）。
- Prometheus：`GET /metrics`（默认 admin；`HIPPOCAMPUS_METRICS_PUBLIC=1` 可公开）。
- 运行时 JSON：`GET /api/monitor`（RSS、缓存、队列、嵌入覆盖、速率限制）。
- 审计：`GET /api/audit`（admin）。

关键告警建议：

| 指标 | 告警 |
| --- | --- |
| `hippocampus_http_requests_total{status=~"5.."}` | 5xx 比例 |
| `hippocampus_http_request_duration_seconds` | P95 延迟 |
| `hippocampus_disk` / `hippocampus_db_size_bytes` | 磁盘水位 |
| `hippocampus_jobs{status="failed"}` | 失败任务 |
| `hippocampus_conflicts_open` | 长期未解决冲突 |
| `hippocampus_embeddings_indexed` | 覆盖停滞 |

## 7. 性能调优

- 默认 `PRAGMA synchronous=FULL`，优先持久性；写入量大时可评估 `NORMAL`（掉电可能丢最后事务）。
- `cache_size=-20000`（约 20MB page cache）、`temp_store=MEMORY`。
- FTS5 预分词（CJK 二元组）；搜索候选上限 250，图谱 200，列表 200。
- 搜索/图谱缓存 15s，写操作按 `changeSeq` 失效。
- 高频写场景减少 worker 数量；只让一个进程写、其他进程读。
- 自动召回默认每轮用户输入执行一次本地词法检索（4 条、≤1200 字符），不调用外部 embedding；如果延迟敏感可调低 `autoRecallLimit` 或关闭 `autoRecall`。
- 嵌入检索是 SimHash 近似候选 + 精确余弦；超大数据集可调大候选上限/换 pgvector。

## 8. PostgreSQL 水平扩容

SQLite 仍是默认、零依赖的单机方案；需要多进程/多机器共享记忆时切到 PostgreSQL。迁移可以用 CLI 直接复制，或先 `export` 再 `import`：

```bash
# SQLite -> PostgreSQL（目标库会建 schema，skipExisting=true）
node bin/hippocampus.mjs migrate \
  --from-db /var/lib/hippocampus/memory.db \
  --to-pg-url 'postgres://hippo:secret@db.internal:5432/hippocampus'

# PostgreSQL -> SQLite
node bin/hippocampus.mjs migrate \
  --from-pg-url 'postgres://...' \
  --to-db /var/lib/hippocampus/memory.db
```

迁移复制记忆/冲突，不复制向量嵌入与审计/任务历史；切到新库后运行一次 `embed_backfill` 任务即可重建嵌入（没有配置嵌入时不需要）。


### 8.1 建库与扩展

```sql
CREATE DATABASE hippocampus;
\c hippocampus
CREATE EXTENSION IF NOT EXISTS vector;   -- 可选；没有权限时服务端回退 SimHash
```

最小权限也可以只授予 schema/表权限；服务第一次连接会自动创建：
`meta`、`memories`、`conflicts`、`events`、`api_keys`、`audit_log`、`jobs`、`embeddings`、`embedding_index`、`memory_fts`（tsvector）、`leases`。

### 8.2 启动共享实例

```bash
export HIPPOCAMPUS_STORAGE=postgres
export HIPPOCAMPUS_PG_URL='postgres://hippo:secret@db.internal:5432/hippocampus'
export HIPPOCAMPUS_PG_SCHEMA=public
export HIPPOCAMPUS_TOKEN='replace-with-long-random-token'

# 多个进程/机器，各自监听端口；不需要粘性会话
node bin/hippocampus-http.mjs --port 7337
node bin/hippocampus-http.mjs --port 7338
```

DSH 插件配置：

```yaml
- id: hippocampus-memory
  config:
    storage: postgres
    pgUrl: postgres://hippo:secret@db.internal:5432/hippocampus
    pgvector: true
    graphProvider: postgres
```

### 8.3 为什么可以水平扩容

| 机制 | 实现 |
| --- | --- |
| 共享元数据/记忆/审计/API key | PostgreSQL 表 |
| 任务队列 | `UPDATE ... FOR UPDATE SKIP LOCKED`，N 个 worker 不重复领取 |
| 回放/巩固 | `leases` 表原子租约，同一时刻只有一个进程执行 replay |
| 缓存失效 | `meta.change_seq` 由数据库统一递增，各实例缓存键跟随 |
| 向量检索 | pgvector `<=>` 精确余弦；扩展不可用时回退 SimHash + 余弦 |
| 全文检索 | `tsvector` + GIN，中文仍走预分词文本 |
| 图数据 | `graphProvider: projection`（应用内投影）或 `postgres`（PostgreSQL 存储上的图投影）；可通过 `registerGraphProvider()` 注册外部图数据库适配器 |

**单进程内的同步桥**：现有 `MemoryStore` 是同步 API，PostgreSQL 通过 worker 线程 + `pg` 连接池提供同步门面。一个进程内的查询会串行化；横向并发靠**多进程/多实例**，不是单进程多线程。对极高 QPS，建议把 HTTP 层多副本部署在负载均衡后。

### 8.4 备份

- PostgreSQL：使用 `pg_dump -Fc` 或云厂商快照；这是跨实例一致备份的推荐方式。
- 应用内 `/api/export` 仍是逻辑 JSON 导出；`POST /api/jobs {type:"backup"}` 在 PG 模式写 JSON 快照。
- SQLite：`VACUUM INTO` 或直接复制 `memory.db*`。

### 8.5 限制

- 每个实例的搜索/图缓存是进程内缓存；跨实例靠 15–30 秒 TTL + `change_seq` 键，不提供强一致读。
- 速率限制目前是单实例固定窗口；需要全局配额时在网关层做。
- `jobs` 的 `recovered` 过期租约扫描是周期性的；多 worker 下最坏延迟一个扫描周期。
- 一个实例内的同步 PG 门面会阻塞事件循环；这是为了兼容现有同步 Store。真正的高并发建议多副本，或后续替换成原生 async store。

## 9. 升级

```bash
systemctl stop hippocampus
cp -a /var/lib/hippocampus /var/lib/hippocampus.bak-$(date +%F)
# 替换代码目录
systemctl start hippocampus
curl -s http://127.0.0.1:7337/ready
```

Schema 迁移采用版本化迁移函数（当前 schemaVersion 4：新增 `namespaces` 表并从 `meta.namespace_registry` 回填）；基表仍用 `IF NOT EXISTS`。升级前仍建议备份；恢复接口和 `backup create` 可生成逻辑快照。若数据库 schema 比代码新，启动会拒绝并提示升级。

## 10. 故障排查

| 现象 | 排查 |
| --- | --- |
| 端口占用 | `ss -ltnp | grep 7337` / 改 `--port` |
| 502 | 后端没启动 / host 绑定错误 / token 代理丢失 |
| 401 | token 缺失/错误；反向代理是否转发 Authorization |
| 403 | 角色不足或 namespace 不在 key 白名单 |
| 429 | 触发限流；调 `HIPPOCAMPUS_RATE_LIMIT` |
| `database is locked` | 写并发过高；减少 worker/写进程，检查磁盘 |
| UI 空白 | 浏览器缓存旧资源；强制刷新；检查 CSP 控制台 |
| 嵌入不生效 | provider 配置/网络/key；查看 `/api/config`、任务错误 |
| 任务卡 running | 进程崩溃后 lease 过期会自动回收；重启 worker |
| 图谱节点少 | 服务端 200 上限与 `truncated`；调大 limit 或收窄 namespace |

## 11. 数据保留

- 记忆待删除：7 天冷静期。
- 审计：180 天（`maintenance` 清理）。
- 任务：30 天（`maintenance` 清理）。
- HTTP 服务默认每 24 小时自动调度一次 `maintenance`（审计/任务裁剪 + 回放）；可用 `HIPPOCAMPUS_MAINTENANCE_HOURS` 调整，`0` 关闭。
- 事件：365 天（回放清理）。
- 备份：不自动轮转；用外部 cron/对象存储保留策略。
