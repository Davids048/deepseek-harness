---
description: "The DreamVerse timeline editor as a right-Sidebar tab and a center view: each timeline of the project on one track, with move, trim, split, insert, and remove gestures that become `timeline.*` records."
kind: "package-reference"
---

# @dv/ui-timeline

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a timeline editor beside the chat. The editor shows one tab per timeline, a viewer that plays the selected timeline across its clips, and one video track whose clips are as wide as they play and are marked when stale or a draft. You move, trim, split, and remove clips on the track, and insert assets from the asset pool by dropping them there or choosing them with ＋. The `dv-timeline` tab type of the right Sidebar wraps the editor in the branch bar; `TimelineView` is the shell's center 时间线 view.

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

The editor also has a toolbar and a ruler, and each clip carries its producer's last frame. Dragging a clip moves it, dragging its edges trims it, the toolbar splits the clip under the playhead, its 撤销 / Undo and 重做 / Redo step the working branch back and forward one step (whichever view made the step), and Delete removes the selected clip. The bar under the preview shows the timecode on the left; back 5 s, play or pause, and forward 5 s in the center (J, L, Shift+← and Shift+→ on the focused editor also skip 5 s); and on the right the playback speed button, which cycles 0.5×, 1×, 1.5× and 2× and keeps the speed for the browser tab's session, and full screen. The 原声 / Original audio track draws each clip's waveform over its played range. Dragging the line between the preview and the toolbar (or pressing ArrowUp and ArrowDown on it) changes the track area's height, which the browser remembers under the `localStorage` key `dv-timeline-track-height`; the preview keeps at least 160 px.

```yaml
- id: dv-ui-timeline
  name: '@dv/ui-timeline'
```

The Host half registers nothing. The browser half registers the `dv-timeline` tab type (offered by the Sidebar's guide page as "Timeline"), the `dvTimeline` locale namespace in Chinese and English, and the tab body under its own id `@dv/ui-timeline`. A `dv:timeline-focus` window event with `{timelineId, clipId}` makes the editor select that clip of the timeline and move the playhead to its start.

| Gesture | Record |
| --- | --- |
| Drag a clip edge | `timeline.clip_trim {clip, in_sec, out_sec}` (`clip` is the clip ID); an unset end is left out |
| Drag a clip | `timeline.clip_move {clip, to}` (`to` is the 1-based position) |
| Split | `timeline.clip_split {clip, at_sec}` for the clip under the playhead |
| Delete key on the selected clip | `timeline.clip_remove {clip}` |
| Drop an asset on the track, or pick one with ＋ | `timeline.clip_insert {timeline, at, asset}` |
| ＋ New, rename, delete a tab | `timeline.create {timeline, assets: []}` (no name, so the tab shows 时间线 {n} / Timeline {n}), `timeline.rename {timeline, name}`, `timeline.delete {timeline}` |
| Export | One `deliver.timeline_export {timeline}` call; the link opens the exported video |
| "Keep anyway" for a selected stale clip | `POST /api/dv/stale/accept` for the record that made the clip's asset (`proj.stale_accept`) |

Every record carries `surface: 'timeline'`, the chat session the view sits beside (so the record lands on that session's draft), and an intent in the DSH interface language naming the gesture. The selected timeline is shared through `@dv/ui-kit/current-timeline.ts`, so the shell keeps it in the URL. `TimelineView` follows `<html lang>` through `@dv/ui-kit/locale.ts`; switching timeline tabs stops playback and resets the viewer and playhead. Clicking a clip selects it and sends nothing. While a `draft/*` branch is shown the gestures are disabled. The working-branch bar of `@dv/ui-kit/WorkingBranchBar.tsx` above the tabs names the branch the edits go to, shows the `intent` of the draft's latest record that has one, and accepts or discards the open draft. A clip whose asset reports no duration is drawn as five seconds.

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
| [`src/client/waveform.ts`](src/client/waveform.ts) | Audio decoding, peak envelopes, and waveform bars of the 原声 track |
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

Indirectly, through `@dv/project`; the records its gestures write reach the model only through the `dv:project` prompt section and the `dv_proj_*` and operation tools of [`@dv/project`](../project/README.md).

#### KV Cache effect

None; the timeline sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One video track** — the 原声 (original audio) track mirrors the video clips and has no edits of its own; subtitles and music have no lane.
- **Waveforms decode in the browser** — the 原声 track draws each clip's waveform by downloading the clip's whole media file and decoding its audio with the Web Audio API, one asset at a time and cached in memory per page load; a clip keeps a plain block while its audio decodes, when decoding fails, and when the media has no audio track.
