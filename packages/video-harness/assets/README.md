---
description: "Content-addressed immutable media store of the video harness: SHA-256 asset IDs, the producing operation of each asset, an append-only index, and the /vh/assets content route."
kind: "package-reference"
---

# @video-harness/assets

English | [中文](README.zh.md)

## Summary

Use this package to keep every image, video, audio file, and text artifact of a video project exactly once and never change it. An asset's ID is the SHA-256 of its bytes, so the same file stored twice is one asset, and a record that names an asset always names the same bytes. Each asset remembers the operation that produced it, which lets the operation log trace a file back to the tool call that made it. While the DSH web server runs, the service serves asset bytes at `/vh/assets/<id>/content`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with a root directory. Other plugins inject `vhAssets`.

```yaml
- id: vh-assets
  name: '@video-harness/assets'
  config:
    root: /home/user/.local/state/video-harness/assets
```

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory holding `objects/<sha256>` and `index.jsonl`; created when missing |

| Method | Behavior |
| --- | --- |
| `put(bytes \| {path}, {mime, name?, producedBy?, width?, height?, durationSec?})` | Stores the bytes under their hash and appends an index line; identical content returns the existing ID and keeps the first record |
| `get(id)` | The record: `id`, `mime`, `name`, `sizeBytes`, `producedBy`, `createdAt`, and the dimensions the caller supplied |
| `path(id)` / `read(id)` | The stored file's path, or its bytes |
| `has(id)` / `list()` | Membership, and every record oldest first |
| `assetIdOf(bytes)` | The ID the store would give those bytes, without storing them |

`GET /vh/assets/<id>/content` answers the whole file with its MIME type and an immutable cache header; any other path or method under `/vh/assets` is 404.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`put` writes the bytes to `objects/<sha>.partial` and renames the file into place, so a crash never leaves a half-written object under its hash. The index is one JSON line per asset, appended after the object exists; at start the service replays the index and skips lines whose object file is missing. The store never decodes media: width, height, and duration are stored only when the caller supplies them. The route registers on `webServer` through `ctx.inject`, so the plugin also works in compositions without a web server.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `vhAssets`: the store, the index replay, and the content route |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Video harness subsystem](../../../docs/subsystems/video-harness.md) — how assets, records, and the runtime relate.
- [`@dv/project`](../../dv/project/README.md) — the records that produce and consume assets.

-----

<a id="model-experience"></a>
## Model Experience

None, as the store keeps media bytes by content hash; tools decide what reaches a model.

#### KV Cache effect

None; the store adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No `Range` requests** — the content route sends whole files; seeking inside a long video through this route downloads it from the start.
- **No deletion** — a project's unreferenced assets stay on disk; garbage collection is deferred until projects can be deleted.
- **Index grows without compaction** — replay reads every line at start; a store with very many assets starts slowly.
