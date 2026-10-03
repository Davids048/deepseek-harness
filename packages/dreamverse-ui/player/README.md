---
description: "The DreamVerse video player as a DSH browser plugin: live playback of the streamed project video, archived clip playback, connection and generation status, and clip download."
kind: "package-reference"
---

# @dreamverse/ui-player

English | [中文](README.zh.md)

## Summary

This package draws the DreamVerse video player. It plays the project's video live while the harness streams it, plays archived clips that the user selects, shows the connection and generation status while the user waits, and offers the clip for download. It renders what the page passes it and sends nothing to the harness itself.

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

Mount the plugin with `@dreamverse/ui-kit`, which declares its slot.

### Minimal configuration

```yaml
- id: dreamverse-ui-player
  name: '@dreamverse/ui-player'
```

The browser half fills `dreamverse.player` with `VideoPlayer`, the port of the frontend's `components/VideoPlayer.tsx`, while the kit declares the slot. It also registers the player's Chinese and English copy as the `dreamverse.player` locale namespace, so the profile must mount `@deepseek-ai/dsh-client-locale`, which provides the `locale` service; the player shows its status, queue, and playback-error copy in the page's active language. The kit's media pipeline attaches the live and archived video elements through the `videoRef` and `archivedPlaybackRef` props. The Host half registers nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`VideoPlayer` is a presentation component: the page owns the stream, the archive, and the download, and passes their state and callbacks as `VideoPlayerProps`.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | The dictionary and slot registrations |
| [`src/client/locales.ts`](src/client/locales.ts) | The `zh` and `en` dictionaries of the `dreamverse.player` namespace |
| [`src/client/components/VideoPlayer.tsx`](src/client/components/VideoPlayer.tsx) | The player |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dreamverse/ui-kit`](../kit/README.md) — the page and the media pipeline that feed the player.
- [`dreamverse-ui/`](../README.md) — the other page packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the player only displays video and status that the page receives.

#### KV Cache effect

None; the player adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Large bundle** — the bundle holds the whole `@carbon/icons-react` library (about 3.9 MB), and the DreamVerse web server sends it uncompressed.
- **No package tests** — the package has no `tests/` directory; the kit's page tests render the player as the real `dreamverse.player` occupant.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
