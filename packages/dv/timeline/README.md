---
description: "Timeline component of DreamVerse: the dvTimeline service, the timelines of a project and their clips, the ten timeline.* operations with their agent tools, and the timeline reducer."
kind: "package-reference"
---

# @dv/timeline

English | [中文](README.zh.md)

## Summary

Use this package to keep the timelines of a project: each timeline is one edited video that holds clips in playback order, and a clip is an asset with in and out points and a clip ID such as `cl3`; editing a clip never creates a file. The package registers ten operations, which become the agent tools `dv_timeline_*`, and the `timeline` reducer, which folds their records into the `timeline` slice. Exporting a timeline belongs to `@dv/deliver`. While the DSH skill registry is mounted, the package also registers the `timeline-editing` skill, which maps the user's editing phrasings to exact `dv_*` calls.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project`. It has no configuration. While the skill registry `skills` of `@deepseek-ai/dsh-skill` is mounted, the plugin registers the `timeline-editing` skill from [`skills/timeline-editing/SKILL.md`](skills/timeline-editing/SKILL.md) with `ctx.skills.register`; without the registry the operations work and no skill is registered.

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

The `timeline` slice is `{timelines: Timeline[]}`; a `Timeline` is `{id, name, clips}` and a `Clip` is `{id, asset, source, in_sec, out_sec}`, where `id` is the clip ID, `source` is the render output `{record, output}` the clip was laid out from (null for a clip of an existing asset), and null points mean the asset's start and end. A clip is ready when `asset` is not null; a clip whose `asset` is null is a placeholder for a render that is not done. Its `ClipStatus` is derived from the source record and never stored: `ready`, `rendering` while the source record is pending or running, else `failed`. The package exports the types `Timeline`, `Clip`, `ClipId`, `ClipStatus`, `TimelineId` and `TimelineState` (the slice).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The operations write only their records. Each one's `execute` checks the call against the state at the record's parent and fails the record with a reason when a created timeline exists, another named timeline or the named clip does not exist, a position is outside the timeline, a split or trim names a placeholder clip ("Clip cl3 is still rendering."), a split time is outside the clip, or a trim range is empty. The operations are not `deterministic`, so the runner runs that check on every call instead of reusing an earlier record. The reducer applies each finished record and ignores records that do not apply.

**Placeholder clips.** `timeline.create` and `timeline.update` declare the `clip` input role in `OperationSpec.pendingInputRoles`, so a `clip` input may name the output of a render that is not done: the call runs at once and its record is done while the render runs. The reducer lays out each `clip` input as a clip with that `source`; the input's `resolved_asset`, and so the clip's `asset`, is null until the render is done, when the record's current form fills it. A failed render leaves the clip a placeholder. Move, remove and replace work on a placeholder; replace puts an asset in it and clears its `source`. The agent summary lists a placeholder clip as `{clip, asset: null, status, record, in_sec, out_sec}`, where `record` is the render it waits for.

**Clip IDs.** The operations that add clips assign their clip IDs in `execute` and store them in the record's `report.clips`, in clip order: one per clip for `timeline.create` and `timeline.update`, one for `timeline.clip_insert`, and one for the second part of `timeline.clip_split` (the first part keeps the clip's ID). The number after `cl` is one more than the highest number in the `report.clips` of any Timeline record anywhere in the project's history, including undone records, and than any number assigned to a call still running, so no two clips of a project share an ID, whichever state they were added in. The reducer reads clip IDs only from `report.clips`. A finished record whose `report.clips` does not match the clips it adds, or names an ID already in use, applies nothing.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvTimeline`: the ten operation specs, their registration, and clip ID assignment |
| [`src/reducer.ts`](src/reducer.ts) | The `timeline` reducer and the clip checks it shares with the operations |
| [`src/types.ts`](src/types.ts) | `Timeline`, `Clip`, `ClipId`, `TimelineId`, and the `timeline` slice declaration |
| [`skills/timeline-editing/SKILL.md`](skills/timeline-editing/SKILL.md) | The body of the `timeline-editing` skill |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, reducers, undo, and agent tools.
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

A call returns one text block with the record's status and a one-line summary such as `clip cl3 moved to 1`; a call that adds clips also returns their clip IDs in `report.clips`, and a call that does not fit the timeline returns a tool error with the failed record's reason. `dv_proj_state` lists every timeline with its clips by clip ID (field `clip`), and the agent's project block lists them with each clip's producing record; a placeholder clip shows its status (`rendering` or `failed`) and the render record it waits for instead of an asset.

#### Token effect

Roughly 50 to 150 tokens per call; a create or update with many clips adds its asset list.

#### KV Cache effect

Each result is appended to the conversation after its call; the cached prefix stays intact.

### Skill

#### What the model sees

The skill catalog lists `timeline-editing` with its description and when to use it. When the agent loads the skill, it reads a table from the user's editing phrasings (trims, retakes, reference and style changes, reordering, deletion, going back to an earlier take, undo, export) to the `dv_*` calls in order and their required arguments, and the rules that apply to every row. A retake calls the render tool of the clip's render mode (`dv_shot_render_ref2va` or `dv_shot_render_t2va`).

#### Token effect

About 60 tokens in the skill catalog while the plugin is mounted; about 1,800 tokens each time the agent loads the skill.

#### KV Cache effect

The catalog entry sits in the stable skill section; mounting or removing the plugin changes the catalog. A loaded skill is appended to the conversation as a tool result; the cached prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Assets are params, not inputs**: `asset` and `assets` are recorded as params, so a clip does not make its record stale when the asset's producer is superseded.
