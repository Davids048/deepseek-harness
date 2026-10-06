---
description: "The DreamVerse timeline editor as a right-Sidebar tab and a center view: each timeline of the project on one track, with move, trim, split, insert, and remove gestures that become `timeline.*` records."
kind: "package-reference"
---

# @dv/ui-timeline

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a timeline editor beside the chat. The editor shows one tab per timeline of the project, a viewer that plays the selected timeline across its clips, a toolbar, a ruler, and one video track whose clips are as wide as they play, carry their producer's last frame, and are marked when stale or a draft. Dragging a clip moves it, dragging its edges trims it, the toolbar splits the clip under the playhead, Delete removes the selected clip, and an asset from the asset pool can be dropped on the track or picked with ＋. The `dv-timeline` tab type of the right Sidebar wraps the editor in the branch bar; `TimelineView` is the shell's center 时间线 view.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that stacks `dsh-web-app` and `@dv/api`, and build the browser bundle first with `pnpm run build`.

```yaml
- id: dv-ui-timeline
  name: '@dv/ui-timeline'
```

The Host half registers nothing. The browser half registers the `dv-timeline` tab type (offered by the Sidebar's guide page as "Timeline"), the `dvTimeline` locale namespace in Chinese and English, and the tab body under its own id `@dv/ui-timeline`.

| Gesture | Record |
| --- | --- |
| Drag a clip edge | `timeline.clip_trim {clip, in_sec, out_sec}` (`clip` is the clip ID); an unset end is left out |
| Drag a clip | `timeline.clip_move {clip, to}` (`to` is the 1-based position) |
| Split | `timeline.clip_split {clip, at_sec}` for the clip under the playhead |
| Delete key on the selected clip | `timeline.clip_remove {clip}` |
| Drop an asset on the track, or pick one with ＋ | `timeline.clip_insert {timeline, at, asset}` |
| ＋ New, rename, delete a tab | `timeline.create {timeline, assets: []}` (no name, so the tab shows 时间线 {n} / Timeline {n}), `timeline.rename {timeline, name}`, `timeline.delete {timeline}` |
| Export | One `deliver.timeline_export {timeline}` call; the link opens the exported video |
| Click a clip | `POST /api/dv/selection` with kind `clip` and the clip ID |
| "Keep anyway" for a selected stale clip | `POST /api/dv/stale/accept` for the record that made the clip's asset (`proj.stale_accept`) |

Every record carries `surface: 'timeline'`, the chat session the view sits beside (so the record lands on that session's draft), and an intent in the DSH interface language naming the gesture. The selected timeline is shared through `@dv/ui-kit/current-timeline.ts`, so the shell keeps it in the URL. `TimelineView` follows `<html lang>` through `@dv/ui-kit/locale.ts`; switching timeline tabs stops playback and resets the viewer and playhead. While a `draft/*` branch is shown the gestures are disabled. The working-branch bar of `@dv/ui-kit/WorkingBranchBar.tsx` above the tabs names the branch the edits go to and accepts or discards the open draft. A clip whose asset reports no duration is drawn as five seconds.

The DOM carries test IDs `dv-timeline-body`, `dv-timeline-editor`, `dv-timeline-viewer`, `dv-timeline-viewer-empty`, `dv-timeline-time`, `dv-timeline-exported`, `dv-timeline-ruler` and `dv-timeline-playhead`; each clip carries `data-clip` (its clip ID), `data-clip-position`, `data-clip-stale` and `data-clip-draft`, and each tab carries `data-timeline`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`TimelineBody` holds the view session from `@dv/ui-kit/useView.ts` and renders the branch bar above `TimelineEditor`. `TimelineView` reads the branch state itself and shows the open draft of its chat session with the draft's clips marked. `placeTimeline` turns one timeline of the state into positioned clips; `useTimelinePlayer` plays them through two stacked `<video>` elements. Each gesture is one `DvClient.runOperation` call followed by a state refetch.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | Registrations |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/TimelineBody.tsx`](src/client/TimelineBody.tsx) | The tab body: branch bar and editor |
| [`src/client/TimelineView.tsx`](src/client/TimelineView.tsx) | The center view: state, draft overlay, writes |
| [`src/client/TimelineEditor.tsx`](src/client/TimelineEditor.tsx) | The editor: tabs, viewer, toolbar, ruler, tracks, gestures |
| [`src/client/timelines.ts`](src/client/timelines.ts) | Clip placement, drop position, timecode |
| [`src/client/player.ts`](src/client/player.ts) | Continuous playback across clips |
| [`src/client/locales.ts`](src/client/locales.ts) | The `dvTimeline` dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/api`](../api/README.md) — the routes behind every gesture.
- [`@dv/ui-kit`](../ui-kit/README.md) — the client, the track geometry and the hooks.
- [`@dv/timeline`](../timeline/README.md) — the `timeline.*` operations the editor calls.
- [`@dv/deliver`](../deliver/README.md) — the `deliver.timeline_export` operation that Export calls.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through browser-side timeline; the records its gestures write reach the model only through the agent integration (`@dv/agent-integration`).

#### KV Cache effect

None; the timeline sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One video track** — the A1 track only mirrors the clips; audio and overlays have no lane of their own.
- **Undo across timelines** — undo moves `main` back one turn; the editor offers it only while that turn edited the shown timeline.
