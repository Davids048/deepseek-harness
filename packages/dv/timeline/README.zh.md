---
description: "DreamVerse 的时间线组件：dvTimeline 服务、项目的时间线及其片段、九个 timeline.* 操作及其智能体工具，以及 timeline 归约函数。"
kind: "package-reference"
---

# @dv/timeline

[English](README.md) | 中文

## 概述

用本包保存项目的时间线：每条时间线是一个剪辑好的视频，以名称显示（例如第 1 集），按播放顺序保存片段。片段是带入点和出点的素材；编辑片段从不创建文件。本包向 `dvProject` 注册九个操作，`dvProject` 把它们变成智能体工具 `dv_timeline_*`；本包还注册 `timeline` 归约函数，把这些操作的记录折叠成项目状态的 `timeline` 切片。把时间线导出成一个文件属于 `@dv/deliver`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 之后挂载本插件。它没有配置项。

```yaml
- id: dv-timeline
  name: '@dv/timeline'
```

每个操作都接受可选参数 `timeline`（时间线 ID，例如 `t1`；默认为第一条时间线），`timeline.rename` 和 `timeline.delete` 中它是必填项。片段用参数 `clip` 中从 1 开始的位置来指定。

| 操作 | 工具 | 参数 | 效果 |
| --- | --- | --- | --- |
| `timeline.create` | `dv_timeline_create` | `name`、`assets`（按顺序的素材 ID）、`plan`；输入角色 `clip`（多个） | 以新 ID 添加一条时间线，或替换已有时间线的片段；没有 `assets` 时片段为按顺序的 `clip` 输入 |
| `timeline.rename` | `dv_timeline_rename` | `name` | 设置名称 |
| `timeline.delete` | `dv_timeline_delete` | — | 删除时间线；其素材留在项目中 |
| `timeline.clip_insert` | `dv_timeline_clip_insert` | `at`、`asset` | 把素材作为片段插入到位置 `at`；时间线不存在时创建它 |
| `timeline.clip_move` | `dv_timeline_clip_move` | `clip`、`to` | 把片段移到位置 `to` |
| `timeline.clip_remove` | `dv_timeline_clip_remove` | `clip` | 移除片段；后面的片段前移 |
| `timeline.clip_split` | `dv_timeline_clip_split` | `clip`、`at_sec` | 在素材内的某个时间把片段分成同一素材的两个片段 |
| `timeline.clip_trim` | `dv_timeline_clip_trim` | `clip`、`in_sec`、`out_sec` | 设置入点和出点；省略的点表示从素材开头播放或播放到素材结尾 |
| `timeline.clip_replace` | `dv_timeline_clip_replace` | `clip`、`asset` | 把片段换成另一个素材并重置入点和出点 |

`timeline` 切片为 `{timelines: Timeline[]}`；`Timeline` 为 `{id, name, clips}`，`Clip` 为 `{asset, in_sec, out_sec}`，入点或出点为 null 表示素材的开头或结尾。本包导出类型 `Timeline`、`Clip`、`TimelineId` 和 `TimelineState`（切片）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

这些操作只写记录。每个操作的 `execute` 用记录父节点处的状态检查调用；当时间线不存在、位置超出时间线、分割时间不在片段内或裁剪范围为空时，它以原因使记录失败。这些操作不是 `deterministic` 的，因此运行器每次调用都执行这项检查，而不复用先前的记录。归约函数应用每条已完成的记录，并忽略无法应用的记录；它的 `conflict` 执行同一项检查，因此在已移动的 `main` 上接受草稿时，会停在不再适用的片段编辑处。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvTimeline`：九个操作 spec 及其注册 |
| [`src/reducer.ts`](src/reducer.ts) | `timeline` 归约函数及其与操作共用的片段检查 |
| [`src/types.ts`](src/types.ts) | `Timeline`、`Clip`、`TimelineId` 以及 `timeline` 切片声明 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、归约函数、草稿和智能体工具。
- [`@dv/deliver`](../deliver/README.zh.md)：把时间线导出成一个视频文件。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：本包遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

九个工具，从 `dv_timeline_create` 到 `dv_timeline_clip_replace`，格式与 `@dv/project` 为每个操作工具提供的格式相同。一次调用返回一个文本块，包含记录状态和一行摘要，例如 `t2 clip 3 moved to 1`；不适用于时间线的调用返回失败记录的原因。`dv_proj_state` 按位置列出每条时间线及其片段，智能体的项目块也列出它们，并附上每个片段的产生记录。

#### KV Cache 影响

挂载本插件时，九个工具 schema 是每次智能体请求的一部分。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **片段按位置指定**：在插入或移除了片段的 `main` 上重放的草稿编辑，可能作用于同一位置上的另一个片段；`conflict` 只能发现已不存在的位置。稳定的片段 ID（`ClipId`）可以消除这个问题。
- **素材是参数而不是输入**：`asset` 和 `assets` 作为参数记录，因此素材的产生记录被取代时，片段不会使其记录过期。
