---
description: "Generate one DreamVerse video segment for any workload: conditioning-image order and labels, the generation request, streamed delivery, stored video and last-frame files, and the shared creation rules."
kind: "package-reference"
---

# @dreamverse/segment-generation

English | [中文](README.zh.md)

## Summary

Use this package when a workload needs one video segment: give it the prompt, the frame settings, the project's reference images, and the previous segment's last frame, and it streams the video to you while it stores the video and its last frame as project files. Both files exist only for a completely delivered segment. The package also holds the rules that every generating workload shares: creation settings checked against the served model, the creation-capabilities payload, and which images each request carries under which prompt labels. It depends on no workload.

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

Mount the service after `@dreamverse/generation-client` and `@dreamverse/assets-manager`; it has no configuration.

### Minimal configuration

```yaml
- id: dreamverse-segment-generation
  name: '@dreamverse/segment-generation'
```

### Generate a segment

`dreamverseSegmentGeneration.generate(request, sink)` sends one backend request and returns the stored `video` and `lastFrame` records, the video MIME type, the backend timings, and the counts of the chunks that the sink accepted. The request names the prompt, frame width and height, frame count, generation mode, reference assets in selection order, the predecessor's last frame or null, the file owner, a base file name, and an optional seed and abort signal. Each non-empty chunk goes to a file store writer and then to `sink.chunk`. On the backend's `done`, the writer commits `<name>.mp4`, and the last frame is written as `<name>.png`.

Any failure removes the files of the segment, and leaving the stream early cancels the backend request. A backend `invalid_request` failure becomes `DreamverseValueError`; any other backend failure becomes `Error` with the backend message; a stream without a video start, a last frame, or `done` fails with `Error`. Once the request's signal aborts, `generate` rejects with `signal.reason`, so a workload aborts with its own error.

### Shared generation rules

A workload applies these rules before it calls `generate`:

- **Creation settings** — `parseProjectCreationConfig`, `validateProjectCreation`, `SEGMENT_COUNTS`, `parseReferenceAssetIds`, and `validateReferenceAssets` port the reference `project_creation.py` (without prompt safety) and its model capability checks, with the reference messages. `parseReferenceAssetIds` returns the selected IDs as `AssetId` values.
- **Creation capabilities** — `lobbyCapabilitiesAsDict(model, uploadPolicy)` builds the payload of `GET /creation-capabilities`.
- **Segment conditioning** — `continuesPreviousSegment` decides whether a segment starts from its predecessor's last frame, `segmentImageLabels` names the request images for the prompt, `segmentRequestImages` reads them in the same order, and `referenceImageLimit` gives the selection limit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One mapping in `src/conditioning.ts` orders the request images and labels position N `Picture N`, so a prompt names exactly the images that its request sends. On a model whose facts set `usesPreviousFrame`, every segment after the first in a round continues its predecessor, and the first segment of an appended round continues the latest completed segment; an image supplied to an appended first-frame (`initial_image`) shot starts that shot fresh instead. The selected reference images always come first, so the user's `Picture 1` to `Picture K` never shift; a continued segment sends its predecessor's last frame after them as `Picture K+1`, and a continued first-frame shot sends only the last frame.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The `dreamverseSegmentGeneration` service and the package exports |
| [`src/generate.ts`](src/generate.ts) | One segment's request, streamed delivery, and stored files |
| [`src/conditioning.ts`](src/conditioning.ts) | Request images, their order, and their labels |
| [`src/creation.ts`](src/creation.ts) | Creation settings and reference validation |
| [`src/capabilities.ts`](src/capabilities.ts) | The creation-capabilities payload |

The `tests/` directory covers generation, conditioning, creation settings, and capabilities.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the shared project layer and the generation backend.
- [`@dreamverse/generation-client`](../generation-client/README.md) — the backend request that `generate` sends.
- [`@dreamverse/assets-manager`](../assets-manager/README.md) — the file store that keeps the segment files.
- [`@dreamverse/project`](../project/README.md) — the DreamVerse workload, which calls `generate`.

-----

<a id="model-experience"></a>
## Model Experience

### Segment request images

#### What the model sees

The video model receives one `POST /v1/streamv2/generate` request per segment with the caller's `prompt` unchanged, the frame size, the frame count, the optional seed, and the request images in the order of `segmentRequestImages`: the selected reference images in selection order (`Picture 1` to `Picture K`), then, for a continued segment, the predecessor's last frame (`Picture K+1`). A continued first-frame (`initial_image`) shot carries only the last frame. `segmentImageLabels` returns the same labels, so the workload's prompt names exactly these images.

#### Token effect

Zero direct text tokens: the package adds no text to the prompt. Each request carries at most the model's `maxReferenceImages` images, and `referenceImageLimit` keeps one image free for the last frame in a reference-image mode of a model that continues segments.

#### KV Cache effect

Independent request per segment: the backend keeps no state between requests, so continuity between segments comes only from the last-frame image that the next request carries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No harness-side generation queue** — every `generate` call sends its request at once. Concurrent projects send concurrent requests, and the backend serializes them, so a request can wait for other projects' segments without a queue position.
- **Fixed segment counts** — `SEGMENT_COUNTS` (1 to 6) is the reference list in code; no `Config` field changes it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
