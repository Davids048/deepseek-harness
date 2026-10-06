---
description: "Deliver component of DreamVerse: the dvDeliver service and its operation deliver.timeline_export, which trims the clips of a timeline that have an in or out point and joins all clips into one video with ffmpeg, with its agent tool."
kind: "package-reference"
---

# @dv/deliver

English | [中文](README.zh.md)

## Summary

Use this package to export a timeline to one video file. It registers one operation with `dvProject`, `deliver.timeline_export`: it reads the timeline's clips from the `timeline` slice of the project state, trims each clip that has an in or out point to that range, joins all clips in timeline order through `dvFfmpeg`, and imports the joined video into the asset pool as the record's output. `dvProject` turns it into the agent tool `dv_deliver_timeline_export`; the timeline panel's Export button calls the same operation. The component has no reducer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project`, `@dv/ffmpeg`, and the asset pool `@dv/asset-pool`. The operation reads the slice of the Timeline component `@dv/timeline`, so a composition that exports also mounts that component. The plugin has no configuration fields.

```yaml
- id: dv-deliver
  name: '@dv/deliver'
```

| Operation | Tool | Inputs and params | Outputs |
| --- | --- | --- | --- |
| `deliver.timeline_export` | `dv_deliver_timeline_export` | no inputs; param `timeline` (the timeline ID, such as `t1`; default: the first timeline) | `video` (MP4) |

The operation is not deterministic, because its output depends on the timeline's clips in the project state, which the params do not name; every call exports again. It runs in the `cpu` resource class and never asks for confirmation. A call fails its record for an unknown timeline, for a project without timelines, and for a timeline without clips. The service method `exportTimeline(timeline, dir)` writes the joined file into `dir` for other callers and returns its path.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`exportTimeline` takes the file of each clip from the asset pool. A clip whose `in_sec` and `out_sec` are both null plays the whole asset and uses the asset's file as it is. Any other clip is trimmed into a new file in the operation's `scratchDir` with the seek after `-i` and re-encoding (H.264 in yuv420p, AAC audio), so the trim lands on the exact frame. The clip files are then joined with the concat demuxer and stream copy. When ffmpeg rejects the stream copy, for example because the files disagree on codec, the concat filter re-encodes the video of every file at the first file's frame size, scaled and padded. The operation probes the joined file and imports it with its duration and frame size, named after the timeline's name.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvDeliver`: the operation and `exportTimeline` |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, records, and agent tools.
- [`@dv/ffmpeg`](../ffmpeg/README.md): `run` and `probe`.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): the layout this package follows.

-----

<a id="model-experience"></a>
## Model Experience

### Tool definitions

#### What the model sees

One tool, `dv_deliver_timeline_export`, in the format `@dv/project` gives every operation tool. Its description says "Export a timeline to one video: each clip with an in or out point is trimmed to that range, and all clips are joined in timeline order. Runs on the CPU." Its only own param is `timeline` (the timeline ID, such as `t1`; default: the first timeline).

#### Token effect

About 250 tokens for the definition, fixed while the plugin is mounted; the shared arguments of `@dv/project` add about 200 tokens to each definition.

#### KV Cache effect

The definition sits in the stable tool section of every agent request; mounting or removing the plugin changes the tool list and invalidates the cached prefix from the tool section on.

### Tool results

#### What the model sees

A call returns one text block: `done <record>: exported timeline t1` (`exported the first timeline` without `timeline`), the line `- video: <AssetId> (video/mp4) <url>`, and the params. The video sends no image block.

#### Token effect

About 80 tokens per call.

#### KV Cache effect

The result is appended to the conversation after the call; the cached prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Video-only join fallback**: when stream copy fails, the re-encoding fallback drops audio, so the exported video has no sound.
- **Stream copy accepts some mismatched files**: ffmpeg copies clips of different frame sizes without an error, and players then show the later clips at the wrong size; only a rejected copy falls back to re-encoding.
- **No GPU encoders**: trims and the fallback join re-encode with `libx264` on the CPU.
