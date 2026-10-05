---
description: "DreamVerse projects in the harness: project creation and reopening, browser command admission, generation plans, stored workload data, legacy migration, and the project event log."
kind: "package-reference"
---

# @dreamverse/project

English | [中文](README.zh.md)

## Summary

Use this package to run DreamVerse projects in the harness. A project accepts the page's commands, queues generation rounds, generates each segment, and stores its prompts, segments, and reference copies so that the user can close the page and reopen the project later. Opening a project in a second window moves it there and closes the first. User actions plug in as separate plugins, and every project event goes to a JSON Lines log. Projects stored by earlier versions migrate at start. Superseded by the [video harness](../../../docs/subsystems/video-harness.md).

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

Mount the service after the shared project layer, the generation client, and the prompt enhancer. It injects `dreamverseGeneration`, `dreamverseAssetsManager`, `dreamversePromptEnhancer`, `dreamverseProjectStore`, and `dreamverseSegmentGeneration`.

### Minimal configuration

```yaml
- id: dreamverse-project
  name: '@dreamverse/project'
  config:
    projectLogRoot: /home/user/.local/state/fastvideo/dreamverse/outputs/project_logs
```

| Field | Default | Meaning |
| --- | --- | --- |
| `projectLogRoot` | required | Directory of the project event log |

### Service

`dreamverseProjects` creates and opens projects and holds the user-action registry:

- `registerUserAction({actionTypes, handler})` registers one handler for its action types and returns the disposer. An action type without a handler fails its round with `Unsupported project action: <type>`.
- `createProject({socket, holder, payload})` validates a `project_init_v1` payload, stores a new project of kind `dreamverse`, and takes its lease; a rejected payload throws `ProjectValidationError`.
- `openProject({socket, holder, projectId})` takes the lease of a stored `dreamverse` project. The store first revokes the current holder, whose connection closes and stores the project.
- `logProjectEvent(projectId, event, payload)` appends one entry to the project log.

A `Project` serves one socket: `processBrowserCommand` admits a browser command, `processQueuedGenerationActions` runs the queued rounds, `closeAndWaitForGeneration` stops generation and stores the final workload data, and `releaseLease` ends the project's writes. Closing a project aborts its generation with `ProjectClosedError`, so the segment in progress, prompt waits, and the generation loop end with that error.

### Stored projects

A DreamVerse project is a project of kind `dreamverse` in `dreamverseProjectStore`. Its workload data, schema version 1, holds these fields:

| Field | Content |
| --- | --- |
| `creation_config` | The `ProjectCreationConfig.as_dict()` fields |
| `prompt_enhancement_enabled` | The project's prompt enhancement setting |
| `prompt_sequence_id`, `prompt_sequence_label` | The browser's `preset_id` value and the preset label |
| `segments` | Every segment: `segment_id`, `prompt`, `source`, `instruction`, `enhanced`, `sequence_index`, `reference_segment_id`, `reference_asset_ids`, `video_asset_id`, `last_frame_asset_id`, `status`, `error`, `mime`, and `created_at` |
| `completed_sequences` | Each completed round's display sequence of segment IDs, oldest first |
| `reference_copies` | Each library asset ID that the project used, mapped to the ID of the project's copy |

Segment IDs are `SegmentId`, and instruction request IDs, the browser's `prompt_id`, are `PromptId`. This package exports both branded string types and brands the IDs that it generates, reads from workload data, or receives in browser commands.

A segment's fragmented MP4 (`<segment_id>.mp4`) and last frame (`<segment_id>.png`) are files that the project owns in the file store. The first time that an action uses a library image, the project copies it into the project and records the copy in `reference_copies`; later actions reuse the copy. The project writes its workload data when it is created, after each segment settles, when an action records a completed sequence, when a round fails, and when it closes. The thumbnail is the last frame of the last segment of the last completed sequence. The title is the preset label, else the first prompt cut to 60 code points, else `Untitled project`.

An opened project is rebuilt from its workload data: segments that were pending or generating become `cancelled`, the last segment of the last completed sequence becomes the segment that an append continues, and the project starts idle without Auto Extension. Opening refuses a project that is not stored or has another kind (`Project not found`), one whose `model_id` is not the served model (`Model unavailable`), and one whose reference copy is unavailable (`Invalid reference asset`). When the socket closes, the segment in progress becomes `cancelled` (`Project disconnected.`), queued actions are dropped, and the final workload data is stored.

### Project log

The project log is one JSON Lines file per service start, `<projectLogRoot>/<hostname>/<yymmdd_HHMMSS_ffffff>.jsonl`. Each entry starts with `ts`, `event`, `hostname`, and `project_id`, followed by the event's payload, and keeps the reference event names and payload keys.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This package ports the reference `dreamverse/project/` except the user actions, the WebSocket connection, and segment generation. A `GenerationPlan` lists the segments of one round, and `GenerationPlanController` generates them in order through `dreamverseSegmentGeneration`, forwarding each video chunk to the socket. Reference assets are retained and released synchronously through `dreamverseAssetsManager`, so browser commands are admitted at receipt like the reference. Error kinds mirror the reference exception classes: `DreamverseValueError` stands for Python `ValueError`, and any other `Error` stands for a non-`ValueError` exception.

Before the service is ready, it migrates every schema-1 `project.json` that `dreamverseProjectStore.listUnrecognized()` reports. For each project, the migration deletes the files that an unfinished earlier run left, moves the completed segments' `segments/<segment_id>.mp4` and `.png` files into the file store, copies the referenced library images into the project, writes the record with `migrate`, sets the thumbnail, and removes `segments/`. An image that the library no longer holds is skipped with a warning. A record whose `schema_version` is not 1 belongs to another workload and is skipped; a project that fails to migrate is retried at the next start.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The `dreamverseProjects` service and the startup migration |
| [`src/project.ts`](src/project.ts) | `Project`: command admission, rounds, storage, and lifetime |
| [`src/project-data.ts`](src/project-data.ts) | The DreamVerse workload data |
| [`src/legacy-migration.ts`](src/legacy-migration.ts) | Migration of schema-1 projects |
| [`src/generation-plan.ts`](src/generation-plan.ts), [`src/generation-plan-controller.ts`](src/generation-plan-controller.ts) | Rounds and their segment generation |
| [`src/video-segment.ts`](src/video-segment.ts) | One segment's state |
| [`src/project-logger.ts`](src/project-logger.ts) | The project event log |

The `tests/` directory covers projects, stored projects and migration, generation plans, and the project log.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the DreamVerse workload and the differences from the Python reference.
- [`@dreamverse/user-actions`](../user-actions/README.md) — the handlers that run each round.
- [`@dreamverse/project-controller`](../project-controller/README.md) — the `/ws` connection that drives a project.
- [`@dreamverse/project-store`](../project-store/README.md) — project records and leases.

-----

<a id="model-experience"></a>
## Model Experience

### Segment generation inputs

#### What the model sees

For each segment, the video model receives the segment's `prompt` as the workload data stores it, the frame width, frame height, and frame count from `creation_config`, and the request images that `@dreamverse/segment-generation` orders from the project's reference copies and the predecessor's last frame. `promptImageLabels` gives the prompt enhancer the labels of the same images, such as `Picture 1`, so an enhanced prompt names the images that its request sends.

#### Token effect

One prompt per segment; the project adds no text to the prompt that an action prepares.

#### KV Cache effect

Independent request per segment; the project sends no state between requests except the predecessor's last-frame image.

### Auto Extension

#### What the model sees

While Auto Extension is on, the project queues the action `{"type": "auto_extend"}` after each completed round. The `append_prompt` and `auto_extend` handler then asks the prompt enhancer for a continuation without a steer prompt and generates one more segment.

#### Token effect

One more continuation request and one more segment request per completed round until the user turns Auto Extension off or the project closes.

#### KV Cache effect

Independent requests, the same as a user continuation.

### Project log

#### What the model sees

Nothing. The project log records `enhance_request`, `rewrite_done`, `rewrite_exception`, `simple_generate`, `append_prompt`, `segment_start`, and the other reference events for audit; no model request reads it.

#### Token effect

Zero; log entries never enter a model request.

#### KV Cache effect

None; logging changes no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Partial request record** — the project log records the user's prompts and the enhancer's replies, but not the rendered enhancer request or every segment's final video prompt. The workload data holds each segment's final `prompt`.
- **Reopened projects start without Auto Extension** — opening a stored project never resumes Auto Extension, even when it was on when the project closed.
- **Append after a failed round** — while the same socket serves a project, an append after a failed round requires a rewrite first; a reopened project appends to its last completed sequence.
- **Superseded by the video harness** — the [video harness](../../../docs/subsystems/video-harness.md) replaces this package with the `vhProject` fold and the plan tools of `@video-harness/runtime` and `@video-harness/tools`; the package remains only for the `dreamverse` and `dreamverse-multiverse` profiles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
