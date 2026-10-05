# Video harness

English | [中文](video-harness.zh.md)

The video harness is the project layer for video production inside DeepSeek Harness. This page owns the vocabulary and the cross-package rules of the [`packages/video-harness/`](../../packages/video-harness/README.md) group: the layers, the operation record, how views and the agent write, and how staleness, drafts, undo, and branches work. Each package README owns its configuration and service API.

## Layers

```text
views (chat, timeline, canvas) and the agent     clients of the runtime; they only invoke tools
  │  vhProject.invoke(tool, inputs, params, who/where/why)
  ▼
runtime (@video-harness/runtime)                 fold, turns, drafts, undo, branches, staleness, deterministic cache
  │
  ├── oplog (@video-harness/oplog)               append-only records and branch heads, one directory per project
  └── assets (@video-harness/assets)             immutable bytes by SHA-256, with the operation that produced them
```

Tools are registered on the runtime (`registerTool`). The runtime ships built-in tools for uploads, entities, plans, sequence edits, a deterministic `clip.trim` through ffmpeg, and a placeholder `generate.video` that renders a solid-color clip. A profile mounts [`@video-harness/tools`](../../packages/video-harness/tools/README.md) for the typed specs: it registers them with the runtime, exposes each as a `vh_<name>` DSH tool whose call becomes one record, and mounts `generate.video` over the DreamVerse generation backend and `perception.describe` over the default model. Media tools run through [`@video-harness/media`](../../packages/video-harness/media/README.md). A spec declares a cost class (`free`, `cpu`, `gpu`); the runtime's `schedule` runs queued records under one concurrency limit per class and expands an approved plan into one generation per shot.

## The operation record

Every change to a project is one record: who (`actor`), from which view (`surface`), the user's words or gesture (`intent`), the tool or command, the inputs with the asset each resolved to, the params, the outputs, the status, the turn, the parent record, and two links that drive staleness: `base_op` (this record modifies a copy of that one) and `supersedes` (this record replaces those records' outputs). Records are appended, never rewritten; a status change is appended as a patch line. Branches are named pointers to records.

## How a view writes

A gesture on the timeline or the canvas becomes a tool call with `surface` set to that view; a chat message becomes an `intent` record followed by the agent's tool calls. No view holds project state and no view talks to another: each subscribes to the log of the branch it shows and folds it.

## Drafts, acceptance, undo, branches

An agent turn opens `draft/<turn>` at the `main` head and writes there. `acceptTurn` appends an `approve` record and moves `main` to it; it is refused when `main` moved since the draft forked, and the agent then re-plans on the current `main`. `rejectTurn` leaves the draft in the log. `undoLatestTurn` moves `main` back to the record before the latest turn; the records stay. `createBranch` starts an exploration at any record or branch head, and folding that branch gives the state at that point.

## The agent layer

[`@video-harness/agent`](../../packages/video-harness/agent/README.md) binds the DSH agent loop to the runtime through the tool bridge in [`@video-harness/tools`](../../packages/video-harness/tools/README.md). A `turn/start` session event tells the bridge which agent-loop turn a session is in; the first structured call of that turn opens the draft, and a draft opened in an earlier turn is not extended until `vh_turn_accept` or `vh_turn_reject` closes it. At `turn/end` of a completed turn, a draft whose records are all deterministic or carry `user_requested: true`, with no `confirm: always` tool among them, is accepted into `main`; any other draft with records stays open for the user's decision, and an empty or aborted draft is rejected. Confirmation follows each spec's `confirm` class: `always` runs only with `user_approved: true` or the user's answer to a `userQuestions` question; `cost` asks only when the turn's estimated GPU seconds exceed the bridge's budget and the call does not carry `user_requested: true`; `never` runs. A system-prompt section carries the bound project's entities, timeline slots, takes, stale records, and plans so the model resolves references to concrete ids, and the `video-directing` and `branching-story` skills hold the procedures. [`@video-harness/bundle`](../../packages/bundle/video-harness/README.md) composes all of it as the `video-harness` and `video-harness-headless` profiles.

## The views

[`@video-harness/views`](../../packages/video-harness/views/README.md) is the HTTP face of the runtime for the browser: `/api/vh/state` folds a head into one JSON document, `/api/vh/invoke` runs a tool as a user turn whose records carry `surface: 'canvas'` or `'timeline'`, `/api/vh/turn`, `/api/vh/undo`, and `/api/vh/branch` expose the draft, undo, and branch operations, and `/vh/events` streams every log change. [`@video-harness/ui-canvas`](../../packages/video-harness/ui-canvas/README.md) and [`@video-harness/ui-timeline`](../../packages/video-harness/ui-timeline/README.md) are right-Sidebar tab types of the web application, so they sit beside the chat page in one profile: the canvas draws the records of the shown head as a DAG of asset flow (entities as sources, plans collapsed into one node, takes beside their base, drafts dashed, stale records marked) and lets the user edit a record's params and write the edit as a superseding record or a new take; the timeline draws the folded sequence as one track and turns reorder, range, trim, and insert gestures into `sequence.*` and `clip.trim` records. Both keep no project state: they fold what the host sends, refetch on every event, and report the selected node or clip to `/api/vh/selection` so the agent can be told what the user pointed at. [`@video-harness/ui-kit`](../../packages/video-harness/ui-kit/README.md) holds the browser code the two share.

## Staleness

A record is stale when one of its inputs was produced by a record that a later record `supersedes`, when an input's producer is itself stale, or when an entity input is older than the entity's current version (`entity.update` supersedes the previous version). The fold reports stale records; it reruns nothing. Deterministic tools may be replayed on new inputs through the cache; generation tools are rerun only when the agent or the user decides. An `accept_stale` record clears the mark for one record.

## Deterministic cache

A deterministic tool whose name, version, params, and resolved inputs match an earlier successful record reuses that record's outputs; the call is still recorded, with `cost.cached` set. Generation tools are never cached: the same request again is a new take, grouped with the original through `base_op`.
