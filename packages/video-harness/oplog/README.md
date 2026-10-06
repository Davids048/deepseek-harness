---
description: "Append-only operation log of the video harness: the Op record type, per-project JSONL storage, forward-only patches, named branch heads, ancestry walks, and change subscriptions."
kind: "package-reference"
---

# @video-harness/oplog

English | [中文](README.zh.md)

## Summary

Use this package as the single source of truth of a video project. Every change is one `Op` record: who did it, from which view, the request, the tool, the inputs and what they resolved to, the params, the outputs, and the parent record. Records are appended and never rewritten; a status change is an appended patch line. Branches are named pointers to records, so undo, drafts, and explorations are pointer moves and new branches, and the state at any record is reconstructed by folding its ancestors.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with a root directory. The runtime injects `vhOpLog`; views subscribe to it.

```yaml
- id: vh-oplog
  name: '@video-harness/oplog'
  config:
    root: /home/user/.local/state/video-harness/projects
```

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory holding one `<project_id>/` per project; created when missing |

| Method | Behavior |
| --- | --- |
| `createProject({title})` / `listProjects()` / `project(id)` | A project directory with an empty log and no heads |
| `append(projectId, draft, parent)` | Appends a record on `draft.branch`; `parent` must be that branch's head, except for a `branch` record, which may follow any record and creates its branch |
| `update(projectId, opId, patch)` | Status forward only (`pending → running → done \| failed`), plus outputs, resolved inputs, cost, error, and finish time |
| `get` / `all` / `ancestors(projectId, opId)` | One record, every record in creation order, or the chain from the first record to `opId` |
| `heads` / `createBranch(projectId, name, at, turn?)` / `moveHead(projectId, branch, to)` | Branch pointers: read, create at a record, or move |
| `subscribe(projectId, listener)` | Synchronous `append`, `patch`, and `head` events until the returned function is called |

The `Op` type, the `OpDraft` and `OpPatch` helpers, the ID brands, `MAIN_BRANCH`, and `statusAdvances` are exported for the runtime and the views.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each project is `<root>/<project_id>/` with `project.json` (title and creation time), `ops.jsonl` (records and patch lines in write order), and `heads.json` (branch name → record ID, written atomically through a temporary file). At start the service replays every directory: records first, then patches applied to the records they name, then the heads; a patch for an unknown record is ignored and a directory without `project.json` is skipped. The in-memory log is a map of records, the creation order, the heads, and the listeners; every mutation writes the file first and notifies listeners after the in-memory state changed.

| File | Content |
| --- | --- |
| [`src/types.ts`](src/types.ts) | The `Op` record and its parts |
| [`src/index.ts`](src/index.ts) | `vhOpLog`: storage, replay, append rules, patches, branches, subscriptions |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Video harness subsystem](../../../docs/subsystems/video-harness.md) — what the record fields mean across the harness.
- [`@video-harness/runtime`](../runtime/README.md) — the only writer of records in a running harness.

-----

<a id="model-experience"></a>
## Model Experience

None, as the log keeps operation records and branch heads that no model request reads directly.

#### KV Cache effect

None; the log adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Single parent** — a record has one parent; merging two branches is not representable yet.
- **One process** — the log keeps no file lock; two harness processes over the same root would interleave writes.
- **Whole-file replay** — start time grows with the number of records; there is no snapshot of folded state.
