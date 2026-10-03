---
description: "DreamVerse prompt enhancement: clip expansion, continuation, and rollout rewriting with packaged Markdown templates and a Cerebras/Groq provider race."
kind: "package-reference"
---

# @dreamverse/prompt-enhancer

English | [中文](README.zh.md)

## Summary

Use this package to turn a short user idea into a complete video prompt. It expands one idea into a standalone clip, continues a story from its completed segments and an optional steer prompt, and rewrites a whole sequence of segment prompts. Each request goes to Cerebras and Groq at once, and the first valid reply wins. The prompt templates ship with the package and match the FastVideo reference, except the reference-image template. Both API keys are required; the package has no prompt safety filter.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service with the provider settings; the DreamVerse workload injects `dreamversePromptEnhancer`.

### Minimal configuration

The bundles fill the provider and template fields from the reference environment variables and set `timeoutMs` directly:

```yaml
- id: dreamverse-prompt-enhancer
  name: '@dreamverse/prompt-enhancer'
  config:
    cerebrasApiKey: !!js process.env.CEREBRAS_API_KEY
    groqApiKey: !!js process.env.GROQ_API_KEY
    timeoutMs: 20000
```

| Field | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `cerebrasApiKey` | `CEREBRAS_API_KEY` | required | Cerebras API key; absent or blank fails plugin start |
| `groqApiKey` | `GROQ_API_KEY` | required | Groq API key; absent or blank fails plugin start |
| `model` | `FASTVIDEO_PROMPT_MODEL` | `gpt-oss-120b` | Logical model of every request |
| `cerebrasModel` | `FASTVIDEO_PROMPT_CEREBRAS_MODEL` | the logical model | Model name sent to Cerebras |
| `groqModel` | `FASTVIDEO_PROMPT_GROQ_MODEL` | `openai/<logical model>` | Model name sent to Groq |
| `groqApiBaseUrl` | `FASTVIDEO_PROMPT_GROQ_API_BASE_URL` | `https://api.groq.com/openai/v1` | Groq endpoint; blank selects the OpenAI SDK endpoint, as in the reference |
| `cerebrasBaseUrl` | `CEREBRAS_BASE_URL` | `https://api.cerebras.ai` | Cerebras endpoint |
| `enhanceSystemPromptPath` | `FASTVIDEO_PROMPT_ENHANCE_SYSTEM_PROMPT_PATH` | packaged file | Continuation template |
| `autoSystemPromptPath` | `FASTVIDEO_PROMPT_AUTO_SYSTEM_PROMPT_PATH` | packaged file | Clip expansion template |
| `rewriteAllSystemPromptPath` | `FASTVIDEO_PROMPT_REWRITE_ALL_SYSTEM_PROMPT_PATH` | packaged file | Template for rewriting existing prompts |
| `rewriteUserSystemPromptPath` | `FASTVIDEO_PROMPT_REWRITE_USER_SYSTEM_PROMPT_PATH` | packaged file | Template for writing a sequence from an instruction |
| `timeoutMs` | none | required | Deadline of one prompt operation in milliseconds; both bundles set 20000 |

A missing template or key fails plugin start with the reference message.

### Operations

- `expandClip(prompt, options)` writes one standalone clip prompt from a user idea.
- `continueVideo(prompt, options)` writes the next segment after the locked segments, from a user steer prompt or, for `null`, an inferred next beat. `firstFrameLabel` names the previous segment's last frame that the new segment starts from.
- `rewriteRollout(prompts, options)` rewrites the browser's prompt window or the project's prompts, or writes a new sequence from an instruction when no prompts remain. `continuedSegmentLabels` names the images of the segments after the first.
- `rewriteModel()` returns the logical model that project logs and browser events report.

Each operation takes the segment duration, the generation mode (`t2va`, `i2v`, or `ref2va`), the reference labels, and an abort signal, and runs under the `timeoutMs` deadline. A failed race returns an empty prompt (or the source prompts for a rollout) with the failure; an unsupported generation mode throws `PromptValueError`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`PromptEnhancer` selects the template and the completion budget from the operation and the generation mode, and each feature builds its user message and validates the reply. `ProviderRace` starts the same request on Cerebras and Groq at once; the first reply that the feature accepts wins, and the other attempt is aborted and awaited. The packaged templates in `resources/` are byte-identical copies of the reference `templates/resources/`, except `ref2va_system_prompt.md`, which follows the [MiniMax H3 reference-mode prompt guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md) and names a continued segment's first frame.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The `dreamversePromptEnhancer` service and its Config |
| [`src/prompt-enhancer.ts`](src/prompt-enhancer.ts) | Template and budget selection |
| [`src/features/`](src/features/) | The three operations: user messages and reply validation |
| [`src/llm/`](src/llm/) | The vendor client and the provider race |
| [`src/templates/loader.ts`](src/templates/loader.ts) | Template loading and path overrides |
| [`resources/`](resources/) | The packaged templates |

The `tests/` directory covers settings, templates, features, the race, the vendor client, and recorded reference fixtures.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — where prompt enhancement sits in the process layout.
- [`@dreamverse/user-actions`](../user-actions/README.md) — the DreamVerse actions that call each operation.

-----

<a id="model-experience"></a>
## Model Experience

### Clip expansion request

#### What the model sees

Each `expandClip` call sends one chat-completions request with two messages. The system message is the clip expansion template ([`resources/auto_extension_system_prompt.md`](resources/auto_extension_system_prompt.md), or the file at `autoSystemPromptPath`) for `t2va` and `i2v`, and [`resources/ref2va_system_prompt.md`](resources/ref2va_system_prompt.md) for `ref2va`. The user message is the JSON object `{"request": "Expand the user prompt into one complete <segment_duration_sec>-second audiovisual shot. Respond with valid JSON only as {\"prompt\": \"...\"}.", "segment_duration_sec": <seconds>, "user_prompt": "<idea>"}`, plus `protagonist_reference_labels` when the request names reference images. The reply must be a JSON object with a nonblank `prompt`.

#### Token effect

The template plus the user message on every call, with `max_completion_tokens` 3000 (at least 8192 for `ref2va`) and temperature 1.0. The race sends the same request to both providers, so each call costs two provider requests.

#### KV Cache effect

Independent request per call. The system message comes first and stays byte-stable for one template and generation mode, so a provider can reuse that prefix across calls; the user message changes per call.

### Continuation request

#### What the model sees

Each `continueVideo` call sends the continuation template ([`resources/next_segment_system_prompt.md`](resources/next_segment_system_prompt.md), or the file at `enhanceSystemPromptPath`; the `ref2va` template for `ref2va`) and a user JSON object with `request`, `segment_duration_sec`, and, when set, `protagonist_reference_labels` and `first_frame_label`. The `request` text lists the locked segments as `segment_<i> (<start>-<end>s): "<prompt>"` inside `<locked_segments>`, adds the steer prompt inside `<conditioning_prompt>` or asks the model to infer the next beat, names `<first_frame_label>` as the last frame of the previous segment when set, and asks for `{"next_prompt": "..."}`.

#### Token effect

Grows with the story: the user message repeats every locked segment prompt, so each continuation costs more input tokens than the one before it. The completion budget, temperature, and two-provider cost match the clip expansion request.

#### KV Cache effect

Independent request per call with the same byte-stable system prefix per template and mode. The locked segment list grows by appending, but the package sends no cache identifier, and the user message changes on every call.

### Rollout rewrite request

#### What the model sees

Each `rewriteRollout` call sends the rewrite template ([`resources/rewrite_window_system_prompt.md`](resources/rewrite_window_system_prompt.md) when source prompts remain, [`resources/rewrite_user_system_prompt.md`](resources/rewrite_user_system_prompt.md) otherwise, or their path overrides; the `ref2va` template for `ref2va`). The user JSON object carries `mode` (`new_rollout` or `edit_existing_rollout`), the `request` text `Rewrite all segment prompts with improved continuity and cinematic detail. Keep count and ordering identical.`, `user_instruction`, `desired_segment_count`, `segment_duration_sec`, and either the rollout ID and label hints or `current_rollout` with its `segment_prompts`. It adds `protagonist_reference_labels`, `continued_segment_first_frame_label`, and `continued_segment_protagonist_reference_labels` when set. The reply must hold the requested number of segment prompts.

#### Token effect

The template plus every source prompt of the rollout on each call; the reply carries one prompt per segment within the same completion budget. The two-provider cost matches the other requests.

#### KV Cache effect

Independent request per call with a byte-stable system prefix per template and mode; the user message changes per call.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No request log** — the package writes `[ENHANCE]` diagnostics to its logger but records neither the rendered user message nor the provider reply. Callers record the inputs and results; DreamVerse records them in its project log.
- **Fixed sampling and deadlines** — temperature 1.0, the 3000-token completion budget, and the race's stage deadlines are reference values in code; no `Config` field changes them.
- **No `ref2va` template override** — the `ref2va` template always loads from the package; no path field replaces it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
