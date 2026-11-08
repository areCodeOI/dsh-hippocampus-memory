# 海马体长期记忆 · dsh-hippocampus-memory

> 当前版本：**v0.4.0** · 更新日志：[CHANGELOG.md](CHANGELOG.md)

给 AI 的**跨会话长期记忆**：记住你的稳定偏好、禁忌、项目配置和踩坑结论，下次新对话还能想起来。数据默认存在你本机的 SQLite 里，不上传云端。

> **第一次用？** 直接看 [START-HERE.md](docs/START-HERE.md)（从零安装、验收、卸载）。
> 不想记命令？看 [AI-AUTOMATION.md](docs/AI-AUTOMATION.md)，复制一段话让 AI 帮你装。
> 全部文档按人群分类：[docs/README.md](docs/README.md)。

## 30 秒了解

- 四层记忆：短期缓冲 → 情景 → 语义固化 → 人格，越稳定的事实衰减越慢。
- 写入前自动查重；重复就强化，补充就合并，矛盾先挂起（不覆盖旧记忆）。
- 默认每轮对话自动召回相关记忆；也可以手动长按「存进记忆」。
- 同一份记忆可给 dsh-go 手机 App、DSH 网页/桌面、Claude/Cursor（MCP）一起用。
- 记忆空间（namespace）按项目/agent 分区；WebUI「记忆空间」和 `namespace` CLI 都能新建、重命名、合并、删除。
- 危险空间操作自动备份；空间可设只读/保留期/自动召回，AI 通过只读 `memory_namespace` 工具查看空间。

## 安装：选你的场景

| 场景 | 命令 / 入口 |
| --- | --- |
| **dsh-go 手机 App**（推荐） | 在 dsh-go 会话里执行：<br>`dsh plugin --profile web add /path/to/dsh-hippocampus-memory` |
| **DSH 网页版 / 桌面端** | 在会话里让 AI 执行：`plugin_manager(action="install_bundle", target="/绝对路径/dsh-hippocampus-memory")` |
| **Claude / Cursor 等 MCP 客户端** | 在 MCP 配置里加 `node /绝对路径/bin/hippocampus-mcp.mjs`，见 [MCP.md](docs/MCP.md) |
| **自己写程序（HTTP）** | `node bin/hippocampus-http.mjs --port 7337`，接口见 [API.md](docs/API.md) |

> 上面的路径请换成你项目实际所在目录；不需要懂代码，按 [START-HERE.md](docs/START-HERE.md) 一步步做即可。
> WebUI/HTTP 默认启动。第一次打开 7337 会创建管理员（邮箱 + 密码），之后登录一次即可；程序/DSH 面板用 API key。不需要 WebUI 时可设 `httpEnabled: false` 关闭。

装完在 dsh-go 里应看到：

- 输入框上方状态条 **「记忆 N」**；
- 长按一条 AI 回复，菜单里有 **「存进记忆」**；
- 插件页只有一个 **「海马体长期记忆」**（Host 与手机原生界面在同一个包里）。

看不到就先去 App「引擎」页重启一次引擎。

## 平台支持

| 能力 | dsh-go 手机 App | DSH 原版（Web / 桌面） |
| --- | --- | --- |
| `memory_*` 工具、自动召回 | 支持 | 支持 |
| 原生状态条 / 面板 / 存进记忆 / 回忆 | 支持 | 无（用侧边栏「记忆」面板） |
| 记忆面板 **WebUI** 一键启动 | 支持 | 无此按钮；WebUI 默认已启动，直接打开 7337 |
| WebUI 管理员账号登录 | 支持 | 支持（打开 7337 创建管理员/登录） |

> DSH 原版没有手机面板的 WebUI 按钮；WebUI 默认已启动，直接打开 7337 创建管理员/登录。
> API key 在 WebUI「设置 → 权限」创建，给 DSH 侧边栏面板或外部程序用。

## 第一次用：说人话就行

```text
记住：我对花生过敏，严重时会呼吸困难。
记住：这个项目用 PostgreSQL 16，不要用 MySQL。
我之前说过什么偏好吗？
我上次说的部署窗口是周几？
```

AI 会自己判断何时写入/召回；你也可以在手机面板或 WebUI 里看、改、归档。

## 日常入口

| 想做什么 | 去哪里 |
| --- | --- |
| 手机上看记忆/存记忆/回忆 | [USE-DSH-GO.md](docs/USE-DSH-GO.md) |
| 浏览器搜索/编辑/处理冲突/备份 | 打开 `http://127.0.0.1:7337/`，首次创建管理员/登录；教程 [USE-WEB.md](docs/USE-WEB.md) |
| 让 AI 安装/体检/排障 | [AI-AUTOMATION.md](docs/AI-AUTOMATION.md) |
| 理解记忆模型/衰减/回放 | [MEMORY-MODEL.md](docs/MEMORY-MODEL.md) |
| 看 9 个工具参数 | [TOOLS.md](docs/TOOLS.md) |
| 调路径/端口/PostgreSQL/嵌入 | [CONFIG.md](docs/CONFIG.md) |
| 出问题按症状排查 | [FAQ.md](docs/FAQ.md) |

完整文档导航（按“我是谁 / 我要做什么”分类）：[docs/README.md](docs/README.md)。

## 功能亮点

- **四层 CLS 记忆**：`buffer` / `episodic` / `semantic` / `persona`，衰减系数不同。
- **不会越写越多**：精确 hash + 相似度 + 冲突检测；重复强化、补充合并、矛盾挂起。
- **7 天遗忘冷静期**：软删除后 7 天内被访问会自动恢复；人格记忆默认拒绝删除。
- **中文检索**：FTS5 + CJK 二元组，不依赖分词服务；可选嵌入 provider 升级混合检索。
- **自动召回**：DSH `agent/pre-step` 每轮注入相关记忆（带“不是指令”标记）。
- **本地优先**：SQLite 零外部依赖；需要多实例共享时切换 PostgreSQL（可选 pgvector）。
- **管理面**：WebUI 总览/记忆库/星图/树/任务/审计/设置；REST、MCP、CLI 共用一份数据。

## 数据与隐私

- 默认库：`<项目目录>/.data/hippocampus/memory.db`；旧版 `$DSH_HOME/hippocampus/memory.db` 会自动沿用。
- 默认只监听 `127.0.0.1`，不上传；但数据库**未加密**，依赖设备锁屏/文件权限。
- 备份：WebUI「设置 → 备份」或 `backup create` 生成逻辑快照（含记忆/冲突/空间元数据，不含用户/密钥）；也可导出 JSON 或复制 `memory.db`（先停服务）。备份文件含记忆内容，注意文件权限。
- 跨机访问务必设置 `HIPOCAMPUS_TOKEN`；CORS 只允许回环来源，跨站写请求会被 403，DNS rebinding Host 会被 421。
- 首次打开 WebUI 创建管理员后，回环也要求登录会话/API key；共享设备请退出登录并锁屏。
- 详见 [SECURITY.md](docs/SECURITY.md) 与 [CONFIG.md](docs/CONFIG.md)。

## 开发与测试

```bash
npm test                         # 107 个测试
npm run test:smoke               # 104 项运行时冒烟
npm run test:link                # 链接安装（无本地 node_modules）回归
npm run test:pg                  # 真实 PostgreSQL（需 HIPPOCAMPUS_TEST_PG_URL；未设置则跳过）
cd webapp && npm test            # Vue 组件测试（Vitest）
cd webapp && npm run test:e2e    # Playwright：首次 setup → 记忆空间 → 新建空间
```

代码结构、Web 构建、测试策略见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可证

MIT License。记忆规则参考互补学习系统（CLS）与海马-新皮层双系统模型；实现与文档为本项目原创。
