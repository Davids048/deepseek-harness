---
description: "The DreamVerse canvas: the records of a project drawn as story bible, asset, plan, and take nodes linked by asset flow, with a floating editor that renders a new take or replaces a reference image as a user record."
kind: "package-reference"
---

# @dv/ui-canvas

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a canvas over a DreamVerse project beside the chat. `CanvasView` draws the records of the project's current state as nodes on a surface that pans and zooms, linked by the assets that flowed between them, with stale records marked. Clicking a node opens a floating editor that renders a new take, replaces a reference image, or prefills the chat composer. The shell mounts `CanvasView` in its center; the `dv-canvas` right-Sidebar tab type shows the same canvas under the project bar.

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

The canvas shows the project's current state only, with no history view: characters, locations, and styles at their current version as `bible` nodes, images and videos on the canvas as `asset` nodes, each plan at its latest version as a `plan` node, and `shot.render_ref2va` and `shot.render_t2va` records as `take` nodes. The takes drawn are the current take of each shot of each plan's latest version (the take the shot's clip on the plan's timeline plays, else the newest done take of that shot and version or the earlier take the approval reused) with its retakes, every take that is not part of a plan, and every take whose outputs are in use (played by a timeline clip, a reference of a current story bible or plan version, or an input of a drawn take). Takes of removed shots and unused takes of earlier plan versions are left out, so an undo or a "go back" to an earlier step changes what the canvas shows. An image or video has one `asset` node only while its asset ID is on the canvas (the `asset` slice's `placed`), unless a `bible` node (a reference image of a character, location, or style) or a `take` node (a take output) already shows it; a take that reads an asset off the canvas has no edge from it, and its editor still lists the reference. An asset goes on the canvas when the user drops its file or its asset pool tile on the canvas, or sends it in a chat message as an attached image or a `dv:asset/<id>` chip (`@dv/chat-references` places those); the editor of an `asset` node takes it off with "Remove from canvas", and the asset stays in the asset pool. Each of these is a step of the history, so History lists it and undo takes it back. A `bible` card shows the kind, the name, and the reference images of the current version as a row of small thumbnails (up to four, then "+N"), so a character, location, or style reads differently from an image; its reference images never get `asset` nodes of their own. The canvas follows the current state when it changes, and its edits become steps of the history at once.

```yaml
- id: dv-ui-canvas
  name: '@dv/ui-canvas'
```

The Host half registers nothing. The browser half registers the `dv-canvas` tab type (a page the Sidebar's guide offers as "Video canvas"), the `dvCanvas` locale namespace in Chinese and English, and the tab body under its own id `@dv/ui-canvas`.

| Gesture | Request |
| --- | --- |
| Edit a take's prompt, references, duration, or seed and press "Render new take" | `POST /api/dv/operation` with the take's own operation (`shot.render_ref2va` or `shot.render_t2va`), the edited inputs and params, `based_on` set to the shown take, `surface: 'canvas'` |
| Replace the reference image of a character, location, or style | `POST /api/dv/operation` with `bible.<kind>_update` and the image as input role `reference`; an imported file first runs `asset.import` |
| Drop image or video files on the canvas | `POST /api/dv/assets/import` with `surface=canvas`, whose `asset.import` also puts the asset on the canvas; the new node is placed under the pointer |
| Drop an asset pool tile on the canvas | a tile whose asset has a node moves that node under the pointer; any other image or video of the asset pool panel runs `POST /api/dv/operation` with `asset.place` and the asset as input role `asset`, and its new node is placed under the pointer |
| "Remove from canvas" in the editor of an `asset` node | `POST /api/dv/operation` with `asset.unplace` and the asset as input role `asset`; the asset stays in the asset pool |
| Ask the agent | the `dv:compose` window event, which prefills the chat composer with an `@` reference to the node |
| "Keep anyway" in the editor of a stale node | `POST /api/dv/stale/accept` for the node's record (`proj.stale_accept` as a step of the history) |
| Drag a node, pan, or zoom | `POST /api/dv/layout` with the moved positions, keyed by node ID, and the viewport |
| A node without a stored position appears | `POST /api/dv/layout` with its spot: its default layout position, moved down one row at a time until it covers no other card |

Every request carries `surface: 'canvas'` and the chat session the canvas sits beside, which the record stores as its `session`. A `dv:canvas-focus` window event with `{recordId}` centers and opens that record's node. When the record has no node of its own, the event opens the story bible node of the version it wrote, else the node of its first output.

The floating editor opens centered over the dimmed canvas, at most 720 px wide and about 80% of the canvas height. Drag its title row to move it; drag its right edge, bottom edge, or bottom-right corner to resize it, or focus the corner handle and press the arrow keys (16 px per press); a double click on the title row puts it back at the centered default. The browser keeps one last position and size for every node in `localStorage` and fits them into the canvas the next time the editor opens. A click on the dimmed canvas or Escape closes the editor.

Clicking a node selects it, which draws an accent ring, and opens its editor. Closing the editor keeps the ring, so the node stays easy to find; a click on empty canvas with no editor open clears it. After "Render new take" or a failed take's "Retry", the button reads "Rendering…" and is disabled until the new take's node appears; the editor then closes and the canvas centers and selects the new node, which shows "Rendering…" until the render ends. A request refused before that shows its error under the editor's button, or above the canvas for "Retry". A finished take that the user has not opened in this browser shows an accent dot beside its title until its editor opens. The browser keeps the opened takes per project in `localStorage`; a project opened for the first time in a browser starts with every finished take counted as opened.

The editor of a take shows its render mode, "From references" (`ref2va`) or "From text" (`t2va`); a `t2va` take has no reference chips. The editor of a plan node switches between the plan's versions. A version shows "Approved" once approved, "Awaiting approval" while it is the latest unapproved version, and "Replaced by v{n}" when a later version replaced it before approval. Each shot shows its render mode, followed by "Continues the previous shot" when `continue_previous` is set. A `ref2va` shot shows the reference images it renders from, in the order the video model numbers them, and its prompt shows each `Picture N` or `<Picture N>` token, brackets included, as the N-th of those images (`@dv/ui-kit/references.ts`); a `t2va` shot shows no reference images.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`CanvasView` reads the project's current state with `useProjectState` from `@dv/ui-kit/useProject.ts`; `buildCanvasGraph` turns it into nodes, edges, and a default column layout: story bible items and assets first, plans next, takes by first-frame depth, retakes beside their source take. A bible node's ID is `bible:<id>`; an `asset` node's ID is the current-state `asset.import` record that output the asset, else `asset:<AssetId>` with no record (an import that an undo went back past, a still, an export); every other node's ID is its record ID. Stored positions from `/api/dv/layout` override the default layout; a failed layout read or write is ignored. Requests carry inputs as reference text (`<asset>`, `<record>#<output>`, `<id>@<version>`), which `referenceText` writes from a record's stored input references. The state refetches on every `/dv/events` frame, so an asset a chat message places appears without a reload; a placement this view sent shows at once and stays until the state shows it, and a refused placement is put back.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | Registrations |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/CanvasBody.tsx`](src/client/CanvasBody.tsx) | The tab body: the project bar above a `CanvasView` |
| [`src/client/CanvasView.tsx`](src/client/CanvasView.tsx) | The surface: pan, zoom, drag, drop, layout storage |
| [`src/client/graph.ts`](src/client/graph.ts) | Nodes, edges, and the default layout |
| [`src/client/NodeCard.tsx`](src/client/NodeCard.tsx), [`src/client/NodeEditor.tsx`](src/client/NodeEditor.tsx) | The node card and the floating editor |
| [`src/client/locales.ts`](src/client/locales.ts) | The `dvCanvas` dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/api`](../api/README.md) — the routes behind every gesture.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, and the hooks.
- [DreamVerse packages](../../../docs/subsystems/video-harness.md) — staleness, takes, and the history rules as the canvas shows them.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dv/project`; the records its gestures write reach the model only through the `dv:project` prompt section and the `dv_proj_*` and operation tools of [`@dv/project`](../project/README.md).

#### KV Cache effect

None; the canvas sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No new nodes from the canvas** — the editor renders new takes of existing records and replaces reference images; starting a plan or a character is left to the chat.
- **Whole-graph rebuild** — every project event refetches the state and rebuilds the graph; a long project redraws slowly.
