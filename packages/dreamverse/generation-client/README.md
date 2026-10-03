---
description: "Client for the FastVideo streaming_v2 generation backend: served-model facts, readiness, and one streamed segment request with its server-sent events and errors."
kind: "package-reference"
---

# @dreamverse/generation-client

English | [中文](README.zh.md)

## Summary

Use this package to reach the FastVideo generation backend that DreamVerse uses for video. It reads the served model's facts (durations, frame sizes, reference image limit), reports whether the backend is ready, and streams one segment per request: the last frame, then the fragmented MP4 in chunks, then the timings. Backend errors become typed errors, and aborting a request cancels it at once. The backend keeps no state between requests, so callers send every conditioning image with each request.

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

Mount the service with the backend's base URL; the DreamVerse workloads inject `dreamverseGeneration`.

### Minimal configuration

```yaml
- id: dreamverse-generation-client
  name: '@dreamverse/generation-client'
  config:
    baseUrl: http://127.0.0.1:8029
```

| Field | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | required | HTTP base URL of the generation backend |

`scripts/dreamverse/launch-generation.sh` runs `fastvideo serve --config scripts/dreamverse/h3-ref2va.serve.yaml`. The config's `streaming_v2:` block selects FastVideo's streaming_v2 API, and its `generator:` block loads MiniMax H3 Ref2VA with the preset's default sampling.

### Service

- `model()` reads `GET /v1/streamv2/capabilities` and caches the first successful result. It adds the harness's facts for the served H3 Ref2VA model: the generation mode `{ref2va: 'reference_images'}`, no unsupported modes, aspect ratios and resolutions from the `frame_sizes` keys, `usesPreviousFrame: true`, and the labels `Picture 1` to `Picture N` for N = `max_reference_images`.
- `ready()` reads `GET /v1/streamv2/health` and throws for another status or an unreachable backend.
- `generateSegment(request)` sends one `POST /v1/streamv2/generate` and yields `last_frame`, `video_start`, `chunk`, and `done` outputs in arrival order. HTTP 400 and an `error` event reject with `GenerationSegmentError(message, errorType, isValueError)`, where `isValueError` is true for `invalid_request`. A stream that ends before `done` rejects with `Error`. Leaving the iteration or aborting `request.signal` cancels the HTTP request; an abort rejects with `signal.reason`.

The package also exports the shared error kinds `DreamverseValueError` and `ProjectValidationError`, which stand for the reference's Python `ValueError` cases.

### Backend API

FastVideo owns the API; the client uses three routes. `GET /v1/streamv2/health` answers 200 `{"status": "ready"}` while the server accepts requests. `GET /v1/streamv2/capabilities` answers the model's facts:

```json
{
  "model_id": "h3-ref2va",
  "name": "H3 Ref2AV",
  "min_segment_duration_sec": 5,
  "max_segment_duration_sec": 15,
  "max_reference_images": 9,
  "max_reference_aspect_ratio": 4.0,
  "frame_sizes": {"16:9": {"720p": [1344, 768]}},
  "num_frames_by_duration_sec": {"5": 124, "6": 158, "15": 362}
}
```

`max_reference_images` counts every request image, including a continued segment's first frame. `num_frames_by_duration_sec` holds every whole duration from the minimum to the maximum.

`POST /v1/streamv2/generate` takes `{"prompt", "reference_images", "width", "height", "num_frames", "seed"?, "return_last_frame"}` and answers a `text/event-stream` of `event: <name>` records with one-line JSON `data:`, in this order:

| Event | Data |
| --- | --- |
| `last_frame` | `{"data": <base64 PNG of the final decoded frame>}`, only when `return_last_frame` is true |
| `video_start` | `{"mime": str}` |
| `video_chunk` | `{"data": <base64 fMP4 bytes>}`, one or more; their concatenation is one fragmented MP4 |
| `done` | `{"timings": {"generation_ms": float, "e2e_latency_ms": float}}`; the response ends |
| `error` | `{"code": "invalid_request" \| "generation_failed", "message": str}`; the response ends |

A request problem found before generation starts answers HTTP 400 `{"code": "invalid_request", "message": str}`. The backend serializes generation across concurrent requests and finishes a segment whose generation has started, even after the client cancels.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service uses `fetch` for every call. `generateSegment` parses the server-sent event stream line by line and yields each output as soon as its event is complete, so a caller can forward video chunks while the backend still generates.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The `dreamverseGeneration` service: model facts, readiness, and the segment request |
| [`src/generation-stream.ts`](src/generation-stream.ts) | The request body and the event-stream parser |
| [`src/types.ts`](src/types.ts) | Model facts, the segment request, and the segment outputs |
| [`src/errors.ts`](src/errors.ts) | The shared error kinds |

The `tests/` directory runs the client against a local HTTP server that plays the backend.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the generation backend in the process layout.
- [`@dreamverse/segment-generation`](../segment-generation/README.md) — orders the request images and stores the results.

-----

<a id="model-experience"></a>
## Model Experience

### Segment generation request

#### What the model sees

The video model receives the request body that `generateSegment` builds: `prompt` unchanged, `reference_images` as base64 image bytes in the caller's order, `width`, `height`, `num_frames`, `seed` only when the caller sets one, and `return_last_frame`. The prompt names the images `Picture 1`, `Picture 2`, and so on in list order.

#### Token effect

Zero direct text tokens: the client adds no text to the caller's prompt.

#### KV Cache effect

Independent request per segment: the backend keeps no state between requests, and the client sends no session or cache identifier.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Model facts never refresh** — `model()` keeps the first successful capabilities result for the plugin's lifetime. A backend that restarts with another model keeps the old facts in the harness until the plugin reloads.
- **No request deadline** — the client sets no timeout on the capabilities, health, or generation requests. A backend that stops sending events holds the request until the caller aborts it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
