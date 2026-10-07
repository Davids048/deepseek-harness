---
description: "DreamVerse t2va 生成方式（dvT2va）的 Service Provider，面向 FastVideo streaming_v2 服务器后的 FastH3 8-Step V2 文字生成视频模型，附带提示词 skill fasth3-t2va-prompting。"
kind: "package-reference"
---

# @dv/fasth3-t2va

[English](README.md) | 中文

## 概述

使用本包以文字生成（`t2va`）方式渲染镜头：由 FastVideo streaming_v2 服务器后的 FastH3 8-Step V2 文字生成视频模型（`FastVideo/FastVideo-FastH3-8-Step-V2`），只根据提示词渲染。类 `FastH3T2vaRenderer` 是 `@dv/render-modes` 中 `dvT2va` 的 Service Provider：它从服务器读取不含参考图的模型事实，报告服务器是否就绪，并在每次渲染时不发送图片。DSH skill 注册表挂载期间，它注册 skill `fasth3-t2va-prompting`：模型的限制和 `dv_shot_render_t2va` 的提示词规则。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用服务文字生成视频模型的 streaming_v2 服务器的基础 URL 挂载插件。只有设置了 `DV_T2VA_BACKEND_URL` 时，DreamVerse bundle 才以行 `dv-fasth3-t2va` 挂载它；未设置时，智能体没有 `dv_shot_render_t2va` 工具：

```yaml
- id: dv-fasth3-t2va
  name: '@dv/fasth3-t2va'
  disabled: !!js "!process.env.DV_T2VA_BACKEND_URL"
  config:
    baseUrl: !!js process.env.DV_T2VA_BACKEND_URL
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | 必填 | 服务文字生成视频模型的 FastVideo streaming_v2 服务器的 HTTP 基础 URL；bundle 读取 `DV_T2VA_BACKEND_URL` |
| `gpuSecondsPerVideoSecond` | `1.5` | 该服务器每渲染一秒视频所用的 GPU 秒数；`model()` 报告它，用于渲染前的 GPU 估算 |

provider 挂载期间，`@dv/shot-render` 注册 `shot.render_t2va`（工具 `dv_shot_render_t2va`）。同时挂载 DSH skill 注册表（`@deepseek-ai/dsh-skill`），智能体才能加载提示词 skill。

-----

<a id="understand-the-implementation"></a>
## 理解实现

HTTP 工作由 `@dreamverse/generation-client` 的 streaming_v2 客户端完成：`model()` 读取 `GET /v1/streamv2/capabilities`，`ready()` 读取 `GET /v1/streamv2/health`，`render()` 发送一个 streaming_v2 渲染请求并返回服务器的事件流。`model()` 复制服务器的事实，并报告 `maxReferenceImages` 为 0、`imageLabels` 为空，因为文字生成视频模型不接受参考图。`render()` 以空图片列表发送提示词，向服务器请求最后一帧，并传递 `signal` 以取消 HTTP 请求。客户端位于隔离的 `dreamverseGeneration` 作用域中，所以宿主不会多出 `dreamverseGeneration` 服务。skill 在 `ctx.inject(['skills'], …)` 内通过 `ctx.skills.register` 注册，所以 skill 注册表挂载时出现，provider 或注册表移除时消失。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `FastH3T2vaRenderer`、`Config` 和 skill 注册 |
| [`skills/fasth3-t2va-prompting.md`](skills/fasth3-t2va-prompting.md) | skill 正文：模型限制、三个提示词字段，以及关于描述、镜头运动、说话人与对白和画面文字的规则 |
| [`tests/fasth3-t2va.spec.ts`](tests/fasth3-t2va.spec.ts) | 一个包含 skill 注册表的 Loader 组合，连接假的 streaming_v2 服务器；一个需显式启用的测试对 `DV_T2VA_BACKEND_URL` 指定的服务器真实渲染 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/render-modes`](../render-modes/README.zh.md)：本包提供的 `dvT2va` 服务。
- [`@dv/shot-render`](../shot-render/README.zh.md)：Consumer，提供工具 `dv_shot_render_t2va`。
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.zh.md)：streaming_v2 客户端。
- [`dsh-tool-skill`](../../skill/tool-skill/README.zh.md)：智能体如何看到 skill 目录并加载 skill。

-----

<a id="model-experience"></a>
## 模型体验

### 提示词 skill

#### 模型看到什么

skill 注册表挂载期间，`dsh-tool-skill` 渲染的 skill 目录列出下面的目录条目。智能体用 `fasth3-t2va-prompting` 调用 `skill` 工具时，工具结果带有 `skills/fasth3-t2va-prompting.md`：镜头没有参考图和首帧，`duration_sec` 为 5 到 15，提示词用英文写成三个字段 `integrated_multimodal_description`、`overall_soundscape` 和 `non_diegetic_music`，并附有关于一个渲染镜头内多个摄影镜头（`[Shot 2] At 00:03.500, …`）、镜头运动、说话人 ID（如 `(S1)`）、`<d>` 内的对白和画面文字的规则。

##### 目录条目

```markdown
- `fasth3-t2va-prompting`: Model limits and prompt rules for dv_shot_render_t2va (render mode t2va): the three prompt fields, shot changes, camera motion, speakers and dialogue, sound and music.
```

#### Token 影响

provider 和 skill 注册表挂载期间，目录中约 40 个 token；智能体每次加载该 skill 约 1,200 个 token。

#### KV Cache 影响

挂载或移除 provider 会改变 skill 列表，`dsh-tool-skill` 会追加一份替换目录；加载的 skill 正文作为工具结果追加。两者都不改变它们之前的缓存前缀。

### 渲染工具中的模型事实

#### 模型看到什么

本 provider 的模型事实影响 `dv_shot_render_t2va`：它的结果报告 `model`（服务器的模型 ID）、`frame_width`、`frame_height` 和 `num_frames`，它的拒绝文本列出允许的宽高比、分辨率和时长，以及由 `gpuSecondsPerVideoSecond` 得出的 GPU 估算。本 provider 挂载期间，没有参考图的 `dv_shot_render_ref2va` 调用的拒绝文本也会指引智能体使用 `dv_shot_render_t2va`。

#### Token 影响

除 `@dv/shot-render` 写出的工具结果和拒绝文本外，本包不增加 token。

#### KV Cache 影响

挂载或移除 provider 会增加或移除 `dv_shot_render_t2va`，使缓存前缀从工具部分起失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **跨镜头没有身份一致性**：模型只看到提示词，所以主体只有在相同文字描述的范围内保持外观；必须保持同一张脸时，需要带参考图的 `dv_shot_render_ref2va`。
- **不能从较早的镜头开始**：`T2vaRequest` 不带图片，所以只有 `dv_shot_render_ref2va`（`continue_from`）能从较早镜头的最后静帧开始一个镜头。
- **skill 中的固定限制**：`skills/fasth3-t2va-prompting.md` 写明 5 到 15 秒，而 `model()` 从服务器读取时长范围；服务器的范围不同时，skill 会与 `dv_shot_render_t2va` 的拒绝文本不一致。
