# dreamverse-generation — DreamVerse generation backend

`dreamverse_generation` is the Python FastAPI process that generates DreamVerse video for DeepSeek Harness. It holds
one FastVideo worker for its whole lifetime and serves `GET /readyz`, `GET /v1/model`, and `WS /v1/generation` as
[Generation backend API](../../packages/dreamverse/README.md#generation-backend-api) specifies. The harness plugins in
[`packages/dreamverse/`](../../packages/dreamverse/README.md) own everything else: projects, user actions, prompt
enhancement, assets, and every browser route.

The backend imports the reference `dreamverse` package from `apps/dreamverse/` in the FastVideo checkout. It reuses
the reference configuration loaders, model capabilities, backend factories, worker pool, and FastVideo request
construction, and it adds no application settings of its own.

## Launch

The model selection options match `dreamverse-server`. Run the backend from this repository with the FastVideo checkout
on `PYTHONPATH`:

```sh
export PYTHONPATH=<FastVideo checkout>:<FastVideo checkout>/apps/dreamverse:services/dreamverse-generation
# H3 Ref2VA on the GPUs listed by CUDA_VISIBLE_DEVICES or nvidia-smi (the config uses four GPUs per worker).
python -m dreamverse_generation \
  --config <FastVideo checkout>/apps/dreamverse/dreamverse/generation/models/configs/h3-ref2va.yaml \
  --host 127.0.0.1 --port 8009
# The same model facts with CPU test media from the reference mock backend.
python -m dreamverse_generation \
  --config <FastVideo checkout>/apps/dreamverse/dreamverse/generation/models/configs/h3-ref2va.yaml \
  --mock --latency 50 --host 127.0.0.1 --port 8009
```

`--preset` accepts the reference preset IDs in place of `--config`. `--host` and `--port` override the `server`
section of the selected FastVideo YAML file. The mock backend encodes through ffmpeg; set `FASTVIDEO_FFMPEG_BIN` when
the host has no system ffmpeg.

The reference mock worker hides every GPU before it imports FastVideo. On hosts where FastVideo's Triton kernels need a
visible CUDA driver at import time, `python -m dreamverse_generation --mock` stops during worker startup with
`RuntimeError: 0 active drivers`. `tests/generation_launcher.py` imports FastVideo before the worker hides the GPUs
and accepts the same arguments, so it also launches a mock backend by hand on those hosts; its mock media adds `test_*`
entries to the segment timings.

## Behavior

- Startup builds the reference `WorkerPool` with the arguments and warmup request of `dreamverse.main.lifespan`,
  reserves its worker, and clears the worker's conditioning. uvicorn listens only after startup finishes, so the port
  refuses connections while the model loads. `/readyz` then reports 503 only when the worker process has stopped.
- One lock serializes segments across all connections. A request that waits for the lock is not cancelled when its
  client disconnects; the backend notices the disconnect at its first send and still finishes the worker command.
- A segment clears the latest continuation handle when it is submitted to the worker and issues a new handle after
  `SegmentFinished`. A request rejected before submission, such as a malformed message or a stale `continue_from`,
  leaves the latest handle valid because the worker conditioning is unchanged.
- Reference images are written to a request-owned directory under the system temporary directory as
  `reference-<n><extension of name>`, in request order. The directory is removed after the worker command ends.
- uvicorn accepts WebSocket messages up to the size of a request that carries the model's maximum number of reference
  images at the reference image upload limit (15 MiB each, base64-encoded), plus 1 MiB.

## Tests

The tests start real backends through `tests/generation_launcher.py` with the reference mock media on free ports from
18100 to 18199:

```sh
PYTHONPATH=<FastVideo checkout>:<FastVideo checkout>/apps/dreamverse:services/dreamverse-generation \
  python -m pytest services/dreamverse-generation/tests -p no:cacheprovider
```
