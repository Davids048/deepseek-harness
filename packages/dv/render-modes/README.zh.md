---
description: "DreamVerse 生成方式 seam 的 Service Definition：dvRef2va（Ref2vaRenderer，提示词和参考图）和 dvT2va（T2vaRenderer，只有提示词），以及它们的请求、模型事实和渲染流类型。"
kind: "package-reference"
---

# @dv/render-modes

[English](README.md) | 中文

## 概述

使用本包添加或替换渲染镜头的方式。生成方式（render mode）是镜头由其输入渲染出来的方式，每种生成方式都是独立的能力 seam。本包定义两个 Cordis 服务：`dvRef2va`（抽象类 `Ref2vaRenderer`：一段提示词、1 到 `maxReferenceImages` 张参考图，以及可选的首帧）和 `dvT2va`（抽象类 `T2vaRenderer`：只有提示词）。每种生成方式都以 `RenderStreamEvent` 流返回一段带音频的视频及其最后一帧。`@dv/shot-render` 是 Consumer；`@dv/fasth3-ref2va` 和 `@dv/fasth3-t2va` 是 Service Provider。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

要添加 provider，继承 `Ref2vaRenderer` 或 `T2vaRenderer` 并把子类作为插件加载；每个 context 中每种生成方式只有一个 provider。Consumer 注入 `dvRef2va` 或 `dvT2va` 并调用三个方法，每个 provider 都按以下语义实现它们：

| 方法 | 返回值 | 语义 |
| --- | --- | --- |
| `model()` | `Promise<RenderModelFacts>` | 后端所服务模型的事实；后端无法连接时 reject。`dvRef2va` 报告的 `maxReferenceImages` 至少为 1，并为每张请求图片提供一个 `imageLabels` 条目，先是参考图，然后是首帧；`dvT2va` 报告 `maxReferenceImages` 为 0，`imageLabels` 为空 |
| `ready()` | `Promise<{ ready, detail }>` | 后端是否可以渲染；`detail` 说明不能渲染的原因，可以渲染时为 null |
| `render(request, signal?)` | `AsyncIterable<RenderStreamEvent>` | 恰好一个 `last_frame`、一个 `video_start`、若干 `chunk` 事件，然后是 `done`；任何后端失败都会 reject；中止 `signal` 会取消渲染并以其原因 reject |

| 类型 | 字段 |
| --- | --- |
| `RenderModelFacts` | `modelId`、`name`、`aspectRatios` 和 `resolutions`（默认值在前）、`frameSizes`（按宽高比再按分辨率给出的 `[width, height]`）、`minDurationSec`、`maxDurationSec`、`numFramesByDurationSec`、`maxReferenceImages`、`imageLabels`（`Picture 1`、`Picture 2`、…）、`gpuSecondsPerVideoSecond`（provider 每渲染一秒视频所用的 GPU 秒数） |
| `Ref2vaRequest` | `prompt`、`references`（按输入顺序的图片字节）、`firstFrame`（图片字节或 null）、`frameWidth`、`frameHeight`、`numFrames`、`seed` |
| `T2vaRequest` | `prompt`、`frameWidth`、`frameHeight`、`numFrames`、`seed` |
| `RenderStreamEvent` | `last_frame`（PNG 字节，在视频之前或之后）、`video_start`（视频的 MIME 类型）、`chunk`（视频字节）、`done`（后端的耗时：以 `_ms` 结尾的键是毫秒，其他键是秒） |

-----

<a id="understand-the-implementation"></a>
## 理解实现

每种生成方式是一个单独的服务，所以挂载一个 provider 恰好增加一种生成方式。`dvRef2va` 挂载期间，`@dv/shot-render` 注册 `shot.render_ref2va`；`dvT2va` 挂载期间，注册 `shot.render_t2va`。镜头渲染读取 `model()`，把镜头的 `duration_sec`、`aspect_ratio` 和 `resolution` 参数换算成画面尺寸和帧数，用 `maxReferenceImages` 检查 `ref2va` 调用的参考图数量，在渲染运行前用镜头时长乘以 `gpuSecondsPerVideoSecond` 得到 GPU 估算，并把渲染流存为一个版本的两个输出 `video` 和 `last_still`。本包只包含类型和两个抽象类，抽象类的构造函数注册服务名。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `Ref2vaRenderer`、`T2vaRenderer`，以及 Cordis `Context` 上的 `dvRef2va` 和 `dvT2va` 属性 |
| [`src/types.ts`](src/types.ts) | `RenderModelFacts`、`Ref2vaRequest`、`T2vaRequest`、`RenderStreamEvent` |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/shot-render`](../shot-render/README.zh.md)：Consumer 及其操作 `shot.render_ref2va` 和 `shot.render_t2va`。
- [`@dv/fasth3-ref2va`](../fasth3-ref2va/README.zh.md)：`dvRef2va` 的 Service Provider。
- [`@dv/fasth3-t2va`](../fasth3-t2va/README.zh.md)：`dvT2va` 的 Service Provider。
- [`@dv/bundle`](../../bundle/dv/README.zh.md)：挂载这些 provider 的行 `dv-fasth3-ref2va` 和 `dv-fasth3-t2va`。

-----

<a id="model-experience"></a>
## 模型体验

### 镜头渲染的渲染工具

#### 模型看到什么

本包不注册工具、提示词段落或 skill。它的两个服务决定 `@dv/shot-render` 列出哪些渲染工具：`dvRef2va` 挂载期间列出 `dv_shot_render_ref2va`，`dvT2va` 挂载期间列出 `dv_shot_render_t2va`。已挂载 provider 的 `RenderModelFacts` 出现在这些工具的结果中（`model`、`frame_width`、`frame_height`、`num_frames`，`ref2va` 还有请求图片的 `image_labels`），也出现在它们的拒绝文本中（允许的宽高比、分辨率和时长，参考图上限，以及渲染需要用户同意时由 `gpuSecondsPerVideoSecond` 得出的 GPU 估算）。

#### Token 影响

本包自身不增加 token；每个 provider 包承担其 skill 的 token，`@dv/shot-render` 承担渲染工具的 token。

#### KV Cache 影响

挂载或移除一个 provider 会增加或移除它的渲染工具，这会改变工具列表，使缓存前缀从工具部分起失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每种生成方式一个 provider**：每个 context 只有一个 `dvRef2va` provider 和一个 `dvT2va` provider，所以同一生成方式的两个模型不能并列挂载。
- **`fl2va` 是保留名**：生成方式名 `fl2va` 在本包中没有服务，也没有类。
