---
description: "Project component of DreamVerse: the dvProject service that stores every project's records, branches and drafts, runs operations, computes state and history, turns every operation into its agent tool, and owns the dv_proj_* tools."
kind: "package-reference"
---

# @dv/project

English | [中文](README.zh.md)

## Summary

Use this package to change and read DreamVerse projects. Every change is a record written by `dvProject.run` (component operations) or by a `proj.*` method (drafts, undo, redo, branches). Components register their operations with `registerOperation` and their state reducers with `registerReducer`; while the DSH `tools` registry is mounted, each registered operation also becomes its agent tool `dv_<operation name with _>`, and Project adds its own `dv_proj_*` tools, which bind a chat session to its project and return the project summary; each reducer adds its slice's fields to that summary through `Reducer.agentSummary`. The asset pool registers itself with `registerAssetStore`, chat sessions are bound to projects with `bindSession`, and the agent integration checks every agent tool call through `registerToolCallCheck`. `CONTRACTS.md` specifies each internal module.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the projects directory and the session directory. The asset pool registers its store when it loads.

```yaml
- id: dv-project
  name: '@dv/project'
  config:
    root: $VH_STATE_ROOT/projects
    sessionRoot: $VH_STATE_ROOT/sessions
```

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory holding one `<ProjectId>/` per project; created when missing |
| `cpuConcurrency` | `4` | Scheduled `cpu` records that may run at the same time |
| `gpuConcurrency` | `1` | Scheduled `gpu` records that may run at the same time |
| `sessionRoot` | required | Directory holding one `<session>.json` per chat session with the project it is bound to |

<a id="understand-the-implementation"></a>
## Understand the implementation

The service in `src/index.ts` delegates to ten private modules: the record store (the only code that touches `project.json`, `records.jsonl` and `branches.json`), the runner, the scheduler, drafts and branches, history, the reducer registry, subscriptions, the chat sessions (bindings, turns, held tool calls), the agent tools (one DSH tool per operation), and the `dv_proj_*` tools. `CONTRACTS.md` lists each module's functions, rules, errors and tests.

<a id="further-exploration"></a>
## Further Exploration

- `CONTRACTS.md` in this package: module contracts and the test plan.

<a id="model-experience"></a>
## Model Experience

Every registered operation reaches the model as one tool, `dv_<operation name with _>`: the operation's `description` followed by the resource hint ("Uses the GPU.", "Runs on the CPU.") and a note for reads (no record) and deterministic operations (a repeated call reuses the earlier result), its `params` plus `toolParams`, and the shared arguments `reason` (the record's intent), `project_id`, `inputs` (`<asset>`, `<record>#<output>`, or `<id>@<version>` for a character, location or style version, by role), `supersedes` and `based_on` (the last two only for operations that write a record). The result is one text block (`<status> <record>: <summary>`, one line per output with its URL, the scheduled records, the params and the report) plus one image block per image output while an attachment service is mounted.

Project's own tools are `dv_proj_create`, `dv_proj_open`, `dv_proj_state`, `dv_proj_history_list`, `dv_proj_draft_accept`, `dv_proj_draft_discard`, `dv_proj_undo`, `dv_proj_redo`, `dv_proj_stale_accept`, `dv_proj_branch_create`, `dv_proj_branch_switch` and `dv_proj_wait`. `dv_proj_history_list` returns records newest first with their marks; the others return the project summary of a branch as indented JSON: `project_id`, `head`, `branch`, `draft` (counts or null), `branches`, `records` (the count), then the `agentSummary` fields of each component in component key order (Story bible `characters`, `locations`, `styles`; Shot plan `plans`; Timeline `timelines`), then `stale` and `recent` (at most twelve operation records with their summaries and output URLs). The summary grows with the project.

#### KV Cache effect

Each registered operation adds one tool schema to every request of an agent that mounts the DSH tool registry, and the twelve `dv_proj_*` tools add a fixed set; registering or removing an operation changes the tool list and invalidates the cached prefix from the tool section on.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A character, location or style version without reference images resolves to no input, so a record that names such a version keeps no trace of it and does not become stale when the version changes.
