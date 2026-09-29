"""Serve `WS /v1/generation`: run segment requests on the backend's worker and stream their media.

`packages/dreamverse/README.md` (sections "WS /v1/generation" and "Continuation handles")
specifies the messages. One `SegmentRunner` serves every connection of the backend.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect

from dreamverse.generation.contracts import ReferenceImageInput
from dreamverse.project.video_segment import build_generation_request
from dreamverse.workers.api import MediaEnd, MediaMetadata, SegmentFinished, SegmentRequest

if TYPE_CHECKING:
    from fastvideo.api.schema import GenerationRequest
    from dreamverse.workers.process_controller import WorkerProcessController

STALE_CONTINUATION_MESSAGE = "The video service can continue only its last completed segment."


@dataclass(frozen=True)
class SegmentMessage:
    """One validated `generate_segment` client message with decoded reference images.

    The frame field names match `ProjectCreationConfig`, so `build_generation_request`
    reads them from this record.
    """

    prompt: str
    frame_width: int
    frame_height: int
    num_frames: int
    segment_idx: int
    continue_from: str | None
    reference_images: tuple[tuple[str, bytes], ...]


def _required_field(message: dict, name: str, field_type: type[str | int]) -> str | int:
    """Return one required string or integer field; booleans are rejected as integers."""
    value = message.get(name)
    if type(value) is not field_type:
        raise ValueError(f"generate_segment field {name!r} must be of type {field_type.__name__}.")
    return value


def _decode_reference_image(index: int, image: object) -> tuple[str, bytes]:
    """Return the name and decoded bytes of one `reference_images` entry."""
    if not isinstance(image, dict) or type(image.get("name")) is not str or type(image.get("data")) is not str:
        raise ValueError(f"reference_images[{index}] must be an object with string name and data.")
    try:
        return image["name"], base64.b64decode(image["data"], validate=True)
    except binascii.Error as exc:
        raise ValueError(f"reference_images[{index}].data must be base64 image bytes.") from exc


def parse_segment_message(text: str | None) -> SegmentMessage:
    """Decode one client frame; `text` is None for a binary frame.

    Every rejection raises ValueError or its subclass `json.JSONDecodeError`, so the client
    receives `segment_error` with `is_value_error` true.
    """
    if text is None:
        raise ValueError("A generation message must be a JSON text frame.")
    message = json.loads(text)
    if not isinstance(message, dict) or message.get("type") != "generate_segment":
        raise ValueError("A generation message must be a JSON object with type 'generate_segment'.")
    if "continue_from" not in message or not (message["continue_from"] is None
                                              or type(message["continue_from"]) is str):
        raise ValueError("generate_segment field 'continue_from' must be a string or null.")
    images = message.get("reference_images")
    if type(images) is not list:
        raise ValueError("generate_segment field 'reference_images' must be a list.")
    return SegmentMessage(
        prompt=_required_field(message, "prompt", str),
        frame_width=_required_field(message, "frame_width", int),
        frame_height=_required_field(message, "frame_height", int),
        num_frames=_required_field(message, "num_frames", int),
        segment_idx=_required_field(message, "segment_idx", int),
        continue_from=message["continue_from"],
        reference_images=tuple(_decode_reference_image(index, image) for index, image in enumerate(images)),
    )


def write_reference_images(directory: Path, images: tuple[tuple[str, bytes], ...]) -> tuple[ReferenceImageInput, ...]:
    """Write images in request order, keeping each name's extension because the H3 backends open file paths."""
    inputs = []
    for index, (name, data) in enumerate(images, start=1):
        path = directory / f"reference-{index}{Path(name).suffix}"
        path.write_bytes(data)
        inputs.append(ReferenceImageInput(str(path)))
    return tuple(inputs)


class SegmentRunner:
    """Run segments one at a time on the backend's worker and own the latest continuation handle.

    The worker keeps conditioning only for its last generated segment. `latest_handle` names
    that segment after it finished and is None while no finished segment owns the conditioning.
    """

    def __init__(self, worker: WorkerProcessController, request_defaults: GenerationRequest) -> None:
        self.worker = worker
        self.request_defaults = request_defaults
        self.lock = asyncio.Lock()
        self.latest_handle: str | None = None

    async def serve_segment(self, websocket: WebSocket, text: str | None) -> None:
        """Validate one request, run it under the backend-wide lock, and send one terminal message.

        A client disconnect propagates as WebSocketDisconnect after the worker finished the
        abandoned segment. Every other failure becomes `segment_error`.
        """
        try:
            message = parse_segment_message(text)
            async with self.lock:
                finished = await self._stream_segment(websocket, message)
                if finished is None:
                    await websocket.send_json({"type": "segment_ended"})
                    return
                handle = uuid4().hex
                await websocket.send_json({"type": "segment_finished", "timings": finished.timings,
                                           "continuation_handle": handle})
                self.latest_handle = handle
        except WebSocketDisconnect:
            raise
        except Exception as exc:
            await websocket.send_json({"type": "segment_error", "error_type": type(exc).__name__,
                                       "is_value_error": isinstance(exc, ValueError), "message": str(exc)})

    async def _stream_segment(self, websocket: WebSocket, message: SegmentMessage) -> SegmentFinished | None:
        """Forward one segment's media and return its SegmentFinished, or None when the stream ended without it.

        The worker's conditioning belongs to this segment from submission on, so the latest
        handle is cleared before submission. The `stream_segment` scope finishes the worker
        command before it exits, so the reference image files outlive the worker's reads.
        """
        if message.continue_from is not None and message.continue_from != self.latest_handle:
            raise ValueError(STALE_CONTINUATION_MESSAGE)
        finished: SegmentFinished | None = None
        with TemporaryDirectory(prefix="dreamverse-generation-") as directory:
            request = SegmentRequest(build_generation_request(self.request_defaults, message, prompt=message.prompt),
                                     message.segment_idx, reset_conditioning=message.continue_from is None,
                                     reference_images=write_reference_images(Path(directory),
                                                                              message.reference_images))
            self.latest_handle = None
            async with self.worker.stream_segment(request) as outputs:
                async for output in outputs:
                    match output:
                        case MediaMetadata(stream_id=stream_id, mime=mime):
                            await websocket.send_json({"type": "media_metadata", "stream_id": stream_id, "mime": mime})
                        case bytes() as chunk:
                            await websocket.send_bytes(chunk)
                        case MediaEnd(stream_id=stream_id, chunks=chunks):
                            await websocket.send_json({"type": "media_end", "stream_id": stream_id, "chunks": chunks})
                        case SegmentFinished():
                            finished = output
        return finished


async def serve_generation_socket(websocket: WebSocket, runner: SegmentRunner) -> None:
    """Serve one connection's segment requests in arrival order until the client closes it."""
    await websocket.accept()
    try:
        while True:
            frame = await websocket.receive()
            if frame["type"] == "websocket.disconnect":
                return
            await runner.serve_segment(websocket, frame.get("text"))
    except WebSocketDisconnect:
        return
