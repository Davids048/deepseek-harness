---
description: "DreamVerse 的浏览器 API：经认证的路由读取分支状态、把画布、时间线和素材库面板的操作写成人的记录、新建、切换和重命名分支、撤销和重做、接受过期记录，并以事件流推送项目变化。"
kind: "package-reference"
---

# @dv/api

[English](README.md) | 中文

## 概述

使用本包让浏览器视图通过 HTTP 而不是通过智能体读取和修改 DreamVerse 项目。`dvApi` 在 `/api/dv/` 下注册经认证的 Fetch 路由，涵盖项目、分支状态、以人的身份运行的操作、素材导入、分支、撤销和重做、过期记录、历史、画布布局和 Workspace 关联。原始路由 `GET /dv/events` 以 server-sent events 推送每一次项目变化。`@dv/ui-*` 各包是它的消费者；浏览器客户端是 `@dv/ui-kit` 的 `DvClient`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 和 `@dv/asset-pool` 之后挂载插件，并且 profile 还要挂载 `dsh-web-app`（提供 `connection` 和 `webServer` 服务）。没有 `connection` 时 Fetch 路由不会注册；没有 `webServer` 时事件流不会注册。

这些 Fetch 路由列出、新建、重命名和删除项目，把一条分支的状态读成 JSON，列出操作声明，以人的身份运行一个操作，把文件导入素材库，新建、切换和重命名分支，撤销和重做，接受一条过期记录，列出历史，保存画布布局，以及把项目关联到 DSH Workspace。事件流用同一个 Connection cookie 放行浏览器。

```yaml
- id: dv-api
  name: '@dv/api'
  config:
    keepaliveMs: 15000
    stateRoot: /home/me/.local/state/dv
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `keepaliveMs` | `15000` | 空闲事件流多久发一行注释，让代理保持连接 |
| `stateRoot` | 必填 | 状态目录：`canvas-layout/` 里的画布布局、`workspaces.json` 里的项目 → Workspace 关联、`entry/` 里的入口 Workspace，以及 `sessions/` 里 `@dv/project` 的会话绑定文件；bundle 用 `DV_STATE_ROOT` 设置它 |

| 路由 | 方法 | 请求 | 响应 |
| --- | --- | --- | --- |
| `/api/dv/projects` | GET | 可选 `session`（对话 ID） | `WireProject[]`（`{id, title, created_at, heads, current}`），最新在前；给出 `session` 时该对话绑定的项目排第一并带 `current: true` |
| `/api/dv/projects` | POST | `{title, surface}` | 从视图新建的项目：`ProjectInfo` `{id, title, created_at}` |
| `/api/dv/projects/rename` | POST | `{project, title}` | `{title}`，重名时追加 ` 2`、` 3`…… 使其唯一 |
| `/api/dv/projects/delete` | POST | `{project}` | `{ok, workspace_id}`；项目移进 Project 存储的回收目录，它的画布布局文件被删除 |
| `/api/dv/state` | GET | `project`，可选 `branch`（默认是项目的当前分支） | `WireState`：`{project, branch, head, heads, branches, current, components, redo_steps, assets}`，带每个分支及其 `tip`、当前分支，每个组件状态切片与 Project 算出的一致，外加该分支上重做能恢复的步骤，以及每个被提到的素材在素材库里的条目 |
| `/api/dv/operations` | GET | — | `WireOperation[]`：每个不是 `readOnly` 的已注册操作，不含执行器 |
| `/api/dv/operation` | POST | `OperationRequest` `{project, operation, inputs?, params?, intent?, surface, session?, based_on?, supersedes?}`；`inputs` = `[{role, ref}]`，`ref` 是引用文本 | `ProjectRecord`，已完成或 `pending` |
| `/api/dv/assets/import` | POST | 原始文件作为请求体；查询参数 `project`、`name`、`mime`、`surface`（`canvas \| asset_pool`，其他值回 `400` `invalid_params`）、`session?` | `{asset, record}`：`AssetId` 和 `asset.import` 记录 |
| `/api/dv/branches/create` | POST | `{project, title?, branch?, to?, session?, surface}`：从当前分支 head 所在的位置分出一个分支，或带 `branch` 和 `to` 时从该分支的线上的那一步分出，并让它成为当前分支；`branch` 和 `to` 必须同时给出（否则返回 400 `invalid_params`） | `{branch, heads}`，带新分支 |
| `/api/dv/branches/switch` | POST | `{project, branch, to?, session?, surface}`：让一个分支成为当前分支；带 `to` 时让该分支回到它线上的这一步 | `{branch, heads}` |
| `/api/dv/branches/rename` | POST | `{project, branch, title}`；空标题恢复默认名称；超过 40 个字符的标题返回 400 `invalid_params`，与其他分支相同的标题返回 409 `branch_exists` | `{branch, heads}` |
| `/api/dv/undo` | POST | `{project, session?, surface, to?}`：在当前分支上后退一步，或回到记录 `to`（向前跳到可重做的步骤时写 `proj.redo`） | `{record, heads}`，带 `proj.undo` 记录 |
| `/api/dv/redo` | POST | `{project, session?, surface}`：在当前分支上前进一步 | `{record, heads}`，带 `proj.redo` 记录 |
| `/api/dv/stale/accept` | POST | `{project, record, session?, surface}` | `{record, heads}`，带 `proj.stale_accept` 记录 |
| `/api/dv/history` | POST | `{project, branch?, marks?, actor?, component?, operation?, kind?, status?, session?, turn?, tool_call?, records?, before?, limit?}`；`marks` 和 `records` 是数组；`limit` 取 1 到 200，默认 50 | `WireHistory` `{entries, assets}`：`dvProject.listHistory` 的条目 `{record, mark, branches}`（最新的在前），以及条目提到的每个素材；这是只读请求，不写记录 |
| `/api/dv/layout` | GET / POST | GET：`project`；POST：`{project, positions?, viewport?, placed?, removed?}` | `{positions, viewport, placed}`；POST 合并以画布节点 ID 为键的位置，把 `placed` 中的素材 ID 加入项目的画布列表（有画布节点的导入素材），并把 `removed` 中的素材 ID 移出该列表 |
| `/api/dv/workspaces` | GET / POST | POST：`{project, workspace_id}` | GET：`{entry_path, projects: [{id, title, created_at, path, workspace_id}], bindings}`；POST：`{ok}` |
| `/api/dv/workspaces/bind` | POST | `{session, project}` | `{ok}` |
| `/api/dv/workspaces/sessions` | GET | `project` | `[{session, updated_at, bytes}]`，最新在前；`updated_at` 是 ISO-8601 UTC |
| `/dv/events?project=<id>` | GET | — | `text/event-stream`：先 `ready`，再是 `record`、`update` 和 `branch` 事件，每个事件带一个 `ProjectEvent` |

`surface` 是 `canvas`、`timeline`、`asset_pool` 或 `history`；其他值都按 `canvas` 处理，素材导入除外：它只接受 `canvas` 或 `asset_pool`。一次运行以人的身份调用 `dvProject.run`，写在项目的当前分支上（撤销之后会先分出新分支），请求所属的对话记为记录的 `session`；当某个输入指向尚未完成的记录时改为排队。每条路由（包括事件流）的每个错误都以 JSON 体 `{error, code, ...details}` 回答：`error` 是消息文本，`code` 是下表中的一个错误码；`details` 携带拒绝的附加字段。

| 错误码 | 状态 | 含义 |
| --- | --- | --- |
| `invalid_params` | 400 | 请求不合法：字段、查询字段或文件体缺失或格式错误 |
| `invalid_inputs` | 400 | 操作拒绝的 `inputs`：未知角色、单值角色给了列表、缺少必需角色或未知版本；消息中写出操作名 |
| `unknown_project` | 404 | 请求指定的项目不存在 |
| `unknown_branch`、`unknown_record`、`unknown_asset`、`unknown_operation` | 404 | 其他不存在资源的 `ProjectError` 错误码 |
| `not_found` | 404 | 没有 `ProjectError` 错误码的不存在资源；本包读取的每种资源都有错误码 |
| 其他 `ProjectError` 错误码 | 400 或 409 | Project 拒绝了变更，例如 `nothing_to_undo` 或 `nothing_to_redo`（409） |
| `internal_error` | 500 | 意外失败；`error` 是抛出错误的文本 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`DvApi` 在 `dvProject` 和 `dvAssetPool` 之上构造一个 `ApiHandlers`；操作列表和一次运行的操作来自 `dvProject.listOperations()`，运行的 `inputs` 由 `dvProject.parseInputs` 解析，工作区路由用 `dvProject.bindSession` 把对话绑定到项目，并为列表读回绑定文件（`{"project": <ProjectId>}`）。在 `ctx.inject(['connection'])` 里它用 `connection.fetch.register` 注册各条 Fetch 路由，包括素材导入、布局、工作区和项目管理路由在内的每条路由都经过 `src/api.ts` 中同一个 `answer` 包装，把 `ApiRequestError` 或 `ProjectError` 映射成它的状态码和错误码，其他错误映射成 500 `internal_error`；同一文件中的 `requireProject` 检查每条路由指定的项目。`/dv/events` 写出同样的错误体。在 `ctx.inject(['webServer'])` 里它注册 `/dv/events` 前缀路由，通过 `requestRejection` 询问 Connection 请求是否带有效 cookie，再把响应交给 `serveEventStream`；后者订阅 `dvProject.subscribe(projectId)`，每次变化写一帧 `event:`/`data:`，直到请求关闭。`toWireState` 原样发送 `ProjectState` 及其 `components`，再加上各分支头、分支和素材列表：已创建的素材、每条记录的输出和已解析输入、每个角色、场景和风格版本的参考图，以及每个时间线片段的并集。

| 文件 | 内容 |
| --- | --- |
| [`src/wire.ts`](src/wire.ts) | `WireState`、`WireHistory`、`WireOperation`、`toWireState`、`toWireOperation`、`mentionedAssets`、`projectIdOf` |
| [`src/api.ts`](src/api.ts) | `ApiHandlers`、`ApiRequestError`、`OperationRequest`、`WireProject`：每条路由背后的校验和 `dvProject` 调用；所有路由共用的 `answer`、`json` 和 `requireProject` |
| [`src/asset-import.ts`](src/asset-import.ts) | 素材导入路由 |
| [`src/layout.ts`](src/layout.ts) | `CanvasLayoutStore` 和布局路由 |
| [`src/workspaces.ts`](src/workspaces.ts) | 项目 → Workspace 关联、对话绑定，以及项目的 DSH 会话 |
| [`src/projects-admin.ts`](src/projects-admin.ts) | 项目重命名和删除 |
| [`src/events.ts`](src/events.ts) | `frameOf` 和 `serveEventStream` |
| [`src/index.ts`](src/index.ts) | `DvApi`、`Config`、`ROUTES`、`EVENTS_PATH` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 各包](../../../docs/subsystems/video-harness.zh.md) — 记录、分支、过期标记，以及每个视图遵守的规则。
- [`@dv/project`](../project/README.zh.md) — 路由背后的记录、分支、撤销和过期标记，以及把用户记录告诉模型的项目摘要。
- [`@dv/ui-canvas`](../ui-canvas/README.zh.md) 与 [`@dv/ui-timeline`](../ui-timeline/README.zh.md) — 其中两个浏览器消费者。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过路由把视图手势记成用户记录；`@dv/project` 决定模型从中了解什么。

#### KV Cache 影响

无；路由不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **整份状态读取** — 每次变化视图都重新拉取完整状态；没有增量状态路由。
- **缺少 `connection` 时事件流不认证** — 此时路由放行所有请求；profile 应挂载 `dsh-web-app`。
