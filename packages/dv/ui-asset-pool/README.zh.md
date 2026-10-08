---
description: "DreamVerse 素材库面板：在右侧栏标签里列出项目的图片和视频，可导入、拖入画布或时间线、预览。"
kind: "package-reference"
---

# @dv/ui-asset-pool

[English](README.md) | 中文

## 概述

使用本包让 web 应用在对话旁边多一个 素材库 面板。`AssetsPanel` 把所打开项目当前分支在 head 之前的每个图片和视频列出一次，分为图片、视频和从生成中截取的帧；它的开关 显示其他分支的素材 会加上只有其他分支或当前分支的重做步骤才有的素材，每个素材都标出它的分支。你可以把图片和视频拖到面板上导入，把缩略图拖进画布或时间线，并打开预览，把视频插入为片段或让智能体使用该素材。右侧栏的 `dv-asset-pool` 标签类型显示 shell 所打开项目的面板。

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
| 打开面板、项目的任何变化 | 对项目的当前分支调用 `GET /api/dv/state`，每个 `/dv/events` 事件都重新拉取 |
| 显示其他分支的素材（打开后按钮文字变为 隐藏其他分支的素材） | `POST /api/dv/history`，带 `marks: ['redo', 'branch']` 和 `limit: 200`；开关打开期间，状态每次重新加载都重新拉取 |
| 把图片或视频拖到拖放区，或点击它选择文件 | 每个图片或视频文件一次 `POST /api/dv/assets/import`，带 `surface=asset_pool` 和标签所在的对话；`asset.import` 记录写到项目的当前分支。拖放区不导入其他文件，对每个这样的文件显示 「<name>」不是图片或视频，没有导入。 |
| 拖动缩略图 | 以 `application/x-dv-asset` 携带素材 ID 的拖动；画布把素材的节点移到放下的位置，时间线在放下的位置插入片段 |
| 视频预览里的 插入片段 | `dv:timeline-insert` `{assetId}`；shell 把片段追加到编辑器里选中的时间线（没有时用第一条时间线，再没有时新建时间线 `t1`），并显示时间线 |
| 预览里的 让智能体使用 | `dv:compose`，文字为 使用这个素材：，素材作为 `@` 引用；输入框填入草稿，不发送任何内容 |

缩略图和预览从 `GET /dv/assets/<AssetId>` 加载素材文件。

面板把当前分支的状态在 `assets` 里列出的每个图片和视频（导入的文件、渲染结果及其静帧、导出，以及角色、场景和风格的参考图）列出一次，分为三组，每组最新在前：图片（`image/*`）、视频（`video/*`）和 从生成中截取的帧（`shot.render_ref2va` 或 `shot.render_t2va` 记录产出的图片，例如版本的末帧静帧）。其他媒体类型的素材不列出。角色、场景或风格用到的图片仍列在 图片 一组，`asset.grab_still` 的静帧也列在 图片 一组。没有素材的组不显示，没有素材的项目显示 暂无。开关打开时，面板还把其他分支和当前分支重做步骤的记录产出、而当前分支没有列出的图片和视频列在同样的组里；每个素材带一个徽标，显示其分支的标签（分支的标题，否则为 主线 或 分支 n），拖动、插入和预览都和其他素材一样，所以插入它会在当前分支上写一条普通的 `timeline.clip_insert` 记录。预览显示尺寸、时长和文件大小，带操作 插入片段（仅视频）、让智能体使用 和 关闭。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`otherBranchAssets` 读取开关拉取的历史条目：当前状态没有列出的产出，如果条目的 `branches` 包含当前分支（重做步骤），就属于当前分支，否则属于 `branches` 中的第一个分支；不在任何分支线上的条目不加任何素材。`assetLibrary` 把这些素材合并进当前分支的素材，每个素材只出现一次，并把图片和视频分组；镜头渲染记录产出的图片归入 `extracted`。导入的素材显示本项目状态为 `done` 的 `asset.import` 记录的名字和时间，因为素材库保存的是任意项目中相同字节第一次导入时的名字和时间；只有加入了当前状态之外素材的记录才能给它命名。历史拉取失败时不显示其他分支的素材。素材没有宽高时（导入的文件），预览从加载的媒体读取宽高；预览渲染在 `document.body` 上，所以右侧栏不会盖住它的按钮；按 Escape 或点击外面关闭。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Host 半边，不注册任何东西 |
| [`src/client/index.ts`](src/client/index.ts) | 标签类型和标签主体的注册 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/AssetsPanel.tsx`](src/client/AssetsPanel.tsx) | 面板、拖放区、按组分的缩略图网格、预览和标签主体 |
| [`src/client/library.ts`](src/client/library.ts) | 把当前分支和其他分支的素材按媒体类型分组、单列渲染静帧，并标出其他分支素材所属的分支 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/api`](../api/README.zh.md) — 状态路由、历史路由和素材导入路由。
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

- **其他分支的素材只来自最新的 200 条** — 开关最多读取 200 条标记为 `redo` 或 `branch` 的历史条目，所以其他分支历史更长的项目只列出最新那些条目的素材。
- **项目每次变化都拉取一次历史** — 开关打开期间，项目的每次变化除了重新拉取状态，还会重新拉取历史条目。
