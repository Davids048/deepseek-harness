---
description: "Browser API of DreamVerse: authenticated routes that read branch state, run operations from the canvas, the timeline and the asset pool panel as human records, accept or discard drafts, undo and redo, branch, accept stale records, and stream project changes."
kind: "package-reference"
---

# @dv/api

English | [中文](README.zh.md)

## Summary

Use this package to let browser views read and change a DreamVerse project through HTTP instead of through the agent. `dvApi` registers authenticated Fetch routes under `/api/dv/` for projects, branch state, operations run as the human, asset imports, drafts, undo and redo, branches, stale records, history, canvas layouts, Workspace links, and view selections. A raw `GET /dv/events` route streams every project change as server-sent events. The `@dv/ui-*` packages are its consumers; the browser client is `DvClient` of `@dv/ui-kit`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project` and `@dv/asset-pool`, in a profile that also mounts `dsh-web-app` (for the `connection` and `webServer` services). Without `connection` the Fetch routes stay unregistered; without `webServer` the event stream does.

The Fetch routes list, create, rename and delete projects, read the state of a branch as JSON, list the operation declarations, run an operation as the human, import a file into the asset pool, accept or discard a chat session's draft, undo and redo, create and switch branches, accept a stale record, list the history, keep the canvas layout, link projects to DSH Workspaces, and remember what a view selected. The event stream admits a browser through the same Connection cookie.

```yaml
- id: dv-api
  name: '@dv/api'
  config:
    keepaliveMs: 15000
    stateRoot: /home/me/.local/state/dv
```

| Field | Default | Meaning |
| --- | --- | --- |
| `keepaliveMs` | `15000` | How often an idle event stream sends a comment line so proxies keep the connection open |
| `stateRoot` | required | The state directory: canvas layouts in `canvas-layout/`, project → Workspace links in `workspaces.json`, the entry Workspace in `entry/`, and the session binding files of `@dv/project` in `sessions/`; the bundle sets it from `DV_STATE_ROOT` |

| Route | Method | Request | Response |
| --- | --- | --- | --- |
| `/api/dv/projects` | GET | optional `session` (a chat session ID) | `WireProject[]` (`{id, title, created_at, heads, current}`), newest first; with `session`, the project that session is bound to comes first with `current: true` |
| `/api/dv/projects` | POST | `{title, surface}` | The project started from a view: `ProjectInfo` `{id, title, created_at}` |
| `/api/dv/projects/rename` | POST | `{project, title}` | `{title}`, made unique with ` 2`, ` 3`, … |
| `/api/dv/projects/delete` | POST | `{project}` | `{ok, workspace_id}`; the project moves into the Project store's trash and its canvas layout file is deleted |
| `/api/dv/state` | GET | `project`, optional `branch` (default `main`) | `WireState`: `{project, branch, head, heads, branches, components, redo_steps, assets}`, with every component slice as Project computed it, the steps that redo brings back on the branch, and the asset pool entry of every mentioned asset |
| `/api/dv/operations` | GET | — | `WireOperation[]`: every registered operation that is not `readOnly`, without its executor |
| `/api/dv/operation` | POST | `OperationRequest` `{project, operation, inputs?, params?, intent?, surface, session?, based_on?, supersedes?}`; `inputs` = `[{role, ref}]` with reference text | The `ProjectRecord`, finished or `pending` |
| `/api/dv/assets/import` | POST | raw file body; query `project`, `name`, `mime`, `surface` (`canvas \| asset_pool`, anything else answers `400` `invalid_params`), `session?` | `{asset, record}`: the `AssetId` and the `asset.import` record |
| `/api/dv/drafts/accept` | POST | `{project, session \| branch, surface}` | `{record, heads}` with the `proj.draft_accept` record |
| `/api/dv/drafts/discard` | POST | `{project, session \| branch, surface, counts?}` | Without `counts`: `{draft, counts}`; with the confirmed counts: `{draft, counts, heads}` |
| `/api/dv/undo` | POST | `{project, session?, surface, to?}`: one step back on the session's working branch, or back to the record `to` (a jump forward to a redo step writes `proj.redo`) | `{record, heads}` with the `proj.undo` record |
| `/api/dv/redo` | POST | `{project, session?, surface}`: one step forward on the session's working branch | `{record, heads}` with the `proj.redo` record |
| `/api/dv/branches/create` | POST | `{project, name, at, session?, surface}` | `{branch, heads}` for the branch `explore/<name>` |
| `/api/dv/branches/switch` | POST | `{project, branch, session, surface}` | `{branch, heads}` for the branch the session works on |
| `/api/dv/stale/accept` | POST | `{project, record, session?, surface}` | `{record, heads}` with the `proj.stale_accept` record |
| `/api/dv/history` | POST | `{project, branch?, marks?, actor?, component?, operation?, kind?, status?, session?, turn?, tool_call?, records?, before?, limit?}`; `marks` and `records` are arrays; `limit` is 1 to 200, default 50 | `WireHistory` `{entries, requests, assets}`: the `dvProject.listHistory` entries `{record, mark}` newest first, the `request` record of every turn they belong to (by turn), and every asset they name; a read that writes no record |
| `/api/dv/selection` | GET / POST | GET: `project`; POST: `{project, kind, id, surface}` with `kind` `record \| clip \| asset \| character \| location \| style` | `ViewSelection` `{kind, id, surface, at}` (GET: or null) |
| `/api/dv/layout` | GET / POST | GET: `project`; POST: `{project, positions?, viewport?}` | `{positions, viewport}`; POST merges positions keyed by canvas node ID |
| `/api/dv/workspaces` | GET / POST | POST: `{project, workspace_id}` | GET: `{entry_path, projects: [{id, title, created_at, path, workspace_id}], bindings}`; POST: `{ok}` |
| `/api/dv/workspaces/bind` | POST | `{session, project}` | `{ok}` |
| `/api/dv/workspaces/sessions` | GET | `project` | `[{session, updated_at, bytes}]`, newest first; `updated_at` is ISO-8601 UTC |
| `/dv/events?project=<id>` | GET | — | `text/event-stream`: `ready`, then `record`, `update`, and `branch` events, each carrying one `ProjectEvent` |

`surface` is `canvas`, `timeline`, `asset_pool` or `history`; anything else counts as `canvas`, except on the asset import, which takes `canvas` or `asset_pool` only. A run calls `dvProject.run` as the human, on the working branch of the request's chat session (`main` without one), or schedules the call when an input names a record that has not finished. Every error of every route, the event stream included, answers with the JSON body `{error, code, ...details}`: `error` is the message text and `code` is one of the codes below; `details` carries extra fields of a refusal, such as the current `counts` of a changed draft. The agent integration reads the last selection of a project through `dvApi.selection(projectId)`, so the agent's project block can name what the user pointed at.

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_params` | 400 | A malformed request: a missing or malformed field, query field, or file body |
| `invalid_inputs` | 400 | Operation `inputs` that the operation refuses: an unknown role, a list on a single role, a missing required role, or an unknown version; the message names the operation |
| `unknown_project` | 404 | The request names no existing project |
| `unknown_branch`, `unknown_record`, `unknown_asset`, `unknown_operation` | 404 | The `ProjectError` code of another unknown resource |
| `not_found` | 404 | An unknown resource without a `ProjectError` code; every resource this package reads has one |
| Another `ProjectError` code | 400 or 409 | Project refused the change, such as `draft_changed`, `no_open_draft`, or `nothing_to_undo` (409) |
| `internal_error` | 500 | An unexpected failure; `error` is the thrown error's text |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`DvApi` builds one `ApiHandlers` over `dvProject` and `dvAssetPool`; the operation list and a run's operation come from `dvProject.listOperations()`, a run's `inputs` are parsed by `dvProject.parseInputs`, and the workspace routes bind a chat session to a project with `dvProject.bindSession` and read the binding files (`{"project": <ProjectId>}`) back for the listing. Inside `ctx.inject(['connection'])` it registers the Fetch routes with `connection.fetch.register`, and every route, including the asset import, layout, workspace and project admin routes, answers through one `answer` wrapper in `src/api.ts` that maps an `ApiRequestError` or a `ProjectError` to its status and code and anything else to 500 `internal_error`; `requireProject` there checks the project every route names. `/dv/events` writes the same error body. Inside `ctx.inject(['webServer'])` it registers the `/dv/events` prefix route, asks the Connection whether the request carries a valid cookie through `requestRejection`, and hands the response to `serveEventStream`, which subscribes to `dvProject.subscribe(projectId)` and writes one `event:`/`data:` frame per change until the request closes. `toWireState` sends `ProjectState` with its `components` as they are and adds the heads, the branches, and the asset list: the union of the created assets, every record's outputs and resolved inputs, the reference images of every character, location, and style version, and every timeline clip.

| File | Content |
| --- | --- |
| [`src/wire.ts`](src/wire.ts) | `WireState`, `WireHistory`, `WireOperation`, `ViewSelection`, `toWireState`, `toWireOperation`, `mentionedAssets`, `projectIdOf` |
| [`src/api.ts`](src/api.ts) | `ApiHandlers`, `ApiRequestError`, `OperationRequest`, `WireProject`: validation and the `dvProject` calls behind each route; `answer`, `json` and `requireProject`, shared by every route |
| [`src/asset-import.ts`](src/asset-import.ts) | The asset import route |
| [`src/layout.ts`](src/layout.ts) | `CanvasLayoutStore` and the layout route |
| [`src/workspaces.ts`](src/workspaces.ts) | Project → Workspace links, session bindings, and a project's DSH sessions |
| [`src/projects-admin.ts`](src/projects-admin.ts) | Project rename and delete |
| [`src/events.ts`](src/events.ts) | `frameOf` and `serveEventStream` |
| [`src/index.ts`](src/index.ts) | `DvApi`, `Config`, `ROUTES`, `EVENTS_PATH` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse packages](../../../docs/subsystems/video-harness.md) — the record, drafts, staleness, and the rules every view follows.
- [`@dv/project`](../project/README.md) — records, drafts, branches, undo, and stale marks behind the routes.
- [`@dv/agent-integration`](../agent-integration/README.md) — reads the view selection for the agent's project block.
- [`@dv/ui-canvas`](../ui-canvas/README.md) and [`@dv/ui-timeline`](../ui-timeline/README.md) — two of the browser consumers.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the routes record view gestures as user records; the agent integration decides what the model learns about them.

#### KV Cache effect

None; the routes send nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Selection is in memory** — the last selection per project is lost on restart and is not a record.
- **Whole-state reads** — every change makes a view refetch the complete state; there is no incremental state route.
- **Event stream is unauthenticated when `connection` is absent** — the route then admits every request; the profile is expected to mount `dsh-web-app`.
