---
description: "The DreamVerse canvas: the records of a project drawn as story bible, asset, plan, and take nodes linked by asset flow, with a floating editor that renders a new take or replaces a reference image as a user record."
kind: "package-reference"
---

# @dv/ui-canvas

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a canvas over a DreamVerse project beside the chat. `CanvasView` draws the records of the shown branch on a surface that pans and zooms: characters, locations, and styles as `bible` nodes, imported images and videos as `asset` nodes, plans as `plan` nodes, and every `shot.render` record as a `take` node, linked by the assets that flowed between them. The open draft of the chat session beside the canvas is overlaid with dashed nodes; the working-branch bar on top names the branch the canvas's edits go to and accepts or discards the draft; stale records are marked. Clicking a node opens a floating editor that renders a new take, replaces a reference image, or prefills the chat composer. The shell mounts `CanvasView` in its center; the `dv-canvas` right-Sidebar tab type shows the same canvas under a branch bar.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that stacks `dsh-web-app` (which provides the right Sidebar, the locale service, and the client module loader) and `@dv/api` (which serves the routes the canvas calls). Build the browser bundle first: `pnpm run build` writes `lib/client.js`.

```yaml
- id: dv-ui-canvas
  name: '@dv/ui-canvas'
```

The Host half registers nothing. The browser half registers the `dv-canvas` tab type (a page the Sidebar's guide offers as "Video canvas"), the `dvCanvas` locale namespace in Chinese and English, and the tab body under its own id `@dv/ui-canvas`.

| Gesture | Request |
| --- | --- |
| Edit a take's prompt, references, duration, or seed and press "Render new take" | `POST /api/dv/operation` with `shot.render`, the edited inputs and params, `based_on` set to the shown take, `surface: 'canvas'` |
| Replace the reference image of a character, location, or style | `POST /api/dv/operation` with `bible.<kind>_update` and the image as input role `reference`; an imported file first runs `asset.import` |
| Drop image or video files on the canvas | `POST /api/dv/assets/import`; the new node is placed under the pointer |
| Ask the agent | the `dv:compose` window event, which prefills the chat composer with an `@` reference to the node |
| Accept or discard the draft | `POST /api/dv/drafts/accept` or `/api/dv/drafts/discard` for the chat session's draft; discard first asks in the confirmation dialog of `@dv/ui-kit/DiscardDraftDialog.tsx` |
| "Keep anyway" in the editor of a stale node | `POST /api/dv/stale/accept` for the node's record (`proj.stale_accept` on the working branch) |
| Click a node | `POST /api/dv/selection` with kind `record`, `character`, `location`, or `style`, so the host can tell the agent what the user pointed at |
| Drag a node, pan, or zoom | `POST /api/dv/layout` with the moved positions, keyed by node ID, and the viewport |

While a `draft/*` branch is shown the editor's write buttons are disabled; accept or discard the draft, or switch to another branch, to write. A `dv:canvas-focus` window event with `{recordId}` centers and opens that record's node. When the record has no node of its own, the event opens the story bible node of the version it wrote, else the node of its first output.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`CanvasView` reads the branch state with `useProjectState` from `@dv/ui-kit/useProject.ts`, and the state of the beside session's open draft when there is one. `overlayDraft` merges the draft's records, assets, and story bible versions into the base state, and `buildCanvasGraph` turns the merged state into nodes, edges, and a default column layout: story bible items and assets first, plans next, takes by first-frame depth, retakes beside their source take. A bible node's ID is `bible:<id>`; every other node's ID is its record ID. Stored positions from `/api/dv/layout` override the default layout; a failed layout read or write is ignored. Requests carry inputs as reference text (`<asset>`, `<record>#<output>`, `<id>@<version>`), which `referenceText` writes from a record's stored input references. The state refetches on every `/dv/events` frame.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | Registrations |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/CanvasBody.tsx`](src/client/CanvasBody.tsx) | The tab body: the branch bar above a `CanvasView` |
| [`src/client/CanvasView.tsx`](src/client/CanvasView.tsx) | The surface: pan, zoom, drag, drop, layout storage, the working-branch bar |
| [`src/client/graph.ts`](src/client/graph.ts) | Nodes, edges, draft overlay, and the default layout |
| [`src/client/NodeCard.tsx`](src/client/NodeCard.tsx), [`src/client/NodeEditor.tsx`](src/client/NodeEditor.tsx) | The node card and the floating editor |
| [`src/client/locales.ts`](src/client/locales.ts) | The `dvCanvas` dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/api`](../api/README.md) — the routes behind every gesture.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, and the hooks.
- [DreamVerse packages](../../../docs/subsystems/video-harness.md) — drafts, staleness, takes, and branches as the canvas shows them.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through browser-side canvas; the records its gestures write reach the model only through the agent integration (`@dv/agent-integration`).

#### KV Cache effect

None; the canvas sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No new nodes from the canvas** — the editor renders new takes of existing records and replaces reference images; starting a plan or a character is left to the chat.
- **Whole-graph rebuild** — every project event refetches the state and rebuilds the graph; a long project redraws slowly.
