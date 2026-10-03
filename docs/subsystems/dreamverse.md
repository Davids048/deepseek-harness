# DreamVerse

English | [中文](dreamverse.zh.md)

DreamVerse is an interactive video-story application that runs as Cordis plugins inside DeepSeek Harness. This page owns the vocabulary and the cross-package rules of the [`packages/dreamverse/`](../../packages/dreamverse/README.md) and [`packages/dreamverse-ui/`](../../packages/dreamverse-ui/README.md) groups: the process layout, the shared project layer, the workloads that use it, and the intentional differences from the FastVideo Python reference. Each package README owns its configuration, routes, and service API.

## Process layout

Each user runs one harness instance. The harness owns everything the user sees and decides: the page, the browser protocol, projects, user actions, prompt enhancement, the file store, and product rules. A FastVideo generation backend on a GPU machine generates the video; the harness reaches it over HTTP, and GPU details never reach the user.

```text
Browser (the DreamVerse page at the `dsh web:` token URL)
   │  WebSocket /ws and HTTP routes
   ▼
dsh --profile dreamverse  (Node, one instance per user)
   @dreamverse/ui-*                 the page as browser plugins
   @dreamverse/project-controller   /ws project protocol, health, readiness, creation capabilities
   @dreamverse/project              DreamVerse projects, action admission, generation plans, project log
   @dreamverse/user-actions/*       one plugin per user action
   @dreamverse/prompt-enhancer      prompt templates and the Cerebras/Groq provider race
   @dreamverse/segment-generation   one segment's generation and its files
   @dreamverse/project-store        project records, write leases, /projects routes
   @dreamverse/assets-manager       file store, /assets routes
   @dreamverse/generation-client    client for the generation backend API
   │  HTTP requests and server-sent event responses
   ▼
fastvideo serve with a streaming_v2 config  (Python, on the GPU machine)
```

Python keeps only the work that needs GPUs, torch, or FastVideo. Everything that stays the same when the generation provider changes belongs to the harness. The `dreamverse-multiverse` profile replaces the DreamVerse workload rows with the Multiverse rows and keeps the same shared rows.

## Shared project layer

Three packages form a thin layer that every workload uses. They depend on no workload package and use no DSH Session, Workspace, or storage package.

| Package | Service | Responsibility |
| --- | --- | --- |
| [`@dreamverse/assets-manager`](../../packages/dreamverse/assets-manager/README.md) | `dreamverseAssetsManager` | The one file store: library uploads and every file of every project |
| [`@dreamverse/project-store`](../../packages/dreamverse/project-store/README.md) | `dreamverseProjectStore` | Project records, workload data, write leases, and the `/projects` routes |
| [`@dreamverse/segment-generation`](../../packages/dreamverse/segment-generation/README.md) | `dreamverseSegmentGeneration` | One segment's generation, its stored video and last frame, and the shared generation rules |

The layer uses these terms:

| Term | Meaning |
| --- | --- |
| Project | One unit of user work with an ID, a title, a thumbnail, and workload data. The harness owns every project; the page keeps no project content. |
| Kind | The workload that owns a project, such as `dreamverse` or `multiverse`. A project has exactly one kind, fixed at creation. |
| Workload data | The workload's own JSON value and its schema version. The project store keeps it without interpreting it. |
| File owner | `library` for a user upload, or `project:<project_id>` for a file of one project. Every file has exactly one owner. Deleting a project deletes its files. |
| Reference copy | The project's own copy of a library image that it uses. Deleting the library image leaves the project unchanged. |
| Lease | The right to write one project. One holder at a time holds a project's lease; a new holder revokes the current one first. Leases exist inside one harness process. |
| Segment | One generated video with its last frame, stored as two files of the project that requested it. |

## Workloads

A workload is a set of packages that gives projects of one kind their behavior and their page.

- **DreamVerse** (`dreamverse`): [`@dreamverse/project`](../../packages/dreamverse/project/README.md) holds the project state and its log, [`@dreamverse/user-actions`](../../packages/dreamverse/user-actions/README.md) runs the user actions, [`@dreamverse/project-controller`](../../packages/dreamverse/project-controller/README.md) serves the `/ws` protocol, and the [`dreamverse-ui`](../../packages/dreamverse-ui/README.md) packages draw the page. The [`@dreamverse/bundle`](../../packages/bundle/dreamverse/README.md) patch mounts them.
- **Multiverse** (`multiverse`): [`@dreamverse/multiverse`](../../packages/dreamverse/multiverse/README.md) grows a branching story as a tree of segments, and [`@dreamverse/ui-multiverse`](../../packages/dreamverse-ui/multiverse/README.md) draws it. The [`@dreamverse/multiverse-bundle`](../../packages/bundle/dreamverse-multiverse/README.md) patch mounts them.

## Generation backend

FastVideo owns the streaming_v2 API that [`@dreamverse/generation-client`](../../packages/dreamverse/generation-client/README.md) calls. One request generates one segment, and the backend keeps no state between requests. The harness keeps the continuity between segments: [`@dreamverse/segment-generation`](../../packages/dreamverse/segment-generation/README.md) decides which images each request carries and stores the last frame that the next segment starts from.

## Differences from the Python reference

The Python DreamVerse server in `apps/dreamverse/dreamverse/` of the FastVideo checkout is the behavioral reference. For the same browser messages, model replies, and generated media, the harness sends the same browser events in the same order and writes the same project log events, except for these differences:

- The harness sends no `queue_status`, and GPU state stays inside the backend: `/status` and `/internal/monitor/capacity` are not served, `/readyz` reports backend readiness without GPU counts, and the `gpu_assigned` project log event carries no `gpu_id`.
- The prompt safety filter is removed.
- The LTX-only LoRA routes are not served.
- The DSH web server answers every path that no DreamVerse route claims: `/` serves the token-protected DreamVerse page, and other unclaimed paths get the web server's answer instead of FastAPI's JSON 404. Under `/assets`, GET and HEAD requests that match no asset GET route serve the DSH page shell's files.
- Developer tools are not ported: the harness serves no `/curated-presets`, `/curated-presets/append`, or `/prompt-system-config` route, and prompt templates load without the `prompts.local` developer overlay.
- The browser cannot choose rewrite settings: `project_init_v1` and `rewrite_seed_prompts` ignore `rewrite_model`, `rewrite_temperature`, `rewrite_window_system_prompt`, and `rewrite_user_system_prompt`, and `set_rewrite_model` and `set_rewrite_temperature` are unsupported commands.
- The harness, not the backend, keeps the conditioning between segments: each continued segment sends its predecessor's last frame as a request image, and a selection holds at most one image fewer than the model's request limit.
- Projects outlive their sockets: the harness stores every project, reopens it through `project_open_v1`, and lets a later connection take over an open project through the project's lease. A project copies each library image that it uses.
- The `websocket_connected` project log event of a socket that creates a project carries a connection UUID instead of the project ID, because the project store assigns the project ID after the first message.
- A segment stream failure names the segment by its segment ID instead of its display position.
- The packaged `ref2va_system_prompt.md` template follows the MiniMax H3 reference-mode prompt guide instead of matching the reference template.
- The served model reports no unsupported generation modes, and a `fl2va` project fails with `Unsupported generation_mode: fl2va`.

The page also differs from the FastVideo Next.js frontend:

- The page omits the developer tools (`NEXT_PUBLIC_INCLUDE_DEVTOOLS`), the rewrite inspector, the monitor page, the LoRA controls, and voice input.
- The live composer has a **Prompt action** selection: **Rewrite** sends `rewrite_seed_prompts`, and **Continue from the last segment** sends `append_prompt`. The frontend exposes this choice only in its developer tools.
- The page stores no project in the browser. The project history lists the harness projects, opening a project rebuilds its stored rounds, and a closed project socket shows **Reconnect**. The frontend saves projects to IndexedDB and shows saved projects read-only.
- The first visit opens the `dsh web:` token URL; that visit redirects to `/` without other query parameters, so demo mode needs a second visit to `/?demo=1`.
- Images are plain `<img>` elements, so the K2 logo shows the original PNG instead of the Next.js image optimizer's copy.
- The page omits the frontend's ineffective Google Fonts import and renders the same system fonts.
- The page shows its copy in Chinese or English: each dreamverse-ui package registers a locale dictionary for the copy that it renders, and the page follows the browser's language. The frontend shows English only.
