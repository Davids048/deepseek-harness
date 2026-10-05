---
description: "作为右侧栏标签的视频 harness 画布：把项目的操作记录按素材流向画成 DAG，参数表单可把任一记录改参数重跑或修改，写成新的用户记录。"
kind: "package-reference"
---

# @video-harness/ui-canvas

[English](README.md) | 中文

## 概述

使用本包让 web 应用在聊天旁边多一个视频项目的画布。右侧栏的 `vh-canvas` 标签类型把所示分支的记录画成从左到右的图：实体是源头，每次工具调用一个方框，计划折叠成一个方框，重拍挨着它的基准，agent 草稿用虚线，过期记录有标记。点一个方框显示它的事实和参数表单；"应用"把改过的参数写成替代原记录的记录，"重跑"写成一个新版本。顶部的栏切换项目和分支，接受或拒绝打开的草稿，撤销，开分支。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在叠了 `dsh-web-app`（提供右侧栏、locale 服务和客户端模块加载器）和 `@video-harness/views`（提供画布调用的路由）的 profile 里挂载插件。先构建浏览器 bundle：`pnpm run build` 会写出 `lib/client.js`。

```yaml
- id: vh-ui-canvas
  name: '@video-harness/ui-canvas'
```

Host 半边不注册任何东西。浏览器半边注册 `vh-canvas` 标签类型（侧栏指南页以"视频画布"提供的页面）、中英文的 `vhCanvas` locale 命名空间，以及以自身 id 为键的标签主体。从指南页打开标签；画布选最新的项目和 `main`。

| 手势 | 记录 |
| --- | --- |
| 改参数并按"应用" | 同一工具加改过的参数，`base_op` 和 `supersedes` 指向所示记录，`surface: 'canvas'` |
| 按"重跑" | 同一工具同一参数作为新版本：设 `base_op`，不替代任何记录 |
| 接受或拒绝草稿标签 | `/api/vh/turn`，快进 `main` 或把草稿留在日志里 |
| 撤销 | `/api/vh/undo`，把 `main` 退回一个 turn |
| 新建项目 | 用询问得到的标题 `POST /api/vh/projects`；画布随后显示新项目的 `main` |
| 新分支 | 在所示 head 上 `/api/vh/branch`；画布随后显示新分支 |
| 点一个节点 | `/api/vh/selection`，带记录或实体 id，让宿主能告诉 agent 用户指向了什么 |

显示 `draft/*` 分支时表单禁用；接受或拒绝草稿，或切到别的分支，才能写入。在探索分支上的手势写到那个分支。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`CanvasBody` 持有来自 `@video-harness/ui-kit/useView.ts` 的视图会话（项目、head、状态、工具、最近一次失败）、展开的计划集合和选中的节点 id。kit 的 `buildDag` 和 `layoutDag` 把状态变成带坐标的节点；`DagView` 用 SVG 画出它们，并以 data 属性标出状态、过期、草稿和被替代；`NodePanel` 显示选中节点，并用来自 `/api/vh/tools` 的工具声明挂载 `ParamForm`，以记录 id 为 key，这样换选择时字段会重新填充。一次写入是一次 `client.invoke` 调用加一次状态重新拉取；失败显示在图的上方。每收到一帧 `/vh/events` 状态就重新拉取。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | 注册 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/CanvasBody.tsx`](src/client/CanvasBody.tsx) | 主体：会话、图、面板、写入 |
| [`src/client/DagView.tsx`](src/client/DagView.tsx)、[`src/client/dag-style.ts`](src/client/dag-style.ts) | SVG 图和它的颜色 |
| [`src/client/NodePanel.tsx`](src/client/NodePanel.tsx)、[`src/client/ParamForm.tsx`](src/client/ParamForm.tsx) | 侧面板和表单 |
| [`src/client/locales.ts`](src/client/locales.ts) | `vhCanvas` 词典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@video-harness/views`](../views/README.zh.md) — 每个手势背后的路由。
- [`@video-harness/ui-kit`](../ui-kit/README.zh.md) — 图布局、表单模型和 hook。
- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md) — 画布所显示的草稿、过期、版本和分支。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过浏览器侧的画布；其手势写下的记录只经由 agent 层的项目提示词节到达模型。

#### KV Cache 影响

无；画布不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **画布上不能新建节点** — 表单只能修改或重跑已有记录；从零添加工具调用留给聊天。
- **整图重画** — 每次日志事件都重新拉取状态并重新布局；长项目重画慢。
- **没有平移和缩放** — 图在标签内滚动；没有缩放控件。
- **扁平参数表单** — 数组和对象以 JSON 文本编辑。
