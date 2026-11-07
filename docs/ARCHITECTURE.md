# 架构与开发

> **适合谁**：要改代码、做二次开发的人
> **难度**：参考 · **预计阅读**：8 分钟
> **前置**：熟悉 Node.js/模块结构

一句话：给要改代码/做二次开发的人看的目录与测试说明。

代码结构、测试与 Web 构建。

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

## 测试

```bash
npm test
# 等价于：
node --test --test-isolation=none test/*.test.mjs

# 可选：起真实 HTTP 服务跑多维度运行时冒烟（REST/MCP/鉴权/CORS/性能/崩溃回归）
node test/smoke-runtime.mjs
```

当前 71 个测试覆盖：

- store：写入/召回/中文标点、精确与近似查重、严格补充合并、数值冲突与确认解决、无匹配、衰减归档、待删除 7 天冷静期与永久清理、读取恢复、回放巩固幂等、namespace 隔离、导出导入、人格记忆删除保护、重要性推断、归档/待删除记忆重新写入时恢复、固化记忆被取代需显式确认、冲突事实在重复阈值以下也能被识别
- MCP：initialize、tools/list、tools/call、resources、prompts、错误码、非法 JSON、重启后持久化
- HTTP：health、REST CRUD、搜索、统计、回放、MCP-over-HTTP、Bearer token、错误响应
- v2 HTTP：WebUI 静态资源、星图/树、monitor/metrics、缓存命中、API key 角色、namespace 限制、审计、任务、导出、token 保护
- auth：bootstrap、本地回环、key hash、角色、namespace、吊销、required 模式
- jobs：领取/完成、失败重试、取消、lease 恢复、列表/统计/清理
- embeddings：FP32/余弦/SimHash、OpenAI+Ollama 多 provider、混合召回、回填、查询缓存、禁用 no-op
- plugin：8 个工具注册、DSH 会话来源、提示词注入开关、插件卸载时关闭数据库、自动召回 pre-step 注入（长消息截断、不回写访问统计）、promptLanguage auto 语言协商
- auto-recall：用户消息提取、斜杠命令跳过、上下文截断、来源标记、pre-step 注入
- storage：SQLite 路径/目录、PostgreSQL 配置脱敏、SQL 占位符与 `INSERT OR IGNORE` 翻译、change_seq 持久化、跨进程租约、图 provider
- 回归：GET /mcp 不再打死进程、只读端点 405、CORS 仅回环源、Prometheus TYPE 完整、否定事实冲突、任务重试退避、向量权重 `0` 可关闭混合检索
- dsh-go：`dshGo` 清单里的每个入口都有对应注册；存进记忆/回忆/面板共用同一个 store

> Android/Termux 上 `node --test` 默认的进程隔离会因为 `process.execPath` 指向 linker 而失败，所以脚本固定使用 `--test-isolation=none`；MCP 测试内部用 `process.argv0` 启动子进程。

## WebUI 开发与构建

独立 WebUI 是 **Vue 3 + Element Plus + Vite** 的 SPA，源码在 `webapp/`，构建产物在 `web/`（运行时不需要 Node 构建工具链）。

```bash
cd webapp
npm install
node node_modules/vite/bin/vite.js build --outDir ../web --emptyOutDir
```

Android/Termux 上如果 `node_modules` 位于 `/storage` 会因 linker namespace 无法加载 Rollup native 模块：请在应用私有目录（如 `$TMPDIR/webapp-build`）安装依赖并构建，再把 `web/` 同步回包目录。构建脚本与说明见 `webapp/` 和 [UI.md](UI.md)。

不希望用 Vue 也可以只替换 `web/` 下的静态文件；后端只依赖 `/api/*`，不依赖前端框架。
