# MCP 接入说明

> **适合谁**：要接 Claude/Cursor/Cline 等 MCP 客户端的人
> **难度**：入门～进阶 · **预计阅读**：10 分钟
> **前置**：Node.js ≥ 22.13；会改 JSON 配置

海马体记忆对外提供两条 MCP 通道：

1. **stdio**：`bin/hippocampus-mcp.mjs`，适合 Claude Desktop / Code、Cursor、Cline、自研客户端。
2. **Streamable HTTP（JSON response 模式）**：`POST /mcp`，由 `bin/hippocampus-http.mjs` 提供，适合远程/容器/多语言。

两者共用 `lib/mcp.js` 的方法分发和同一个 SQLite 库。HTTP 模式复用 REST 的 API key / 角色 / namespace 权限：`tools/call` 会先经过授权，reader 不能调用写工具；`memory://` 资源只对 wildcard namespace 的 reader/admin 开放。stdio 模式的信任边界由启动它的客户端决定。

---

## 1. stdio 传输

### 启动

```bash
node bin/hippocampus-mcp.mjs [--db /path/memory.db] [--namespace default]
```

- **stdin**：一行一个 JSON-RPC 2.0 消息（消息内不能有换行）。
- **stdout**：一行一个 JSON-RPC 响应；通知没有响应。
- **stderr**：诊断日志。
- 客户端关闭 stdin 后进程退出；stdout EPIPE 不会让服务崩溃。
- 服务是**无状态**的：不要求先收到 `notifications/initialized` 才能调用工具。

### 客户端配置

```json
{
  "mcpServers": {
    "hippocampus": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-hippocampus-memory/bin/hippocampus-mcp.mjs"],
      "env": {
        "HIPPOCAMPUS_DB": "/absolute/path/to/memory.db",
        "HIPPOCAMPUS_NAMESPACE": "default"
      }
    }
  }
}
```

- Termux / Android：`command` 建议写 Node 的绝对路径（GUI 环境不一定继承 Termux PATH）。
- Windows：`command` 用 `node.exe` 绝对路径，`args` 用反斜杠或正斜杠均可。
- 不设置 `HIPPOCAMPUS_DB` 时，依次回退到 `$DSH_HOME/hippocampus/memory.db`、`~/.dsh/hippocampus/memory.db`。

---

## 2. HTTP 传输

```bash
node bin/hippocampus-http.mjs --port 7337
```

```http
POST /mcp HTTP/1.1
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

- 只支持 JSON 响应模式；`GET /mcp` 返回 405（不提供 SSE 长连接）。
- 请求可以是单条消息，也可以是 JSON-RPC batch 数组。
- 通知（无 `id`）返回 `202 Accepted`，无响应体。
- 设置 `HIPPOCAMPUS_TOKEN` 后需要 `Authorization: Bearer <token>` 或 `X-Api-Key: <token>`；API key 的角色/namespace 同样生效。
- 无状态，不校验 `Mcp-Session-Id`；每次请求独立处理。
- 自定义监听：`node bin/hippocampus-http.mjs --host 0.0.0.0 --port 18080`，则 MCP 端点为 `http://<host>:18080/mcp`。
- 配置 `HIPPOCAMPUS_EMBEDDING_*` / `HIPPOCAMPUS_EMBEDDINGS` 后，stdio 与 HTTP MCP 的 `memory_search` 也会做混合检索；stdio 在新记忆写入/更新后同步索引，HTTP 模式同样。未配置时保持词法+权重，行为完全离线。

---

## 3. 支持的协议版本

| 请求的 `protocolVersion` | 返回 |
| --- | --- |
| `2025-06-18` | 原样返回 |
| `2025-03-26` | 原样返回 |
| `2024-11-05` | 原样返回 |
| 其他/缺省 | `2025-06-18` |

---

## 4. 方法

| 方法 | 说明 |
| --- | --- |
| `initialize` | 返回协议版本、`tools/resources/prompts` 能力、`serverInfo`、中英文记忆协议 `instructions` |
| `notifications/initialized` | 通知，无响应 |
| `ping` | 返回 `{}` |
| `tools/list` | 9 个工具的 `name/description/inputSchema` |
| `tools/call` | 调用工具；结果同时给 `content[].text`（JSON 字符串）和 `structuredContent`；只读 `memory_namespace` 可查空间列表 |
| `resources/list` | `memory://stats`、`memory://recent`、`memory://conflicts` |
| `resources/read` | 读取上述资源，`text` 为 JSON |
| `prompts/list` | `hippocampus_memory_protocol` |
| `prompts/get` | 返回记忆使用规范（可直接注入模型） |
| `logging/setLevel` | 接受并忽略 |
| `notifications/cancelled` | 接受并忽略 |

> `tools/call` 的 `memory_stats` 会按 key 的 namespace 白名单过滤（`byNamespace` 与
> `openConflicts` 不会泄露其他空间）。namespace 管理（列表/新建/重命名/合并/删除）
> 不在 MCP 工具里，请用 WebUI「记忆空间」、`hippocampus namespace` CLI 或
> `/api/namespaces`。

工具调用失败时**不抛协议错误**，而是返回：

```json
{
  "content": [{"type": "text", "text": "Error: content is required"}],
  "isError": true
}
```

未知工具、参数错误、SQLite 错误都走这条路径；未知方法/非法 JSON 才是 JSON-RPC 错误。

### 错误码

| code | 场景 |
| --- | --- |
| `-32700` | 非法 JSON |
| `-32600` | 不是合法 JSON-RPC 2.0 请求 |
| `-32601` | 未知方法 |
| `-32602` | 参数缺失（如 `tools/call` 没有 name、resources 未知 URI） |
| `-32603` | 内部错误 |

---

## 5. 一次完整会话（stdio）

请求：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_add","arguments":{"content":"项目 Kestrel 的生产服务器是 10.0.0.7。","kind":"semantic","importance":8,"confirmed":true}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"Kestrel 服务器"}}}
```

响应（每条一行，已格式化便于阅读）：

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false},"resources":{"listChanged":false,"subscribe":false},"prompts":{"listChanged":false}},"serverInfo":{"name":"hippocampus-memory","title":"Hippocampus Memory","version":"0.7.0"},"instructions":"## 海马体长期记忆…"}}

{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{…}"}],"structuredContent":{"action":"created","memory":{"id":"mem_…","kind":"semantic","content":"项目 Kestrel 的生产服务器是 10.0.0.7。","importance":8,"status":"active","weight":8.0,…},"message":"已写入一条新记忆。"},"isError":false}}

{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{…}"}],"structuredContent":{"query":"Kestrel 服务器","count":1,"memories":[{"content":"项目 Kestrel 的生产服务器是 10.0.0.7。","score":0.97,"why":"匹配「Kestrel、服务器」；重要性 8.0/10；语义固化；刚刚访问过"}]},"isError":false}}
```

---

## 6. 每个客户端的模型能看到什么

1. `initialize.instructions`：一段中英文记忆协议（什么时候查、什么时候写、冲突怎么处理）。
2. 9 个工具的 `description`：每个工具都写清了适用场景、参数语义和禁止行为。
3. 可选：客户端把 `prompts/get hippocampus_memory_protocol` 作为系统消息注入，进一步强化规范。

记忆内容返回的是 JSON，不会自动变成系统指令；客户端应把它当**数据**。

---

## 7. 多客户端 / 多进程

- 同一个数据库可以同时被 DSH 插件、多个 MCP 客户端、HTTP 服务使用。
- SQLite 使用 WAL + `busy_timeout=15000`，读不阻塞写。
- 如果需要严格隔离，给不同项目/agent 设置不同 `namespace` 或不同 `--db`。
- 定时回放建议只在一个长期运行的进程里开启（DSH 插件默认开启）；多个 MCP 客户端不需要各自回放。

---

## 8. 故障排查

| 现象 | 处理 |
| --- | --- |
| 客户端报 `ENOENT` | `command` 写 Node 绝对路径；确认脚本路径存在 |
| `bad ELF magic` | 误把 `process.execPath`（Android 上是 linker）当 node 用；本项目的 `lib/exec.js` 已处理，客户端请直接写 node 路径 |
| 工具返回 `Error: content is required` | 参数为空；`memory_add` 必须有 `content` |
| 工具返回 `no such table` | 数据库文件损坏或不是本项目的库；换 `HIPPOCAMPUS_DB` |
| `database is locked` | 极高并发写入；减少写进程或调大 busy timeout |
| 中文搜不到 | 确认写入的是 `content` 而不是只写 `summary`；尝试更短的关键词 |
| HTTP 401 | 设置了 `HIPPOCAMPUS_TOKEN`，请求头缺少 Bearer |

---

## 9. 安全

- stdio 模式的信任边界由客户端决定；任何能启动该进程的本地程序都能读写数据库。
- HTTP 模式默认只监听 `127.0.0.1`；跨机访问必须设置 token，最好放在反向代理/TLS 后面。
- MCP 响应可能包含用户隐私；客户端不应把记忆内容转发给不可信第三方。
