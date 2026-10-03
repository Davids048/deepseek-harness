---
description: "dreamverse 包组：DreamVerse 的 harness 包、共享项目层以及生成后端客户端，供选择或浏览该包族的读者使用。"
kind: "package-group"
---

# dreamverse/ — DreamVerse on DeepSeek Harness

[English](README.md) | 中文

## 概述

这些包在 DeepSeek Harness 内运行交互式视频故事应用 DreamVerse。用户用一段提示词和若干参考图创建项目，逐个片段地导演它，之后还能重新打开；harness 负责增强提示词、向 FastVideo 后端请求每个视频片段，并存储每个项目和文件。共享项目层（文件存储、项目存储、片段生成）对各种工作负载（workload）类型通用，DreamVerse 使用它。页面位于 [`../dreamverse-ui/`](../dreamverse-ui/README.zh.md)。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

[DreamVerse 子系统页](../../docs/subsystems/dreamverse.zh.md)说明这些包如何组合在一起。

| 包 | 角色 |
| --- | --- |
| [`assets-manager`](assets-manager/README.zh.md) | 文件存储：素材库上传、所有项目文件以及 `/assets` 路由 |
| [`project-store`](project-store/README.zh.md) | 所有工作负载的项目记录、写租约以及 `/projects` 路由 |
| [`segment-generation`](segment-generation/README.zh.md) | 为任意工作负载生成一个片段并存储其视频与末帧；持有共享生成规则 |
| [`generation-client`](generation-client/README.zh.md) | FastVideo 生成后端 API 的客户端 |
| [`prompt-enhancer`](prompt-enhancer/README.zh.md) | 通过 Cerebras 与 Groq 把用户想法变成完整的视频提示词 |
| [`project`](project/README.zh.md) | DreamVerse 项目：状态、操作准入、生成计划以及项目日志 |
| [`user-actions`](user-actions/README.zh.md) | 每个 DreamVerse 用户操作一个插件 |
| [`project-controller`](project-controller/README.zh.md) | `/ws` 项目协议、健康与能力路由，以及页面的协议模块 |
| [`http-routes`](http-routes/README.zh.md) | 供 DreamVerse HTTP 路由使用的 Starlette 兼容响应与路由分发 |

<a id="related-documentation"></a>
## 相关文档

- [DreamVerse 子系统](../../docs/subsystems/dreamverse.zh.md)——进程布局、共享项目层、工作负载，以及与 Python 参考实现的差异。
- [`dreamverse-ui/`](../dreamverse-ui/README.zh.md)——DreamVerse 页面。
- [`@dreamverse/bundle`](../bundle/dreamverse/README.zh.md)——`dreamverse` profile 层。

<a id="dev-note"></a>
## 开发备注

无。
