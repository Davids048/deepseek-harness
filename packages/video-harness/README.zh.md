---
description: "video-harness 包组：操作日志、内容寻址的素材存储、所有视频视图和 agent 共同写入的项目运行时、媒体服务、结构化工具、浏览器 API，以及画布和时间线视图。"
kind: "package-group"
---

# video-harness/ — 视频 agent harness

[English](README.md) | 中文

## 概述

这些包是视频 agent harness 的项目层。一个项目是一组不可变的媒体素材加一份追加写入的操作日志；画布、时间线和聊天都是这份日志的投影，agent 和每个视图都只能通过运行时调用工具来改变项目。运行时把日志折叠成状态，为每个 agent turn 开一个草稿分支，接受时快进 `main`，撤销 turn，开探索分支，并在输入被替代时把下游结果标记为过期。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

[视频 harness 子系统页](../../docs/subsystems/video-harness.zh.md)说明这些包如何配合。

| 包 | 职责 |
| --- | --- |
| [`assets`](assets/README.zh.md) | 内容寻址的不可变媒体存储，以及 `/vh/assets/<id>/content` 路由 |
| [`oplog`](oplog/README.zh.md) | 每个项目的追加写入操作记录、分支头和变更订阅 |
| [`runtime`](runtime/README.zh.md) | `invoke` 与 `schedule`、状态折叠、turn 与草稿、撤销、分支、过期标记、确定性缓存、计划调度和自动重放 |
| [`media`](media/README.zh.md) | 在已存素材上运行 ffmpeg 和 ffprobe：探测、抽帧、裁剪、拼接、运行声明输出的命令 |
| [`tools`](tools/README.zh.md) | 带类型的工具 spec、它们在运行时的注册，以及调用即成记录的 `vh_*` DSH 工具 |
| [`agent`](agent/README.zh.md) | DSH agent loop 的 turn 边界变成草稿、确认问题、项目提示词节，以及导演 skill |
| [`views`](views/README.zh.md) | 经认证的 `/api/vh/*` 路由和 `/vh/events` 事件流，浏览器视图经此读状态、写用户记录 |
| [`ui-kit`](ui-kit/README.zh.md) | 两个视图共用的浏览器代码：API 客户端、状态类型、图布局、表单模型、轨道几何和分支栏 |
| [`ui-canvas`](ui-canvas/README.zh.md) | 右侧栏的画布标签：记录按素材流向画成 DAG，参数表单可修改或重跑任一记录 |
| [`ui-timeline`](ui-timeline/README.zh.md) | 右侧栏的时间线标签：片段序列在一条轨道上，可排序、设范围、裁剪、插入、移除 |

<a id="related-documentation"></a>
## 相关文档

- [视频 harness 子系统](../../docs/subsystems/video-harness.zh.md) — 分层、操作记录，以及视图和 agent 遵守的规则。
- [`dreamverse/`](../dreamverse/README.zh.md) — 模型工具复用的生成客户端和片段规则。

<a id="dev-note"></a>
## 开发备注

无。
