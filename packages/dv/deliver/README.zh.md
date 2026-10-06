---
description: "DreamVerse 的交付组件：dvDeliver 服务及其操作 deliver.timeline_export，它用 ffmpeg 裁剪时间线上有入点或出点的片段，再把全部片段拼成一个视频，以及它的智能体工具。"
kind: "package-reference"
---

# @dv/deliver

[English](README.md) | 中文

## 概述

使用本包把一条时间线导出为一个视频文件。它向 `dvProject` 注册一个操作 `deliver.timeline_export`：从项目状态的 `timeline` 切片读取时间线的片段，把每个有入点或出点的片段裁到该范围，经 `dvFfmpeg` 按时间线顺序拼接全部片段，再把拼好的视频作为记录的输出导入素材库。`dvProject` 把它变成智能体工具 `dv_deliver_timeline_export`；时间线面板的导出按钮调用同一个操作。该组件没有归约函数。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project`、`@dv/ffmpeg` 和素材库 `@dv/asset-pool` 之后挂载插件。该操作读取时间线组件 `@dv/timeline` 的切片，因此要导出的组合也挂载该组件。插件没有配置字段。

```yaml
- id: dv-deliver
  name: '@dv/deliver'
```

| 操作 | 工具 | 输入和参数 | 输出 |
| --- | --- | --- | --- |
| `deliver.timeline_export` | `dv_deliver_timeline_export` | 无输入；参数 `timeline`（时间线 ID，例如 `t1`；默认第一条时间线） | `video`（MP4） |

该操作不是确定性的，因为它的输出取决于项目状态中时间线的片段，而参数并不指明这些片段；每次调用都重新导出。它在 `cpu` 资源类别中运行，从不请求确认。时间线未知、项目没有时间线或时间线没有片段时，调用让记录失败。时间线中有占位片段（渲染尚未完成，所以没有素材）时，调用在写下记录之前被拒绝，并列出片段位置，例如 "Clips 3, 5 of timeline t1 are not ready yet."；`exportTimeline` 抛出同样的错误。服务方法 `exportTimeline(timeline, dir)` 为其他调用方把拼好的文件写入 `dir` 并返回其路径。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`exportTimeline` 从素材库取得每个片段的文件。`in_sec` 和 `out_sec` 都为 null 的片段播放整个素材，直接使用素材的文件。其他片段被裁成操作 `scratchDir` 中的新文件，定位放在 `-i` 之后并重新编码（yuv420p 的 H.264，AAC 音频），因此裁切落在准确的帧上。随后用 concat demuxer 以流复制拼接这些片段文件。ffmpeg 拒绝流复制时（例如文件的编码不一致），concat 滤镜按第一个文件的画面尺寸缩放并补边，重新编码每个文件的画面。操作探测拼好的文件，带上时长和画面尺寸导入它，并以时间线名称命名。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvDeliver`：该操作和 `exportTimeline` |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、记录和智能体工具。
- [`@dv/ffmpeg`](../ffmpeg/README.zh.md)：`run` 和 `probe`。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：本包遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

### 工具定义

#### 模型看到什么

一个工具 `dv_deliver_timeline_export`，格式与 `@dv/project` 给每个操作工具的一样。它的描述是 "Export a timeline to one video: each clip with an in or out point is trimmed to that range, and all clips are joined in timeline order. Runs on the CPU."。它自己只有一个参数 `timeline`（时间线 ID，例如 `t1`；默认：第一条时间线）。

#### Token 影响

定义约 250 个 token，插件挂载期间固定不变；`@dv/project` 的共享参数让每个定义多约 200 个 token。

#### KV Cache 影响

该定义位于每次智能体请求中固定的工具部分；挂载或移除插件会改变工具列表，使缓存前缀从工具部分起失效。

### 工具结果

#### 模型看到什么

一次调用返回一个文本块：`done <record>: exported timeline t1`（没有 `timeline` 时为 `exported the first timeline`）、一行 `- video: <AssetId> (video/mp4) <url>`，以及参数。视频不发送图片块。

#### Token 影响

每次调用约 80 个 token。

#### KV Cache 影响

结果在调用之后追加到对话中；已缓存的前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **拼接回退只保留画面**：流复制失败时，重新编码的回退丢弃音频，导出的视频没有声音。
- **流复制接受部分不一致的文件**：ffmpeg 对画面尺寸不同的片段做流复制时不报错，播放器随后以错误的尺寸显示后面的片段；只有被拒绝的流复制才回退到重新编码。
- **没有 GPU 编码器**：裁剪和回退拼接用 CPU 上的 `libx264` 重新编码。
