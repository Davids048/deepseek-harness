---
description: "The DreamVerse asset pool panel: the project's characters, reference images, renders, exports, and imports in a right-Sidebar tab, with import, drag into the canvas or the timeline, and preview."
kind: "package-reference"
---

# @dv/ui-asset-pool

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a 素材库 / Asset pool panel beside the chat. `AssetsPanel` lists the open project's characters, reference images, renders, and exports, including assets that only an unaccepted draft has, marked 草稿 / Draft. You can import images and videos by dropping them on the panel, drag a thumbnail into the canvas or the timeline, and open a preview that inserts a video as a clip or asks the agent to use the asset. The `dv-asset-pool` right-Sidebar tab type shows the panel of the project the shell has open.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that stacks `dsh-web-app` (which provides the right Sidebar and the client module loader) and `@dv/api` (which serves the routes the panel calls). Build the browser bundle first: `pnpm run build` writes `lib/client.js`.

```yaml
- id: dv-ui-asset-pool
  name: '@dv/ui-asset-pool'
```

The Host half registers nothing. The browser half registers the `dv-asset-pool` tab type (a page the Sidebar's guide offers as "Asset pool") and the tab body under its own id `@dv/ui-asset-pool`. The tab stays mounted while another tab is in front.

| Gesture | Request or event |
| --- | --- |
| Open the panel, any project change | `GET /api/dv/state` for `main` and for each open draft branch, refetched on every `/dv/events` event |
| Drop images or videos on the drop zone, or click it to choose files | `POST /api/dv/assets/import` once per file with `surface=asset_pool` and the tab's chat session; the `asset.import` record goes to that session's working branch |
| Drag a thumbnail | a drag that carries the asset ID as `application/x-dv-asset`; the canvas moves the asset's node to the drop point, the timeline inserts a clip at the drop position |
| 插入片段 / Insert clip in the preview of a video | `dv:timeline-insert` `{assetId}`; the shell appends the clip to the timeline selected in the editor (else the first timeline, else a new timeline `t1`) and shows the timeline |
| 让智能体使用 / Ask the agent to use it in the preview | `dv:compose` with the text 使用这个素材： / "Use this asset: " and the asset as an `@` reference; the composer fills its draft and sends nothing |

Thumbnails and the preview load the asset files from `GET /dv/assets/<AssetId>`.

The sections list, newest first: 角色 / Characters, the reference images of each character's latest version; 参考图 / Reference images, imported files and the reference images of locations and styles; 渲染结果 / Rendered, the videos of `shot.render` records; and 导出 / Exports, the videos of `deliver.timeline_export` records. The filters 全部 / All, 导入 / Imported, and 渲染结果 / Rendered show the four sections, the `asset.import` outputs alone, or the renders alone. The preview shows the size, duration, and file size, with the actions 插入片段 / Insert clip (videos only), 让智能体使用 / Ask the agent to use it, and 关闭 / Close.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`assetLibrary` merges the open drafts into the state of `main`: records and assets that `main` lacks, and a character, location, or style whose draft has more versions. A record counts only when its status is `done`. An imported asset shows the name and time of this project's `asset.import` record, because the asset pool keeps the name and time of the first import of identical bytes in any project. The 参考图 section leaves out the reference images of characters and the renders. An asset counts as a draft when the state of `main` does not list it. The panel refetches the draft states whenever the state of `main` reloads, and leaves out a draft whose fetch fails. The preview reads the width and height from the loaded media when the asset has none (imported files), and renders on `document.body` so the right Sidebar cannot cover its buttons; Escape or a click outside closes it.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The Host half, which registers nothing |
| [`src/client/index.ts`](src/client/index.ts) | Registrations of the tab type and the tab body |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/AssetsPanel.tsx`](src/client/AssetsPanel.tsx) | The panel, its filters, the drop zone, the thumbnail grid, the preview, and the tab body |
| [`src/client/library.ts`](src/client/library.ts) | Sorting of the assets of `main` and the open drafts into sections, filters, and draft flags |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/api`](../api/README.md) — the state route and the asset import route.
- [`@dv/asset-pool`](../asset-pool/README.md) — the asset pool that stores the files and serves them.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, the window events, and the compose event.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the browser-side asset pool panel; the `asset.import` records its imports write reach the model only through the agent integration (`@dv/agent-integration`).

#### KV Cache effect

None; the panel sends nothing to a model. 让智能体使用 / Ask the agent to use it only fills the composer, and the user decides whether to send it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Drafts of every chat session** — the panel lists the assets of every open draft of the project, including drafts of other chat sessions, with the same 草稿 / Draft badge.
- **One state fetch per open draft** — every project change refetches the state of `main` and of each open draft; a project with many open drafts reloads slowly.
