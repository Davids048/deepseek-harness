# DreamVerse packages

English | [中文](video-harness.zh.md)

The DreamVerse packages are the project layer for video production inside DeepSeek Harness. This page owns the vocabulary and the cross-package rules of these packages under `packages/dv/` and of the [`packages/video-harness/`](../../packages/video-harness/README.md) group: the layers and their roles, the render modes, the operation record, how views and the agent write, confirmation in the conversation, project state, branches and undo, what the agent reads, staleness, [where new behavior goes](#where-new-behavior-goes), and the [glossary](#glossary) of the names that code, records, tools, and interface copy use. Each package README owns its configuration and service API.

## Layers and roles

```text
views          @dv/ui-shell @dv/ui-canvas @dv/ui-timeline @dv/ui-asset-pool @dv/ui-composer @dv/ui-history (+ library @dv/ui-kit)
  │ HTTP: /api/dv/…, /dv/events
  ▼
API            @dv/api                    routes that read state and run operations as the user; the event stream
  │ dvProject.run, getState, listHistory
  ▼
registry       @dv/project                records, branches, undo and redo, state, agent tools, the dv:project prompt section
  ▲ registerOperation, registerReducer             ▲ dvProject.run (asset.import), current-branch reads
  │                                                │
components     @dv/asset-pool @dv/story-bible      chat references   @dv/chat-references   dv: mentions, chat images
               @dv/shot-plan @dv/shot-render
               @dv/timeline @dv/deliver @dv/inspector
  │ ctx.dvRef2va, ctx.dvT2va (Consumer: @dv/shot-render)
  ▼
render modes   @dv/render-modes           Service Definitions dvRef2va, dvT2va
  ▲ subclass and register the service
  │
providers      @dv/fasth3-ref2va @dv/fasth3-t2va   each with its prompt skill

bundle         @dv/bundle                 the cordis.patch.yml rows of every package above, the video-directing skill
```

Each arrow points from a package to the package it depends on, and no dependency points the other way. A component runs another component's operation only through `dvProject.run` by its name. In DeepSeek Harness terms, the layers have these roles:

| Layer           | Packages                                                                                                                                                                                                                                                     | Role                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| registry        | [`@dv/project`](../../packages/dv/project/README.md)                                                                                                                                                                                                         | The `dvProject` Service: components register operations and reducers with it, as tools register with `ctx.tools`. It is the only writer of project files, turns every operation into a DSH tool, and registers the `dv:project` system-prompt section. |
| components      | `@dv/asset-pool`, `@dv/story-bible`, `@dv/shot-plan`, `@dv/shot-render`, `@dv/timeline`, `@dv/deliver`, `@dv/inspector`                                                                                                                                      | Plugins that each own one capability: its data (a state slice and its reducer), its operations, and the text the agent reads about them. External programs come through [`@dv/ffmpeg`](../../packages/dv/ffmpeg/README.md).                            |
| render modes    | [`@dv/render-modes`](../../packages/dv/render-modes/README.md), [`@dv/fasth3-ref2va`](../../packages/dv/fasth3-ref2va/README.md), [`@dv/fasth3-t2va`](../../packages/dv/fasth3-t2va/README.md), [`@dv/shot-render`](../../packages/dv/shot-render/README.md) | One capability seam per render mode: `@dv/render-modes` holds the Service Definitions, the FastH3 packages are Service Providers, and Shot render is the Consumer.                                                                                     |
| API             | [`@dv/api`](../../packages/dv/api/README.md)                                                                                                                                                                                                                 | Fetch routes on the DSH `connection` service and an event stream on `webServer`; the only way a view reads or changes a project.                                                                                                                       |
| chat references | [`@dv/chat-references`](../../packages/dv/chat-references/README.md)                                                                                                                                                                                         | Listeners on `agent/pre-step` and `session/event` that turn what the user points at in a chat message into project IDs and assets.                                                                                                                     |
| views           | `@dv/ui-*`                                                                                                                                                                                                                                                   | Right-Sidebar tab types and center views of the DSH Web Client; `@dv/ui-kit` is the library they share.                                                                                                                                                |
| bundle          | [`@dv/bundle`](../../packages/bundle/dv/README.md)                                                                                                                                                                                                           | The profile layer that composes every row as the `video-harness` and `video-harness-headless` profiles and ships the `video-directing` skill.                                                                                                          |

Components register their operations with `dvProject.registerOperation` and their reducers with `dvProject.registerReducer`. Each operation is also the agent tool `dv_<operation name with _>`, whose call becomes one record. The asset pool's `dv_asset_import` and `dv_asset_grab_still` add assets; Story bible's `dv_bible_*` tools create and update character, location, and style versions; Shot plan's `dv_plan_create` writes version 1 of a new plan, which gets a `PlanId` (`p1`, `p2`, …), `dv_plan_update` writes the next version of the plan its `plan` param names, and `dv_plan_approve` approves one version; Shot render's `dv_shot_render_ref2va` and `dv_shot_render_t2va` render one take of a shot in their [render mode](#render-modes), with `duration_sec` a whole number of seconds within the served model's range (default: the model's minimum); Timeline's `dv_timeline_*` tools create, update, rename, and delete timelines and insert, move, remove, split, trim, and replace clips without creating files; Deliver's `dv_deliver_timeline_export` writes a timeline to one video; and Inspector's `dv_inspect_image` and `dv_inspect_asset` read assets without writing a record. Project's own `dv_proj_*` tools create and open projects, read the state and the history, create a branch, undo, redo, accept stale records, and wait for scheduled records. An operation declares a resource class (`none`, `cpu`, `gpu`) and a confirmation policy (`never`, `always`, `over_gpu_budget`; see [Confirmation in the conversation](#confirmation-in-the-conversation)); Project's scheduler runs scheduled records under one concurrency limit per class.

A plan approval runs, as the `system` actor, one call of the shot's render operation (`shot.render_<mode>`) per new or changed shot of the approved version, with the params `plan`, `plan_version`, and `shot` (the shot's 1-based position, which a shot keeps across versions). A shot is unchanged when a done record of the same render operation for the same plan on the approving branch has the same params apart from `plan`, `plan_version`, and `shot`, the same reference inputs, and the same first frame; the approval reuses the newest such take instead of rendering. It then runs a `timeline.update` of the plan's timeline (the timeline whose latest create or update record names the plan) with every shot's take in shot order, or a `timeline.create` when the plan has none; a shot whose render is not done yet shows as a placeholder clip until it finishes. The approval lists the scheduled records in its `report.scheduled`. A clip has a `ClipId` (`cl1`, `cl2`, …) that the Timeline operation inserting it assigns and stores in the record's `report.clips`; the ID is unique within the project, is never reused, and names the clip in the `clip` param of every clip operation.

<a id="render-modes"></a>
## Render modes

A render mode is how a shot is rendered from its inputs. `ref2va` renders from a prompt, 1 to the model's `maxReferenceImages` reference images, and an optional first frame; `t2va` renders from a prompt only. Every render mode returns one video with audio and its last still, which Shot render stores as the two outputs of a take.

Each render mode is its own capability seam. The Service Definition is an abstract class in `@dv/render-modes` (`Ref2vaRenderer` as `ctx.dvRef2va`, `T2vaRenderer` as `ctx.dvT2va`) with the methods `model()`, `ready()`, and `render(request, signal)`. A Service Provider subclasses it for one backend: `@dv/fasth3-ref2va` and `@dv/fasth3-t2va` serve FastH3 models behind a FastVideo streaming_v2 server, and each registers its prompt skill (`fasth3-ref2va-prompting`, `fasth3-t2va-prompting`) with `ctx.skills`. The Consumer is `@dv/shot-render`: it registers `shot.render_ref2va` only while `dvRef2va` is mounted and `shot.render_t2va` only while `dvT2va` is mounted, so the agent has a `dv_shot_render_<mode>` tool only for a render mode the deployment serves. The bundle disables the `dv-fasth3-t2va` row while `DV_T2VA_BACKEND_URL` is unset.

The precondition of `shot.render_ref2va` refuses, for every caller, a call without a reference image; that rule belongs to the `ref2va` render mode, so `t2va` renders have no reference images at all. Each shot of a plan names its own render mode in `mode`, and `continue_previous: true` makes a `ref2va` shot start from the last still of the previous shot. `plan.create`, `plan.update`, and `plan.approve` refuse a shot whose render mode has no registered render operation, a `t2va` shot with references, and `continue_previous` on shot 1 or on a `t2va` shot.

## The operation record

Every change to a project is one record in the project's `records.jsonl` file, which only `@dv/project` reads and writes. Every record has `kind: 'operation'`: it is one call of one operation. A record holds who (`actor`: `user`, `agent`, or `system`), where the call came from (`surface`: `chat`, `canvas`, `timeline`, `asset_pool`, `history`, or `api`), why (`intent`: the agent's `reason` argument or a short description of the human's gesture), the owning `component` and the `operation` with its version, the params, the inputs with the asset each resolved to (`resolved_asset`), the outputs, the status, the parent record, and two links: `based_on` (this record repeats that record with changes, such as a new take with an edited prompt) and `supersedes` (this record replaces those records' outputs). The fields `session`, `turn`, and `tool_call` link a record to the DSH session log of the chat session that made it: the chat session ID, the DSH turn number of that session, and the tool call ID; the conversation itself stays in the session log. Records are appended, never rewritten; a status change, the cost, and the report are appended as an update line, and `branches.json` holds the branch pointers. Project's own actions are records too (`proj.create`, `proj.undo`, `proj.redo`, `proj.stale_accept`), while reads such as `dv_proj_state`, `dv_proj_history_list`, and the `inspect.*` operations write no record.

## How an operation runs

The views and the agent reach the same operations. A gesture on the canvas, the timeline, the asset pool panel, or the History panel runs an operation through the routes of `@dv/api` with `actor: 'user'` and `surface` set to that view. The agent calls the operation's `dv_*` tool, which runs it with `actor: 'agent'`, `surface: 'chat'`, the chat session, the turn, and the tool call ID. Before an agent call runs, the operation's `prepareToolCall` may refuse or change it, and Project applies the operation's `confirm` policy. Every call goes through the runner of `dvProject.run`. The runner validates the params; then, under the project lock, it resolves each input to an asset and calls the operation's `precondition`, which refuses a call for every caller before any record is written (`shot.render_ref2va` and `plan.approve` refuse a `ref2va` render without a reference image). The runner then appends the `pending` record and adds to its `supersedes` the records that the operation's own `supersedes` names. Finally the runner runs the owning component's implementation outside the lock and appends the final update with the outputs, the cost, and the report. A call whose input names an unfinished record, and each render that a plan approval schedules, waits in Project's scheduler until its inputs are done.

<a id="confirmation-in-the-conversation"></a>
## Confirmation in the conversation

The agent asks the user for agreement in the conversation, and the question is in bold. `OperationSpec.confirm` declares when an agent call needs that agreement:

| `confirm`         | Tool-only argument | An agent call is refused when                                                                               | Operations                               |
| ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `never`           | —                  | never                                                                                                       | every other operation                    |
| `always`          | `user_approved`    | it lacks `user_approved: true`                                                                              | `plan.approve`                           |
| `over_gpu_budget` | `user_requested`   | it lacks `user_requested: true` and the turn's GPU seconds pass `confirmGpuSecondsThreshold` of `dvProject` | `shot.render_ref2va`, `shot.render_t2va` |

The turn's GPU seconds are the cost of the turn's finished records, the `estimate` of its unfinished records, and the GPU estimate of this call. An operation with `confirm` other than `never` provides `confirmSummary(call, state)`, which returns `{text, gpu_seconds}`: what the call will do (for `plan.approve`, one line per shot with its render mode, duration, whether it continues the previous shot, and its prompt) and its GPU estimate. The refusal is a tool error that carries this text and tells the agent to show it, ask the user in the conversation with the question in bold, and call again with the argument after the user agreed. Nothing is written for a refused call, the argument never reaches the record's params, and calls by the human or the system are never refused.

## Project state

A reducer reads records and computes state; it writes no record. The runner and the record store are the only writers. The state of a branch is the result of folding its effective chain through the reducers: Project walks back from the branch head, follows each `proj.undo` and `proj.redo` record to the record its `params.to` names, and passes the kept records, oldest first, through every registered reducer. Each component's reducer turns its records into its slice of `ProjectState.components` (Story bible `bible`, Shot plan `plan`, Shot render `shot`, Timeline `timeline`), and Project's own reducer keeps the `proj` slice: the records of the effective chain, the stale and superseded records, and the record that created each asset. A reducer's `agentSummary` adds that component's fields to the project summary that the `dv_proj_*` tools and the `dv:project` prompt section give the agent.

The views show either records or state. The History panel lists records: in its list view the steps of the current branch with the steps that redo brings back, and in its tree view every step of every branch, each record with a mark that says where it stands (`current`, `redo`, `branch`, or `undone`) and the branches whose line holds it. The canvas, the timeline editor, and the asset pool panel show state: the state of the project's current branch at its head, so an undo, a jump to an earlier step, or a switch to another branch changes what they draw. No view holds project state: each fetches the state of the current branch and fetches it again on every event of the live stream.

## Branches and undo

A project starts with the branch `main`; every other branch is `b<n>` (`b2`, `b3`, …), forked from another branch, and branches are never merged: they share only the asset pool, so a branch uses a clip that another branch rendered by inserting it as an ordinary asset. `branches.json` stores every branch pointer and the project's current branch, which every view and every chat session reads and every write of every actor (`user`, `agent`, `system`) goes to at once; nobody accepts a change. A branch is forked in two cases only: the human creates one (from the branch menu, or by asking the agent, which calls `dv_proj_branch_create`), or a write arrives while the current branch's head stands before its tip after an undo. The fork starts at the head's position, the old branch returns to its tip and keeps the steps after the fork point, and the new branch becomes current. Undo, redo, switching, and reads never fork. Forking, switching, and renaming change `branches.json` only and write no record; a branch has an optional title, and without one the views show 主线 / Main or 分支 n / Branch n.

Undo and redo act on the project's current branch. Undo (`proj.undo`) without `to` goes back one step, where every record is one step; with `to`, it returns the branch to its state just after that record. Each undo appends a record whose `params.to` names the record whose state the branch returns to. Redo (`proj.redo`) moves forward one step on the redo line. A write after an undo forks a new branch, so the redo steps stay on the old branch. Switching to a step of another branch makes that branch current and returns it to that step. No record is rewritten or removed.

## What the agent reads

The agent reads a project through three channels, each owned by the package that owns its content:

- **Tools.** Each operation's `description` says how to use its tool; [`@dv/project`](../../packages/dv/project/README.md) builds the tool from the `OperationSpec`.
- **The `dv:project` prompt section.** `@dv/project` registers it while the DSH `systemPrompt` service is mounted. It holds Project's rules (every write lands on the current branch at once, undo and redo with the fork after a roll back, `dv_proj_branch_create` only on the user's request, how to name records, assets, versions, and clips, confirmation in the conversation, stale records), then the project summary of the current branch. It holds nothing the user cannot see: no selection in a view and no preference.
- **Chat references.** [`@dv/chat-references`](../../packages/dv/chat-references/README.md) expands the `dv:` mentions that the composer writes for `@` and `+ → 引用` into one context message with concrete record and asset IDs at `agent/pre-step`, and imports the images a user attaches in the chat with `asset.import` as the user; the session's next tool call waits for the import.

Skills hold procedures and model-specific rules, each registered by its owner:

| Skill                                              | Owner                                                                         | Registered through               | Content                                                                                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `video-directing`                                  | [`@dv/bundle`](../../packages/bundle/dv/README.md) (`skills/video-directing`) | the `skill-filesystem` directory | The planning procedure across components: the story and its shots, a render mode and inputs per shot, prompts written with the render mode's prompt skill, a plan the user agrees to, then rendering and retakes |
| `timeline-editing`                                 | [`@dv/timeline`](../../packages/dv/timeline/README.md)                        | `ctx.skills`                     | Editing timelines and clips                                                                                                                                                                                      |
| `fasth3-ref2va-prompting`, `fasth3-t2va-prompting` | the provider of each render mode                                              | `ctx.skills`                     | The model's limits and prompt rules for that render mode                                                                                                                                                         |

## The API and the views

[`@dv/api`](../../packages/dv/api/README.md) is the HTTP face of Project for the browser: `/api/dv/state` returns the state of one branch (by default the current branch) as one JSON document, `/api/dv/operations` lists the registered operations, `/api/dv/operation` runs an operation as the user with `surface: 'canvas'`, `'timeline'`, or `'asset_pool'`, `/api/dv/history` returns one page of the history, `/api/dv/branches/create`, `/api/dv/branches/switch`, `/api/dv/branches/rename`, `/api/dv/undo`, `/api/dv/redo`, and `/api/dv/stale/accept` expose the branch, undo, redo, and stale operations, other routes manage projects, asset imports, canvas layouts, and Workspace links, and `/dv/events` streams every record and branch change.

The interface packages are right-Sidebar tab types and center views of the web application, so they sit beside the chat page in one profile. [`@dv/ui-shell`](../../packages/dv/ui-shell/README.md) puts the project workspace in the center, the 对话 / Chat and 轨迹 / Trajectory tabs on the right, the 画布 / Canvas and 时间线 / Timeline toggle in the top bar, the branch menu of [`@dv/ui-kit`](../../packages/dv/ui-kit/README.md) in a bottom bar, a button with the current branch's name whose menu switches the project's current branch, forks a branch (新建分支 / New branch), and renames one in place, and binds Ctrl+Z and Shift+Ctrl+Z to undo and redo of the current branch. The History panel's header holds the same branch menu. [`@dv/ui-canvas`](../../packages/dv/ui-canvas/README.md) draws the current state of the current branch as nodes linked by asset flow: characters, locations, and styles at their current version, imported assets, each plan at its latest version with each shot's render mode and 接上一镜头 / Continues the previous shot where set, and takes with their render mode; stale records are marked, and its editor renders a new take or replaces a reference image as a user record. [`@dv/ui-timeline`](../../packages/dv/ui-timeline/README.md) draws each timeline as one track and turns insert, move, remove, split, and trim gestures into `timeline.*` records that name clips by `ClipId`, and its export into a `deliver.timeline_export` record. `@dv/ui-asset-pool` lists the assets of the current branch up to its head, shows the assets of other branches with their branch label behind 显示其他分支的素材 / Show assets from other branches, and imports files, and `@dv/ui-composer` adds the `@` and `+ → 引用` references, the render card, and the creator-facing tool names to the chat.

## History and the trajectory

The history is the project's records in order, from every actor, view, and chat session; the trajectory is the agent's steps in one chat session. A record links the two through its `session` and `tool_call` fields. [`@dv/ui-history`](../../packages/dv/ui-history/README.md) is the History panel (tab type `dv-history`). Its list view has one row per step of the current branch, newest first, with the action, who did it (你 / You, 智能体 / Agent, 自动 / Automatic), the status, an output thumbnail, 当前 / Current on the head step, and the steps that redo brings back dimmed; the records that a plan approval scheduled fold under the approval's row, and each row's ⋮ menu offers 回到这一步 / Go back to this step, which returns the branch to a step, and 从这里新建分支 / New branch from here, which forks a branch at that step. Its header holds the same branch menu as the bottom bar, the 列表 | 分支树 / List | Branch tree switch, and undo and redo. Its tree view, 分支树 / Branch tree, draws every step of every branch in one lane per branch with less information per step, labels each branch where its lane starts, and marks the head step with 当前 / Current; selecting a step selects it, and the 回到这一步 / Go back to this step in its ⋮ menu makes its branch current at that step. Selecting a row focuses the record's node on the canvas (`dv:canvas-focus`) or its clip on the timeline (`dv:timeline-focus`); the row's 在轨迹中查看 / Show in trajectory link sends `dv:trajectory-focus`, and `@dv/ui-shell` opens 轨迹 on that chat session at that tool call. In the chat, every settled row of a tool that writes a record has an 在历史中查看 / Show in history link, which sends `dv:history-focus` so the History panel selects the record that tool call wrote.

## Staleness

Project's reducer marks records stale; it reruns nothing. When a record lists a record X in `supersedes`, every record that read an output of X, and every record downstream of such a record, becomes stale; a later record that reads an input whose producer is superseded or stale is stale too. The producer of an input is the record that created its asset or, for a character, location, or style version, the record that wrote that version. The owning operation decides what a call supersedes through `OperationSpec.supersedes`: `bible.character_update`, `bible.location_update`, and `bible.style_update` supersede the record that created the previous version, so every record that read the previous version is stale. A caller can also name records in `supersedes`, as the agent does for a retake that replaces a shot. A stale record is rerun only when the agent or the human decides; `proj.stale_accept` clears the mark of one record and keeps its consumers from becoming stale through it.

## Deterministic reuse

When an operation with `deterministic: true` is called with the same operation and version, equal params, and the same resolved input assets as an earlier `done` record, the runner reuses that record's outputs instead of running the operation; the call is still recorded, with `cost.reused: true`. Renders are not deterministic: rendering a shot again gives a new take, a record of a render operation whose `based_on` names the earlier render, and Shot render's reducer groups the takes of a shot under its first render, whichever render mode each take used.

<a id="where-new-behavior-goes"></a>
## Where new behavior goes

New DreamVerse behavior attaches to an extension point that a package already owns, as DeepSeek Harness behavior does in the "Where new behavior goes" section of the [architecture page](../architecture.md).

### Principles

1. **Everything has one owner.** Each piece of data, each capability, and each text the agent reads belongs to one plugin, which registers it at an extension point itself.
2. **A plugin says in one sentence what it owns.** A plugin that can only be described as "connects A to B" owns nothing and is split among the owners of A and B.
3. **New behavior attaches to an existing extension point**, chosen from the lookup table below.
4. **Only a swappable capability becomes a capability seam.** A capability with two or more interchangeable implementations gets a Service Definition package and Service Provider packages.
5. **Dependencies point one way:** views → `@dv/api` → `@dv/project` ← components → Service Definition ← Service Provider. No package depends against this direction or names another plugin's operation in code.
6. **Text for the agent goes with its owner**, by this table:

| The text is about                                                                      | It goes in                                                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| How to use one component's tool                                                        | That operation's `description`                                                         |
| A procedure across several components                                                  | A skill in `@dv/bundle`                                                                |
| A model's limits and how to write its prompts, such as the reference-image requirement | The prompt skill of that model's Service Provider                                      |
| The project state, which changes every turn                                            | The `dv:project` prompt section of `@dv/project`, through the reducers' `agentSummary` |

### Procedure

When you add something, answer these questions in order:

1. What kind of thing is it: project data, an operation, a swappable capability, a model, text for the agent, a view, or logic attached to the agent loop?
2. Who owns it? When no package owns it, create a component and write the one sentence that says what it owns.
3. Which extension point does it attach to? Use the lookup table.
4. Must it be swappable? If so, make it a capability seam; if not, it is one registration in an ordinary plugin.
5. Does it carry text for the agent? If so, put the text with its owner by the table in the principles.

Then check that the owner's one sentence still holds, that no plugin name of another package is written into code, and that no dependency points against the direction of principle 5.

### Lookup table

| To add                           | Do this                                                                                                     | Example                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Project data                     | Add it to the owning component's reducer state and summarize it in `agentSummary`                           | The music of a shot            |
| An operation                     | `registerOperation` in the owning component; Project derives the tool, the API route, the history, and undo | `timeline.clip_split`          |
| A swappable capability           | A Service Definition package and Service Provider packages; the component that uses it is the Consumer      | Render modes, 3D rendering     |
| A model                          | A Service Provider package under an existing seam, with its own prompt skill                                | A MiniMax H3 provider          |
| Text for the agent               | Place it by the text table in the principles                                                                | "Show a plan before rendering" |
| A view                           | A `@dv/ui-*` plugin that reads and writes only through `@dv/api`                                            | The canvas                     |
| Logic attached to the agent loop | The owner of the data registers on a DSH event, such as `agent/pre-step` or `tools/pre-execute`             | `dv:` mention expansion        |

### Example: rendering without reference images

1. Kind: a render mode, which is a swappable capability.
2. Owner: the `t2va` seam; a Service Provider whose model supports `t2va` implements it.
3. Extension points: `@dv/render-modes` defines `dvT2va`, `@dv/fasth3-t2va` provides it, and `@dv/shot-render` registers `shot.render_t2va`, so the agent gets the tool `dv_shot_render_t2va`.
4. Swappable: yes; every render mode is its own seam.
5. Text: the `t2va` prompt rules are the skill `fasth3-t2va-prompting` of the provider; "every shot needs a reference image" is an input requirement of `ref2va` only, stated in the description of `dv_shot_render_ref2va` and in the `ref2va` provider's skill.

<a id="glossary"></a>
## Glossary

Code, record fields, tool descriptions, docs, and interface copy use these names, each with one meaning. The zh / en column is the copy the interface shows.

### Concepts

| Term            | zh / en copy          | Meaning                                                                                                                                                                                                              |
| --------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| component       | 组件 / Component        | A plugin that owns one capability: its implementation, data, operations, reducer, and tools.                                                                                                                         |
| operation       | 操作 / Operation        | An action a component implements that changes a project, or a read it serves.                                                                                                                                        |
| record          | 记录 / Record           | One log entry written by one operation call.                                                                                                                                                                         |
| tool            | 工具 / Tool             | Something the agent can call; a component tool (智能体工具 / agent tool) wraps one operation.                                                                                                                             |
| reducer         | —                     | A component function that reads records and computes its slice of the project state; it does not write records. The DSH counterpart is a session projection (`ctx.sessionProjections`), which folds the session log. |
| render mode     | 生成方式 / Render mode    | How a shot is rendered from its inputs: `ref2va` (参考图生成 / From references: a prompt and reference images) or `t2va` (文字生成 / From text: a prompt only). Each render mode is one capability seam.                      |
| capability seam | —                     | A swappable capability with three roles: the Service Definition (`@dv/render-modes`), the Service Providers (`@dv/fasth3-ref2va`, `@dv/fasth3-t2va`), and the Consumer (`@dv/shot-render`).                          |
| turn            | 轮次 / Turn             | One run of the agent from a user message to its reply; a record names it by the DSH turn number.                                                                                                                     |
| branch          | 分支 / Branch           | A named line of records: `main`, or `b<n>` forked from another branch. Branches are never merged; they share only the asset pool.                                                                                    |
| current branch  | 当前分支 / Current branch | The branch every view and chat session of a project shows and every write goes to.                                                                                                                                   |
| history         | 历史 / History          | The project's records in order.                                                                                                                                                                                      |
| trajectory      | 轨迹 / Trajectory       | The agent's steps in one chat session.                                                                                                                                                                               |
| surface         | 来源 / Surface          | The record field that names where a call came from: `chat`, `canvas`, `timeline`, `asset_pool`, `history`, or `api`.                                                                                                 |

### IDs and types

| Term      | Type                  | ID                                        | Owner       | zh / en copy                                                        |
| --------- | --------------------- | ----------------------------------------- | ----------- | ------------------------------------------------------------------- |
| project   | `Project`             | `ProjectId`                               | Project     | 项目 / Project                                                        |
| record    | `ProjectRecord`       | `RecordId`                                | Project     | 记录 / Record                                                         |
| branch    | `Branch`              | name: `main`, `b<n>`                      | Project     | 分支 / Branch                                                         |
| turn      | —                     | `TurnId`                                  | Project     | 轮次 / Turn                                                           |
| asset     | `Asset`               | `AssetId`                                 | Asset pool  | 素材 / Asset                                                          |
| still     | `Asset`               | `AssetId`                                 | Asset pool  | 静帧 / Still                                                          |
| character | `Character`           | `CharacterId`, versions `<id>@<version>`  | Story bible | 角色 / Character                                                      |
| location  | `Location`            | `LocationId`, versions `<id>@<version>`   | Story bible | 场景 / Location                                                       |
| style     | `Style`               | `StyleId`, versions `<id>@<version>`      | Story bible | 风格 / Style                                                          |
| plan      | `Plan`, `PlanVersion` | `PlanId` (`p1`, `p2`, …), versions `p1@2` | Shot plan   | 分镜计划 / Plan; a plan's version is 版次                                 |
| shot      | `Shot`                | its 1-based position in the plan          | Shot plan   | 镜头 / Shot                                                           |
| take      | `Take`                | `TakeId`                                  | Shot render | 版本 / Take                                                           |
| timeline  | `Timeline`            | `TimelineId` (`t1`, `t2`, …)              | Timeline    | 时间线 / Timeline; an unnamed timeline shows as 时间线 {n} / Timeline {n} |
| clip      | `Clip`                | `ClipId` (`cl1`, `cl2`, …)                | Timeline    | 片段 / Clip                                                           |

`ProjectRecord` names the record type because `Record` is a TypeScript built-in. The agent writes a reference as `<asset>`, `<record>#<output>`, or `<id>@<version>`. A `Shot` holds `prompt`, `mode` (its render mode), and optionally `duration_sec`, `references`, `seed`, and `continue_previous`.

### Components and packages

| Component        | Key        | Package           | Service        | Operations                                                                                                                                                                                                    |
| ---------------- | ---------- | ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project 项目       | `proj`     | `@dv/project`     | `dvProject`    | `proj.create` `proj.undo` `proj.redo` `proj.stale_accept`; the read tools `dv_proj_open` `dv_proj_state` `dv_proj_history_list` `dv_proj_wait`; `dv_proj_branch_create`, which writes no record               |
| Asset pool 素材库   | `asset`    | `@dv/asset-pool`  | `dvAssetPool`  | `asset.import` `asset.grab_still`                                                                                                                                                                             |
| Story bible 设定库  | `bible`    | `@dv/story-bible` | `dvStoryBible` | `bible.character_create` `bible.character_update` `bible.location_create` `bible.location_update` `bible.style_create` `bible.style_update`                                                                   |
| Shot plan 分镜     | `plan`     | `@dv/shot-plan`   | `dvShotPlan`   | `plan.create` `plan.update` `plan.approve`                                                                                                                                                                    |
| Shot render 镜头渲染 | `shot`     | `@dv/shot-render` | `dvShotRender` | `shot.render_ref2va` (while `dvRef2va` is mounted) `shot.render_t2va` (while `dvT2va` is mounted)                                                                                                             |
| Timeline 时间线     | `timeline` | `@dv/timeline`    | `dvTimeline`   | `timeline.create` `timeline.update` `timeline.rename` `timeline.delete` `timeline.clip_insert` `timeline.clip_move` `timeline.clip_remove` `timeline.clip_split` `timeline.clip_trim` `timeline.clip_replace` |
| Deliver 交付       | `deliver`  | `@dv/deliver`     | `dvDeliver`    | `deliver.timeline_export`                                                                                                                                                                                     |
| Inspector 检查器    | `inspect`  | `@dv/inspector`   | `dvInspector`  | reads `inspect.image` `inspect.asset`                                                                                                                                                                         |

An operation is named `<key>.<verb>` or `<key>.<object>_<verb>`, and its agent tool is `dv_` plus the operation name with `.` replaced by `_` (`timeline.clip_move` → `dv_timeline_clip_move`). Text the model reads names tools, never operations. The other packages are the render mode Service Definitions `@dv/render-modes` (`dvRef2va`, `dvT2va`) and their Service Providers `@dv/fasth3-ref2va` and `@dv/fasth3-t2va`, the chat references `@dv/chat-references` (`dvChatReferences`), the API 接口 (`@dv/api`, `dvApi`), the bundle (`@dv/bundle`), and the interface (`@dv/ui-shell`, `@dv/ui-canvas`, `@dv/ui-timeline`, `@dv/ui-asset-pool`, `@dv/ui-composer`, `@dv/ui-history`, and the library `@dv/ui-kit`). Product names use `dv`: routes `/api/dv/…` and `/dv/events`, window events `dv:…`, page globals `__dv…`, and test IDs `dv-<area>-<thing>`.

### Verbs

Each verb has one meaning:

| Verb                                              | Meaning                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `create` `update` `delete` `rename`               | Projects, characters, locations, styles, plans, and timelines.          |
| `import`                                          | Bring a file into the asset pool.                                       |
| `grab`                                            | Take a still from a video.                                              |
| `render`                                          | Turn a shot into a take.                                                |
| `export`                                          | Turn a timeline into one video asset.                                   |
| `insert` `move` `remove` `split` `trim` `replace` | Clips.                                                                  |
| `approve`                                         | A plan version.                                                         |
| `accept`                                          | A stale record (`proj.stale_accept`).                                   |
| `undo` `redo`                                     | One step on the current branch.                                         |
| `inspect`                                         | Read-only analysis of an image or an asset.                             |
| `get` `list`                                      | Read one by ID; read many.                                              |

### Interface copy

| zh                               | en                                                             | Use                                                                              |
| -------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 渲染新版本                            | Render new take                                                | Rendering a take again; 渲染 is the zh verb for render.                            |
| 生成方式 / 参考图生成 / 文字生成              | Render mode / From references / From text                      | A take's or a shot's render mode (`ref2va`, `t2va`).                             |
| 参考图生成镜头 / 文字生成镜头                 | Render shot from references / Render shot from text            | The tools `dv_shot_render_ref2va` and `dv_shot_render_t2va` in chat and History. |
| 接上一镜头                            | Continues the previous shot                                    | A shot with `continue_previous: true`.                                           |
| 渲染结果                             | Rendered                                                       | The asset filter for takes.                                                      |
| 导入                               | Imported                                                       | The asset filter for imported files.                                             |
| 参考图                              | Reference images                                               | The images a character, location, style, or shot renders from.                   |
| 场景和风格                            | Locations and styles                                           | The story bible sections after 角色 / Characters.                                  |
| 新建时间线 / 修改时间线                    | Create timeline / Update timeline                              | The Timeline operations that add a timeline or replace its clips.                |
| 插入片段 / 移动片段 / 移除片段 / 拆分片段 / 裁剪片段 | Insert clip / Move clip / Remove clip / Split clip / Trim clip | The clip operations; a clip shows as 片段 N / Clip N in copy.                      |
| 分支 / 主线 / 分支 {n}                 | Branch / Main / Branch {n}                                     | The branch menu and the default branch labels.                                   |
| 当前分支                             | Current branch                                                 | The tooltip of the branch menu's button.                                         |
| 新建分支 / 重命名                       | New branch / Rename                                            | The branch menu's fork row and rename (✎) button.                                |
| 仍然保留                             | Keep anyway                                                    | The one label of `proj.stale_accept`.                                            |
| 分镜计划版次 / v{version}              | Plan versions / v{version}                                     | The canvas switch between a plan's versions.                                     |
| 你 / 智能体 / 自动                     | You / Agent / Automatic                                        | Who acted, in the History panel.                                                 |
| 渲染 {n} 个镜头                       | Render {n} shots                                               | The fold of the renders an approval scheduled.                                   |
| 当前 / 分支树                         | Current / Branch tree                                          | The History panel mark of the head step, and its tree view.                      |
| 在历史中查看 / 在轨迹中查看                  | Show in history / Show in trajectory                           | The links between the chat and the History panel.                                |
