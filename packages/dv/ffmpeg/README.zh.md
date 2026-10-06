---
description: "DreamVerse 的 ffmpeg 执行器：dvFfmpeg 服务为截取静帧、导出时间线和检查素材的组件对文件运行 ffmpeg 和 ffprobe。"
kind: "package-reference"
---

# @dv/ffmpeg

[English](README.md) | 中文

## 概述

在组件操作里运行 ffmpeg 或 ffprobe 时使用本包。`dvFfmpeg.run` 用输入文件路径和声明的输出文件名执行一条命令，把输出写进调用方给出的目录（通常是 `OperationContext.scratchDir`），并返回它们的路径；随后操作用 `context.importAsset` 把它们导入素材库，所以它创建的每个文件都能追溯到它的记录。`dvFfmpeg.probe` 读取一个文件的时长、画面尺寸、编码和是否有音频。执行器从不访问素材库或项目。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用两个可执行文件挂载插件；组件注入 `dvFfmpeg`。

```yaml
- id: dv-ffmpeg
  name: '@dv/ffmpeg'
  config:
    ffmpegPath: /opt/ffmpeg/bin/ffmpeg
    ffprobePath: ffprobe
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `ffmpegPath` | 必填 | ffmpeg 可执行文件 |
| `ffprobePath` | 必填 | ffprobe 可执行文件；只写名字时在 `PATH` 上查找 |
| `outputLimitBytes` | `1048576` | 每条命令保留的 stdout 和 stderr 字节数 |

| 方法 | 行为 |
| --- | --- |
| `run({argv, inputs, outputs, dir, files?, timeoutMs?})` | 在 `dir` 中运行一条命令；`{{in:<n>}}` 展开为第 n 个输入路径，`{{out:<name>}}` 展开为 `dir/<name>`；`argv[0]` 为 `ffmpeg` 和 `ffprobe` 时映射到配置的可执行文件；按声明顺序返回输出路径和捕获的输出流 |
| `probe(path)` | 时长、视频流时长、宽、高、是否有音频和视频编码；ffprobe 没有报告的字段为 null |

命令失败、占位符未知，或命令没有写出某个声明的输出时，抛出带命令 stderr 的 `FfmpegError`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`run` 展开参数和声明的文本文件里的占位符，把这些文件写进 `dir`，解析程序，并带超时（默认十分钟）执行它。挂载了 `ctx.subprocess` 时命令在 harness 的受管进程范围内运行并收集 stdout 和 stderr；否则由 `child_process.execFile` 运行。退出后，`run` 检查每个声明的输出都在 `dir` 中。`probe` 以 JSON 输出运行 ffprobe，读取格式和第一个视频流。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvFfmpeg`：`run`、`probe`、`FfmpegError` |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/inspector`](../inspector/README.zh.md)：经 `probe` 读取素材元数据。
- [`@dv/project`](../project/README.zh.md)：`OperationContext.scratchDir` 和 `importAsset`。

-----

<a id="model-experience"></a>
## 模型体验

无；该服务只运行命令，由调用它的操作决定模型得知什么。

#### KV Cache 影响

无；该服务不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有 GPU 编码器**：重新编码的命令使用其参数指定的编码器；各组件传入 `libx264` 这样的 CPU 编码器。
