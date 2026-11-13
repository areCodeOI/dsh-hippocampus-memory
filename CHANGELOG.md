# Changelog

本项目遵循语义化版本；数据库 schema 变更会单独标注。

## 0.7.0 — 2026-11-14

### Added

- **记忆中枢（默认关闭，`memoryHub: true` 开启）**：纯本地、确定性、零外置 LLM 的决策层，
  自主决定「该记什么 / 怎么记 / 什么时候读」。核心在 `lib/memory-hub.js`，执行层在
  `lib/hub-runner.js`，接口契约见 `docs/HUB-API.md`，使用说明见 `docs/MEMORY-HUB.md`。
- **12 个上下文信号 + 读写双阈值**：`hubReadThreshold`（默认 0.34）控制何时检索，
  `hubWriteThreshold`（默认 0.55）控制是否写入；寒暄/命令/纯代码/PII/猜测/问句自动跳过。
- **自动分层**：候选按健康禁忌、稳定偏好、显式约定、项目事实、带结果事件分入
  `persona / semantic / episodic / buffer` 四层并自动分配 importance / confidence。
- **自主生效**：用户亲口说出且 `confidence≥0.85` 的 `persona` / `semantic` 事实由中枢
  自主批准（`review: 'approved'`）并可在下一轮被召回；较弱或机器来源候选仍进审阅队列。
  可用 `hubAutoApprove: false` 关闭该行为。
- **WebUI 实时开关（免重启、免改文件）**：设置页新增「记忆中枢」卡片，
  可开关中枢、自动写入、自主批准，并调读/写阈值、每轮上限、召回条数与空间；
  保存写入数据库 meta `memory_hub_settings`，下一轮对话立即生效。
  新增 `GET/PATCH /api/hub/settings`（admin）。
- **设置优先级**：数据库已保存值 > DSH 启动配置 > `HUB_DEFAULTS`。
  `lib/index.js` 的 pre-step 每轮读取实时设置，因此界面改动无需重启。
- **新配置项**：`memoryHub`、`hubReadThreshold`、`hubWriteThreshold`、`hubCapture`、
  `hubAutoApprove`、`hubCaptureMaxPerTurn`、`hubRecallLimit`、`hubRecallMaxChars`、
  `hubRecallMinScore`、`hubNamespace`；`cordis.patch.yml` 与 `docs/CONFIG.md` 同步。
  DSH 设置页可直接编辑这些字段（作为启动默认值）。
- 中枢开启时向系统提示词追加一段「记忆中枢」说明；工具清单保持不变（仍为 10 个）。
- `writeCandidates` 新增可选 `decorate(candidate)` 钩子并导出；默认行为完全不变。
- 新增 `test/memory-hub.test.mjs`（纯决策单测）与 `test/hub-runner.test.mjs`（读写集成测试），
  并注册进 `test/all.test.mjs`。

### Notes

- 中枢路径不读取 `autoCaptureLlm*` 配置，不发起任何 HTTP 请求；旧 LLM 抽取选项保留为兼容。
- 自动捕获候选继续进入审阅队列（`review: 'pending'`），批准前不参与自动召回。
- 数据库 schema 不变；中枢写入沿用既有 store 查重、冲突检测与跨进程 `leases` 锁。

## 0.6.1 — 2026-11-09

### Fixed

- 修复 npm 发布时 `bin` 路径带 `./` 被 npm 11 判定为非法并移除的问题；CLI 二进制将正确安装。
- 版本号 0.6.0 → 0.6.1；WebUI 资产重建。

## 0.6.0 — 2026-11-09

### Added

- **LLM 抽取（可选）**：`autoCaptureLlm:true` + OpenAI 兼容 endpoint/model 时，优先用 LLM 从用户消息抽取候选；超时/失败自动回退本地规则。API key 建议用 `HIPPOCAMPUS_LLM_API_KEY`。
- **助手结论 / 工具结果捕获**：`autoCaptureAssistant` / `autoCaptureToolResults`（默认开）可从 pre-step 消息中的助手结论和工具成功/失败行提取候选。
- **待审阅队列**：自动捕获写入 `review:'pending'`，不再参与自动召回；WebUI「捕获审阅」页可批准为语义/人格/情景，或忽略归档。
- **WebUI 配置**：设置页新增自动捕获开关、目标空间、每消息上限、助手/工具开关；写入 DB 覆盖插件默认值，无需重启。
- **更强 DLP**：新增手机号、邮箱、身份证/护照、银行卡、住址等 PII 跳过；敏感内容整条不捕获。
- **多实例去重**：捕获写入使用跨进程 `leases` 锁，同一消息并发时只有一个实例写入；store 去重继续兜底。
- API：`GET/PATCH /api/capture/settings`、`GET /api/captures`、`POST /api/captures/{id}/approve|reject`。

### Changed

- 自动捕获候选不再默认进入自动召回，必须人工批准；批准后按 semantic/persona/episodic 保存。
- `memory_stats.autoCapture` 增加 `pending` 计数；WebUI 总览显示自动捕获次数/条数。
- 版本号 0.5.1 → 0.6.0；WebUI 资产重建。

### Tests

- 单元/集成：115/115（新增 LLM 解析/HTTP mock、助手/工具来源、审阅队列、设置、HTTP 路由测试）。
- WebUI Vitest：2/2（新增捕获审阅页）；Playwright E2E：通过。

## 0.5.1 — 2026-11-09

### Fixed

- 自动捕获只处理真实用户消息：跳过 DSH 注入的 user-role 上下文（system-reminder 等），避免把框架内容写成记忆。
- 中文问句过滤增强：无问号但含“什么/怎么/为什么/如何/哪/谁/是否/能不能/多少”或句末“吗/呢”的内容不再捕获（除非含“记住/以后/不要”等明确指令）。
- `store.list` 新增标签过滤，多个标签按 **OR** 匹配；`GET /api/memories?tags=...` 与 WebUI 记忆库标签输入框同步，便于审阅 `auto-capture` 候选。
- 自动捕获统计增加标签过滤回归测试；文档补充自动捕获的使用边界。

### Changed

- 版本号 0.5.0 → 0.5.1；WebUI 资产重建。

## 0.5.0 — 2026-11-09

### Added

- **opt-in 自动捕获**：`autoCapture:true` 时在 DSH `agent/pre-step` 用本地确定性规则从最新用户消息抽取少量明确事实（“记住/以后/不要/我喜欢/项目使用/部署在”等），写入 `episodic`、`confirmed:false`，标签 `auto-capture`。
- 自动捕获不调用模型、不保存整段对话；每条消息最多 `autoCaptureMaxPerTurn` 条；跳过 slash 命令、代码块、问句和含密码/token/身份证等敏感词的整条消息。
- 可配置 `autoCaptureNamespace`、`autoCaptureMaxPerTurn`；自动捕获遵守 namespace 只读/归档策略，不自动写 `persona`。
- 统计与可观测性：`memory_stats` 增加 `autoCapture` 计数，WebUI 总览显示自动召回/自动捕获次数与条数；捕获记忆可按 `auto-capture` 标签审阅、提升或删除。

### Changed

- DSH 插件 pre-step 合并为单监听器，自动召回与自动捕获可独立开关；`autoRecall:false` 不影响自动捕获。
- 版本号 0.4.0 → 0.5.0；WebUI 资产重建。

### Tests

- 单元/集成：112/112。
- 新增 auto-capture 纯规则、去重、只读空间、敏感词和插件 opt-in 测试。

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
