# 参考的开源项目与设计取舍

> **适合谁**：想了解设计来源与取舍的人
> **难度**：参考 · **预计阅读**：3 分钟

一句话：这些开源项目启发了本项目的设计；不看也不影响使用。

海马体记忆不是一个从零发明的概念。下列项目在「agent 长期记忆」的不同方向上有公开实现；本项目的取舍是**CLS 四层 + 本地优先 + 可视化/运维一体化**。

| 项目 | 核心思路 | 对本项目的影响 |
| --- | --- | --- |
| [Mem0](https://github.com/mem0ai/mem0) | 抽取事实、向量记忆、可选图记忆；提供托管/自托管 API | 最小事实 + 去重/冲突 + REST/MCP 的产品形态；我们没有把 LLM 抽取强绑进写入路径 |
| [Letta（MemGPT）](https://github.com/letta-ai/letta) | OS 式内存层级、agent 主动管理 core/archival/recall memory | 「agent 决定何时写/读/归档」的显式记忆管理；本项目的 buffer/episodic/semantic/persona 四层更贴近 CLS |
| [Zep / Graphiti](https://github.com/getzep/graphiti) | 时序知识图谱，事实带 valid/invalid 时间窗；冲突不删除旧事实 | `conflict` + `superseded` 的审计式更新；我们没有引入完整时序图数据库，而是用 SQLite 关系列 |
| [Cognee](https://github.com/topoteretes/cognee) | 文档/图/向量混合记忆管线 | 混合检索（词法 + 可选向量）与异步索引任务 |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | 以 Markdown 为源、双向链接、人类可读 | 「数据可带走」与导出/导入；本项目用 SQLite 而非 Markdown，但保留 JSON 快照 |
| [MemoryOS](https://github.com/BAI-LAB/MemoryOS) | 分层记忆操作系统（短期/中期/长期） | 分层与衰减/回放的思想；本项目把分层固化为四种 kind 与不同 λ |
| [Khoj](https://github.com/khoj-ai/khoj) | 自托管个人 AI、文档/记忆检索、Web UI | 自托管 + Web 管理面的产品方向；本项目的 UI 更聚焦记忆图谱与运维 |
| [MemGPT 论文](https://arxiv.org/abs/2310.08560) | 虚拟上下文管理与内存层级 | 显式记忆管理、压缩/召回 |
| [Generative Agents](https://arxiv.org/abs/2304.03442) | memory stream + reflection + retrieval | 回放/巩固（replay）与重要性/近因/相关性打分 |
| [Complementary Learning Systems](https://doi.org/10.1037/0033-295X.102.3.419) | 海马快速编码 + 新皮层慢速巩固 | 四层记忆与不同衰减系数、睡眠回放 |

## 我们刻意没有照搬的部分

- **没有把 LLM 调用放进核心写路径**：Mem0/Graphiti 等可以在写入时调用模型抽取/消解；本项目默认确定性、可离线、可测试，模型只负责决定「存什么」。
- **没有默认向量数据库**：FTS5 + CJK 二元组在中文短事实场景足够；嵌入是可选的混合增强，不配置时零网络请求。
- **没有假装分布式**：单机 SQLite 是明确边界；水平扩展需要 PostgreSQL/pgvector 或图数据库，见 [OPERATIONS.md](OPERATIONS.md)。
- **默认不自动捕获整段聊天**：显式 `memory_add` 是主路径；v0.5 提供 opt-in 的 `autoCapture`，只捕获用户明确陈述的少量候选事实，不调用模型、不存全文，并跳过敏感词。
- **图是投影而非全库**：星图最多 500 节点，按重要性取；大库用分页/过滤，而不是把十万条边塞进浏览器。

## 可视化参考

「记忆星图」是 agent memory 社区常见的隐喻（把记忆/知识画成星座）。本项目没有依赖某个图形库，而是：

- 服务端 `/api/graph` 生成节点/边投影；
- 前端 Canvas 自己实现力导向、平移/缩放/拖拽；
- 边类型显式对应巩固、冲突、共享标签、词法相似；
- 节点颜色/大小/描边对应记忆层、重要性、冲突状态。

这样星图不是装饰，而是能直接读到记忆系统状态的管理视图。
