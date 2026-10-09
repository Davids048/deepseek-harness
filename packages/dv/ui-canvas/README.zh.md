---
description: "DreamVerse 画布：把项目的记录画成设定、素材、分镜计划和版本节点，按素材流向连线；浮动编辑器把新渲染的版本或更换的参考图写成用户记录。"
kind: "package-reference"
---

# @dv/ui-canvas

[English](README.md) | 中文

## 概述

使用本包让 web 应用在对话旁边多一个 DreamVerse 项目的画布。`CanvasView` 在可平移、可缩放的画布上把项目当前状态的记录画成节点，节点之间按流过的素材连线，过期记录有标记。点一个节点打开浮动编辑器，可以渲染新版本、更换参考图，或预填对话输入框。shell 把 `CanvasView` 放在中间区域；右侧栏的 `dv-canvas` 标签类型在项目栏下显示同一个画布。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在叠了 `dsh-web-app`（提供右侧栏、locale 服务和客户端模块加载器）和 `@dv/api`（提供画布调用的路由）的 profile 里挂载插件。先构建浏览器 bundle：`pnpm run build` 会写出 `lib/client.js`。

画布只显示项目的当前状态，不显示历史：角色、场景和风格以当前版本画成 `bible` 节点，位于画布上的导入图片和视频画成 `asset` 节点，每个分镜计划以最新版本画成 `plan` 节点，`shot.render_ref2va` 和 `shot.render_t2va` 记录画成 `take` 节点。画出的版本是：每个分镜计划最新版本中每个镜头的当前版本（计划时间线上该镜头的片段所播放的版本，否则是该镜头该计划版本中最新完成的版本，或批准时沿用的较早版本）及其重拍；不属于分镜计划的版本；输出仍在使用中的版本（被时间线片段播放、被当前设定或分镜计划版本用作参考图、或被已画出的版本用作输入）。被删掉的镜头的版本和较早计划版本中未被使用的版本不显示，所以撤销或回到之前某一步会改变画布显示的内容。图片或视频只在其素材 ID 位于画布上（`asset` 切片的 `placed`）时才有一个 `asset` 节点；已由 `bible` 节点（角色、场景或风格的参考图）或 `take` 节点（版本的产出）显示的除外。读取画布外素材的版本没有来自该素材的边，它的编辑器仍列出该参考图。用户把文件或素材库缩略图拖到画布上，或在对话消息里以附加图片或 `dv:asset/<id>` 标签发出某个素材（由 `@dv/chat-references` 放置）时，该素材放到画布上；`asset` 节点编辑器里的"从画布移除"把它移出画布，素材仍留在素材库里。这些都是历史中的步骤，所以历史会列出它们，撤销能退回它们。`bible` 卡片显示类别、名称，以及当前版本的参考图组成的一排小缩略图（最多四张，其余显示为"+N"），所以角色、场景或风格与图片看起来不同；这些参考图从不单独画成 `asset` 节点。当前状态改变时画布跟着改变，画布的修改立即成为历史中的步骤。

```yaml
- id: dv-ui-canvas
  name: '@dv/ui-canvas'
```

Host 半边不注册任何东西。浏览器半边注册 `dv-canvas` 标签类型（侧栏指南页以"视频画布"提供的页面）、中英文的 `dvCanvas` locale 命名空间，以及以自身 id `@dv/ui-canvas` 为键的标签主体。

| 手势 | 请求 |
| --- | --- |
| 改一个版本的提示词、参考图、时长或种子并按"渲染新版本" | `POST /api/dv/operation`，该版本自己的操作（`shot.render_ref2va` 或 `shot.render_t2va`）加改过的输入和参数，`based_on` 指向所示版本，`surface: 'canvas'` |
| 更换角色、场景或风格的参考图 | `POST /api/dv/operation`，`bible.<kind>_update`，图片作为输入角色 `reference`；导入的文件先运行 `asset.import` |
| 把图片或视频文件拖到画布上 | 带 `surface=canvas` 的 `POST /api/dv/assets/import`，其 `asset.import` 同时把素材放到画布上；新节点放在指针下 |
| 把素材库缩略图拖到画布上 | 素材已有节点时，把该节点移到指针下；素材库面板中的其他图片或视频则由 `POST /api/dv/operation` 执行 `asset.place`，该素材作为输入角色 `asset`，新节点放在指针下 |
| 在 `asset` 节点编辑器里点"从画布移除" | `POST /api/dv/operation` 执行 `asset.unplace`，该素材作为输入角色 `asset`；素材仍留在素材库里 |
| 让智能体改 | `dv:compose` 窗口事件，用指向该节点的 `@` 引用预填对话输入框 |
| 在过期节点的编辑器里点"仍然保留" | 对节点的记录调用 `POST /api/dv/stale/accept`（作为历史中的一步运行 `proj.stale_accept`） |
| 拖动节点、平移或缩放 | `POST /api/dv/layout`，带以节点 ID 为键的移动位置和视口 |

每个请求都带 `surface: 'canvas'` 和画布旁边的对话，记录把该对话存为它的 `session`。带 `{recordId}` 的 `dv:canvas-focus` 窗口事件把该记录的节点移到中央并打开。记录没有自己的节点时，该事件打开它写下的设定版本的节点，否则打开它第一个产出的节点。

版本的编辑器显示它的生成方式，"参考图生成"（`ref2va`）或"文字生成"（`t2va`）；`t2va` 版本没有参考图标签。分镜计划节点的编辑器在计划的各版本之间切换。版本批准后显示"已批准"，是最新且未批准的版本时显示"待批准"，在批准前被后来的版本取代时显示"已被 v{n} 取代"。每个镜头显示它的生成方式，设置了 `continue_previous` 时后接"接上一镜头"。`ref2va` 镜头显示它渲染所用的参考图，顺序与视频模型的编号一致，提示词里的每个 `Picture N` 标记显示为其中第 N 张图（`@dv/ui-kit/references.ts`）；`t2va` 镜头不显示参考图。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`CanvasView` 用 `@dv/ui-kit/useProject.ts` 的 `useProjectState` 读项目的当前状态；`buildCanvasGraph` 把它变成节点、边和默认的分列布局：先设定和素材，再分镜计划，版本按首帧链深度排列，重拍挨着它的源版本。设定节点的 ID 是 `bible:<id>`；`asset` 节点的 ID 是当前状态中产出该素材的 `asset.import` 记录，否则为没有记录的 `asset:<AssetId>`（撤销退过的导入、静帧、导出）；其他节点的 ID 是它的记录 ID。`/api/dv/layout` 中存下的位置覆盖默认布局；布局读写失败时忽略。请求的输入是引用文本（`<asset>`、`<record>#<output>`、`<id>@<version>`），由 `referenceText` 从记录存储的输入引用写出。每收到一帧 `/dv/events`，状态就重新拉取，所以对话消息放上的素材不用刷新就会出现；本视图发出的摆放立即显示，直到状态显示它为止，被拒绝的摆放会恢复原样。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | 注册 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/CanvasBody.tsx`](src/client/CanvasBody.tsx) | 标签主体：项目栏下的 `CanvasView` |
| [`src/client/CanvasView.tsx`](src/client/CanvasView.tsx) | 画布：平移、缩放、拖动、拖放、布局存储 |
| [`src/client/graph.ts`](src/client/graph.ts) | 节点、边和默认布局 |
| [`src/client/NodeCard.tsx`](src/client/NodeCard.tsx)、[`src/client/NodeEditor.tsx`](src/client/NodeEditor.tsx) | 节点卡片和浮动编辑器 |
| [`src/client/locales.ts`](src/client/locales.ts) | `dvCanvas` 词典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/api`](../api/README.zh.md) — 每个手势背后的路由。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — API 客户端、wire 类型和 hook。
- [DreamVerse 各包](../../../docs/subsystems/video-harness.zh.md) — 画布所显示的过期、版本和历史规则。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dv/project`；其手势写下的记录只经由 [`@dv/project`](../project/README.zh.md) 的 `dv:project` 提示词段落以及 `dv_proj_*` 和操作工具到达模型。

#### KV Cache 影响

无；画布不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **画布上不能新建节点** — 编辑器只为已有记录渲染新版本和更换参考图；新建分镜计划或角色留给对话。
- **整图重建** — 每个项目事件都重新拉取状态并重建图；长项目重画慢。
