# dsh-go 原生界面插件

`plugin/` 是 dsh-go 手机 App 的原生插件，和仓库根目录的 DSH Host 插件是两个包：

- 根目录：八个 `memory_*` 工具、`agent/pre-step` 自动召回、HTTP/WebUI、MCP。
- `dsh-go/plugin`：输入框上方状态条「记忆 N」、海马体记忆面板、长按消息「存进记忆」、
  「回忆」胶囊、对话信息页「回放记忆」。

原生插件在引擎进程内直接打开同一个 SQLite（不经过 7337），所以即使 HTTP 服务没起也能用。

## 安装

```bash
dsh plugin --profile web add "$PWD"
dsh plugin --profile web add "$PWD/dsh-go/plugin"
```

安装是 link，目录不要删除或移动。

## 自检

```bash
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" dsh-go/plugin --load
```

## 数据路径

两个包都使用 `lib/paths.js` 的 `resolveStorageConfig()`：优先 `HIPPOCAMPUS_DB`/`dbPath`，
其次 `HIPPOCAMPUS_DATA_DIR`，再沿用旧版 `$DSH_HOME/hippocampus/memory.db`，否则用
仓库下 `.data/hippocampus/memory.db`。原生插件可用 `HIPOCAMPUS_REPO` 指向其他 checkout。

## 行为

- 状态条每 60 秒刷新一次；点按打开面板。
- 面板列出最近 8 条记忆（点条目=归档），可刷新、回放；有冲突时显示黄色提示。
- 「存进记忆」把长按的回复存成 `episodic`，标签 `dsh-go` / `对话收藏`，importance 5。
- 「回忆」用输入框草稿检索最多 4 条，把草稿和结果一起插回输入框，不自动发送。
