---
description: "DreamVerse 生成方式 seam 的 Service Definition：按名字登记渲染器的注册表 dvRef2va（Ref2vaRenderer，提示词和参考图）和 dvT2va（T2vaRenderer，只有提示词），以及它们的请求、模型事实和渲染流类型。"
kind: "package-reference"
---

# @dv/render-modes

[English](README.md) | 中文

## 概述

使用本包添加渲染镜头的方式。生成方式（render mode）是镜头由其输入渲染出来的方式，每种生成方式都是独立的能力 seam。本包提供两个 Cordis 服务，每个都是按后端名字登记渲染器的注册表：`dvRef2va`（接口 `Ref2vaRenderer`：一段提示词、1 到 `maxReferenceImages` 张参考图，以及可选的首帧）和 `dvT2va`（接口 `T2vaRenderer`：只有提示词）。任意数量的 provider 插件都可以向同一种生成方式登记渲染器。每个渲染器都以 `RenderStreamEvent` 流返回一段带音频的视频及其最后一帧。`@dv/shot-render` 是 Consumer；`@dv/fasth3-ref2va` 和 `@dv/fasth3-t2va` 是 Service Provider。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

只挂载本插件一次（[`@dv/bundle`](../../bundle/dv/README.zh.md) 的行 `dv-render-modes`）；它提供 `dvRef2va` 和 `dvT2va`。要添加一个后端，写一个插件：注入其生成方式的注册表，并在 `ctx.effect` 内以一个后端名字登记一个实现 `Ref2vaRenderer` 或 `T2vaRenderer` 的对象，这样卸载该插件时渲染器随之移除：

```ts
ctx.effect(() => ctx.dvRef2va.register(config.backend, new MyRef2vaRenderer(config)))
```

每个注册表有以下方法：

| 方法 | 返回值 | 语义 |
| --- | --- | --- |
| `register(backend, renderer)` | `() => void` | 以 `backend` 登记渲染器，并返回移除它的函数；`backend` 已在本生成方式中登记时抛出错误 |
| `get(backend)` | 渲染器或 `undefined` | 以 `backend` 登记的渲染器 |
| `backends()` | `string[]` | 已登记的后端名字，按登记顺序 |
| `onChanged(listener)` | `() => void` | 每次登记和移除后调用 `listener`；返回移除该 listener 的函数 |

Consumer 注入 `dvRef2va` 或 `dvT2va`，按后端名字选出一个渲染器，并调用三个方法，每个渲染器都按以下语义实现它们：

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

每种生成方式是一个单独的注册表，所以一个 provider 恰好向一种生成方式增加一个后端。`dvRef2va` 中有渲染器期间，`@dv/shot-render` 注册 `shot.render_ref2va`；`dvT2va` 中有渲染器期间，注册 `shot.render_t2va`；每次 `onChanged` 回调时它都重新注册操作，使其 `backend` 参数列出已登记的后端。镜头渲染读取调用所指定渲染器的 `model()`，把镜头的 `duration_sec`、`aspect_ratio` 和 `resolution` 参数换算成画面尺寸和帧数，用 `maxReferenceImages` 检查 `ref2va` 调用的参考图数量，在渲染运行前用镜头时长乘以 `gpuSecondsPerVideoSecond` 得到 GPU 估算，并把渲染流存为一个版本的两个输出 `video` 和 `last_still`。本包包含类型、渲染器接口、通用的 `RendererRegistry` 类，以及挂载 `Ref2vaRegistry` 和 `T2vaRegistry` 的函数插件。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `Ref2vaRenderer`、`T2vaRenderer`、`RendererRegistry`、`Ref2vaRegistry`、`T2vaRegistry`、插件的 `apply`，以及 Cordis `Context` 上的 `dvRef2va` 和 `dvT2va` 属性 |
| [`src/types.ts`](src/types.ts) | `RenderModelFacts`、`Ref2vaRequest`、`T2vaRequest`、`RenderStreamEvent` |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/shot-render`](../shot-render/README.zh.md)：Consumer 及其操作 `shot.render_ref2va` 和 `shot.render_t2va`。
- [`@dv/fasth3-ref2va`](../fasth3-ref2va/README.zh.md)：向 `dvRef2va` 登记一个渲染器的 Service Provider。
- [`@dv/fasth3-t2va`](../fasth3-t2va/README.zh.md)：向 `dvT2va` 登记一个渲染器的 Service Provider。
- [`@dv/bundle`](../../bundle/dv/README.zh.md)：挂载注册表的行 `dv-render-modes`，以及挂载这些 provider 的行 `dv-fasth3-ref2va` 和 `dv-fasth3-t2va`。

-----

<a id="model-experience"></a>
## 模型体验

### 镜头渲染的渲染工具

#### 模型看到什么

本包不注册工具、提示词段落或 skill。它的两个注册表决定 `@dv/shot-render` 列出哪些渲染工具，以及这些工具的 `backend` 参数可取哪些值：`dvRef2va` 中有渲染器期间列出 `dv_shot_render_ref2va`，`dvT2va` 中有渲染器期间列出 `dv_shot_render_t2va`，各自以已登记的后端名字作为 `backend` 的取值。调用所指定渲染器的 `RenderModelFacts` 出现在这些工具的结果中（`model`、`frame_width`、`frame_height`、`num_frames`，`ref2va` 还有请求图片的 `image_labels`），也出现在它们的拒绝文本中（允许的宽高比、分辨率和时长，参考图上限，以及渲染需要用户同意时由 `gpuSecondsPerVideoSecond` 得出的 GPU 估算）。

#### Token 影响

本包自身不增加 token；每个 provider 包承担其 skill 的 token，`@dv/shot-render` 承担渲染工具的 token。

#### KV Cache 影响

登记或移除一个渲染器会改变渲染工具的 `backend` 取值，或者增加或移除该工具，这会改变工具列表，使缓存前缀从工具部分起失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **`fl2va` 是保留名**：生成方式名 `fl2va` 在本包中没有服务，也没有类。
