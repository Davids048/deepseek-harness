---
description: "Media processing service of the video harness: ffmpeg and ffprobe over stored assets for probing, frame extraction, trimming, concatenation, and declared-output commands."
kind: "package-reference"
---

# @video-harness/media

English | [中文](README.zh.md)

## Summary

Use this package to run ffmpeg and ffprobe over assets of the content-addressed store. `run` executes one command in a scratch directory with its input assets materialized and its declared outputs collected into `vhAssets` with the producing operation; `probe`, `extractFrame`, `trim`, and `concat` are the commands the harness tools use most, written once here. Commands run through the harness subprocess service when it is mounted, else through `child_process`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@video-harness/assets`.

```yaml
- id: vh-media
  name: '@video-harness/media'
  config:
    ffmpegPath: /opt/ffmpeg/bin/ffmpeg
    ffprobePath: ffprobe
```

| Field | Default | Meaning |
| --- | --- | --- |
| `ffmpegPath` | required | The ffmpeg binary |
| `ffprobePath` | required | The ffprobe binary; a bare name is resolved on `PATH` |
| `outputLimitBytes` | `1048576` | Bytes of stdout and stderr kept per command |

| Method | Behavior |
| --- | --- |
| `run({argv, inputs, outputs, files?, producedBy?, timeoutMs?})` | Runs one command; `{{in:<n>}}` expands to the n-th input's path and `{{out:<name>}}` to a declared output; `ffmpeg` and `ffprobe` as `argv[0]` map to the configured binaries; every declared output must exist afterwards |
| `probe(asset)` | Duration, width, height, audio presence, and video codec |
| `extractFrame(asset, 'first' \| 'last' \| seconds, producedBy?)` | One PNG frame |
| `trim(asset, {startSec, endSec?, reencode?}, producedBy?)` | A cut clip; re-encoding (the default) cuts on the exact frame, stream copy cuts on the nearest keyframe |
| `concat(assets, producedBy?)` | The clips joined in order; stream copy first, re-encoding when the inputs disagree |

A failed command throws `MediaError` with the command's stderr.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`run` creates a scratch directory, expands placeholders in the arguments and in any declared text files, resolves the program, and executes it with a timeout. With `ctx.subprocess` mounted the command runs in the harness's managed process range with collected stdout and stderr; otherwise `child_process.execFile` runs it. After exit, each declared output is read from the scratch directory into the store, which deduplicates identical bytes, and the directory is removed.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `vhMedia`: run, probe, extractFrame, trim, concat |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@video-harness/assets`](../assets/README.md) — where inputs come from and outputs go.
- [`@video-harness/tools`](../tools/README.md) — the tools that call this service.

-----

<a id="model-experience"></a>
## Model Experience

None, as the service runs media commands and stores files; a tool decides what the model learns about the result.

#### KV Cache effect

None; the service sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Video-only concatenation fallback** — the re-encoding fallback of `concat` drops audio; clips with audio that need re-encoding keep only their video.
- **No GPU encoders** — trims and joins re-encode with `libx264` on the CPU.
