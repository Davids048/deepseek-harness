---
description: "视频 harness 各视图共用的浏览器代码：/api/vh 客户端、折叠状态类型、操作 DAG 布局、参数表单模型、轨道几何、视图会话 hook 和分支栏。"
kind: "package-reference"
---

# @video-harness/ui-kit

[English](README.md) | 中文

## 概述

在视频 harness 的视图插件里使用本包与 `@video-harness/views` 通信，并把它的折叠状态变成可以画的东西。`VhClient` 封装 `/api/vh` 路由并跟随 `/vh/events`；`buildDag` 和 `layoutDag` 把记录变成分层的图；`fieldsOf` 和 `paramsOf` 把工具的参数 schema 变成表单字段再变回参数；`placeClips` 给时间线的片段定尺寸；`useViewSession` 让视图的项目、head、状态和工具与宿主同步；`BranchBar` 是两个视图都显示的项目、分支、草稿和撤销栏。本包是一个库：它不注册任何东西，会被打进每个消费者的 bundle。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把 `@video-harness/ui-kit` 加进浏览器插件的 `devDependencies`，按模块逐个导入；包的 `./*` 导出映射到 `src/client/*`，DSH 客户端 bundle 会内联导入的内容。没有 Loader 行。

```ts
import { VhClient } from '@video-harness/ui-kit/api.ts'
import { useViewSession } from '@video-harness/ui-kit/useView.ts'
import { buildDag, layoutDag } from '@video-harness/ui-kit/dag.ts'
```

| 模块 | 内容 |
| --- | --- |
| `types.ts` | `WireState`、`WireOp`、`WireAsset`、`WireToolSpec`、`WireProject`、`WireLogEvent`：`@video-harness/views` 发出的 JSON 的结构类型 |
| `api.ts` | `VhClient`（`projects`、`state`、`tools`、`invoke`、`turn`、`undo`、`branch`、`select`、`subscribe`）、`VhApiError`、`assetUrl` |
| `dag.ts` | `buildDag(state, expandedPlans)` 和 `layoutDag(dag)`：记录为节点，素材流向为边，计划折叠，按最长路径分层 |
| `form.ts` | `fieldsOf(params, values)`、`paramsOf(fields)`、`FieldParseError`：每个 schema 属性一个控件，带类型转换 |
| `timeline.ts` | `placeClips(state, pxPerSec)`、`clipSeconds`、`formatSeconds` |
| `state.ts` | `openDrafts`、`branchNames`、`assetIndex`、`videoAssets` |
| `useProject.ts` | `useProjects`、`useTools`、`useProjectState`：每次日志事件都重新拉取的加载器 |
| `useView.ts` | `useViewSession(client, surface, session?)`：项目与 head 选择、折叠状态、工具、最近一次失败，以及分支栏回调；`sessionFromLocation` 从页面地址的 `?session=` 读聊天会话，让视图打开该会话的项目 |
| `BranchBar.tsx` | 分支栏：项目和分支选择器、新建项目和新建分支按钮、撤销，以及每个打开草稿一枚接受/拒绝标签；文案以 `labels` 传入，由所属插件先本地化 |

`subscribe` 在浏览器有 `EventSource` 时用它，否则每三秒轮询一次。图的节点是一条记录、一个实体的当前版本或一个计划；`plan.create` 和 `plan.update` 记录在计划展开前隐藏其批准所调度的记录，`intent`、`branch`、`approve`、`reject` 记录和 `plan.approve` 调用从不绘制。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`buildDag` 先找出每个计划的子记录（批准该计划的那些 turn 里除批准本身以外的记录），计划未展开时隐藏它们；然后为每个实体（最新版本）和每条可见记录各加一个节点，为每个输入加一条边：`entity@version` 引用从实体节点出发，素材从生产它的记录出发（先在可见记录里找，再查折叠的 `producers`，生产者被隐藏时改指向计划），展开的计划指向每个子记录。`layoutDag` 给每个节点分配比进入它的最长边链多一的层，带环保护，同一层的节点按输入顺序堆叠。`useLoader` 在重新加载期间保留上一个值，并忽略输入已变化的响应；`useProjectState` 把一阵日志事件合成一次重新拉取。`types.ts` 里的类型手工照抄 `@video-harness/views` 的 wire 模块，因为宿主包不能被导入进浏览器 bundle。

| 文件 | 内容 |
| --- | --- |
| [`src/client/dag.ts`](src/client/dag.ts) | 图和它的布局 |
| [`src/client/form.ts`](src/client/form.ts) | 表单模型 |
| [`src/client/timeline.ts`](src/client/timeline.ts) | 轨道几何 |
| [`src/client/useProject.ts`](src/client/useProject.ts)、[`src/client/useView.ts`](src/client/useView.ts) | hook |
| [`src/client/BranchBar.tsx`](src/client/BranchBar.tsx) | 共用的栏 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@video-harness/views`](../views/README.zh.md) — 这个客户端读取的路由和 JSON。
- [`@video-harness/ui-canvas`](../ui-canvas/README.zh.md) 与 [`@video-harness/ui-timeline`](../ui-timeline/README.zh.md) — 两个消费者。
- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md) — 记录、草稿和过期标记的含义。

-----

<a id="model-experience"></a>
## 模型体验

无；浏览器侧的图、表单和轨道辅助代码，不触碰任何提示词、schema 或工具结果。

#### KV Cache 影响

无；本包不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **手工复制的 wire 类型** — `types.ts` 照抄宿主的 wire 模块；宿主侧新增字段要手工加到这里。
- **扁平表单** — 表单模型把嵌套对象和数组渲染成一个 JSON 文本框。
- **简单分层** — 同层节点保持输入顺序；长边可能交叉，没有边路由。
- **轮询回退** — 没有 `EventSource` 时视图每三秒轮询一次，无法知道变了什么。
