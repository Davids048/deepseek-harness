---
description: "视频 harness 的媒体处理服务：在已存素材上运行 ffmpeg 和 ffprobe，做探测、抽帧、裁剪、拼接和声明输出的命令。"
kind: "package-reference"
---

# @video-harness/media

[English](README.md) | 中文

## 概述

使用本包在内容寻址存储的素材上运行 ffmpeg 和 ffprobe。`run` 在一个临时目录里执行一条命令：输入素材被物化成路径，声明的输出被收进 `vhAssets` 并记下产生它们的操作；`probe`、`extractFrame`、`trim` 和 `concat` 是 harness 工具最常用的几条命令，在这里只写一次。挂载了 harness 的子进程服务时命令经它运行，否则经 `child_process` 运行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@video-harness/assets` 之后挂载插件。

```yaml
- id: vh-media
  name: '@video-harness/media'
  config:
    ffmpegPath: /opt/ffmpeg/bin/ffmpeg
    ffprobePath: ffprobe
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `ffmpegPath` | 必填 | ffmpeg 二进制 |
| `ffprobePath` | 必填 | ffprobe 二进制；裸名字在 `PATH` 上解析 |
| `outputLimitBytes` | `1048576` | 每条命令保留的 stdout 和 stderr 字节数 |

| 方法 | 行为 |
| --- | --- |
| `run({argv, inputs, outputs, files?, producedBy?, timeoutMs?})` | 运行一条命令；`{{in:<n>}}` 展开为第 n 个输入的路径，`{{out:<name>}}` 展开为一个声明输出；`argv[0]` 为 `ffmpeg` 或 `ffprobe` 时映射到配置的二进制；每个声明输出事后必须存在 |
| `probe(asset)` | 时长、宽、高、是否有音频、视频编码 |
| `extractFrame(asset, 'first' \| 'last' \| 秒数, producedBy?)` | 一帧 PNG |
| `trim(asset, {startSec, endSec?, reencode?}, producedBy?)` | 裁出的片段；重编码（默认）精确到帧，流复制落在最近的关键帧 |
| `concat(assets, producedBy?)` | 按顺序拼接；先尝试流复制，输入不一致时重编码 |

失败的命令抛出带有 stderr 的 `MediaError`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`run` 创建一个临时目录，展开参数和声明文本文件里的占位符，解析程序，带超时执行。挂载了 `ctx.subprocess` 时命令在 harness 管理的进程范围里运行并收集 stdout 和 stderr；否则由 `child_process.execFile` 运行。退出后每个声明输出从临时目录读入存储（存储按字节去重），然后删除目录。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `vhMedia`：run、probe、extractFrame、trim、concat |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@video-harness/assets`](../assets/README.zh.md) — 输入从哪里来、输出到哪里去。
- [`@video-harness/tools`](../tools/README.zh.md) — 调用本服务的工具。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本服务只运行媒体命令并存文件；由工具决定模型了解到结果的哪些部分。

#### KV Cache 影响

无；本服务不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **拼接回退只保留视频** — `concat` 的重编码回退丢弃音频；需要重编码的带音频片段只保留画面。
- **没有 GPU 编码器** — 裁剪和拼接用 CPU 上的 `libx264` 重编码。
