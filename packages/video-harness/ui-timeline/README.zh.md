---
description: "作为右侧栏标签的视频 harness 时间线：项目的片段序列在一条轨道上，排序、设范围、裁剪、插入、移除手势变成序列和片段记录。"
kind: "package-reference"
---

# @video-harness/ui-timeline

[English](README.md) | 中文

## 概述

使用本包让 web 应用在聊天旁边多一个视频项目的时间线。右侧栏的 `vh-timeline` 标签类型把所示分支折叠出的序列画成一条轨道：每个片段的宽度就是它播放的时长，带生产它的镜头的最后一帧，生产者过期或仍是 agent 草稿时有标记。点一个片段可预览并使用手势：设它的入点和出点、左移或右移、把范围固化成一个替换它的新片段，或在它后面插入另一个素材。空时间线可以从任一视频素材开始。顶部的栏切换项目和分支，接受或拒绝打开的草稿，撤销，开分支。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在叠了 `dsh-web-app` 和 `@video-harness/views` 的 profile 里挂载插件，先用 `pnpm run build` 构建浏览器 bundle。

```yaml
- id: vh-ui-timeline
  name: '@video-harness/ui-timeline'
```

Host 半边不注册任何东西。浏览器半边注册 `vh-timeline` 标签类型（侧栏指南页以"视频时间线"提供）、中英文的 `vhTimeline` locale 命名空间，以及以自身 id 为键的标签主体。

| 手势 | 记录 |
| --- | --- |
| 设置范围 | `sequence.set_range {slot, inSec, outSec}`；空字段表示"从头开始"或"到结尾" |
| 前移或后移 | `sequence.move {from, to}` |
| 固化裁剪 | 先对片段素材用入点和出点做 `clip.trim`，再用新片段做 `sequence.replace {slot, asset}` |
| 插在这段后面 | `sequence.insert {at, asset}`，素材为所选视频 |
| 从时间线移除 | `sequence.remove {slot}`；随后选中它前面的片段 |
| 从这个素材新建时间线 | `sequence.create {assets: [asset]}` |
| 点一个片段 | `/api/vh/selection`，带素材 id 和槽位 |

每条记录都带 `surface: 'timeline'` 和一句用 DSH 界面语言说明手势的意图。剪辑视图（`CutsView`）通过 `@video-harness/ui-kit/locale.ts` 跟随 `<html lang>`；切换分集标签会停止播放，并把预览和播放头重置到新的一集。显示 `draft/*` 分支时手势禁用。轨道每秒画四十像素；素材没有时长时片段按五秒画。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`TimelineBody` 持有来自 `@video-harness/ui-kit/useView.ts` 的视图会话和选中的槽位。kit 的 `placeClips` 把状态里的序列变成带坐标的片段；`Track` 把它们画成绝对定位条带上的按钮；`ClipPanel` 以槽位和素材为 key，这样换选择时字段会重新填充，它持有入点和出点文本并调用主体的动作。每个动作都是一次 `client.invoke` 调用加一次状态重新拉取，固化裁剪除外：它等待裁剪记录，再用其第一个输出写替换记录；裁剪没有输出时什么都不写。移动成功后重新选中被移动的片段。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | 注册 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/TimelineBody.tsx`](src/client/TimelineBody.tsx) | 主体：会话、轨道、面板、写入 |
| [`src/client/Track.tsx`](src/client/Track.tsx)、[`src/client/ClipPanel.tsx`](src/client/ClipPanel.tsx) | 轨道和片段面板 |
| [`src/client/locales.ts`](src/client/locales.ts) | `vhTimeline` 词典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@video-harness/views`](../views/README.zh.md) — 每个手势背后的路由。
- [`@video-harness/ui-kit`](../ui-kit/README.zh.md) — 轨道几何和 hook。
- [`@video-harness/tools`](../tools/README.zh.md) — 时间线调用的 `sequence.*` 和 `clip.trim` 工具。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过浏览器侧的时间线；其手势写下的记录只经由 agent 层的项目提示词节到达模型。

#### KV Cache 影响

无；时间线不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不能拖拽** — 片段每次点击移动一个槽位；没有拖拽手柄。
- **不能播放整条序列** — 面板只预览一个片段；播放整条轨道需要一条 `media.concat` 记录。
- **只有一条轨道** — 音频和叠加层没有自己的泳道。
