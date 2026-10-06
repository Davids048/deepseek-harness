---
description: "Browser API of the video harness: authenticated routes that read branch state, run operations from the canvas and the timeline as human records, accept or discard drafts, undo and redo, branch, keep stale records, and stream project changes."
kind: "package-reference"
---

# @video-harness/views

English | [中文](README.zh.md)

## Summary

Use this package to let browser views read and change a video project through HTTP instead of through the agent. `vhViews` registers authenticated Fetch routes under `/api/vh/` that list projects, read the state of a branch as JSON, list the tool declarations, run an operation as the human, accept or discard a chat session's draft, undo and redo, start and switch branches, keep a stale record, and record what a view selected. A raw `GET /vh/events` route streams every project change as server-sent events, admitted through the same Connection cookie. `@video-harness/ui-canvas` and `@video-harness/ui-timeline` are its consumers.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@video-harness/assets`, `@dv/project`, and `@video-harness/tools`, in a profile that also mounts `dsh-web-app` (for the `connection` and `webServer` services). Without `connection` the Fetch routes stay unregistered; without `webServer` the event stream does.

```yaml
- id: vh-views
  name: '@video-harness/views'
  config:
    keepaliveMs: 15000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `keepaliveMs` | `15000` | How often an idle event stream sends a comment line so proxies keep the connection open |

| Route | Method | Request | Response |
| --- | --- | --- | --- |
| `/api/vh/projects` | GET | optional `session` (a chat session ID) | Every project, newest first, with its branch heads; with `session`, the project that session is bound to comes first with `current: true` |
| `/api/vh/projects` | POST | `{title, surface}` | A project started from a view: `{projectId, title}` |
| `/api/vh/state` | GET | `project`, optional `head` (branch name; default `main`) | The state of the branch: project, head, heads, branches with draft counts, records, mentioned assets, characters, locations and styles, timelines, stale and superseded records, takes, plans, producers |
| `/api/vh/tools` | GET | — | Every registered tool declaration without its executor |
| `/api/vh/invoke` | POST | `{project, tool, inputs?, params?, intent?, surface, session?, base_op?, supersedes?}` | The record; `surface` is `canvas` or `timeline` |
| `/api/vh/drafts/accept` | POST | `{project, session \| branch, surface}` | The `proj.draft_accept` record and the heads afterwards |
| `/api/vh/drafts/discard` | POST | `{project, session \| branch, surface, counts?}` | Without `counts`: `{draft, counts}`; with the confirmed counts: the discarded counts and the heads afterwards |
| `/api/vh/undo` | POST | `{project, session?, surface}` | The `proj.undo` record and the heads afterwards |
| `/api/vh/redo` | POST | `{project, session?, surface}` | The `proj.redo` record and the heads afterwards |
| `/api/vh/branch` | POST | `{project, name, at, session?, surface}` | The branch `explore/<name>` and the heads afterwards |
| `/api/vh/branch/switch` | POST | `{project, branch, session, surface}` | The branch the session works on and the heads afterwards |
| `/api/vh/stale/accept` | POST | `{project, record, session?, surface}` | The `proj.stale_accept` record and the heads afterwards |
| `/api/vh/selection` | POST | `{project, kind: op \| clip \| asset \| entity, id, slot?, surface}` | `{ok: true}` |
| `/vh/events?project=<id>` | GET | — | `text/event-stream` with `record`, `update`, and `branch` events, each carrying one `ProjectEvent` |

An invoke runs the operation through `dvProject.run` as the human, on the working branch of the request's chat session (`main` without one), or schedules it when an input names a record that has not finished. A malformed body answers `400`, an unknown project, record, or tool `404`, and a refused change (such as discarding a draft whose counts changed) `409`; every error body is `{error, code?}`, where `code` is the `ProjectError` code. The host reads the last selection of a project through `vhViews.selection(projectId)` so an agent prompt can mention what the user pointed at.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`VhViews` builds one `ViewsApi` over `dvProject`, `vhAssets`, and `vhTools`. Inside `ctx.inject(['connection'])` it registers the Fetch routes with `connection.fetch.register`, each answering through one `answer` wrapper that maps `ViewsRequestError` to its status. Inside `ctx.inject(['webServer'])` it registers the `/vh/events` prefix route, asks the Connection whether the request carries a valid cookie through `requestRejection`, and hands the response to `serveEventStream`, which subscribes to `dvProject.subscribe(projectId)` and writes one `event:`/`data:` frame per change until the request closes. `toWireState` turns a `ProjectState` into JSON: branded IDs stay strings, and the asset list is the union of every record's outputs and resolved inputs and the reference images of every character, location, and style version.

| File | Content |
| --- | --- |
| [`src/wire.ts`](src/wire.ts) | `WireState`, `WireToolSpec`, `ViewSelection`, `toWireState`, `mentionedAssets`, `projectIdOf` |
| [`src/api.ts`](src/api.ts) | `ViewsApi` and `ViewsRequestError`: validation and the `dvProject` calls behind each route |
| [`src/events.ts`](src/events.ts) | `frameOf` and `serveEventStream` |
| [`src/index.ts`](src/index.ts) | `VhViews`, `ROUTES`, `EVENTS_PATH` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Video harness subsystem](../../../docs/subsystems/video-harness.md) — the record, drafts, staleness, and the rules every view follows.
- [`@dv/project`](../../dv/project/README.md) — records, drafts, branches, undo, and stale marks behind the routes.
- [`@video-harness/ui-canvas`](../ui-canvas/README.md) and [`@video-harness/ui-timeline`](../ui-timeline/README.md) — the two browser consumers.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the routes record view gestures as user records; the agent layer decides what the model learns about them.

#### KV Cache effect

None; the routes send nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Selection is in memory** — the last selection per project is lost on restart and is not a record.
- **Whole-state reads** — every change makes a view refetch the complete folded state; there is no incremental state route.
- **Event stream is unauthenticated when `connection` is absent** — the route then admits every request; the profile is expected to mount `dsh-web-app`.
