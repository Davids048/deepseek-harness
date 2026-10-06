---
description: "video-harness 包组：基于 `@dv/project` 操作的 agent 集成、浏览器 API，以及画布和时间线视图。"
kind: "package-group"
---

# video-harness/ — 视频 agent harness

[English](README.md) | 中文

## 概述

这些包是视频 agent harness 的项目层。一个项目是一组不可变的媒体素材加项目组件 [`@dv/project`](../dv/project/README.zh.md) 的追加写入记录；画布、时间线和聊天都是这些记录的投影，agent 和每个视图都只能通过 `dvProject.run` 运行操作来改变项目。项目组件从记录计算状态，为每个聊天会话保留一个草稿直到人接受或丢弃它，把撤销和重做写成记录，开探索分支，并在输入被替代时把下游结果标记为过期。

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
| [`agent`](agent/README.zh.md) | DSH agent loop 的轮次及其请求文本、聊天图片导入、确认问题、项目提示词节，以及导演 skill |
| [`views`](views/README.zh.md) | 经认证的 `/api/vh/*` 路由和 `/vh/events` 事件流，浏览器视图经此读状态、写用户记录 |
| [`ui-kit`](ui-kit/README.zh.md) | 两个视图共用的浏览器代码：API 客户端、状态类型、图布局、表单模型、轨道几何和分支栏 |
| [`ui-canvas`](ui-canvas/README.zh.md) | 右侧栏的画布标签：记录按素材流向画成 DAG，参数表单可修改或重跑任一记录 |
| [`ui-timeline`](ui-timeline/README.zh.md) | 右侧栏的时间线标签：一条时间线的片段在一条轨道上，可排序、设范围、裁剪、插入、移除 |

<a id="related-documentation"></a>
## 相关文档

- [视频 harness 子系统](../../docs/subsystems/video-harness.zh.md) — 分层、操作记录，以及视图和 agent 遵守的规则。
- [`dreamverse/`](../dreamverse/README.zh.md) — 模型工具复用的生成客户端和片段规则。

<a id="dev-note"></a>
## 开发备注

无。
