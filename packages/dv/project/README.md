---
description: "Project component of DreamVerse: the dvProject service that stores every project's records and branches, runs operations, computes state and history, turns every operation into its agent tool with its confirmation rule, owns the dv_proj_* tools, and contributes the dv:project prompt section."
kind: "package-reference"
---

# @dv/project

English | [中文](README.zh.md)

## Summary

Use this package to change and read DreamVerse projects. Every change is a record written by `dvProject.run` (component operations) or by a `proj.*` method (undo, redo, stale accept); forking, switching and renaming branches change only `branches.json`. Components register their operations with `registerOperation` and their reducers with `registerReducer`. While the DSH `tools` registry is mounted, every operation becomes its agent tool `dv_<operation name with _>`, beside Project's own `dv_proj_*` tools. While the DSH `systemPrompt` service is mounted, Project's rules and the project summary of the current branch reach the agent as the `dv:project` prompt section. `CONTRACTS.md` specifies each internal module.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the projects directory and the session directory. The asset pool registers its store with `registerAssetStore` when it loads, and chat sessions are bound to projects with `bindSession`. An operation that needs the user's agreement before an agent call sets `OperationSpec.confirm` to `always` or `over_gpu_budget` and provides `confirmSummary(call, state)`, which returns `{text, gpu_seconds}`: what the call will do and its GPU estimate; `registerOperation` refuses such a spec without `confirmSummary` (`invalid_params`). Project then adds the tool-only argument `user_approved` (`always`) or `user_requested` (`over_gpu_budget`) to the operation's tool and refuses an agent call without it, before any record is written, when `always` applies or when the turn's GPU seconds pass `confirmGpuSecondsThreshold`; the refusal tells the agent to ask the user in the conversation with the question in bold. The argument never reaches the record's params, and calls by the human or the system are never refused. Each reducer adds its slice's fields to the project summary through `Reducer.agentSummary`. An operation lists in `OperationSpec.pendingInputRoles` the input roles that may name the output of a record that is not done yet: the runner records and executes such a call at once with a null `resolved_asset`, which the record's current form fills when the producer finishes (Timeline clips that wait for their render use it).

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
| `confirmGpuSecondsThreshold` | `60` | Estimated GPU seconds one agent turn may spend on `over_gpu_budget` operations before the user must agree |
| `promptSectionOrder` | `4900` | Order of the `dv:project` section in the system prompt; before the tool SDK section at 5000 |

<a id="understand-the-implementation"></a>
## Understand the implementation

The service in `src/index.ts` delegates to eleven private modules: the record store (the only code that touches `project.json`, `records.jsonl` and `branches.json`), the runner, the scheduler, branches, history, the reducer registry, subscriptions, the chat sessions (bindings, held tool calls), the agent tools (one DSH tool per operation, with the confirmation check), the `dv_proj_*` tools, and the agent context (the `dv:project` prompt section). A project starts with the branch `main`; every other branch is `b<n>`, forked from another branch, and branches are never merged. `branches.json` also stores the project's current branch, which every view and every chat session reads and every write of every actor goes to at once. A branch is forked only when the human (or the agent, when the human asks) creates one, or when a write arrives while the current branch's head stands before its tip after an undo; the fork starts at the head's position, the old branch returns to its tip and keeps the undone steps, and the new branch becomes current. Records carry `session`, `turn` and `tool_call` as links into the DSH session log: the agent tools read the turn when a tool runs, as the DSH turn number of the calling agent's session from the `turnBoundary` session projection that the agent loop registers (null outside a turn or without an agent). `CONTRACTS.md` lists each module's functions, rules, errors and tests. `listHistory(query)` is the one history query: the `dv_proj_history_list` tool and the `POST /api/dv/history` route of `@dv/api` both call it. Its filters (`branch`, `marks`, `actor`, `component`, `operation`, `kind`, `status`, `session`, `turn`, `tool_call`, `records`, `before`) combine with AND, and `limit` applies after them; each entry carries its mark (`current`, `redo`, `branch`, `undone`) and the branches whose line holds the record.

<a id="further-exploration"></a>
## Further Exploration

- `CONTRACTS.md` in this package: module contracts and the test plan.

<a id="model-experience"></a>
## Model Experience

### Operation tool definitions

#### What the model sees

While the DSH `tools` registry is mounted, every registered operation reaches the model as one tool, `dv_<operation name with _>`: the operation's `description` followed by the resource hint ("Uses the GPU." or "Runs on the CPU.") and a note for reads ("A read that writes no record.") and deterministic operations ("Repeating a call with the same inputs and params reuses the earlier result."); its `params` plus `toolParams` and, by `confirm`, the boolean `user_approved` ("Set true only after the user agreed to this exact call in the conversation. …") or `user_requested` ("Set true when the user asked for this exact change, or agreed to it in the conversation. …"); and the shared arguments `reason` (the record's intent), `project_id`, `inputs` (`<asset>`, `<record>#<output>`, or `<id>@<version>` for a character, location or style version, by role; only for operations with inputs), `supersedes` and `based_on` (the last two only for operations that write a record).

#### Token effect

The shared arguments add up to about 200 tokens to each definition, and a confirmation argument about 40 more; the operation's description and params add the rest, and each component README gives the total of its tools.

#### KV Cache effect

The definitions sit in the stable tool section of every request of an agent that mounts the DSH tool registry; registering or removing an operation changes the tool list and invalidates the cached prefix from the tool section on.

### Operation tool results

#### What the model sees

A call returns one text block: `<status> <record>: <summary>` (`<status>: <summary>` for a read, which writes no record), one line per output with its asset ID, media type and URL, the scheduled records, the params, and the report; each image output follows as one image block while an attachment service is mounted. A record that failed or was cancelled returns a tool error with its message, and a stopped one returns "dv_<name> was stopped before it finished.". A call that needs the user's agreement and lacks it returns a tool error: "dv_<name> needs the user's agreement." (or, past the budget, "dv_<name> would bring this turn to about N GPU seconds, above the M s budget."), then "What it will do:" with the `confirmSummary` text, the estimated GPU time, and the instruction to show this to the user, ask in the conversation with the question in bold, and call again with `user_approved: true` or `user_requested: true` after the user's answer.

#### Token effect

Roughly 50 to 200 tokens of text per call, plus the image blocks; a confirmation refusal adds the length of its summary text.

#### KV Cache effect

Each result is appended to the conversation after its call; the cached prefix stays intact.

### Project tools

#### What the model sees

Nine tools: `dv_proj_create`, `dv_proj_open`, `dv_proj_state`, `dv_proj_history_list`, `dv_proj_branch_create`, `dv_proj_undo`, `dv_proj_redo`, `dv_proj_stale_accept` and `dv_proj_wait`. `dv_proj_history_list` returns records newest first with their marks and branch lines (20 by default); the others return the project summary of a branch as indented JSON: `record` (only after a tool that writes records: the newest record the call wrote), `project_id`, `head`, `branch`, `branches` (each `{name, title}`), `records` (the count), then the `agentSummary` fields of each component in component key order (Story bible `characters`, `locations`, `styles`; Shot plan `plans`; Timeline `timelines`), then `stale` and `recent` (at most twelve records with their summaries and output URLs). `dv_proj_branch_create` forks a branch from the current state, with an optional `title`, and continues on it; the agent calls it only when the user asks for a new branch. `dv_proj_undo` and `dv_proj_redo` act on the current branch: `dv_proj_undo` without `to` undoes one step, and with `to` (a record ID from `dv_proj_history_list`) returns the project to its state just after that record; `dv_proj_redo` moves forward one step.

#### Token effect

About 800 tokens for the nine definitions, fixed while the plugin is mounted. A project summary starts near 150 tokens and grows with the project: each recent record, character, location, style, plan and clip adds its fields.

#### KV Cache effect

The nine definitions are a fixed part of the stable tool section; each result is appended to the conversation after its call, so the cached prefix stays intact.

### Project prompt section

#### What the model sees

While the DSH `systemPrompt` service is mounted, the system prompt of every step carries the `dv:project` section. It starts with Project's rules: every call of the agent and every edit of the user lands on the project's current branch at once, and the user does not accept changes; `dv_proj_undo` and `dv_proj_redo` roll the branch back and forward, never new edits that rebuild an earlier state, and a change written after a roll back continues on a new branch while the undone steps stay on the old branch; `dv_proj_branch_create` is called only when the user asks for a new branch; things are named by the IDs in the project summary (record, `<record>#<n>`, `<id>@<version>`, asset, clip), the user points at things with + → 引用 or `dv:` mentions, and an ambiguous reference is asked about instead of guessed; a call refused for the user's agreement is shown to the user and asked about in the conversation with the question in bold; stale records are redone only when the user agrees. For a session bound to a project, the rules are followed by "This conversation belongs to project <ProjectId> …" and the project summary of the current branch as indented JSON, the same summary `dv_proj_state` returns. For an unbound session, the rules are followed by "No project is bound to this conversation yet: start the work with dv_proj_create.". The section holds no selection and no preference that the user cannot see.

#### Token effect

About 450 tokens of rules on every step, plus the project summary of the current branch: about 150 tokens for a new project, growing with the project as described for the project tools.

#### KV Cache effect

The section sits in the system prompt at order `promptSectionOrder` (4900, before the tool SDK section) and is rebuilt at every step from the current branch, so every record that changes the summary, and every switch to another branch, invalidates the cached prefix from this section on; the rules alone stay stable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A character, location or style version without reference images resolves to no input, so a record that names such a version keeps no trace of it and does not become stale when the version changes.
