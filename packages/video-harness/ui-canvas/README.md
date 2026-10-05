---
description: "The video harness canvas as a right-Sidebar tab: the operation records of a project drawn as a DAG of asset flow, with a parameter form that reruns or edits any record as a new user record."
kind: "package-reference"
---

# @video-harness/ui-canvas

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a canvas over a video project beside the chat. The `vh-canvas` tab type of the right Sidebar draws the records of the shown branch as a left-to-right graph: entities as sources, each tool call as a box, plans collapsed, retakes beside their base, drafts dashed, stale records marked. Clicking a box shows its facts and a form over its params; "Apply" writes the edited params as a superseding record, "Rerun" writes a new take. The bar switches project and branch, decides open drafts, undoes, and starts branches.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that stacks `dsh-web-app` (which provides the right Sidebar, the locale service, and the client module loader) and `@video-harness/views` (which serves the routes the canvas calls). Build the browser bundle first: `pnpm run build` writes `lib/client.js`.

```yaml
- id: vh-ui-canvas
  name: '@video-harness/ui-canvas'
```

The Host half registers nothing. The browser half registers the `vh-canvas` tab type (a page the Sidebar's guide offers as "Video canvas"), the `vhCanvas` locale namespace in Chinese and English, and the tab body under its own id. Open the tab from the guide page; the canvas picks the newest project and `main`.

| Gesture | Record |
| --- | --- |
| Edit params and press Apply | The same tool with the edited params, `base_op` and `supersedes` set to the shown record, `surface: 'canvas'` |
| Press Rerun | The same tool and params as a new take: `base_op` set, nothing superseded |
| Accept or reject a draft chip | `/api/vh/turn`, which fast-forwards `main` or leaves the draft in the log |
| Undo | `/api/vh/undo`, which moves `main` back one turn |
| New project | `POST /api/vh/projects` with the title asked for; the canvas then shows the new project on `main` |
| New branch | `/api/vh/branch` at the shown head; the canvas then shows the new branch |
| Click a node | `/api/vh/selection` with the record or entity id, so the host can tell the agent what the user pointed at |

While a `draft/*` branch is shown the form is disabled; accept or reject the draft, or switch to another branch, to write. A gesture on an exploration branch writes to that branch.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`CanvasBody` holds the view session from `@video-harness/ui-kit/useView.ts` (project, head, state, tools, last failure), the set of expanded plans, and the selected node id. `buildDag` and `layoutDag` from the kit turn the state into positioned nodes; `DagView` draws them as SVG with data attributes for status, staleness, draft, and supersession; `NodePanel` shows the selected node and mounts `ParamForm` with the tool's declaration from `/api/vh/tools`, keyed by record id so a new selection reseeds the fields. A write is one `client.invoke` call followed by a state refetch; failures appear above the graph. The state refetches on every `/vh/events` frame.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | Registrations |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/CanvasBody.tsx`](src/client/CanvasBody.tsx) | The body: session, graph, panel, writes |
| [`src/client/DagView.tsx`](src/client/DagView.tsx), [`src/client/dag-style.ts`](src/client/dag-style.ts) | The SVG graph and its colors |
| [`src/client/NodePanel.tsx`](src/client/NodePanel.tsx), [`src/client/ParamForm.tsx`](src/client/ParamForm.tsx) | The side panel and the form |
| [`src/client/locales.ts`](src/client/locales.ts) | The `vhCanvas` dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@video-harness/views`](../views/README.md) — the routes behind every gesture.
- [`@video-harness/ui-kit`](../ui-kit/README.md) — the graph layout, the form model, and the hooks.
- [Video harness subsystem](../../../docs/subsystems/video-harness.md) — drafts, staleness, takes, and branches as the canvas shows them.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through browser-side canvas; the records its gestures write reach the model only through the project prompt section of the agent layer.

#### KV Cache effect

None; the canvas sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No new nodes from the canvas** — the form edits or reruns an existing record; adding a tool call from scratch is left to the chat.
- **Whole-graph redraw** — every log event refetches the state and relays out the graph; a long project redraws slowly.
- **No pan or zoom** — the graph scrolls inside the tab; there is no zoom control.
- **Flat param forms** — arrays and objects are edited as JSON text.
