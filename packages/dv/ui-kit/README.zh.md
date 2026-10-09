---
description: "DreamVerse 各视图共用的浏览器代码：/api/dv 客户端、wire 类型、参数表单模型、轨道几何、窗口事件、视图会话 hook 和项目栏。"
kind: "package-reference"
---

# @dv/ui-kit

[English](README.md) | 中文

## 概述

在 DreamVerse 的浏览器插件里使用本包与 `@dv/api` 通信，并读取它发来的状态。`DvClient` 封装每条 `/api/dv` 路由并跟随 `/dv/events`；`fieldsOf` 和 `paramsOf` 把操作的参数 schema 变成表单字段再变回参数；`useViewSession` 让视图的项目、项目的当前状态和操作与宿主同步；`ProjectBar` 是侧栏视图的项目和撤销栏；事件模块拥有各面板之间交换的 `dv:*` 窗口事件和页面全局变量。本包是一个库：它不注册任何东西，会被打进每个消费者的 bundle。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把 `@dv/ui-kit` 加进浏览器插件的 `devDependencies`，按模块逐个导入；包的 `./*` 导出映射到 `src/client/*`，DSH 客户端 bundle 会内联导入的内容。没有 Loader 行。

```ts
import { DvClient } from '@dv/ui-kit/api.ts'
import { useViewSession } from '@dv/ui-kit/useView.ts'
import { DV_TIMELINE_INSERT_EVENT } from '@dv/ui-kit/workspace-events.ts'
```

| 模块 | 内容 |
| --- | --- |
| `types.ts` | `WireState`（`head` 是当前位置，`tip` 是历史列表的最后一步）、`WireLine`（`{tip, at}`，撤销和重做的回答）、`ProjectRecord`、`Asset`、`ProjectAsset`（带本项目导入名字和时间以及 `made_by` 的素材）、`Timeline`、`Clip`、`WireOperation`、`WireProject`、`WireProjectSummary` 和 `WireProjectCover`（项目卡片的封面、镜头数、时长和最后编辑时间）、`ProjectEvent`、`OperationRequest`、`HistoryQuery`、`HistoryEntry`（`{record, place}`）、`WireHistory`、`PlanVersion`、`Shot`（带生成方式 `mode`，即 `ref2va` 或 `t2va`，以及 `continue_previous`）：`@dv/api` 收发的 JSON 的结构类型 |
| `api.ts` | `DvClient`（`listProjects`、`listProjectSummaries`（`GET /api/dv/projects/summary`）、`getState`（读当前状态）、`listOperations`、`runOperation`、`importAsset`、`undo`（往回移一步）、`moveTo`（移到历史列表中的某一步）、`redo`（往前移一步）、`acceptStale`、`listHistory`、`placeOnCanvas`（在画布来源上执行 `asset.place` 或 `asset.unplace`），项目、布局（位置和视口）、工作区和对话调用，`subscribe`）、`ViewSurface`、`DvApiError`、`assetUrl` |
| `form.ts` | `fieldsOf(params, values)`、`paramsOf(fields)`、`FieldParseError`：每个 schema 属性一个控件，带类型转换 |
| `timeline.ts` | `FALLBACK_CLIP_SECONDS`、`timelineName(timeline, numbered)`、`formatSeconds` |
| `references.ts` | `shotReferences(version, shot)`、`referenceImages(state, references)`、`pictureParts(prompt)`：一个镜头发给视频模型的参考图，按提示词里 `Picture 1`、`Picture 2`…… 的编号顺序排列，以及在这些标记处切开的提示词；`t2va` 镜头没有参考图 |
| `state.ts` | `assetIndex`、`videoAssets` |
| `useProject.ts` | `useProjects`、`useOperations`、`useProjectState`：每次项目事件都重新拉取的加载器 |
| `useView.ts` | `useViewSession(client, surface, session?)`：项目选择、项目的当前状态、操作、最近一次失败和项目栏回调；`sessionFromLocation` 从页面地址的 `?session=` 读对话，让视图打开该对话的项目 |
| `ProjectBar.tsx` | 侧栏的栏（测试 ID `dv-kit-project-bar`）：项目选择器、新建项目按钮和撤销，用 `--dv-*` 主题变量画成 28 px 的次要控件；文案以 `labels` 传入，由所属插件先本地化 |
| `compose.ts`、`workspace-events.ts` | 窗口事件 `dv:compose`、`dv:timeline-insert`、`dv:canvas-focus`、`dv:history-focus`、`dv:trajectory-focus`、`dv:timeline-focus`（`DV_*_EVENT`）和素材拖拽类型 `application/x-dv-asset` |
| `tool-labels.ts` | `DV_TOOL_LABELS`：每个 `dv_*` 工具的中英文标签，由输入框的工具卡片和历史面板显示 |
| `current-project.ts`、`current-timeline.ts` | 打开的项目和选中的时间线，存在 `window.__dvCurrentProject` 和 `window.__dvCurrentTimeline` 上，用 `dv:current-project` 和 `dv:current-timeline` 通知 |
| `zoom.ts` | `useZoomPresence(value, openerOf, onOpened?)`：弹窗（对话视频播放器、画布节点编辑器、素材库预览）的缩放过渡。弹窗用 300 ms 从打开它的元素放大出来，关闭时用 250 ms 缩回该元素，背景同时淡入淡出；无论用哪种方式关闭，弹窗都等缩回结束才移除。打开它的元素已不存在或在屏幕外时，弹窗改为轻微缩放加淡出；开启 `prefers-reduced-motion` 时只淡入淡出。弹窗还在放大时被关闭，会从屏幕上的当前状态开始缩回。`mediaBox(width, height, maxWidth, maxHeight)` 在已知尺寸的图片或视频加载前就定好它的大小，这样由媒体决定大小的弹窗在过渡测量时已是最终尺寸 |
| `locale.ts` | `useText`、`pickText`：按 `<html lang>` 取一对中英文字符串中的一个 |

`subscribe` 在浏览器有 `EventSource` 时用它，否则每三秒轮询一次。跟随项目的每个 bundle 通过 `window.__dvEventSources` 为每个项目共享一条流；`window.__dvStreams` 记录打开的流数。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`DvClient` 把每个错误响应体解码成 `DvApiError`，保留 HTTP 状态和 `ProjectError` 代码；`listProjectSummaries` 还检查摘要每个字段的类型，响应格式不对时抛出 `Error`。`useLoader` 在重新加载期间保留上一个值，并忽略输入已变化的响应；`useProjectState` 读取项目的当前状态，并把一阵项目事件合成一次重新拉取，所以任何地方的撤销或重做都会刷新每个视图。`types.ts` 里的类型手工照抄 `@dv/project` 和各组件的类型，因为宿主包不能被导入进浏览器 bundle；记录以 `ProjectRecord` 到达，输入的 `ref` 是存储时的对象。

| 文件 | 内容 |
| --- | --- |
| [`src/client/api.ts`](src/client/api.ts) | 客户端和共享的事件流 |
| [`src/client/form.ts`](src/client/form.ts) | 表单模型 |
| [`src/client/timeline.ts`](src/client/timeline.ts) | 时间线辅助函数 |
| [`src/client/references.ts`](src/client/references.ts) | 镜头参考图和 `Picture N` 标记 |
| [`src/client/zoom.ts`](src/client/zoom.ts) | 弹窗的缩放过渡 |
| [`src/client/useProject.ts`](src/client/useProject.ts)、[`src/client/useView.ts`](src/client/useView.ts) | hook |
| [`src/client/ProjectBar.tsx`](src/client/ProjectBar.tsx) | 共用的栏 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/api`](../api/README.zh.md) — 这个客户端读取的路由和 JSON。
- [`@dv/ui-canvas`](../ui-canvas/README.zh.md) 与 [`@dv/ui-timeline`](../ui-timeline/README.zh.md) — 使用这些 hook 和项目栏的两个视图。
- [DreamVerse 各包](../../../docs/subsystems/video-harness.zh.md) — 记录、历史规则和过期标记的含义。

-----

<a id="model-experience"></a>
## 模型体验

无；浏览器侧的客户端、表单和轨道辅助代码，不触碰任何提示词、schema 或工具结果。

#### KV Cache 影响

无；本包不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **手工复制的 wire 类型** — `types.ts` 照抄宿主的类型；宿主侧新增字段要手工加到这里。
- **扁平表单** — 表单模型把嵌套对象和数组渲染成一个 JSON 文本框。
- **轮询回退** — 没有 `EventSource` 时视图每三秒轮询一次，无法知道变了什么。
