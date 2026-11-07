# HTTP / REST API

> **适合谁**：要写程序接 REST 的开发者
> **难度**：进阶 · **预计阅读**：15 分钟
> **前置**：会 HTTP/JSON；最好读过 TOOLS

由 `bin/hippocampus-http.mjs` 提供，默认 `http://127.0.0.1:7337`。

```bash
node bin/hippocampus-http.mjs --port 7337
# 跨机：
HIPPOCAMPUS_TOKEN=change-me node bin/hippocampus-http.mjs --host 0.0.0.0 --port 7337
```

- 请求/响应均为 `application/json; charset=utf-8`；大于 1KB 的响应在客户端支持时 gzip。
- 认证：`Authorization: Bearer <token>` 或 `X-Api-Key: <token>`。`HIPPOCAMPUS_TOKEN` 是 bootstrap admin；API key 有 `reader` / `writer` / `admin` 角色与 namespace 白名单。
- 只读端点只接受 `GET`（如 `/api/stats`、`/api/export`），错误方法返回 `405` 并带 `Allow` 头。
- 未配置 token 时，**回环请求**自动本地 admin；非回环仍需 key。`HIPPOCAMPUS_AUTH=required` 强制回环也认证。
- CORS 只反射回环 Origin（`127.0.0.1` / `localhost` / `::1`）与 `HIPOCAMPUS_CORS_ORIGINS` 允许列表；`OPTIONS` 预检返回 204。
- 机器可读的 OpenAPI：`GET /openapi.json`。
- 公共端点：`/health`、`/ready`、`/api/public-config`、静态 UI 资源；其余按角色保护。

---

## 路由总表

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查（不需要 token） |
| `GET` | `/ready` | 就绪检查（DB 可查询） |
| `GET` | `/` | WebUI（`index.html`） |
| `GET` | `/api/public-config` | 公开配置：版本、认证、嵌入、存储驱动、图 provider |
| `GET` | `/api/auth/check` | 校验当前 token，返回角色/namespace/服务配置 |
| `POST` | `/mcp` | MCP JSON-RPC（见 [MCP.md](MCP.md)） |
| `GET` | `/metrics` | Prometheus 指标（默认 admin；`?token=` 也可） |
| `GET` | `/api/tools` | 工具定义列表 |
| `POST` | `/api/tools/{name}` | 按名字调用工具，body 为参数对象 |
| `POST` | `/api/memories` | 写入记忆 |
| `GET` | `/api/memories` | 分页列表：`limit/offset/status/order/kinds` |
| `GET` | `/api/memories/search` | 召回（词法 + 可选向量） |
| `GET` | `/api/memories/{id}` | 读取一条（待删除会自动恢复） |
| `PATCH` / `PUT` | `/api/memories/{id}` | 更新一条 |
| `DELETE` | `/api/memories/{id}` | 软删除；`?hard=true&confirm=true` 硬删除 |
| `POST` | `/api/memories/{id}/archive` | 归档 |
| `POST` | `/api/memories/{id}/restore` | 从归档/待删除恢复 |
| `POST` | `/api/replay` | 同步回放（`{"dryRun":true}` 预览；`async:true` 入队） |
| `GET` | `/api/stats` | 统计；`?includeConflicts=true` 附带冲突列表 |
| `GET` | `/api/conflicts` | 冲突列表；按 key namespace 过滤 |
| `GET` | `/api/graph` | 星图投影：`namespace/limit/includeArchived/similarity` |
| `GET` | `/api/tree` | 记忆树投影 |
| `GET` / `POST` | `/api/jobs` | 任务列表 / 入队 |
| `GET` | `/api/jobs/{id}` | 任务详情 |
| `POST` | `/api/jobs/{id}/cancel` | 取消任务（admin） |
| `GET` | `/api/audit` | 审计日志（admin；`action/actor/limit/offset`） |
| `GET` / `POST` | `/api/keys` | 列出/创建 API key（admin） |
| `DELETE` | `/api/keys/{id}` | 吊销 key（admin） |
| `GET` | `/api/config` | 安全配置/缓存/队列/嵌入状态（admin） |
| `GET` | `/api/monitor` | 运行时监控 JSON（reader） |
| `GET` | `/api/export` | 导出 JSON 快照；按 key namespace 限制 |
| `POST` | `/api/import` | 导入 JSON 快照（admin） |
| `GET` | `/openapi.json` | OpenAPI 3.1 文档 |

---

## 认证与权限

| 角色 | 能力 |
| --- | --- |
| `reader` | 搜索、列表、读取、图谱、树、统计、监控、导出 |
| `writer` | reader + 写入/更新/归档/软删除/回放/任务 |
| `admin` | 全部，包括硬删除、导入、审计、API key、配置、备份/维护 |

创建 key：

```bash
curl -s -X POST http://127.0.0.1:7337/api/keys \
  -H 'content-type: application/json' \
  -d '{"name":"claude-desktop","role":"reader","namespaces":["default"]}'
```

响应中的 `key` 只出现一次。之后所有请求：

```http
Authorization: Bearer hk_...
```

`namespaces` 支持 `["*"]` 或具体列表；不在白名单的 namespace 返回 403。

## 分页列表

```bash
curl -s 'http://127.0.0.1:7337/api/memories?limit=25&offset=0&status=active&order=recent'
```

- `status`: `active|archived|conflict|pending_delete|all`
- `order`: `recent|created|updated|important`
- `kinds`: 逗号分隔
- 返回 `{items,total,limit,offset,namespace}`。

## 图谱与树

```bash
curl -s 'http://127.0.0.1:7337/api/graph?namespace=default&limit=200&similarity=true'
curl -s 'http://127.0.0.1:7337/api/tree?namespace=default&limit=500'
```

`/api/graph` 节点字段：`id/label/content/kind/status/importance/weight/tags/namespace/...`；边 `source/target/type/weight`，`type` 为 `consolidation|conflict|supersede|tag|similar`。超过上限时 `truncated:true`。

## 异步任务

```bash
# 入队
curl -s -X POST http://127.0.0.1:7337/api/jobs \
  -H 'content-type: application/json' \
  -d '{"type":"embed_backfill","payload":{"limit":1000}}'

# 列表 / 详情 / 取消（admin）
curl -s 'http://127.0.0.1:7337/api/jobs?status=running&limit=20'
curl -s http://127.0.0.1:7337/api/jobs/job_xxx
curl -s -X POST http://127.0.0.1:7337/api/jobs/job_xxx/cancel
```

任务类型：`replay`、`embed`、`embed_backfill`、`backup`、`maintenance`、`graph`、`tree`。`202` 返回 `job`。任务状态：`queued|running|succeeded|failed|cancelled`。

## 审计与监控

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7337/api/audit?limit=50&action=memory.add'

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7337/api/monitor
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7337/metrics
```

`/metrics` 是 Prometheus 文本格式；设置 `HIPPOCAMPUS_METRICS_PUBLIC=1` 可免认证（仅建议内网）。

---

## 写入

```bash
curl -s http://127.0.0.1:7337/api/memories \
  -H 'content-type: application/json' \
  -d '{
    "content": "用户对花生过敏，严重时需立即就医。",
    "kind": "persona",
    "importance": 10,
    "confidence": 0.95,
    "tags": ["健康", "过敏"],
    "confirmed": true
  }'
```

`201 Created`，返回：

```json
{
  "action": "created",
  "memory": {
    "id": "mem_mw5...",
    "kind": "persona",
    "kindLabel": "人格记忆",
    "content": "用户对花生过敏，严重时需立即就医。",
    "importance": 10,
    "confidence": 0.95,
    "weight": 10,
    "status": "active",
    "confirmed": true,
    "tags": ["健康", "过敏"],
    "namespace": "default"
  },
  "message": "已写入一条新记忆。"
}
```

`action` 可能为：

| action | 含义 |
| --- | --- |
| `created` | 新建 |
| `reinforced` | 重复，强化旧记忆 |
| `merged` | 严格补充，合并进旧记忆 |
| `conflict` | 与旧记忆冲突，新条目待确认 |
| `superseded` | 明确取代旧记忆（需 `confirmed`） |
| `duplicate` | `dedupe:"reject"` 命中重复，未写入 |

字段与 `memory_add` 工具一致：`content`（必填）、`kind`、`importance`、`confidence`、`tags`、`entities`、`summary`、`namespace`、`confirmed`、`supersedes`、`mergeInto`、`dedupe`、`metadata`。

---

## 召回

```bash
curl -s 'http://127.0.0.1:7337/api/memories/search?q=花生过敏&limit=3'
```

查询参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `q` / `query` | — | 查询词；`mode=recent/important` 时可空 |
| `limit` | 5 | 1–50 |
| `mode` | `relevance` | `relevance` / `recent` / `important` |
| `kinds` 或 `kind` | 全部 | 逗号分隔，如 `persona,semantic` |
| `tags` | — | 逗号分隔，任一匹配 |
| `minImportance` | 0 | 最低原始重要性 |
| `namespace` | `default` | `*` 表示全部空间 |
| `includeArchived` | false | 含归档/被取代 |
| `includePending` | false | 含冲突/待删除 |
| `explain` | true | 是否返回 `why` |

返回：

```json
{
  "query": "花生过敏",
  "mode": "relevance",
  "namespace": "default",
  "count": 1,
  "memories": [
    {
      "id": "mem_...",
      "kind": "persona",
      "content": "用户对花生过敏，严重时需立即就医。",
      "importance": 10,
      "weight": 9.99,
      "score": 0.976,
      "ageDays": 0,
      "why": "匹配「花生过敏」；重要性 10.0/10；人格记忆；刚刚访问过；置信度 95%"
    }
  ]
}
```

无匹配时：

```json
{"query":"量子火箭","mode":"relevance","namespace":"default","count":0,"memories":[],"message":"无匹配记忆（不编造记忆）。"}
```

---

## 读取 / 更新

```bash
curl -s http://127.0.0.1:7337/api/memories/mem_xxx
```

```bash
curl -s -X PATCH http://127.0.0.1:7337/api/memories/mem_xxx \
  -H 'content-type: application/json' \
  -d '{"importance": 9, "tags": ["健康","过敏","紧急"]}'
```

解决冲突：

```bash
curl -s -X PATCH http://127.0.0.1:7337/api/memories/<新条目id> \
  -H 'content-type: application/json' \
  -d '{"status":"active","confirmed":true,"supersede":"<旧条目id>"}'
```

`PATCH` 可改：`content`、`kind`、`importance`、`confidence`、`tags`、`entities`、`summary`、`confirmed`、`status`、`supersede`、`metadata`。
把 `kind` 提升为 `semantic`/`persona` 时必须 `confirmed: true`。

---

## 删除 / 归档 / 恢复

```bash
# 软删除：7 天冷静期，期间 GET 会自动恢复
curl -s -X DELETE http://127.0.0.1:7337/api/memories/mem_xxx

# 立即永久删除（人格记忆还需要 force=true）
curl -s -X DELETE 'http://127.0.0.1:7337/api/memories/mem_xxx?hard=true&confirm=true'

# 归档 / 恢复
curl -s -X POST http://127.0.0.1:7337/api/memories/mem_xxx/archive
curl -s -X POST http://127.0.0.1:7337/api/memories/mem_xxx/restore
```

---

## 回放 / 统计 / 冲突

```bash
curl -s -X POST http://127.0.0.1:7337/api/replay \
  -H 'content-type: application/json' \
  -d '{"dryRun":true}'

curl -s 'http://127.0.0.1:7337/api/stats?includeConflicts=true'
curl -s http://127.0.0.1:7337/api/conflicts
```

`/api/stats` 返回总量、分层/状态分布、namespace 分布、标签排行、数据库路径/大小、上次回放时间、未解决冲突数。

---

## 按工具名调用

```bash
curl -s http://127.0.0.1:7337/api/tools/memory_search \
  -H 'content-type: application/json' \
  -d '{"query":"花生过敏","limit":3}'
```

等价于 MCP 的 `tools/call`，只是传输层不同。工具列表：`GET /api/tools`。

---

## 错误格式

```json
{
  "error": {
    "code": 400,
    "message": "content is required"
  }
}
```

| HTTP 状态 | 场景 |
| --- | --- |
| 400 | 参数错误、非法 JSON、非法状态迁移 |
| 401 | 缺少/错误 token |
| 404 | 记忆或路由不存在 |
| 405 | 方法不允许（如 GET /mcp） |
| 500 | 内部错误 |

---

## 跨语言注意

- 所有时间戳是 **Unix 毫秒**。
- 所有字段名是 camelCase。
- `content` 必须是字符串；数组/对象会报错。
- 返回体含中文，注意按 UTF-8 解码。
- 并发写：WAL + busy timeout；批量导入建议用 CLI `import` 或单进程串行。
