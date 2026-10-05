---
description: "Project runtime of the video harness: invoke and schedule, folding the operation log into state, agent draft turns, acceptance, undo, branches, staleness marks, the deterministic cache, plan scheduling, and automatic replay."
kind: "package-reference"
---

# @video-harness/runtime

English | [中文](README.zh.md)

## Summary

Use this package as the one place that changes a video project. `invoke` resolves inputs, appends a record, runs the tool, and records the outputs; `schedule` queues the record behind the records its inputs name, under one concurrency limit per cost class. `fold` turns any branch or record into view state. An agent turn works on a draft branch that `acceptTurn` fast-forwards into `main`; `undoLatestTurn` moves `main` back; `createBranch` starts an exploration. Approved plans are scheduled shot by shot, deterministic results are cached, and deterministic consumers are replayed when a record they read is superseded.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@video-harness/assets` and `@video-harness/oplog`.

```yaml
- id: vh-runtime
  name: '@video-harness/runtime'
  config:
    ffmpegPath: /opt/ffmpeg/bin/ffmpeg
    builtinTools: true
```

| Field | Default | Meaning |
| --- | --- | --- |
| `ffmpegPath` | required | The ffmpeg binary for the built-in `clip.trim` and the placeholder `generate.video` |
| `builtinTools` | `true` | Register the built-in tools at start |
| `gpuConcurrency` | `1` | Scheduled records of `gpu`-cost tools that run at the same time |
| `cpuConcurrency` | `4` | Scheduled records of `cpu`-cost tools that run at the same time; `free` tools are not limited |

| Method | Behavior |
| --- | --- |
| `createProject({title})` | A project whose `main` branch starts with one `intent` record |
| `invoke(projectId, request)` | Runs a tool now and records it; `request` names the tool, inputs (asset IDs, `entity@version`, or `<record>#<index>` outputs of finished records), params, actor, surface, intent, turn, and optionally `branch`, `base_op`, `supersedes`; refused when an input names an unfinished record |
| `schedule(projectId, request, {after?})` | Appends the record at once and runs it when the records its inputs name, and the `after` records, are done; a failed producer fails the record |
| `whenIdle(projectId)` | Settles when nothing is queued or running for the project |
| `fold(projectId, head?)` | The `ProjectState` at a branch name or record ID; defaults to `main` |
| `beginTurn(projectId, {actor, surface, intent, branch?})` | Opens a turn; an agent turn gets `draft/<turn>` forked from `main`, a user turn writes to `main`, and a turn with `branch` writes to that exploration branch without a draft |
| `openTurn(turn)` | The open turn's branch, base, and whether it is a draft, or undefined once it was accepted or rejected; at boot the runtime reopens every `draft/<turn>` head of the log that has no approve or reject record |
| `acceptTurn` / `rejectTurn` / `undoLatestTurn` / `createBranch` | Fast-forward `main` to a draft (refused when `main` moved), leave a draft behind, move `main` back one turn, or start a branch at any record |
| `registerTool(spec)` / `tool(name)` / `toolNames()` | Make a tool invokable; a later registration of the same name replaces the earlier one; a spec declares `cost` as `free`, `cpu`, or `gpu` |

Built-in tools: `asset.upload`, `entity.create`, `entity.update`, `plan.create`, `plan.approve`, `sequence.create`, `sequence.replace`, `sequence.move`, `sequence.set_range`, `sequence.insert`, `sequence.remove`, `clip.trim`, and a placeholder `generate.video` that renders a solid-color clip whose color follows the prompt, so a project can be exercised without a model backend. [`@video-harness/tools`](../tools/README.md) registers the typed specs a profile ships instead.

A `plan.approve` record names a `plan.create` or `plan.update` record whose output is a plan document: `shots` with prompts and durations, `references`, and `continuity`. The runtime schedules one `generate.video` record per shot, with `chained` continuity naming the previous shot's last frame (`<record>#1`) as the `first_frame` input, then one `sequence.create` over the clips. A tool may return `report` facts, such as the seed it drew, which the record keeps beside its params.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`fold` walks the record chain once. Outputs become assets with their producer; `entity.*` records build version lists; `sequence.*` records build the item list; `plan` and `approve` records pair up; `base_op` chains group takes under their root. A second pass marks staleness: a record is stale when an input's producer is superseded or stale, or when an entity input is older than the entity's current version; an `accept_stale` record exempts one record. Turns are accepted when they are reachable from `main`.

`invoke` and `schedule` both fold the branch head to resolve inputs, derive the implicit `supersedes` of an `entity.update` (the previous version's record), and append the pending record; output references to unfinished records stay unresolved until the record runs. The scheduler starts every queued record whose producers and `after` records are done while its cost class has room, and fails a record whose producer failed. A run first serves deterministic tools from the cache (an earlier successful record with the same tool, version, canonical params, and resolved inputs, recorded as `cost.cached`), else executes the tool with a scratch directory that is removed afterwards; the record ends `done` with outputs, wall time, and the tool's report, or `failed` with the error. After a `plan.approve` finishes, the plan's shots are scheduled; after a record with `supersedes` finishes, every deterministic consumer of a replaced asset is scheduled again on the replacement with `base_op`, `supersedes`, and `params.replayed_from` (ignored by the cache key), and sequence slots that showed a replaced asset are repointed with `sequence.replace`.

| File | Content |
| --- | --- |
| [`src/types.ts`](src/types.ts) | `ProjectState`, `InvokeRequest`, `RuntimeToolSpec` |
| [`src/fold.ts`](src/fold.ts) | The fold and the staleness rules |
| [`src/builtins.ts`](src/builtins.ts) | The built-in tools |
| [`src/index.ts`](src/index.ts) | `vhProject`: invoke, turns, undo, branches, cache |

`scripts/video-harness/walkthrough.ts` runs the design's six-step test case through the `@video-harness/tools` specs against the fake generation backend (or a running one with `VH_BACKEND_URL`) and asserts the expected states, including plan scheduling in both continuity modes and the automatic replay.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Video harness subsystem](../../../docs/subsystems/video-harness.md) — drafts, undo, branches, and staleness across the harness.
- [`@video-harness/oplog`](../oplog/README.md) — the records the runtime writes.
- [`@video-harness/assets`](../assets/README.md) — where tool outputs are stored.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the runtime records tool calls and folds state; the tools it invokes own every model request.

#### KV Cache effect

None; the runtime itself sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Undo is the latest turn only** — undoing an earlier turn is a `revert` record that the runtime does not yet write; branch from before that turn instead.
- **Placeholder generator** — the built-in `generate.video` renders a solid color; a profile mounts `@video-harness/tools` with a generation backend for real shots.
- **Replay follows record inputs** — a deterministic record that reads assets through its params, such as `sequence.create`, is repointed slot by slot rather than rerun; non-deterministic consumers of a replaced asset are only marked stale.
- **Scheduled failures are recorded only** — a scheduled record that fails, or whose producer failed, ends `failed` in the log without notifying the caller; `whenIdle` followed by a fold shows it.
