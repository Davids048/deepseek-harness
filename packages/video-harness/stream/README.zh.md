---
description: "DreamVerse 的实时媒体流：一个 Cordis 服务把正在渲染的镜头的 fMP4 分块，以及项目的记录变化和历史移动，经 /vh/ws WebSocket 路由发给浏览器。"
kind: "package-reference"
---

# @video-harness/stream

[English](README.md) | 中文

## 概述

使用本包让浏览器在 `shot.render` 仍在渲染镜头时观看它。本包的 Cordis 服务从 `@dv/shot-render` 接收每个正在渲染的版本的 fMP4 分块，并按 DreamVerse 媒体帧格式（`media_init`、二进制分块、`media_segment_complete`）发给经 `/vh/ws` WebSocket 路由订阅该项目的每个浏览器。在镜头中途订阅的浏览器先收到已经发出的分块，以字节预算为上限。同一个 socket 还转发 `dvProject` 中项目的记录变化和当前位置的移动，所以一条连接同时承载媒体和状态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在有 DSH web 服务器（`webServer`）的 profile 里挂载插件；`webServer` 存在期间 `/vh/ws` 路由存在。`dvProject` 是可选的：没有它时，socket 只承载媒体。

```yaml
- id: vh-stream
  name: '@video-harness/stream'
  config:
    bufferBytes: 67108864
    pingMs: 20000
```

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `bufferBytes` | 64 MiB | 一个进行中的片段为镜头中途订阅的浏览器保留的最多字节数 |
| `pingMs` | 20000 | 服务器 ping 的间隔，防止空闲代理关闭 socket |

`@dv/shot-render` 在每次渲染时用 `ctx.get` 查找 `vhStream` 服务，服务存在时在后端视频流开始时调用 `openSegment(project, record, {mime, segmentIdx})`。记录 ID 成为浏览器看到的 `stream_id`，渲染的 `shot` 参数（没有时为 0）成为 `segment_idx`。`openSegment` 返回的写入端有 `chunk(bytes)`、`complete()` 和 `fail(error)`。`subscribe(project, listener)` 在 Host 进程内收到相同的帧，`openSockets` 统计打开的浏览器 socket 数。 <!-- names:allow (the live stream service keeps its name) -->

`/vh/ws` 路由的工作方式如下：

| 步骤 | 消息 |
| --- | --- |
| 升级请求 | 挂载了 `connection` 服务时由它决定；被拒绝的请求得到 HTTP 401 或 403，不是 WebSocket 升级的请求得到 HTTP 400 |
| 浏览器订阅 | 文本 `{type: 'subscribe', project_id}`；后来的订阅替换先前的订阅 |
| 服务器确认 | `{type: 'subscribed', project_id, in_flight}`，`in_flight` 列出仍在渲染的每个片段的 `stream_id`，随后重放这些片段 |
| 镜头开始 | `{type: 'media_init', segment_idx, mime, stream_id}` |
| 分块到达 | 一条带 fMP4 字节的二进制消息 |
| 镜头结束 | `{type: 'media_segment_complete', segment_idx, stream_id}` |
| 镜头失败 | `{type: 'error', stream_id, message}` |
| 记录写入或更新 | `{type: 'op', change: 'append' 或 'patch', op}`，`op` 是 `ProjectRecord` |
| 写入、撤销、重做或移到某一步改变了历史列表或当前位置 | `{type: 'line', tip, at}`：最后一步和当前位置 |
| 错误的消息 | 文本不是 JSON 或不是订阅命令时为 `{type: 'error', message}` |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`SegmentBroadcaster` 按项目保存订阅者集合和进行中的片段。`openSegment` 立即发送 `media_init`，并在每个分块到达时把它交给订阅者。每个分块也为后来的订阅者保留，直到片段保留的字节将超过 `bufferBytes`；此后片段被标为截断，后来的订阅者不会收到它的重放。`complete` 和 `fail` 把片段从进行中集合移除。`VhStream` 在 `webServer` 存在期间注册 `/vh/ws` 升级路由，web 服务器消失时以代码 1001 关闭每个打开的 socket。每个 socket 每 `pingMs` 发送一次 ping，并忽略浏览器发来的二进制消息。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 服务类 `VhStream`、其配置、`/vh/ws` 路由，以及 `dvProject` 事件的转发 |
| [`src/broadcast.ts`](src/broadcast.ts) | `SegmentBroadcaster`：按项目分发片段，并为后来的订阅者做有上限的重放 |
| [`src/socket.ts`](src/socket.ts) | RFC 6455 服务端 socket，使本包不需要 WebSocket 库：握手、帧编码与解码、ping 与 pong、关闭 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/shot-render`](../../dv/shot-render/README.zh.md) — 渲染版本并把其分块写入本服务的操作。
- [`@dv/project`](../../dv/project/README.zh.md) — socket 转发的记录事件和 line 事件。
- [DreamVerse 包](../../../docs/subsystems/video-harness.zh.md) — DreamVerse 各包如何组合。
- [`dsh-host-webserver`](../../host/webserver/README.zh.md) — 提供升级路由的 web 服务器。

-----

<a id="model-experience"></a>
## 模型体验

无，因为服务把媒体字节和项目变化转发给浏览器；没有模型请求读取它们。

#### KV Cache 影响

无；服务不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有 DreamVerse 视图读取该路由** — `@dv/bundle` 不挂载本包，也没有 `@dv/ui-*` 插件订阅 `/vh/ws`；只有 profile 挂载本服务时 `@dv/shot-render` 才使用它。
- **后来的订阅者错过大片段** — 字节超过 `bufferBytes` 的片段不重放；在那之后订阅的浏览器收到该片段后续的分块和完成消息，但收不到它的 `media_init`。
- **订阅时不检查项目** — 服务器确认任何 `project_id`；只有 `dvProject.subscribe` 抛出的错误会以 `error` 消息到达浏览器。
- **操作日志的消息名** — 记录消息沿用 DreamVerse 页面帧格式的类型 `op` 和字段 `op`，尽管它们承载的是 `ProjectRecord`。
