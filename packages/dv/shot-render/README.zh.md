---
description: "DreamVerse 的镜头渲染组件：dvShotRender 服务，它用 DreamVerse 生成后端生成一个镜头的一个版本的 shot.render 操作，记录版本的 shot 归约函数，以及智能体工具 dv_shot_render。"
kind: "package-reference"
---

# @dv/shot-render

[English](README.md) | 中文

## 概述

使用本包生成镜头。它向 `dvProject` 注册一个操作 `shot.render`：由 DreamVerse 生成后端（`dreamverseGeneration`，一个 FastVideo Ref2AV 服务器）根据提示词、参考图，以及可选的更早镜头的最后静帧，生成一个镜头的一个版本。记录的输出是视频和它的最后静帧。`dvProject` 把该操作变成智能体工具 `dv_shot_render`。该组件的归约函数在 `shot` 切片中按镜头归组版本。只有本包使用 `@dreamverse/generation-client`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 和 `@dv/asset-pool` 之后挂载插件。`shot` 归约函数总会注册；挂载了 `dreamverseGeneration` 时注册 `shot.render`。

```yaml
- id: dv-shot-render
  name: '@dv/shot-render'
  config:
    gpuSecondsPerVideoSecond: 4
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `gpuSecondsPerVideoSecond` | `4` | 每生成一秒视频的预估 GPU 秒数；`estimate(params)` 用它乘以 `duration_sec`（调用未给出时为 5），供批准卡片和 DSH 提问规则使用 |

| 操作 | 工具 | 输入和参数 | 输出和报告 |
| --- | --- | --- | --- |
| `shot.render` | `dv_shot_render` | 输入 `reference`（图片，或角色、场景、风格版本 `<id>@<n>`，按提示词顺序）和 `first_frame`（一张图片）；参数 `prompt`（必填）、`duration_sec`、`aspect_ratio`、`resolution`、`generation_mode`、`seed`，以及 `plan`、`plan_version` 和 `shot`（PlanId、已批准的版本和镜头在该版本中的位置，已批准的分镜计划调度生成时设置）；仅工具参数 `continue_from`（一条 `shot.render` 记录，其输出 `#1` 成为 `first_frame`） | 输出 `video`、`last_still`；报告 `{seed, model, generation_mode, aspect_ratio, resolution, duration_sec, frame_width, frame_height, num_frames, image_labels, timings}`；成本 `gpu_seconds` 取自后端的计时 |

`shot.render` 使用 GPU，不是确定性的，并且先问（`confirm: agent_ask_first`）：会话的输入框处于先问模式时，智能体的调用等待输入框的批准卡片。省略的参数取模型的第一个生成模式、画面比例和分辨率以及最短时长；调用未给出种子时抽取一个。`based_on` 一条更早生成记录的调用是该镜头的新版本；`shot` 切片把每个镜头的根记录映射到它的版本（`takes`），并把每个版本映射到它的根（`roots`）。其他调用方使用服务方法 `renderShot(context)`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`renderShot` 从 `dreamverseGeneration.model()` 读取模型事实，按参数解析帧尺寸和帧数，用 DreamVerse 规则校验参考图数量，用 `segmentRequestImages` 排列请求图片（先参考图，再首帧），把后端的片段流写入临时文件，然后经 `context.importAsset` 导入视频和 PNG 最后静帧。挂载了 `@video-harness/stream` 的可选实时流服务时，视频分块到达时也送到它的 `openSegment`，以计划的 `shot` 序号作为片段索引。

对任何调用方，在写下任何记录之前，操作的 `precondition` 在所服务的模型依据参考图生成而调用不带任何参考图时拒绝它：一个素材或一条记录输出算一张参考图，一个角色、场景或风格版本算 `dvProject.assetsOf` 为它返回的素材数。分镜计划调度的调用（参数 `plan`）会被告知用 `dv_plan_update` 更新分镜计划，`plan.approve` 在写下自己的记录之前为每个镜头运行这个前置条件。智能体调用之前，`prepareToolCall` 运行同一个前置条件，所以智能体在提问规则询问用户之前就被拒绝；然后它把 `continue_from` 变成 `first_frame` 输入 `{record, output: 1}`。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvShotRender`：`shot.render`、`renderShot`、参考图规则 |
| [`src/render.ts`](src/render.ts) | `shotGeometry`、`backendSeconds`、`assetRecord` |
| [`src/reducer.ts`](src/reducer.ts) | `shotReducer`，每个镜头的版本 |
| [`src/types.ts`](src/types.ts) | `ShotState`，即 `shot` 切片 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、批准和智能体工具。
- [`@dv/asset-pool`](../asset-pool/README.zh.md)：参考图和导入的输出。
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.zh.md)：后端客户端。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：本包遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

### 工具定义

#### 模型看到什么

一个工具 `dv_shot_render`，格式与 `@dv/project` 给每个操作工具的一样，带提示 "Uses the GPU."，另有仅工具参数 `continue_from`。它的描述说明参考图输入（`c1@1`）、`continue_from`、两个输出，以及每次调用都是新版本、修改提示词时传 `based_on`。智能体集成的提问规则加上 `user_requested`。

#### Token 影响

插件和生成后端挂载期间，该定义固定约 600 个 token；`@dv/project` 的共享参数给每个定义最多增加约 200 个 token。

#### KV Cache 影响

插件和生成后端挂载期间，该定义位于每个智能体请求固定的工具段中；挂载或移除二者之一会改变工具列表，使从工具段开始的缓存前缀失效。

### 工具结果

#### 模型看到什么

一次调用返回一个文本块，含记录、状态、摘要 `shot "<prompt>" (<n>s, seed <seed>)`（已批准的分镜计划调度时为 `shot <n> of plan <plan> v<version> "<prompt>" …`）、带 URL 的输出、参数和报告；挂载了附件服务时最后静帧还以图片块到达。不带参考图的调用在写任何记录之前被拒绝，消息让智能体向用户要一张参考图："The video model renders every shot from 1 to <n> reference images, and this shot has none. Nothing was rendered. …"。

#### Token 影响

每次调用约 200 个 token 的文本，另加最后静帧的图片块。

#### KV Cache 影响

每个结果在调用之后追加到对话中；已缓存的前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **一个后端**：该操作经唯一挂载的 `dreamverseGeneration` 客户端生成；它的模型事实决定每个帧尺寸和时长。
- **批准预估**：GPU 预估是 `duration_sec × gpuSecondsPerVideoSecond`，一个配置的速率，而非测得的值。
