---
description: "The video-harness package group: the live media stream of shot renders. The other DreamVerse packages live under `packages/dv/`."
kind: "package-group"
---

# video-harness/ — the video agent harness

English | [中文](README.zh.md)

## Summary

This group holds one package, `stream` (`@video-harness/stream`), a Cordis service: while a Shot render operation (`shot.render_ref2va`, `shot.render_t2va`) renders a take, the service sends the take's fMP4 chunks to every browser subscribed to the project over the `/vh/ws` WebSocket route. The Project component, the other components, the render mode packages, the chat references, the API, the interface plugins, and the browser tests of DreamVerse live under `packages/dv/`, starting with [`@dv/project`](../dv/project/README.md); the bundle is [`@dv/bundle`](../bundle/dv/README.md).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The [DreamVerse packages page](../../docs/subsystems/video-harness.md) explains how these packages fit together.

| Package | Role |
| --- | --- |
| `stream` | `@video-harness/stream`: live fMP4 chunks of shot renders, served to browsers over the `/vh/ws` WebSocket route in the DreamVerse media framing |

<a id="related-documentation"></a>
## Related documentation

- [DreamVerse packages](../../docs/subsystems/video-harness.md) — the layers, the operation record, and the rules views and the agent follow.
- [`@dv/api`](../dv/api/README.md) — the browser API that the interface plugins read state from.
- [`dreamverse/`](../dreamverse/README.md) — the generation client and segment rules that the model-backed tools reuse.

<a id="dev-note"></a>
## Dev Note

None.
