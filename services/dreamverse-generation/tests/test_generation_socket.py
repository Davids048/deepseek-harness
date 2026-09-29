"""Exercise `WS /v1/generation`: media streaming, continuation handles, serialization, and request errors."""
from __future__ import annotations

import asyncio
import json
import os
import re
import time

import httpx
import pytest

from conftest import (REF2VA_LATENCY_MS, assert_streamed_segment, generate, image_bytes, open_generation,
                      receive_segment, segment_request)

STALE_ERROR = {"type": "segment_error", "error_type": "ValueError", "is_value_error": True,
               "message": "The video service can continue only its last completed segment."}


async def finished_segment(connection, **request_fields) -> dict:
    """Generate one segment and return its segment_finished message after checking the stream order."""
    return assert_streamed_segment(*await generate(connection, segment_request(**request_fields)))


@pytest.mark.anyio
async def test_ref2va_segment_streams_media_and_passes_inputs_to_worker(ref2va_backend):
    """Reference images reach the worker as files with their names' extensions and are removed afterwards."""
    portrait, profile = image_bytes("PNG"), image_bytes("JPEG")
    async with await open_generation(ref2va_backend) as connection:
        finished = await finished_segment(connection, segment_idx=3, num_frames=158,
                                          reference_images=(("portrait.png", portrait), ("profile.jpeg", profile)))
    assert re.fullmatch(r"[0-9a-f]{32}", finished["continuation_handle"])
    assert {key: value for key, value in finished["timings"].items() if key.startswith("test_")} == {
        "test_segment_idx": 3.0, "test_reset_conditioning": 1.0, "test_frame_width": 1344.0,
        "test_frame_height": 768.0, "test_num_frames": 158.0,
        "test_reference_image_1.png": float(len(portrait)), "test_reference_image_2.jpeg": float(len(profile)),
    }
    assert list(ref2va_backend.tmp_dir.glob("dreamverse-generation-*")) == []


@pytest.mark.anyio
async def test_continuation_handles_follow_the_latest_finished_segment(fast_h3_backend):
    """Only the latest handle continues; a rejected request keeps it, and a fresh segment replaces it."""
    async with await open_generation(fast_h3_backend) as connection:
        first = await finished_segment(connection, reference_images=())
        second = await finished_segment(connection, continue_from=first["continuation_handle"], segment_idx=2,
                                        reference_images=())
        assert second["continuation_handle"] != first["continuation_handle"]
        assert second["timings"]["test_reset_conditioning"] == 0.0
        _, messages, _ = await generate(connection, segment_request(continue_from=first["continuation_handle"]))
        assert messages == [STALE_ERROR]
        third = await finished_segment(connection, continue_from=second["continuation_handle"], segment_idx=3,
                                       reference_images=())
        assert third["timings"]["test_reset_conditioning"] == 0.0
        fresh = await finished_segment(connection, continue_from=None, reference_images=())
        assert fresh["timings"]["test_reset_conditioning"] == 1.0
        _, messages, _ = await generate(connection, segment_request(continue_from=third["continuation_handle"]))
        assert messages == [STALE_ERROR]
        _, messages, _ = await generate(connection, segment_request(continue_from="unknown"))
        assert messages == [STALE_ERROR]


@pytest.mark.anyio
async def test_failed_segment_clears_continuation(fast_h3_backend):
    """A segment that fails in the worker leaves no handle to continue from."""
    async with await open_generation(fast_h3_backend) as connection:
        first = await finished_segment(connection, reference_images=())
        _, messages, _ = await generate(connection, segment_request(
            continue_from=first["continuation_handle"], num_frames=0, reference_images=()))
        assert (messages[-1]["type"], messages[-1]["error_type"], messages[-1]["is_value_error"]) == (
            "segment_error", "RuntimeError", False)
        _, messages, _ = await generate(connection, segment_request(continue_from=first["continuation_handle"]))
        assert messages == [STALE_ERROR]


@pytest.mark.anyio
async def test_concurrent_connections_run_one_segment_at_a_time(ref2va_backend):
    """Two connections' segments never interleave: one segment's messages all precede the other's."""
    timeline: list[str] = []

    async def run(name: str) -> None:
        async with await open_generation(ref2va_backend) as connection:
            await connection.send(json.dumps(segment_request()))
            while True:
                message = await connection.recv()
                timeline.append(name)
                if isinstance(message, str) and json.loads(message)["type"] in {"segment_finished", "segment_error"}:
                    assert json.loads(message)["type"] == "segment_finished"
                    return

    await asyncio.gather(run("first"), run("second"))
    boundary = timeline.index(timeline[-1])
    assert set(timeline[:boundary]) == {timeline[0]} and set(timeline[boundary:]) == {timeline[-1]}, timeline
    assert timeline[0] != timeline[-1]


@pytest.mark.anyio
async def test_client_disconnect_mid_segment_leaves_backend_usable(ref2va_backend):
    """Closing during a segment drains the worker command and leaves no continuation state."""
    async with await open_generation(ref2va_backend) as connection:
        before = await finished_segment(connection)
    # The close handshake finishes within the mock generation delay, so the backend's first media send fails
    # while the worker still owns the segment.
    abandoned = await open_generation(ref2va_backend)
    started = time.monotonic()
    await abandoned.send(json.dumps(segment_request()))
    await abandoned.close()
    assert time.monotonic() - started < REF2VA_LATENCY_MS / 1000
    async with await open_generation(ref2va_backend) as connection:
        _, messages, _ = await generate(connection, segment_request(continue_from=before["continuation_handle"]))
        assert messages == [STALE_ERROR]
        await finished_segment(connection)
    assert httpx.get(f"{ref2va_backend.base_url}/readyz").status_code == 200
    assert list(ref2va_backend.tmp_dir.glob("dreamverse-generation-*")) == []


@pytest.mark.anyio
@pytest.mark.parametrize(("request_frame", "error_type", "message"), [
    ("not json", "JSONDecodeError", "Expecting value: line 1 column 1 (char 0)"),
    ("[]", "ValueError", "A generation message must be a JSON object with type 'generate_segment'."),
    ('{"type": "cancel_segment"}', "ValueError",
     "A generation message must be a JSON object with type 'generate_segment'."),
    ({key: value for key, value in segment_request().items() if key != "continue_from"}, "ValueError",
     "generate_segment field 'continue_from' must be a string or null."),
    ({**segment_request(), "frame_width": True}, "ValueError",
     "generate_segment field 'frame_width' must be of type int."),
    ({**segment_request(), "prompt": None}, "ValueError", "generate_segment field 'prompt' must be of type str."),
    ({**segment_request(), "reference_images": [{"name": "a.png"}]}, "ValueError",
     "reference_images[0] must be an object with string name and data."),
    ({**segment_request(), "reference_images": [{"name": "a.png", "data": "not base64!"}]}, "ValueError",
     "reference_images[0].data must be base64 image bytes."),
    (b"\x00binary", "ValueError", "A generation message must be a JSON text frame."),
])
async def test_malformed_request_reports_value_error_and_keeps_connection(ref2va_backend, request_frame, error_type,
                                                                          message):
    async with await open_generation(ref2va_backend) as connection:
        await connection.send(json.dumps(request_frame) if isinstance(request_frame, dict) else request_frame)
        _, messages, _ = await receive_segment(connection)
        assert messages == [{"type": "segment_error", "error_type": error_type, "is_value_error": True,
                             "message": message}]
        await finished_segment(connection)


@pytest.mark.anyio
async def test_largest_reference_upload_fits_one_message(fast_h3_backend):
    """A 15 MiB image, the reference upload limit, arrives as one base64 message above uvicorn's 16 MiB default."""
    image = os.urandom(15 * 1024 * 1024)
    async with await open_generation(fast_h3_backend) as connection:
        finished = await finished_segment(connection, reference_images=(("large.webp", image),))
    assert finished["timings"]["test_reference_image_1.webp"] == float(len(image))
