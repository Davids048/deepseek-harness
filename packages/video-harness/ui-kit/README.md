---
description: "Browser code the video harness views share: the /api/vh client, the folded-state types, the operation DAG layout, the parameter form model, the track geometry, the view session hooks, and the branch bar."
kind: "package-reference"
---

# @video-harness/ui-kit

English | [中文](README.zh.md)

## Summary

Use this package from a video harness view plugin to talk to `@video-harness/views` and to turn its folded state into something drawable. `VhClient` wraps the `/api/vh` routes and follows `/vh/events`; `buildDag` and `layoutDag` turn the records into a layered graph; `fieldsOf` and `paramsOf` turn a tool's parameter schema into form fields and back; `placeClips` sizes the timeline's clips; `useViewSession` keeps a view's project, head, state, and tools in step with the host; `BranchBar` is the project, branch, draft, and undo bar both views show. The package is a library: it registers nothing and is bundled into each consumer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Add `@video-harness/ui-kit` to a browser plugin's `devDependencies` and import one module at a time; the package's `./*` export maps to `src/client/*`, and the DSH client bundle inlines what it imports. There is no Loader row.

```ts
import { VhClient } from '@video-harness/ui-kit/api.ts'
import { useViewSession } from '@video-harness/ui-kit/useView.ts'
import { buildDag, layoutDag } from '@video-harness/ui-kit/dag.ts'
```

| Module | Content |
| --- | --- |
| `types.ts` | `WireState`, `WireOp`, `WireAsset`, `WireToolSpec`, `WireProject`, `WireLogEvent`: the JSON `@video-harness/views` sends, as structural types |
| `api.ts` | `VhClient` (`projects`, `state`, `tools`, `invoke`, `turn`, `undo`, `branch`, `select`, `subscribe`), `VhApiError`, `assetUrl` |
| `dag.ts` | `buildDag(state, expandedPlans)` and `layoutDag(dag)`: records as nodes, asset flow as edges, plans collapsed, longest-path layers |
| `form.ts` | `fieldsOf(params, values)`, `paramsOf(fields)`, `FieldParseError`: one control per schema property, typed coercion |
| `timeline.ts` | `placeClips(state, pxPerSec)`, `clipSeconds`, `formatSeconds` |
| `state.ts` | `openDrafts`, `branchNames`, `assetIndex`, `videoAssets` |
| `useProject.ts` | `useProjects`, `useTools`, `useProjectState`: loaders that refetch on every log event |
| `useView.ts` | `useViewSession(client, surface, session?)`: project and head selection, the folded state, the tools, the last failure, and the branch-bar callbacks; `sessionFromLocation` reads the chat session from the page's `?session=` so the view opens on that session's project |
| `BranchBar.tsx` | The bar: project and branch pickers, a new-project and a new-branch button, undo, and one accept/reject chip per open draft; its copy arrives as `labels`, already localized by the owning plugin |

`subscribe` uses `EventSource` when the browser has it and polls every three seconds otherwise. A node of the graph is a record, an entity's current version, or a plan; `plan.create` and `plan.update` records hide the records their approval scheduled until the plan is expanded, and `intent`, `branch`, `approve`, and `reject` records and `plan.approve` calls are never drawn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`buildDag` first finds every plan's children (the records of the turns in which the plan was approved, other than the approval itself) and hides them unless the plan is expanded; it then adds one node per entity (its latest version) and per visible record, and one edge per input: an `entity@version` reference points from the entity node, an asset points from the record that produced it (looked up among visible records, then in the fold's `producers`, and redirected to the plan when the producer is hidden), and an expanded plan points at each child. `layoutDag` assigns each node the layer one more than the longest chain of edges into it, guarding against cycles, and stacks the nodes of a layer in input order. `useLoader` keeps the last value while a reload is in flight and ignores a response whose inputs changed; `useProjectState` folds several log events of one burst into one refetch. The types in `types.ts` mirror `@video-harness/views`'s wire module by hand because the host package cannot be imported into a browser bundle.

| File | Content |
| --- | --- |
| [`src/client/dag.ts`](src/client/dag.ts) | The graph and its layout |
| [`src/client/form.ts`](src/client/form.ts) | The form model |
| [`src/client/timeline.ts`](src/client/timeline.ts) | Track geometry |
| [`src/client/useProject.ts`](src/client/useProject.ts), [`src/client/useView.ts`](src/client/useView.ts) | The hooks |
| [`src/client/BranchBar.tsx`](src/client/BranchBar.tsx) | The shared bar |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@video-harness/views`](../views/README.md) — the routes and the JSON this client reads.
- [`@video-harness/ui-canvas`](../ui-canvas/README.md) and [`@video-harness/ui-timeline`](../ui-timeline/README.md) — the two consumers.
- [Video harness subsystem](../../../docs/subsystems/video-harness.md) — what a record, a draft, and a stale mark mean.

-----

<a id="model-experience"></a>
## Model Experience

None, as browser-side graph, form, and track helpers; they touch no prompt, schema, or tool result.

#### KV Cache effect

None; the kit sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Hand-copied wire types** — `types.ts` restates the host's wire module; a field added on the host side must be added here by hand.
- **Flat forms** — the form model renders nested objects and arrays as one JSON text field.
- **Simple layering** — nodes keep input order inside a layer; long edges may cross, and there is no edge routing.
- **Polling fallback** — without `EventSource` a view polls every three seconds and cannot tell what changed.
