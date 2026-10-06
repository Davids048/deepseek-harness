---
description: "DreamVerse 画布：把项目的记录画成设定、素材、分镜计划和版本节点，按素材流向连线；浮动编辑器把新渲染的版本或更换的参考图写成用户记录。"
kind: "package-reference"
---

# @dv/ui-canvas

[English](README.md) | 中文

## 概述

使用本包让 web 应用在对话旁边多一个 DreamVerse 项目的画布。`CanvasView` 在可平移、可缩放的画布上把所示分支的记录画成节点，节点之间按流过的素材连线；画布旁对话打开的草稿以虚线节点叠加显示，过期记录有标记。点一个节点打开浮动编辑器，可以渲染新版本、更换参考图，或预填对话输入框。shell 把 `CanvasView` 放在中间区域；右侧栏的 `dv-canvas` 标签类型在分支栏下显示同一个画布。

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

画布把角色、场景和风格画成 `bible` 节点，导入的图片和视频画成 `asset` 节点，分镜计划画成 `plan` 节点，每条 `shot.render` 记录画成 `take` 节点。顶部的当前分支栏说明画布的修改写入哪个分支，并接受或丢弃草稿。

```yaml
- id: dv-ui-canvas
  name: '@dv/ui-canvas'
```

Host 半边不注册任何东西。浏览器半边注册 `dv-canvas` 标签类型（侧栏指南页以"视频画布"提供的页面）、中英文的 `dvCanvas` locale 命名空间，以及以自身 id `@dv/ui-canvas` 为键的标签主体。

| 手势 | 请求 |
| --- | --- |
| 改一个版本的提示词、参考图、时长或种子并按"渲染新版本" | `POST /api/dv/operation`，`shot.render` 加改过的输入和参数，`based_on` 指向所示版本，`surface: 'canvas'` |
| 更换角色、场景或风格的参考图 | `POST /api/dv/operation`，`bible.<kind>_update`，图片作为输入角色 `reference`；导入的文件先运行 `asset.import` |
| 把图片或视频文件拖到画布上 | `POST /api/dv/assets/import`；新节点放在指针下 |
| 让智能体改 | `dv:compose` 窗口事件，用指向该节点的 `@` 引用预填对话输入框 |
| 接受或丢弃草稿 | 对该对话的草稿调用 `POST /api/dv/drafts/accept` 或 `/api/dv/drafts/discard`；丢弃前先在 `@dv/ui-kit/DiscardDraftDialog.tsx` 的确认对话框里确认 |
| 在过期节点的编辑器里点"仍然保留" | 对节点的记录调用 `POST /api/dv/stale/accept`（在当前分支上运行 `proj.stale_accept`） |
| 点一个节点 | `POST /api/dv/selection`，kind 为 `record`、`character`、`location` 或 `style`，让宿主能告诉智能体用户指向了什么 |
| 拖动节点、平移或缩放 | `POST /api/dv/layout`，带以节点 ID 为键的移动位置和视口 |

显示 `draft/*` 分支时编辑器的写入按钮禁用；接受或丢弃草稿，或切到别的分支，才能写入。带 `{recordId}` 的 `dv:canvas-focus` 窗口事件把该记录的节点移到中央并打开。记录没有自己的节点时，该事件打开它写下的设定版本的节点，否则打开它第一个产出的节点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`CanvasView` 用 `@dv/ui-kit/useProject.ts` 的 `useProjectState` 读分支状态，旁边会话有打开的草稿时也读草稿的状态。`overlayDraft` 把草稿的记录、素材和设定版本并入基础状态，`buildCanvasGraph` 把合并后的状态变成节点、边和默认的分列布局：先设定和素材，再分镜计划，版本按首帧链深度排列，重拍挨着它的源版本。设定节点的 ID 是 `bible:<id>`；其他节点的 ID 是它的记录 ID。`/api/dv/layout` 中存下的位置覆盖默认布局；布局读写失败时忽略。请求的输入是引用文本（`<asset>`、`<record>#<output>`、`<id>@<version>`），由 `referenceText` 从记录存储的输入引用写出。每收到一帧 `/dv/events` 状态就重新拉取。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | 注册 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/CanvasBody.tsx`](src/client/CanvasBody.tsx) | 标签主体：分支栏下的 `CanvasView` |
| [`src/client/CanvasView.tsx`](src/client/CanvasView.tsx) | 画布：平移、缩放、拖动、拖放、布局存储、当前分支栏 |
| [`src/client/graph.ts`](src/client/graph.ts) | 节点、边、草稿叠加和默认布局 |
| [`src/client/NodeCard.tsx`](src/client/NodeCard.tsx)、[`src/client/NodeEditor.tsx`](src/client/NodeEditor.tsx) | 节点卡片和浮动编辑器 |
| [`src/client/locales.ts`](src/client/locales.ts) | `dvCanvas` 词典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/api`](../api/README.zh.md) — 每个手势背后的路由。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — API 客户端、wire 类型和 hook。
- [DreamVerse 各包](../../../docs/subsystems/video-harness.zh.md) — 画布所显示的草稿、过期、版本和分支。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过浏览器侧的画布；其手势写下的记录只经由智能体集成（`@dv/agent-integration`）到达模型。

#### KV Cache 影响

无；画布不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **画布上不能新建节点** — 编辑器只为已有记录渲染新版本和更换参考图；新建分镜计划或角色留给对话。
- **整图重建** — 每个项目事件都重新拉取状态并重建图；长项目重画慢。
