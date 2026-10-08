# Video harness 设计

[English](video-harness-design.md) | 中文

本页是一个指针。[DreamVerse 各包](video-harness.zh.md)的设计依据记录在已发布的设计文档[视频 Harness 分层设计](https://claude.ai/artifact/5CoTU4WaDUfmGPC7wRPyZA)及其交互走查[操作日志与三视图可视化](https://claude.ai/artifact/KgwBnYzWMYZa1ewkJumAiN)中。[DreamVerse 各包页面](video-harness.zh.md)拥有当前的类型定义与生成的 Cordis API。

## 设计文档涵盖的内容

- 术语：项目、素材、操作记录、轮次、分支、工具、命令、分镜计划、角色和场景、视图。
- 从 DeepSeek Harness 内核到三个视图的六层结构，以及视图与智能体为何平级且只通过工具写入。
- 操作记录：追加写入、单父 DAG、命名指针、折叠即回放、undo 即指针移动、确定性缓存。
- chat、timeline、canvas 如何从同一份日志推导，每个界面的手势如何变成记录。
- 结构化工具与任意命令的区别，以及哪些命令应包装成工具。
- 过期、分支、确认、调度模式、指代解析、角色和场景、智能体修改手动内容的策略。
- 六步 test case 与两处已承认的别扭之处。
- 最小可行范围与扩展点。

## 实现位置

`packages/dv/` 和 [`packages/video-harness/`](../../packages/video-harness/README.zh.md) 下的包实现了该设计，[DreamVerse 各包页面](video-harness.zh.md)描述这些包；[DreamVerse 页](dreamverse.zh.md)列出了 harness 复用与取代的 DreamVerse 包。
