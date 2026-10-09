---
description: "Service Provider of the DreamVerse t2va render mode: registers a renderer into dvT2va for the FastH3 8-Step V2 text-to-video model behind a FastVideo streaming_v2 server, with its prompt skill fasth3-t2va-prompting."
kind: "package-reference"
---

# @dv/fasth3-t2va

English | [中文](README.zh.md)

## Summary

Use this package to render `t2va` shots, from a prompt only, with the FastH3 8-Step V2 text-to-video model (`FastVideo/FastVideo-FastH3-8-Step-V2`) behind a FastVideo streaming_v2 server. The plugin is a Service Provider of `dvT2va` from `@dv/render-modes`: it registers a `FastH3T2vaRenderer` under its `backend` name, and the renderer reads the model facts from the server with no reference images, reports whether the server is ready, and sends each render without images. While the DSH skill registry is mounted, it registers the skill `fasth3-t2va-prompting`: the model's limits and prompt rules for `dv_shot_render_t2va`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the base URL of a streaming_v2 server that serves the text-to-video model. The DreamVerse bundle mounts it as row `dv-fasth3-t2va` only when `DV_T2VA_BACKEND_URL` is set; without it, the agent has no `dv_shot_render_t2va` tool:

```yaml
- id: dv-fasth3-t2va
  name: '@dv/fasth3-t2va'
  disabled: !!js "!process.env.DV_T2VA_BACKEND_URL"
  config:
    baseUrl: !!js process.env.DV_T2VA_BACKEND_URL
```

| Field | Default | Meaning |
| --- | --- | --- |
| `backend` | `fasth3` | The backend name the renderer is registered under in `dvT2va`; the `backend` argument of `dv_shot_render_t2va` names it. Give each row of this plugin its own name to serve several servers side by side |
| `baseUrl` | required | HTTP base URL of the FastVideo streaming_v2 server that serves the text-to-video model; the bundle reads `DV_T2VA_BACKEND_URL` |
| `gpuSecondsPerVideoSecond` | `1.5` | GPU seconds per rendered video second on this server; `model()` reports it for the GPU estimate before a render |

Mount [`@dv/render-modes`](../render-modes/README.md) first. While the renderer is registered, `@dv/shot-render` registers `shot.render_t2va` (tool `dv_shot_render_t2va`) with this backend among the values of its `backend` argument. Mount the DSH skill registry (`@deepseek-ai/dsh-skill`) as well so that the agent can load the prompt skill.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The streaming_v2 client of `@dreamverse/generation-client` does the HTTP work: `model()` reads `GET /v1/streamv2/capabilities`, `ready()` reads `GET /v1/streamv2/health`, and `render()` sends one streaming_v2 render request and returns the server's event stream. `model()` copies the server's facts and reports `maxReferenceImages` 0 and an empty `imageLabels`, because a text-to-video model takes no reference images. `render()` sends the prompt with an empty image list, asks for the server's last frame, and passes `signal` on to cancel the HTTP request. The client lives in an isolated `dreamverseGeneration` scope, so the host gains no `dreamverseGeneration` service. The plugin registers the renderer through `ctx.dvT2va.register` inside `ctx.effect`, so disposing the plugin removes the renderer. The skill registers through `ctx.skills.register` inside `ctx.inject(['skills'], …)`, so it appears when the skill registry mounts and leaves when the provider or the registry is removed.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `FastH3T2vaRenderer`, `Config`, and the plugin `apply`, which registers the renderer and the skill |
| [`skills/fasth3-t2va-prompting.md`](skills/fasth3-t2va-prompting.md) | The skill body: the DreamVerse connection section, then the official MiniMax-H3 prompt guide (T2VA / I2VA / FL2VA / L2VA) copied unchanged |
| [`tests/fasth3-t2va.spec.ts`](tests/fasth3-t2va.spec.ts) | A Loader composition with the skill registry against a fake streaming_v2 server; an opt-in test renders against the server named by `DV_T2VA_BACKEND_URL` |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/render-modes`](../render-modes/README.md): the `dvT2va` registry that this package registers into.
- [`@dv/shot-render`](../shot-render/README.md): the Consumer, with the tool `dv_shot_render_t2va`.
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.md): the streaming_v2 client.
- [`dsh-tool-skill`](../../skill/tool-skill/README.md): how the agent sees the skill catalog and loads a skill.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt skill

#### What the model sees

While the skill registry is mounted, the skill catalog that `dsh-tool-skill` renders lists the catalog entry below. When the agent calls the `skill` tool with `fasth3-t2va-prompting`, the tool result carries `skills/fasth3-t2va-prompting.md`: a DreamVerse connection section (use the guide's T2VA mode, so the prompt begins directly with the three fields `integrated_multimodal_description`, `overall_soundscape` and `non_diegetic_music`; one DreamVerse shot is one target video; describe everything in words; `duration_sec` from 5 to 15), followed by the official MiniMax-H3 prompt guide `VIDEO_PROMPT_WRITING_GUIDE_base_en.md` copied unchanged.

##### Catalog entry

```markdown
- `fasth3-t2va-prompting`: Model limits and prompt rules for dv_shot_render_t2va (render mode t2va): the three prompt fields, shot changes, camera motion, speakers and dialogue, sound and music.
```

#### Token effect

About 40 tokens in the catalog while the provider and the skill registry are mounted, and about 4,200 tokens each time the agent loads the skill.

#### KV Cache effect

Mounting or removing the provider changes the skill list, and `dsh-tool-skill` appends a replacement catalog; a loaded skill body is appended as a tool result. Both leave the cached prefix before them intact.

### Render tool facts

#### What the model sees

The model facts of this provider shape `dv_shot_render_t2va`: its results report `model` (the server's model ID), `frame_width`, `frame_height` and `num_frames`, and its refusals name the allowed aspect ratios, resolutions and durations, and the GPU estimate from `gpuSecondsPerVideoSecond`. While a `t2va` renderer is registered, the refusal of a `dv_shot_render_ref2va` call without a reference image also points the agent to `dv_shot_render_t2va`.

#### Token effect

This package adds no tokens beyond the tool results and refusals that `@dv/shot-render` writes.

#### KV Cache effect

Registering or removing the renderer changes the values of the `backend` argument of `dv_shot_render_t2va`, or adds or removes the tool, and invalidates the cached prefix from the tool section on.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No identity across shots**: the model sees only the prompt, so a subject keeps its look only as far as the same words describe it; a face that must stay the same needs `dv_shot_render_ref2va` with a reference image.
- **No start from an earlier shot**: `T2vaRequest` carries no image, so only `dv_shot_render_ref2va` (`continue_from`) starts a shot from the last still of an earlier shot.
- **Fixed limits in the skill**: `skills/fasth3-t2va-prompting.md` states 5 to 15 seconds, while `model()` reads the duration range from the server; a server with another range makes the skill disagree with the refusals of `dv_shot_render_t2va`.
- **One skill for several rows**: two rows of this plugin register the same skill name; the skill registry keeps the first and ignores the second, so removing the first row removes the skill while the second row's renderer stays registered.
