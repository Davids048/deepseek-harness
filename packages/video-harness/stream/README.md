---
description: "The live media stream of DreamVerse: a Cordis service sends the fMP4 chunks of a rendering shot, and the project's record and branch changes, to browsers over the /vh/ws WebSocket route."
kind: "package-reference"
---

# @video-harness/stream

English | [中文](README.zh.md)

## Summary

Use this package to let a browser watch a shot while `shot.render` is still rendering it. The package's Cordis service takes the fMP4 chunks of each rendering take from `@dv/shot-render` and sends them to every browser subscribed to the project over the `/vh/ws` WebSocket route, in the DreamVerse media framing (`media_init`, binary chunks, `media_segment_complete`). A browser that subscribes mid-shot first receives the chunks already sent, up to a byte budget. The same socket forwards the project's record and branch changes from `dvProject`, so one connection carries both media and state.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that has the DSH web server (`webServer`); the `/vh/ws` route exists while `webServer` exists. `dvProject` is optional: without it, the socket carries media only.

```yaml
- id: vh-stream
  name: '@video-harness/stream'
  config:
    bufferBytes: 67108864
    pingMs: 20000
```

| Config | Default | Meaning |
| --- | --- | --- |
| `bufferBytes` | 64 MiB | The most bytes one in-flight segment keeps for browsers that subscribe mid-shot |
| `pingMs` | 20000 | Interval of the server pings that keep idle proxies from closing the socket |

`@dv/shot-render` looks up the `vhStream` service with `ctx.get` on every render and, when the service exists, calls `openSegment(project, record, {mime, segmentIdx})` at the start of the backend's video stream. The record ID becomes the `stream_id` the browser sees, and the render's `shot` param (0 for a shot without one) becomes `segment_idx`. The writer end that `openSegment` returns has `chunk(bytes)`, `complete()`, and `fail(error)`. `subscribe(project, listener)` receives the same frames in the Host process, and `openSockets` counts the open browser sockets. <!-- names:allow (the live stream service keeps its name) -->

The `/vh/ws` route works as follows:

| Step | Message |
| --- | --- |
| Upgrade request | The `connection` service, when mounted, decides; a rejected request gets HTTP 401 or 403, a request that is not a WebSocket upgrade gets HTTP 400 |
| Browser subscribes | Text `{type: 'subscribe', project_id}`; a later subscribe replaces the earlier one |
| Server acknowledges | `{type: 'subscribed', project_id, in_flight}`, where `in_flight` lists the `stream_id` of every segment still rendering, then a replay of those segments |
| A shot starts | `{type: 'media_init', segment_idx, mime, stream_id}` |
| A chunk arrives | One binary message with the fMP4 bytes |
| The shot ends | `{type: 'media_segment_complete', segment_idx, stream_id}` |
| The shot fails | `{type: 'error', stream_id, message}` |
| A record is written or updated | `{type: 'op', change: 'append' or 'patch', op}`, where `op` is the `ProjectRecord` |
| A branch is created or moves, or the current branch changes | `{type: 'head', branch, to, current}`, where `to` is the branch head and `current` the project's current branch |
| A bad message | `{type: 'error', message}` for text that is not JSON or not a subscribe command |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`SegmentBroadcaster` keeps, per project, the set of subscribers and the segments in flight. `openSegment` sends `media_init` at once and passes every chunk to the subscribers as it arrives. Each chunk is also kept for late subscribers until the segment's kept bytes would pass `bufferBytes`; from then on the segment is marked truncated and late subscribers get no replay of it. `complete` and `fail` remove the segment from the in-flight set. `VhStream` registers the `/vh/ws` upgrade route while `webServer` exists and closes every open socket with code 1001 when the web server goes away. Each socket sends a ping every `pingMs` and ignores binary messages from the browser.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The service class `VhStream`, its config, the `/vh/ws` route, and the forwarding of `dvProject` events |
| [`src/broadcast.ts`](src/broadcast.ts) | `SegmentBroadcaster`: per-project fan-out of segments with bounded replay for late subscribers |
| [`src/socket.ts`](src/socket.ts) | The RFC 6455 server socket, so the package needs no WebSocket library: handshake, frame encoding and decoding, ping and pong, and close |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/shot-render`](../../dv/shot-render/README.md) — the operation that renders a take and writes its chunks to this service.
- [`@dv/project`](../../dv/project/README.md) — the records and branch events the socket forwards.
- [DreamVerse packages](../../../docs/subsystems/video-harness.md) — how the DreamVerse packages fit together.
- [`dsh-host-webserver`](../../host/webserver/README.md) — the web server that serves the upgrade route.

-----

<a id="model-experience"></a>
## Model Experience

None, as the service relays media bytes and project changes to browsers; no model request reads them.

#### KV Cache effect

None; the service sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No DreamVerse view reads the route** — `@dv/bundle` does not mount the package, and no `@dv/ui-*` plugin subscribes to `/vh/ws`; `@dv/shot-render` uses the service only when a profile mounts it.
- **Late subscribers miss large segments** — a segment whose bytes pass `bufferBytes` is not replayed; a browser that subscribes after that point receives the segment's later chunks and its completion message without its `media_init`.
- **No project check on subscribe** — the server acknowledges any `project_id`; only an error that `dvProject.subscribe` throws reaches the browser, as an `error` message.
- **Operation-log message names** — the record messages keep the type `op` and the field `op` of the DreamVerse page framing, though they carry a `ProjectRecord`.
