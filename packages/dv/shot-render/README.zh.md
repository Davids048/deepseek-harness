---
description: "DreamVerse 的镜头渲染组件：dvShotRender 服务，生成方式 seam 的使用者，含渲染一个镜头的一个版本的操作 shot.render_ref2va 和 shot.render_t2va、记录版本的 shot 归约函数，以及智能体工具 dv_shot_render_ref2va 和 dv_shot_render_t2va。"
kind: "package-reference"
---

# @dv/shot-render

[English](README.md) | 中文

## 概述

使用本包渲染镜头。它是 [`@dv/render-modes`](../render-modes/README.zh.md) 中生成方式 seam 的使用者：`shot.render_ref2va` 经 `dvRef2va` 根据提示词、参考图和可选的首帧渲染一个镜头的一个版本，`shot.render_t2va` 经 `dvT2va` 只根据提示词渲染一个版本。每个操作只在它的生成方式注册表中有渲染器期间存在，所以智能体只得到它能用的工具 `dv_shot_render_<mode>`，调用的 `backend` 参数指定由哪个已登记的渲染器渲染。每个版本的输出都是视频和它的最后静帧；归约函数在 `shot` 切片中按镜头归组版本。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 和 `@dv/asset-pool` 之后挂载插件，并挂载 [`@dv/render-modes`](../render-modes/README.zh.md)，以及要使用的每种生成方式至少一个实现，例如 [`@dv/fasth3-ref2va`](../fasth3-ref2va/README.zh.md) 和 [`@dv/fasth3-t2va`](../fasth3-t2va/README.zh.md)。`shot` 归约函数总会注册；`dvRef2va` 中有渲染器时注册 `shot.render_ref2va`，`dvT2va` 中有渲染器时注册 `shot.render_t2va`。每当注册表变化，每个操作都重新注册，所以它的 `backend` 参数恰好按登记顺序列出已登记的后端名字。

```yaml
- id: dv-shot-render
  name: '@dv/shot-render'
```

本插件没有配置。一次渲染的 GPU 预估 `estimate(params)` 是 `duration_sec`（调用未给出时为 5）乘以 `backend` 指定的渲染器（调用未给出时为第一个登记的渲染器）在模型事实中报告的 `gpuSecondsPerVideoSecond`；Shot render 保存每个已登记渲染器最近一次报告的模型事实，在渲染器登记时读取，每次渲染时再读取，所以同步的预估可以用于一轮的 GPU 预算和 `confirmSummary` 的确认文字。渲染器还没有报告模型事实时，它的预估为 0。

| 操作 | 工具 | 输入和参数 | 输出和报告 |
| --- | --- | --- | --- |
| `shot.render_ref2va` | `dv_shot_render_ref2va` | 输入 `reference`（至少一个：图片，或角色、场景、风格版本 `<id>@<n>`，按提示词顺序）和 `first_frame`（一张图片）；参数 `prompt`（必填）、`backend`（已登记的 `ref2va` 后端之一；默认第一个）、`duration_sec`、`aspect_ratio`、`resolution`、`seed`，以及 `plan`、`plan_version` 和 `shot`（PlanId、已批准的版次和镜头在该版次中的位置，已批准的分镜计划调度渲染时设置）；仅工具参数 `continue_from`（一条渲染记录，其输出 `#1` 成为 `first_frame`） | 输出 `video`、`last_still`；报告 `{seed, model, aspect_ratio, resolution, duration_sec, frame_width, frame_height, num_frames, backend, image_labels, timings}`；成本 `gpu_seconds` 取自后端的计时 |
| `shot.render_t2va` | `dv_shot_render_t2va` | 没有输入；参数与 `shot.render_ref2va` 相同，`backend` 取已登记的 `t2va` 后端之一 | 输出 `video`、`last_still`；报告 `{seed, model, aspect_ratio, resolution, duration_sec, frame_width, frame_height, num_frames, backend, timings}`；成本 `gpu_seconds` 取自后端的计时 |

两个操作都使用 GPU，不是确定性的，并声明 `confirm: over_gpu_budget`：会让本轮超过 `dvProject` GPU 预算的智能体调用被拒绝，直到智能体在对话中询问用户并带 `user_requested: true` 再次调用；`confirmSummary` 为拒绝消息给出一行说明（`Render shot from references, 5 s: "<prompt>"`）和该调用的 GPU 预估。Shot render 运行之前，Project 就会拒绝未登记的 `backend`。省略的参数取模型的第一个画面比例和分辨率以及最短时长；调用未给出种子时抽取一个。`based_on` 任一生成方式的更早渲染记录的调用是该镜头的新版本；`shot` 切片把每个镜头的根记录映射到它的版本（`takes`），并把每个版本映射到它的根（`roots`）。其他调用方使用服务方法 `renderShot(context)`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`renderShot` 按记录的操作选择生成方式，按 `backend` 参数选择渲染器（调用未给出时为第一个登记的后端），从该渲染器的 `model()` 读取模型事实，按参数解析帧尺寸和帧数；对 `ref2va`，它检查调用带有 1 到 `maxReferenceImages` 张参考图，并从素材库读取它们和首帧的字节。它把请求发给该渲染器的 `render(request, signal)`，把流写入临时文件，然后经 `context.importAsset` 导入视频和 PNG 最后静帧。报告的 `backend` 指明渲染这个版本的渲染器；对 `ref2va`，`image_labels` 用模型的 `imageLabels` 为图片命名：先按顺序是参考图，再是首帧。挂载了 `@video-harness/stream` 的可选实时流服务时，视频分块到达时也送到它的 `openSegment`，以计划的 `shot` 序号作为片段索引。

对任何调用方，在写下任何记录之前，`shot.render_ref2va` 的 `precondition` 拒绝不带任何参考图的调用：一个素材或一条记录输出算一张参考图，一个角色、场景或风格版本算 `dvProject.assetsOf` 为它返回的素材数。分镜计划调度的调用（参数 `plan`）会被告知用 `dv_plan_update` 更新分镜计划；`dvT2va` 中有渲染器时，拒绝消息还说明不需要参考图的镜头可以用 `dv_shot_render_t2va` 渲染。智能体调用之前，`prepareToolCall` 运行同一个前置条件，所以智能体在 Project 请求用户同意之前就被拒绝；然后它把 `continue_from` 变成 `first_frame` 输入 `{record, output: 1}`。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvShotRender`：`shot.render_ref2va`、`shot.render_t2va`、`renderShot`、参考图规则 |
| [`src/render.ts`](src/render.ts) | `shotGeometry`、`imageLabels`、`backendSeconds` |
| [`src/reducer.ts`](src/reducer.ts) | `shotReducer`，两种生成方式下每个镜头的版本 |
| [`src/types.ts`](src/types.ts) | `ShotState`，即 `shot` 切片 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、批准和智能体工具。
- [`@dv/asset-pool`](../asset-pool/README.zh.md)：参考图和导入的输出。
- [`@dv/render-modes`](../render-modes/README.zh.md)：本包使用的生成方式 seam。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：本包遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

### 工具定义

#### 模型看到什么

每种有已登记渲染器的生成方式一个工具，格式与 `@dv/project` 给每个操作工具的一样，带提示 "Uses the GPU."，以及 Project 因 `confirm: over_gpu_budget` 加上的参数 `user_requested`。`dv_shot_render_ref2va` 说明它至少需要一张参考图（`c1@1`），并说明 `continue_from`；`dv_shot_render_t2va` 说明它只根据提示词渲染、没有输入。两者都把已登记的后端列为 `backend` 的取值，并都说明两个输出，以及每次调用都是新版本、修改提示词时传 `based_on`。

#### Token 影响

插件挂载且它的生成方式注册表中的渲染器不变期间，每个定义固定约 600 个 token；`@dv/project` 的共享参数给每个定义最多增加约 200 个 token。

#### KV Cache 影响

插件挂载且它的生成方式注册表中有渲染器期间，每个定义位于每个智能体请求固定的工具段中；挂载或移除插件，或者登记或移除渲染器，都会改变工具列表，使从工具段开始的缓存前缀失效。

### 工具结果

#### 模型看到什么

一次调用返回一个文本块，含记录、状态、摘要 `shot "<prompt>" (<n>s, seed <seed>)`（已批准的分镜计划调度时为 `shot <n> of plan <plan> v<version> "<prompt>" …`）、带 URL 的输出、参数和报告；挂载了附件服务时最后静帧还以图片块到达。不带参考图的 `dv_shot_render_ref2va` 调用在写任何记录之前被拒绝，消息让智能体向用户要一张参考图："dv_shot_render_ref2va renders a shot from 1 to <n> reference images, and this shot has none. Nothing was rendered. …"。

#### Token 影响

每次调用约 200 个 token 的文本，另加最后静帧的图片块。

#### KV Cache 影响

每个结果在调用之后追加到对话中；已缓存的前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **GPU 预估**：GPU 预估是 `duration_sec × gpuSecondsPerVideoSecond`，即渲染器的实现配置的速率，而非测得的值。
