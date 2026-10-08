---
description: "作为右侧栏标签和中央视图的 DreamVerse 时间线编辑器：项目的每条时间线在一条轨道上，移动、裁剪、拆分、插入、移除手势变成 `timeline.*` 记录。"
kind: "package-reference"
---

# @dv/ui-timeline

[English](README.md) | 中文

## 概述

使用本包让 web 应用在对话旁边多一个时间线编辑器。编辑器为每条时间线显示一个标签，一个跨片段连续播放所选时间线的预览，以及一条视频轨道：每个片段的宽度就是它播放的时长，过期或属于草稿时有标记。你可以在轨道上移动、裁剪、拆分和移除片段，并把素材库里的素材拖到轨道上或用 ＋ 选择来插入。右侧栏的 `dv-timeline` 标签类型把编辑器包在分支栏下；`TimelineView` 是 shell 中央的时间线视图。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在叠了 `dsh-web-app` 和 `@dv/api` 的 profile 里挂载插件，先用 `pnpm run build` 构建浏览器 bundle。

编辑器还有一条工具栏和一把标尺，每个片段带生产它的记录的最后一帧。拖动片段即移动，拖动片段边缘即裁剪，工具栏在播放头处拆分片段，其 撤销 和 重做 把当前分支后退或前进一步（不论这一步是哪个视图做的），Delete 键移除选中的片段。预览下方的控制栏左侧是时间码；中间是后退 5 秒、播放或暂停、前进 5 秒（编辑器获得焦点时，J、L、Shift+← 和 Shift+→ 也能跳 5 秒）；右侧是播放速度按钮和全屏按钮，播放速度按钮在 0.5×、1×、1.5×、2× 之间循环，并在浏览器标签页的会话内保持所选速度。原声轨道按每个片段的播放区间画出它的波形。拖动预览和工具栏之间的分隔线（或在分隔线上按 ArrowUp 和 ArrowDown）可改变轨道区的高度，浏览器把它记在 `localStorage` 键 `dv-timeline-track-height` 下；预览至少保留 160 px。

```yaml
- id: dv-ui-timeline
  name: '@dv/ui-timeline'
```

Host 半边不注册任何东西。浏览器半边注册 `dv-timeline` 标签类型（侧栏指南页以"时间线"提供）、中英文的 `dvTimeline` locale 命名空间，以及以自身 id `@dv/ui-timeline` 为键的标签主体。带 `{timelineId, clipId}` 的 `dv:timeline-focus` 窗口事件让编辑器选中该时间线的那个片段，并把播放头移到片段开头。

| 手势 | 记录 |
| --- | --- |
| 拖动片段边缘 | `timeline.clip_trim {clip, in_sec, out_sec}`（`clip` 是片段 ID）；未设置的一端不写 |
| 拖动片段 | `timeline.clip_move {clip, to}`（`to` 是从 1 开始的位置） |
| 拆分 | 对播放头下的片段做 `timeline.clip_split {clip, at_sec}` |
| 对选中片段按 Delete | `timeline.clip_remove {clip}` |
| 把素材拖到轨道上，或用 ＋ 选择 | `timeline.clip_insert {timeline, at, asset}` |
| ＋ 新建、重命名、删除标签 | `timeline.create {timeline, assets: []}`（不带名称，标签显示 时间线 {n} / Timeline {n}）、`timeline.rename {timeline, name}`、`timeline.delete {timeline}` |
| 导出 | 一次 `deliver.timeline_export {timeline}` 调用；链接打开导出的视频 |
| 对选中的过期片段点"仍然保留" | 对创建该片段素材的记录调用 `POST /api/dv/stale/accept`（`proj.stale_accept`） |

每条记录都带 `surface: 'timeline'`、视图旁边的对话（记录因此落在该对话的草稿上），以及一句用 DSH 界面语言说明手势的意图。所选时间线经 `@dv/ui-kit/current-timeline.ts` 共享，shell 因此把它写进 URL。`TimelineView` 通过 `@dv/ui-kit/locale.ts` 跟随 `<html lang>`；切换时间线标签会停止播放，并重置预览和播放头。点一个片段会选中它，不发送任何请求。显示 `draft/*` 分支时手势禁用。标签上方 `@dv/ui-kit/WorkingBranchBar.tsx` 的当前分支栏说明修改写入哪个分支，显示草稿中最近一条带 `intent` 的记录的 `intent`，并接受或丢弃打开的草稿。素材没有时长时片段按五秒画。

DOM 带测试 ID `dv-timeline-body`、`dv-timeline-editor`、`dv-timeline-viewer`、`dv-timeline-viewer-empty`、`dv-timeline-time`、`dv-timeline-exported`、`dv-timeline-ruler` 和 `dv-timeline-playhead`；每个片段带 `data-clip`（片段 ID）、`data-clip-position`、`data-clip-stale` 和 `data-clip-draft`，每个标签带 `data-timeline`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`TimelineBody` 持有来自 `@dv/ui-kit/useView.ts` 的视图会话，在 `TimelineEditor` 上方画分支栏。`TimelineView` 自己读取分支状态，并显示其对话打开的草稿，标出草稿的片段。`placeTimeline` 把状态里的一条时间线变成带坐标的片段；`useTimelinePlayer` 通过两个叠放的 `<video>` 元素播放它们。每个手势都是一次 `DvClient.runOperation` 调用加一次状态重新拉取。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | 注册 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/TimelineBody.tsx`](src/client/TimelineBody.tsx) | 标签主体：分支栏和编辑器 |
| [`src/client/TimelineView.tsx`](src/client/TimelineView.tsx) | 中央视图：状态、草稿叠加、写入 |
| [`src/client/TimelineEditor.tsx`](src/client/TimelineEditor.tsx) | 编辑器：标签、预览、工具栏、标尺、轨道、手势 |
| [`src/client/timelines.ts`](src/client/timelines.ts) | 片段摆放、放下位置、时间码 |
| [`src/client/player.ts`](src/client/player.ts) | 跨片段连续播放 |
| [`src/client/waveform.ts`](src/client/waveform.ts) | 原声轨道的音频解码、峰值包络和波形条 |
| [`src/client/locales.ts`](src/client/locales.ts) | `dvTimeline` 词典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/api`](../api/README.zh.md) — 每个手势背后的路由。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — 客户端、轨道几何和 hook。
- [`@dv/timeline`](../timeline/README.zh.md) — 编辑器调用的 `timeline.*` 操作。
- [`@dv/deliver`](../deliver/README.zh.md) — 导出调用的 `deliver.timeline_export` 操作。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dv/project`；其手势写下的记录只经由 [`@dv/project`](../project/README.zh.md) 的 `dv:project` 提示词段落以及 `dv_proj_*` 和操作工具到达模型。

#### KV Cache 影响

无；时间线不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有一条视频轨道** — 原声轨道镜像视频片段，没有自己的编辑操作；字幕和配乐没有泳道。
- **波形在浏览器里解码** — 原声轨道为每个片段画波形时，会下载片段的整个媒体文件，用 Web Audio API 解码其音频，一次解码一个素材，并在本次页面加载内按素材缓存在内存里；音频解码期间、解码失败时、媒体没有音轨时，片段保持纯色块。媒体文件取不到时（网络错误或 5xx 状态），结果不进缓存：片段在 2 秒、8 秒、30 秒后各重试一次，片段下次挂载时从头再试。
