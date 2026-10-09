---
description: "Shot render component of DreamVerse: the dvShotRender service, the Consumer of the render mode seams, with the operations shot.render_ref2va and shot.render_t2va that render one take of a shot, the shot reducer of takes, and the agent tools dv_shot_render_ref2va and dv_shot_render_t2va."
kind: "package-reference"
---

# @dv/shot-render

English | [中文](README.zh.md)

## Summary

Use this package to render shots. It is the Consumer of the render mode seams of [`@dv/render-modes`](../render-modes/README.md): `shot.render_ref2va` renders one take of a shot from a prompt, reference images and an optional first frame through `dvRef2va`, and `shot.render_t2va` renders one take from a prompt only through `dvT2va`. Each operation exists only while its render mode registry holds a renderer, so the agent gets only the tools `dv_shot_render_<mode>` it can use, and a call's `backend` param names which registered renderer renders it. Every take's outputs are the video and its last still; the reducer groups the takes of each shot in the `shot` slice.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project` and `@dv/asset-pool`, and mount [`@dv/render-modes`](../render-modes/README.md) with at least one provider of each render mode it renders with, such as [`@dv/fasth3-ref2va`](../fasth3-ref2va/README.md) and [`@dv/fasth3-t2va`](../fasth3-t2va/README.md). The `shot` reducer is always registered; `shot.render_ref2va` is registered while `dvRef2va` holds a renderer, and `shot.render_t2va` while `dvT2va` holds one. Each operation is registered again whenever its registry changes, so its `backend` param lists exactly the registered backend names, in registration order.

```yaml
- id: dv-shot-render
  name: '@dv/shot-render'
```

The plugin has no configuration. The GPU estimate of a render, `estimate(params)`, is `duration_sec` (5 when the call names none) times the `gpuSecondsPerVideoSecond` that the renderer named by `backend` (the first registered one when the call names none) reports in its model facts; Shot render keeps the latest facts of each registered renderer, read when the renderer registers and again by every render, so the synchronous estimate serves the GPU budget of a turn and the agreement text of `confirmSummary`. While a renderer has reported no facts, its estimate is 0.

| Operation | Tool | Inputs and params | Outputs and report |
| --- | --- | --- | --- |
| `shot.render_ref2va` | `dv_shot_render_ref2va` | inputs `reference` (at least one: images, or character, location and style versions `<id>@<n>`, in prompt order) and `first_frame` (one image); params `prompt` (required), `backend` (one of the registered `ref2va` backends; default the first), `duration_sec`, `aspect_ratio`, `resolution`, `seed`, and `plan`, `plan_version` and `shot` (the PlanId, the approved version and the shot position in it, set when an approved plan schedules the render); tool-only `continue_from` (a render record whose output `#1` becomes `first_frame`) | outputs `video`, `last_still`; report `{seed, model, aspect_ratio, resolution, duration_sec, frame_width, frame_height, num_frames, backend, image_labels, timings}`; cost `gpu_seconds` from the backend's timings |
| `shot.render_t2va` | `dv_shot_render_t2va` | no inputs; the same params as `shot.render_ref2va`, with `backend` one of the registered `t2va` backends | outputs `video`, `last_still`; report `{seed, model, aspect_ratio, resolution, duration_sec, frame_width, frame_height, num_frames, backend, timings}`; cost `gpu_seconds` from the backend's timings |

Both operations use the GPU, are not deterministic, and declare `confirm: over_gpu_budget`: an agent call that would bring its turn past the GPU budget of `dvProject` is refused until the agent asks the user in the conversation and calls again with `user_requested: true`; `confirmSummary` gives the refusal one line (`Render shot from references, 5 s: "<prompt>"`) and the call's GPU estimate. Project rejects a `backend` that is not registered before Shot render runs. Omitted params take the model's first aspect ratio and resolution and its shortest duration; a seed is drawn when the call names none. A call that `based_on` an earlier render of either render mode is a new take of that shot; the `shot` slice maps each shot's root record to its takes (`takes`) and each take to its root (`roots`). Other callers use the service method `renderShot(context)`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`renderShot` picks the render mode from the record's operation and the renderer from the `backend` param (the first registered backend when the call names none), reads the model facts from the renderer's `model()`, resolves the frame size and frame count from the params, and for `ref2va` checks that the call carries 1 to `maxReferenceImages` reference images and reads their bytes and the first frame's from the asset pool. It sends the request to the renderer's `render(request, signal)`, writes the stream into a scratch file, and imports the video and the PNG last still through `context.importAsset`. For `ref2va`, the report's `backend` names the renderer that rendered the take, and `image_labels` names the images by the model's `imageLabels`: the reference images in order, then the first frame. While the optional live stream service of `@video-harness/stream` is mounted, the video chunks also go to its `openSegment` as they arrive, with the plan's `shot` number as the segment index.

Before any record is written, for every caller, the `precondition` of `shot.render_ref2va` refuses a call that carries no reference image: an asset or a record output counts one image, and a character, location or style version counts the assets `dvProject.assetsOf` returns for it. A call that a plan scheduled (param `plan`) is told to update the plan with `dv_plan_update`; while `dvT2va` holds a renderer, the refusal also says that a shot without a reference image can be rendered with `dv_shot_render_t2va`. Before an agent call, `prepareToolCall` runs the same precondition, so the agent is refused before Project asks for the user's agreement; it then turns `continue_from` into the `first_frame` input `{record, output: 1}`.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvShotRender`: `shot.render_ref2va`, `shot.render_t2va`, `renderShot`, the reference-image rule |
| [`src/render.ts`](src/render.ts) | `shotGeometry`, `imageLabels`, `backendSeconds` |
| [`src/reducer.ts`](src/reducer.ts) | `shotReducer`, the takes of each shot for both render modes |
| [`src/types.ts`](src/types.ts) | `ShotState`, the `shot` slice |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, approval, and agent tools.
- [`@dv/asset-pool`](../asset-pool/README.md): the reference images and the imported outputs.
- [`@dv/render-modes`](../render-modes/README.md): the render mode seams this package consumes.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): the layout this package follows.

-----

<a id="model-experience"></a>
## Model Experience

### Tool definitions

#### What the model sees

One tool per render mode with a registered renderer, in the format `@dv/project` gives every operation tool, with the hint "Uses the GPU." and the argument `user_requested` that Project adds for `confirm: over_gpu_budget`. `dv_shot_render_ref2va` says that it needs at least one reference image (`c1@1`) and names `continue_from`; `dv_shot_render_t2va` says that it renders from the prompt only and takes no inputs. Both list the registered backends as the values of `backend`, and both name the two outputs and that every call is a new take whose changed prompt passes `based_on`.

#### Token effect

About 600 tokens for each definition, fixed while the plugin is mounted and its render mode registry holds the same renderers; the shared arguments of `@dv/project` add up to about 200 tokens to each definition.

#### KV Cache effect

Each definition sits in the stable tool section of every agent request while the plugin is mounted and its render mode registry holds a renderer; mounting or removing the plugin, or registering or removing a renderer, changes the tool list and invalidates the cached prefix from the tool section on.

### Tool results

#### What the model sees

A call returns one text block with the record, its status, the summary `shot "<prompt>" (<n>s, seed <seed>)` (`shot <n> of plan <plan> v<version> "<prompt>" …` when an approved plan scheduled it), the outputs with their URLs, the params, and the report; the last still also arrives as an image block when an attachment service is mounted. A `dv_shot_render_ref2va` call without reference images is refused before any record with a message that tells the agent to ask the user for a reference image: "dv_shot_render_ref2va renders a shot from 1 to <n> reference images, and this shot has none. Nothing was rendered. …".

#### Token effect

Roughly 200 tokens of text per call, plus the image block of the last still.

#### KV Cache effect

Each result is appended to the conversation after its call; the cached prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **GPU estimate**: the GPU estimate is `duration_sec × gpuSecondsPerVideoSecond`, the rate the renderer's provider is configured with, not a measured one.
