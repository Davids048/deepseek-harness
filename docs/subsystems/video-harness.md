# DreamVerse packages

English | [中文](video-harness.zh.md)

The DreamVerse packages are the project layer for video production inside DeepSeek Harness. This page owns the vocabulary and the cross-package rules of these packages under `packages/dv/` and of the [`packages/video-harness/`](../../packages/video-harness/README.md) group: the layers, the operation record, how views and the agent write, how staleness, drafts, undo, and branches work, and the [glossary](#glossary) of the names that code, records, tools, and interface copy use. Each package README owns its configuration and service API.

## Layers

```text
views (chat, canvas, timeline, asset pool, History) and the agent  run operations; they hold no project state
  │  dvProject.run(operation, inputs, params, origin)
  ▼
Project (@dv/project)                                              records, branches, drafts, undo and redo, stale marks, state, agent tools
  │
  ├── components (@dv/story-bible, @dv/shot-plan, @dv/shot-render, @dv/timeline, @dv/deliver, @dv/inspector)
  └── asset pool (@dv/asset-pool)                                  immutable bytes by SHA-256, with the record that created them
```

Components register their operations with `dvProject.registerOperation` and their state reducers with `dvProject.registerReducer` ([`@dv/project`](../../packages/dv/project/README.md)). Each operation is also the agent tool `dv_<operation name with _>`, whose call becomes one record. The asset pool's `dv_asset_import` and `dv_asset_grab_still` add assets; Story bible's `dv_bible_*` tools create and update character, location, and style versions; Shot plan's `dv_plan_create` writes version 1 of a new plan, which gets a `PlanId` (`p1`, `p2`, …), `dv_plan_update` writes the next version of the plan its `plan` param names, and `dv_plan_approve` approves one version; Shot render's `dv_shot_render` renders a take over the DreamVerse generation backend, with `duration_sec` a whole number of seconds within the served model's range (default: the model's minimum); Timeline's `dv_timeline_*` tools create, update, rename, and delete timelines and insert, move, remove, split, trim, and replace clips without creating files; Deliver's `dv_deliver_timeline_export` writes a timeline to one video; and Inspector's `dv_inspect_image` and `dv_inspect_asset` read assets without writing a record. The ffmpeg work runs through [`@dv/ffmpeg`](../../packages/dv/ffmpeg/README.md). Project's own `dv_proj_*` tools create and open projects, read the state and the history, accept and discard drafts, undo, redo, accept stale records, create and switch branches, and wait for scheduled records. An operation declares a resource class (`none`, `cpu`, `gpu`) and a confirmation policy (`never`, `agent_ask_first`); Project's scheduler runs scheduled records under one concurrency limit per class.

A plan approval runs, as the `system` actor, one `shot.render` per new or changed shot of the approved version, with the params `plan`, `plan_version`, and `shot` (the shot's 1-based position, which a shot keeps across versions). A shot is unchanged when a done `shot.render` record of the same plan on the approving branch has the same params apart from `plan`, `plan_version`, and `shot`, the same reference inputs, and the same first frame; the approval reuses the newest such take instead of rendering. It then runs a `timeline.update` of the plan's timeline (the timeline whose latest create or update record names the plan) with every shot's take in shot order, or a `timeline.create` when the plan has none, and lists the scheduled records in its `report.scheduled`. A clip has a `ClipId` (`cl1`, `cl2`, …) that the Timeline operation inserting it assigns and stores in the record's `report.clips`; the ID is unique within the project, is never reused, and names the clip in the `clip` param of every clip operation.

## The operation record

Every change to a project is one record in the project's `records.jsonl` file, which only `@dv/project` reads and writes. A record holds who (`actor`: `user`, `agent`, or `system`), where the call came from (`surface`: `chat`, `canvas`, `timeline`, `asset_pool`, `history`, or `api`), the human's words or a description of the gesture (`intent`), the owning `component` and the `operation` with its version, the turn, chat session, and tool call that made it, the params, the inputs with the asset each resolved to (`resolved_asset`), the outputs, the status, the parent record, and two links: `based_on` (this record repeats that record with changes, such as a new take with an edited prompt) and `supersedes` (this record replaces those records' outputs). A record has `kind: 'operation'`, except the `request` record that holds the human's words that start an agent turn. Records are appended, never rewritten; a status change, the cost, and the report are appended as an update line, and `branches.json` holds the branch pointers. Project's own actions are records too (`proj.draft_accept`, `proj.draft_discard`, `proj.undo`, `proj.redo`, `proj.branch_create`, `proj.branch_switch`, `proj.stale_accept`), while reads such as `dv_proj_state`, `dv_proj_history_list`, and the `inspect.*` operations write no record.

## How an operation runs

The views and the agent reach the same operations. A gesture on the canvas, the timeline, the asset pool panel, or the History panel runs an operation through the routes of `@dv/api` with `actor: 'user'` and `surface` set to that view. The agent calls the operation's `dv_*` tool, which runs it with `actor: 'agent'`, `surface: 'chat'`, the turn, the chat session, and the tool call ID; the turn's first record follows a `request` record that holds the human's words. Every call goes through the runner of `dvProject.run`. The runner validates the params; then, under the project lock, it resolves each input to an asset and calls the operation's `precondition`, which refuses a call for every caller before any record is written: `shot.render` and `plan.approve` refuse a render without a reference image when the served model renders from reference images. The runner then appends the `pending` record and adds to its `supersedes` the records that the operation's own `supersedes` names. For an operation with `confirm: agent_ask_first`, an agent call from a chat session that asks first waits for the composer's approval card, and a declined card ends the record `cancelled`. Finally the runner runs the owning component's implementation outside the lock and appends the final update with the outputs, the cost, and the report. A call whose input names an unfinished record, and each render that a plan approval schedules, waits in Project's scheduler until its inputs are done.

## Project state

The state of a branch is computed from its records: Project walks back from the branch head, follows each `proj.undo` and `proj.redo` record to the record it names, and passes the records, oldest first, through every registered reducer. Each component's reducer turns its records into its slice of `ProjectState.components` (Story bible `bible`, Shot plan `plan`, Shot render `shot`, Timeline `timeline`), and Project's own reducer keeps the `proj` slice: the records, the stale and superseded records, and the record that created each asset. A reducer's `agentSummary` adds that component's fields to the project summary that `dv_proj_state` and the other `dv_proj_*` tools return to the agent. No view holds project state: the canvas and the timeline fetch the state of the branch they show and fetch it again on every event of the live stream.

## Drafts, acceptance, undo, branches

Each chat session has at most one open draft per project, the branch `draft/<session>`. The working branch of a session is its open draft, else the exploration branch it switched to, else `main`; the agent's calls and the human's edits in that session write to it. The first agent write of a session without an open draft opens the draft at the head of the session's working branch; `user` and `system` writes never open one. The draft spans turns until the human accepts or discards it, and Project never closes a draft by itself. Accepting (`proj.draft_accept`) moves the branch the draft forked from to the draft when that branch has not moved; when another session's draft was accepted in between, Project replays the draft's records as copies on the moved head, and refuses with `DraftConflictError`, writing nothing, when a record supersedes a record that is already superseded there or a component's reducer reports a conflict. Discarding (`proj.draft_discard`) removes the branch and keeps its records in the history; it is refused when the counts of agent changes and human edits differ from the counts the confirmation dialog showed. Both are refused while a draft record is pending or running. Undo (`proj.undo`) moves `main` back by one change, an accepted draft as a whole or one record written directly on `main`, by appending a record whose `params.to` names the record whose state `main` returns to; redo (`proj.redo`) appends a record that returns `main` to the state before that undo, and a later change on `main` ends the chance to redo. No record is rewritten or removed. `proj.branch_create` starts an exploration branch `explore/<name>` at any record or branch head, and `proj.branch_switch` moves a session to it or back to `main`.

## Agent integration

[`@dv/agent-integration`](../../packages/dv/agent-integration/README.md) binds the DSH agent loop to Project. It reports each agent turn and the human's words that started it to `dvProject`, so the turn's records carry the turn and follow the turn's request record; it imports the images a user attaches in the chat with `asset.import`; and it registers the DSH question rule as the `dvProject` tool call check: a `plan.approve` call asks the user unless it carries `user_approved: true`, with the shots the approval renders and their GPU estimate in the question, and a `shot.render` call asks when the GPU seconds the turn already spent plus the call's estimate exceed `confirmGpuSecondsThreshold` and the call does not carry `user_requested: true`. When the session asks first, the approval card that the runner shows for an `agent_ask_first` operation is the question; otherwise the rule asks a live root agent's user through the DSH user-questions service when one is mounted, and else the tool result tells the model to ask in the conversation and call again with the flag. The rule only asks: the runner alone enforces `confirm`. A chat session's draft spans turns until the human accepts or discards it, and an operation with `confirm: agent_ask_first` waits for the composer's approval card while the session asks first. A system-prompt section carries the state of the session's working branch (characters, locations and styles, timelines and their clips, takes, stale records, plans, the draft) so the model resolves references to concrete IDs, and the `video-directing`, `timeline-editing`, and `branching-story` skills hold the procedures. The same package keeps each chat session's composer modes, holds the approval cards, and expands the `dv:` mentions in a user message into the concrete record and asset IDs they name. [`@dv/bundle`](../../packages/bundle/dv/README.md) composes all of it as the `video-harness` and `video-harness-headless` profiles.

## The API and the views

[`@dv/api`](../../packages/dv/api/README.md) is the HTTP face of Project for the browser: `/api/dv/state` returns the state of one branch as one JSON document, `/api/dv/operations` lists the registered operations, `/api/dv/operation` runs an operation as the user with `surface: 'canvas'`, `'timeline'`, or `'asset_pool'`, `/api/dv/history` returns one page of the history, `/api/dv/drafts/accept`, `/api/dv/drafts/discard`, `/api/dv/undo`, `/api/dv/redo`, `/api/dv/branches/create`, `/api/dv/branches/switch`, and `/api/dv/stale/accept` expose the draft, undo, redo, branch, and stale operations, and `/dv/events` streams every record and branch change.

The interface packages are right-Sidebar tab types and center views of the web application, so they sit beside the chat page in one profile. [`@dv/ui-shell`](../../packages/dv/ui-shell/README.md) puts the project workspace in the center and the 对话 / Chat and 轨迹 / Trajectory tabs on the right. [`@dv/ui-canvas`](../../packages/dv/ui-canvas/README.md) draws the records of the shown branch as a DAG of asset flow: characters, locations, and styles as sources, one node per plan with a switch between its versions, takes beside the record they are based on, the open draft dashed, and stale records marked; its editor writes a changed record as a superseding record or a new take. [`@dv/ui-timeline`](../../packages/dv/ui-timeline/README.md) draws each timeline as one track and turns insert, move, remove, split, and trim gestures into `timeline.*` records that name clips by `ClipId`, and its export into a `deliver.timeline_export` record. `@dv/ui-asset-pool` lists the project's assets and imports files, and `@dv/ui-composer` adds the approval cards, the render card, and the `@` mentions to the chat input. The canvas and the timeline editor show the working-branch bar of [`@dv/ui-kit`](../../packages/dv/ui-kit/README.md): it names the branch the view's edits go to (当前分支：草稿 / Working branch: Draft, else `main`) and accepts or discards the open draft. Every discard goes through one confirmation dialog that shows the counts of agent changes and human edits the server reports and sends the discard with those counts; when the draft changed in between, the server refuses with `draft_changed` and the dialog shows the current counts. No view keeps project state: each renders what the host sends, refetches on every event, and reports the selected node or clip to `/api/dv/selection` so the agent can be told what the user pointed at.

## History and the trajectory

The history is the project's records in order, from every actor, view, and chat session; the trajectory is the agent's steps in one chat session. A record links the two through its `session` and `tool_call` fields. [`@dv/ui-history`](../../packages/dv/ui-history/README.md) is the History panel (tab type `dv-history`): one row per operation record, newest first, with the action, who did it (你 / You, 智能体 / Agent, 自动 / Automatic), the status, an output thumbnail, and a mark (草稿 / Draft, 已接受, 已撤销, 已丢弃, 已重放, or an exploration branch); the records that a plan approval scheduled fold under the approval's row. Selecting a row focuses the record's node on the canvas (`dv:canvas-focus`) or its clip on the timeline (`dv:timeline-focus`); the row's 在轨迹中查看 / Show in trajectory link sends `dv:trajectory-focus`, and `@dv/ui-shell` opens 轨迹 on that chat session at that tool call. In the chat, every settled row of a tool that writes a record has an 在历史中查看 / Show in history link, which sends `dv:history-focus` so the History panel selects the record that tool call wrote.

## Staleness

Project's reducer marks records stale; it reruns nothing. When a record lists a record X in `supersedes`, every record that read an output of X, and every record downstream of such a record, becomes stale; a later record that reads an input whose producer is superseded or stale is stale too. The producer of an input is the record that created its asset or, for a character, location, or style version, the record that wrote that version. The owning operation decides what a call supersedes through `OperationSpec.supersedes`: `bible.character_update`, `bible.location_update`, and `bible.style_update` supersede the record that created the previous version, so every record that read the previous version is stale. A caller can also name records in `supersedes`, as the agent does for a retake that replaces a shot. A stale record is rerun only when the agent or the human decides; `proj.stale_accept` clears the mark of one record and keeps its consumers from becoming stale through it.

## Deterministic reuse

When an operation with `deterministic: true` is called with the same operation and version, equal params, and the same resolved input assets as an earlier `done` record, the runner reuses that record's outputs instead of running the operation; the call is still recorded, with `cost.reused: true`. Renders are not deterministic: rendering a shot again gives a new take, a `shot.render` record whose `based_on` names the earlier render, and Shot render's reducer groups the takes of a shot under its first render.

<a id="glossary"></a>
## Glossary

Code, record fields, tool descriptions, docs, and interface copy use these names, each with one meaning. The zh / en column is the copy the interface shows.

### Concepts

| Term           | zh / en copy              | Meaning                                                                                                              |
| -------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| component      | 组件 / Component          | A plugin that owns one capability: its implementation, data, operations, reducers, and tools.                        |
| integration    | 集成 / Integration        | A plugin that connects people or the agent to components and owns no capability.                                     |
| operation      | 操作 / Operation          | An action a component implements that changes a project, or a read it serves.                                        |
| record         | 记录 / Record             | One log entry written by one operation call, or the `request` record of a turn.                                      |
| tool           | 工具 / Tool               | Something the agent can call; a component tool (智能体工具 / agent tool) wraps one operation.                        |
| reducer        | —                         | A component function that turns its records into its slice of the project state.                                     |
| turn           | 轮次 / Turn               | One run of the agent from a request to its reply.                                                                    |
| draft          | 草稿 / Draft              | The open branch of a chat session; it spans turns and holds the agent's records and the human's edits.               |
| branch         | 分支 / Branch             | A named line of records; `main` is the accepted project.                                                             |
| working branch | 当前分支 / Working branch | The branch the human and the agent of a chat session write to: its draft, else `main`.                               |
| history        | 历史 / History            | The project's records in order.                                                                                      |
| trajectory     | 轨迹 / Trajectory         | The agent's steps in one chat session.                                                                               |
| surface        | 来源 / Surface            | The record field that names where a call came from: `chat`, `canvas`, `timeline`, `asset_pool`, `history`, or `api`. |

### IDs and types

| Term      | Type                  | ID                                                | Owner       | zh / en copy                                                              |
| --------- | --------------------- | ------------------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| project   | `Project`             | `ProjectId`                                       | Project     | 项目 / Project                                                            |
| record    | `ProjectRecord`       | `RecordId`                                        | Project     | 记录 / Record                                                             |
| branch    | `Branch`              | name: `main`, `draft/<session>`, `explore/<name>` | Project     | 分支 / Branch                                                             |
| turn      | —                     | `TurnId`                                          | Project     | 轮次 / Turn                                                               |
| asset     | `Asset`               | `AssetId`                                         | Asset pool  | 素材 / Asset                                                              |
| still     | `Asset`               | `AssetId`                                         | Asset pool  | 静帧 / Still                                                              |
| character | `Character`           | `CharacterId`, versions `<id>@<version>`          | Story bible | 角色 / Character                                                          |
| location  | `Location`            | `LocationId`, versions `<id>@<version>`           | Story bible | 场景 / Location                                                           |
| style     | `Style`               | `StyleId`, versions `<id>@<version>`              | Story bible | 风格 / Style                                                              |
| plan      | `Plan`, `PlanVersion` | `PlanId` (`p1`, `p2`, …), versions `p1@2`         | Shot plan   | 分镜计划 / Plan; a plan's version is 版次                                 |
| shot      | `Shot`                | its 1-based position in the plan                  | Shot plan   | 镜头 / Shot                                                               |
| take      | `Take`                | `TakeId`                                          | Shot render | 版本 / Take                                                               |
| timeline  | `Timeline`            | `TimelineId` (`t1`, `t2`, …)                      | Timeline    | 时间线 / Timeline; an unnamed timeline shows as 时间线 {n} / Timeline {n} |
| clip      | `Clip`                | `ClipId` (`cl1`, `cl2`, …)                        | Timeline    | 片段 / Clip                                                               |

`ProjectRecord` names the record type because `Record` is a TypeScript built-in. The agent writes a reference as `<asset>`, `<record>#<output>`, or `<id>@<version>`.

### Components and integration

| Component            | Key        | Package           | Service        | Operations                                                                                                                                                                                                                        |
| -------------------- | ---------- | ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project 项目         | `proj`     | `@dv/project`     | `dvProject`    | `proj.create` `proj.draft_accept` `proj.draft_discard` `proj.undo` `proj.redo` `proj.branch_create` `proj.branch_switch` `proj.stale_accept`; the read tools `dv_proj_open` `dv_proj_state` `dv_proj_history_list` `dv_proj_wait` |
| Asset pool 素材库    | `asset`    | `@dv/asset-pool`  | `dvAssetPool`  | `asset.import` `asset.grab_still`                                                                                                                                                                                                 |
| Story bible 设定库   | `bible`    | `@dv/story-bible` | `dvStoryBible` | `bible.character_create` `bible.character_update` `bible.location_create` `bible.location_update` `bible.style_create` `bible.style_update`                                                                                       |
| Shot plan 分镜       | `plan`     | `@dv/shot-plan`   | `dvShotPlan`   | `plan.create` `plan.update` `plan.approve`                                                                                                                                                                                        |
| Shot render 镜头渲染 | `shot`     | `@dv/shot-render` | `dvShotRender` | `shot.render`                                                                                                                                                                                                                     |
| Timeline 时间线      | `timeline` | `@dv/timeline`    | `dvTimeline`   | `timeline.create` `timeline.update` `timeline.rename` `timeline.delete` `timeline.clip_insert` `timeline.clip_move` `timeline.clip_remove` `timeline.clip_split` `timeline.clip_trim` `timeline.clip_replace`                     |
| Deliver 交付         | `deliver`  | `@dv/deliver`     | `dvDeliver`    | `deliver.timeline_export`                                                                                                                                                                                                         |
| Inspector 检查器     | `inspect`  | `@dv/inspector`   | `dvInspector`  | reads `inspect.image` `inspect.asset`                                                                                                                                                                                             |

An operation is named `<key>.<verb>` or `<key>.<object>_<verb>`, and its agent tool is `dv_` plus the operation name with `.` replaced by `_` (`timeline.clip_move` → `dv_timeline_clip_move`). Text the model reads names tools, never operations. The integration packages are the API 接口 (`@dv/api`, `dvApi`), the agent integration 智能体集成 (`@dv/agent-integration`, `dvAgentIntegration`), the bundle (`@dv/bundle`), and the interface (`@dv/ui-shell`, `@dv/ui-canvas`, `@dv/ui-timeline`, `@dv/ui-asset-pool`, `@dv/ui-composer`, `@dv/ui-history`, and the library `@dv/ui-kit`). Product names use `dv`: routes `/api/dv/…` and `/dv/events`, window events `dv:…`, page globals `__dv…`, and test IDs `dv-<area>-<thing>`.

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
| `approve`                                         | A plan version, or a render that awaits confirmation.                   |
| `accept`                                          | A draft (`proj.draft_accept`), or a stale record (`proj.stale_accept`). |
| `discard`                                         | A draft.                                                                |
| `undo` `redo`                                     | One change on `main`.                                                   |
| `inspect`                                         | Read-only analysis of an image or an asset.                             |
| `get` `list`                                      | Read one by ID; read many.                                              |
| `switch`                                          | Move a chat session to another branch.                                  |

### Interface copy

| zh                                                   | en                                                             | Use                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 渲染镜头 / 渲染新版本                                | Render shot / Render new take                                  | Rendering a shot; 渲染 is the zh verb for render.                            |
| 渲染前先问 / 直接渲染                                | Ask first / Render directly                                    | The composer modes for agent renders.                                        |
| 渲染结果                                             | Rendered                                                       | The asset filter for takes.                                                  |
| 导入                                                 | Imported                                                       | The asset filter for imported files.                                         |
| 参考图                                               | Reference images                                               | The images a character, location, style, or shot renders from.               |
| 场景和风格                                           | Locations and styles                                           | The story bible sections after 角色 / Characters.                            |
| 新建时间线 / 修改时间线                              | Create timeline / Update timeline                              | The Timeline operations that add a timeline or replace its clips.            |
| 插入片段 / 移动片段 / 移除片段 / 拆分片段 / 裁剪片段 | Insert clip / Move clip / Remove clip / Split clip / Trim clip | The clip operations; a clip shows as 片段 N / Clip N in copy.                |
| 当前分支：{branch}                                   | Working branch: {branch}                                       | The working-branch bar.                                                      |
| 丢弃草稿？ / 丢弃                                    | Discard the draft? / Discard                                   | The discard confirmation dialog; 丢弃 is the zh verb for discard everywhere. |
| 仍然保留                                             | Keep anyway                                                    | The one label of `proj.stale_accept`.                                        |
| 分镜计划版次 / v{version}                            | Plan versions / v{version}                                     | The canvas switch between a plan's versions.                                 |
| 你 / 智能体 / 自动                                   | You / Agent / Automatic                                        | Who acted, in the History panel.                                             |
| 渲染 {n} 个镜头                                      | Render {n} shots                                               | The fold of the renders an approval scheduled.                               |
| 已接受 / 已撤销 / 已丢弃 / 已重放                    | Accepted / Undone / Discarded / Replayed                       | History marks beside 草稿 / Draft.                                           |
| 发起者 / 操作类型                                    | Actor / Operation kind                                         | History filters.                                                             |
| 在历史中查看 / 在轨迹中查看                          | Show in history / Show in trajectory                           | The links between the chat and the History panel.                            |
