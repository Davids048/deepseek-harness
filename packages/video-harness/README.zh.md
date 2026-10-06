---
description: "video-harness 包组：镜头渲染的实时媒体流。其余 DreamVerse 包位于 `packages/dv/`。"
kind: "package-group"
---

# video-harness/ — 视频智能体 harness

[English](README.md) | 中文

## 概述

本包组只有一个包 `stream`（`@video-harness/stream`），它是一个 Cordis 服务：`shot.render` 渲染一个版本时，该服务通过 WebSocket 路由 `/vh/ws` 把这个版本的 fMP4 分块发给订阅该项目的每个浏览器。DreamVerse 的项目组件、其他组件、API、智能体集成、界面插件和浏览器测试位于 `packages/dv/`，入口是 [`@dv/project`](../dv/project/README.zh.md)；bundle 是 [`@dv/bundle`](../bundle/dv/README.zh.md)。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

[DreamVerse 各包页面](../../docs/subsystems/video-harness.zh.md)说明这些包如何配合。

| 包 | 职责 |
| --- | --- |
| `stream` | `@video-harness/stream`：镜头渲染的实时 fMP4 分块，按 DreamVerse 的媒体帧格式经 WebSocket 路由 `/vh/ws` 发给浏览器 |

<a id="related-documentation"></a>
## 相关文档

- [DreamVerse 各包](../../docs/subsystems/video-harness.zh.md) — 分层、操作记录，以及视图和智能体遵守的规则。
- [`@dv/api`](../dv/api/README.zh.md) — 界面插件读取状态所用的浏览器 API。
- [`dreamverse/`](../dreamverse/README.zh.md) — 模型工具复用的生成客户端和片段规则。

<a id="dev-note"></a>
## 开发备注

无。
