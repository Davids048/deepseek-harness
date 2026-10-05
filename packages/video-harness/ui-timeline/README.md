---
description: "The video harness timeline as a right-Sidebar tab: the project's clip sequence on one track, with reorder, range, trim, insert, and remove gestures that become sequence and clip records."
kind: "package-reference"
---

# @video-harness/ui-timeline

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a timeline over a video project beside the chat. The `vh-timeline` tab type of the right Sidebar draws the shown branch's sequence as one track: each clip as wide as it plays, with its producer's last frame, marked when stale or a draft. Clicking a clip previews it and offers the gestures: set in and out points, move, bake the range into a replacing clip, or insert an asset after it. An empty timeline starts from any video asset. The bar switches project and branch, decides drafts, undoes, and branches.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that stacks `dsh-web-app` and `@video-harness/views`, and build the browser bundle first with `pnpm run build`.

```yaml
- id: vh-ui-timeline
  name: '@video-harness/ui-timeline'
```

The Host half registers nothing. The browser half registers the `vh-timeline` tab type (offered by the Sidebar's guide page as "Video timeline"), the `vhTimeline` locale namespace in Chinese and English, and the tab body under its own id.

| Gesture | Record |
| --- | --- |
| Set range | `sequence.set_range {slot, inSec, outSec}`; an empty field means "from the start" or "to the end" |
| Move left or right | `sequence.move {from, to}` |
| Bake trim | `clip.trim` on the clip's asset with the in and out points, then `sequence.replace {slot, asset}` with the new clip |
| Insert after this clip | `sequence.insert {at, asset}` with the chosen video asset |
| Remove from the timeline | `sequence.remove {slot}`; the clip before it is selected afterwards |
| Start the timeline from this asset | `sequence.create {assets: [asset]}` |
| Click a clip | `/api/vh/selection` with the asset id and slot |

Every record carries `surface: 'timeline'` and an intent in the DSH interface language naming the gesture. The 剪辑 view (`CutsView`) follows `<html lang>` through `@video-harness/ui-kit/locale.ts`; switching episode tabs stops playback and resets the viewer and playhead to the new episode. While a `draft/*` branch is shown the gestures are disabled. The track draws forty pixels per second; a clip whose asset reports no duration is drawn as five seconds.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`TimelineBody` holds the view session from `@video-harness/ui-kit/useView.ts` and the selected slot. `placeClips` from the kit turns the state's sequence into positioned clips; `Track` draws them as buttons over an absolutely positioned strip; `ClipPanel`, keyed by slot and asset so a new selection reseeds its fields, holds the in and out texts and calls the body's actions. Each action is one `client.invoke` call followed by a state refetch, except bake, which awaits the trim record and then writes the replace with its first output; a trim without output writes nothing. A successful move reselects the moved clip.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | Registrations |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/TimelineBody.tsx`](src/client/TimelineBody.tsx) | The body: session, track, panel, writes |
| [`src/client/Track.tsx`](src/client/Track.tsx), [`src/client/ClipPanel.tsx`](src/client/ClipPanel.tsx) | The track and the clip panel |
| [`src/client/locales.ts`](src/client/locales.ts) | The `vhTimeline` dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@video-harness/views`](../views/README.md) — the routes behind every gesture.
- [`@video-harness/ui-kit`](../ui-kit/README.md) — the track geometry and the hooks.
- [`@video-harness/tools`](../tools/README.md) — the `sequence.*` and `clip.trim` tools the timeline calls.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through browser-side timeline; the records its gestures write reach the model only through the project prompt section of the agent layer.

#### KV Cache effect

None; the timeline sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No drag** — clips move one slot per click; there are no drag handles.
- **No playback of the sequence** — the panel previews one clip; playing the whole track needs a `media.concat` record.
- **One track** — audio and overlays have no lane.
