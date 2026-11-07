# WebUI 使用说明

启动服务后打开 `http://127.0.0.1:7337/`（或你配置的 host/port）：

```bash
node bin/hippocampus-http.mjs --host 127.0.0.1 --port 7337
```

独立 WebUI 是 **Vue 3 + Element Plus + Vite** 的 SPA，构建产物在 `web/`，运行时不需要构建工具链，也不加载 CDN。源码在 `webapp/`。

## DSH 侧边栏入口

安装/重启 DSH 后，左侧全局面板图标里、**「插件」旁边**会出现「记忆」：

- 点击打开 DSH 风格的主面板：总览、记忆库（搜索/详情/编辑/删除）、任务、设置。
- DSH「设置」页新增「记忆」分区，可直接跳到管理面板。
- 面板通过独立 HTTP 服务（默认 `http://<当前 host>:7337`）读写同一个记忆库；在面板「设置」里可以改 API 地址和 token。
- 若独立服务未启动，面板会显示连接错误；运行 `node bin/hippocampus-http.mjs --port 7337`，或在 DSH 插件配置里设 `httpEnabled: true` 后重启。
- 面板右上角「打开完整管理台」会在新标签打开本 Vue WebUI，星图/树、审计、API key、导入导出都在那里。
- DSH 客户端插件源码是包根的 `client.js`；它使用 DSH 的 theme token，不引入第二套全局样式。

## 页面

| 页面 | 作用 |
| --- | --- |
| 总览 | 记忆总量、待处理冲突、数据库大小、缓存命中率、分层分布、最近记忆、审计尾迹、运行时状态 |
| 记忆库 | 关键词召回 / 分页列表、层/状态过滤、详情抽屉、写入/编辑/归档/恢复/删除 |
| 记忆星图 | Canvas 力导向图，节点=记忆，边=巩固/冲突/标签/相似；拖拽、缩放、点击查看 |
| 记忆树 | `namespace → 记忆层 → 记忆` 的折叠树，支持内容过滤 |
| 异步任务 | 回放、嵌入回填、备份、维护任务；进度、重试、取消、结果 JSON |
| 审计日志 | 时间、actor、role、action、request、状态、IP、detail；按 action/actor 过滤 |
| 设置与权限 | 服务信息、监听地址、DB 路径、嵌入 provider、缓存/队列/限流、API key 管理、导入导出 |

## 登录与 token

- 没有 `HIPPOCAMPUS_TOKEN` 且没有 API key 时，**回环访问**自动以本地 admin 进入。
- 设置 `HIPPOCAMPUS_TOKEN` 或 `HIPPOCAMPUS_AUTH=required` 后，进入 UI 需要输入 token / API key。
- token 只保存在当前标签页的 `sessionStorage`，关闭标签页即清除；不写入 cookie。
- 右上角显示当前角色与 actor；「退出」清除 token。
- 创建 API key 后，完整 key 只显示一次；服务端只存 SHA-256 hash。

## 记忆库

- 搜索框走 `/api/memories/search`；空搜索走分页列表 `/api/memories`。
- 状态过滤：有效 / 已归档 / 待确认 / 全部状态。
- 层过滤：人格 / 语义 / 情景 / 缓冲。
- 点击行打开右侧详情：内容、层、状态、重要性/权重、置信度、访问次数、namespace、来源会话、标签、metadata、冲突、ID。
- 写入/编辑弹窗支持设置层、重要性、置信度、标签、confirmed、namespace。
- 删除：默认进入 7 天冷静期；admin 可永久删除；人格记忆自动带 `force`。
- 所有写操作都会刷新页面并记录审计。

## 记忆星图

星图把记忆当作星体：

- **颜色**：人格=金、语义=青、情景=蓝紫、缓冲=灰。
- **大小**：由重要性决定；人格/语义节点带光晕。
- **描边**：冲突节点红色；选中节点白色。
- **边**：
  - 青色：巩固链（episodic → semantic）
  - 红色虚线：冲突
  - 灰色：共享标签
  - 紫色淡化：词法相似度 ≥ 0.45
- **交互**：拖拽节点、拖拽空白平移、滚轮缩放、点击节点打开详情、重置视图。
- **上限**：默认 200 节点，可切到 100/300/500；超过上限时服务端返回 `truncated: true`，按重要性优先。
- **数据来源**：`GET /api/graph?namespace=&limit=&includeArchived=&similarity=`。

星图是**投影**而不是全库：它只展示当前 namespace 与上限内最重要的记忆，避免浏览器被十万条边拖死。大库排查请用记忆库分页 + 图谱过滤。

## 记忆树

- 按 `namespace → 记忆层 → 记忆` 展开。
- 默认只显示有效记忆，可在设置/接口加 `includeArchived`。
- 顶部输入框按内容/标签即时过滤叶子节点。
- 点击叶子打开同一套详情抽屉。

## 异步任务

- 「运行回放」入队 `replay`；「嵌入回填」入队 `embed_backfill`；「创建备份」入队 `backup`；「维护」入队 `maintenance`。
- 任务状态：queued / running / succeeded / failed / cancelled。
- 进度条来自 `jobs.progress`；长任务每 30 秒续租，进程重启后过期 lease 会被回收。
- 详情展开可看 payload / result / error；admin 可取消 queued 或 running 任务。
- 列表每 3 秒自动刷新，离开页面后停止轮询。

## 设置与权限

- 服务卡：版本、DB 路径、存储驱动（SQLite / PostgreSQL+pgvector）、图 provider、监听地址、认证模式、嵌入状态、worker、缓存。
- 数据卡：导出 JSON（reader）、导入 JSON（admin）、备份数据库（admin，后台 `VACUUM INTO`）。
- API key 卡：新建/吊销；角色 reader/writer/admin；namespace 逗号分隔或 `*`。
- 嵌入 provider 列表来自 `/api/config`；回填按钮在「异步任务」页。

## 键盘与移动端

- `Esc` 关闭详情抽屉/弹窗。
- 移动端侧栏折叠为汉堡菜单；展开后可点侧栏右上角 ×、点遮罩、按 Esc 或选择任意菜单项关闭。
- 主题切换保存在 localStorage（`hippocampus.theme`）。
- 尊重 `prefers-reduced-motion`。

## 可访问性

- 导航与表格行支持键盘焦点；抽屉/弹窗使用 `role="dialog"` 与 `aria-modal`。
- 颜色不是唯一信息：记忆层、状态都有文字标签。
- CSP 禁止外联脚本/样式，UI 不加载第三方资源。

## 二次开发与构建

- `webapp/src/`：Vue SFC 源码（`App.vue`、`views/*`、`components/StarMap.vue`、`styles.css`）。
- `web/`：Vite 构建产物；`index.html` + `assets/*.js` + `assets/*.css`，由 `bin/hippocampus-http.mjs` 静态服务。
- 前端只调用 `/api/*`，不直接读 SQLite；可以替换 UI 框架而不动后端。
- CSP 允许 `style-src 'unsafe-inline'`（动态样式），脚本只允许 `script-src 'self'`；没有 `unsafe-eval`。
- 构建：

```bash
cd webapp
npm install
node node_modules/vite/bin/vite.js build --outDir ../web --emptyOutDir
```

> Android/Termux：不要把 `node_modules` 放在 `/storage`，Rollup native 模块会被 linker namespace 拒绝；在应用私有目录（如 `$TMPDIR/webapp-build`）安装并构建，再把产物同步到 `web/`。

- 如果要把 UI 放到别的路径，设置 `HIPPOCAMPUS_WEB_ROOT` 或 `--web-root`。
