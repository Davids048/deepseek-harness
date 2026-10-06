---
description: "DreamVerse 的检查器组件：dvInspector 服务及其两个只读操作 inspect.image（默认模型回答关于一张图片的问题）和 inspect.asset（ffprobe 元数据），以及它们的智能体工具。"
kind: "package-reference"
---

# @dv/inspector

[English](README.md) | 中文

## 概述

使用本包让智能体查看项目素材而不改变项目。它向 `dvProject` 注册两个只读操作：`inspect.image`，由 harness 的默认模型回答关于一个图片素材的问题；`inspect.asset`，经 `dvFfmpeg` 用 ffprobe 读取素材的时长、画面尺寸、编码和是否有音频。`dvProject` 把它们变成智能体工具 `dv_inspect_image` 和 `dv_inspect_asset`。两者都不写记录；回答就是结果的报告。该组件没有归约函数。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project`、`@dv/ffmpeg` 和 `@dv/asset-pool` 之后挂载插件。`inspect.asset` 总会注册；挂载了 `llm`、`agentDefaultModel` 和 `attachments` 时注册 `inspect.image`。

```yaml
- id: dv-inspector
  name: '@dv/inspector'
  config:
    imageInput: true
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxTokens` | `1024` | 一次 `inspect.image` 回答的输出 token 上限 |
| `imageInput` | `true` | agent 模型是否接受图片；为 `false` 时 `inspect.image` 不调用模型，以 `report.unsupported` 作答 |

| 操作 | 工具 | 输入和参数 | 报告 |
| --- | --- | --- | --- |
| `inspect.image` | `dv_inspect_image` | 输入 `image`（PNG、JPEG、WebP 或 GIF），参数 `question`（默认问题询问主体、构图、光线和瑕疵） | `{question, answer, model, unsupported?}` |
| `inspect.asset` | `dv_inspect_asset` | 输入 `asset`（视频、音频或图片） | `{duration_sec, video_duration_sec, width, height, has_audio, codec}` |

服务方法 `inspectImage(asset, question)` 和 `inspectAsset(asset)` 向其他调用方返回同样的报告。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`inspectImage` 经附件服务保存图片，与每张模型可见的图片一样，然后经 `ctx.llm.stream()` 发送一次请求，使用 `ctx.agentDefaultModel.currentSelection()` 的 provider、模型和推理强度，无系统提示词，`maxTokens`，一条用户消息包含图片和随后的问题。`imageInput` 为 `false`，或所选模型的目录条目没有声明图片输入时，不发送请求，`unsupported` 说明原因，agent 读到原因而不是一次失败的调用。`inspectAsset` 探测该素材在素材库中的文件，并以 snake_case 返回各字段。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvInspector`：两个操作及其服务方法 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、只读运行和智能体工具。
- [`@dv/ffmpeg`](../ffmpeg/README.zh.md)：`probe`。
- [`@dv/asset-pool`](../asset-pool/README.zh.md)：本组件读取的素材文件。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：本包是组件的参考布局。

-----

<a id="model-experience"></a>
## 模型体验

### 工具定义

#### 模型看到什么

两个工具 `dv_inspect_image` 和 `dv_inspect_asset`，格式与 `@dv/project` 给每个操作工具的一样；两个描述都以 "A read that writes no record." 结尾，也都不接受 `supersedes` 和 `based_on`。`dv_inspect_image` 查看输入 `image` 并回答参数 `question`（默认："Describe this image: the subject, the framing, the lighting, and anything that looks wrong."）；它的描述告诉智能体，要看视频就先用 `dv_asset_grab_still` 截一张静帧。`dv_inspect_asset` 读取输入 `asset` 的时长、画面尺寸、编码和是否有音频。只有挂载了 `llm`、`agentDefaultModel` 和 `attachments` 时，才列出 `dv_inspect_image`。

#### Token 影响

两个定义约 450 个 token，插件挂载期间固定不变；`@dv/project` 的共享参数让每个定义多约 200 个 token。

#### KV Cache 影响

这些定义位于每次智能体请求中固定的工具部分；挂载或移除插件，或 `dv_inspect_image` 需要的模型服务，会改变工具列表，使缓存前缀从工具部分起失效。

### 工具结果

#### 模型看到什么

一次调用返回一个文本块：`done: dv_inspect_image answered`（或 `dv_inspect_asset`）、参数，以及报告：图片的报告是 `question`、`answer` 和 `model`，默认模型不接受图片时以 `unsupported` 代替回答；素材的报告是 `duration_sec`、`video_duration_sec`、`width`、`height`、`has_audio` 和 `codec`。

#### Token 影响

每次调用约 60 个 token，再加上回答，回答以 `maxTokens` 设置为上限（默认 1024）。

#### KV Cache 影响

结果在调用之后追加到对话中；已缓存的前缀保持不变。

### 图片提问请求

#### 模型看到什么

`dv_inspect_image` 向智能体的默认模型发送一条用户消息，图片作为附件、问题作为文本，不带系统提示词和工具，并把回复的文本放进报告。

#### Token 影响

图片按模型对一张图片的计费计算，问题几十个 token，回答至多 `maxTokens`。模型不接受图片输入或设置了 `imageInput: false` 时，不发送请求。

#### KV Cache 影响

这是智能体对话之外的独立请求；它不触及智能体的缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每次调用一张图片**：`inspect.image` 接受一张图片和一个问题；回答受 `maxTokens` 限制。
- **视频不直接给模型看**：要看视频，智能体先用 `dv_asset_grab_still` 截取它的一张静帧。
