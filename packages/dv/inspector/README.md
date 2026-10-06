---
description: "Inspector component of DreamVerse: the dvInspector service and its two reads, inspect.image (the default model answers a question about an image) and inspect.asset (ffprobe metadata), with their agent tools."
kind: "package-reference"
---

# @dv/inspector

English | [中文](README.zh.md)

## Summary

Use this package to let the agent look at project assets without changing the project. It registers two read operations with `dvProject`: `inspect.image`, where the harness's default model answers a question about an image asset, and `inspect.asset`, where ffprobe reads an asset's duration, frame size, codec, and audio presence through `dvFfmpeg`. `dvProject` turns them into the agent tools `dv_inspect_image` and `dv_inspect_asset`. Both write no record; the answer is the result's report. The component has no reducer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project`, `@dv/ffmpeg`, and `@dv/asset-pool`. `inspect.asset` is always registered; `inspect.image` is registered while `llm`, `agentDefaultModel`, and `attachments` are mounted.

```yaml
- id: dv-inspector
  name: '@dv/inspector'
  config:
    imageInput: true
```

| Field | Default | Meaning |
| --- | --- | --- |
| `maxTokens` | `1024` | The output token cap of one `inspect.image` answer |
| `imageInput` | `true` | Whether the agent model accepts images; `false` makes `inspect.image` answer with `report.unsupported` instead of calling the model |

| Operation | Tool | Inputs and params | Report |
| --- | --- | --- | --- |
| `inspect.image` | `dv_inspect_image` | input `image` (PNG, JPEG, WebP or GIF), param `question` (a default question asks for the subject, framing, lighting, and flaws) | `{question, answer, model, unsupported?}` |
| `inspect.asset` | `dv_inspect_asset` | input `asset` (video, audio or image) | `{duration_sec, video_duration_sec, width, height, has_audio, codec}` |

The service methods `inspectImage(asset, question)` and `inspectAsset(asset)` return the same reports to other callers.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`inspectImage` saves the image through the attachment service, as every model-visible image is saved, and sends one request through `ctx.llm.stream()` with the provider, model, and reasoning effort of `ctx.agentDefaultModel.currentSelection()`, no system prompt, `maxTokens`, and one user message with the image followed by the question. When `imageInput` is `false`, or the selected model's catalog entry declares no image input, no request is sent and `unsupported` explains why, so the agent reads the reason instead of a failed call. `inspectAsset` probes the asset's file in the asset pool and returns the fields in snake_case.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvInspector`: both operations and their service methods |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, read-only runs, and agent tools.
- [`@dv/ffmpeg`](../ffmpeg/README.md): `probe`.
- [`@dv/asset-pool`](../asset-pool/README.md): the asset files this component reads.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): this package is the reference layout of a component.

-----

<a id="model-experience"></a>
## Model Experience

Two tools, `dv_inspect_image` and `dv_inspect_asset`, in the format `@dv/project` gives every operation tool. Their descriptions say that they are reads that write no record. A call returns one text block: `done: dv_inspect_image answered`, the params, and the report with the model's answer or the probe fields. `inspect.image` also sends the image and the question to the default model in a separate request outside the agent's conversation.

#### KV Cache effect

The two tool schemas are part of every agent request while the plugin is mounted. The model request of `inspect.image` is separate and does not touch the agent's cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One image per call**: `inspect.image` takes one image and one question; the answer is capped by `maxTokens`.
- **Videos are not shown to the model**: to look at a video, the agent first grabs a still of it with `dv_asset_grab_still`.
