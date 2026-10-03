---
description: "DreamVerse 提示词增强：片段扩写、续写与整段改写，使用打包的 Markdown 模板和 Cerebras/Groq 提供方竞速。"
kind: "package-reference"
---

# @dreamverse/prompt-enhancer

[English](README.md) | 中文

## 概述

使用本包把用户的简短想法变成完整的视频提示词。它把一个想法扩写成独立片段，根据已完成的片段和可选的引导提示词续写故事，并改写整组片段提示词。每个请求同时发往 Cerebras 和 Groq，第一个有效回复胜出。提示词模板随包发布，并与 FastVideo 参考实现一致，参考图模板除外。两个 API 密钥都是必需的；本包没有提示词安全过滤器。

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

用提供方设置挂载该服务；DreamVerse 工作负载（workload）注入 `dreamversePromptEnhancer`。

### 最小配置

组合包从参考实现的环境变量填写服务商和模板字段，并直接设置 `timeoutMs`：

```yaml
- id: dreamverse-prompt-enhancer
  name: '@dreamverse/prompt-enhancer'
  config:
    cerebrasApiKey: !!js process.env.CEREBRAS_API_KEY
    groqApiKey: !!js process.env.GROQ_API_KEY
    timeoutMs: 20000
```

| 字段 | 环境变量 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `cerebrasApiKey` | `CEREBRAS_API_KEY` | 必填 | Cerebras API 密钥；缺失或为空时插件启动失败 |
| `groqApiKey` | `GROQ_API_KEY` | 必填 | Groq API 密钥；缺失或为空时插件启动失败 |
| `model` | `FASTVIDEO_PROMPT_MODEL` | `gpt-oss-120b` | 每个请求的逻辑模型 |
| `cerebrasModel` | `FASTVIDEO_PROMPT_CEREBRAS_MODEL` | 逻辑模型 | 发往 Cerebras 的模型名 |
| `groqModel` | `FASTVIDEO_PROMPT_GROQ_MODEL` | `openai/<logical model>` | 发往 Groq 的模型名 |
| `groqApiBaseUrl` | `FASTVIDEO_PROMPT_GROQ_API_BASE_URL` | `https://api.groq.com/openai/v1` | Groq 端点；为空时与参考实现一样选择 OpenAI SDK 端点 |
| `cerebrasBaseUrl` | `CEREBRAS_BASE_URL` | `https://api.cerebras.ai` | Cerebras 端点 |
| `enhanceSystemPromptPath` | `FASTVIDEO_PROMPT_ENHANCE_SYSTEM_PROMPT_PATH` | 打包文件 | 续写模板 |
| `autoSystemPromptPath` | `FASTVIDEO_PROMPT_AUTO_SYSTEM_PROMPT_PATH` | 打包文件 | 片段扩写模板 |
| `rewriteAllSystemPromptPath` | `FASTVIDEO_PROMPT_REWRITE_ALL_SYSTEM_PROMPT_PATH` | 打包文件 | 改写已有提示词的模板 |
| `rewriteUserSystemPromptPath` | `FASTVIDEO_PROMPT_REWRITE_USER_SYSTEM_PROMPT_PATH` | 打包文件 | 根据指令编写整组提示词的模板 |
| `timeoutMs` | 无 | 必填 | 一次提示词操作的截止时间，单位毫秒；两个组合包都设为 20000 |

缺少模板或密钥时，插件启动以参考消息失败。

### 操作

- `expandClip(prompt, options)` 根据用户想法写出一个独立片段的提示词。
- `continueVideo(prompt, options)` 在锁定片段之后写出下一个片段，依据是用户的引导提示词，或在传入 `null` 时推断出的下一个情节。`firstFrameLabel` 指明新片段起始所用的上一片段末帧。
- `rewriteRollout(prompts, options)` 改写浏览器的提示词窗口或项目的提示词；当没有剩余提示词时，根据指令编写一组新提示词。`continuedSegmentLabels` 指明第一个之后各片段的图片。
- `rewriteModel()` 返回项目日志和浏览器事件所报告的逻辑模型。

每个操作接受片段时长、生成模式（`t2va`、`i2v` 或 `ref2va`）、参考标签和中止信号，并在 `timeoutMs` 截止时间内运行。竞速失败时返回空提示词（改写时返回源提示词）并附带失败信息；不受支持的生成模式抛出 `PromptValueError`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`PromptEnhancer` 根据操作和生成模式选择模板与补全预算，每个功能构建自己的用户消息并校验回复。`ProviderRace` 同时在 Cerebras 和 Groq 上发起相同请求；功能接受的第一个回复胜出，另一个尝试被中止并等待其结束。`resources/` 中打包的模板与参考实现的 `templates/resources/` 逐字节相同，`ref2va_system_prompt.md` 除外，它遵循 [MiniMax H3 参考模式提示词指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)，并指明延续片段的首帧。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dreamversePromptEnhancer` 服务及其 Config |
| [`src/prompt-enhancer.ts`](src/prompt-enhancer.ts) | 模板与预算选择 |
| [`src/features/`](src/features/) | 三种操作：用户消息与回复校验 |
| [`src/llm/`](src/llm/) | 厂商客户端与提供方竞速 |
| [`src/templates/loader.ts`](src/templates/loader.ts) | 模板加载与路径覆盖 |
| [`resources/`](resources/) | 打包的模板 |

`tests/` 目录覆盖设置、模板、功能、竞速、厂商客户端，以及录制的参考 fixture。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——提示词增强在进程布局中的位置。
- [`@dreamverse/user-actions`](../user-actions/README.zh.md)——调用各个操作的 DreamVerse 用户操作。

-----

<a id="model-experience"></a>
## 模型体验

### 片段扩写请求

#### 模型看到什么

每次 `expandClip` 调用发送一个带两条消息的 chat-completions 请求。对 `t2va` 和 `i2v`，系统消息是片段扩写模板（[`resources/auto_extension_system_prompt.md`](resources/auto_extension_system_prompt.md)，或 `autoSystemPromptPath` 指向的文件）；对 `ref2va`，系统消息是 [`resources/ref2va_system_prompt.md`](resources/ref2va_system_prompt.md)。用户消息是 JSON 对象 `{"request": "Expand the user prompt into one complete <segment_duration_sec>-second audiovisual shot. Respond with valid JSON only as {\"prompt\": \"...\"}.", "segment_duration_sec": <seconds>, "user_prompt": "<idea>"}`，请求指明参考图时再加上 `protagonist_reference_labels`。回复必须是带非空 `prompt` 的 JSON 对象。

#### Token 影响

每次调用都包含模板和用户消息，`max_completion_tokens` 为 3000（`ref2va` 至少 8192），温度为 1.0。竞速把同一请求发给两个提供方，因此每次调用产生两次提供方请求。

#### KV Cache 影响

每次调用是独立请求。系统消息排在最前，并且对同一模板和生成模式逐字节稳定，因此提供方可以在多次调用之间复用该前缀；用户消息每次调用都不同。

### 续写请求

#### 模型看到什么

每次 `continueVideo` 调用发送续写模板（[`resources/next_segment_system_prompt.md`](resources/next_segment_system_prompt.md)，或 `enhanceSystemPromptPath` 指向的文件；`ref2va` 使用 `ref2va` 模板）和一个用户 JSON 对象，其中有 `request`、`segment_duration_sec`，以及在设置时附加的 `protagonist_reference_labels` 与 `first_frame_label`。`request` 文本在 `<locked_segments>` 中以 `segment_<i> (<start>-<end>s): "<prompt>"` 列出锁定片段，把引导提示词放进 `<conditioning_prompt>` 或要求模型推断下一个情节，在设置时把 `<first_frame_label>` 指明为上一片段的末帧，并要求返回 `{"next_prompt": "..."}`。

#### Token 影响

随故事增长：用户消息重复每个锁定片段的提示词，因此每次续写的输入 token 都比上一次多。补全预算、温度和双提供方成本与片段扩写请求相同。

#### KV Cache 影响

每次调用是独立请求，每个模板和模式下的系统前缀同样逐字节稳定。锁定片段列表以追加方式增长，但本包不发送缓存标识，用户消息每次调用都会变化。

### 整段改写请求

#### 模型看到什么

每次 `rewriteRollout` 调用发送改写模板（仍有源提示词时为 [`resources/rewrite_window_system_prompt.md`](resources/rewrite_window_system_prompt.md)，否则为 [`resources/rewrite_user_system_prompt.md`](resources/rewrite_user_system_prompt.md)，或它们的路径覆盖；`ref2va` 使用 `ref2va` 模板）。用户 JSON 对象携带 `mode`（`new_rollout` 或 `edit_existing_rollout`）、`request` 文本 `Rewrite all segment prompts with improved continuity and cinematic detail. Keep count and ordering identical.`、`user_instruction`、`desired_segment_count`、`segment_duration_sec`，以及整组 ID 与标签提示或带 `segment_prompts` 的 `current_rollout` 二者之一。设置时还会加上 `protagonist_reference_labels`、`continued_segment_first_frame_label` 和 `continued_segment_protagonist_reference_labels`。回复必须包含所请求数量的片段提示词。

#### Token 影响

每次调用都包含模板和整组的每个源提示词；回复在同样的补全预算内为每个片段携带一个提示词。双提供方成本与其他请求相同。

#### KV Cache 影响

每次调用是独立请求，每个模板和模式下的系统前缀逐字节稳定；用户消息每次调用都不同。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有请求日志**——本包把 `[ENHANCE]` 诊断写入其 logger，但既不记录渲染后的用户消息，也不记录提供方回复。由调用方记录输入和结果；DreamVerse 把它们记录在其项目日志中。
- **固定的采样与截止时间**——温度 1.0、3000 token 的补全预算以及竞速的阶段截止时间都是代码中的参考值；没有 `Config` 字段可以修改它们。
- **没有 `ref2va` 模板覆盖**——`ref2va` 模板总是从包内加载；没有路径字段可以替换它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
