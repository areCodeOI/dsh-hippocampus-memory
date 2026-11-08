# 从零开始：安装并使用海马体记忆

> **适合谁**：完全没接触过的新手
> **难度**：入门 · **预计阅读**：15 分钟
> **前置**：Android 手机 + dsh-go，或电脑上的 DSH；会复制粘贴即可

> 给完全没接触过 DSH 插件的人。照着做即可，**不需要懂代码**。
> 更短的一页版在 [README](../README.md)；全部文档导航在 [docs/README](README.md)；看不懂的词见 [第 10 节](#10-术语速查)。

先认识三个词：**DSH** 是能调用 AI 的对话工具；**dsh-go** 是它的 Android 手机 App；
**插件**是给 AI 增加能力的小程序（本文装的就是“长期记忆”能力）。

## 1. 这是什么，能帮你做什么

可以把「海马体记忆」理解成 **AI 的长期备忘录**：

- 你在一次对话里说过的稳定偏好、禁忌、项目配置，下次新对话它还能想起来。
- 记忆存在你自己设备上的一个本地数据库里，不上传云端。
- 同一份记忆可以给 dsh-go 手机 App、DSH 网页版、Claude/Cursor 等 MCP 客户端一起用。

你不需要每次都说“记住”。装好后：

- AI 会在每轮对话前自动召回相关记忆（不是每次都注入，只在相关时）。
- 长按手机里的一条回复，可以手动「存进记忆」。
- 打开「海马体记忆」面板，可以看到、归档、回放记忆。

## 2. 先选你的使用方式

| 你的情况 | 看哪一节 |
| --- | --- |
| 用 Android 手机上的 **dsh-go App** | [第 3 节](#3-在-dsh-go-手机-app-里安装推荐) |
| 用电脑上的 **DSH 网页版 / 桌面端** | [第 4 节](#4-在-dsh-web--桌面端安装) |
| 用 **Claude Desktop、Cursor、Cline** 等 MCP 客户端 | [第 5 节](#5-接入-claude--cursor-等-mcp-客户端) |
| 自己写程序，通过 HTTP 调用 | [第 6 节](#6-只用-http-api自己写程序) |

> 拿不准就选第 3 节；大多数人用的是 dsh-go 手机 App。

## 3. 在 dsh-go 手机 App 里安装（推荐）

### 3.1 你需要准备

- 一台 Android 手机，已经装好 dsh-go，并且能正常对话。
- 本项目的文件夹（下面用 `/sdcard/model/dsh-hippocampus-memory` 举例）。
  如果你是从 GitHub 下载的 zip，解压后把实际路径替换掉即可。
- 不需要 Root，不需要电脑，不需要单独买服务器。

### 3.2 安装（两种方法，选一种）

**方法 A：让 AI 帮你装（最省事）**

1. 在 dsh-go 里新建一个**普通对话**（不要用「伙伴」角色；它没有工具权限）。
2. 把下面整段话复制进去发送：

```text
请帮我安装海马体记忆插件。项目目录是 /sdcard/model/dsh-hippocampus-memory。
步骤：
1) 确认 node -v 满足 >=22.13；
2) 运行 dsh plugin --profile web add /sdcard/model/dsh-hippocampus-memory；
3) 运行 dsh plugin --profile web list，确认列表里有 dsh-hippocampus-memory；
4) 重启后确认插件工具可用；HTTP 默认关闭，除非我明确启用了它，否则不要检查 7337；
5) 用 memory_stats 工具确认可用，并把 DB 路径告诉我。
不要删除任何已有文件，不要 push 任何 git 仓库。每步把结果用中文告诉我。
```

3. 等 AI 做完。它会告诉你成功或卡在哪一步。
4. 如果界面没出现，去 App 的「引擎」页点一次「重启引擎」。

**方法 B：自己执行命令**

如果你会打开终端（或者 dsh-go 里有终端）：

```bash
dsh plugin --profile web add /sdcard/model/dsh-hippocampus-memory
dsh plugin --profile web list        # 应看到 dsh-hippocampus-memory
```

安装是「链接」到原目录，所以 **不要删除或移动项目文件夹**，否则插件会失效。

### 3.3 安装成功的标志

在 dsh-go App 里检查三处：

1. **输入框上方**出现一行小字：`记忆 1`（数字是记忆条数）。
2. **长按一条 AI 回复**，菜单里有「存进记忆」。
3. 打开「插件」页，已安装列表里只有一个 **海马体长期记忆**（不会有两个）。

如果三处都看不到：去「引擎」页重启引擎，再返回对话看一次。

### 3.4 第一次使用

在对话里直接说人话即可，例如：

- `记住：我对花生过敏，严重时会呼吸困难。`
- `记住：这个项目用 PostgreSQL 16，不要用 MySQL。`
- `我之前说过什么偏好吗？`
- `我上次说的部署窗口是周几？`

AI 会自己决定是否调用记忆工具；你也可以在插件面板里看到刚写入的记忆。
之后问一个相关问题时，对话里可能出现「海马体自动召回」背景块，面板里的
「自动召回 N 次」也会增加——这就是插件在工作/被使用的记录。

### 3.5 日常怎么用

见 [USE-DSH-GO.md](USE-DSH-GO.md)：状态条、面板、长按存记忆、「回忆」胶囊、回放。

## 4. 在 DSH Web / 桌面端安装

如果你用的是电脑上的 DSH 网页版/桌面端，**不需要自己敲命令**：

1. 打开 DSH，新建对话，发送：

```text
请帮我安装海马体记忆插件，项目路径是 /绝对路径/dsh-hippocampus-memory。
用 plugin_manager(action="install_bundle", target="/绝对路径/dsh-hippocampus-memory")
安装；需要重启/刷新就告诉我；装完用 memory_stats 确认可用。
```

2. 按 AI 的提示重启/刷新 DSH。
3. 侧边栏「插件」旁会出现「记忆」入口；设置页会多一个「记忆」分区。
4. 同样用 `memory_stats` 检查；WebUI 默认关闭，需要时按 [USE-WEB.md](USE-WEB.md) 开启
   （DSH 原版没有手机面板的 WebUI 按钮，要改 `httpEnabled` 或用独立服务）。

注意：本地目录安装是链接，项目文件夹不要删/移。

## 5. 接入 Claude / Cursor 等 MCP 客户端

前提：电脑上装了 **Node.js ≥ 22.13**（不会看版本就把这句话发给 AI 让它检查）。

1. 下载/解压本项目，记住路径。示例：
   - macOS/Linux：`/Users/you/dsh-hippocampus-memory`
   - Windows：`C:\Users\you\dsh-hippocampus-memory`（JSON 里反斜杠要写成 `\\`）
2. 在客户端的 MCP 配置里加入：

```json
{
  "mcpServers": {
    "hippocampus": {
      "command": "node",
      "args": ["/Users/you/dsh-hippocampus-memory/bin/hippocampus-mcp.mjs"]
    }
  }
}
```

3. 重启客户端，确认出现 8 个 `memory_*` 工具。

> 找不到配置文件在哪：Claude Desktop 一般在「设置 → 开发者 → 编辑配置」；
> Cursor 在「设置 → MCP / Tools」；不同版本菜单可能不同，找不到就问 AI：
> “{{客户端}} 的 MCP 配置文件在哪里？帮我加一个 node server”。
4. 让 AI 执行 `memory_add` 写一条，再 `memory_search` 搜回来。

> 不会写 JSON？把客户端名称和项目路径发给 AI，让它按
> [AI-AUTOMATION.md 第 3 节](AI-AUTOMATION.md#3-场景-c让-ai-接入-claude--cursor-等-mcp-客户端) 生成配置。

完整说明见 [MCP.md](MCP.md)。

## 6. 只用 HTTP API（自己写程序）

```bash
node /path/to/dsh-hippocampus-memory/bin/hippocampus-http.mjs --port 7337
curl http://127.0.0.1:7337/api/stats
curl -X POST http://127.0.0.1:7337/api/memories \
  -H 'content-type: application/json' \
  -d '{"content":"用户偏好简体中文回答。","kind":"persona","importance":9}'
```

接口列表见 [API.md](API.md)，多语言示例见 [EXAMPLES.md](EXAMPLES.md)。

## 7. 装完必须知道的 5 件事

1. **数据在哪**：默认是项目目录下 `.data/hippocampus/memory.db`；
   如果以前有 `~/.dsh/hippocampus/memory.db`，会自动沿用旧库。
2. **怎么备份**：WebUI 的「设置 → 导出」会下载一个 JSON；恢复用「导入」。
   也可以直接复制 `memory.db` 文件（先停服务更稳妥）。
3. **隐私**：默认只监听本机 `127.0.0.1`，不上传；但数据库**没有加密**，
   手机丢失/被解锁可能被看到，重要设备请开锁屏。
4. **不要随便删/移项目目录**：DSH 里装的是指向它的链接。
5. **冲突不会自动覆盖**：新信息和旧记忆矛盾时会先挂起，等你确认（面板会有黄色提示）。
6. **WebUI 默认关闭**：dsh-go 原生面板不需要 7337；要用浏览器管理台，
   打开记忆面板点 **WebUI**，插件会自动生成 token 并复制登录链接
   （见 [USE-WEB.md](USE-WEB.md) 第 0 节）。

## 8. 卡住了怎么办

| 现象 | 先做什么 |
| --- | --- |
| 没有状态条 / 没有「存进记忆」 | App「引擎」页重启引擎；再看「插件」页是否只有一个海马体条目 |
| `memory_*` 工具不存在 | 重新执行安装命令；确认 `dsh plugin --profile web list` 有 `dsh-hippocampus-memory` |
| 7337 打不开 | HTTP 默认关闭；先按 [USE-WEB.md](USE-WEB.md) 开启。已开启则检查端口占用/引擎 |
| 记忆条数是 0 | 还没写入过；说一句「记住……」或用长按「存进记忆」 |
| 旧记忆不见了 | 检查是不是换了 App 包/设备；旧库位置见 [CONFIG.md](CONFIG.md) |

更细的排查见 [FAQ.md](FAQ.md)；也可以把报错整段发给 AI，让它按
[AI-AUTOMATION.md](AI-AUTOMATION.md) 的排障提示词处理。

## 9. 想卸载

```bash
dsh plugin --profile web remove dsh-hippocampus-memory
```

卸载不会删除 `.data/hippocampus/memory.db`；想彻底清空再手动删这个文件。

## 10. 术语速查

| 词 | 大白话 |
| --- | --- |
| DSH | 能调用 AI 的对话工具 |
| dsh-go | DSH 的 Android 手机 App |
| 插件 / Host 插件 | 给 AI 增加能力的小程序；本项目的插件给 AI 加“长期记忆” |
| dsh-go 原生界面 | 手机 App 里的状态条、面板、长按菜单（和主插件同一个包） |
| token | 一串访问口令；设了以后打开管理台/API 要填 |
| MCP | 让 Claude/Cursor 等外部客户端也能用记忆工具的协议 |
| namespace | 记忆空间，用来隔离不同项目/agent |
| SQLite | 本机的小型数据库文件；记忆就存在里面 |
| 7337 | Web 管理台默认端口，地址是 `http://127.0.0.1:7337/` |
| profile | DSH 的“配置档案”；手机引擎用的是 `web` |
| 冲突 | 新信息和旧记忆矛盾，先挂起等你确认，不会自动覆盖 |
| 回放 | 按时间整理记忆：衰减、归档旧项、合并重复情景 |
