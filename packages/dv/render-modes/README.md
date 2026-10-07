---
description: "Service Definitions of the DreamVerse render mode seams: dvRef2va (Ref2vaRenderer, a prompt and reference images) and dvT2va (T2vaRenderer, a prompt only), with their request, model-fact and render-stream types."
kind: "package-reference"
---

# @dv/render-modes

English | [中文](README.zh.md)

## Summary

Use this package to add or replace a way of rendering shots. A render mode is how a shot is rendered from its inputs, and each render mode is its own capability seam. The package defines two Cordis services: `dvRef2va` (abstract class `Ref2vaRenderer`: a prompt, 1 to `maxReferenceImages` reference images, and an optional first frame) and `dvT2va` (abstract class `T2vaRenderer`: a prompt only). Every render mode returns one video with audio and its last frame as a `RenderStreamEvent` stream. `@dv/shot-render` is the Consumer; `@dv/fasth3-ref2va` and `@dv/fasth3-t2va` are the Service Providers.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

To add a provider, subclass `Ref2vaRenderer` or `T2vaRenderer` and load the subclass as a plugin; each context holds one provider per render mode. A Consumer injects `dvRef2va` or `dvT2va` and calls three methods, which every provider implements with these semantics:

| Method | Returns | Semantics |
| --- | --- | --- |
| `model()` | `Promise<RenderModelFacts>` | The facts of the model the backend serves; rejects when the backend cannot be reached. `dvRef2va` reports `maxReferenceImages` of at least 1 and an `imageLabels` entry for every request image, the reference images first, then the first frame; `dvT2va` reports `maxReferenceImages` 0 and an empty `imageLabels` |
| `ready()` | `Promise<{ ready, detail }>` | Whether the backend serves renders; `detail` says why it does not, or is null |
| `render(request, signal?)` | `AsyncIterable<RenderStreamEvent>` | Exactly one `last_frame`, one `video_start`, the `chunk` events, then `done`; rejects for any backend failure; aborting `signal` cancels the render and rejects with its reason |

| Type | Fields |
| --- | --- |
| `RenderModelFacts` | `modelId`, `name`, `aspectRatios` and `resolutions` (the default first), `frameSizes` (`[width, height]` by aspect ratio and then by resolution), `minDurationSec`, `maxDurationSec`, `numFramesByDurationSec`, `maxReferenceImages`, `imageLabels` (`Picture 1`, `Picture 2`, …), `gpuSecondsPerVideoSecond` (the provider's GPU seconds per rendered video second) |
| `Ref2vaRequest` | `prompt`, `references` (image bytes in input order), `firstFrame` (image bytes or null), `frameWidth`, `frameHeight`, `numFrames`, `seed` |
| `T2vaRequest` | `prompt`, `frameWidth`, `frameHeight`, `numFrames`, `seed` |
| `RenderStreamEvent` | `last_frame` (PNG bytes, before or after the video), `video_start` (the MIME type of the video), `chunk` (video bytes), `done` (the backend's timings: keys ending in `_ms` are milliseconds, other keys seconds) |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Each render mode is a separate service, so mounting a provider adds exactly one render mode. `@dv/shot-render` registers `shot.render_ref2va` while `dvRef2va` is mounted and `shot.render_t2va` while `dvT2va` is mounted. Shot render reads `model()` to turn the `duration_sec`, `aspect_ratio` and `resolution` params of a shot into a frame size and a frame count, checks the reference image count of a `ref2va` call against `maxReferenceImages`, multiplies the shot duration by `gpuSecondsPerVideoSecond` for the GPU estimate before the render runs, and stores the render stream as the two outputs of a take, `video` and `last_still`. The package holds only the types and the two abstract classes, whose constructors register the service names.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `Ref2vaRenderer`, `T2vaRenderer`, and the `dvRef2va` and `dvT2va` properties of the Cordis `Context` |
| [`src/types.ts`](src/types.ts) | `RenderModelFacts`, `Ref2vaRequest`, `T2vaRequest`, `RenderStreamEvent` |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/shot-render`](../shot-render/README.md): the Consumer and its operations `shot.render_ref2va` and `shot.render_t2va`.
- [`@dv/fasth3-ref2va`](../fasth3-ref2va/README.md): the Service Provider of `dvRef2va`.
- [`@dv/fasth3-t2va`](../fasth3-t2va/README.md): the Service Provider of `dvT2va`.
- [`@dv/bundle`](../../bundle/dv/README.md): the rows `dv-fasth3-ref2va` and `dv-fasth3-t2va` that mount the providers.

-----

<a id="model-experience"></a>
## Model Experience

### Render tools of Shot render

#### What the model sees

This package registers no tool, prompt section, or skill. Its two services decide which render tools `@dv/shot-render` lists: `dv_shot_render_ref2va` while `dvRef2va` is mounted, and `dv_shot_render_t2va` while `dvT2va` is mounted. The `RenderModelFacts` of the mounted provider appear in the results of those tools (`model`, `frame_width`, `frame_height`, `num_frames`, and for `ref2va` the `image_labels` of the request images) and in their refusals (the allowed aspect ratios, resolutions and durations, the reference image limit, and the GPU estimate from `gpuSecondsPerVideoSecond` when a render needs the user's agreement).

#### Token effect

The package adds no tokens of its own; each provider package owns the tokens of its skill, and `@dv/shot-render` owns the tokens of the render tools.

#### KV Cache effect

Mounting or removing a provider adds or removes its render tool, which changes the tool list and invalidates the cached prefix from the tool section on.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One provider per render mode**: each context holds one provider of `dvRef2va` and one of `dvT2va`, so two models of the same render mode cannot be mounted side by side.
- **`fl2va` is reserved**: the render mode name `fl2va` has no service and no class in this package.
