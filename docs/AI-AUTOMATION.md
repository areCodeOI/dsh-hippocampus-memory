# AI 自动化教程：把安装、维护、排障交给 AI

> 适合“不想记命令、不想读长文档”的人。你只需要复制一段话给 AI，让它按步骤做并汇报。
> 新手先看 [START-HERE.md](START-HERE.md)；手机日常使用看 [USE-DSH-GO.md](USE-DSH-GO.md)。

## 0. 先记住 4 条安全规则

1. **不要让 AI 接触你的 GitHub token、API key、密码**；安装不需要这些。
2. **安装前先备份**：WebUI「设置 → 导出」或复制 `memory.db`。
3. **不要让 AI 删除人格记忆/批量清空**；要删先让它列出清单给你确认。
4. **不要让 AI 自行 push 代码**；需要推远程时让它先问你。

下面所有提示词都已经写了这些限制，可以直接用。

## 1. 场景 A：让 AI 在 dsh-go 手机里安装

在 dsh-go 新建对话，把下面整段复制发送（把路径换成你的实际路径）：

```text
请帮我安装「海马体记忆」插件，并做验收。

项目路径：/sdcard/model/dsh-hippocampus-memory

要求：
1. 先确认环境：node -v 必须 >= 22.13；不支持就停下来告诉我，不要乱装。
2. 执行：dsh plugin --profile web add /sdcard/model/dsh-hippocampus-memory
3. 执行：dsh plugin --profile web list，确认出现 dsh-hippocampus-memory。
4. 等待/触发引擎重启后，检查 http://127.0.0.1:7337/health 是否返回 ok；
   如果 10 秒内没起来，等 10 秒再试一次，不要重复安装。
5. 用 memory_stats 工具确认插件可用，并告诉我 dbPath 和 memories 总数。
6. 告诉我三件事怎么验证：输入框上方状态条「记忆 N」、长按 AI 回复的「存进记忆」、
   插件页是否只有一个「海马体长期记忆」。
7. 不要删除/移动项目目录，不要 git push，不要改任何 token 配置。

每完成一步用中文汇报结果；失败就停下来说明原因和下一步，不要猜。
```

**你需要做的**：等它汇报完，按第 4 步的三处检查一下。看不到就让它继续排查（用第 5 节提示词）。

## 2. 场景 B：让 AI 在 DSH Web / 桌面端安装

```text
请帮我安装海马体记忆插件。
项目路径：/绝对路径/dsh-hippocampus-memory

步骤：
1. 用 plugin_manager(action="install_bundle", target="/绝对路径/dsh-hippocampus-memory") 安装；
2. 如果提示需要重启/刷新，告诉我怎么做；
3. 重启后确认侧边栏「插件」旁出现「记忆」，设置页出现「记忆」分区；
4. 用 memory_stats 确认工具可用，报告 dbPath；
5. 不要删除项目目录，不要 push。
```

## 3. 场景 C：让 AI 接入 Claude / Cursor 等 MCP 客户端

```text
我在用 {{客户端名称}}，想接上海马体记忆的 MCP server。
项目路径：/绝对路径/dsh-hippocampus-memory

请：
1. 确认 node -v >= 22.13；
2. 给我这个客户端要粘贴的 MCP 配置 JSON（command=node，
   args=["/绝对路径/dsh-hippocampus-memory/bin/hippocampus-mcp.mjs"]）；
3. 告诉我配置文件放在哪、改完怎么重启；
4. 重启后让我验证：客户端里应出现 8 个 memory_* 工具；
5. 不要修改项目里的代码，不要 push。
```

## 4. 场景 D：让 AI 做日常维护（推荐每周一次）

```text
请帮我做一次海马体记忆体检，只读优先：
1. 用 memory_stats(includeConflicts=true) 报告：总数、各层数量、待确认冲突列表；
2. 用 memory_replay(dryRun=true) 预览回放结果（不写入）；
3. 检查 http://127.0.0.1:7337/health 和 /api/monitor 是否正常；
4. 列出建议：哪些冲突需要我确认、哪些记忆建议归档、是否建议真正执行回放；
5. 等我确认后，再执行 memory_replay（不要自动删除任何记忆）；
6. 最后告诉我数据库路径和大小，提醒我备份。
```

想让它自动备份：

```text
请通过 WebUI/API 创建一个备份任务（backup），等它结束后把结果文件路径和大小告诉我；
不要删除旧备份，不要动记忆内容。
```

## 5. 场景 E：出问题时让 AI 自动排查

直接把现象发给它，例如：

```text
dsh-go 里看不到「记忆 N」状态条，长按回复也没有「存进记忆」。
请按顺序排查并修复：
1. dsh plugin --profile web list 里有没有 dsh-hippocampus-memory；
2. 引擎是否在运行、7337 是否正常；
3. 读 ~/.dsh/dsh-app/diagnostics.md 的最近错误和引擎日志尾部；
4. 如果只是没重启，告诉我重启引擎；如果是安装断了，重新安装但不要重复装；
5. 修好后用三处验收：状态条、长按菜单、插件页只有一个条目。
不要删除数据，不要删项目目录，不要 push。
```

其他常见现象可以直接替换第一句：

- “`memory_*` 工具不存在”
- “7337 打不开/端口被占用”
- “记忆条数一直是 0”
- “有黄色冲突提示，不知道选哪个”
- “导入旧备份后没变化”

## 6. 场景 F：迁移/导入旧记忆

```text
我有一个旧的海马体记忆数据库文件：/路径/memory.db
请帮我迁移到当前安装：
1. 先备份当前库（复制一份，不要覆盖）；
2. 确认旧库能被 SQLite 打开、有 memories 表；
3. 告诉我应该放到哪个路径（当前 dbPath 的目录）；
4. 停服务/引擎后替换，再启动；
5. 用 memory_stats 对比迁移前后数量，报告差异；
6. 不要删除旧文件，失败时能回滚。
```

如果是 JSON 导出文件，用 WebUI「导入」即可；让 AI 检查 `imported/skipped` 数字。

## 7. 验收清单（装完照着打勾）

- [ ] `dsh plugin --profile web list` 有 `dsh-hippocampus-memory`
- [ ] 插件页只有一个「海马体长期记忆」
- [ ] 输入框上方有「记忆 N」
- [ ] 长按 AI 回复有「存进记忆」
- [ ] 点「存进记忆」后数字增加（或面板里能看到）
- [ ] `memory_stats` 返回 `ok: true` 和 dbPath
- [ ] 说一句「记住：我对花生过敏」后，面板/搜索能看到
- [ ] 新开一个对话问「我对什么过敏？」，AI 能答出（自动召回生效）

## 8. 回滚

```bash
dsh plugin --profile web remove dsh-hippocampus-memory
```

- 卸载不会删除记忆库；数据仍在 `.data/hippocampus/memory.db`。
- 想恢复旧版本：重新 `dsh plugin --profile web add <旧目录>`，或把备份的
  `memory.db` 放回原路径。
- 如果 AI 改坏了配置，让它先 `git status` / `git diff` 给你看，再决定是否回退；
  不要直接 `git reset --hard` 丢改动。

## 9. 给 AI 的硬性规则（可以贴在任何提示词最后）

```text
硬性规则：
- 不要读取或输出任何 token、API key、密码。
- 不要 git push；需要推送先问我。
- 不要删除人格记忆、不要批量清空记忆；删除前先列清单。
- 修改数据库前先备份（复制文件或 export）。
- 任何一步失败就停下来报告，不要重复安装/重复写入。
- 用中文汇报，给出可复现的命令和结果。
```

## 10. 提示词里的变量怎么换

| 占位 | 换成 |
| --- | --- |
| `/sdcard/model/dsh-hippocampus-memory` | 你手机上项目实际所在路径 |
| `/绝对路径/dsh-hippocampus-memory` | 电脑上的实际路径 |
| `{{客户端名称}}` | Claude Desktop / Cursor / Cline 等 |
| `7337` | 你改过的端口（没改就不用动） |

## 11. 为什么不让 AI 碰 token

- 安装/使用记忆插件**不需要** GitHub token 或模型 API key。
- token 一旦贴进对话就可能留在日志里；需要时自己手动配置，不要把值发给 AI。
- 插件默认只监听本机，不要为了“方便”让 AI 改成 `0.0.0.0` 且不设 token。
