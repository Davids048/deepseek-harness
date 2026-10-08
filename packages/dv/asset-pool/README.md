---
description: "Asset pool component of DreamVerse: the dvAssetPool service, the content-addressed asset store with its /dv/assets route, the canvas placements of each branch, and the operations asset.import, asset.grab_still, asset.place and asset.unplace with their agent tools."
kind: "package-reference"
---

# @dv/asset-pool

English | [中文](README.zh.md)

## Summary

Use this package to keep every image, video, audio, and text file of a project exactly once and never change it. An asset's ID is the SHA-256 of its bytes, so a record that names an asset always names the same bytes. The service is Project's asset store and registers four operations with `dvProject`: `asset.import`, where a file or base64 bytes become an asset; `asset.grab_still`, where one frame of a video becomes a PNG still; and `asset.place` and `asset.unplace`, which put assets on the canvas and take them off it. While the DSH web server runs, the service serves asset files at `/dv/assets/<AssetId>`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project` and `@dv/ffmpeg`. Other plugins inject `dvAssetPool`. The service registers itself with `dvProject.registerAssetStore`, so the same file imported twice is one asset. `asset.grab_still` runs through `dvFfmpeg`, and `dvProject` turns the four operations into the agent tools `dv_asset_import`, `dv_asset_grab_still`, `dv_asset_place` and `dv_asset_unplace`. The `asset` reducer keeps `placed`, the assets on the branch's canvas in the order they were placed; the `proj` slice's `created_by` names the record that created each asset. Which assets are on the canvas is project content: each placement is a record, so it belongs to one branch, History lists it, and undo takes it back.

```yaml
- id: dv-asset-pool
  name: '@dv/asset-pool'
  config:
    root: /home/user/.local/state/video-harness/assets
```

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory holding `objects/<sha256>` and `index.jsonl`; created when missing |
| `publicBaseUrl` | `''` | Base of the asset URLs that the agent and chat cards show, such as a tunnel origin; empty keeps them relative |

| Operation | Tool | Inputs and params | Outputs |
| --- | --- | --- | --- |
| `asset.import` | `dv_asset_import` | params `path` (a file on this machine) or `base64` (the bytes), `mime` (required), `name` (default: the file name), `place` (true also puts the asset on the canvas) | `asset` |
| `asset.grab_still` | `dv_asset_grab_still` | input `video`, param `at`: `first`, `last` (default), or a time in seconds | `still` (PNG) |
| `asset.place` | `dv_asset_place` | input `asset` (one or more); refused with `invalid_inputs` for an asset no record of the current branch created, and with `invalid_params` when every asset is already on the canvas | none |
| `asset.unplace` | `dv_asset_unplace` | input `asset` (one or more); refused with `invalid_params` when none of the assets is on the canvas; the assets stay in the pool | none |

| Method | Behavior |
| --- | --- |
| `importAsset(bytes \| {path}, {mime, name, durationSec?, width?, height?}, createdBy)` | Stores the bytes under their hash and appends an index line; identical content returns the existing ID and keeps the first asset |
| `get(asset)` | The `Asset`: `id`, `mime`, `name`, `size_bytes`, `created_by`, `created_at`, `width`, `height`, `duration_sec` |
| `path(asset)` / `read(asset)` | The stored file's absolute path, or its bytes |
| `has(asset)` / `list()` | Membership, and every asset oldest first |
| `url(asset)` | `<publicBaseUrl>/dv/assets/<AssetId>` |
| `grabStill(video, at, dir)` | Writes one frame of a video as `still.png` into `dir` and returns its path; the operation imports it |

`get`, `path`, and `read` throw `ProjectError` with code `unknown_asset` for an asset the pool does not hold. `GET /dv/assets/<AssetId>` answers the whole file with its media type and an immutable cache header; any other path or method under `/dv/assets` is 404.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`importAsset` writes the bytes to `objects/<sha>.partial` and renames the file into place, so a crash never leaves a half-written object under its hash. The index is one `Asset` JSON line per asset, appended after the object exists; at start the service replays the index and skips lines whose object file is missing. The pool never decodes media: width, height, and duration are stored only when the importer gives them. `grabStill` seeks to the first frame or the given time; for the last frame it probes the video and tries an input seek just before the video stream's end, then a full decode that keeps the last frame, because a fragmented MP4 from a streaming backend has no reliable duration in its header. The route registers on `webServer` through `ctx.inject`, so the plugin also works in compositions without a web server.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvAssetPool`: the store, the index replay, the route, the four operations, and `grabStill` |
| [`src/reducer.ts`](src/reducer.ts) | The `asset` reducer: `placed` from `asset.place`, `asset.unplace`, and `asset.import` with `place` |
| [`src/types.ts`](src/types.ts) | `Asset`, one line of `index.jsonl`, and the `asset` slice `AssetState` |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, agent tools, and the asset store registration.
- [`@dv/ffmpeg`](../ffmpeg/README.md): the ffmpeg runner `grabStill` uses.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): the layout this component follows.

-----

<a id="model-experience"></a>
## Model Experience

### Tool definitions

#### What the model sees

Four tools, `dv_asset_import`, `dv_asset_grab_still`, `dv_asset_place` and `dv_asset_unplace`, in the format `@dv/project` gives every operation tool. `dv_asset_import` says "Bring a file into the asset pool: a path on this machine, or base64 bytes. Returns the asset ID to reference later." and takes `path`, `base64`, `mime` (required), `name` and `place` ("Also put the asset on the canvas."). `dv_asset_grab_still` says "Grab one frame of a video as a PNG still, to look at it or to use it as a reference." and "Runs on the CPU.", and takes the input `video` and the param `at` (`'first'`, `'last'`, or a time in seconds; default last). These two descriptions end with "Repeating a call with the same inputs and params reuses the earlier result." `dv_asset_place` says "Put assets of the project on the canvas, where the user sees each one as a node. The assets must have been created on the current branch." and `dv_asset_unplace` says "Take assets off the canvas. The assets stay in the asset pool."; both take the input `asset`.

#### Token effect

About 1,100 tokens for the four definitions, fixed while the plugin is mounted; the shared arguments of `@dv/project` add about 200 tokens to each definition.

#### KV Cache effect

The definitions sit in the stable tool section of every agent request; mounting or removing the plugin changes the tool list and invalidates the cached prefix from the tool section on.

### Tool results

#### What the model sees

A call returns one text block: `done <record>: <summary>` (`imported face.png`, `still at last`, `placed 2 asset(s) on the canvas`), one line per output with its asset ID (the SHA-256 of its bytes), media type and `/dv/assets/<AssetId>` URL, and the params. Image outputs also arrive as image blocks while an attachment service is mounted.

#### Token effect

About 80 tokens of text per call, most of it the 64-character asset ID and the URL. A `dv_asset_import` call with `base64` repeats the bytes in the echoed params, so its result costs about as much as its argument again. Each image block costs what the model charges for one image.

#### KV Cache effect

The result is appended to the conversation after the call; the cached prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No `Range` requests**: the route sends whole files; seeking inside a long video through this route downloads it from the start.
- **No deletion**: a project's unreferenced assets stay on disk; garbage collection is deferred until projects can be deleted.
- **Index grows without compaction**: replay reads every line at start; a pool with very many assets starts slowly.
