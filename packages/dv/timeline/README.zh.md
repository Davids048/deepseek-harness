---
description: "DreamVerse 的时间线组件：dvTimeline 服务、项目的时间线及其片段、十个 timeline.* 操作及其智能体工具，以及 timeline 归约函数。"
kind: "package-reference"
---

# @dv/timeline

[English](README.md) | 中文

## 概述

用本包保存项目的时间线：每条时间线是一个剪辑好的视频，以名称显示（没有名称的时间线 `t<n>` 显示为 时间线 {n}），按播放顺序保存片段。片段是带入点、出点和片段 ID（例如 `cl3`）的素材；编辑片段从不创建文件。本包向 `dvProject` 注册十个操作，`dvProject` 把它们变成智能体工具 `dv_timeline_*`；本包还注册 `timeline` 归约函数，把这些操作的记录折叠成项目状态的 `timeline` 切片。把时间线导出成一个文件属于 `@dv/deliver`。

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

整条时间线的操作和 `timeline.clip_insert` 用参数 `timeline`（时间线 ID，例如 `t1`）指定时间线：`timeline.update`、`timeline.rename` 和 `timeline.delete` 中它是必填项；`timeline.create` 默认为 `t1`，`timeline.clip_insert` 默认为第一条时间线。其他片段操作用参数 `clip` 中的片段 ID 指定片段，该 ID 同时确定了包含它的时间线。

| 操作 | 工具 | 参数 | 效果 |
| --- | --- | --- | --- |
| `timeline.create` | `dv_timeline_create` | `timeline`、`name`、`assets`（按顺序的素材 ID）、`plan`；输入角色 `clip`（多个） | 添加一条时间线；ID 已存在时失败。没有 `assets` 时片段为按顺序的 `clip` 输入 |
| `timeline.update` | `dv_timeline_update` | `timeline`、`assets`（按顺序的素材 ID）、`plan`；输入角色 `clip`（多个） | 用获得新片段 ID 的片段替换已有时间线的全部片段；保留名称 |
| `timeline.rename` | `dv_timeline_rename` | `timeline`、`name` | 设置名称 |
| `timeline.delete` | `dv_timeline_delete` | `timeline` | 删除时间线；其素材留在项目中 |
| `timeline.clip_insert` | `dv_timeline_clip_insert` | `timeline`、`at`、`asset` | 把素材作为片段插入到位置 `at`；时间线不存在时创建它 |
| `timeline.clip_move` | `dv_timeline_clip_move` | `clip`、`to` | 把片段移到位置 `to` |
| `timeline.clip_remove` | `dv_timeline_clip_remove` | `clip` | 移除片段；后面的片段前移 |
| `timeline.clip_split` | `dv_timeline_clip_split` | `clip`、`at_sec` | 在素材内的某个时间把片段分成同一素材的两个片段；后一部分获得新的片段 ID |
| `timeline.clip_trim` | `dv_timeline_clip_trim` | `clip`、`in_sec`、`out_sec` | 设置入点和出点；省略的点表示从素材开头播放或播放到素材结尾 |
| `timeline.clip_replace` | `dv_timeline_clip_replace` | `clip`、`asset` | 把片段换成另一个素材，保留其片段 ID 并重置入点和出点 |

`timeline` 切片为 `{timelines: Timeline[]}`；`Timeline` 为 `{id, name, clips}`，`Clip` 为 `{id, asset, in_sec, out_sec}`，其中 `id` 是片段 ID，入点或出点为 null 表示素材的开头或结尾。本包导出类型 `Timeline`、`Clip`、`ClipId`、`TimelineId` 和 `TimelineState`（切片）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

这些操作只写记录。每个操作的 `execute` 用记录父节点处的状态检查调用；当要创建的时间线已存在、指定的其他时间线或片段不存在、位置超出时间线、分割时间不在片段内或裁剪范围为空时，它以原因使记录失败。这些操作不是 `deterministic` 的，因此运行器每次调用都执行这项检查，而不复用先前的记录。归约函数应用每条已完成的记录，并忽略无法应用的记录；它的 `conflict` 执行同一项检查，因此在已移动的 `main` 上接受草稿时，会停在其片段已被 `main` 移除的片段编辑处。

**片段 ID。** 添加片段的操作在 `execute` 中分配片段 ID，并按片段顺序存入记录的 `report.clips`：`timeline.create` 和 `timeline.update` 每个片段一个，`timeline.clip_insert` 一个，`timeline.clip_split` 为后一部分分配一个（前一部分保留原片段 ID）。`cl` 之后的数字比项目在任何分支上（包括已撤销和已丢弃的记录）任一时间线记录的 `report.clips` 中的最大数字大 1，也大于分配给仍在运行的调用的任何数字，因此项目中不会有两个片段共用一个 ID。归约函数只从 `report.clips` 读取片段 ID；接受草稿时的重放会在每个副本上重复报告，因此重放的记录保留其片段 ID，之后指定这些 ID 的草稿记录仍然适用。已完成的记录如果其 `report.clips` 与它添加的片段不符，或指定了已在使用的 ID，则不产生任何效果，并在重放时冲突。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvTimeline`：十个操作 spec、它们的注册以及片段 ID 的分配 |
| [`src/reducer.ts`](src/reducer.ts) | `timeline` 归约函数及其与操作共用的片段检查 |
| [`src/types.ts`](src/types.ts) | `Timeline`、`Clip`、`ClipId`、`TimelineId` 以及 `timeline` 切片声明 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、归约函数、草稿和智能体工具。
- [`@dv/deliver`](../deliver/README.zh.md)：把时间线导出成一个视频文件。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：本包遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

### 工具定义

#### 模型看到什么

十个工具 `dv_timeline_create`、`dv_timeline_update`、`dv_timeline_rename`、`dv_timeline_delete`、`dv_timeline_clip_insert`、`dv_timeline_clip_move`、`dv_timeline_clip_remove`、`dv_timeline_clip_split`、`dv_timeline_clip_trim` 和 `dv_timeline_clip_replace`，格式与 `@dv/project` 为每个操作工具提供的格式相同。编辑工具用 `timeline` 指定时间线（例如 `t1`；默认第一条时间线），用 `clip` 指定片段（例如 `cl3`），参数描述让智能体去 `dv_proj_state` 的 `timelines` 及其 `clips` 里查找。

#### Token 影响

挂载本插件时，十个定义固定约 2,500 个 token；`@dv/project` 的共享参数给每个定义最多增加约 200 个 token。

#### KV Cache 影响

这些定义位于每个智能体请求固定的工具段中；挂载或移除插件会改变工具列表，使从工具段开始的缓存前缀失效。

### 工具结果

#### 模型看到什么

一次调用返回一个文本块，包含记录状态和一行摘要，例如 `clip cl3 moved to 1`；添加片段的调用还在 `report.clips` 中返回这些片段的 ID，不适用于时间线的调用返回带失败记录原因的工具错误。`dv_proj_state` 按片段 ID（字段 `clip`）列出每条时间线及其片段，智能体的项目块也列出它们，并附上每个片段的产生记录。

#### Token 影响

每次调用约 50 到 150 个 token；片段多的新建或更新再加上其素材列表。

#### KV Cache 影响

每个结果在调用之后追加到对话中；已缓存的前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **素材是参数而不是输入**：`asset` 和 `assets` 作为参数记录，因此素材的产生记录被取代时，片段不会使其记录过期。
