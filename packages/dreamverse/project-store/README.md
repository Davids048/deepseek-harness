---
description: "The shared DreamVerse project store: project records of every workload, opaque workload data, one-writer leases, legacy-record migration hooks, and the /projects HTTP routes."
kind: "package-reference"
---

# @dreamverse/project-store

English | [中文](README.zh.md)

## Summary

Use this package to keep the projects of every DreamVerse workload: each project's title, thumbnail, timestamps, kind, and the workload's own data, stored as one JSON file per project. One holder at a time may write a project, and a new holder takes over by revoking the current one, so two browser windows never write the same project. The `/projects` routes list, read, and delete stored projects for any page. Deleting a project deletes its files in the file store. Leases exist only inside one harness process. Superseded by the [video harness](../../../docs/subsystems/video-harness.md).

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

Mount the store service and, on a harness with a web server, its routes plugin. The service injects `dreamverseAssetsManager`.

### Minimal configuration

```yaml
- id: dreamverse-project-store
  name: '@dreamverse/project-store'
  config:
    root: /home/user/.local/state/fastvideo/dreamverse/projects
- id: dreamverse-project-routes
  name: '@dreamverse/project-store/routes'
```

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory that holds one `<project_id>/project.json` per project; the service creates it when it is missing |

### Projects and workload data

`create` stores a project with a `kind`, a title, and workload data `{schemaVersion, data}`, where `data` is any JSON value. The kind names the owning workload, such as `dreamverse` or `multiverse`, and never changes. `list({kind})` returns projects most recently updated first; `get` reads one. The store keeps workload data without interpreting it, and the project's files are file store assets owned by `projectOwner(projectId)`. Project IDs are `ProjectId`, a branded string: the store brands the IDs that it creates or finds under its root, and a caller that reads a project ID from a request brands it with `brandString` from `@deepseek-ai/dsh-brand`.

### Leases

`acquire(projectId, holder)` returns the lease that every write (`updateWorkload`, `setTitle`, `setThumbnail`) takes; a write with a released or revoked lease throws `StaleLeaseError`. When the project already has a holder, `acquire` calls that holder's `revoke()`, waits for it, and only then grants the new lease. Concurrent `acquire` calls for one project are granted in call order. Each workload decides which party holds its projects. `delete` throws `ProjectInUseError` for a held project; otherwise it deletes the project's files with `deleteOwnedBy` and then the project directory.

### Records from earlier formats

`list` and `get` skip a directory whose `project.json` is not a schema-2 record. `listUnrecognized` reports those directories with their parsed record (null for invalid JSON), including a directory that holds only `project.legacy.json` because a migration stopped between its two steps. `migrate` renames the unrecognized `project.json` to `project.legacy.json` and writes a schema-2 record, so the workload that owns the old format converts it.

### HTTP routes

`@dreamverse/project-store/routes` registers one `/projects` prefix route on the DSH web server:

| Route | Behavior |
| --- | --- |
| `GET /projects?kind=<kind>` | `{"projects": [{project_id, kind, title, created_at, updated_at, thumbnail_url}]}`, most recently updated first; `kind` is optional; `thumbnail_url` is `/assets/<asset_id>/content` or null |
| `GET /projects/<project_id>` | The list entry plus `held`, `workload: {schema_version, data}`, and `assets`, the project's files with their `content_url`; 404 `{"detail": "Project not found."}` |
| `DELETE /projects/<project_id>` | 204 after deleting the project and its files; 404 for an unknown project; 409 `{"detail": "This project is open. Close it before deleting."}` while a holder holds it |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each project is one directory, `<root>/<project_id>/project.json`, holding `{"schema_version": 2, "project_id", "kind", "title", "created_at", "updated_at", "thumbnail_asset_id", "workload": {"schema_version", "data"}}`. Project IDs match `[A-Za-z0-9_-]{1,128}`. Every write replaces `project.json` through a temporary file and a rename and sets `updated_at`; writes are synchronous, so the writes to one project never interleave. The service depends on Cordis, Schemastery, Node, and `@dreamverse/assets-manager` only; only the routes plugin uses the DSH web server.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The `dreamverseProjectStore` service: records, leases, deletion, and migration hooks |
| [`src/records.ts`](src/records.ts) | The schema-2 record format and its parser |
| [`src/routes.ts`](src/routes.ts), [`src/http.ts`](src/http.ts) | The `/projects` routes plugin |

The `tests/` directory covers records, leases, deletion, migration hooks, and the routes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — projects, kinds, and leases in the shared project layer.
- [`@dreamverse/assets-manager`](../assets-manager/README.md) — the file store that holds project files.
- [`@dreamverse/project`](../project/README.md) — the DreamVerse workload data and its migration.
- [`@dreamverse/multiverse`](../multiverse/README.md) — the Multiverse workload data.

-----

<a id="model-experience"></a>
## Model Experience

None, as the store keeps project records and workload data that no model request reads directly.

#### KV Cache effect

None; the store adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Leases inside one process** — two harness processes over the same `root`, such as the `dreamverse` and `dreamverse-multiverse` profiles, do not see each other's leases. One process can delete or overwrite a project while the other process writes it.
- **No paging or search** — `GET /projects` returns every project of the requested kind in one response.
- **Superseded by the video harness** — the [video harness](../../../docs/subsystems/video-harness.md) replaces this package with `@video-harness/oplog`, the append-only operation log with branch heads; the package remains only for the `dreamverse` and `dreamverse-multiverse` profiles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
