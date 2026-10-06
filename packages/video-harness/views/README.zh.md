---
description: "视频 harness 的浏览器 API：经认证的路由读取分支状态、把画布和时间线的操作写成人的记录、接受或丢弃草稿、撤销和重做、开分支、保留过期记录，并以事件流推送项目变化。"
kind: "package-reference"
---

# @video-harness/views

[English](README.md) | 中文

## 概述

使用本包让浏览器视图通过 HTTP 而不是通过 agent 读取和修改视频项目。`vhViews` 在 `/api/vh/` 下注册经认证的 Fetch 路由：列出项目、把一条分支的状态读成 JSON、列出工具声明、以人的身份运行一个操作、接受或丢弃一个聊天会话的草稿、撤销和重做、开分支和切换分支、保留一条过期记录，以及记录视图选中了什么。原始路由 `GET /vh/events` 以 server-sent events 推送每一次项目变化，用同一个 Connection cookie 放行。`@video-harness/ui-canvas` 和 `@video-harness/ui-timeline` 是它的消费者。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@video-harness/assets`、`@dv/project` 和 `@video-harness/tools` 之后挂载插件，并且 profile 还要挂载 `dsh-web-app`（提供 `connection` 和 `webServer` 服务）。没有 `connection` 时 Fetch 路由不会注册；没有 `webServer` 时事件流不会注册。

```yaml
- id: vh-views
  name: '@video-harness/views'
  config:
    keepaliveMs: 15000
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `keepaliveMs` | `15000` | 空闲事件流多久发一行注释，让代理保持连接 |

| 路由 | 方法 | 请求 | 响应 |
| --- | --- | --- | --- |
| `/api/vh/projects` | GET | 可选 `session`（聊天会话 ID） | 全部项目，最新在前，带各分支头；给出 `session` 时该会话绑定的项目排第一并带 `current: true` |
| `/api/vh/projects` | POST | `{title, surface}` | 从视图新建的项目：`{projectId, title}` |
| `/api/vh/state` | GET | `project`，可选 `head`（分支名；默认 `main`） | 分支的状态：项目、head、各分支头、带草稿计数的分支、记录、提到的素材、角色场景和风格、时间线、过期和被替代的记录、版本、计划、生产者 |
| `/api/vh/tools` | GET | — | 全部已注册工具的声明，不含执行器 |
| `/api/vh/invoke` | POST | `{project, tool, inputs?, params?, intent?, surface, session?, base_op?, supersedes?}` | 记录；`surface` 是 `canvas` 或 `timeline` |
| `/api/vh/drafts/accept` | POST | `{project, session \| branch, surface}` | `proj.draft_accept` 记录和之后的各分支头 |
| `/api/vh/drafts/discard` | POST | `{project, session \| branch, surface, counts?}` | 不带 `counts`：`{draft, counts}`；带已确认的计数：被丢弃的计数和之后的各分支头 |
| `/api/vh/undo` | POST | `{project, session?, surface}` | `proj.undo` 记录和之后的各分支头 |
| `/api/vh/redo` | POST | `{project, session?, surface}` | `proj.redo` 记录和之后的各分支头 |
| `/api/vh/branch` | POST | `{project, name, at, session?, surface}` | 分支 `explore/<name>` 和之后的各分支头 |
| `/api/vh/branch/switch` | POST | `{project, branch, session, surface}` | 会话所在的分支和之后的各分支头 |
| `/api/vh/stale/accept` | POST | `{project, record, session?, surface}` | `proj.stale_accept` 记录和之后的各分支头 |
| `/api/vh/selection` | POST | `{project, kind: op \| clip \| asset \| entity, id, slot?, surface}` | `{ok: true}` |
| `/vh/events?project=<id>` | GET | — | `text/event-stream`，含 `record`、`update` 和 `branch` 事件，每个事件带一个 `ProjectEvent` |

一次 invoke 以人的身份通过 `dvProject.run` 运行操作，写在请求所属聊天会话的当前分支上（没有会话时是 `main`）；当某个输入指向尚未完成的记录时改为排队。请求体不合法回 `400`，项目、记录或工具不存在回 `404`，被拒绝的变更（例如丢弃一个计数已变化的草稿）回 `409`；每个错误体都是 `{error, code?}`，`code` 是 `ProjectError` 的错误码。宿主可以通过 `vhViews.selection(projectId)` 读到项目的最近一次选择，让 agent 提示词提到用户指向的东西。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`VhViews` 在 `dvProject`、`vhAssets` 和 `vhTools` 之上构造一个 `ViewsApi`。在 `ctx.inject(['connection'])` 里它用 `connection.fetch.register` 注册各条 Fetch 路由，每条都经过同一个 `answer` 包装，把 `ViewsRequestError` 映射成状态码。在 `ctx.inject(['webServer'])` 里它注册 `/vh/events` 前缀路由，通过 `requestRejection` 询问 Connection 请求是否带有效 cookie，再把响应交给 `serveEventStream`；后者订阅 `dvProject.subscribe(projectId)`，每次变化写一帧 `event:`/`data:`，直到请求关闭。`toWireState` 把 `ProjectState` 变成 JSON：品牌化 ID 保持字符串，素材列表是每条记录的输出和已解析输入，以及每个角色、场景和风格版本的参考图的并集。

| 文件 | 内容 |
| --- | --- |
| [`src/wire.ts`](src/wire.ts) | `WireState`、`WireToolSpec`、`ViewSelection`、`toWireState`、`mentionedAssets`、`projectIdOf` |
| [`src/api.ts`](src/api.ts) | `ViewsApi` 和 `ViewsRequestError`：每条路由背后的校验和 `dvProject` 调用 |
| [`src/events.ts`](src/events.ts) | `frameOf` 和 `serveEventStream` |
| [`src/index.ts`](src/index.ts) | `VhViews`、`ROUTES`、`EVENTS_PATH` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md) — 记录、草稿、过期标记，以及每个视图遵守的规则。
- [`@dv/project`](../../dv/project/README.zh.md) — 路由背后的记录、草稿、分支、撤销和过期标记。
- [`@video-harness/ui-canvas`](../ui-canvas/README.zh.md) 与 [`@video-harness/ui-timeline`](../ui-timeline/README.zh.md) — 两个浏览器消费者。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过路由把视图手势记成用户记录；agent 层决定模型从中了解什么。

#### KV Cache 影响

无；路由不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **选择只在内存里** — 每个项目的最近一次选择重启即丢，也不是记录。
- **整份状态读取** — 每次变化视图都重新拉取完整的折叠状态；没有增量状态路由。
- **缺少 `connection` 时事件流不认证** — 此时路由放行所有请求；profile 应挂载 `dsh-web-app`。
