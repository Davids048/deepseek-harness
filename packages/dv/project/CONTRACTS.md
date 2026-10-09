# @dv/project module contracts

This file specifies the internal modules of the `dvProject` service: what each one does, its rules and errors, and the unit tests that pin it. The public types are in `src/types.ts`, the error codes in `src/shared.ts`, and the service surface with its JSDoc (the history list and its current position, lock scope, every method) in `src/index.ts`.

## Contents

1. [Modules, files and tests](#1-modules-files-and-tests)
2. [Module calls](#2-module-calls)
3. [Rules for every module](#3-rules-for-every-module)
4. [Record store](#4-record-store-record-storets)
5. [Subscriptions](#5-subscriptions-subscriptionsts)
6. [Reducer registry and state](#6-reducer-registry-and-state-reducersts)
7. [History](#7-history-historyts)
8. [Runner](#8-runner-runnerts)
9. [Scheduler](#9-scheduler-schedulerts)
10. [Chat sessions, agent tools and agent context](#10-chat-sessions-agent-tools-and-agent-context-sessionsts-agent-toolsts-proj-toolsts-agent-contextts)
11. [Test plan](#11-test-plan)

## 1. Modules, files and tests

| Module                          | Files                                                                                | Tests                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Record store and subscriptions  | `src/record-store.ts`, `src/subscriptions.ts`                                        | `tests/record-store.spec.ts`, `tests/subscriptions.spec.ts` |
| Runner and scheduler            | `src/runner.ts`, `src/scheduler.ts`                                                  | `tests/runner.spec.ts`, `tests/scheduler.spec.ts`           |
| History and reducer registry    | `src/history.ts`, `src/reducers.ts`                                                  | `tests/history.spec.ts`, `tests/reducers.spec.ts`           |
| Sessions, tools, agent context  | `src/sessions.ts`, `src/agent-tools.ts`, `src/proj-tools.ts`, `src/agent-context.ts` | `tests/agent-tools.spec.ts`, `tests/proj-tools.spec.ts`     |

The runner and history call the record store; the runner calls the reducer registry and the scheduler; the reducer registry calls `store.ancestors`; the runner calls `history.discardedSteps`. Tests use the real modules (`tests/support.ts` `startModules()`), not mocks of other modules. Run them from `packages/dv`: `../../node_modules/.bin/vitest run --config vitest.config.ts project/tests`.

## 2. Module calls

```
  callers (API, agent tools, components)
        |
        v
  index.ts  DvProject (dvProject) ---------------------------------------------+
        |  createProject renameProject deleteProject openProject listProjects  |
        |  getRecord                                       -> record-store     |
        |  run acceptStale registerOperation listOperations                    |
        |                                                  -> runner           |
        |  undo redo listHistory                            -> history          |
        |  getState registerReducer                        -> reducers         |
        |  wait                                            -> scheduler        |
        |  subscribe                                       -> subscriptions    |
        |  bindSession sessionProject holdToolCalls                            |
        |                                                  -> sessions         |
        |  registerOperation (tool), parseInputs           -> agent-tools      |
        |  dv_proj_* tools (registry mounted)              -> proj-tools       |
        |  dv:project section (systemPrompt mounted)       -> agent-context    |
        |  registerAssetStore: the store the runner and agent-tools read       |
        v                                                                      |
  runner ----> store.line / append                                            |
    |    ----> reducers.stateAt / getState / assetsOf                          |
    |    ----> scheduler.enqueue / cancel scheduler ----> runner.execute       |
    |    ----> asset store                                                     |
    v                                                                          |
  runner ----> history.discardedSteps                                         |
  history, reducers, runner, scheduler ----> record-store                     |
                                                         |                     |
                                                         v  onChange(event)    |
                                         subscriptions.emit, scheduler.recordFinished
```

Only `record-store.ts` imports `node:fs` or knows a file path under the root. The runner's scratch directory for `execute` is the one other file system use (a temporary directory under the OS temp directory).

## 3. Rules for every module

**Lock.** `RecordStore.lock(project, fn)` serializes work per project. Who holds it:

- `run`: while it checks the request and appends the operation record; again for each update line (`running`, the final status). Never while `execute` runs.
- `undo`, `redo`, `renameProject`, `deleteProject`, the `proj.create` append of `createProject`, and `acceptStale`: for the whole call (`index.ts` takes it for all but `acceptStale`, which the runner takes).
- Reads (`getState`, `getRecord`, `listHistory`, `openProject`, `listProjects`) take no lock. Read-only operations take no lock.
- The lock is not reentrant: a function that runs under the lock never calls `lock` for the same project. Module functions documented "the caller holds the project lock" never take it themselves.

**Errors.** Throw `ProjectError(code, message)` from `src/shared.ts` with one of the approved codes. Messages are in words a creator can read and name the project or record. A refused call changes nothing on disk and emits no event. Failures of an operation call after its record exists never throw: they end the record with a `RecordFailure` (`operation_failed`, `input_failed`, `stopped`).

**IDs and times.** Record IDs and project IDs are `randomUUID()` values. Times are `new Date().toISOString()`.

**Record templates.** Every record has `kind: 'operation'` and copies the six `RecordOrigin` fields from the call: `session`, `turn` and `tool_call` link the record to the DSH session log, and `intent` is the agent's `reason` or a description of the human's gesture. `proj.*` records are written with `status: 'done'` and have no update lines.

| Record               | `kind`      | `component` | `operation`, `operation_version` | `params`                                                         |
| -------------------- | ----------- | ----------- | -------------------------------- | ---------------------------------------------------------------- |
| `proj.create`        | `operation` | `proj`      | `proj.create`, `1`               | `{title}`                                                        |
| `proj.stale_accept`  | `operation` | `proj`      | `proj.stale_accept`, `1`         | `{record}`                                                       |

All of them have `inputs: []`, `outputs: []`, `based_on: null`, `supersedes: []`, `deterministic: true`.

**Current form.** Every module reads records in their current form from the record store: the record line, with each update line applied in order, and with the `resolved_asset` of each `{record, output}` input filled from the producer's `outputs[output]` once the producer is `done` (a derived value, never written to disk).

## 4. Record store (`record-store.ts`)

Owner: agent A. Files: `<root>/<ProjectId>/project.json` (`ProjectInfo`, pretty-printed or one line, ending with a newline), `records.jsonl` (one JSON object per line), `line.json` (`ProjectLine` `{tip, at}` as one line, rewritten atomically). `tip` is the last step: the history list is the `parents[0]` ancestry of `tip`. `at` is the current position, a record of the history list. Each record's parent is `at` when the record is written. A project without records has no `line.json`; `load` takes the last record as `tip` and `at` when the file is missing.

| Function                                  | Behavior                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constructor(root, onChange)`             | Stores both; `mkdirSync(root, {recursive: true})` happens in `load`.                                                                                                                                    |
| `load()`                                  | Reads every `<root>/*/project.json` (skips directories without it and `.trash`) and replays `records.jsonl` (record lines, then update lines applied in file order). Emits nothing.                     |
| `lock(project, fn)`                       | A per-project promise chain: `fn` starts after every earlier `fn` for that project settled, whether it resolved or threw. Different projects run concurrently. Returns `fn`'s result or rejection.      |
| `createProject(info)`                     | Writes `project.json` and an empty `records.jsonl`. Refuses an existing ID with `invalid_params`.                                                                                                       |
| `listProjects()` / `getProject(id)`       | Oldest first by `created_at`, then ID. `getProject` throws `unknown_project`.                                                                                                                           |
| `renameProject(id, title)`                | Rewrites `project.json` atomically (write `<file>.tmp`, rename). Returns the new info.                                                                                                                  |
| `deleteProject(id)`                       | Renames the directory to `<root>/.trash/<id>-<Date.now()>`; forgets the project, its listeners stay.                                                                                                    |
| `append(project, line)`                   | Rules in the JSDoc: `parents` must be `[at]` (`[]` for the first record), else `parent_not_head`. Assigns `id` and `created_at`, appends one line, sets `tip` and `at` to the record, then emits `record` and `line`. |
| `update(project, update)`                 | Rules in the JSDoc. Appends one `{"update": id, …}` line, applies it in memory, emits `{kind: 'update', record}` with the current form.                                                                 |
| `getRecord` / `listRecords` / `ancestors` | Current forms. `ancestors` follows `parents[0]` only (the raw chain).                                                                                                                                   |
| `line(project)`                           | The project's `{tip, at}`, or undefined for a project without records.                                                                                                                                  |
| `requireLine(project)`                    | The project's `{tip, at}`; `invalid_params` for a project without records.                                                                                                                              |
| `lineIds(project)`                        | `{ids, atIndex}`: the record IDs of the history list, oldest first, and the index of `at`; copies no record. `{ids: [], atIndex: -1}` for a project without records.                                     |
| `moveTo(project, at)`                     | Sets `at` and rewrites `line.json`; `tip` stays. Writes no record; emits `{kind: 'line', tip, at}`. `unknown_record` for an unknown record. The caller checks that `at` is in the history list.         |

Invariants:

- `records.jsonl` is append-only: no function rewrites or truncates it. Line order is write order.
- A record line is written exactly once; it carries no `started_at`, `finished_at`, `error`, `cost` or `report`.
- Status order: `pending` → `running` | `done` | `failed` | `cancelled`; `running` → `done` | `failed` | `cancelled`. Moving to the same status or backwards throws `status_backwards`; any update of a `done`, `failed` or `cancelled` record throws `record_finished`.
- The store emits an event only after the line or file is written; a refused call emits nothing.
- No function removes or reorders a record; only `append` and `moveTo` change `tip` and `at`.
- `getRecord` and `listRecords` return copies, so a caller that mutates a result cannot change the store.

## 5. Subscriptions (`subscriptions.ts`)

Owner: agent A. `subscribe(project, listener)` adds a listener and returns an idempotent remover. `emit(project, event)` calls the project's listeners synchronously, in subscription order, on a snapshot of the set (a listener removed during delivery still receives the current event; one added during delivery does not). A throwing listener is reported to `onListenerError` and delivery continues. `dvProject.subscribe` exposes it; the live stream (`/dv/events`) and the stream service are its consumers.

## 6. Reducer registry and state (`reducers.ts`)

Owner: agent D.

| Function                             | Behavior                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register(key, reducer)`             | One reducer per key (`reducer_exists`); at most one reducer defines `createdBy` and `assetsOf` (`invalid_params`). Registration order is the call order of `reduce`. Returns a remover.               |
| `getState(project)`                  | `stateAt(project, at)` with the project's current position.                                                                                            |
| `stateAt(project, head)`             | `reduceChain(info, store.ancestors(project, head))`.                                                                                                   |
| `reduceChain(info, records)`         | Starts each registered reducer at `initial()`, calls `reduce` for every record in order, returns `{project: info, head: last.id, components}`.         |
| `apply(state, record)`               | One more `reduce` per reducer on a copy of `state.components`; `head` becomes `record.id`.                                                             |
| `assetsOf(state, ref)`               | `assetsOf` of the reducer that defines it, on that reducer's slice (Story bible in a deployment); null when no reducer defines it.                    |
| `createdBy` (private)                | `createdBy` of the reducer that defines it, on its slice before the record; the `proj` slice reads it while it reduces that record.                   |
| `agentSummaries(state, assets)`      | The `agentSummary(slice, assets, state)` fields of every reducer that defines it, in the component key order of `COMPONENT_KEYS` (other keys after, in registration order). |

`projReducer` (Project's own slice) follows its JSDoc. Staleness in detail, for each record R in order:

The producers of an input are the record in `created_by[resolved_asset]` and, for a `{character}`, `{location}` or `{style}` ref, the record that created that version (`createdBy` of the reducer that defines it).

1. Each output asset of R when R is `done`: `created_by[asset] = R.id`.
2. Each ID X in `R.supersedes`: `superseded[X] = R.id`; then every earlier record with an input produced by X, or by a record already stale through X, gets `stale[consumer] = R.id` unless it carries a stale acceptance.
3. Each input of R produced by a record P with `superseded[P]` or `stale[P]` set: R gets `stale[R] = superseded[P] ?? stale[P]`, unless R carries a stale acceptance.
4. `proj.stale_accept` with `params.record = X`: delete `stale[X]` and remember X as accepted; accepted records are never marked again, and their consumers are not stale through them.

Version staleness follows from these rules: the operation that writes a new character, location or style version supersedes the record that created the previous version (`OperationSpec.supersedes`), so every record that read the previous version, and every record downstream of it, is stale.

Invariants: reducers are pure; `getState` on the same records always gives equal state; a reducer never sees a record twice; a registered reducer that throws makes `getState` throw (the error propagates; nothing is cached). An implementation may cache states by `(project, head)`; a cached state must be dropped when an update line changes a record on that chain.

## 7. History (`history.ts`)

Owner: agent D. The module comment defines the history list, the current position and moves; the JSDoc of `discardedSteps`, `undo`, `redo`, `moveTo` and `list` defines their behavior. The user-facing rules are the [history rules](../../../docs/subsystems/video-harness.md#history-rules).

- The history list is the `parents[0]` ancestry of `tip` (`store.lineIds`), oldest first; the first record is `proj.create`.
- `undo(project)`: moves `at` to its parent; `nothing_to_undo` at the first record; `invalid_params` for a project without records.
- `redo(project)`: moves `at` to the next record of the history list toward `tip`; `nothing_to_redo` at `tip`.
- `moveTo(project, to)`: `unknown_record` for an unknown ID; `invalid_params` for a record outside the history list (a discarded record); a move to `at` changes nothing and emits no event; otherwise `at` becomes `to`, before or after the old `at`.
- `discardedSteps(store, project)`: the records of the history list after `at`, oldest first; empty when `at` is `tip`.
- `list(query)`: the steps of the history list, newest first, as `{record, place}`, where `place` is `before`, `current` or `after` relative to `at`; filters combine with AND; `before` keeps the steps before that record in the list (`unknown_record` when the list does not have it); `records` keeps the named records; `tool_call` keeps the records one tool call wrote; `limit` applies after every filter; only the listed entries are copied.

`dvProject.undo(project)`, `dvProject.moveTo(project, to)` and `dvProject.redo(project)` call `undo`, `moveTo` and `redo`; each holds the project lock and returns `{tip, at}`. `dvProject.line(project)` returns `{tip, at}`; `dvProject.listRecords(project)` returns every record, discarded records included.

Invariants: a move writes no record and keeps `tip`; an undo and then a redo return to the same position; a write after a move appends after `at`, so the steps that were after `at` leave the history list and stay in `records.jsonl`; a discarded step never comes back to the list.

## 8. Runner (`runner.ts`)

Owner: agent B.

**Registration.** `registerOperation(spec)`: refuse a registered name with `operation_exists`, a `component` outside `proj asset bible plan shot timeline deliver inspect` with `invalid_params`, a name that does not start with `<component>.` with `invalid_params`, and a `confirm` other than `never` without `confirmSummary` with `invalid_params`. `listOperations` returns registration order.

**Runner: run.** Steps of `run(request)`:

1. Look up the operation (`unknown_operation`) and the project (`unknown_project`).
2. Validate `params` with `validateArgs(spec.params, params)` from `@deepseek-ai/dsh-tools`; any message → `invalid_params` with the messages joined. Every input role must be a key of `spec.inputs` (`invalid_inputs`).
3. Read-only operation (`spec.readOnly`): state = `reducers.getState(project)`, resolve inputs (step 5 rules), await `spec.precondition?.(request, state)` (a throw rejects `run` with that error), call `execute` with `record: null` and a scratch directory, and resolve `{record: null, outputs, report: report ?? null}`. No lock, no record. A throw from `execute` rejects `run` with that error.
4. Take the lock. `parent` = the current position, `store.line(project).at`.
5. Resolve inputs against `reducers.getState(project)` (the state at `parent`): `{asset}` must exist in the registered asset store (`unknown_asset`); `{record, output}` must name an existing record (`unknown_record`) and a non-negative integer `output`; when the producer is `done`, `resolved_asset` is its `outputs[output]` (missing → `invalid_inputs`); `failed` or `cancelled` → `invalid_inputs`; `pending` or `running` → `resolved_asset: null`, allowed only when `request.after` is set, else `input_not_ready`. An input whose role is in `spec.pendingInputRoles` resolves to `resolved_asset: null` for a producer in any status other than `done`, without `request.after`. A `{character}`, `{location}` or `{style}` ref becomes one input per asset of `reducers.assetsOf` (null → `invalid_inputs`), each with the same role and ref. Then await `spec.precondition?.(request, current state)` under the lock: a throw rejects `run` with that error unchanged, before anything is written.
6. Append the operation record by the discard rule (below): `status: 'pending'`, `component`, `operation`, `operation_version`, `deterministic` from the spec, `based_on ?? null`, `outputs: []`, and `supersedes`: `request.supersedes ?? []` followed by `spec.supersedes?.(params, current state)`, without repeats. Release the lock.
7. `request.after` set → `scheduler.enqueue(project, id, spec.resource, after, spec.pendingInputRoles ?? [])`; resolve with the `pending` record, `outputs: []`, `report: null`. Otherwise `final = await execute(project, id, request.signal)`; resolve with `{record: final, outputs: final.outputs, report: final.report ?? null}`. Immediate runs do not count against the scheduler's limits.

**Runner: execute.** `execute(project, record, signal?)`:

1. Read the record; a record that a write discarded before it started ends `cancelled` / `discarded` at once. Its operation must still be registered, else the final update is `failed` / `operation_failed`.
2. An input with `resolved_asset: null` (a producer that did not finish `done`) whose role is not in `spec.pendingInputRoles` → `failed` / `input_failed`. Inputs of those roles reach `execute` with `resolved_asset: null`; the record's current form fills it once the producer is done.
3. Deterministic reuse: when `spec.deterministic` and an earlier record has the same `operation` and `operation_version`, status `done`, `cost.reused` not true, equal params (canonical JSON with sorted keys) and the same sorted list of `resolved_asset` values: one update `{status: 'done', finished_at, outputs: <its outputs>, cost: {gpu_seconds: 0, wall_seconds: 0, reused: true}}`.
4. Otherwise update `{status: 'running', started_at}`; compute `state = reducers.stateAt(project, record.parents[0])`; create a scratch directory (`mkdtemp(join(tmpdir(), 'dv-operation-'))`); call `spec.execute(context)` with `importAsset` bound to `assets.importAsset(source, meta, record.id)`.
5. Success → `{status: 'done', finished_at, outputs, cost: {gpu_seconds: result.cost?.gpu_seconds ?? 0, wall_seconds: <measured, rounded to ms>, reused: false}, report}` (omit `report` when undefined). A throw while `signal` is aborted → `cancelled` / `stopped`, or `cancelled` / `discarded` when a discard aborted it; any other throw → `failed` / `operation_failed` with the error's message. Remove the scratch directory in every case.

**Confirmation.** The runner holds no call for confirmation and treats every caller alike. An agent's confirmation (`OperationSpec.confirm`) is checked earlier, in the agent tool call (section 11), before `run` is called.

**`acceptStale`.** Under the lock: the record must exist (`unknown_record`); append `proj.stale_accept` with `parents: [at]` by the discard rule.

**Discard.** Every record the runner appends goes after `at` and becomes `tip` and `at` (`appendStep`). The records of the history list that were after `at` leave the list. Each of them that is `pending` or `running` ends `cancelled` with `error {code: 'discarded'}`: an executing record is aborted; a queued scheduled record leaves the queue through `scheduler.cancel` and is updated at once; a record that has not started yet ends when `execute` starts it.

**`recover`.** At start: under each project's lock, every `pending` or `running` operation record gets `{status: 'cancelled', finished_at, error: {code: 'stopped', message: 'The server stopped before the call finished.'}}`.

Invariants: every record the runner writes starts `pending` and ends with exactly one final update; `run` never leaves a record `running` after it resolves (except a scheduled one, which the scheduler finishes); the lock is never held across `await` of `execute`.

## 9. Scheduler (`scheduler.ts`)

Owner: agent B. Behavior is in the module comment and JSDoc. Details:

- Queue order is enqueue order across projects. Each pump walks the queue once, front to back: a ready record with room starts; a ready record without room stays in place (later `none` records may still start); a waiting record stays.
- Readiness reads current forms from the store. `input_failed` updates are written under the project lock.
- The producers of inputs whose role is in the operation's `pendingInputRoles` are not dependencies: the record neither waits for them nor fails when they fail.
- `wait(project)` without records also waits for records enqueued while it waits, until the project has none queued or running. `wait(project, records)` works for any record, scheduled or not, and resolves at once when all are finished.
- `cancel(project, record)` takes a queued record that has not started out of the queue and returns whether it was queued; the caller ends the record. Waiters and dependent records re-check after that update.
- `dispose` stops starting records; a `wait` that can no longer settle stays pending (the service is going away).

Invariants: never more than `limits.gpu` scheduled `gpu` records and `limits.cpu` scheduled `cpu` records run at once; a record never starts before its dependencies are `done`; each queued record runs at most once.

## 10. Chat sessions, agent tools and agent context (`sessions.ts`, `agent-tools.ts`, `proj-tools.ts`, `agent-context.ts`)

**Sessions.** `bind(session, project)` writes `<sessionRoot>/<encodeURIComponent(session)>.json` as `{"project": "<ProjectId>"}` (the field name the API's workspace listing reads) and keeps it in memory; `project(session)` reads the file on first use (`null` without a file; a file whose `project` is neither a string nor null throws "is not a session binding"). `hold(session, work)` chains `work` behind earlier held work; `ready(session)` settles after all of it, whether it fulfilled or rejected.

**Turn.** `turnOf(ctx, exec)` reads the turn of a tool call from DSH: the `lastTurn` of the `turnBoundary` session projection (`ctx.sessionProjections.stateOf(exec.agent.session, 'turnBoundary')`, registered by the DSH agent loop) as a string `TurnId` such as `"3"`, unique within the session. A call without an agent, without the `sessionProjections` registry, or before the session's first turn has turn `null`. Operation tools and `dv_proj_*` tools both use it.

**Asset store.** `registerAssetStore(store)` keeps one store; a later registration replaces it and the remover clears only the same store. While no store is registered, `has` and `importAsset` throw "No asset store is registered", so a run that names an asset input or imports an output fails.

**Agent tools.** While the DSH `tools` registry is mounted, the service registers one tool per registered operation and removes it with the operation or the registry. `toolNameOf(spec)`: `dv_<name with _>`. The tool's description is `<description>`, then "Uses the GPU." for resource `gpu` or "Runs on the CPU." for `cpu` (nothing for `none`), then "A read that writes no record." for `readOnly` or, for `deterministic`, "Repeating a call with the same inputs and params reuses the earlier result.". Its parameters are `spec.params`, `spec.toolParams`, the confirmation argument of `spec.confirm` (`user_approved` for `always`, `user_requested` for `over_gpu_budget`, none for `never`), and the shared `reason` (required), `project_id`, `inputs` (when the operation has input roles), and `supersedes` and `based_on` (when the operation writes a record). A call:

1. waits for `sessions.ready(session)`; `session` is the calling agent's ID, else `anonymous`;
2. takes `project_id`, else the session's project, else fails with "No project selected";
3. builds the origin: actor `agent`, surface `chat`, the session, `turnOf(ctx, exec)`, the call ID, and the `reason` (empty → the operation name) as the intent;
4. reads the project's current state and parses `inputs` with `parseInputs`;
5. builds the run request: params are the arguments without the shared, tool-only and confirmation ones (so `user_approved` and `user_requested` never reach the record's params); `based_on` and `supersedes` from the arguments;
6. calls `spec.prepareToolCall` with `{args, request, state, exec}`, which may refuse the call before any record or change the request's params and inputs;
7. applies the confirmation rule (below); a refusal is a tool error and writes nothing;
8. schedules the call (`after: []`) when an input outside the operation's `pendingInputRoles` names an unfinished record, then runs it;
9. returns `{record, status, summary, outputs [{role, asset_id, mime, url}], scheduled, params, report?, images?}`; a read returns `record: ''`, the summary `<tool> answered` and its report; a `failed` or `cancelled` record is a tool error (`stopped` → "<tool> was stopped before it finished.", else the failure message). Model-visible text names the tool (`toolNameOf(spec)`), never the operation. `formatToolResult` (internal) writes the value as one text block, then one image block per image attachment.

**Confirmation rule.** Applies only to agent tool calls; calls by the human (views, API) and by the system (scheduled renders) never reach it and are never refused. For `confirm: 'never'` nothing happens. For `always`, a call whose `user_approved` argument is `true` runs; any other call is refused. For `over_gpu_budget`, a call whose `user_requested` argument is `true` runs; otherwise Project computes the turn's GPU seconds: the `cost.gpu_seconds` of the finished records of the call's session and turn (`listHistory({project, session, turn})`, the whole history), plus `spec.estimate(params).gpu_seconds` of that turn's `pending` and `running` records (by their operation's spec), plus `confirmSummary(call, state).gpu_seconds`; at most `confirmGpuSecondsThreshold` (Config, default 60) runs, more is refused. A call outside any turn (`turn` null) counts only its own estimate. The refusal is an `Error` whose message is, line by line: "<tool> needs the user's agreement." (`always`) or "<tool> would bring this turn to about N GPU seconds, above the M s budget." (`over_gpu_budget`, N rounded); "What it will do:"; the `confirmSummary` text; "Estimated GPU time: about S s."; and "Show this to the user and ask in the conversation, with the question in bold (for example **Render these shots now?**). Wait for the user's answer, then call again with <user_approved | user_requested>: true.".

**Input references.** `parseInputs(spec, raw, state, versionCreatedBy, callerName)`: `raw` is an object of role → reference text or a list of them. `<record>#<output>` → `{record, output}`; `<id>@<version>` → the first of `{character}`, `{location}`, `{style}` whose version `createdBy` of the reducer that defines it knows, else "Unknown character, location, or style version"; anything else → `{asset}`. An unknown role, a list on a single role, a non-string reference and a missing required role throw an error that names the role and `callerName`: the agent tool passes the tool name (`dv_shot_render_ref2va`), and `dvProject.parseInputs(operation, raw, state, callerName?)` passes the operation name unless its caller names another, so `@dv/api` names the operation. `formatInputRef(ref)` writes a reference as the text this parser reads back.

**Project tools.** While the registry is mounted, the service also registers the `dv_proj_*` tools of `proj-tools.ts` and removes them with the registry. Each resolves the project from `project_id`, else the session's project (else "No project selected"), and writes its records with the agent origin of the call. `dv_proj_create` and `dv_proj_open` bind the session and refuse ("This conversation belongs to project …") when the session is bound to another project. `dv_proj_history_list` returns `listHistory` entries (default limit 20), each as `{record, place, operation, status, actor, intent, outputs}`. `dv_proj_undo` takes an optional `to` and calls `undo`; `dv_proj_redo` calls `redo`. Every other tool returns the project summary of the current state: `record` (only after a tool that writes records: the newest record of the call, by `listHistory({tool_call})`; the tool's `presentationMeta` is `{record}`, and the tools `dv_proj_open dv_proj_state dv_proj_history_list dv_proj_undo dv_proj_redo dv_proj_wait`, which write no record, have none), `project_id head records`, then `agentSummaries` in order, then `stale` and `recent` (the last twelve records with their summaries and output URLs). A field name used twice throws `invalid_params`. `projectSummary` is exported to the agent context.

**Agent context.** While the DSH `systemPrompt` service is mounted, the service registers the system-prompt section `dv:project` (order `promptSectionOrder`, Config, default 4900; `interpolate: false`) and removes it with the service. `projectContext(project, deps, sessionId)` builds its text from the assembly's agent ID: Project's rules first (every call and every edit is a step at once, `dv_proj_undo` with or without `to` and `dv_proj_redo` as moves that add no step, a new change after a move discards the later steps so the agent asks first, naming things by record ID, `<record>#<n>`, `<id>@<version>`, asset ID and clip ID with the user pointing through + → 引用 or `dv:` mentions and ambiguous references asked about, confirmation in the conversation with the question in bold, stale records). For a session bound to a project, the rules are followed by "This conversation belongs to project <ProjectId>: do all work in it and never call dv_proj_create or dv_proj_open.", the line "Project summary of the current state, as dv_proj_state returns it:", and `projectSummary` of the current state as indented JSON. Without an agent or a bound project, the rules are followed by "No project is bound to this conversation yet: start the work with dv_proj_create.". The text names no selection and no preference the user cannot see.

## 11. Test plan

Each test file builds modules with `startModules()` and projects with `createTestProject()` from `tests/support.ts`. Test names below are the `it(...)` titles; each line says what the test asserts. Required tests are marked (R).

**`tests/record-store.spec.ts` (A)**

- `writes a record line and an update line` (R): `append` then `update(running)` then `update(done, outputs, cost)`: `readLines` gives one record line with exactly the record-line fields and two `{"update": id}` lines; `getRecord` returns the current form with `started_at`, `finished_at`, `outputs`, `cost`.
- `refuses an append whose parent is not the current position`: `parent_not_head`, nothing written, no event.
- `refuses a backward or repeated status`: `done` → `running` and `running` → `running` throw `status_backwards`.
- `refuses an update of a finished record`: `record_finished` after `done`, `failed`, `cancelled`.
- `reloads records, updates and the line from disk`: a second `RecordStore` on the same root after `load()` returns equal records and the same `{tip, at}` after a `moveTo`.
- `moves the current position without writing a record, and appends after it`: `moveTo` leaves `records.jsonl` unchanged and emits `line`; an append after the old `tip` throws `parent_not_head`; an append after `at` becomes `tip` and `at`; an unknown record throws `unknown_record`; a project without records has no line.
- `lists the record IDs of the history list with the index of the current position`: `lineIds` gives the list and the index of `at`; a write after a move leaves the later IDs out; a project without records gives `{ids: [], atIndex: -1}` and `requireLine` throws `invalid_params`.
- `fills resolved_asset of an output input once the producer is done`: record B with `{record: A, output: 0}`; null before A is done, A's output after; the file still has `null`.
- `returns copies that callers cannot use to change the store`.
- `serializes work under the project lock`: two `lock` calls with awaited delays run one after the other; another project's lock runs concurrently.
- `renames and deletes a project`: `project.json` title changes; the directory moves under `.trash`; `getProject` then throws `unknown_project`.
- `emits record, line and update events after the write`: events arrive in order with current forms, each after its change is on disk.

**`tests/subscriptions.spec.ts` (A)**

- `delivers events in subscription order and stops after removal`.
- `delivers the current event to the listeners subscribed when delivery started`.
- `keeps delivering when a listener throws`: the second listener still runs; `onListenerError` receives the error.

**`tests/reducers.spec.ts` (D)**

- `computes each registered slice from the records of the effective chain`: a test reducer counting records of its component; its slice and the `records` of the `proj` slice match the chain.
- `refuses a second reducer for a key`: `reducer_exists`.
- `marks consumers of a superseded record stale`: A outputs X, B consumes X, C supersedes A → `stale[B] = C`, `superseded[A] = C`, `created_by[X] = A`.
- `keeps a record fresh after proj.stale_accept`: after the accept record, `stale[B]` is gone and stays gone after a later unrelated record.
- `refuses a second reducer that defines createdBy or assetsOf`: `invalid_params`; after the remover, the key registers.
- `resolves character references through the reducer that defines assetsOf`: a test `test_bible` reducer with `assetsOf`.
- `marks records that read a superseded character version stale`: a test `test_bible` reducer with `createdBy`; an update that supersedes the creating record marks the render that read version 1 and the clip made from it.

**`tests/history.spec.ts` (D)**

- `moves the current position on undo and redo without writing a record, and the state follows it` (R): `undo` moves `at` back one step and the state follows; `nothing_to_undo` at `proj.create`; `redo` moves forward again; `nothing_to_redo` at `tip`; `records.jsonl` is unchanged; each move emits `line`.
- `moves to a step before or after the current position, and a move to the current position changes nothing`: `moveTo` back and forward sets the state and the places; a move to `at` emits nothing; an unknown ID throws `unknown_record`.
- `discards the steps after the current position on a write: they leave the list and stay on disk` (R): `discardedSteps` names the later steps; a write after a move has `at` as its parent and becomes `tip` and `at`; the list and the state leave out the discarded steps; `redo` throws `nothing_to_redo` and `moveTo` a discarded step throws `invalid_params`; `listRecords` still has them.
- `cancels a discarded running step and a discarded queued step, and leaves the new step running` (R): a move alone cancels nothing; the write after it ends the running render and the queued render `cancelled` / `discarded`, and the queued render never executes.
- `lists the steps of the list newest first with their place, and filters them` (R): entries carry `after`, `current` and `before`; `actor`, `session`, `tool_call`, `records`, `before` and `limit` each narrow the list as specified; an unknown `before` throws `unknown_record`.

**`tests/runner.spec.ts` (B)**

- `runs an operation and records its outputs`: `done` record with outputs, `cost.reused: false`, measured `wall_seconds`, report.
- `refuses invalid params, unknown inputs and unfinished inputs before writing`: `invalid_params`, `unknown_asset`, `input_not_ready`; the file is unchanged.
- `refuses a call that the operation's precondition refuses, before writing`.
- `adds the records an operation replaces to the record's supersedes`: `spec.supersedes` receives the params and the current state; its records follow `request.supersedes` without repeats.
- `fails the record when execute throws`: `failed` / `operation_failed` with the message; `run` resolves.
- `reuses outputs of an identical deterministic call`: second call `done` with `cost.reused: true`, execute not called.
- `writes no record for a read-only operation`: the file is unchanged; `report` is returned.
- `refuses an operation whose name does not start with its component key`.
- `runs an operation that asks for confirmation at once for every caller, holding no call` (R, confirmation): agent and `user` calls of `always` and `over_gpu_budget` operations end `done` through `run`; a `confirm` other than `never` without `confirmSummary` throws `invalid_params`.
- `lets other edits run while a render executes` (lock scope): an execute blocked on a promise; a second run on the same project finishes first.
- `ends unfinished records at start`: a `pending` record from an earlier store → `cancelled` / `stopped` after `recover`.

**`tests/scheduler.spec.ts` (B)**

- `runs scheduled records in dependency order` (R, scheduler ordering): B `after` A and C with an input `{record: B, output: 0}`; execution order is A, B, C; C's input resolves to B's output.
- `keeps at most one gpu record running`: two independent `gpu` records with `limits.gpu = 1` never overlap; a `none` record runs meanwhile.
- `fails a record whose input record failed`: A fails → B `failed` / `input_failed` and never executes.
- `does not wait for the producers of pending input roles`: B with `pendingInputRoles: ['clip']` and a `clip` input `{record: A, output: 0}` runs while A is pending; run without `after` executes at once with `resolved_asset: null`, a scheduled B starts before A finishes, and A's failure leaves B `done`.
- `waits for every scheduled record of a project`: `wait(project)` resolves after the last record finishes.

**`tests/agent-tools.spec.ts`**

- Tool names, registration with the registry and removal with the operation.
- A call runs as the agent on the session's project and turn, carries `based_on` and `supersedes`, and returns outputs with URLs and image blocks; a failed record is a tool error. With a `sessionProjections` registry whose `turnBoundary` state has `lastTurn: 3`, the record's `turn` is `"3"` and its `session` and `tool_call` are the call's.
- `records no turn for a call outside any turn`: with `lastTurn: 0`, the record's `turn` is null.
- A read answers with its report and writes nothing; without an attachment service a result has no images.
- `prepareToolCall` changes the inputs, tool-only arguments stay out of params, and a call behind an unfinished producer is scheduled.
- `refuses an always call without user_approved before any record, and runs it with the argument kept out of params` (R, confirmation): the tool has `user_approved` and no `user_requested`; the refusal is a tool error with the exact text (the tool, the `confirmSummary` text, the GPU estimate, the bold question) and writes no record; the same call with `user_approved: true` ends `done` with params without the argument; a `user` call through `run` is never refused.
- `refuses an over_gpu_budget call past the turn's budget, counting the turn's finished cost and unfinished estimates` (R, confirmation): the tool has `user_requested`; a 40 s call runs under the 60 s budget; the next 40 s call of the same turn is refused with the turn's total and the budget; with `user_requested: true` it runs and its params leave the argument out; a new turn starts from zero; a running render of the turn counts with its `estimate`.
- `refuses to register an operation that asks for confirmation without a confirmSummary`: `invalid_params`; nothing is registered.
- `gives the agent the dv:project prompt section: Project's rules, and the summary of the bound project's current state` (R): with a `systemPrompt` service mounted, an unbound session's section holds the rules (the step, undo, redo and discard rules) and ends with "No project is bound to this conversation yet: start the work with dv_proj_create."; a bound session's section holds "This conversation belongs to project <ProjectId>" and the project summary `dv_proj_state` returns for the current state, and no selection.
- Held work delays a session's calls until it settles, even when it fails.

**`tests/proj-tools.spec.ts`**

- Every `dv_proj_*` tool is registered while the registry is mounted and removed with the service.
- Create and open bind the session; a bound session refuses another project; a call without a project fails.
- Each reducer's `agentSummary` fields sit between `records` and `stale`; a field used twice refuses the summary.
- `recent` lists summaries, failure messages, output URLs and pending statuses; history lists the steps with their operation and `place`.
- Undo (one step, and to a step before or after the current one) and redo move the current position and write no record; a write after a move discards the later steps, and undo to a discarded step fails; stale accept and wait behave as their methods do.
- Undo and redo are read tools: their result names no record and has no presentation metadata.
- The record a write tool wrote leads its summary and its presentation metadata; read tools have no metadata.
- `parseInputs` for every reference form and every refusal.
- A binding survives a restart and a broken binding file throws; a run without an asset store fails.
