# dsh-go 原生界面（已合并进主插件）

原生界面不再是一个单独的包：仓库根目录的 `dsh-hippocampus-memory` 同时提供

- Host 半侧：8 个 `memory_*` 工具、`agent/pre-step` 自动召回、HTTP/WebUI、MCP；
- dsh-go 半侧（package.json 的 `dshGo` 清单 + `lib/dsh-go-ui.js`）：
  输入框上方状态条「记忆 N」、记忆面板、长按「存进记忆」、「回忆」胶囊、「回放记忆」。

两半共用一个 `MemoryStore`，所以只安装一个插件即可：

```bash
dsh plugin --profile web add /path/to/dsh-hippocampus-memory
```

dsh-go 的「插件」页只会看到一个「海马体长期记忆」。

## 行为

- 状态条每 60 秒刷新；点按打开面板。
- 面板列出最近 8 条记忆（点条目=归档），可刷新、回放；有冲突时显示黄色提示。
- 「存进记忆」把长按的回复存成 `episodic`，标签 `dsh-go` / `对话收藏`，importance 5。
- 「回忆」用输入框草稿检索最多 4 条，把草稿和结果一起插回输入框，不自动发送。

## 数据路径

仍由 `lib/paths.js` 的 `resolveStorageConfig()` 决定；Host 与 dsh-go 共用同一个 store，
因此不存在两个库或路径不一致的问题。
