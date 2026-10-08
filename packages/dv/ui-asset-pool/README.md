---
description: "The DreamVerse asset pool panel: the project's images and videos in a right-Sidebar tab, with import, drag into the canvas or the timeline, and preview."
kind: "package-reference"
---

# @dv/ui-asset-pool

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a 素材库 / Asset pool panel beside the chat. `AssetsPanel` lists every image and video of the open project's current branch up to its head once, grouped into images, videos, and stills extracted from generation; its toggle 显示其他分支的素材 / Show assets from other branches adds the assets that only other branches or the current branch's redo steps hold, each marked with its branch. You can import images and videos by dropping them on the panel, drag a thumbnail into the canvas or the timeline, and open a preview that inserts a video as a clip or asks the agent to use the asset. The `dv-asset-pool` right-Sidebar tab type shows the panel of the project the shell has open.

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
| Open the panel, any project change | `GET /api/dv/state` for the project's current branch, refetched on every `/dv/events` event |
| 显示其他分支的素材 / Show assets from other branches (the label turns to 隐藏其他分支的素材 / Hide assets from other branches while it is on) | `POST /api/dv/history` with `marks: ['redo', 'branch']` and `limit: 200`, refetched whenever the state reloads while the toggle is on |
| Drop images or videos on the drop zone, or click it to choose files | `POST /api/dv/assets/import` once per image or video file with `surface=asset_pool` and the tab's chat session; the `asset.import` record goes to the project's current branch. The zone imports no other file and shows 「<name>」不是图片或视频，没有导入。 / "<name>" is not an image or a video, so it was not imported. for each one |
| Drag a thumbnail | a drag that carries the asset ID as `application/x-dv-asset`; the canvas moves the asset's node to the drop point, the timeline inserts a clip at the drop position |
| 插入片段 / Insert clip in the preview of a video | `dv:timeline-insert` `{assetId}`; the shell appends the clip to the timeline selected in the editor (else the first timeline, else a new timeline `t1`) and shows the timeline |
| 让智能体使用 / Ask the agent to use it in the preview | `dv:compose` with the text 使用这个素材： / "Use this asset: " and the asset as an `@` reference; the composer fills its draft and sends nothing |

Thumbnails and the preview load the asset files from `GET /dv/assets/<AssetId>`.

The panel lists every image and video that the state of the current branch lists in `assets` (imported files, renders and their stills, exports, and the reference images of characters, locations, and styles) once, in three sections, each newest first: 图片 / Images (`image/*`), 视频 / Videos (`video/*`), 从生成中截取的帧 / Extracted from generation (the images that a `shot.render_ref2va` or `shot.render_t2va` record outputs, such as the last still of a take). Assets of other media types are not listed. An image stays under 图片 / Images when a character, location, or style uses it, and a still of `asset.grab_still` is listed under 图片 / Images. A section without assets is hidden, and a project without assets shows 暂无 / None yet. With the toggle on, the panel also lists the images and videos that the records of other branches and of the current branch's redo steps output and that the current branch does not list, in the same sections; each carries a badge with the label of its branch (the branch's title, else 主线 / Main or 分支 n / Branch n), and drags, inserts, and previews like any other asset, so inserting one writes a normal `timeline.clip_insert` record on the current branch. The preview shows the size, duration, and file size, with the actions 插入片段 / Insert clip (videos only), 让智能体使用 / Ask the agent to use it, and 关闭 / Close.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`otherBranchAssets` reads the history entries of the toggle: an output that the current state does not list belongs to the branch that `entryBranch` of `@dv/ui-kit` names: the current branch when the entry's `branches` hold it (a redo step), else the branch the record was written on, else the first branch in `branches`; an entry on no branch line adds nothing. `assetLibrary` merges those assets into the assets of the current branch, each asset once, and groups the images and videos; an image that a shot render record outputs goes to `extracted`. An imported asset shows the name and time of this project's `asset.import` record whose status is `done`, because the asset pool keeps the name and time of the first import of identical bytes in any project; only a record that adds an asset outside the current state can name it. A failed history fetch shows no other-branch assets. The preview reads the width and height from the loaded media when the asset has none (imported files), and renders on `document.body` so the right Sidebar cannot cover its buttons; Escape or a click outside closes it.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The Host half, which registers nothing |
| [`src/client/index.ts`](src/client/index.ts) | Registrations of the tab type and the tab body |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/AssetsPanel.tsx`](src/client/AssetsPanel.tsx) | The panel, the drop zone, the thumbnail grids by section, the preview, and the tab body |
| [`src/client/library.ts`](src/client/library.ts) | Grouping of the current branch's assets and the other branches' assets by media type with the render stills apart, and the branch of each other-branch asset |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/api`](../api/README.md) — the state route, the history route, and the asset import route.
- [`@dv/asset-pool`](../asset-pool/README.md) — the asset pool that stores the files and serves them.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, the window events, and the compose event.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dv/project`; the `asset.import` records that the asset pool panel's imports write reach the model only through the `dv:project` prompt section and the `dv_proj_*` and operation tools of [`@dv/project`](../project/README.md).

#### KV Cache effect

None; the panel sends nothing to a model. 让智能体使用 / Ask the agent to use it only fills the composer, and the user decides whether to send it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Other-branch assets from the newest 200 entries** — the toggle reads at most 200 history entries marked `redo` or `branch`, so a project with a longer history on other branches lists only the assets of the newest ones.
- **One history fetch per project change** — while the toggle is on, every project change refetches the history entries as well as the state.
