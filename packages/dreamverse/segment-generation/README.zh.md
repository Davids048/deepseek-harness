---
description: "为任意工作负载生成一个 DreamVerse 视频片段：条件图片的顺序与标签、生成请求、流式交付、已存储的视频与末帧文件，以及共享创建规则。"
kind: "package-reference"
---

# @dreamverse/segment-generation

[English](README.md) | 中文

## 概述

当工作负载（workload）需要一个视频片段时使用本包：交给它提示词、帧设置、项目的参考图和上一片段的末帧，它会把视频流式交给你，同时把视频和末帧存为项目文件。只有完整交付的片段才会同时拥有这两个文件。本包还持有所有生成型工作负载共享的规则：按所服务模型检查的创建设置、创建能力载荷，以及每个请求携带哪些图片、使用哪些提示词标签。它不依赖任何工作负载。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dreamverse/generation-client` 与 `@dreamverse/assets-manager` 之后挂载该服务；它没有配置。

### 最小配置

```yaml
- id: dreamverse-segment-generation
  name: '@dreamverse/segment-generation'
```

### 生成片段

`dreamverseSegmentGeneration.generate(request, sink)` 发送一个后端请求，并返回已存储的 `video` 与 `lastFrame` 记录、视频 MIME 类型、后端耗时，以及 sink 接受的分块计数。请求指定提示词、帧宽与帧高、帧数、生成模式、按选择顺序排列的参考素材、前一片段的末帧或 null、文件所有者、基础文件名，以及可选的种子和中止信号。每个非空分块先交给文件存储写入器，再交给 `sink.chunk`。收到后端的 `done` 后，写入器提交 `<name>.mp4`，末帧写为 `<name>.png`。

任何失败都会删除该片段的文件，提前离开流会取消后端请求。后端的 `invalid_request` 失败变为 `DreamverseValueError`；其他后端失败变为带后端消息的 `Error`；缺少视频开始、末帧或 `done` 的流以 `Error` 失败。请求的信号一旦中止，`generate` 就以 `signal.reason` 拒绝，因此工作负载会以它自己的错误中止。

### 共享生成规则

工作负载在调用 `generate` 之前应用以下规则：

- **创建设置**——`parseProjectCreationConfig`、`validateProjectCreation`、`SEGMENT_COUNTS`、`parseReferenceAssetIds` 和 `validateReferenceAssets` 移植参考实现的 `project_creation.py`（不含提示词安全）及其模型能力检查，并使用参考消息。`parseReferenceAssetIds` 以 `AssetId` 值返回所选 ID。
- **创建能力**——`lobbyCapabilitiesAsDict(model, uploadPolicy)` 构建 `GET /creation-capabilities` 的载荷。
- **片段条件输入**——`continuesPreviousSegment` 决定片段是否从前一片段的末帧开始，`segmentImageLabels` 为提示词命名请求图片，`segmentRequestImages` 按相同顺序读取它们，`referenceImageLimit` 给出选择上限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/conditioning.ts` 中的同一个映射决定请求图片的顺序，并把第 N 个位置标为 `Picture N`，因此提示词所命名的正是其请求发送的图片。在模型事实设置了 `usesPreviousFrame` 的模型上，一个轮次中第一个片段之后的每个片段都延续其前一片段，追加轮次的第一个片段延续最近完成的片段；但为追加的首帧（`initial_image`）镜头提供的图片会让该镜头重新开始。选中的参考图总是排在前面，因此用户的 `Picture 1` 到 `Picture K` 永不移位；延续片段在它们之后以 `Picture K+1` 发送前一片段的末帧，延续的首帧镜头只发送末帧。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dreamverseSegmentGeneration` 服务与包导出 |
| [`src/generate.ts`](src/generate.ts) | 单个片段的请求、流式交付与已存储文件 |
| [`src/conditioning.ts`](src/conditioning.ts) | 请求图片、其顺序与标签 |
| [`src/creation.ts`](src/creation.ts) | 创建设置与参考图校验 |
| [`src/capabilities.ts`](src/capabilities.ts) | 创建能力载荷 |

`tests/` 目录覆盖生成、条件输入、创建设置和能力。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——共享项目层与生成后端。
- [`@dreamverse/generation-client`](../generation-client/README.zh.md)——`generate` 发送的后端请求。
- [`@dreamverse/assets-manager`](../assets-manager/README.zh.md)——保存片段文件的文件存储。
- [`@dreamverse/project`](../project/README.zh.md) 与 [`@dreamverse/multiverse`](../multiverse/README.zh.md)——调用 `generate` 的工作负载。

-----

<a id="model-experience"></a>
## 模型体验

### 片段请求图片

#### 模型看到什么

视频模型每个片段收到一个 `POST /v1/streamv2/generate` 请求，其中调用方的 `prompt` 保持不变，另有帧尺寸、帧数、可选种子，以及按 `segmentRequestImages` 顺序排列的请求图片：先是按选择顺序排列的选中参考图（`Picture 1` 到 `Picture K`），对于延续片段，再加上前一片段的末帧（`Picture K+1`）。延续的首帧（`initial_image`）镜头只携带末帧。`segmentImageLabels` 返回相同的标签，因此工作负载的提示词所命名的正是这些图片。

#### Token 影响

直接文本 token 为零：本包不向提示词添加任何文本。每个请求最多携带模型的 `maxReferenceImages` 张图片；在会延续片段的模型的参考图模式下，`referenceImageLimit` 为末帧保留一个图片位置。

#### KV Cache 影响

每个片段是独立请求：后端在请求之间不保留状态，因此片段之间的连续性只来自下一个请求携带的末帧图片。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **harness 侧没有生成队列**——每次 `generate` 调用都会立即发送其请求。并发的项目会发送并发请求，后端将它们串行处理，因此一个请求可能在没有队列位置提示的情况下等待其他项目的片段。
- **固定的片段数量**——`SEGMENT_COUNTS`（1 到 6）是代码中的参考列表；没有 `Config` 字段可以修改它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
