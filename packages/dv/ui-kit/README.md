---
description: "Browser code the DreamVerse views share: the /api/dv client, the wire types, the parameter form model, the track geometry, the window events, the view session hooks, and the project bar."
kind: "package-reference"
---

# @dv/ui-kit

English | [中文](README.zh.md)

## Summary

Use this package from a DreamVerse browser plugin to talk to `@dv/api` and to read the state it sends. `DvClient` wraps every `/api/dv` route and follows `/dv/events`; `fieldsOf` and `paramsOf` turn an operation's parameter schema into form fields and back; `useViewSession` keeps a view's project, the project's current state, and the operations in step with the host; `ProjectBar` is the project and undo bar of the Sidebar views; the event modules own the `dv:*` window events and page globals the panels exchange. The package is a library: it registers nothing and is bundled into each consumer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Add `@dv/ui-kit` to a browser plugin's `devDependencies` and import one module at a time; the package's `./*` export maps to `src/client/*`, and the DSH client bundle inlines what it imports. There is no Loader row.

```ts
import { DvClient } from '@dv/ui-kit/api.ts'
import { useViewSession } from '@dv/ui-kit/useView.ts'
import { DV_TIMELINE_INSERT_EVENT } from '@dv/ui-kit/workspace-events.ts'
```

| Module | Content |
| --- | --- |
| `types.ts` | `WireState`, `ProjectRecord`, `Asset`, `Timeline`, `Clip`, `WireOperation`, `WireProject`, `ProjectEvent`, `OperationRequest`, `HistoryQuery`, `HistoryEntry`, `WireHistory`, `PlanVersion`, `Shot` (with its render `mode`, `ref2va` or `t2va`, and `continue_previous`): the JSON `@dv/api` sends and receives, as structural types |
| `api.ts` | `DvClient` (`listProjects`, `getState` (the current state), `listOperations`, `runOperation`, `importAsset`, `undo` (one step, or with `to` back to a record), `acceptStale`, `listHistory`, `placeOnCanvas` (`asset.place` or `asset.unplace` on the canvas surface), project, layout (positions and viewport), workspace, and session calls, `subscribe`), `ViewSurface`, `DvApiError`, `assetUrl` |
| `form.ts` | `fieldsOf(params, values)`, `paramsOf(fields)`, `FieldParseError`: one control per schema property, typed coercion |
| `timeline.ts` | `FALLBACK_CLIP_SECONDS`, `timelineName(timeline, numbered)`, `formatSeconds` |
| `references.ts` | `shotReferences(version, shot)`, `referenceImages(state, references)`, `pictureParts(prompt)`: the reference images a shot sends to the video model in the order its prompt names them `Picture 1`, `Picture 2`, …, and the prompt split at those tokens; a `t2va` shot has no reference images |
| `state.ts` | `assetIndex`, `videoAssets` |
| `useProject.ts` | `useProjects`, `useOperations`, `useProjectState`: loaders that refetch on every project event |
| `useView.ts` | `useViewSession(client, surface, session?)`: the project choice, the project's current state, the operations, the last failure, and the project-bar callbacks; `sessionFromLocation` reads the chat session from the page's `?session=` so the view opens on that session's project |
| `ProjectBar.tsx` | The Sidebar bar (test ID `dv-kit-project-bar`): the project picker, a new-project button, and undo; its copy arrives as `labels`, already localized by the owning plugin |
| `compose.ts`, `workspace-events.ts` | The window events `dv:compose`, `dv:timeline-insert`, `dv:canvas-focus`, `dv:history-focus`, `dv:trajectory-focus`, `dv:timeline-focus` (`DV_*_EVENT`) and the asset drag type `application/x-dv-asset` |
| `tool-labels.ts` | `DV_TOOL_LABELS`: the zh and en label of every `dv_*` tool, shown by the composer's tool cards and the History panel |
| `current-project.ts`, `current-timeline.ts` | The open project and the selected timeline, kept on `window.__dvCurrentProject` and `window.__dvCurrentTimeline` and announced with `dv:current-project` and `dv:current-timeline` |
| `locale.ts` | `useText`, `pickText`: the Chinese or English string of a pair, following `<html lang>` |

`subscribe` uses `EventSource` when the browser has it and polls every three seconds otherwise. Every bundle that follows a project shares one stream per project through `window.__dvEventSources`; `window.__dvStreams` counts the open streams.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`DvClient` decodes every error body into a `DvApiError` that keeps the HTTP status and the `ProjectError` code. `useLoader` keeps the last value while a reload is in flight and ignores a response whose inputs changed; `useProjectState` reads the project's current state and folds several project events of one burst into one refetch, so an undo made anywhere refreshes every view. The types in `types.ts` copy the `@dv/project` and component types by hand because host packages cannot be imported into a browser bundle; a record arrives as `ProjectRecord` with its inputs' `ref` as the stored object.

| File | Content |
| --- | --- |
| [`src/client/api.ts`](src/client/api.ts) | The client and the shared event streams |
| [`src/client/form.ts`](src/client/form.ts) | The form model |
| [`src/client/timeline.ts`](src/client/timeline.ts) | Timeline helpers |
| [`src/client/references.ts`](src/client/references.ts) | Shot reference images and `Picture N` tokens |
| [`src/client/useProject.ts`](src/client/useProject.ts), [`src/client/useView.ts`](src/client/useView.ts) | The hooks |
| [`src/client/ProjectBar.tsx`](src/client/ProjectBar.tsx) | The shared bar |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/api`](../api/README.md) — the routes and the JSON this client reads.
- [`@dv/ui-canvas`](../ui-canvas/README.md) and [`@dv/ui-timeline`](../ui-timeline/README.md) — the two views that use the hooks and the bar.
- [DreamVerse packages](../../../docs/subsystems/video-harness.md) — what a record, the history rules, and a stale mark mean.

-----

<a id="model-experience"></a>
## Model Experience

None, as browser-side client, form, and track helpers; they touch no prompt, schema, or tool result.

#### KV Cache effect

None; the kit sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Hand-copied wire types** — `types.ts` restates the host's types; a field added on the host side must be added here by hand.
- **Flat forms** — the form model renders nested objects and arrays as one JSON text field.
- **Polling fallback** — without `EventSource` a view polls every three seconds and cannot tell what changed.
