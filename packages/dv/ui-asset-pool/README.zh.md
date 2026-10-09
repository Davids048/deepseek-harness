---
description: "DreamVerse 素材库面板：在右侧栏标签里列出项目的图片和视频，可导入、拖入画布或时间线、预览。"
kind: "package-reference"
---

# @dv/ui-asset-pool

[English](README.md) | 中文

## 概述

使用本包让 web 应用在对话旁边多一个 素材库 面板。`AssetsPanel` 把所打开项目的每个图片和视频列出一次，分为图片、视频和从生成中截取的帧：当前状态中的每个素材，加上项目的任何记录导入的每个素材，包括被丢弃的记录，所以撤销会隐藏当前位置之后的步骤生成的素材，但从不隐藏导入的素材。你可以把图片和视频拖到面板上导入，把缩略图拖进画布或时间线，并打开预览，把视频插入为片段或让智能体使用该素材。右侧栏的 `dv-asset-pool` 标签类型显示 shell 所打开项目的面板。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在叠了 `dsh-web-app`（提供右侧栏和客户端模块加载器）和 `@dv/api`（提供面板调用的路由）的 profile 里挂载插件。先构建浏览器 bundle：`pnpm run build` 会写出 `lib/client.js`。

```yaml
- id: dv-ui-asset-pool
  name: '@dv/ui-asset-pool'
```

Host 半边不注册任何东西。浏览器半边注册 `dv-asset-pool` 标签类型（侧栏指南页以"素材库"提供的页面）和以自身 id `@dv/ui-asset-pool` 为键的标签主体。其他标签在前面时，该标签保持挂载。

| 手势 | 请求或事件 |
| --- | --- |
| 打开面板、项目的任何变化 | 对项目的当前状态调用 `GET /api/dv/state`，每个 `/dv/events` 事件都重新拉取 |
| 把图片或视频拖到拖放区，或点击它选择文件 | 每个图片或视频文件一次 `POST /api/dv/assets/import`，带 `surface=asset_pool` 和标签所在的对话；`asset.import` 记录是项目当前位置之后的一步。拖放区不导入其他文件，对每个这样的文件显示 「<name>」不是图片或视频，没有导入。 |
| 拖动缩略图 | 以 `application/x-dv-asset` 携带素材 ID 的拖动；画布把素材的节点移到放下的位置，时间线在放下的位置插入片段 |
| 视频预览里的 插入片段 | `dv:timeline-insert` `{assetId}`；shell 把片段追加到编辑器里选中的时间线（没有时用第一条时间线，再没有时新建时间线 `t1`），并显示时间线 |
| 预览里的 让智能体使用 | `dv:compose`，文字为 使用这个素材：，素材作为 `@` 引用；输入框填入草稿，不发送任何内容 |

缩略图和预览从 `GET /dv/assets/<AssetId>` 加载素材文件。

面板把状态在 `assets` 里列出的每个图片和视频（当前状态中的每个素材，加上项目的任何记录导入的每个素材，包括被丢弃的记录；见[历史规则](../../../docs/subsystems/video-harness.zh.md#history-rules)）列出一次，分为三组，每组最新在前：图片（`image/*`）、视频（`video/*`）和 从生成中截取的帧（`made_by` 为 `shot.render_ref2va` 或 `shot.render_t2va` 的图片，例如版本的末帧静帧）。其他媒体类型的素材不列出。角色、场景或风格用到的图片仍列在 图片 一组，`asset.grab_still` 的静帧也列在 图片 一组。没有素材的组不显示，没有素材的项目显示 暂无。被撤销移出当前状态的导入素材，拖动、插入和预览都和其他素材一样，所以插入它会写一条普通的 `timeline.clip_insert` 记录，作为当前位置之后的一步。预览显示尺寸、时长和文件大小，带操作 插入片段（仅视频）、让智能体使用 和 关闭。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`assetLibrary` 把状态中的素材分为图片和视频，每个素材只出现一次；`made_by` 为镜头渲染操作的图片归入 `extracted`。状态已经带上每个素材在本项目中的导入名字和时间（`ProjectAsset`），因为素材库保存的是任意项目中相同字节第一次导入时的名字和时间。素材库在导入时没能读出宽高时，预览从加载的媒体读取宽高；预览渲染在 `document.body` 上，所以右侧栏不会盖住它的按钮；按 Escape 或点击外面关闭。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Host 半边，不注册任何东西 |
| [`src/client/index.ts`](src/client/index.ts) | 标签类型和标签主体的注册 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/AssetsPanel.tsx`](src/client/AssetsPanel.tsx) | 面板、拖放区、按组分的缩略图网格、预览和标签主体 |
| [`src/client/library.ts`](src/client/library.ts) | 把项目的素材按媒体类型分组，并单列渲染静帧 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/api`](../api/README.zh.md) — 状态路由和素材导入路由。
- [`@dv/asset-pool`](../asset-pool/README.zh.md) — 保存并提供素材文件的素材库。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — API 客户端、wire 类型、窗口事件和 compose 事件。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dv/project`；素材库面板导入写下的 `asset.import` 记录只经由 [`@dv/project`](../project/README.zh.md) 的 `dv:project` 提示词段落以及 `dv_proj_*` 和操作工具到达模型。

#### KV Cache 影响

无；面板不向模型发送任何内容。让智能体使用 只填入输入框，由用户决定是否发送。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **项目每次变化都拉取整个状态** — 项目的每次变化都会重新拉取整个状态，包括素材列表；没有增量的素材路由。
