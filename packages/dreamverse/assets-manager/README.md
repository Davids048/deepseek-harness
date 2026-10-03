---
description: "The DreamVerse file store: library uploads with media validation, project-owned files, reference copies, deferred deletion, and the /assets HTTP routes."
kind: "package-reference"
---

# @dreamverse/assets-manager

English | [中文](README.zh.md)

## Summary

Use this package to keep every DreamVerse file in one place: the images, videos, and audio that a user uploads to the library, and the segment videos, last frames, and reference copies that belong to projects. Uploads are validated like the FastVideo reference, files that the harness writes appear only once complete, and a file in use stays readable until its last reader finishes. Deleting a project deletes its files; deleting a library file never changes a project. Video and audio inspection needs `ffprobe`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service once per harness; every DreamVerse workload injects `dreamverseAssetsManager`.

### Minimal configuration

The DreamVerse bundles mount the service with the state root's `assets` directory:

```yaml
- id: dreamverse-assets-manager
  name: '@dreamverse/assets-manager'
  config:
    root: /home/user/.local/state/fastvideo/dreamverse/assets
```

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory that holds `files/<asset_id>` and the SQLite index `index.sqlite3` |

### File owners

Every file has exactly one owner: the user's library (`library`) or one project (`project:<project_id>`, built by `projectOwner(projectId)`). A record holds only facts that the file itself shows: name, media type, MIME type, size, dimensions, duration, and creation time.

- `add` stores a library upload. Images go through `sharp` (content format, pixel limit, animation, full decode); video and audio go through `ffprobe` with the reference arguments. A rejected upload throws `MediaValidationError` or `UploadTooLargeError` with the reference message.
- `createWriter` writes a file that the harness produces, such as a segment video while it streams, to `files/<asset_id>.partial`. `commit` inspects the file without the upload limits, renames it, and indexes it; `abort` and a failed commit remove the partial file. `addBytes` writes a complete file the same way.
- `copy` gives another owner its own copy with a new ID. A project copies each library image that it uses, so deleting either file leaves the other.
- `retain` and `release` bracket each generation request and each content response. `delete` and `deleteOwnedBy` hide files at once and remove a retained file after its last release.

### HTTP routes

While the DSH web server (`webServer`) is available, the service registers one `/assets` prefix route. Asset JSON carries `asset_id`, `owner`, `name`, `media_type`, `mime_type`, `size_bytes`, `width`, `height`, `duration_sec`, `created_at`, and `content_url`.

| Route | Behavior |
| --- | --- |
| `GET /assets` | `{"assets": [...]}`: the library's files, newest first |
| `POST /assets` | Multipart `file` upload to the library: 201 with the record; 400 or 413 for a rejected upload; 422 for a missing `file` field |
| `GET /assets/{asset_id}/content` | The file of any owner, with `Range` support; 404 for an unknown or deleted file |
| `DELETE /assets/{asset_id}` | 204 for a library file; 404 for an unknown or deleted file; 409 for a project's file, which goes with its project |

The DSH page shell loads its own scripts and styles from `./assets/`, so a GET or HEAD request under `/assets` that matches no asset route serves the shell's file through `@deepseek-ai/dsh-host-frontend-static`. The browser module `@dreamverse/assets-manager/client/assets.ts` lists, uploads, and deletes library files for the page.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`AssetLibrary` owns the files directory and the index, which `node:sqlite` opens. The index carries `SCHEMA_VERSION` (1) in `PRAGMA user_version`. An unversioned index, the reference layout, migrates in one transaction: existing files belong to the library, `created_at` comes from each file's modification time, and the `asset_references` table of earlier harness builds is dropped. An index with a newer version fails to open with an error that names both versions. The service removes leftover `.partial` files when it starts.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The `dreamverseAssetsManager` service and its `/assets` route registration |
| [`src/library.ts`](src/library.ts) | Files, index, owners, writers, copies, retention, and deletion |
| [`src/media.ts`](src/media.ts) | Upload policy and media inspection with `sharp` and `ffprobe` |
| [`src/asset-routes.ts`](src/asset-routes.ts), [`src/file-response.ts`](src/file-response.ts) | The `/assets` routes and ranged file responses |
| [`src/shell-files.ts`](src/shell-files.ts) | The fallback to the DSH page shell's files |
| [`src/client/assets.ts`](src/client/assets.ts) | The page's asset client |

The `tests/` directory covers the library, media inspection, the routes, and the service lifecycle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — file owners and reference copies in the shared project layer.
- [`@dreamverse/project-store`](../project-store/README.md) — deletes a project's files with its project.
- [`@dreamverse/segment-generation`](../segment-generation/README.md) — writes each segment's video and last frame.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dreamverse/segment-generation`, which reads the stored image files that a workload selects and sends them to the video model as request images.

#### KV Cache effect

None; the file store adds nothing to a model request and keeps no state that a model provider reuses.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fixed upload limits** — the upload policy uses the reference values in code: images up to 15 MiB and 16,777,216 pixels; video up to 100 MiB, 8,294,400 pixels, and 30 seconds; audio up to 100 MiB, 30 seconds, and 2 channels. No `Config` field changes them.
- **Retention is per process** — `retain` counts live in one harness process. Two harness processes over the same `root` do not see each other's retentions, so a deletion in one process can remove a file that the other process retained.
- **`ffprobe` from `PATH`** — video and audio uploads fail with `MediaValidationError` when no `ffprobe` executable is on `PATH`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
