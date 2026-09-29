"""Start generation backends with the reference mock media and share WebSocket helpers.

Each backend is a real `python -m dreamverse_generation --mock` process started through
`generation_launcher.py` on a free port from 18100 to 18199. The tests expect the PYTHONPATH
from `services/dreamverse-generation/README.md` and FASTVIDEO_FFMPEG_BIN when the host has no
system ffmpeg. Each backend writes request temporary files under its own TMPDIR.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from PIL import Image
from websockets.asyncio.client import ClientConnection, connect

import dreamverse

LAUNCHER = Path(__file__).resolve().parent / "generation_launcher.py"
H3_REF2VA_CONFIG = Path(dreamverse.__file__).resolve().parent / "generation/models/configs/h3-ref2va.yaml"
STARTUP_TIMEOUT_SEC = 300.0
RECEIVE_TIMEOUT_SEC = 120.0
REF2VA_LATENCY_MS = 1000
TERMINAL_MESSAGES = {"segment_finished", "segment_error", "segment_ended"}


@dataclass(frozen=True)
class GenerationBackend:
    """One running backend process, its URLs, and the TMPDIR that holds its request files."""

    process: subprocess.Popen
    base_url: str
    generation_url: str
    tmp_dir: Path


def _free_port() -> int:
    """Return the first port from 18100 to 18199 that accepts a listener on 127.0.0.1."""
    for port in range(18100, 18200):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("No free port from 18100 to 18199.")


@contextmanager
def run_generation_backend(directory: Path, *args: str) -> Iterator[GenerationBackend]:
    """Launch a mock backend and stop it and its worker process on exit."""
    port = _free_port()
    tmp_dir = directory / "tmp"
    tmp_dir.mkdir(parents=True)
    log_path = directory / "backend.log"
    with log_path.open("w") as log:
        process = subprocess.Popen(
            [sys.executable, str(LAUNCHER), *args, "--mock", "--host", "127.0.0.1", "--port", str(port)],
            env={**os.environ, "TMPDIR": str(tmp_dir)}, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    backend = GenerationBackend(process, f"http://127.0.0.1:{port}", f"ws://127.0.0.1:{port}/v1/generation", tmp_dir)
    try:
        _wait_until_ready(backend, log_path)
        yield backend
    finally:
        process.terminate()
        try:
            process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        # The worker shares the backend's process group; remove it if shutdown did not.
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)


def _wait_until_ready(backend: GenerationBackend, log_path: Path) -> None:
    """Poll /readyz until the worker is initialized, failing with the backend log if the process exits."""
    deadline = time.monotonic() + STARTUP_TIMEOUT_SEC
    while time.monotonic() < deadline:
        if backend.process.poll() is not None:
            pytest.fail(f"Generation backend exited during startup:\n{log_path.read_text()[-4000:]}")
        with suppress(httpx.HTTPError):
            if httpx.get(f"{backend.base_url}/readyz", timeout=5).status_code == 200:
                return
        time.sleep(0.5)
    pytest.fail(f"Generation backend was not ready after {STARTUP_TIMEOUT_SEC} s:\n{log_path.read_text()[-4000:]}")


@pytest.fixture(scope="session")
def ref2va_backend(tmp_path_factory) -> Iterator[GenerationBackend]:
    """Serve h3-ref2va with a 1-second mock generation delay, so a segment outlasts a client's close handshake."""
    with run_generation_backend(tmp_path_factory.mktemp("ref2va"), "--config", str(H3_REF2VA_CONFIG),
                                "--latency", str(REF2VA_LATENCY_MS)) as backend:
        yield backend


@pytest.fixture(scope="session")
def fast_h3_backend(tmp_path_factory) -> Iterator[GenerationBackend]:
    with run_generation_backend(tmp_path_factory.mktemp("fast-h3"), "--preset", "fast-h3") as backend:
        yield backend


def image_bytes(image_format: str) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (40, 120, 200)).save(buffer, format=image_format)
    return buffer.getvalue()


def segment_request(*, continue_from: str | None = None, segment_idx: int = 1, num_frames: int = 124,
                    reference_images: tuple[tuple[str, bytes], ...] = (("portrait.png", image_bytes("PNG")),)) -> dict:
    """Build a `generate_segment` message for the served 1344x768 frame size."""
    return {
        "type": "generate_segment", "prompt": f"Picture 1 walks through shot {segment_idx}",
        "frame_width": 1344, "frame_height": 768, "num_frames": num_frames, "segment_idx": segment_idx,
        "continue_from": continue_from,
        "reference_images": [{"name": name, "data": base64.b64encode(data).decode()}
                             for name, data in reference_images],
    }


async def open_generation(backend: GenerationBackend) -> ClientConnection:
    return await connect(backend.generation_url, max_size=None)


async def receive_segment(connection: ClientConnection) -> tuple[list[str], list[dict], list[bytes]]:
    """Collect the message order, JSON messages, and binary frames through the terminal message."""
    order, messages, chunks = [], [], []
    while True:
        message = await asyncio.wait_for(connection.recv(), RECEIVE_TIMEOUT_SEC)
        if isinstance(message, bytes):
            order.append("binary")
            chunks.append(message)
            continue
        messages.append(json.loads(message))
        order.append(messages[-1]["type"])
        if order[-1] in TERMINAL_MESSAGES:
            return order, messages, chunks


async def generate(connection: ClientConnection, request: dict | str) -> tuple[list[str], list[dict], list[bytes]]:
    """Send one request, as a message dictionary or raw text, and collect its response."""
    await connection.send(request if isinstance(request, str) else json.dumps(request))
    return await receive_segment(connection)


def assert_streamed_segment(order: list[str], messages: list[dict], chunks: list[bytes]) -> dict:
    """Check media_metadata, one or more binary frames, media_end, then segment_finished, and return the last."""
    binary_count = len(order) - 3
    assert binary_count >= 1, order
    assert order == ["media_metadata", *["binary"] * binary_count, "media_end", "segment_finished"]
    metadata, media_end, finished = messages
    assert metadata["mime"].startswith("video/mp4")
    assert media_end == {"type": "media_end", "stream_id": metadata["stream_id"], "chunks": binary_count}
    assert chunks[0][4:8] == b"ftyp"
    assert finished["timings"]["e2e_latency_ms"] >= 0
    return finished
