---
description: "The ffmpeg runner of DreamVerse: the dvFfmpeg service runs ffmpeg and ffprobe over files for the components that grab stills, export timelines, and inspect assets."
kind: "package-reference"
---

# @dv/ffmpeg

English | [中文](README.zh.md)

## Summary

Use this package to run ffmpeg or ffprobe from a component operation. `dvFfmpeg.run` executes one command with input file paths and declared output names, writes the outputs into a directory the caller gives (usually `OperationContext.scratchDir`), and returns their paths; the operation then imports them into the asset pool with `context.importAsset`, so every file it creates is traced to its record. `dvFfmpeg.probe` reads the duration, frame size, codec, and audio presence of a file. The runner never touches the asset pool or a project.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with both binaries; components inject `dvFfmpeg`.

```yaml
- id: dv-ffmpeg
  name: '@dv/ffmpeg'
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
| `run({argv, inputs, outputs, dir, files?, timeoutMs?})` | Runs one command in `dir`; `{{in:<n>}}` expands to the n-th input path and `{{out:<name>}}` to `dir/<name>`; `ffmpeg` and `ffprobe` as `argv[0]` map to the configured binaries; returns the output paths in declaration order and the captured streams |
| `probe(path)` | Duration, video stream duration, width, height, audio presence, and video codec; null where ffprobe reports nothing |

A failed command, an unknown placeholder, or a declared output the command did not write throws `FfmpegError` with the command's stderr.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`run` expands placeholders in the arguments and in any declared text files, writes those files into `dir`, resolves the program, and executes it with a timeout (ten minutes by default). With `ctx.subprocess` mounted the command runs in the harness's managed process range with collected stdout and stderr; otherwise `child_process.execFile` runs it. After exit, `run` checks that every declared output exists in `dir`. `probe` runs ffprobe with JSON output and reads the format and the first video stream.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvFfmpeg`: `run`, `probe`, `FfmpegError` |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/inspector`](../inspector/README.md): reads asset metadata through `probe`.
- [`@dv/project`](../project/README.md): `OperationContext.scratchDir` and `importAsset`.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the operations of `@dv/asset-pool`, `@dv/deliver`, and `@dv/inspector`, whose tool results report the files and probe fields that the service produces.

#### KV Cache effect

None; the service sends nothing to a model and adds no tool.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No GPU encoders**: commands that re-encode use whatever codec their arguments name; the components pass CPU encoders such as `libx264`.
