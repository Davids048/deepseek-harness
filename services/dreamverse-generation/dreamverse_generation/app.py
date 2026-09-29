"""Assemble the DreamVerse generation backend that DeepSeek Harness reaches over HTTP and WebSocket.

The backend serves `GET /readyz`, `GET /v1/model`, and `WS /v1/generation` as
`packages/dreamverse/README.md` (section "Generation backend API") specifies. It reuses the
reference `dreamverse` package for configuration, model capabilities, and the worker pool.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from copy import deepcopy
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse

from dreamverse.assets.media import upload_policy_as_dict
from dreamverse.generation.contracts import GenerationBackendFactory
from dreamverse.generation.models.configs import get_model_capabilities
from dreamverse.generation.models.configs.capabilities import ModelCapabilities
from dreamverse.generation.models.factory import create_model_backend_factory, create_reference_prompt_labeler
from dreamverse.generation.presets import load_generation_config, load_preset
from dreamverse.workers.pool import WorkerPool, get_available_gpus

from dreamverse_generation.generation_socket import SegmentRunner, serve_generation_socket

# The backend reserves its single worker under this pool owner ID for its whole lifetime.
GENERATION_OWNER_ID = "dreamverse-generation"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the worker pool, hold its worker until shutdown, and shut the pool down on every exit.

    Pool construction and startup warmup match `dreamverse.main.lifespan`. The worker
    starts without conditioning, so no continuation handle exists at startup.
    """
    print("Starting generation backend...")
    backend_factory = app.state.backend_factory
    config = app.state.config
    worker_pool = None
    try:
        # CPU generation occupies one logical slot without discovering GPU devices.
        gpu_ids = get_available_gpus() if backend_factory.requires_gpu else [0]
        print(f"Selected GPU ids: {gpu_ids}")
        warmup_request = None
        if config.streaming.warmup.enabled:
            from fastvideo.api.request_metadata import reset_tracking_roots

            warmup_request = deepcopy(config.default_request)
            reset_tracking_roots(warmup_request)
            warmup_request.prompt = config.streaming.warmup.prompt
            warmup_request.inputs.image_path = None
            warmup_request.output.return_frames = True
            warmup_request.output.save_video = False
        worker_pool = WorkerPool(
            gpu_ids,
            backend_factory=backend_factory,
            generator_config=config.generator,
            streaming_config=config.streaming,
            warmup_request=warmup_request,
        )
        await worker_pool.initialize()
        worker = await worker_pool.acquire(GENERATION_OWNER_ID)
        await worker.clear_conditioning()
        app.state.segment_runner = SegmentRunner(worker, config.default_request)
        print("Generation backend started")
        yield
    finally:
        print("Shutting down generation backend...")
        # WorkerPool.shutdown releases the reservation before it stops the worker process.
        if worker_pool is not None:
            await worker_pool.shutdown()


router = APIRouter()


@router.get("/readyz")
async def get_readyz(request: Request):
    """Report whether the backend's worker is initialized and its process is alive."""
    if request.app.state.segment_runner.worker.ready:
        return {"status": "ready"}
    return JSONResponse(status_code=503, content={"status": "warming", "detail": "No ready GPU worker processes."})


@router.get("/v1/model")
async def get_model(request: Request) -> dict:
    return request.app.state.model_facts


@router.websocket("/v1/generation")
async def generation_socket(websocket: WebSocket) -> None:
    await serve_generation_socket(websocket, websocket.app.state.segment_runner)


def describe_model(capabilities: ModelCapabilities, fps: int) -> dict:
    """Compute the `/v1/model` fields from the reference capabilities and the default request's frame rate."""
    aspect_ratios, resolutions = sorted(capabilities.aspect_ratios), sorted(capabilities.resolutions)
    durations = range(capabilities.min_segment_duration_sec, capabilities.max_segment_duration_sec + 1)
    return {
        "model_id": capabilities.model_id,
        "name": capabilities.name,
        "generation_modes": dict(capabilities.generation_modes),
        "unsupported_generation_modes": dict(capabilities.unsupported_generation_modes),
        "aspect_ratios": aspect_ratios,
        "resolutions": resolutions,
        "min_segment_duration_sec": capabilities.min_segment_duration_sec,
        "max_segment_duration_sec": capabilities.max_segment_duration_sec,
        "max_reference_images": capabilities.max_reference_images,
        "max_reference_aspect_ratio": capabilities.max_reference_aspect_ratio,
        "uses_previous_frame": capabilities.uses_previous_frame,
        "frame_sizes": {
            aspect_ratio: {resolution: list(capabilities.resolve_frame_size(aspect_ratio, resolution))
                           for resolution in resolutions}
            for aspect_ratio in aspect_ratios
        },
        "num_frames_by_duration_sec": {str(duration): capabilities.resolve_num_frames(duration, fps)
                                       for duration in durations},
        "reference_labels": list(create_reference_prompt_labeler(capabilities)(capabilities.max_reference_images)),
    }


def max_generation_message_bytes(capabilities: ModelCapabilities) -> int:
    """Size the WebSocket message limit for a request that carries the most images of the largest upload size.

    Base64 encodes each 3 bytes as 4 characters; 1 MiB covers the prompt and the other fields.
    """
    image_bytes = upload_policy_as_dict()["image"]["max_bytes"]
    return capabilities.max_reference_images * 4 * -(-image_bytes // 3) + 1024 * 1024


def create_generation_app(
    *,
    preset: str | None = None,
    config_path: Path | None = None,
    backend_factory: GenerationBackendFactory | None = None,
    host: str | None = None,
    port: int | None = None,
) -> FastAPI:
    """Resolve one preset or FastVideo YAML file and assemble the generation backend that serves it.

    Configuration and backend selection match `dreamverse.main.create_app`. An injected
    factory supplies test media through the same worker interface. The uvicorn server must
    accept WebSocket messages of `app.state.max_generation_message_bytes`.
    """
    if (preset is None) == (config_path is None):
        raise ValueError("Provide exactly one of preset or config_path.")
    config = load_preset(preset) if preset is not None else load_generation_config(config_path)
    capabilities = get_model_capabilities(config.server.served_model_name)
    if backend_factory is None:
        backend_factory = create_model_backend_factory(capabilities)
    if host is not None:
        config.server.host = host
    if port is not None:
        config.server.port = port
    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.backend_factory = backend_factory
    app.state.config = config
    app.state.model_facts = describe_model(capabilities, config.default_request.sampling.fps)
    app.state.max_generation_message_bytes = max_generation_message_bytes(capabilities)
    app.include_router(router)
    return app
