---
description: "Browser API of the video harness: authenticated routes that read folded project state, invoke tools from the canvas and the timeline as user records, accept or reject drafts, undo, branch, and stream operation log changes."
kind: "package-reference"
---

# @video-harness/views

English | [中文](README.zh.md)

## Summary

Use this package to let browser views read and change a video project through HTTP instead of through the agent. `vhViews` registers authenticated Fetch routes under `/api/vh/` that list projects, fold a head into one JSON state, list the tool declarations, run a tool as a user turn, accept or reject an agent draft, undo, start a branch, and record what a view selected. A raw `GET /vh/events` route streams every operation log change as server-sent events, admitted through the same Connection cookie. `@video-harness/ui-canvas` and `@video-harness/ui-timeline` are its consumers.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@video-harness/assets`, `@video-harness/oplog`, `@video-harness/runtime`, and `@video-harness/tools`, in a profile that also mounts `dsh-web-app` (for the `connection` and `webServer` services). Without `connection` the Fetch routes stay unregistered; without `webServer` the event stream does.

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
| `/api/vh/state` | GET | `project`, optional `head` (branch or record; default `main`) | The folded state: project, head, heads, records, mentioned assets, entities, sequence, stale and superseded records, turns, takes, plans, producers |
| `/api/vh/tools` | GET | — | Every registered tool declaration without its executor |
| `/api/vh/invoke` | POST | `{project, tool, inputs?, params?, intent?, surface, branch?, base_op?, supersedes?}` | The record; `surface` is `canvas` or `timeline` |
| `/api/vh/turn` | POST | `{project, turn, action: accept \| reject, surface}` | The heads afterwards |
| `/api/vh/undo` | POST | `{project}` | The undone turn and the heads afterwards |
| `/api/vh/branch` | POST | `{project, name, at}` | The branch record and the heads afterwards |
| `/api/vh/selection` | POST | `{project, kind: op \| clip \| asset \| entity, id, slot?, surface}` | `{ok: true}` |
| `/vh/events?project=<id>` | GET | — | `text/event-stream` with `op` events (`{kind: append \| patch, op}`) and `head` events (`{kind: head, branch, to}`) |

An invoke opens a user turn with the given `surface` and `intent`, runs the tool (or schedules it when an input names a record that has not finished), and closes the turn. A malformed body answers `400`, an unknown project or tool `404`, a refused turn change (such as accepting a draft after `main` moved) `409`; every error body is `{error}`. The host reads the last selection of a project through `vhViews.selection(projectId)` so an agent prompt can mention what the user pointed at.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`VhViews` builds one `ViewsApi` over `vhProject`, `vhOpLog`, `vhAssets`, and `vhTools`. Inside `ctx.inject(['connection'])` it registers the eight Fetch routes with `connection.fetch.register`, each answering through one `answer` wrapper that maps `ViewsRequestError` to its status. Inside `ctx.inject(['webServer'])` it registers the `/vh/events` prefix route, asks the Connection whether the request carries a valid cookie through `requestRejection`, and hands the response to `serveEventStream`, which subscribes to `vhOpLog.subscribe(projectId)` and writes one `event:`/`data:` frame per change until the request closes. `toWireState` turns a `ProjectState` into JSON: `Set` becomes an array, branded ids stay strings, and the asset list is the union of the state's assets, every record's outputs and resolved inputs, and every entity version's references.

| File | Content |
| --- | --- |
| [`src/wire.ts`](src/wire.ts) | `WireState`, `WireToolSpec`, `ViewSelection`, `toWireState`, `mentionedAssets`, `projectIdOf` |
| [`src/api.ts`](src/api.ts) | `ViewsApi` and `ViewsRequestError`: validation and the runtime calls behind each route |
| [`src/events.ts`](src/events.ts) | `frameOf` and `serveEventStream` |
| [`src/index.ts`](src/index.ts) | `VhViews`, `ROUTES`, `EVENTS_PATH` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Video harness subsystem](../../../docs/subsystems/video-harness.md) — the record, drafts, staleness, and the rules every view follows.
- [`@video-harness/runtime`](../runtime/README.md) — `invoke`, `schedule`, turns, and branches behind the routes.
- [`@video-harness/ui-canvas`](../ui-canvas/README.md) and [`@video-harness/ui-timeline`](../ui-timeline/README.md) — the two browser consumers.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the routes record view gestures as user records; the agent layer decides what the model learns about them.

#### KV Cache effect

None; the routes send nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No project creation route** — a view can only show projects that the agent or a direct `vhProject.createProject` call created.
- **Selection is in memory** — the last selection per project is lost on restart and is not a record.
- **Whole-state reads** — every change makes a view refetch the complete folded state; there is no incremental state route.
- **Event stream is unauthenticated when `connection` is absent** — the route then admits every request; the profile is expected to mount `dsh-web-app`.
