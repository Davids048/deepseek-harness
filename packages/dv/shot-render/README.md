---
description: "Shot render component of DreamVerse: the dvShotRender service, its shot.render operation that renders one take of a shot with the DreamVerse generation backend, the shot reducer of takes, and the dv_shot_render agent tool."
kind: "package-reference"
---

# @dv/shot-render

English | [中文](README.zh.md)

## Summary

Use this package to render shots. It registers one operation with `dvProject`, `shot.render`: one take of a shot from a prompt, reference images, and optionally the last still of an earlier shot, rendered by the DreamVerse generation backend (`dreamverseGeneration`, a FastVideo Ref2AV server). The record's outputs are the video and its last still. `dvProject` turns the operation into the agent tool `dv_shot_render`. The component's reducer groups the takes of each shot in the `shot` slice. It is the only package that uses `@dreamverse/generation-client`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project` and `@dv/asset-pool`. The `shot` reducer is always registered; `shot.render` is registered while `dreamverseGeneration` is mounted.

```yaml
- id: dv-shot-render
  name: '@dv/shot-render'
  config:
    gpuSecondsPerVideoSecond: 4
```

| Field | Default | Meaning |
| --- | --- | --- |
| `gpuSecondsPerVideoSecond` | `4` | Estimated GPU seconds per rendered video second; `estimate(params)` multiplies it by `duration_sec` (5 when the call names none) for the approval card and the DSH question rule |

| Operation | Tool | Inputs and params | Outputs and report |
| --- | --- | --- | --- |
| `shot.render` | `dv_shot_render` | inputs `reference` (images, or character, location and style versions `<id>@<n>`, in prompt order) and `first_frame` (one image); params `prompt` (required), `duration_sec`, `aspect_ratio`, `resolution`, `generation_mode`, `seed`, and `plan` and `shot` (the plan record and the shot position, set when an approved plan schedules the render); tool-only `continue_from` (a `shot.render` record whose output `#1` becomes `first_frame`) | outputs `video`, `last_still`; report `{seed, model, generation_mode, aspect_ratio, resolution, duration_sec, frame_width, frame_height, num_frames, image_labels, timings}`; cost `gpu_seconds` from the backend's timings |

`shot.render` uses the GPU, is not deterministic, and asks first (`confirm: agent_ask_first`): an agent call waits for the composer's approval card while the session's composer asks first. Omitted params take the model's first generation mode, aspect ratio and resolution and its shortest duration; a seed is drawn when the call names none. A call that `based_on` an earlier render is a new take of that shot; the `shot` slice maps each shot's root record to its takes (`takes`) and each take to its root (`roots`). Other callers use the service method `renderShot(context)`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`renderShot` reads the model facts from `dreamverseGeneration.model()`, resolves the frame size and frame count from the params, validates the reference count with the DreamVerse rules, orders the request images with `segmentRequestImages` (references first, then the first frame), streams the backend's segment into a scratch file, and imports the video and the PNG last still through `context.importAsset`. While the optional live stream service of `@video-harness/stream` is mounted, the video chunks also go to its `openSegment` as they arrive, with the plan's `shot` number as the segment index.

Before any record is written, for every caller, the operation's `precondition` refuses a call when the served model renders from reference images and the call carries no reference image: an asset or a record output counts one image, and a character, location or style version counts the assets `dvProject.assetsOf` returns for it. A call that a plan scheduled (param `plan`) is told to update the plan, and `plan.approve` runs this precondition for every shot before its own record. Before an agent call, `prepareToolCall` runs the same precondition, so the agent is refused before the question rule asks the user; it then turns `continue_from` into the `first_frame` input `{record, output: 1}`.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvShotRender`: `shot.render`, `renderShot`, the reference-image rule |
| [`src/render.ts`](src/render.ts) | `shotGeometry`, `backendSeconds`, `assetRecord` |
| [`src/reducer.ts`](src/reducer.ts) | `shotReducer`, the takes of each shot |
| [`src/types.ts`](src/types.ts) | `ShotState`, the `shot` slice |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, approval, and agent tools.
- [`@dv/asset-pool`](../asset-pool/README.md): the reference images and the imported outputs.
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.md): the backend client.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): the layout this package follows.

-----

<a id="model-experience"></a>
## Model Experience

One tool, `dv_shot_render`, in the format `@dv/project` gives every operation tool, with the tool-only `continue_from`. Its description names the reference input, `continue_from`, the two outputs, and that every call is a new take whose changed prompt passes `based_on`. A call returns one text block with the record, its status, the summary `shot "<prompt>" (<n>s, seed <seed>)`, the outputs with their URLs, the params, and the report; the last still also arrives as an image block when an attachment service is mounted. A call without reference images is refused before any record with a message that tells the agent to ask the user for a reference image: "The video model renders every shot from 1 to <n> reference images, and this shot has none. Nothing was rendered. …".

#### KV Cache effect

The tool schema is part of every agent request while the plugin and the generation backend are mounted; mounting or removing the backend changes the tool list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One backend**: the operation renders through the single mounted `dreamverseGeneration` client; its model facts decide every frame size and duration.
- **Approval estimate**: the GPU estimate is `duration_sec × gpuSecondsPerVideoSecond`, a configured rate, not a measured one.
