---
description: "Timeline component of DreamVerse: the dvTimeline service, the timelines of a project and their clips, the nine timeline.* operations with their agent tools, and the timeline reducer."
kind: "package-reference"
---

# @dv/timeline

English | [中文](README.zh.md)

## Summary

Use this package to keep the timelines of a project: each timeline is one edited video, shown by its name such as 第 1 集, and holds clips in playback order. A clip is an asset with in and out points; editing a clip never creates a file. The package registers nine operations with `dvProject`, which turns them into the agent tools `dv_timeline_*`, and the `timeline` reducer, which folds their records into the `timeline` slice of the project state. Exporting a timeline to one file belongs to `@dv/deliver`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project`. It has no configuration.

```yaml
- id: dv-timeline
  name: '@dv/timeline'
```

Every operation takes the optional param `timeline` (a timeline ID such as `t1`; default: the first timeline), except `timeline.rename` and `timeline.delete`, where it is required. A clip is named by its 1-based position in the param `clip`.

| Operation | Tool | Params | Effect |
| --- | --- | --- | --- |
| `timeline.create` | `dv_timeline_create` | `name`, `assets` (asset IDs in order), `plan`; input role `clip` (many) | Adds a timeline with a new ID, or replaces the clips of an existing one; without `assets` the clips are the `clip` inputs in order |
| `timeline.rename` | `dv_timeline_rename` | `name` | Sets the name |
| `timeline.delete` | `dv_timeline_delete` | — | Removes the timeline; its assets stay in the project |
| `timeline.clip_insert` | `dv_timeline_clip_insert` | `at`, `asset` | Inserts the asset as a clip at position `at`; creates the timeline when it does not exist |
| `timeline.clip_move` | `dv_timeline_clip_move` | `clip`, `to` | Moves a clip to position `to` |
| `timeline.clip_remove` | `dv_timeline_clip_remove` | `clip` | Removes a clip; later clips shift |
| `timeline.clip_split` | `dv_timeline_clip_split` | `clip`, `at_sec` | Splits a clip at a time inside its asset into two clips of the same asset |
| `timeline.clip_trim` | `dv_timeline_clip_trim` | `clip`, `in_sec`, `out_sec` | Sets the in and out points; an omitted point plays from the asset's start or to its end |
| `timeline.clip_replace` | `dv_timeline_clip_replace` | `clip`, `asset` | Puts another asset in the clip and resets its points |

The `timeline` slice is `{timelines: Timeline[]}`; a `Timeline` is `{id, name, clips}` and a `Clip` is `{asset, in_sec, out_sec}`, where null points mean the asset's start and end. The package exports the types `Timeline`, `Clip`, `TimelineId` and `TimelineState` (the slice).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The operations write only their records. Each one's `execute` checks the call against the state at the record's parent and fails the record with a reason when the timeline does not exist, a position is outside the timeline, a split time is outside the clip, or a trim range is empty. The operations are not `deterministic`, so the runner runs that check on every call instead of reusing an earlier record. The reducer applies each finished record and ignores records that do not apply; its `conflict` runs the same check, so accepting a draft on a `main` that moved stops at a clip edit that no longer fits.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvTimeline`: the nine operation specs and their registration |
| [`src/reducer.ts`](src/reducer.ts) | The `timeline` reducer and the clip check it shares with the operations |
| [`src/types.ts`](src/types.ts) | `Timeline`, `Clip`, `TimelineId`, and the `timeline` slice declaration |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, reducers, drafts, and agent tools.
- [`@dv/deliver`](../deliver/README.md): exporting a timeline to one video file.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): the layout this package follows.

-----

<a id="model-experience"></a>
## Model Experience

Nine tools, `dv_timeline_create` through `dv_timeline_clip_replace`, in the format `@dv/project` gives every operation tool. A call returns one text block with the record's status and a one-line summary such as `t2 clip 3 moved to 1`; a call that does not fit the timeline returns the failed record's reason. `dv_proj_state` lists every timeline with its clips by position, and the agent's project block lists them with each clip's producing record.

#### KV Cache effect

The nine tool schemas are part of every agent request while the plugin is mounted.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Clips are named by position**: a draft edit replayed on a `main` that inserted or removed clips can apply to a different clip at the same position; `conflict` catches only positions that no longer exist. Stable clip IDs (`ClipId`) would remove this.
- **Assets are params, not inputs**: `asset` and `assets` are recorded as params, so a clip does not make its record stale when the asset's producer is superseded.
