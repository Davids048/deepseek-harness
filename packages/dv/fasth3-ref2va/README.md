---
description: "Service Provider of the DreamVerse ref2va render mode: registers a renderer into dvRef2va for a FastH3 Ref2VA model behind a FastVideo streaming_v2 server, with its prompt skill fasth3-ref2va-prompting."
kind: "package-reference"
---

# @dv/fasth3-ref2va

English | [中文](README.zh.md)

## Summary

Use this package to render `ref2va` shots, from a prompt and reference images, with a FastH3 Ref2VA model behind a FastVideo streaming_v2 server. The plugin is a Service Provider of `dvRef2va` from `@dv/render-modes`: it registers a `FastH3Ref2vaRenderer` under its `backend` name, and the renderer reads the model facts from the server, reports whether the server is ready, and sends each render with the reference images first and the first frame after them. While the DSH skill registry is mounted, it registers the skill `fasth3-ref2va-prompting`: the model's limits and prompt rules for `dv_shot_render_ref2va`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the base URL of the streaming_v2 server. The DreamVerse bundle mounts it as row `dv-fasth3-ref2va`:

```yaml
- id: dv-fasth3-ref2va
  name: '@dv/fasth3-ref2va'
  config:
    baseUrl: !!js process.env.DV_BACKEND_URL || 'http://127.0.0.1:8029'
```

| Field | Default | Meaning |
| --- | --- | --- |
| `backend` | `fasth3` | The backend name the renderer is registered under in `dvRef2va`; the `backend` argument of `dv_shot_render_ref2va` names it. Give each row of this plugin its own name to serve several servers side by side |
| `baseUrl` | required | HTTP base URL of the FastVideo streaming_v2 server; the bundle reads `DV_BACKEND_URL` and falls back to `http://127.0.0.1:8029` |
| `gpuSecondsPerVideoSecond` | `4` | GPU seconds per rendered video second on this server; `model()` reports it for the GPU estimate before a render |

Mount [`@dv/render-modes`](../render-modes/README.md) first. While the renderer is registered, `@dv/shot-render` registers `shot.render_ref2va` (tool `dv_shot_render_ref2va`) with this backend among the values of its `backend` argument. Mount the DSH skill registry (`@deepseek-ai/dsh-skill`) as well so that the agent can load the prompt skill.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The streaming_v2 client of `@dreamverse/generation-client` does the HTTP work: `model()` reads `GET /v1/streamv2/capabilities`, `ready()` reads `GET /v1/streamv2/health`, and `render()` sends one streaming_v2 render request and returns the server's event stream. The server counts the first frame among its request images, so `model()` reports `maxReferenceImages` as one fewer than the server's `max_reference_images` and keeps one `imageLabels` entry per server image (`Picture 1` to `Picture N`); the first frame takes the label after the last reference image. `render()` sends the reference images in input order, appends the first frame when the request carries one, asks for the server's last frame, and passes `signal` on to cancel the HTTP request. The client lives in an isolated `dreamverseGeneration` scope, so the host gains no `dreamverseGeneration` service. The plugin registers the renderer through `ctx.dvRef2va.register` inside `ctx.effect`, so disposing the plugin removes the renderer. The skill registers through `ctx.skills.register` inside `ctx.inject(['skills'], …)`, so it appears when the skill registry mounts and leaves when the provider or the registry is removed.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `FastH3Ref2vaRenderer`, `Config`, and the plugin `apply`, which registers the renderer and the skill |
| [`skills/fasth3-ref2va-prompting.md`](skills/fasth3-ref2va-prompting.md) | The skill body: the DreamVerse connection section, then the official MiniMax-H3 full-reference prompt guide copied unchanged |
| [`tests/fasth3-ref2va.spec.ts`](tests/fasth3-ref2va.spec.ts) | A Loader composition with the skill registry against a fake streaming_v2 server; an opt-in test renders against the server named by `DV_BACKEND_URL` |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/render-modes`](../render-modes/README.md): the `dvRef2va` registry that this package registers into.
- [`@dv/shot-render`](../shot-render/README.md): the Consumer, with the tool `dv_shot_render_ref2va`.
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.md): the streaming_v2 client.
- [`dsh-tool-skill`](../../skill/tool-skill/README.md): how the agent sees the skill catalog and loads a skill.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt skill

#### What the model sees

While the skill registry is mounted, the skill catalog that `dsh-tool-skill` renders lists the catalog entry below. When the agent calls the `skill` tool with `fasth3-ref2va-prompting`, the tool result carries `skills/fasth3-ref2va-prompting.md`: a DreamVerse connection section (one DreamVerse shot is one target video; the six rewrite sections form the `prompt`; only `<Picture N>` and `<Subject N>` references; picture numbering with the first frame after the reference images; at least one and at most 8 reference images; `duration_sec` from 5 to 15), followed by the official MiniMax-H3 full-reference prompt guide `VIDEO_PROMPT_WRITING_GUIDE_ref_en.md` copied unchanged.

##### Catalog entry

```markdown
- `fasth3-ref2va-prompting`: Model limits and prompt rules for dv_shot_render_ref2va (render mode ref2va): reference images, how the prompt names them, and how a shot continues the previous one.
```

#### Token effect

About 40 tokens in the catalog while the provider and the skill registry are mounted, and about 6,000 tokens each time the agent loads the skill.

#### KV Cache effect

Mounting or removing the provider changes the skill list, and `dsh-tool-skill` appends a replacement catalog; a loaded skill body is appended as a tool result. Both leave the cached prefix before them intact.

### Render tool facts

#### What the model sees

The model facts of this provider shape `dv_shot_render_ref2va`: its results report `model` (the server's model ID), `frame_width`, `frame_height`, `num_frames` and `image_labels`, and its refusals name the allowed aspect ratios, resolutions and durations, the reference image limit, and the GPU estimate from `gpuSecondsPerVideoSecond`.

#### Token effect

This package adds no tokens beyond the tool results and refusals that `@dv/shot-render` writes.

#### KV Cache effect

Registering or removing the renderer changes the values of the `backend` argument of `dv_shot_render_ref2va`, or adds or removes the tool, and invalidates the cached prefix from the tool section on.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fixed limits in the skill**: `skills/fasth3-ref2va-prompting.md` states 5 to 15 seconds and at most 8 reference images, while `model()` reads the limits from the server; a server with other limits makes the skill disagree with the refusals of `dv_shot_render_ref2va`.
- **Reference aspect ratio**: `model()` drops the server's `max_reference_aspect_ratio` because `RenderModelFacts` has no field for it, so Shot render sends reference images to the server without an aspect ratio check.
- **One skill for several rows**: two rows of this plugin register the same skill name; the skill registry keeps the first and ignores the second, so removing the first row removes the skill while the second row's renderer stays registered.
