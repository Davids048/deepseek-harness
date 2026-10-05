---
description: "以 Cordis 插件实现的 DreamVerse 用户操作：序列生成、单个片段、续写与 Auto Extension，以及序列改写；每个操作准备提示词并生成片段。"
kind: "package-reference"
---

# @dreamverse/user-actions

[English](README.md) | 中文

## 概述

这些插件决定 DreamVerse 用户操作时会发生什么：从预设或想法开始一个序列、生成一个片段、用引导提示词或 Auto Extension 续写故事，或改写整个序列。每个操作准备提示词（适用增强时经过提示词增强器），生成片段，并记录已完成的序列。每个操作都是独立插件，因此 profile 可以省略其中任何一个。增强失败会让操作失败，而不是回退到用户的文本。 已被 [video harness](../../../docs/subsystems/video-harness.zh.md) 取代。

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

在 `@dreamverse/project` 之后挂载每个操作插件；每个插件在其生命周期内把处理器注册到 `dreamverseProjects`，且没有配置。

### 最小配置

```yaml
- id: dreamverse-action-generate-video-sequence
  name: '@dreamverse/user-actions/generate-video-sequence'
- id: dreamverse-action-generate-single-clip
  name: '@dreamverse/user-actions/generate-single-clip'
- id: dreamverse-action-continue-video
  name: '@dreamverse/user-actions/continue-video'
- id: dreamverse-action-rewrite-video-sequence
  name: '@dreamverse/user-actions/rewrite-video-sequence'
```

| 插件入口 | 操作类型 | 行为 |
| --- | --- | --- |
| `@dreamverse/user-actions/generate-video-sequence` | `generate_video_sequence` | 把种子想法扩写成一个序列，或生成预设准备好的提示词 |
| `@dreamverse/user-actions/generate-single-clip` | `simple_generate` | 生成一个独立片段，并把它记录为已完成序列 |
| `@dreamverse/user-actions/continue-video` | `append_prompt`、`auto_extend` | 根据引导提示词追加一个片段，Auto Extension 时根据推断出的下一个情节追加 |
| `@dreamverse/user-actions/rewrite-video-sequence` | `rewrite_seed_prompts` | 改写提示词窗口或已完成序列，并生成其替代内容 |

在提交视频之前，`append_prompt` 先向浏览器报告 `prompt_received`，增强开启时再报告 `prompt_enhancing`，然后报告 `prompt_ready`；增强后的 `simple_generate` 会报告全部三个事件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个处理器接收项目、操作载荷和项目拥有的参考图副本。它用 `project.buildVideoSegment` 构建片段，把片段注册进一个生成计划，运行该计划，并记录已完成的序列。序列和改写操作共享 `src/rewritten-sequence.ts`，它移植参考实现的 `_generate_rewritten_sequence`。

| 文件 | 内容 |
| --- | --- |
| [`src/generate-video-sequence.ts`](src/generate-video-sequence.ts) | `generate_video_sequence` |
| [`src/generate-single-clip.ts`](src/generate-single-clip.ts) | `simple_generate` |
| [`src/continue-video.ts`](src/continue-video.ts) | `append_prompt` 与 `auto_extend` |
| [`src/rewrite-video-sequence.ts`](src/rewrite-video-sequence.ts)、[`src/rewritten-sequence.ts`](src/rewritten-sequence.ts) | `rewrite_seed_prompts` 与共享的整组改写流程 |

`tests/` 目录在使用假服务的项目上运行每个操作。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dreamverse/project`](../project/README.zh.md)——准入命令并运行每个轮次的项目。
- [`@dreamverse/prompt-enhancer`](../prompt-enhancer/README.zh.md)——各操作发给语言模型的请求。
- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——DreamVerse 工作负载（workload）。

-----

<a id="model-experience"></a>
## 模型体验

### 单片段提示词

#### 模型看到什么

对 `simple_generate`，当载荷的 `enhancement_enabled` 为 false 时，视频模型收到用户原样书写的 `prompt`。为 true 时，操作先把提示词连同项目的片段时长、生成模式和参考标签发给 `expandClip`，视频模型收到扩写后的提示词。

#### Token 影响

适用增强时一次片段扩写请求，然后一次片段请求。

#### KV Cache 影响

独立请求；操作不在调用之间保留会话。

### 序列提示词

#### 模型看到什么

对 `generate_video_sequence`，`prompt` 中的种子想法作为一组新的 `segment_count` 条提示词交给 `rewriteRollout`；没有种子时，预设准备好的 `prompts` 原样到达视频模型，每个片段一条。对 `rewrite_seed_prompts`，`rewriteRollout` 总会运行：它用 `rewrite_instruction` 改写浏览器的 `prompt_window_prompts` 或已完成序列的提示词，并指明所生成序列的参考标签和延续片段标签。

#### Token 影响

每个种子或改写一次整组请求，其大小随源提示词数量增长，然后每个片段一次片段请求。预设提示词不产生语言模型请求。

#### KV Cache 影响

独立请求；每次改写都会再次发送完整的源提示词列表。

### 续写提示词

#### 模型看到什么

对增强关闭的 `append_prompt`，视频模型收到原样书写的引导提示词。增强开启时，以及 `auto_extend` 的所有情况下，操作向 `continueVideo` 发送已完成序列的提示词作为锁定片段、引导提示词（Auto Extension 时为 `null`）、下一个片段序号，以及请求图片的标签；当片段从上一片段的末帧开始时，还包括首帧标签。

#### Token 影响

一次续写请求，其锁定片段列表包含每个已完成的提示词，因此成本随故事增长；然后一次片段请求。

#### KV Cache 影响

独立请求；每次续写都会完整地再次发送锁定片段。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **增强失败后没有回退**——当提供方竞速失败、发生回退或返回空提示词时，操作以 `Prompt extension failed for this request.` 失败，而不是根据用户的文本生成。
- **预设长度**——当预设提供的提示词少于项目的 `segment_count` 时，`generate_video_sequence` 失败。
- **已被 video harness 取代**——[video harness](../../../docs/subsystems/video-harness.zh.md) 用video harness 的 skill 与工具（`@video-harness/agent`、`@video-harness/tools`）取代了本包；本包仅为 `dreamverse` 与 `dreamverse-multiverse` profile 保留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
