---
description: "The video-harness package group: the content-addressed asset store, the media service, the structured tools that run as `@dv/project` operations, the agent integration, the browser API, and the canvas and timeline views."
kind: "package-group"
---

# video-harness/ — the video agent harness

English | [中文](README.zh.md)

## Summary

These packages are the project layer of the video agent harness. A project is a set of immutable media assets plus the append-only records of the Project component [`@dv/project`](../dv/project/README.md); the canvas, the timeline, and the chat are projections of those records, and the agent and every view change a project only by running an operation through `dvProject.run`. Project computes state from the records, keeps one draft per chat session until the human accepts or discards it, writes undo and redo as records, starts exploration branches, and marks downstream results stale when an input is replaced.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The [video harness subsystem page](../../docs/subsystems/video-harness.md) explains how these packages fit together.

| Package | Role |
| --- | --- |
| [`assets`](assets/README.md) | Content-addressed immutable media store and the `/vh/assets/<id>/content` route |
| [`media`](media/README.md) | ffmpeg and ffprobe over stored assets: probe, extract frames, trim, concatenate, run declared commands |
| [`tools`](tools/README.md) | The typed tool specs, their registration as `dvProject` operations, the bridge reducers, and the `vh_*` and `dv_proj_*` DSH tools |
| [`agent`](agent/README.md) | The turns of the DSH agent loop and their request text, chat image imports, confirmation questions, the project prompt section, and the directing skills |
| [`views`](views/README.md) | Authenticated `/api/vh/*` routes and the `/vh/events` stream through which the browser views read state and write user records |
| [`ui-kit`](ui-kit/README.md) | Browser code the two views share: the API client, the state types, the graph layout, the form model, the track geometry, and the branch bar |
| [`ui-canvas`](ui-canvas/README.md) | The canvas tab of the right Sidebar: records as a DAG of asset flow, with a parameter form that edits or reruns any record |
| [`ui-timeline`](ui-timeline/README.md) | The timeline tab of the right Sidebar: the clip sequence on one track with reorder, range, trim, insert, and remove gestures |

<a id="related-documentation"></a>
## Related documentation

- [Video harness subsystem](../../docs/subsystems/video-harness.md) — the layers, the operation record, and the rules views and the agent follow.
- [`dreamverse/`](../dreamverse/README.md) — the generation client and segment rules that the model-backed tools reuse.

<a id="dev-note"></a>
## Dev Note

None.
