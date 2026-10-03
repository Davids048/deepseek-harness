---
description: "FastVideo streaming_v2 生成后端的客户端：所服务模型的事实、就绪状态，以及带服务器发送事件和错误的单个流式片段请求。"
kind: "package-reference"
---

# @dreamverse/generation-client

[English](README.md) | 中文

## 概述

使用本包访问 DreamVerse 用于生成视频的 FastVideo 生成后端。它读取所服务模型的事实（时长、帧尺寸、参考图上限），报告后端是否就绪，并为每个请求流式传输一个片段：先是末帧，然后是分块的 fragmented MP4，最后是耗时。后端错误变为带类型的错误，中止请求会立即取消它。后端在请求之间不保留状态，因此调用方每次请求都要发送所有条件图片。

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

用后端的基础 URL 挂载该服务；DreamVerse 工作负载（workload）注入 `dreamverseGeneration`。

### 最小配置

```yaml
- id: dreamverse-generation-client
  name: '@dreamverse/generation-client'
  config:
    baseUrl: http://127.0.0.1:8029
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | 必填 | 生成后端的 HTTP 基础 URL |

`scripts/dreamverse/launch-generation.sh` 运行 `fastvideo serve --config scripts/dreamverse/h3-ref2va.serve.yaml`。配置中的 `streaming_v2:` 块选择 FastVideo 的 streaming_v2 API，其 `generator:` 块以预设的默认采样加载 MiniMax H3 Ref2VA。

### 服务

- `model()` 读取 `GET /v1/streamv2/capabilities` 并缓存第一次成功的结果。它为所服务的 H3 Ref2VA 模型补充 harness 自己的事实：生成模式 `{ref2va: 'reference_images'}`、没有不受支持的模式、取自 `frame_sizes` 键的宽高比与分辨率、`usesPreviousFrame: true`，以及 N = `max_reference_images` 时的标签 `Picture 1` 到 `Picture N`。
- `ready()` 读取 `GET /v1/streamv2/health`，对其他状态码或后端不可达抛出异常。
- `generateSegment(request)` 发送一个 `POST /v1/streamv2/generate`，并按到达顺序产出 `last_frame`、`video_start`、`chunk` 和 `done` 输出。HTTP 400 和 `error` 事件以 `GenerationSegmentError(message, errorType, isValueError)` 拒绝，其中 `isValueError` 对 `invalid_request` 为 true。在 `done` 之前结束的流以 `Error` 拒绝。离开迭代或中止 `request.signal` 会取消 HTTP 请求；中止以 `signal.reason` 拒绝。

本包还导出共享错误类型 `DreamverseValueError` 和 `ProjectValidationError`，它们代表参考实现中 Python `ValueError` 的情形。

### 后端 API

API 归 FastVideo 所有；客户端使用其中三个路由。服务器接受请求期间，`GET /v1/streamv2/health` 返回 200 `{"status": "ready"}`。`GET /v1/streamv2/capabilities` 返回模型的事实：

```json
{
  "model_id": "h3-ref2va",
  "name": "H3 Ref2AV",
  "min_segment_duration_sec": 5,
  "max_segment_duration_sec": 15,
  "max_reference_images": 9,
  "max_reference_aspect_ratio": 4.0,
  "frame_sizes": {"16:9": {"720p": [1344, 768]}},
  "num_frames_by_duration_sec": {"5": 124, "6": 158, "15": 362}
}
```

`max_reference_images` 计入每张请求图片，包括延续片段的首帧。`num_frames_by_duration_sec` 包含从最小值到最大值的每个整数时长。

`POST /v1/streamv2/generate` 接受 `{"prompt", "reference_images", "width", "height", "num_frames", "seed"?, "return_last_frame"}`，并以 `text/event-stream` 响应，其中每条 `event: <name>` 记录带一行 JSON `data:`，顺序如下：

| 事件 | 数据 |
| --- | --- |
| `last_frame` | `{"data": <base64 PNG of the final decoded frame>}`，仅当 `return_last_frame` 为 true 时发送 |
| `video_start` | `{"mime": str}` |
| `video_chunk` | `{"data": <base64 fMP4 bytes>}`，一个或多个；拼接后是一个 fragmented MP4 |
| `done` | `{"timings": {"generation_ms": float, "e2e_latency_ms": float}}`；响应结束 |
| `error` | `{"code": "invalid_request" \| "generation_failed", "message": str}`；响应结束 |

在生成开始前发现的请求问题返回 HTTP 400 `{"code": "invalid_request", "message": str}`。后端在并发请求之间串行生成，并且即使客户端取消，也会完成已经开始生成的片段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

该服务的每次调用都使用 `fetch`。`generateSegment` 逐行解析服务器发送事件流，并在每个事件完整时立即产出对应输出，因此调用方可以在后端仍在生成时转发视频分块。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dreamverseGeneration` 服务：模型事实、就绪状态与片段请求 |
| [`src/generation-stream.ts`](src/generation-stream.ts) | 请求体与事件流解析器 |
| [`src/types.ts`](src/types.ts) | 模型事实、片段请求与片段输出 |
| [`src/errors.ts`](src/errors.ts) | 共享错误类型 |

`tests/` 目录让客户端连接一个扮演后端的本地 HTTP 服务器来测试它。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——进程布局中的生成后端。
- [`@dreamverse/segment-generation`](../segment-generation/README.zh.md)——排列请求图片并存储结果。

-----

<a id="model-experience"></a>
## 模型体验

### 片段生成请求

#### 模型看到什么

视频模型收到 `generateSegment` 构建的请求体：保持不变的 `prompt`、按调用方顺序以 base64 图片字节表示的 `reference_images`、`width`、`height`、`num_frames`、仅在调用方设置时才发送的 `seed`，以及 `return_last_frame`。提示词按列表顺序把这些图片称为 `Picture 1`、`Picture 2` 等。

#### Token 影响

直接文本 token 为零：客户端不向调用方的提示词添加任何文本。

#### KV Cache 影响

每个片段是独立请求：后端在请求之间不保留状态，客户端也不发送任何会话或缓存标识。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **模型事实从不刷新**——`model()` 在插件生命周期内保留第一次成功的能力结果。若后端以另一个模型重启，harness 会一直保留旧事实，直到插件重新加载。
- **没有请求截止时间**——客户端不为能力、健康或生成请求设置超时。停止发送事件的后端会一直占用请求，直到调用方中止它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
