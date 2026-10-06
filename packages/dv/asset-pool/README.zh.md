---
description: "DreamVerse 的素材库组件：dvAssetPool 服务、带 /dv/assets 路由的内容寻址素材存储，以及操作 asset.import 和 asset.grab_still 及其智能体工具。"
kind: "package-reference"
---

# @dv/asset-pool

[English](README.md) | 中文

## 概述

使用本包把项目的每张图片、每段视频、每个音频和文本文件只保存一次，并且永不修改。素材的 ID 是其字节的 SHA-256，因此同一文件导入两次只是一个素材，而引用某个素材的记录永远指向同样的字节。本服务把自己注册为项目的素材存储（`dvProject.registerAssetStore`），并向 `dvProject` 注册两个操作：`asset.import`，把一个文件或 base64 字节变成素材；`asset.grab_still`，经 `dvFfmpeg` 把视频的一帧变成 PNG 静帧。`dvProject` 把它们变成智能体工具 `dv_asset_import` 和 `dv_asset_grab_still`。DSH web server 运行时，本服务在 `/dv/assets/<AssetId>` 提供素材文件。该组件没有归约函数：`proj` 切片的 `created_by` 记着创建每个素材的记录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 和 `@dv/ffmpeg` 之后挂载插件。其他插件注入 `dvAssetPool`。

```yaml
- id: dv-asset-pool
  name: '@dv/asset-pool'
  config:
    root: /home/user/.local/state/video-harness/assets
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | 必填 | 存放 `objects/<sha256>` 和 `index.jsonl` 的目录；不存在时创建 |
| `publicBaseUrl` | `''` | agent 和聊天卡片显示的素材 URL 的前缀，例如隧道源地址；为空时保持相对路径 |

| 操作 | 工具 | 输入和参数 | 输出 |
| --- | --- | --- | --- |
| `asset.import` | `dv_asset_import` | 参数 `path`（本机上的文件）或 `base64`（字节）、`mime`（必填）、`name`（默认：文件名） | `asset` |
| `asset.grab_still` | `dv_asset_grab_still` | 输入 `video`，参数 `at`：`first`、`last`（默认）或以秒计的时间 | `still`（PNG） |

| 方法 | 行为 |
| --- | --- |
| `importAsset(bytes \| {path}, {mime, name, durationSec?, width?, height?}, createdBy)` | 按哈希保存字节并追加一行索引；相同内容返回已有 ID，保留第一个素材 |
| `get(asset)` | `Asset`：`id`、`mime`、`name`、`size_bytes`、`created_by`、`created_at`、`width`、`height`、`duration_sec` |
| `path(asset)` / `read(asset)` | 存储文件的绝对路径，或其字节 |
| `has(asset)` / `list()` | 是否持有，以及按时间从旧到新的全部素材 |
| `url(asset)` | `<publicBaseUrl>/dv/assets/<AssetId>` |
| `grabStill(video, at, dir)` | 把视频的一帧写成 `dir` 中的 `still.png` 并返回其路径；由操作导入 |

对素材库没有的素材，`get`、`path` 和 `read` 抛出代码为 `unknown_asset` 的 `ProjectError`。`GET /dv/assets/<AssetId>` 返回整个文件及其媒体类型和不可变缓存头；`/dv/assets` 下其他路径或方法返回 404。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`importAsset` 先把字节写到 `objects/<sha>.partial`，再改名到位，因此崩溃不会在哈希名下留下写了一半的对象。索引每个素材一行 `Asset` JSON，在对象文件存在之后追加；启动时服务重放索引，跳过对象文件缺失的行。素材库从不解码媒体：宽、高和时长只在导入方给出时保存。`grabStill` 对第一帧或给定时间直接定位；对最后一帧，它先探测视频，尝试在视频流结尾前做输入定位，再尝试保留最后一帧的完整解码，因为来自流式后端的分片 MP4 头部没有可靠的时长。路由通过 `ctx.inject` 注册在 `webServer` 上，因此插件在没有 web server 的组合中也能工作。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvAssetPool`：存储、索引重放、路由、两个操作和 `grabStill` |
| [`src/types.ts`](src/types.ts) | `Asset`，即 `index.jsonl` 的一行 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、智能体工具和素材存储的注册。
- [`@dv/ffmpeg`](../ffmpeg/README.zh.md)：`grabStill` 使用的 ffmpeg 执行器。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：本组件遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

两个工具 `dv_asset_import` 和 `dv_asset_grab_still`，采用 `@dv/project` 给每个操作工具的格式。一次调用返回一个文本块：状态和摘要（`imported face.png`、`still at last`）、参数，以及带素材 ID、媒体类型和 `/dv/assets/<AssetId>` URL 的输出。挂载了附件服务时，图片输出还以图片块到达。

#### KV 缓存影响

插件挂载期间，两个工具的 schema 是每次 agent 请求的一部分。工具结果与其他工具结果一样进入对话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不支持 `Range` 请求**：路由发送整个文件；通过该路由在长视频里跳转会从头下载。
- **不删除**：项目中未被引用的素材留在磁盘上；垃圾回收延后到项目可以删除时再做。
- **索引不压缩**：启动时重放读取每一行；素材很多的素材库启动较慢。
