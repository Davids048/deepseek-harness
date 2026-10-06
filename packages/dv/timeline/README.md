---
description: "Timeline component of DreamVerse: the dvTimeline service, the timelines of a project and their clips, the ten timeline.* operations with their agent tools, and the timeline reducer."
kind: "package-reference"
---

# @dv/timeline

English | [中文](README.zh.md)

## Summary

Use this package to keep the timelines of a project: each timeline is one edited video, shown by its name (a timeline `t<n>` without a name shows as 时间线 {n}), and holds clips in playback order. A clip is an asset with in and out points and a clip ID such as `cl3`; editing a clip never creates a file. The package registers ten operations with `dvProject`, which turns them into the agent tools `dv_timeline_*`, and the `timeline` reducer, which folds their records into the `timeline` slice of the project state. Exporting a timeline to one file belongs to `@dv/deliver`.

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

The whole-timeline operations and `timeline.clip_insert` name a timeline in the param `timeline` (a timeline ID such as `t1`): it is required for `timeline.update`, `timeline.rename` and `timeline.delete`; `timeline.create` defaults it to `t1` and `timeline.clip_insert` to the first timeline. The other clip operations name the clip by its clip ID in the param `clip`, which also names the timeline that holds it.

| Operation | Tool | Params | Effect |
| --- | --- | --- | --- |
| `timeline.create` | `dv_timeline_create` | `timeline`, `name`, `assets` (asset IDs in order), `plan`; input role `clip` (many) | Adds a timeline; fails when the ID exists. Without `assets` the clips are the `clip` inputs in order |
| `timeline.update` | `dv_timeline_update` | `timeline`, `assets` (asset IDs in order), `plan`; input role `clip` (many) | Replaces all clips of an existing timeline with clips that get new clip IDs; keeps the name |
| `timeline.rename` | `dv_timeline_rename` | `timeline`, `name` | Sets the name |
| `timeline.delete` | `dv_timeline_delete` | `timeline` | Removes the timeline; its assets stay in the project |
| `timeline.clip_insert` | `dv_timeline_clip_insert` | `timeline`, `at`, `asset` | Inserts the asset as a clip at position `at`; creates the timeline when it does not exist |
| `timeline.clip_move` | `dv_timeline_clip_move` | `clip`, `to` | Moves a clip to position `to` |
| `timeline.clip_remove` | `dv_timeline_clip_remove` | `clip` | Removes a clip; later clips shift |
| `timeline.clip_split` | `dv_timeline_clip_split` | `clip`, `at_sec` | Splits a clip at a time inside its asset into two clips of the same asset; the second part gets a new clip ID |
| `timeline.clip_trim` | `dv_timeline_clip_trim` | `clip`, `in_sec`, `out_sec` | Sets the in and out points; an omitted point plays from the asset's start or to its end |
| `timeline.clip_replace` | `dv_timeline_clip_replace` | `clip`, `asset` | Puts another asset in the clip, keeps its clip ID and resets its points |

The `timeline` slice is `{timelines: Timeline[]}`; a `Timeline` is `{id, name, clips}` and a `Clip` is `{id, asset, in_sec, out_sec}`, where `id` is the clip ID and null points mean the asset's start and end. The package exports the types `Timeline`, `Clip`, `ClipId`, `TimelineId` and `TimelineState` (the slice).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The operations write only their records. Each one's `execute` checks the call against the state at the record's parent and fails the record with a reason when a created timeline exists, another named timeline or the named clip does not exist, a position is outside the timeline, a split time is outside the clip, or a trim range is empty. The operations are not `deterministic`, so the runner runs that check on every call instead of reusing an earlier record. The reducer applies each finished record and ignores records that do not apply; its `conflict` runs the same check, so accepting a draft on a `main` that moved stops at a clip edit whose clip `main` removed.

**Clip IDs.** The operations that add clips assign their clip IDs in `execute` and store them in the record's `report.clips`, in clip order: one per clip for `timeline.create` and `timeline.update`, one for `timeline.clip_insert`, and one for the second part of `timeline.clip_split` (the first part keeps the clip's ID). The number after `cl` is one more than the highest number in the `report.clips` of any Timeline record of the project on any branch, including undone and discarded records, and than any number assigned to a call still running, so no two clips of a project share an ID. The reducer reads clip IDs only from `report.clips`; accept replay repeats the report on each copy, so a replayed record keeps its clip IDs and the later draft records that name them still apply. A finished record whose `report.clips` does not match the clips it adds, or names an ID already in use, applies nothing and conflicts on replay.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvTimeline`: the ten operation specs, their registration, and clip ID assignment |
| [`src/reducer.ts`](src/reducer.ts) | The `timeline` reducer and the clip checks it shares with the operations |
| [`src/types.ts`](src/types.ts) | `Timeline`, `Clip`, `ClipId`, `TimelineId`, and the `timeline` slice declaration |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, reducers, drafts, and agent tools.
- [`@dv/deliver`](../deliver/README.md): exporting a timeline to one video file.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): the layout this package follows.

-----

<a id="model-experience"></a>
## Model Experience

### Tool definitions

#### What the model sees

Ten tools, `dv_timeline_create`, `dv_timeline_update`, `dv_timeline_rename`, `dv_timeline_delete`, `dv_timeline_clip_insert`, `dv_timeline_clip_move`, `dv_timeline_clip_remove`, `dv_timeline_clip_split`, `dv_timeline_clip_trim` and `dv_timeline_clip_replace`, in the format `@dv/project` gives every operation tool. The edit tools name a timeline by `timeline` (such as `t1`; default the first timeline) and a clip by `clip` (such as `cl3`), and their parameter descriptions point the agent to `timelines` and their `clips` in `dv_proj_state`.

#### Token effect

About 2,500 tokens for the ten definitions, fixed while the plugin is mounted; the shared arguments of `@dv/project` add up to about 200 tokens to each definition.

#### KV Cache effect

The definitions sit in the stable tool section of every agent request; mounting or removing the plugin changes the tool list and invalidates the cached prefix from the tool section on.

### Tool results

#### What the model sees

A call returns one text block with the record's status and a one-line summary such as `clip cl3 moved to 1`; a call that adds clips also returns their clip IDs in `report.clips`, and a call that does not fit the timeline returns a tool error with the failed record's reason. `dv_proj_state` lists every timeline with its clips by clip ID (field `clip`), and the agent's project block lists them with each clip's producing record.

#### Token effect

Roughly 50 to 150 tokens per call; a create or update with many clips adds its asset list.

#### KV Cache effect

Each result is appended to the conversation after its call; the cached prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Assets are params, not inputs**: `asset` and `assets` are recorded as params, so a clip does not make its record stale when the asset's producer is superseded.
