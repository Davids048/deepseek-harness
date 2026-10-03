---
description: "The DreamVerse browser protocol: the /ws project socket with create, open, and takeover, the health, readiness, and creation-capability routes, and the page's React-free protocol and state modules."
kind: "package-reference"
---

# @dreamverse/project-controller

English | [中文](README.zh.md)

## Summary

This package connects the DreamVerse page to the harness. The page opens one WebSocket per project to create a project or reopen a stored one, sends its commands, and receives prompt events and the video stream; a second window that opens the same project takes it over and the first window is told why. The package also answers the health, readiness, and creation-capability requests, and it ships the page's protocol client, state stores, and story presets. The socket stays open through idle proxies with a ping every 20 seconds.

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

Mount the plugin after the DSH web server and the DreamVerse services; it injects `webServer`, `dreamverseGeneration`, `dreamverseAssetsManager`, and `dreamverseProjects` and has no configuration.

### Minimal configuration

```yaml
- id: dreamverse-project-controller
  name: '@dreamverse/project-controller'
```

### Routes

Inside `ctx.effect`, the plugin registers `/ws` with `registerUpgrade()` and each HTTP route with `register()`. Each HTTP route dispatches through `@dreamverse/http-routes`, so another method on a known path answers FastAPI's 405 and a failing route answers Starlette's plain 500.

| Route | Behavior |
| --- | --- |
| `/ws` | One project per socket. The first message is `project_init_v1`, which creates a project, or `{"type": "project_open_v1", "project_id": ...}`, which opens a stored one; any other first message, a missing `project_id`, or a project that cannot open answers `{"type": "error", "message": ...}` and closes with 1003. `gpu_assigned` follows and carries `project_id`; an opened project then reports `generation_round_status` `idle`. |
| `GET /health`, `GET /healthz` | `{"status": "ok", "service": "ltx2-streaming-backend", "ts": ...}` |
| `GET /readyz` | 200 `{"status": "ready", ...}` when the generation backend is ready; otherwise 503 `{"status": "warming", ..., "detail": "Generation backend is unreachable."}` |
| `GET /creation-capabilities` | The reference `lobby_capabilities_as_dict` payload from the served model's facts and the upload policy |

The connection holds the project's lease in `dreamverseProjectStore`. When another connection opens the same project, the store revokes the earlier connection: its project closes and is stored, its browser receives `{"type": "error", "message": "This project was opened in another window."}` and a close, and then the project opens for the later connection. The `/assets` and `/projects` routes belong to `@dreamverse/assets-manager` and `@dreamverse/project-store/routes`.

### Page modules

`src/client/` holds the frontend's React-free modules, which the `@dreamverse/ui-*` packages import as `@dreamverse/project-controller/client/<path>.ts`: the WebSocket client and reducer (`ws/`), the page stores (`stores/`), creation configuration and capabilities, the creation payload, the story presets, prompt events, `projects.ts`, which lists, reads, opens, and deletes stored projects through `/projects`, and `ids.ts`, which declares the page's `ProjectId`, `SegmentId`, and `PromptId` with the brand labels of the host types. The modules brand the IDs of each response and socket event, and the page brands the prompt IDs that it generates. These modules hold no page wording: the creation tables hold mode and model IDs, the selection validators return `CreationSelectionProblem` codes, a project request that fails without a server `detail` throws `ProjectRequestError` with a `failure` code, and the socket reducer reads its two page notices from the page's `noticeText` callback. The `@dreamverse/ui-*` packages translate these with their locale dictionaries; the served model's mode explanations and server messages stay verbatim.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`DreamverseProjectController` accepts each upgrade with `ws`, wraps the socket in `BrowserProjectSocket`, and runs one `ProjectConnection` per socket, the port of the reference `ProjectConnection`. The connection is the project's lease holder: it reads the first message, creates or opens the project through `dreamverseProjects`, forwards browser commands to it, and drives its queued rounds. A closed socket closes the project, which cancels the segment in progress and stores the project. Unloading the plugin removes the routes, terminates every socket, and waits for the connections to finish their cleanup. The server pings each socket every 20 seconds, as the reference uvicorn server does by default, so a proxy such as a Cloudflare tunnel keeps an idle socket open.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The plugin and its route registrations |
| [`src/project-controller.ts`](src/project-controller.ts) | Upgrades, the ping timer, HTTP dispatch, and shutdown |
| [`src/project-connection.ts`](src/project-connection.ts), [`src/project-socket.ts`](src/project-socket.ts) | One project socket and its connection |
| [`src/health-routes.ts`](src/health-routes.ts), [`src/creation-route.ts`](src/creation-route.ts) | Health, readiness, and creation capabilities |
| [`src/client/`](src/client/) | The page's protocol and state modules |

The `tests/` directory covers the controller, the socket, and the page modules.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dreamverse/project`](../project/README.md) — the project that each socket drives.
- [`dreamverse-ui/`](../../dreamverse-ui/README.md) — the page that uses the protocol modules.
- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the process layout and the differences from the Python reference.

-----

<a id="model-experience"></a>
## Model Experience

### Story preset prompts

#### What the model sees

When the user starts a project from a story preset, the page sends the preset's `segment_prompts` from [`src/client/prompts/selected_ltx2_continuation_story_presets.json`](src/client/prompts/selected_ltx2_continuation_story_presets.json) as `curated_prompts` in `project_init_v1`. Without a seed idea, each prompt becomes one segment prompt that the video model receives unchanged.

#### Token effect

Each preset prompt is the complete text input of one segment request; a preset costs no language-model request unless the user rewrites it.

#### KV Cache effect

Independent request per segment; the presets are fixed text in the package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fixed ping interval** — the 20-second socket ping is a constant in code; no `Config` field changes it.
- **Unused developer-tool state** — the page stores in `src/client/stores/` keep the frontend's developer-tools state and operations (editable prompt drafts, curated prompt limits, prompt editor flags), which the page never enables.
- **Health payload names the reference service** — `/health`, `/healthz`, and `/readyz` report the reference service name `ltx2-streaming-backend`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
