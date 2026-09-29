"""Run `python -m dreamverse_generation` for tests with a mock backend that reports its worker inputs.

The reference mock worker hides every GPU before it imports FastVideo, and FastVideo's Triton
kernels fail to import on hosts without a visible CUDA driver. Each spawned worker re-imports
this script as `__mp_main__`, so the import below loads Triton while the GPUs are still visible.
Importing FastVideo creates no CUDA context, and the mock backend never uses a GPU.

`--mock` selects `InputReportingMockBackendFactory`: the reference mock media, plus timings
entries that report the segment inputs the worker received, so tests observe them through
`segment_finished`.
"""
from __future__ import annotations

from pathlib import Path

import fastvideo.api.schema  # noqa: F401

import dreamverse.generation.mock
from dreamverse.generation.mock import MockBackendFactory, MockGenerationBackend


class InputReportingMockBackend(MockGenerationBackend):
    """Return the reference mock media with `test_*` timings that describe the segment inputs."""

    def generate_step(self, request, segment_idx, reset_conditioning, reference_images=()):
        """Record reset_conditioning, the frame fields, and each reference file's extension and size."""
        result = super().generate_step(request, segment_idx, reset_conditioning, reference_images)
        result.timings.update({
            "test_segment_idx": float(segment_idx),
            "test_reset_conditioning": float(reset_conditioning),
            "test_frame_width": float(request.sampling.width),
            "test_frame_height": float(request.sampling.height),
            "test_num_frames": float(request.sampling.num_frames),
        })
        for index, image in enumerate(reference_images, start=1):
            path = Path(image.file_path)
            result.timings[f"test_reference_image_{index}{path.suffix}"] = float(path.stat().st_size)
        return result


class InputReportingMockBackendFactory(MockBackendFactory):
    """Construct `InputReportingMockBackend` inside the worker process."""

    def __call__(self, gpu_id: int) -> InputReportingMockBackend:
        return InputReportingMockBackend(latency_ms=self.latency_ms)


if __name__ == "__main__":
    dreamverse.generation.mock.MockBackendFactory = InputReportingMockBackendFactory
    from dreamverse_generation.__main__ import cli

    cli()
