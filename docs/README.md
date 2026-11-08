# 文档导航

> **适合谁**：所有人（找文档 / 看分类）
> **难度**：入门 · **预计阅读**：2 分钟

> 不知道从哪看？先回答一个问题：**你现在想做什么？**

**难度说明**：入门 = 照着做就行；进阶 = 需要命令行/开发经验；参考 = 查字段或实现细节，不必通读。

## 按“我是谁”选

| 你是 | 先看 |
| --- | --- |
| 完全没接触过，只想装上用 | [START-HERE.md](START-HERE.md) |
| 已装好，用 dsh-go 手机 App | [USE-DSH-GO.md](USE-DSH-GO.md) |
| 已装好，用浏览器管理记忆 | [USE-WEB.md](USE-WEB.md) |
| 不想记命令，让 AI 帮我装/维护 | [AI-AUTOMATION.md](AI-AUTOMATION.md) |
| 想在 Claude / Cursor 里用 | [START-HERE.md 第 5 节](START-HERE.md#5-接入-claude--cursor-等-mcp-客户端)、[MCP.md](MCP.md) |
| 自己写程序调用 | [API.md](API.md)、[EXAMPLES.md](EXAMPLES.md) |
| 负责部署/备份/安全 | [CONFIG.md](CONFIG.md)、[OPERATIONS.md](OPERATIONS.md)、[SECURITY.md](SECURITY.md) |
| 想改代码/看架构 | [ARCHITECTURE.md](ARCHITECTURE.md)、[FEATURES.md](FEATURES.md) |

## 按“我要做什么”选

| 任务 | 文档 |
| --- | --- |
| 第一次安装 | [START-HERE.md](START-HERE.md) |
| 手机上看/存/回忆记忆 | [USE-DSH-GO.md](USE-DSH-GO.md) |
| 网页搜索/编辑/处理冲突 | [USE-WEB.md](USE-WEB.md) |
| 备份、恢复、换设备 | [USE-WEB.md 第 8 节](USE-WEB.md#8-备份与恢复强烈建议)、[OPERATIONS.md](OPERATIONS.md) |
| 让 AI 自动安装/体检/排障 | [AI-AUTOMATION.md](AI-AUTOMATION.md) |
| 理解四层记忆、衰减、巩固 | [MEMORY-MODEL.md](MEMORY-MODEL.md) |
| 看 8 个工具参数和规则 | [TOOLS.md](TOOLS.md) |
| 调端口/路径/PostgreSQL/嵌入 | [CONFIG.md](CONFIG.md) |
| 接 MCP 客户端 | [MCP.md](MCP.md) |
| REST 接口字段 | [API.md](API.md) |
| 出问题按症状排查 | [FAQ.md](FAQ.md)、 [START-HERE.md 第 8 节](START-HERE.md#8-卡住了怎么办) |

## 文档分类

### 1. 新手区（先读这里）

- [START-HERE.md](START-HERE.md) — 从零安装、第一次使用、验收、卸载
- [USE-DSH-GO.md](USE-DSH-GO.md) — dsh-go 手机端日常操作
- [USE-WEB.md](USE-WEB.md) — Web 管理台操作
- [AI-AUTOMATION.md](AI-AUTOMATION.md) — 复制给 AI 的安装/体检/排障提示词

### 2. 使用与配置

- [FEATURES.md](FEATURES.md) — 功能与 v0.2 管理面
- [TOOLS.md](TOOLS.md) — 8 个 `memory_*` 工具与写入/冲突/召回规则
- [CONFIG.md](CONFIG.md) — 数据路径、配置项、权限、嵌入、部署扩容
- [MEMORY-MODEL.md](MEMORY-MODEL.md) — 四层模型、评分、回放、schema
- [UI.md](UI.md) — WebUI 页面与字段参考
- [FAQ.md](FAQ.md) — 常见问题

### 3. 接入与开发

- [API.md](API.md) — REST 路由、分页、图谱、任务、审计、key
- [MCP.md](MCP.md) — MCP stdio/HTTP 接入
- [EXAMPLES.md](EXAMPLES.md) — Python / Go / PHP 示例
- [ARCHITECTURE.md](ARCHITECTURE.md) — 代码结构、测试、Web 构建
- [REFERENCES.md](REFERENCES.md) — 参考项目与设计取舍

### 4. 运维与安全

- [OPERATIONS.md](OPERATIONS.md) — systemd、反向代理、备份、扩容、排障
- [SECURITY.md](SECURITY.md) — 信任边界、角色、API key、审计、加固清单
- [CONFIG.md](CONFIG.md) — 环境变量与数据位置

## 平台差异

- **dsh-go 手机 App**：有原生状态条/面板、长按存记忆、回忆胶囊，以及面板里的 **WebUI** 一键启动。
- **DSH 原版（Web / 桌面）**：Host 工具、自动召回、WebUI 服务都支持；没有手机原生面板，
  侧边栏「记忆」面板需要先启用 `httpEnabled`，或运行独立 HTTP 服务。详见 [USE-WEB.md](USE-WEB.md)。

## 术语速查

- **Host 插件 / 主插件**：跑在引擎里，给 AI 提供 `memory_*` 工具、自动召回、HTTP/WebUI。
- **dsh-go 原生界面**：手机 App 里的状态条/面板/长按菜单；与主插件同一个包、同一个库。
- **MCP**：让 Claude/Cursor 等外部客户端调用记忆工具的协议。
- **namespace**：记忆空间，用来隔离不同项目/agent。
- **冲突**：新旧信息矛盾时先挂起，等你确认；不会自动覆盖。
- **回放**：按衰减整理记忆、归档低价值项、合并重复情景。
