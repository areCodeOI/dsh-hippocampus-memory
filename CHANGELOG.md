# Changelog

本项目遵循语义化版本；数据库 schema 变更会单独标注。

## 0.4.0 — 2026-11-09

### Added

- **namespace v4 元数据与策略**：新增 `namespaces` 表（schemaVersion 4），支持描述、颜色、只读、归档、保留天数、按空间自动召回、embedding provider、软上限与自由 settings；旧库从 `meta.namespace_registry` 自动迁移。
- **逻辑备份/恢复**：`lib/backup.js` 提供 JSON 快照（记忆/冲突/空间元数据）、原子写入、权限 600、保留份数；WebUI「设置 → 备份」、CLI `backup list|create|restore|delete`、HTTP `/api/backups`。
- **危险操作自动备份**：namespace rename/merge/delete 默认在写事务内先快照，备份失败则中止；支持 `--no-backup` / `HIPPOCAMPUS_BACKUP_BEFORE_NAMESPACE=0`。
- **恢复保护**：默认 dry-run，执行前再备份当前状态；拒绝损坏/过新/非普通文件/符号链接备份；有 queued/running 任务时返回 409；恢复后清理 HTTP 缓存。
- **异步 namespace 操作**：`namespace_rename`、`namespace_merge`、`namespace_delete` job，支持进度、取消、事务回滚；HTTP `?async=1`。
- **只读 AI 工具**：新增 `memory_namespace`，AI 工具 8 → 9 个；新建/重命名/合并/删除仍只给管理员。
- **按空间自动召回**：`autoRecall:false` 或归档空间跳过注入；`autoRecallNamespace:"*"` 时逐条过滤。
- **CI**：Linux/Windows/macOS × Node 22/24、link 安装、smoke、真实 PostgreSQL、Vue/Vitest、Playwright E2E。

### Changed

- namespace 策略在存储层强制执行：只读/归档拒绝新写入；保留期由回放归档。
- namespace 删除会同步从 API key 白名单移除；重命名/合并继续迁移 key 与排队任务。
- HTTP 只读写入返回 403（此前被统一映射为 400）。
- WebUI 记忆空间增加设置弹窗；设置页增加备份卡片（仅带 `*` 白名单的 admin 可见）。

### Security

- 备份/恢复接口仅限 **admin 且 namespace 白名单包含 `*`**；受限 admin key 一律 403。
- 备份路径做 basename/目录边界校验，拒绝符号链接；备份名增加随机后缀避免覆盖。
- 危险操作快照移入写事务，并在事务内重新校验源/目标，避免“备份后写入”的竞态。
- 只读空间不再通过读取待删除记忆触发自动恢复。

### Tests

- 单元/集成：107/107。
- 运行时 smoke：104/104。
- link 安装：通过（tools=10）。
- WebUI Vitest：1/1；Playwright E2E：1/1。
- PostgreSQL 集成测试按环境变量启用；CI 使用真实 PostgreSQL service。

## 0.3.0 — 2026-11-08

- 单管理员账号 + 浏览器会话 + API key（reader/writer/admin）。
- namespace 列表/新建/重命名/合并/软硬删除；API key 空间白名单。
- 密码修改与管理员重置（吊销会话）；首次 setup 流程。
- 桌面端 link 安装、CORS 与 `@deepseek-ai/schemastery` fallback 修复。
- 数据库导入/导出、审计、异步任务、嵌入 provider、星图/树/监控。

## 0.2.x

- 自动召回 pre-step 注入、CLS 四层记忆、冲突检测与 7 天冷静期。
- WebUI 观测台、DSH 面板一键启动、MCP/HTTP/CLI 多入口。
- 多轮安全加固：DNS rebinding、跨站写、GET 副作用、数据库权限、缓存与超时。
