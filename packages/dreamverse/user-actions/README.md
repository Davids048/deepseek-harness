---
description: "The DreamVerse user actions as Cordis plugins: sequence generation, single clips, continuation and Auto Extension, and sequence rewrites, each preparing prompts and generating segments."
kind: "package-reference"
---

# @dreamverse/user-actions

English | [中文](README.zh.md)

## Summary

These plugins decide what happens when a DreamVerse user acts: start a sequence from a preset or an idea, generate one clip, continue the story with a steer prompt or by Auto Extension, or rewrite the whole sequence. Each action prepares the prompts, through the prompt enhancer when enhancement applies, generates the segments, and records the completed sequence. Each action is a separate plugin, so a profile can leave one out. An enhancement failure fails the action instead of falling back to the user's text. Superseded by the [video harness](../../../docs/subsystems/video-harness.md).

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

Mount each action plugin after `@dreamverse/project`; each registers its handler into `dreamverseProjects` for the plugin's lifetime and has no configuration.

### Minimal configuration

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

| Plugin entry | Action types | Behavior |
| --- | --- | --- |
| `@dreamverse/user-actions/generate-video-sequence` | `generate_video_sequence` | Expands a seed idea into a sequence, or generates the preset's prepared prompts |
| `@dreamverse/user-actions/generate-single-clip` | `simple_generate` | Generates one independent clip and records it as the completed sequence |
| `@dreamverse/user-actions/continue-video` | `append_prompt`, `auto_extend` | Appends one segment from a steer prompt, or from an inferred next beat for Auto Extension |
| `@dreamverse/user-actions/rewrite-video-sequence` | `rewrite_seed_prompts` | Rewrites the prompt window or the completed sequence and generates its replacement |

Before video submission, `append_prompt` reports `prompt_received`, then `prompt_enhancing` when enhancement is on, then `prompt_ready` to the browser; an enhanced `simple_generate` reports all three.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each handler receives the project, the action payload, and the project-owned reference copies. It builds its segments with `project.buildVideoSegment`, registers them in a generation plan, runs the plan, and records the completed sequence. The sequence and rewrite actions share `src/rewritten-sequence.ts`, the port of the reference `_generate_rewritten_sequence`.

| File | Content |
| --- | --- |
| [`src/generate-video-sequence.ts`](src/generate-video-sequence.ts) | `generate_video_sequence` |
| [`src/generate-single-clip.ts`](src/generate-single-clip.ts) | `simple_generate` |
| [`src/continue-video.ts`](src/continue-video.ts) | `append_prompt` and `auto_extend` |
| [`src/rewrite-video-sequence.ts`](src/rewrite-video-sequence.ts), [`src/rewritten-sequence.ts`](src/rewritten-sequence.ts) | `rewrite_seed_prompts` and the shared rollout workflow |

The `tests/` directory runs each action on a project with fake services.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dreamverse/project`](../project/README.md) — the project that admits commands and runs each round.
- [`@dreamverse/prompt-enhancer`](../prompt-enhancer/README.md) — the requests that each action sends to the language model.
- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the DreamVerse workload.

-----

<a id="model-experience"></a>
## Model Experience

### Single-clip prompt

#### What the model sees

For `simple_generate`, the video model receives the user's `prompt` as written when the payload's `enhancement_enabled` is false. When it is true, the action first sends the prompt to `expandClip` with the project's segment duration, generation mode, and reference labels, and the video model receives the expanded prompt.

#### Token effect

One clip expansion request when enhancement applies, then one segment request.

#### KV Cache effect

Independent requests; the action keeps no conversation between calls.

### Sequence prompts

#### What the model sees

For `generate_video_sequence`, a seed idea in `prompt` goes to `rewriteRollout` as a new sequence of `segment_count` prompts; without a seed, the preset's prepared `prompts` reach the video model unchanged, one per segment. For `rewrite_seed_prompts`, `rewriteRollout` always runs: it rewrites the browser's `prompt_window_prompts`, or the completed sequence's prompts, with the `rewrite_instruction`, and it names the reference and continued-segment labels of the generated sequence.

#### Token effect

One rollout request per seed or rewrite, whose size grows with the number of source prompts, then one segment request per segment. Preset prompts cost no language-model request.

#### KV Cache effect

Independent requests; each rewrite sends the complete source prompt list again.

### Continuation prompt

#### What the model sees

For `append_prompt` with enhancement off, the video model receives the steer prompt as written. With enhancement on, and always for `auto_extend`, the action sends `continueVideo` the completed sequence's prompts as the locked segments, the steer prompt or `null` for Auto Extension, the next segment index, and the labels of the request images, including the first-frame label when the segment starts from the previous segment's last frame.

#### Token effect

One continuation request whose locked-segment list holds every completed prompt, so the cost grows with the story, then one segment request.

#### KV Cache effect

Independent requests; the locked segments are sent again in full on each continuation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No fallback after an enhancement failure** — when the provider race fails, falls back, or returns an empty prompt, the action fails with `Prompt extension failed for this request.` instead of generating from the user's text.
- **Preset length** — `generate_video_sequence` fails when the preset provides fewer prompts than the project's `segment_count`.
- **Superseded by the video harness** — the [video harness](../../../docs/subsystems/video-harness.md) replaces this package with the video harness skills and tools (`@video-harness/agent`, `@video-harness/tools`); the package remains only for the `dreamverse` and `dreamverse-multiverse` profiles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
