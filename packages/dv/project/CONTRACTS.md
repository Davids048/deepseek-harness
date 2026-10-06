# @dv/project module contracts

This file specifies the internal modules of the `dvProject` service: what each one does, its rules and errors,
and the unit tests that pin it. The public types are in `src/types.ts`, the errors and branch constants in
`src/shared.ts`, and the service surface with its JSDoc (working-branch rules, lock scope, every method) in
`src/index.ts`.

## Contents

1. [Modules, files and tests](#1-modules-files-and-tests)
2. [Module calls](#2-module-calls)
3. [Rules for every module](#3-rules-for-every-module)
4. [Record store](#4-record-store-record-storets)
5. [Subscriptions](#5-subscriptions-subscriptionsts)
6. [Reducer registry and state](#6-reducer-registry-and-state-reducersts)
7. [History](#7-history-historyts)
8. [Drafts and branches](#8-drafts-and-branches-draftsts)
9. [Runner and confirmation](#9-runner-and-confirmation-runnerts)
10. [Scheduler](#10-scheduler-schedulerts)
11. [Chat sessions and agent tools](#11-chat-sessions-and-agent-tools-sessionsts-agent-toolsts-proj-toolsts)
12. [Test plan](#12-test-plan)

## 1. Modules, files and tests

| Module                          | Files                                                        | Tests                                                       |
| ------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Record store and subscriptions  | `src/record-store.ts`, `src/subscriptions.ts`                | `tests/record-store.spec.ts`, `tests/subscriptions.spec.ts` |
| Runner, confirmation, scheduler | `src/runner.ts`, `src/scheduler.ts`                          | `tests/runner.spec.ts`, `tests/scheduler.spec.ts`           |
| Drafts, working branches        | `src/drafts.ts`                                              | `tests/drafts.spec.ts`                                      |
| History and reducer registry    | `src/history.ts`, `src/reducers.ts`                          | `tests/history.spec.ts`, `tests/reducers.spec.ts`           |
| Chat sessions and agent tools   | `src/sessions.ts`, `src/agent-tools.ts`, `src/proj-tools.ts` | `tests/agent-tools.spec.ts`, `tests/proj-tools.spec.ts`     |

The runner, drafts and history call the record store; the runner and drafts call the reducer registry and
`effectiveChain`; the runner calls `drafts.branchForWrite`. Tests use the real modules (`tests/support.ts`
`startModules()`), not mocks of other modules. Run them from `packages/dv`:
`../../node_modules/.bin/vitest run --config vitest.config.ts project/tests`.

## 2. Module calls

```
  callers (API, agent tools, components)
        |
        v
  index.ts  DvProject (dvProject) ---------------------------------------------+
        |  createProject renameProject deleteProject openProject listProjects  |
        |  getRecord                                       -> record-store     |
        |  run acceptStale registerOperation listOperations                    |
        |  registerApprovalChannel                         -> runner           |
        |  acceptDraft discardDraft createBranch switchBranch                  |
        |  workingBranch listBranches                      -> drafts           |
        |  undo redo listHistory                           -> history          |
        |  getState registerReducer                        -> reducers         |
        |  wait                                            -> scheduler        |
        |  subscribe                                       -> subscriptions    |
        |  bindSession sessionProject noteTurn sessionTurn holdToolCalls       |
        |                                                  -> sessions         |
        |  registerOperation (tool), parseInputs           -> agent-tools      |
        |  dv_proj_* tools (registry mounted)              -> proj-tools       |
        |  registerAssetStore: the store the runner and agent-tools read       |
        v                                                                      |
  runner ----> drafts.branchForWrite / workingBranch                           |
    |    ----> reducers.stateAt / getState / assetsOf                          |
    |    ----> scheduler.enqueue          scheduler ----> runner.execute       |
    |    ----> approval channel (composer), asset store                        |
    v                                                                          |
  drafts ----> reducers.getState / apply / conflict, history.effectiveChain    |
  reducers --> history.effectiveChain                                          |
  history, drafts, reducers, runner, scheduler ----> record-store             |
                                                         |                     |
                                                         v  onChange(event)    |
                                         subscriptions.emit, scheduler.recordFinished
```

Only `record-store.ts` imports `node:fs` or knows a file path under the root. The runner's scratch directory for
`execute` is the one other file system use (a temporary directory under the OS temp directory).

## 3. Rules for every module

**Lock.** `RecordStore.lock(project, fn)` serializes work per project. Who holds it:

- `run`: while it checks the request and appends the request record and the operation record; again for each update
  line (`running`, the final status). Never while an approval card waits or while `execute` runs.
- `acceptDraft`, `discardDraft`, `undo`, `redo`, `createBranch`, `switchBranch`, `renameProject`, `deleteProject`, the
  `proj.create` append of `createProject`, and `acceptStale`: for the whole call (`index.ts` takes it for all but
  `acceptStale`, which the runner takes).
- Reads (`getState`, `getRecord`, `listHistory`, `listBranches`, `workingBranch`, `openProject`, `listProjects`) take
  no lock. Read-only operations take no lock.
- The lock is not reentrant: a function that runs under the lock never calls `lock` for the same project. Module
  functions documented "the caller holds the project lock" never take it themselves.

**Errors.** Throw `ProjectError(code, message)` from `src/shared.ts` with one of the approved codes, and
`DraftConflictError` for accept conflicts. Messages are in words a creator can read and name the project, record or
branch. A refused call changes nothing on disk and emits no event. Failures of an operation call after its record
exists never throw: they end the record with a `RecordFailure` (`operation_failed`, `input_failed`, `skipped`,
`stopped`).

**IDs and times.** Record IDs and project IDs are `randomUUID()` values. Times are `new Date().toISOString()`.

**Record templates.** Every record copies the six `RecordOrigin` fields from the call. Request records and `proj.*`
records are written with `status: 'done'` and have no update lines.

| Record               | `kind`      | `component` | `operation`, `operation_version` | `params`                                                         |
| -------------------- | ----------- | ----------- | -------------------------------- | ---------------------------------------------------------------- |
| request              | `request`   | `proj`      | `null`, `null`                   | `{}`; `intent` = the human's words; actor `user`, surface `chat` |
| `proj.create`        | `operation` | `proj`      | `proj.create`, `1`               | `{title}`                                                        |
| `proj.draft_accept`  | `operation` | `proj`      | `proj.draft_accept`, `1`         | `{draft, base, replayed: [[original, copy], …]}`                 |
| `proj.draft_discard` | `operation` | `proj`      | `proj.draft_discard`, `1`        | `{draft, base, agent_changes, human_edits}`                      |
| `proj.undo`          | `operation` | `proj`      | `proj.undo`, `1`                 | `{to}`                                                           |
| `proj.redo`          | `operation` | `proj`      | `proj.redo`, `1`                 | `{to}`                                                           |
| `proj.branch_create` | `operation` | `proj`      | `proj.branch_create`, `1`        | `{name, at}` (`at` is the record ID)                             |
| `proj.branch_switch` | `operation` | `proj`      | `proj.branch_switch`, `1`        | `{from, to}` (branch names)                                      |
| `proj.stale_accept`  | `operation` | `proj`      | `proj.stale_accept`, `1`         | `{record}`                                                       |

All of them have `inputs: []`, `outputs: []`, `based_on: null`, `supersedes: []`, `deterministic: true`.

**Draft identity.** Draft names are reused per session: after `draft/<S>` is accepted or discarded, the next agent
write of S opens a new draft with the same name. Anything that identifies one specific draft (history marks, the
records of a discarded draft, undo of an accepted draft) uses its fork record (`forked_at`, `params.base`), never the
branch name alone.

**Current form.** Every module reads records in their current form from the record store: the record line, with each
update line applied in order, and with the `resolved_asset` of each `{record, output}` input filled from the producer's
`outputs[output]` once the producer is `done` (a derived value, never written to disk).

## 4. Record store (`record-store.ts`)

Owner: agent A. Files: `<root>/<ProjectId>/project.json` (`ProjectInfo`, pretty-printed or one line, ending with a
newline), `records.jsonl` (one JSON object per line), `branches.json` (`BranchesFile`).

| Function                                  | Behavior                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constructor(root, onChange)`             | Stores both; `mkdirSync(root, {recursive: true})` happens in `load`.                                                                                                                                    |
| `load()`                                  | Reads every `<root>/*/project.json` (skips directories without it and `.trash`), replays `records.jsonl` (record lines, then update lines applied in file order), reads `branches.json`. Emits nothing. |
| `lock(project, fn)`                       | A per-project promise chain: `fn` starts after every earlier `fn` for that project settled, whether it resolved or threw. Different projects run concurrently. Returns `fn`'s result or rejection.      |
| `createProject(info)`                     | Writes `project.json`, an empty `records.jsonl`, and `{"branches":{},"sessions":{}}` to `branches.json`. Refuses an existing ID with `invalid_params`.                                                  |
| `listProjects()` / `getProject(id)`       | Oldest first by `created_at`, then ID. `getProject` throws `unknown_project`.                                                                                                                           |
| `renameProject(id, title)`                | Rewrites `project.json` atomically (write `<file>.tmp`, rename). Returns the new info.                                                                                                                  |
| `deleteProject(id)`                       | Renames the directory to `<root>/.trash/<id>-<Date.now()>`; forgets the project, its listeners stay.                                                                                                    |
| `append(project, line)`                   | Rules in the JSDoc. Assigns `id` and `created_at`, appends one line, moves the branch pointer, rewrites `branches.json`, then emits `{kind: 'record'}` and `{kind: 'branch'}`.                          |
| `update(project, update)`                 | Rules in the JSDoc. Appends one `{"update": id, …}` line, applies it in memory, emits `{kind: 'update', record}` with the current form.                                                                 |
| `getRecord` / `listRecords` / `ancestors` | Current forms. `ancestors` follows `parents[0]` only (the raw chain).                                                                                                                                   |
| `getBranch` / `listBranches`              | `StoredBranch` values; `listBranches` returns `main` first, then by name.                                                                                                                               |
| `setBranch(project, branch)`              | Creates or replaces the entry, rewrites `branches.json` atomically, emits `{kind: 'branch', name, branch: {...branch, counts: null}}`.                                                                  |
| `removeBranch(project, name)`             | Deletes the entry (refuses `main` with `invalid_params`, unknown name with `unknown_branch`), rewrites, emits `{kind: 'branch', name, branch: null}`.                                                   |
| `getSessionBranch` / `setSessionBranch`   | Reads and writes `sessions` in `branches.json` (atomic rewrite); emits nothing.                                                                                                                         |

Invariants:

- `records.jsonl` is append-only: no function rewrites or truncates it. Line order is write order.
- A record line is written exactly once; it carries no `started_at`, `finished_at`, `error`, `cost` or `report`.
- Status order: `pending` → `running` | `done` | `failed` | `cancelled`; `running` → `done` | `failed` |
  `cancelled`. Moving to the same status or backwards throws `status_backwards`; any update of a `done`, `failed`
  or `cancelled` record throws `record_finished`.
- The store emits an event only after the line or file is written; a refused call emits nothing.
- The store writes `branches.json` with each `setBranch`, `removeBranch`, `setSessionBranch` and `append`.
- `getRecord` and `listRecords` return copies, so a caller that mutates a result cannot change the store.

## 5. Subscriptions (`subscriptions.ts`)

Owner: agent A. `subscribe(project, listener)` adds a listener and returns an idempotent remover. `emit(project, event)`
calls the project's listeners synchronously, in subscription order, on a snapshot of the set (a listener removed during
delivery still receives the current event; one added during delivery does not). A throwing listener is reported to
`onListenerError` and delivery continues. `dvProject.subscribe` exposes it; the live stream (`/dv/events`) and the
stream service are its consumers.

## 6. Reducer registry and state (`reducers.ts`)

Owner: agent D.

| Function                             | Behavior                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register(key, reducer)`             | One reducer per key (`reducer_exists`); at most one reducer defines `createdBy` and `assetsOf` (`invalid_params`). Registration order is the call order of `reduce` and `conflict`. Returns a remover. |
| `getState(project, branch)`          | `stateAt(project, branch, head of branch)`; `unknown_branch` for a missing branch.                                                                     |
| `stateAt(project, branch, head)`     | `reduceChain(info, branch, effectiveChain(store, project, head))`.                                                                                     |
| `reduceChain(info, branch, records)` | Starts each registered reducer at `initial()`, calls `reduce` for every record in order, returns `{project: info, branch, head: last.id, components}`. |
| `apply(state, record)`               | One more `reduce` per reducer on a copy of `state.components`; `head` becomes `record.id`.                                                             |
| `conflict(state, record)`            | The first non-null `conflict` result, in registration order, else null.                                                                                |
| `assetsOf(state, ref)`               | `assetsOf` of the reducer that defines it, on that reducer's slice (Story bible in a deployment); null when no reducer defines it.                    |
| `createdBy` (private)                | `createdBy` of the reducer that defines it, on its slice before the record; the `proj` slice reads it while it reduces that record.                   |
| `agentSummaries(state, assets)`      | The `agentSummary` fields of every reducer that defines it, in the component key order of `COMPONENT_KEYS` (other keys after, in registration order). |

`projReducer` (Project's own slice) follows its JSDoc. Staleness in detail, for each record R in order:

The producers of an input are the record in `created_by[resolved_asset]` and, for a `{character}`, `{location}` or
`{style}` ref, the record that created that version (`createdBy` of the reducer that defines it).

1. Each output asset of R when R is `done`: `created_by[asset] = R.id`.
2. Each ID X in `R.supersedes`: `superseded[X] = R.id`; then every earlier record with an input produced by X, or by a
   record already stale through X, gets `stale[consumer] = R.id` unless it carries a stale acceptance.
3. Each input of R produced by a record P with `superseded[P]` or `stale[P]` set: R gets
   `stale[R] = superseded[P] ?? stale[P]`, unless R carries a stale acceptance.
4. `proj.stale_accept` with `params.record = X`: delete `stale[X]` and remember X as accepted; accepted records are
   never marked again, and their consumers are not stale through them.

Version staleness follows from these rules: the operation that writes a new character, location or style version
supersedes the record that created the previous version (`OperationSpec.supersedes`), so every record that read the
previous version, and every record downstream of it, is stale.

Invariants: reducers are pure; `getState` on the same records always gives equal state; a reducer never sees a record
twice; a registered reducer that throws makes `getState` throw (the error propagates; nothing is cached). An
implementation may cache states by `(project, head)`; a cached state must be dropped when an update line changes a
record on that chain.

## 7. History (`history.ts`)

Owner: agent D. The module comment defines the effective chain and change units; the JSDoc of `undo`, `redo` and
`list` defines their behavior.

- `effectiveChain(store, project, head)`: iterative (no recursion depth limit): walk back from `head`; at a
  `proj.undo` or `proj.redo` record U, keep U and continue from `U.params.to` instead of `U.parents[0]`. Return the
  kept records oldest first.
- `undo`: the target X is the effective-chain record just before the last change unit's first record. For a
  `proj.draft_accept` unit, X is `params.base`. The `proj.undo` record is appended on `main` with `parents: [main
  head]` and `params.to = X`.
- `redo`: see JSDoc; `params.to` is the parent of the undo being redone, so the state returns to what it was just
  before that undo.
- `list(query)`: filters combine with AND; `before` keeps records written before that record (file order);
  `limit` applies after filtering. Marks follow the JSDoc order: `main`, `draft`, `discarded`, `replayed`, `undone`,
  `branch`.

Invariants: undo and redo never move a pointer other than `main` and never rewrite a record; undo after undo walks
further back; any change on `main` after an undo removes the possibility to redo it.

## 8. Drafts and branches (`drafts.ts`)

Owner: agent C. The module comment defines the working branch and the branch for a write; the JSDoc of each function
gives its steps.

- `workingBranch`, `listBranches`: add `counts` (via `counts`) for branches whose `session` is set, else `null`.
- `branchForWrite`: called by the runner under the lock. Agent write without session → `main` (no draft).
- `accept` and `discard` refuse with `draft_busy` while any draft record after `forked_at` is `pending` or `running`.
  A scheduled record waiting in the scheduler is `pending`, so a plan whose shots are still rendering keeps its draft
  busy.
- Replay copies keep every field of the original's current form except `id`, `parents`, `created_at`; the copy's
  `branch` is the draft name. The update line after the copy repeats the original's final fields, so copies have the
  same `outputs`, `cost` and `report`.
- Generic conflict (besides reducer conflicts): a draft record that supersedes a record which the new base already
  marks superseded by a record outside the draft.
- `switchBranch` to the branch the session already works on still writes the record (`from` equals `to`).

Invariants: at most one open draft per session per project; a draft's `base` and `forked_at` are set when it opens and
change only during replay; removing a draft never removes records; a conflict writes nothing.

## 9. Runner and confirmation (`runner.ts`)

Owner: agent B.

**Registration.** `registerOperation(spec)`: refuse a registered name with `operation_exists`, a `component`
outside `proj asset bible plan shot timeline deliver inspect` with `invalid_params`, and a name that does not start
with `<component>.` with `invalid_params`. `listOperations` returns registration order.
`registerApprovalChannel`: one channel; a later one replaces it; the remover clears only the same channel.

**Runner: run.** Steps of `run(request)`:

1. Look up the operation (`unknown_operation`) and the project (`unknown_project`).
2. Validate `params` with `validateArgs(spec.params, params)` from `@deepseek-ai/dsh-tools`; any message →
   `invalid_params` with the messages joined. Every input role must be a key of `spec.inputs` (`invalid_inputs`).
3. Read-only operation (`spec.readOnly`): branch = `drafts.workingBranch(project, session).name`, state =
   `reducers.getState`, resolve inputs (step 5 rules), await `spec.precondition?.(request, state)` (a throw rejects `run`
   with that error), call `execute` with `record: null` and a scratch directory, and
   resolve `{record: null, outputs, report: report ?? null}`. No lock, no record, no confirmation. A throw from
   `execute` rejects `run` with that error.
4. Take the lock. `branch = drafts.branchForWrite(project, request)`; `parent = head of branch`.
5. Resolve inputs against `reducers.stateAt(project, branch, parent)`:
   `{asset}` must exist in the registered asset store (`unknown_asset`); `{record, output}` must name an existing record
   (`unknown_record`) and a non-negative integer `output`; when the producer is `done`, `resolved_asset` is its
   `outputs[output]` (missing → `invalid_inputs`); `failed` or `cancelled` → `invalid_inputs`; `pending` or
   `running` → `resolved_asset: null`, allowed only when `request.after` is set, else `input_not_ready`. A
   `{character}`, `{location}` or `{style}` ref becomes one input per asset of `reducers.assetsOf` (null →
   `invalid_inputs`), each with the same role and ref. Then await `spec.precondition?.(request, state of the working
   branch)` under the lock: a throw rejects `run` with that error unchanged, before anything is written.
6. When `request.request_text` is set, `request.turn` is not null, and no record of the project has `kind: 'request'`
   and this turn: append the request record on `branch` (template in section 3).
7. Append the operation record: `status: 'pending'`, `component`, `operation`, `operation_version`, `deterministic`
   from the spec, `based_on ?? null`, `outputs: []`, and `supersedes`: `request.supersedes ?? []` followed by
   `spec.supersedes?.(params, state of the working branch)`, without repeats. Release the lock.
8. Confirmation (outside the lock): see below. Skipped or stopped → final update, resolve with the `cancelled`
   record.
9. `request.after` set → `scheduler.enqueue(project, id, spec.resource, after)`; resolve with the `pending` record,
   `outputs: []`, `report: null`. Otherwise `final = await execute(project, id, request.signal)`; resolve with
   `{record: final, outputs: final.outputs, report: final.report ?? null}`. Immediate runs do not count against the
   scheduler's limits.

**Runner: execute.** `execute(project, record, signal?)`:

1. Read the record; its operation must still be registered, else the final update is `failed` / `operation_failed`.
2. An input with `resolved_asset: null` (a producer that did not finish `done`) → `failed` / `input_failed`.
3. Deterministic reuse: when `spec.deterministic` and an earlier record has the same `operation` and
   `operation_version`, status `done`, `cost.reused` not true, equal params (canonical JSON with sorted keys) and the
   same sorted list of `resolved_asset` values: one update `{status: 'done', finished_at, outputs: <its outputs>,
   cost: {gpu_seconds: 0, wall_seconds: 0, reused: true}}`.
4. Otherwise update `{status: 'running', started_at}`; compute `state = reducers.stateAt(project, record.branch,
   record.parents[0])`; create a scratch directory (`mkdtemp(join(tmpdir(), 'dv-operation-'))`); call
   `spec.execute(context)` with `importAsset` bound to `assets.importAsset(source, meta, record.id)`.
5. Success → `{status: 'done', finished_at, outputs, cost: {gpu_seconds: result.cost?.gpu_seconds ?? 0,
   wall_seconds: <measured, rounded to ms>, reused: false}, report}` (omit `report` when undefined). A throw while
   `signal` is aborted → `cancelled` / `stopped`; any other throw → `failed` / `operation_failed` with the error's
   message. Remove the scratch directory in every case.

**Confirmation rule.** After the pending record exists, the runner waits for approval when all of these hold:
`spec.confirm === 'agent_ask_first'`, `request.actor === 'agent'`, `request.session !== null`, a channel is registered,
and `channel.asksFirst(session)` is true. It calls `channel.requestApproval({project, record, gpu_seconds:
spec.estimate?.(params).gpu_seconds ?? 0, signal})`, where `signal` is the request's signal or a never-aborted one.
`true` → continue. `false` → final update `{status: 'cancelled', finished_at, error: {code, message}}` with code
`stopped` when the signal is aborted, else `skipped`. An already-aborted signal skips the card and ends `stopped`. Human
(`user`) and `system` calls are never held, and a scheduled `system` render that a plan approval created is not held:
the agent's `plan.approve` call is the one that asks. The chat approval card only shows the pending call; enforcement
is here, so a caller that bypasses the card still cannot run an agent render in ask-first mode.

**`acceptStale`.** Under the lock: the record must exist (`unknown_record`); append `proj.stale_accept` on
`drafts.branchForWrite(project, origin)`.

**`recover`.** At start: under each project's lock, every `pending` or `running` operation record gets
`{status: 'cancelled', finished_at, error: {code: 'stopped', message: 'The server stopped before the call finished.'}}`.

Invariants: every record the runner writes starts `pending` and ends with exactly one final update; `run` never leaves
a record `running` after it resolves (except a scheduled one, which the scheduler finishes); the lock is never held
across `await` of an approval or `execute`.

## 10. Scheduler (`scheduler.ts`)

Owner: agent B. Behavior is in the module comment and JSDoc. Details:

- Queue order is enqueue order across projects. Each pump walks the queue once, front to back: a ready record with
  room starts; a ready record without room stays in place (later `none` records may still start); a waiting record
  stays.
- Readiness reads current forms from the store. `input_failed` updates are written under the project lock.
- `wait(project)` without records also waits for records enqueued while it waits, until the project has none queued
  or running. `wait(project, records)` works for any record, scheduled or not, and resolves at once when all are
  finished.
- `dispose` stops starting records; a `wait` that can no longer settle stays pending (the service is going away).

Invariants: never more than `limits.gpu` scheduled `gpu` records and `limits.cpu` scheduled `cpu` records run at once;
a record never starts before its dependencies are `done`; each queued record runs at most once.

## 11. Chat sessions and agent tools (`sessions.ts`, `agent-tools.ts`, `proj-tools.ts`)

**Sessions.** `bind(session, project)` writes `<sessionRoot>/<encodeURIComponent(session)>.json` as
`{"projectId": "<ProjectId>"}` (the field name the views workspace listing reads) and keeps it in memory;
`project(session)` reads the file on first use (`null` without a file; a file whose `projectId` is neither a string
nor null throws "is not a session binding"). `noteTurn(session, n, text)`: a turn number different from the current
one starts a new `TurnId`; the same number with non-empty text sets the turn's request text. `hold(session, work)`
chains `work` behind earlier held work; `ready(session)` settles after all of it, whether it fulfilled or rejected.

**Tool call check.** `registerToolCallCheck(check)` keeps one check (the agent integration's DSH question rule); a
later registration replaces it, the remover clears only the same check, and both register every tool again so the
schemas carry `check.params(spec)`. Every tool registration belongs to the service's own `ctx.inject(['tools'])` child,
whichever plugin registers the check or the operation, so a check removed while its plugin unloads leaves every
operation tool registered.

**Asset store.** `registerAssetStore(store)` keeps one store; a later registration replaces it and the remover clears
only the same store. While no store is registered, `has` and `importAsset` throw "No asset store is registered", so a
run that names an asset input or imports an output fails.

**Agent tools.** While the DSH `tools` registry is mounted, the service registers one tool per registered operation
and removes it with the operation or the registry. `toolNameOf(spec)`: `dv_<name with _>`. The tool's description
is `<description>`, then "Uses the GPU." for resource `gpu` or "Runs on the CPU." for `cpu` (nothing for `none`), then
"A read that writes no record." for `readOnly` or, for `deterministic`, "Repeating a call with the same inputs and params
reuses the earlier result.". Its parameters are
`spec.params`, `spec.toolParams`, the tool call check's `params(spec)`, and the shared `reason` (required), `project_id`, `inputs` (when the operation has
input roles), and `supersedes` and `based_on` (when the operation writes a record). A call:

1. waits for `sessions.ready(session)`; `session` is the calling agent's ID, else `anonymous`;
2. takes `project_id`, else the session's project, else fails with "No project selected";
3. builds the origin: actor `agent`, surface `chat`, the session, the session's current turn, the call ID, and the
   `reason` (empty → the operation name) as the intent;
4. reads the state of the session's working branch and parses `inputs` with `parseInputs`;
5. builds the run request: params are the arguments without the shared and tool-only ones; `request_text` is the
   turn's text when it has one; `based_on` and `supersedes` from the arguments;
6. calls `spec.prepareToolCall`, then the tool call check's `check(spec, …)`, with `{args, request, state, exec}`;
   either may refuse the call before any record or change the request's params and inputs; neither is a
   confirmation gate, because the runner alone enforces `confirm`;
7. schedules the call (`after: []`) when an input names an unfinished record, then runs it;
8. returns `{record, status, summary, outputs [{role, asset_id, mime, url}], scheduled, params, report?, images?}`;
   a read returns `record: ''`, the summary `<tool> answered` and its report; a `failed` or `cancelled` record is a
   tool error (`skipped` → "The user declined <tool>", `stopped` → "<tool> was stopped", else the failure message).
   Model-visible text names the tool (`toolNameOf(spec)`), never the operation. `formatToolResult` (internal) writes
   the value as one text block, then one image block per image attachment.

**Input references.** `parseInputs(spec, raw, state)`: `raw` is an object of role → reference text or a list of
them. `<record>#<output>` → `{record, output}`; `<id>@<version>` → the first of `{character}`, `{location}`, `{style}` whose
version `createdBy` of the reducer that defines it knows, else "Unknown character, location, or style version";
anything else → `{asset}`. An unknown role, a list on a single role, a non-string reference and a missing required role throw.
`formatInputRef(ref)` writes a reference as the text this parser reads back.

**Project tools.** While the registry is mounted, the service also registers the `dv_proj_*` tools of `proj-tools.ts`
and removes them with the registry. Each resolves the project from `project_id`, else the session's project (else
"No project selected"), and writes its records with the agent origin of the call. `dv_proj_create` and `dv_proj_open`
bind the session and refuse ("This conversation belongs to project …") when the session is bound to another project;
`dv_proj_draft_discard` passes the working branch's counts and refuses without an open draft;
`dv_proj_branch_create` prefixes `explore/` and switches the session to the new branch. `dv_proj_history_list`
returns `listHistory` entries (default limit 20). Every other tool returns the project summary of the session's
working branch (`dv_proj_state` takes `branch`): `project_id head branch draft branches records`, then
`agentSummaries` in order, then `stale` and `recent` (the last twelve operation records with their summaries and
output URLs). A field name used twice throws `invalid_params`.

## 12. Test plan

Each test file builds modules with `startModules()` and projects with `createTestProject()` from `tests/support.ts`.
Test names below are the `it(...)` titles; each line says what the test asserts. Required tests are marked (R).

**`tests/record-store.spec.ts` (A)**

- `writes a record line and an update line` (R): `append` then `update(running)` then `update(done, outputs, cost)`:
  `readLines` gives one record line with exactly the record-line fields and two `{"update": id}` lines; `getRecord`
  returns the current form with `started_at`, `finished_at`, `outputs`, `cost`.
- `refuses an append whose parent is not the branch head`: `parent_not_head`, nothing written, no event.
- `refuses a backward or repeated status`: `done` → `running` and `running` → `running` throw `status_backwards`.
- `refuses an update of a finished record`: `record_finished` after `done`, `failed`, `cancelled`.
- `reloads records, updates and branches from disk`: a second `RecordStore` on the same root after `load()` returns
  equal records, branches and session branches.
- `fills resolved_asset of an output input once the producer is done`: record B with `{record: A, output: 0}`;
  null before A is done, A's output after; the file still has `null`.
- `serializes work under the project lock`: two `lock` calls with awaited delays run one after the other; another
  project's lock runs concurrently.
- `renames and deletes a project`: `project.json` title changes; the directory moves under `.trash`;
  `getProject` then throws `unknown_project`.
- `emits record, update and branch events after the write`: events arrive in order with current forms.

**`tests/subscriptions.spec.ts` (A)**

- `delivers events in subscription order and stops after removal`.
- `keeps delivering when a listener throws`: the second listener still runs; `onListenerError` receives the error.

**`tests/reducers.spec.ts` (D)**

- `computes each registered slice from the branch records`: a test reducer counting records of its component; its
  slice and the `records` of the `proj` slice match the chain.
- `refuses a second reducer for a key`: `reducer_exists`.
- `marks consumers of a superseded record stale`: A outputs X, B consumes X, C supersedes A → `stale[B] = C`,
  `superseded[A] = C`, `created_by[X] = A`.
- `keeps a record fresh after proj.stale_accept`: after the accept record, `stale[B]` is gone and stays gone after a
  later unrelated record.
- `refuses a second reducer that defines createdBy or assetsOf`: `invalid_params`; after the remover, the key
  registers.
- `resolves character references through the reducer that defines assetsOf`: a test `test_bible` reducer with
  `assetsOf`.
- `marks records that read a superseded character version stale`: a test `test_bible` reducer with `createdBy`; an
  update that supersedes the creating record marks the render that read version 1 and the clip made from it.

**`tests/history.spec.ts` (D)**

- `writes undo and redo as records` (R): two human edits on `main`; `undo` appends `proj.undo` with `params.to` = the
  first edit; state equals the state at the first edit; `redo` appends `proj.redo` with `params.to` = the second edit;
  state equals the state after both edits; the file contains every record.
- `undoes an accepted draft as one change`: accept a draft of two records; one `undo` returns `main` to
  `params.base` of the accept.
- `refuses undo with nothing to undo and redo with nothing to redo`: `nothing_to_undo` on a new project;
  `nothing_to_redo` after a fresh edit that followed an undo.
- `lists history newest first with filters` (R): records from two actors and two branches; default order is reverse
  write order; `actor`, `branch`, `operation`, `session`, `before` and `limit` each narrow the list as specified.
- `marks main, draft, undone, discarded and replayed records`: one scenario that produces each mark and asserts it.

**`tests/drafts.spec.ts` (C)**

- `opens one draft on the first agent write and keeps it across turns` (R): agent writes in turn 1 and turn 2 of the
  same session land on `draft/<session>` with one `forked_at`; `main` does not move.
- `puts a human edit with a session on that session's draft` (R): with the draft open, a `user` write with the session
  goes to the draft; without a draft it goes to `main`; a `user` write never opens a draft; a write without a session
  goes to `main`.
- `accepts by fast-forward when main did not move` (R, accept without conflict): `proj.draft_accept` with
  `replayed: []`; `main` points at it; the draft branch is gone.
- `replays the draft on a main that moved` (R, accept replay without conflict): another session's edit lands on `main`
  first; accept appends copies after the new `main` head, the accept record lists `[original, copy]` pairs, and the
  state of `main` contains both changes.
- `stops with DraftConflictError and writes nothing on a conflict` (R, accept replay with conflict): a test reducer
  whose `conflict` returns a reason; the error names the record and reason; `records.jsonl`, `branches.json` and both
  pointers are unchanged.
- `counts and discards a draft` (R, discard counts): two agent records, one human edit → counts `{agent_changes: 2,
  human_edits: 1}`; discard with matching counts writes `proj.draft_discard` with `base`; mismatching counts throw
  `draft_changed`; afterwards `workingBranch` is `main`.
- `refuses accept and discard while a draft record runs`: `draft_busy`.
- `creates and switches to an exploration branch`: `proj.branch_create` and `proj.branch_switch` records; the
  session's working branch becomes the exploration branch; a draft opened then forks from it and accepts into it.

**`tests/runner.spec.ts` (B)**

- `runs an operation and records its outputs`: `done` record with outputs, `cost.reused: false`, measured
  `wall_seconds`, report.
- `writes the turn's request record once`: two runs of one turn with `request_text` → one `request` record before the
  first operation record.
- `refuses invalid params, unknown inputs and unfinished inputs before writing`: `invalid_params`, `unknown_asset`,
  `input_not_ready`; the file is unchanged.
- `adds the records an operation replaces to the record's supersedes`: `spec.supersedes` receives the params and the
  working branch's state; its records follow `request.supersedes` without repeats.
- `fails the record when execute throws`: `failed` / `operation_failed` with the message; `run` resolves.
- `reuses outputs of an identical deterministic call`: second call `done` with `cost.reused: true`, execute not called.
- `writes no record for a read-only operation`: the file is unchanged; `report` is returned.
- `asks before an agent render in ask-first mode` (R, confirmation): channel `asksFirst` true; the record stays
  `pending` until `requestApproval` resolves true, then `done`; resolving false ends `cancelled` / `skipped`; aborting
  the signal ends `cancelled` / `stopped`.
- `does not ask for human calls or in direct mode`: actor `user`, or `asksFirst` false → `requestApproval` never
  called.
- `asks in ask-first mode even when the agent call says the user approved it` (R, confirmation): `user_approved`
  and `user_requested` in the params do not skip the approval card.
- `refuses an operation whose name does not start with its component key`.
- `lets other edits run while a render executes` (lock scope): an execute blocked on a promise; a second run on the
  same project finishes first.
- `ends unfinished records at start`: a `pending` record from an earlier store → `cancelled` / `stopped` after
  `recover`.

**`tests/scheduler.spec.ts` (B)**

- `runs scheduled records in dependency order` (R, scheduler ordering): B `after` A and C with an input
  `{record: B, output: 0}`; execution order is A, B, C; C's input resolves to B's output.
- `keeps at most one gpu record running`: two independent `gpu` records with `limits.gpu = 1` never overlap; a `none`
  record runs meanwhile.
- `fails a record whose input record failed`: A fails → B `failed` / `input_failed` and never executes.
- `waits for every scheduled record of a project`: `wait(project)` resolves after the last record finishes.

**`tests/agent-tools.spec.ts`**

- Tool names, registration with the registry and removal with the operation.
- A call runs as the agent on the session's project and turn, writes the turn's request record, carries `based_on`
  and `supersedes`, and returns outputs with URLs and image blocks; a failed record is a tool error.
- A read answers with its report and writes nothing; without an attachment service a result has no images.
- `prepareToolCall` changes the inputs, tool-only arguments stay out of params, and a call behind an unfinished
  producer is scheduled.
- The tool call check adds its arguments to every tool schema, and a check that throws stops the call before any
  record.
- Held work delays a session's calls until it settles, even when it fails.
- Every operation tool stays registered, without the check's arguments, when the plugin that registered the tool call
  check unloads.

**`tests/proj-tools.spec.ts`**

- Every `dv_proj_*` tool is registered while the registry is mounted and removed with the service.
- Create and open bind the session; a bound session refuses another project; a call without a project fails.
- Each reducer's `agentSummary` fields sit between `records` and `stale`; a field used twice refuses the summary.
- `recent` lists summaries, failure messages, output URLs and pending statuses; history lists entries with marks.
- Accept, discard, undo, redo, stale accept, branch create and switch, and wait behave as their methods do.
- `parseInputs` for every reference form and every refusal.
- A binding survives a restart and a broken binding file throws; a run without an asset store fails.
