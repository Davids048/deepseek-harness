# dreamverse/ — DreamVerse on DeepSeek Harness

This package group runs the DreamVerse application as Cordis plugins inside DeepSeek Harness. Each user runs one harness instance. The harness owns everything the user sees and decides: the DreamVerse page, the browser protocol, projects, user actions, prompt enhancement, the asset library, and product rules. The DreamVerse page is a port of the FastVideo DreamVerse Next.js frontend as DSH browser plugins in [`../dreamverse-ui/`](../dreamverse-ui/README.md). Video generation is a separate API served by a FastVideo generation backend on a GPU machine; the harness reaches it over one stable connection, and GPU details never reach the user.

The Python DreamVerse server in `apps/dreamverse/dreamverse/` (FastVideo checkout) is the behavioral reference. For the same browser messages, model replies, and generated media, the harness sends the same browser events in the same order and writes the same project log events, except for the intentional differences listed at the end of this file.

## Process layout

```
Browser (the DreamVerse page at the `dsh web:` token URL)
   │
   ▼
dsh --profile dreamverse  (Node, one instance per user)
   @deepseek-ai/dsh-host-webserver DSH web server on DREAMVERSE_BROWSER_PORT; DreamVerse plugins register routes on it
   @dreamverse/ui-*                the DreamVerse page as browser plugins (packages/dreamverse-ui/)
   @dreamverse/project-controller  /ws project protocol, health, readiness, and creation capability routes
   @dreamverse/project             Project state, action admission, creation rules, generation plans, project log
   @dreamverse/user-actions/*      one Cordis plugin per user action
   @dreamverse/prompt-enhancer     prompt templates, prompt settings, Cerebras/Groq provider race
   @dreamverse/assets-manager      asset files, their index, upload validation, retention, /assets routes
   @dreamverse/generation-client   client for the generation backend API
   │
   ▼  HTTP + WebSocket (local port or tunnel)
services/dreamverse-generation  (Python, FastAPI, on the GPU machine)
   one GPU worker for the backend's lifetime, H3 model, fMP4 encoding, continuation state
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
| `project-controller` | `@dreamverse/project-controller` | none | Port of `project_websocket_connection.py` and the health, readiness, and creation capability routes; `./client/*` holds the frontend's React-free project modules (`lib/ws/`, `stores/`, creation configuration, project storage) |
| `http-routes` | none (library) | none | Starlette-compatible responses and route dispatch shared by the DreamVerse HTTP routes |
| `../bundle/dreamverse` | bundle patch only | none | `cordis.patch.yml` that mounts every row above |

Every package is ESM TypeScript loaded from source through the `dsh` launcher's tsx hook: `package.json` `exports` point at `./src/*.ts`, and the Host code needs no build step. The `src/client/` modules of `project-controller` and `assets-manager` are browser code: the `@dreamverse/ui-*` bundles compile them from source, and each package's `tsconfig.client.json` typechecks them apart from the Host code (`tsconfig.host.json`).

## Generation backend API

The backend lives in `services/dreamverse-generation/` as the Python package `dreamverse_generation`. `python -m dreamverse_generation (--preset ID | --config PATH) [--mock [--latency MS]] [--host HOST] [--port PORT]` starts it with `PYTHONPATH=<FastVideo checkout>:<FastVideo checkout>/apps/dreamverse:services/dreamverse-generation`. It imports the reference `dreamverse.generation` and `dreamverse.workers` modules and FastVideo. It serves one user: it acquires its single worker at startup, holds it until shutdown, and runs one segment at a time across all connections.

### `GET /readyz`

200 `{"status": "ready"}` when the worker is initialized; 503 `{"status": "warming", "detail": str}` before that.

### `GET /v1/model`

The facts the harness needs to validate projects and build requests, computed from the reference `ModelCapabilities` and the FastVideo default request:

```json
{
  "model_id": "h3-ref2va",
  "name": "H3 Ref2AV",
  "generation_modes": {"ref2va": "reference_images"},
  "unsupported_generation_modes": {"fl2va": "First/last frame mode (FL2VA) is not supported yet."},
  "aspect_ratios": ["16:9"],
  "resolutions": ["720p"],
  "min_segment_duration_sec": 5,
  "max_segment_duration_sec": 15,
  "max_reference_images": 9,
  "max_reference_aspect_ratio": 4.0,
  "uses_previous_frame": false,
  "frame_sizes": {"16:9": {"720p": [1344, 768]}},
  "num_frames_by_duration_sec": {"5": 124, "6": 158},
  "reference_labels": ["Picture 1", "Picture 2"]
}
```

`frame_sizes` holds `resolve_frame_size` for every supported aspect ratio and resolution. `num_frames_by_duration_sec` holds `resolve_num_frames(duration, default_request.sampling.fps)` for every duration from the minimum to the maximum. `reference_labels` holds `create_reference_prompt_labeler(capabilities)(max_reference_images)`; the labels for N images are its first N entries.

### `WS /v1/generation`

A connection carries segment requests one at a time. Client → server:

```json
{"type": "generate_segment", "prompt": str, "frame_width": int, "frame_height": int, "num_frames": int,
 "segment_idx": int, "continue_from": str | null,
 "reference_images": [{"name": str, "data": "<base64 image bytes>"}]}
```

The backend writes the reference images to a request-owned temporary directory, builds the FastVideo request from its default request with the prompt and the three frame fields, and streams the worker output:

| Worker output | Message |
| --- | --- |
| `MediaMetadata(stream_id, mime)` | `{"type": "media_metadata", "stream_id": str, "mime": str}` |
| `bytes` | one binary WebSocket frame with the same bytes |
| `MediaEnd(stream_id, chunks)` | `{"type": "media_end", "stream_id": str, "chunks": int}` |
| `SegmentFinished(timings)` | `{"type": "segment_finished", "timings": {str: float}, "continuation_handle": str}` |
| exception | `{"type": "segment_error", "error_type": type(exc).__name__, "is_value_error": isinstance(exc, ValueError), "message": str(exc)}` |
| stream ended without `SegmentFinished` | `{"type": "segment_ended"}` |

### Continuation handles

The harness owns the continuation reference and the backend owns the tensors. Every finished segment gets a new opaque `continuation_handle`. A request with `continue_from: null` starts fresh video (`reset_conditioning=True`). A request whose `continue_from` equals the latest handle continues that segment (`reset_conditioning=False`). The backend keeps continuation state only for the latest finished segment, so any other handle fails with `ValueError` "The video service can continue only its last completed segment." A failed or abandoned segment leaves no continuation state. The harness decides which segment each request continues from.

## Harness service contracts

TypeScript names use camelCase. Wire payloads, browser events, and project log payloads keep the reference snake_case keys exactly.

### `dreamverseGeneration` (`@dreamverse/generation-client`)

Config: `baseUrl`.

```ts
interface ModelFacts { modelId; name; generationModes; unsupportedGenerationModes; aspectRatios; resolutions;
  minSegmentDurationSec; maxSegmentDurationSec; maxReferenceImages; maxReferenceAspectRatio: number | null;
  usesPreviousFrame; frameSizes; numFramesByDurationSec; referenceLabels: string[] }
interface SegmentRequest { prompt: string; frameWidth: number; frameHeight: number; numFrames: number; segmentIdx: number;
  continueFrom: string | null; referenceImages: { name: string; data: Buffer }[]; signal?: AbortSignal }
type SegmentOutput =
  | { kind: 'media_metadata'; streamId: string; mime: string }
  | { kind: 'chunk'; bytes: Buffer }
  | { kind: 'media_end'; streamId: string; chunks: number }
  | { kind: 'segment_finished'; timings: Record<string, number>; continuationHandle: string }
class DreamverseGeneration {
  model(): Promise<ModelFacts>                         // GET /v1/model, cached after the first success
  ready(): Promise<{ ready: boolean; detail: string | null }>
  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput>   // one WebSocket per request
}
```

A `segment_error` rejects the iteration with `GenerationSegmentError(message, errorType, isValueError)`. Aborting `request.signal` closes the socket and rejects with `signal.reason`; the backend finishes the abandoned segment on its side.

### `dreamverseAssetsManager` (`@dreamverse/assets-manager`)

Config: `root` (the reference `<state root>/assets` directory; `files/<asset_id>` plus `index.sqlite3` with the reference schema, through `node:sqlite`). A port of `AssetLibrary`, `inspect_media`, and `upload_policy_as_dict` with the reference messages: images through `sharp` (content format, pixel limit, animation, full decode), video and audio through `ffprobe` with the reference arguments.

```ts
interface AssetRecord { assetId; name; mediaType; mimeType; filePath; sizeBytes; width: number | null;
  height: number | null; durationSec: number | null }
class DreamverseAssetsManager {
  add(content: Uint8Array, name: string, mimeType: string): Promise<AssetRecord>  // MediaValidationError, UploadTooLargeError
  list(): AssetRecord[]
  get(assetId: string): AssetRecord                                               // AssetNotFoundError
  retain(assetIds: readonly string[]): AssetRecord[]
  release(assetIds: readonly string[]): void
  delete(assetId: string): void
  uploadPolicy(): Record<string, unknown>
}
```

While the DSH web server (`webServer`) is available, the service registers one `/assets` prefix route on it: ports of `routes/assets.py`, including ranged content responses. The DSH page shell loads its own scripts, styles, fonts, and language packs from `./assets/`, so a GET or HEAD request under `/assets` that matches no asset GET route serves the shell's file through `frontend-static`'s `serveStatic`; every other unmatched path answers FastAPI's JSON 404 or 405.

### `dreamversePromptEnhancer` (`@dreamverse/prompt-enhancer`)

A direct port of `PromptEnhancer`, `PromptSettings`, the three features, `ProviderRace`, `VendorClient`, and `PromptTemplates`. The bundled Markdown templates are byte-identical copies of `apps/dreamverse/dreamverse/prompt_enhancement/templates/resources/`. Provider settings come from `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `FASTVIDEO_PROMPT_MODEL`, `FASTVIDEO_PROMPT_CEREBRAS_MODEL`, `FASTVIDEO_PROMPT_GROQ_MODEL`, `FASTVIDEO_PROMPT_GROQ_API_BASE_URL`, and `CEREBRAS_BASE_URL` through validated Config fields.

### `dreamverseProjects` (`@dreamverse/project`)

Owns `Project`, `GenerationPlan`, `VideoSegment`, `GenerationPlanController`, the segment-to-browser stream function, creation and reference validation (ports of `project_creation.py` and the `ModelCapabilities` checks, driven by `ModelFacts`), and `ProjectEventLogger`. Reference assets are retained and released synchronously through `dreamverseAssetsManager`, so browser commands are admitted at receipt like the reference. Each `VideoSegment` records the `continuationHandle` its generation returned; a segment with a predecessor sends that predecessor's handle as `continueFrom`.

```ts
type UserActionHandler = (project: Project, payload: ActionPayload,
                          options: { referenceAssets: readonly AssetRecord[] }) => Promise<void>
interface UserActionRegistration { actionTypes: string[]; handler: UserActionHandler }
class DreamverseProjects {
  registerUserAction(registration: UserActionRegistration): () => void   // returns the disposer
  createProject(init: ProjectInit): Promise<Project>                    // throws ProjectValidationError
  logProjectEvent(projectId: string, event: string, payload?: Record<string, unknown>): Promise<void>
}
interface ProjectSocket { sendJson(event: object): Promise<void>; sendBytes(chunk: Buffer): Promise<void> }
interface ProjectInit { projectId: string; payload: Record<string, unknown>; socket: ProjectSocket }
interface Project {
  readonly projectId: string
  readonly videoGenerationSettings: CreationConfig      // ProjectCreationConfig.as_dict() fields
  processBrowserCommand(payload: Record<string, unknown>): Promise<void>
  processQueuedGenerationActions(): Promise<void>       // rethrows failures that are not ValueError-kind
  closeAndWaitForGeneration(): Promise<void>
}
```

An action type without a registered handler fails the round with `ValueError`-kind `Unsupported project action: <type>`. Error kinds mirror the reference exception classes: `DreamverseValueError` stands for Python `ValueError`; `ProjectValidationError extends DreamverseValueError` carries `reason`. Any other `Error` stands for a non-`ValueError` exception.

### Project controller (`@dreamverse/project-controller`)

No config. Inside `ctx.effect`, the plugin registers `/ws` on the DSH web server with `registerUpgrade()` and the HTTP routes below with `register()`. Each HTTP route dispatches through `@dreamverse/http-routes`, so another method on a known path answers FastAPI's 405 and a failing route answers Starlette's plain 500:

| Route | Behavior |
| --- | --- |
| `/ws` | Port of `ProjectConnection`; `gpu_assigned` follows project creation immediately |
| `GET /health`, `GET /healthz` | The reference payload |
| `GET /readyz` | 200 when `dreamverseGeneration.ready()` reports ready, otherwise 503 with `detail` |
| `GET /creation-capabilities` | The reference `lobby_capabilities_as_dict` payload from `ModelFacts` and the upload policy |
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
- The backend keeps continuation state for its latest segment only, across all projects of the user. A segment generated for another project invalidates a project's continuation state.

## Verification

- `services/dreamverse-generation/tests/`: pytest for the backend API against the reference mock backend.
- `packages/dreamverse/*/tests/`: vitest unit tests for each package.
- `packages/dreamverse-ui/*/tests/`: the frontend's component and page tests, run against the DreamVerse page plugins.
- `dreamverse-parity/`: black-box parity runs of the same browser sessions against the Python reference server and the harness, with a deterministic stub LLM and the mock generation backend.
- `dreamverse-e2e/`: one Playwright script that drives the DreamVerse page (or, for comparison, the FastVideo Next.js frontend) against the harness with the backend serving H3 Ref2VA on four GPUs.
