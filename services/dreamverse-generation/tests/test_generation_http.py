"""Exercise the backend's HTTP routes: readiness, model facts, and the absence of every other route."""
from __future__ import annotations

import asyncio
import time

import httpx
import psutil
import pytest

from conftest import generate, open_generation, run_generation_backend, segment_request

H3_NUM_FRAMES_BY_DURATION_SEC = {"5": 124, "6": 158, "7": 175, "8": 192, "9": 226, "10": 243, "11": 277, "12": 294,
                                 "13": 328, "14": 345, "15": 362}


def test_readyz_reports_ready_worker(ref2va_backend):
    response = httpx.get(f"{ref2va_backend.base_url}/readyz")
    assert (response.status_code, response.json()) == (200, {"status": "ready"})


def test_model_describes_h3_ref2va(ref2va_backend):
    assert httpx.get(f"{ref2va_backend.base_url}/v1/model").json() == {
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
        "uses_previous_frame": False,
        "frame_sizes": {"16:9": {"720p": [1344, 768]}},
        "num_frames_by_duration_sec": H3_NUM_FRAMES_BY_DURATION_SEC,
        "reference_labels": [f"Picture {index}" for index in range(1, 10)],
    }


def test_model_describes_fast_h3_first_frame_model(fast_h3_backend):
    """FastH3 conditions on the previous frame and numbers no reference images in prompts."""
    assert httpx.get(f"{fast_h3_backend.base_url}/v1/model").json() == {
        "model_id": "fast-h3",
        "name": "FastH3",
        "generation_modes": {"t2va": "text", "i2v": "initial_image"},
        "unsupported_generation_modes": {"fl2va": "First/last frame mode (FL2VA) is not supported yet."},
        "aspect_ratios": ["16:9"],
        "resolutions": ["720p"],
        "min_segment_duration_sec": 5,
        "max_segment_duration_sec": 15,
        "max_reference_images": 1,
        "max_reference_aspect_ratio": None,
        "uses_previous_frame": True,
        "frame_sizes": {"16:9": {"720p": [1344, 768]}},
        "num_frames_by_duration_sec": H3_NUM_FRAMES_BY_DURATION_SEC,
        "reference_labels": [],
    }


@pytest.mark.parametrize(("method", "path"), [
    ("GET", "/"), ("GET", "/health"), ("GET", "/healthz"), ("GET", "/status"), ("GET", "/internal/monitor/capacity"),
    ("GET", "/creation-capabilities"), ("GET", "/assets"), ("POST", "/assets"), ("GET", "/curated-presets"),
    ("GET", "/prompt-system-config"), ("GET", "/lora/options"), ("GET", "/internal/v1/runtime"),
    ("POST", "/internal/v1/project-creation"), ("GET", "/docs"), ("GET", "/openapi.json"),
])
def test_backend_serves_no_other_routes(ref2va_backend, method, path):
    assert httpx.request(method, f"{ref2va_backend.base_url}{path}").status_code == 404


@pytest.mark.anyio
async def test_readyz_and_segments_fail_after_worker_exit(tmp_path):
    """A dead worker makes /readyz report 503 and segment requests fail without the ValueError kind."""
    with run_generation_backend(tmp_path, "--preset", "fast-h3") as backend:
        worker = next(child for child in psutil.Process(backend.process.pid).children()
                      if "spawn_main" in " ".join(child.cmdline()))
        worker.kill()
        deadline = time.monotonic() + 30
        while (response := httpx.get(f"{backend.base_url}/readyz")).status_code != 503:
            assert time.monotonic() < deadline, "The backend did not observe the worker exit."
            await asyncio.sleep(0.1)
        assert response.json() == {"status": "warming", "detail": "No ready GPU worker processes."}
        async with await open_generation(backend) as connection:
            _, messages, _ = await generate(connection, segment_request())
        assert (messages[0]["type"], messages[0]["is_value_error"]) == ("segment_error", False)
