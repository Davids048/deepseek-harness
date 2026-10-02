# dreamverse/ — DreamVerse on DeepSeek Harness

This package group runs the DreamVerse application as Cordis plugins inside DeepSeek Harness. Each user runs one harness instance. The harness owns everything the user sees and decides: the DreamVerse page, the browser protocol, projects, user actions, prompt enhancement, the asset library, and product rules. The DreamVerse page is a port of the FastVideo DreamVerse Next.js frontend as DSH browser plugins in [`../dreamverse-ui/`](../dreamverse-ui/README.md). Video generation is a separate API served by a FastVideo generation backend on a GPU machine; the harness reaches it over HTTP, and GPU details never reach the user.

The Python DreamVerse server in `apps/dreamverse/dreamverse/` (FastVideo checkout) is the behavioral reference. For the same browser messages, model replies, and generated media, the harness sends the same browser events in the same order and writes the same project log events, except for the intentional differences listed at the end of this file.

## Process layout

```
Browser (the DreamVerse page at the `dsh web:` token URL)
   │
   ▼
dsh --profile dreamverse  (Node, one instance per user)
   @deepseek-ai/dsh-host-webserver DSH web server on DREAMVERSE_BROWSER_PORT; DreamVerse plugins register routes on it
   @dreamverse/ui-*                the DreamVerse page as browser plugins (packages/dreamverse-ui/)
   @dreamverse/project-controller  /ws project protocol, health, readiness, creation capability, and /projects routes
   @dreamverse/project             Project state, the project store, action admission, creation rules, generation plans, project log
   @dreamverse/user-actions/*      one Cordis plugin per user action
   @dreamverse/prompt-enhancer     prompt templates, prompt settings, Cerebras/Groq provider race
   @dreamverse/assets-manager      asset files, their index, upload validation, retention, project references, /assets routes
   @dreamverse/generation-client   client for the generation backend API
   │
   ▼  HTTP requests and server-sent event responses (local port or tunnel)
fastvideo serve with a streaming_v2 config  (Python, FastVideo, on the GPU machine)
   one video generator for the server's lifetime, H3 Ref2VA model, fMP4 encoding, last-frame PNG
```

The split rule: Python keeps only work that needs GPUs, torch, or FastVideo. Everything that stays the same when the generation provider changes belongs to the harness.

## Packages

| Package | Cordis plugin entries | Service key | Role |
| --- | --- | --- | --- |
| `generation-client` | `@dreamverse/generation-client` | `dreamverseGeneration` | Client for the generation backend API |
| `assets-manager` | `@dreamverse/assets-manager` | `dreamverseAssetsManager` | Port of `dreamverse/assets/` (library and media inspection) and `routes/assets.py`; `./client/assets.ts` is the frontend's asset client (`lib/assets.ts`) |
| `prompt-enhancer` | `@dreamverse/prompt-enhancer` | `dreamversePromptEnhancer` | Port of `dreamverse/prompt_enhancement/` without prompt safety |
| `project` | `@dreamverse/project` | `dreamverseProjects` | Port of `dreamverse/project/` except user actions and the WebSocket connection |
| `user-actions` | `@dreamverse/user-actions/generate-video-sequence`, `/generate-single-clip`, `/continue-video`, `/rewrite-video-sequence` | none (each registers handlers into `dreamverseProjects`) | Port of `dreamverse/project/user_actions/` |
| `project-controller` | `@dreamverse/project-controller` | none | Port of `project_websocket_connection.py` and the health, readiness, and creation capability routes, plus the stored-project routes; `./client/*` holds the frontend's React-free project modules (`lib/ws/`, `stores/`, creation configuration, the stored-project HTTP client `projects.ts`) |
| `http-routes` | none (library) | none | Starlette-compatible responses and route dispatch shared by the DreamVerse HTTP routes |
| `../bundle/dreamverse` | bundle patch only | none | `cordis.patch.yml` that mounts every row above |

Every package is ESM TypeScript loaded from source through the `dsh` launcher's tsx hook: `package.json` `exports` point at `./src/*.ts`, and the Host code needs no build step. The `src/client/` modules of `project-controller` and `assets-manager` are browser code: the `@dreamverse/ui-*` bundles compile them from source, and each package's `tsconfig.client.json` typechecks them apart from the Host code (`tsconfig.host.json`).

## Generation backend API

`scripts/dreamverse/launch-generation.sh` runs `fastvideo serve --config scripts/dreamverse/h3-ref2va.serve.yaml` with FastVideo imported from the checkout named by `FASTVIDEO_ROOT`. The config's `streaming_v2:` block selects FastVideo's streaming_v2 API, and its `generator:` block loads MiniMax H3 Ref2VA on four GPUs with the preset's default sampling, including its denoising steps. FastVideo owns the API; the harness uses the three routes below. The backend keeps no state between requests and serializes generation across concurrent requests.

### `GET /v1/streamv2/health`

200 `{"status": "ready"}` while the server accepts requests; the server creates its generator before it accepts any.

### `GET /v1/streamv2/capabilities`

The served model's facts:

```json
{
  "model_id": "h3-ref2va",
  "name": "H3 Ref2AV",
  "min_segment_duration_sec": 5,
  "max_segment_duration_sec": 15,
  "max_reference_images": 9,
  "max_reference_aspect_ratio": 4.0,
  "frame_sizes": {"16:9": {"720p": [1344, 768]}},
  "num_frames_by_duration_sec": {"5": 124, "6": 158, "15": 362}
}
```

`max_reference_images` counts every request image, including a continued segment's first frame. `num_frames_by_duration_sec` holds every whole duration from the minimum to the maximum.

### `POST /v1/streamv2/generate`

One request generates one segment. The JSON body is `{"prompt": str, "reference_images": [<base64 image bytes>], "width": int, "height": int, "num_frames": int, "seed"?: int, "return_last_frame": bool}`; the prompt names the images `Picture 1`, `Picture 2`, and so on in list order. A request problem found before generation starts answers HTTP 400 `{"code": "invalid_request", "message": str}`. Otherwise the response is a `text/event-stream` of `event: <name>` and one-line JSON `data:` records, in this order:

| Event | Data |
| --- | --- |
| `last_frame` | `{"data": <base64 PNG of the final decoded frame>}`, only when `return_last_frame` is true |
| `video_start` | `{"mime": str}` |
| `video_chunk` | `{"data": <base64 fMP4 bytes>}`, one or more; their concatenation is one fragmented MP4 |
| `done` | `{"timings": {"generation_ms": float, "e2e_latency_ms": float}}`; the response ends |
| `error` | `{"code": "invalid_request" \| "generation_failed", "message": str}`; the response ends |

`invalid_request` marks a problem with the request itself, such as a reference image outside the allowed aspect ratios; `generation_failed` marks any other failure.

## Harness service contracts

TypeScript names use camelCase. Wire payloads, browser events, and project log payloads keep the reference snake_case keys exactly.

### `dreamverseGeneration` (`@dreamverse/generation-client`)

Config: `baseUrl`.

```ts
interface ModelFacts { modelId; name; generationModes; unsupportedGenerationModes; aspectRatios; resolutions;
  minSegmentDurationSec; maxSegmentDurationSec; maxReferenceImages; maxReferenceAspectRatio: number | null;
  usesPreviousFrame; frameSizes; numFramesByDurationSec; referenceLabels: string[] }
interface SegmentRequest { prompt: string; frameWidth: number; frameHeight: number; numFrames: number;
  referenceImages: Buffer[]; seed?: number; returnLastFrame: boolean; signal?: AbortSignal }
type SegmentOutput =
  | { kind: 'last_frame'; png: Buffer }
  | { kind: 'video_start'; mime: string }
  | { kind: 'chunk'; bytes: Buffer }
  | { kind: 'done'; timings: Record<string, number> }
class DreamverseGeneration {
  model(): Promise<ModelFacts>          // GET /v1/streamv2/capabilities, cached after the first success
  ready(): Promise<{ ready: boolean; detail: string | null }>   // GET /v1/streamv2/health
  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput>   // one POST per request
}
```

`model()` adds the harness-owned facts to the capabilities: the generation mode `{ref2va: 'reference_images'}`, no unsupported modes, aspect ratios and resolutions from the `frame_sizes` keys, `usesPreviousFrame: true`, and the labels `Picture 1` to `Picture N` for N = `max_reference_images`. `ready()` throws when the health route answers another status or the backend is unreachable. HTTP 400 and an `error` event reject the iteration with `GenerationSegmentError(message, errorType, isValueError)`, where `errorType` is the backend code and `isValueError` is true for `invalid_request`. A stream that ends before `done` rejects with a plain `Error`. Leaving the iteration or aborting `request.signal` cancels the HTTP request, and an abort rejects with `signal.reason`; the backend finishes a segment whose generation has started.

### `dreamverseAssetsManager` (`@dreamverse/assets-manager`)

Config: `root` (the reference `<state root>/assets` directory; `files/<asset_id>` plus `index.sqlite3` with the reference schema and the harness's `asset_references(asset_id, project_id)` table, through `node:sqlite`). A port of `AssetLibrary`, `inspect_media`, and `upload_policy_as_dict` with the reference messages: images through `sharp` (content format, pixel limit, animation, full decode), video and audio through `ffprobe` with the reference arguments.

```ts
interface AssetRecord { assetId; name; mediaType; mimeType; filePath; sizeBytes; width: number | null;
  height: number | null; durationSec: number | null }
class DreamverseAssetsManager {
  add(content: Uint8Array, name: string, mimeType: string): Promise<AssetRecord>  // MediaValidationError, UploadTooLargeError
  list(): AssetRecord[]
  get(assetId: string): AssetRecord                                               // AssetNotFoundError
  retain(assetIds: readonly string[]): AssetRecord[]
  release(assetIds: readonly string[]): void
  delete(assetId: string): void                                                   // AssetNotFoundError, AssetInUseError
  addProjectReferences(projectId: string, assetIds: readonly string[]): void
  removeProjectReferences(projectId: string): void
  uploadPolicy(): Record<string, unknown>
}
```

`addProjectReferences` records that a stored project uses assets, and `removeProjectReferences` removes every reference of a deleted project; the records persist across restarts. `delete` refuses an asset that a stored project uses with `AssetInUseError`, and `DELETE /assets/{asset_id}` answers it with 409 `{"detail": "This image is used by N project(s). Delete those projects first."}`.

While the DSH web server (`webServer`) is available, the service registers one `/assets` prefix route on it: ports of `routes/assets.py`, including ranged content responses. The DSH page shell loads its own scripts, styles, fonts, and language packs from `./assets/`, so a GET or HEAD request under `/assets` that matches no asset GET route serves the shell's file through `frontend-static`'s `serveStatic`; every other unmatched path answers FastAPI's JSON 404 or 405.

### `dreamversePromptEnhancer` (`@dreamverse/prompt-enhancer`)

A direct port of `PromptEnhancer`, `PromptSettings`, the three features, `ProviderRace`, `VendorClient`, and `PromptTemplates`. The bundled Markdown templates are byte-identical copies of `apps/dreamverse/dreamverse/prompt_enhancement/templates/resources/`, except `ref2va_system_prompt.md`, which follows the [MiniMax H3 reference-mode prompt guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md) and names a continued segment's first frame. `continueVideo` accepts `firstFrameLabel` and sends it as `first_frame_label`; `rewriteRollout` accepts `continuedSegmentLabels` and sends `continued_segment_first_frame_label` and `continued_segment_protagonist_reference_labels` for the segments after the first. Provider settings come from `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `FASTVIDEO_PROMPT_MODEL`, `FASTVIDEO_PROMPT_CEREBRAS_MODEL`, `FASTVIDEO_PROMPT_GROQ_MODEL`, `FASTVIDEO_PROMPT_GROQ_API_BASE_URL`, and `CEREBRAS_BASE_URL` through validated Config fields.

### `dreamverseProjects` (`@dreamverse/project`)

Config: `projectLogRoot` (the project log directory) and `projectRoot` (the project store, described in [Project store and lifetime](#project-store-and-lifetime)).

Owns `Project`, `GenerationPlan`, `VideoSegment`, `GenerationPlanController`, the segment-to-browser stream function, creation and reference validation (ports of `project_creation.py` and the `ModelCapabilities` checks, driven by `ModelFacts`), `ProjectEventLogger`, and `ProjectStore`. Reference assets are retained and released synchronously through `dreamverseAssetsManager`, so browser commands are admitted at receipt like the reference. The project owns segment conditioning, described in [Segment conditioning](#segment-conditioning).

```ts
type UserActionHandler = (project: Project, payload: ActionPayload,
                          options: { referenceAssets: readonly AssetRecord[] }) => Promise<void>
interface UserActionRegistration { actionTypes: string[]; handler: UserActionHandler }
class DreamverseProjects {
  registerUserAction(registration: UserActionRegistration): () => void   // returns the disposer
  createProject(init: ProjectInit): Promise<Project>                    // throws ProjectValidationError
  openProject(init: ProjectOpenInit): Promise<Project>                  // throws ProjectValidationError
  listProjects(): PersistedProject[]                                    // most recently updated first
  readProject(projectId: string): PersistedProject | undefined
  segmentFile(projectId: string, segmentId: string, kind: 'video' | 'frame'): string | undefined
  deleteProject(projectId: string): boolean                             // false when not stored
  logProjectEvent(projectId: string, event: string, payload?: Record<string, unknown>): Promise<void>
}
interface ProjectSocket { sendJson(event: object): Promise<void>; sendBytes(chunk: Buffer): Promise<void> }
interface ProjectOpenInit { projectId: string; socket: ProjectSocket }
interface ProjectInit extends ProjectOpenInit { payload: Record<string, unknown> }
interface Project {
  readonly projectId: string
  readonly videoGenerationSettings: CreationConfig      // ProjectCreationConfig.as_dict() fields
  processBrowserCommand(payload: Record<string, unknown>): Promise<void>
  processQueuedGenerationActions(): Promise<void>       // rethrows failures that are not ValueError-kind
  closeAndWaitForGeneration(): Promise<void>
}
```

An action type without a registered handler fails the round with `ValueError`-kind `Unsupported project action: <type>`. Error kinds mirror the reference exception classes: `DreamverseValueError` stands for Python `ValueError`; `ProjectValidationError extends DreamverseValueError` carries `reason`. Any other `Error` stands for a non-`ValueError` exception.

### Segment conditioning

`src/conditioning.ts` decides which images each segment request carries, and user actions and the generation plan controller both read it, so a prompt names exactly the images that its request sends. On a model whose facts set `usesPreviousFrame`, every segment after the first in a round continues its predecessor, and the first segment of an appended round continues the latest completed segment; an image supplied to an appended first-frame (`initial_image`) shot starts that shot fresh instead. Every request asks for the last frame when the model uses it, and each completed `VideoSegment` keeps that PNG as `lastFrame`.

A continued segment sends its predecessor's last frame first, as `Picture 1`, followed by its reference images as `Picture 2` and later labels; a continued first-frame shot sends only the last frame. An independent segment sends only its reference images, from `Picture 1`. `Project.promptImageLabels()` returns the reference labels and the first-frame label for one segment. Because a continued segment needs one request image for the last frame, a reference-image mode accepts at most `maxReferenceImages - 1` selected images, and `/creation-capabilities` reports that limit.

### Project store and lifetime

The harness owns every project; the page keeps no project content and reads stored projects through the [`/projects` routes](#project-controller-dreamverseproject-controller). `ProjectStore` keeps one directory per project under `projectRoot` (the bundle sets `<FASTVIDEO_DREAMVERSE_HOME or $XDG_STATE_HOME/fastvideo/dreamverse or ~/.local/state/fastvideo/dreamverse>/projects`):

```
<project_id>/project.json                 schema_version 1: title, times, creation config, segments, completed sequences
<project_id>/segments/<segment_id>.mp4     the segment's fragmented MP4, the bytes that the browser received
<project_id>/segments/<segment_id>.png     the segment's last frame
```

`project.json` is replaced through a temporary file and a rename. The project writes it when it is created, after each segment settles (a completed segment's video and last frame are written first; the video goes to `<segment_id>.mp4.partial` while it streams and is renamed after the backend's `done`), when a user action records a completed sequence, when a round fails, and when the project closes. The title is the preset label, else the first prompt cut to 60 code points, else `Untitled project`. Project and segment IDs that name files must match `[A-Za-z0-9_-]{1,128}`.

A `Project` object serves one socket. When the socket closes, the segment in progress becomes `cancelled` (`Project disconnected.`), queued actions are dropped, and the final record is stored. `openProject` rebuilds a stored project for a later socket: completed segments get their last frames back, segments that were pending or generating become `cancelled`, the last segment of the last completed sequence becomes the segment that an append continues, and the project starts idle without Auto Extension. Opening refuses a project that is not stored (`Project not found`), one whose `model_id` is not the served model (`Model unavailable`), and one whose reference asset is unavailable. When a user action with reference assets is accepted, the project registers them with `addProjectReferences`; `deleteProject` removes the directory and the project's asset references.

### Project controller (`@dreamverse/project-controller`)

No config. Inside `ctx.effect`, the plugin registers `/ws` on the DSH web server with `registerUpgrade()` and the HTTP routes below with `register()`. Each HTTP route dispatches through `@dreamverse/http-routes`, so another method on a known path answers FastAPI's 405 and a failing route answers Starlette's plain 500:

| Route | Behavior |
| --- | --- |
| `/ws` | Port of `ProjectConnection`. The first message is `project_init_v1`, which creates a project, or `{"type": "project_open_v1", "project_id": ...}`, which opens a stored one; any other first message, a missing `project_id`, or a project that cannot open answers `{"type": "error", "message": ...}` and closes with 1003. `gpu_assigned` follows immediately and carries `project_id`; an opened project then reports `generation_round_status` `idle`. One connection serves an open project: when another connection opens it, the earlier connection's project closes and is stored, the earlier browser receives `{"type": "error", "message": "This project was opened in another window."}` and a close, and then the project opens for the later connection |
| `GET /projects` | `{"projects": [{project_id, title, created_at, updated_at, thumbnail_url, round_count}]}`, most recently updated first; `thumbnail_url` serves the last frame of the last completed round's last segment, or is null |
| `GET /projects/{project_id}` | `{project_id, title, created_at, updated_at, open, creation_config, rounds: [{round_index, instruction, segments: [{segment_id, prompt, mime, video_url, frame_url}]}]}`: the `gpu_assigned` creation config fields, and one round per completed sequence with its completed segments; `frame_url` is null without a stored last frame; 404 `{"detail": "Project not found."}` |
| `GET /projects/{project_id}/segments/{segment_id}/video`, `.../frame` | The stored file as `video/mp4` or `image/png`, with ranges; 404 `{"detail": "Segment file not found."}` |
| `DELETE /projects/{project_id}` | 204 after removing the project and its asset references; 404 for a project that is not stored; 409 `{"detail": "This project is open. Close it before deleting."}` while a connection serves it |
| `GET /health`, `GET /healthz` | The reference payload |
| `GET /readyz` | 200 when `dreamverseGeneration.ready()` reports ready, otherwise 503 with `detail` |
| `GET /creation-capabilities` | The reference `lobby_capabilities_as_dict` payload from `ModelFacts` and the upload policy; a reference-image mode reports the selection limit from [Segment conditioning](#segment-conditioning) |
| `/assets` routes | Registered by `dreamverseAssetsManager` |

The bundle patch also mounts the DSH web rows: `dsh-host-webserver` (host `DREAMVERSE_BROWSER_HOST`, port `DREAMVERSE_BROWSER_PORT`, no compression), `dsh-web-app` (serves the page shell as the web server's fallback route and prints the `dsh web:` token URL), `dsh-client-modules`, `dsh-client-connection`, `dsh-api-remotes`, `dsh-client-ui-renderer`, and the six `@dreamverse/ui-*` page plugins ([`../dreamverse-ui/`](../dreamverse-ui/README.md)).

## Intentional differences from the reference

- The harness sends no `queue_status`, and GPU state stays inside the backend: `/status` and `/internal/monitor/capacity` are not served, `/readyz` reports backend readiness without GPU counts, and the `gpu_assigned` project log event carries no `gpu_id`.
- The prompt safety filter is removed.
- The LTX-only LoRA routes are not served.
- The DSH web server answers every path that no DreamVerse route claims: `/` serves the token-protected DreamVerse page (open the `dsh web:` URL printed at startup once; the page then sets a cookie), and other unclaimed paths get the web server's answer instead of FastAPI's JSON 404. Under `/assets`, GET and HEAD requests that match no asset GET route (for example `GET /assets/<id>`, a 405 in the reference) serve the DSH page shell's files instead.
- The DreamVerse page runs as DSH browser plugins instead of the Next.js frontend and omits the frontend's developer tools, rewrite inspector, monitor page, LoRA controls, and voice input. [`../dreamverse-ui/`](../dreamverse-ui/README.md#differences-from-the-fastvideo-frontend) lists the visible differences.
- Developer tools are not ported: the harness serves no `/curated-presets`, `/curated-presets/append`, or `/prompt-system-config` route, and prompt templates load without the `prompts.local` developer overlay.
- The browser cannot choose rewrite settings: `project_init_v1` and `rewrite_seed_prompts` ignore `rewrite_model`, `rewrite_temperature`, `rewrite_window_system_prompt`, and `rewrite_user_system_prompt`, and `set_rewrite_model` and `set_rewrite_temperature` are unsupported commands. Every rewrite uses the startup model (`FASTVIDEO_PROMPT_MODEL`), temperature, and templates.
- The harness, not the backend, keeps the conditioning between segments: each continued segment sends its predecessor's last frame as a request image. H3 Ref2VA segments chain like first-frame segments: every later segment of a round and every appended segment starts from the previous segment's last frame, an appended segment after a failed round requires a rewrite while the same socket serves the project (a reopened project appends to its last completed sequence), and a selection holds at most 8 reference images.
- Projects outlive their sockets: the harness stores every project and reopens it through `project_open_v1`, `gpu_assigned` carries `project_id`, a later connection takes over an open project, and the `/projects` routes serve the stored projects. The reference ends a project with its socket and keeps no server-side project content. The asset library refuses to delete an image that a stored project uses.
- The packaged `ref2va_system_prompt.md` template follows the MiniMax H3 reference-mode prompt guide instead of matching the reference template.
- The served model reports no unsupported generation modes: `/creation-capabilities` lists none, and a `fl2va` project fails with `Unsupported generation_mode: fl2va`.

## Verification

- `packages/dreamverse/*/tests/`: vitest unit tests for each package.
- `packages/dreamverse-ui/*/tests/`: the frontend's component and page tests, run against the DreamVerse page plugins.
- `dreamverse-parity/`: black-box parity runs of the same browser sessions against the Python reference server and the harness, with a deterministic stub LLM and the mock generation backend.
- `dreamverse-e2e/`: one Playwright script that drives the DreamVerse page (or, for comparison, the FastVideo Next.js frontend) against the harness with the backend serving H3 Ref2VA on four GPUs.
