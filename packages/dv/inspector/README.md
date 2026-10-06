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

### Tool definitions

#### What the model sees

Two tools, `dv_inspect_image` and `dv_inspect_asset`, in the format `@dv/project` gives every operation tool; both descriptions end with "A read that writes no record.", and neither takes `supersedes` or `based_on`. `dv_inspect_image` looks at the input `image` and answers the param `question` (default: "Describe this image: the subject, the framing, the lighting, and anything that looks wrong."); its description tells the agent to grab a still with `dv_asset_grab_still` to look at a video. `dv_inspect_asset` reads the duration, frame size, codec, and audio presence of the input `asset`. `dv_inspect_image` is listed only while `llm`, `agentDefaultModel` and `attachments` are mounted.

#### Token effect

About 450 tokens for the two definitions, fixed while the plugin is mounted; the shared arguments of `@dv/project` add about 200 tokens to each definition.

#### KV Cache effect

The definitions sit in the stable tool section of every agent request; mounting or removing the plugin, or the model services that `dv_inspect_image` needs, changes the tool list and invalidates the cached prefix from the tool section on.

### Tool results

#### What the model sees

A call returns one text block: `done: dv_inspect_image answered` (or `dv_inspect_asset`), the params, and the report: `question`, `answer` and `model` for an image, with `unsupported` instead of an answer when the default model takes no images; `duration_sec`, `video_duration_sec`, `width`, `height`, `has_audio` and `codec` for an asset.

#### Token effect

About 60 tokens per call plus the answer, which the `maxTokens` setting caps (default 1024).

#### KV Cache effect

The result is appended to the conversation after the call; the cached prefix stays intact.

### Image question request

#### What the model sees

`dv_inspect_image` sends the default model of the agent one user message with the image as an attachment and the question as text, with no system prompt and no tools, and puts the text of the reply into the report.

#### Token effect

The image costs what the model charges for one image, the question a few dozen tokens, and the answer at most `maxTokens`. A model without image input, or `imageInput: false`, sends no request.

#### KV Cache effect

An independent request outside the agent's conversation; it does not touch the agent's cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One image per call**: `inspect.image` takes one image and one question; the answer is capped by `maxTokens`.
- **Videos are not shown to the model**: to look at a video, the agent first grabs a still of it with `dv_asset_grab_still`.
