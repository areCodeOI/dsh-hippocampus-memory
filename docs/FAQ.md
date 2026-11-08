# 常见问题

> **适合谁**：所有人：按症状排查
> **难度**：入门 · **预计阅读**：3 分钟

按症状排查。新手先读 [START-HERE.md](START-HERE.md)。

**Q：为什么默认不用向量数据库？**
A：本地优先：SQLite FTS5 + 二元组 + 重要性/近因加权在中文短事实场景已经够用。需要语义召回时配置嵌入 provider 即可；SQLite 用 BLOB + SimHash 分桶，PostgreSQL 可选 pgvector 精确余弦。

**Q：怎么确认插件真的在用？为什么我没看到记录？**
A：三个地方：① 相关对话里会出现「海马体自动召回」背景块；② 手机面板会累计
「自动召回 N 次 / 累计注入 M 条」；③ `memory_stats` 的 `autoRecall` 字段和
数据库 `events` 表（写入/更新）能看到记录。自动召回只在相关时注入，不是每轮都有；
如果你没说过稳定偏好/配置，也不会凭空产生写入。

**Q：为什么 `memory_search` 返回空？**
A：说明库里没有相关记忆。这不代表模型可以编造；按规范应直接告诉用户「没有相关记忆」。

**Q：为什么重复写入没有增加条数？**
A：查重命中后强化旧记忆（权重、访问次数、标签），这是设计目标：控制记忆库膨胀。

**Q：冲突为什么不自动取新的？**
A：规范要求「没有证据不覆盖固化记忆」。新信息先挂 `conflict`，确认后才取代旧条目，旧条目保留 `superseded` 审计。

**Q：多个进程同时写会锁吗？**
A：SQLite 用 WAL + `busy_timeout=15000`，正常并发没问题；极高写入频率或跨机器请切 PostgreSQL，多实例共享。

**Q：能存英文/日文吗？**
A：可以。分词对英文按单词、CJK 按二元组；记忆内容建议统一简体中文（人格/语义），但检索支持中英混排。

**Q：Node 版本不够？**
A：`node:sqlite` 需要 ≥ 22.13（22.5–22.12 需 `--experimental-sqlite`）。低于此版本请升级 Node。

**Q：怎么新建 / 重命名 / 合并 / 删除 namespace？**
A：WebUI 左侧「记忆空间」页；或 CLI `node bin/hippocampus.mjs namespace list|create|rename|merge|delete`；
或 HTTP `/api/namespaces`。空间是隐式分区，写入首条记忆也会创建；重命名会同步 API key 白名单与排队任务；
删除默认是 7 天冷静期，`--hard --confirm` 才永久删除。默认空间受配置保护。详见 [API.md](API.md#命名空间管理)。

<a id="reset"></a>
## 忘记密码 / 重置密码

v0.3.0 之前只能直接改 SQLite；现在有三种方式：

1. **已登录 WebUI / 会话**：`POST /api/auth/password`
   `{"currentPassword":"旧密码","newPassword":"新密码"}`。需要会话 token；
   旧密码错误返回 401；成功后保留当前会话、吊销其他会话。
2. **管理员重置**：`PATCH /api/users/{id}/password` `{"password":"新密码"}`
   （admin 角色，吊销该用户全部会话）；`GET /api/users` 可先取 id。
3. **命令行（忘记密码时推荐）**：

   ```bash
   node bin/hippocampus.mjs user list
   node bin/hippocampus.mjs user reset-password --email you@example.com
   # 省略 --password 会生成一次性强密码并只显示一次；也可以显式传入
   ```

   重置会吊销该账号的全部会话，旧密码立即失效。

注意：密码首尾空格会被自动忽略（注册/登录/改密一致），复制密码时带空格不会再
造成「注册成功、登录永远失败」。全角字符是不同字符，请确认输入法。

排查「注册成功但登录失败」：先确认邮箱大小写（统一小写）与首尾空格；仍不行就重置。

