---
description: "DreamVerse ref2va 生成方式（dvRef2va）的 Service Provider，面向 FastVideo streaming_v2 服务器后的 FastH3 Ref2VA 模型，附带提示词 skill fasth3-ref2va-prompting。"
kind: "package-reference"
---

# @dv/fasth3-ref2va

[English](README.md) | 中文

## 概述

使用本包以参考图生成（`ref2va`）方式渲染镜头：由 FastVideo streaming_v2 服务器后的 FastH3 Ref2VA 模型，根据提示词和参考图渲染。类 `FastH3Ref2vaRenderer` 是 `@dv/render-modes` 中 `dvRef2va` 的 Service Provider：它从服务器读取模型事实，报告服务器是否就绪，并在每次渲染时先发送参考图，再发送首帧。DSH skill 注册表挂载期间，它注册 skill `fasth3-ref2va-prompting`：模型的限制和 `dv_shot_render_ref2va` 的提示词规则。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用 streaming_v2 服务器的基础 URL 挂载插件。DreamVerse bundle 以行 `dv-fasth3-ref2va` 挂载它：

```yaml
- id: dv-fasth3-ref2va
  name: '@dv/fasth3-ref2va'
  config:
    baseUrl: !!js process.env.DV_BACKEND_URL || 'http://127.0.0.1:8029'
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | 必填 | FastVideo streaming_v2 服务器的 HTTP 基础 URL；bundle 读取 `DV_BACKEND_URL`，未设置时使用 `http://127.0.0.1:8029` |
| `gpuSecondsPerVideoSecond` | `4` | 该服务器每渲染一秒视频所用的 GPU 秒数；`model()` 报告它，用于渲染前的 GPU 估算 |

provider 挂载期间，`@dv/shot-render` 注册 `shot.render_ref2va`（工具 `dv_shot_render_ref2va`）。同时挂载 DSH skill 注册表（`@deepseek-ai/dsh-skill`），智能体才能加载提示词 skill。

-----

<a id="understand-the-implementation"></a>
## 理解实现

HTTP 工作由 `@dreamverse/generation-client` 的 streaming_v2 客户端完成：`model()` 读取 `GET /v1/streamv2/capabilities`，`ready()` 读取 `GET /v1/streamv2/health`，`render()` 发送一个 streaming_v2 渲染请求并返回服务器的事件流。服务器把首帧算作一张请求图片，所以 `model()` 报告的 `maxReferenceImages` 比服务器的 `max_reference_images` 少一，并为服务器的每张图片保留一个 `imageLabels` 条目（`Picture 1` 到 `Picture N`）；首帧使用最后一张参考图之后的标签。`render()` 按输入顺序发送参考图，请求带首帧时把首帧追加在后，向服务器请求最后一帧，并传递 `signal` 以取消 HTTP 请求。客户端位于隔离的 `dreamverseGeneration` 作用域中，所以宿主不会多出 `dreamverseGeneration` 服务。skill 在 `ctx.inject(['skills'], …)` 内通过 `ctx.skills.register` 注册，所以 skill 注册表挂载时出现，provider 或注册表移除时消失。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `FastH3Ref2vaRenderer`、`Config` 和 skill 注册 |
| [`skills/fasth3-ref2va-prompting.md`](skills/fasth3-ref2va-prompting.md) | skill 正文：DreamVerse 对接说明，后接原样复制的 MiniMax-H3 官方全参考提示词指南 |
| [`tests/fasth3-ref2va.spec.ts`](tests/fasth3-ref2va.spec.ts) | 一个包含 skill 注册表的 Loader 组合，连接假的 streaming_v2 服务器；一个需显式启用的测试对 `DV_BACKEND_URL` 指定的服务器真实渲染 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/render-modes`](../render-modes/README.zh.md)：本包提供的 `dvRef2va` 服务。
- [`@dv/shot-render`](../shot-render/README.zh.md)：Consumer，提供工具 `dv_shot_render_ref2va`。
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.zh.md)：streaming_v2 客户端。
- [`dsh-tool-skill`](../../skill/tool-skill/README.zh.md)：智能体如何看到 skill 目录并加载 skill。

-----

<a id="model-experience"></a>
## 模型体验

### 提示词 skill

#### 模型看到什么

skill 注册表挂载期间，`dsh-tool-skill` 渲染的 skill 目录列出下面的目录条目。智能体用 `fasth3-ref2va-prompting` 调用 `skill` 工具时，工具结果带有 `skills/fasth3-ref2va-prompting.md`：一段 DreamVerse 对接说明（一个 DreamVerse 镜头就是一个目标视频；六个改写部分组成 `prompt`；只用 `<Picture N>` 和 `<Subject N>` 引用；图片编号且首帧排在参考图之后；至少一张、最多 8 张参考图；`duration_sec` 为 5 到 15），后接原样复制的 MiniMax-H3 官方全参考提示词指南 `VIDEO_PROMPT_WRITING_GUIDE_ref_en.md`。

##### 目录条目

```markdown
- `fasth3-ref2va-prompting`: Model limits and prompt rules for dv_shot_render_ref2va (render mode ref2va): reference images, how the prompt names them, and how a shot continues the previous one.
```

#### Token 影响

provider 和 skill 注册表挂载期间，目录中约 40 个 token；智能体每次加载该 skill 约 6,000 个 token。

#### KV Cache 影响

挂载或移除 provider 会改变 skill 列表，`dsh-tool-skill` 会追加一份替换目录；加载的 skill 正文作为工具结果追加。两者都不改变它们之前的缓存前缀。

### 渲染工具中的模型事实

#### 模型看到什么

本 provider 的模型事实影响 `dv_shot_render_ref2va`：它的结果报告 `model`（服务器的模型 ID）、`frame_width`、`frame_height`、`num_frames` 和 `image_labels`，它的拒绝文本列出允许的宽高比、分辨率和时长、参考图上限，以及由 `gpuSecondsPerVideoSecond` 得出的 GPU 估算。

#### Token 影响

除 `@dv/shot-render` 写出的工具结果和拒绝文本外，本包不增加 token。

#### KV Cache 影响

挂载或移除 provider 会增加或移除 `dv_shot_render_ref2va`，使缓存前缀从工具部分起失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **skill 中的固定限制**：`skills/fasth3-ref2va-prompting.md` 写明 5 到 15 秒、最多 8 张参考图，而 `model()` 从服务器读取限制；服务器的限制不同时，skill 会与 `dv_shot_render_ref2va` 的拒绝文本不一致。
- **参考图宽高比**：`RenderModelFacts` 没有对应字段，所以 `model()` 丢弃服务器的 `max_reference_aspect_ratio`，镜头渲染把参考图发给服务器前不检查宽高比。
