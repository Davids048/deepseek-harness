---
description: "The DreamVerse canvas: the records of a project drawn as story bible, asset, plan, and take nodes linked by asset flow, with a floating editor that renders a new take or replaces a reference image as a user record."
kind: "package-reference"
---

# @dv/ui-canvas

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a canvas over a DreamVerse project beside the chat. `CanvasView` draws the records of the shown branch as nodes on a surface that pans and zooms, linked by the assets that flowed between them, with the chat session's open draft overlaid as dashed nodes and stale records marked. Clicking a node opens a floating editor that renders a new take, replaces a reference image, or prefills the chat composer. The shell mounts `CanvasView` in its center; the `dv-canvas` right-Sidebar tab type shows the same canvas under a branch bar.

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

The canvas shows the current state of the working branch only, with no history view: characters, locations, and styles at their current version as `bible` nodes, imported images and videos on the project's canvas list as `asset` nodes, each plan at its latest version as a `plan` node, and `shot.render_ref2va` and `shot.render_t2va` records as `take` nodes. The takes drawn are the current take of each shot of each plan's latest version (the take the shot's clip on the plan's timeline plays, else the newest done take of that shot and version or the earlier take the approval reused) with its retakes, every take that is not part of a plan, and every take whose outputs are in use (played by a timeline clip, a reference of a current story bible or plan version, or an input of a drawn take). Takes of removed shots and unused takes of earlier plan versions are left out, so an undo or a jump to an earlier step changes what the canvas shows. An imported image or video has one `asset` node only while its asset ID is on the project's canvas list (the layout's `placed`), unless it is a reference image of a character, location, or style, which that `bible` node shows; a take that reads an asset off the list has no edge from it, and its editor still lists the reference. An asset joins the list when the user drops its file or its asset pool tile on the canvas, or sends it in a chat message as an attached image or a `dv:asset/<id>` chip (`@dv/ui-composer` writes those); the editor of an `asset` node takes it off the list with "Remove from canvas", and the asset stays in the asset pool. A `bible` card shows the kind, the name, and the reference images of the current version as a row of small thumbnails (up to four, then "+N"), so a character, location, or style reads differently from an image; its reference images never get `asset` nodes of their own. The working-branch bar on top names the branch the canvas's edits go to, shows the `intent` of the draft's latest record that has one, and accepts or discards the draft.

```yaml
- id: dv-ui-canvas
  name: '@dv/ui-canvas'
```

The Host half registers nothing. The browser half registers the `dv-canvas` tab type (a page the Sidebar's guide offers as "Video canvas"), the `dvCanvas` locale namespace in Chinese and English, and the tab body under its own id `@dv/ui-canvas`.

| Gesture | Request |
| --- | --- |
| Edit a take's prompt, references, duration, or seed and press "Render new take" | `POST /api/dv/operation` with the take's own operation (`shot.render_ref2va` or `shot.render_t2va`), the edited inputs and params, `based_on` set to the shown take, `surface: 'canvas'` |
| Replace the reference image of a character, location, or style | `POST /api/dv/operation` with `bible.<kind>_update` and the image as input role `reference`; an imported file first runs `asset.import` |
| Drop image or video files on the canvas | `POST /api/dv/assets/import`, then `POST /api/dv/layout` with the new asset in `placed`; the new node is placed under the pointer |
| Drop an asset pool tile on the canvas | `POST /api/dv/layout` with the asset in `placed` when the asset has no node yet; its node is placed under the pointer |
| "Remove from canvas" in the editor of an `asset` node | `POST /api/dv/layout` with the asset in `removed`; the asset stays in the asset pool |
| Ask the agent | the `dv:compose` window event, which prefills the chat composer with an `@` reference to the node |
| Accept or discard the draft | `POST /api/dv/drafts/accept` or `/api/dv/drafts/discard` for the chat session's draft; discard first asks in the confirmation dialog of `@dv/ui-kit/DiscardDraftDialog.tsx` |
| "Keep anyway" in the editor of a stale node | `POST /api/dv/stale/accept` for the node's record (`proj.stale_accept` on the working branch) |
| Drag a node, pan, or zoom | `POST /api/dv/layout` with the moved positions, keyed by node ID, and the viewport |

While a `draft/*` branch is shown the editor's write buttons are disabled; accept or discard the draft, or show another branch, to write. A `dv:canvas-focus` window event with `{recordId}` centers and opens that record's node. When the record has no node of its own, the event opens the story bible node of the version it wrote, else the node of its first output.

The editor of a take shows its render mode, "From references" (`ref2va`) or "From text" (`t2va`); a `t2va` take has no reference chips. The editor of a plan node switches between the plan's versions. A version shows "Approved" once approved, "Awaiting approval" while it is the latest unapproved version, and "Replaced by v{n}" when a later version replaced it before approval. Each shot shows its render mode, followed by "Continues the previous shot" when `continue_previous` is set. A `ref2va` shot shows the reference images it renders from, in the order the video model numbers them, and its prompt shows each `Picture N` token as the N-th of those images (`@dv/ui-kit/references.ts`); a `t2va` shot shows no reference images.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`CanvasView` reads the branch state with `useProjectState` from `@dv/ui-kit/useProject.ts`, and the state of the beside session's open draft when there is one. `overlayDraft` takes the draft's state as the working branch and adds only the records the base branch received after the draft forked, so a record undone on the draft does not come back; then `buildCanvasGraph` turns the merged state into nodes, edges, and a default column layout: story bible items and assets first, plans next, takes by first-frame depth, retakes beside their source take. A bible node's ID is `bible:<id>`; every other node's ID is its record ID. Stored positions from `/api/dv/layout` override the default layout; a failed layout read or write is ignored. Requests carry inputs as reference text (`<asset>`, `<record>#<output>`, `<id>@<version>`), which `referenceText` writes from a record's stored input references. The state and the canvas list refetch on every `/dv/events` frame, so an asset the chat composer places appears without a reload.

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

Indirectly, through `@dv/project`; the records its gestures write reach the model only through the `dv:project` prompt section and the `dv_proj_*` and operation tools of [`@dv/project`](../project/README.md).

#### KV Cache effect

None; the canvas sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No new nodes from the canvas** — the editor renders new takes of existing records and replaces reference images; starting a plan or a character is left to the chat.
- **Whole-graph rebuild** — every project event refetches the state and rebuilds the graph; a long project redraws slowly.
