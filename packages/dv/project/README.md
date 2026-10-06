---
description: "Project component of DreamVerse: the dvProject service that stores every project's records, branches and drafts, runs operations, computes state and history, turns every operation into its agent tool, and owns the dv_proj_* tools."
kind: "package-reference"
---

# @dv/project

English | [中文](README.zh.md)

## Summary

Use this package to change and read DreamVerse projects. Every change is a record written by `dvProject.run` (component operations) or by a `proj.*` method (drafts, undo, redo, branches). Components register their operations with `registerOperation` and their state reducers with `registerReducer`. While the DSH `tools` registry is mounted, each registered operation also becomes its agent tool `dv_<operation name with _>`, and Project adds its own `dv_proj_*` tools, which bind a chat session to its project and return the project summary. `CONTRACTS.md` specifies each internal module.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the projects directory and the session directory. The asset pool registers its store with `registerAssetStore` when it loads, chat sessions are bound to projects with `bindSession`, and the agent integration checks every agent tool call through `registerToolCallCheck`. Each reducer adds its slice's fields to the project summary through `Reducer.agentSummary`.

```yaml
- id: dv-project
  name: '@dv/project'
  config:
    root: $DV_STATE_ROOT/projects
    sessionRoot: $DV_STATE_ROOT/sessions
```

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory holding one `<ProjectId>/` per project; created when missing |
| `cpuConcurrency` | `4` | Scheduled `cpu` records that may run at the same time |
| `gpuConcurrency` | `1` | Scheduled `gpu` records that may run at the same time |
| `sessionRoot` | required | Directory holding one `<session>.json` per chat session with the project it is bound to |

<a id="understand-the-implementation"></a>
## Understand the implementation

The service in `src/index.ts` delegates to ten private modules: the record store (the only code that touches `project.json`, `records.jsonl` and `branches.json`), the runner, the scheduler, drafts and branches, history, the reducer registry, subscriptions, the chat sessions (bindings, turns, held tool calls), the agent tools (one DSH tool per operation), and the `dv_proj_*` tools. `CONTRACTS.md` lists each module's functions, rules, errors and tests. `listHistory(query)` is the one history query: the `dv_proj_history_list` tool and the `POST /api/dv/history` route of `@dv/api` both call it. Its filters (`branch`, `marks`, `actor`, `component`, `operation`, `kind`, `status`, `session`, `turn`, `tool_call`, `records`, `before`) combine with AND, and `limit` applies after them.

<a id="further-exploration"></a>
## Further Exploration

- `CONTRACTS.md` in this package: module contracts and the test plan.

<a id="model-experience"></a>
## Model Experience

### Operation tool definitions

#### What the model sees

While the DSH `tools` registry is mounted, every registered operation reaches the model as one tool, `dv_<operation name with _>`: the operation's `description` followed by the resource hint ("Uses the GPU." or "Runs on the CPU.") and a note for reads ("A read that writes no record.") and deterministic operations ("Repeating a call with the same inputs and params reuses the earlier result."); its `params` plus `toolParams` and the argument the agent integration's question rule adds; and the shared arguments `reason` (the record's intent), `project_id`, `inputs` (`<asset>`, `<record>#<output>`, or `<id>@<version>` for a character, location or style version, by role; only for operations with inputs), `supersedes` and `based_on` (the last two only for operations that write a record).

#### Token effect

The shared arguments add up to about 200 tokens to each definition; the operation's description and params add the rest, and each component README gives the total of its tools.

#### KV Cache effect

The definitions sit in the stable tool section of every request of an agent that mounts the DSH tool registry; registering or removing an operation changes the tool list and invalidates the cached prefix from the tool section on.

### Operation tool results

#### What the model sees

A call returns one text block: `<status> <record>: <summary>` (`<status>: <summary>` for a read, which writes no record), one line per output with its asset ID, media type and URL, the scheduled records, the params, and the report; each image output follows as one image block while an attachment service is mounted. A record that failed or was cancelled returns a tool error with its message, and a call the user declined returns "The user declined dv_<name>. Do not retry it unchanged."

#### Token effect

Roughly 50 to 200 tokens of text per call, plus the image blocks.

#### KV Cache effect

Each result is appended to the conversation after its call; the cached prefix stays intact.

### Project tools

#### What the model sees

Twelve tools: `dv_proj_create`, `dv_proj_open`, `dv_proj_state`, `dv_proj_history_list`, `dv_proj_draft_accept`, `dv_proj_draft_discard`, `dv_proj_undo`, `dv_proj_redo`, `dv_proj_stale_accept`, `dv_proj_branch_create`, `dv_proj_branch_switch` and `dv_proj_wait`. `dv_proj_history_list` returns records newest first with their marks (20 by default); the others return the project summary of a branch as indented JSON: `record` (only after a tool that writes records: the newest record the call wrote), `project_id`, `head`, `branch`, `draft` (counts or null), `branches`, `records` (the count), then the `agentSummary` fields of each component in component key order (Story bible `characters`, `locations`, `styles`; Shot plan `plans`; Timeline `timelines`), then `stale` and `recent` (at most twelve operation records with their summaries and output URLs).

#### Token effect

About 1,000 tokens for the twelve definitions, fixed while the plugin is mounted. A project summary starts near 150 tokens and grows with the project: each recent record, character, location, style, plan and clip adds its fields.

#### KV Cache effect

The twelve definitions are a fixed part of the stable tool section; each result is appended to the conversation after its call, so the cached prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A character, location or style version without reference images resolves to no input, so a record that names such a version keeps no trace of it and does not become stale when the version changes.
