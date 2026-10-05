---
description: "视频 harness 的内容寻址不可变媒体存储：SHA-256 素材 ID、每个素材的产生操作、追加写入的索引，以及 /vh/assets 内容路由。"
kind: "package-reference"
---

# @video-harness/assets

[English](README.md) | 中文

## 概述

使用本包把视频项目的每张图片、每段视频、每个音频文件和文本产物只保存一次，并且永不修改。素材的 ID 是其字节的 SHA-256，因此同一文件存两次只是一个素材，而引用某个素材的记录永远指向同样的字节。每个素材记着产生它的操作，使操作日志能把文件追溯到生成它的工具调用。DSH web server 运行时，本服务在 `/vh/assets/<id>/content` 提供素材字节。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用一个根目录挂载插件。其他插件注入 `vhAssets`。

```yaml
- id: vh-assets
  name: '@video-harness/assets'
  config:
    root: /home/user/.local/state/video-harness/assets
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | 必填 | 存放 `objects/<sha256>` 和 `index.jsonl` 的目录；不存在时创建 |

| 方法 | 行为 |
| --- | --- |
| `put(bytes \| {path}, {mime, name?, producedBy?, width?, height?, durationSec?})` | 按哈希存放字节并追加一行索引；内容相同时返回已有 ID 并保留第一条记录 |
| `get(id)` | 记录：`id`、`mime`、`name`、`sizeBytes`、`producedBy`、`createdAt`，以及调用方提供的尺寸 |
| `path(id)` / `read(id)` | 存放文件的路径，或其字节 |
| `has(id)` / `list()` | 是否存在，以及按时间先后的全部记录 |
| `assetIdOf(bytes)` | 这些字节在存储中会得到的 ID，但不存入 |

`GET /vh/assets/<id>/content` 返回整个文件及其 MIME 类型和不可变缓存头；`/vh/assets` 下其他路径或方法返回 404。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`put` 先把字节写到 `objects/<sha>.partial`，再重命名到位，因此崩溃不会在哈希名下留下半写的对象。索引是每个素材一行 JSON，在对象存在之后追加；启动时服务重放索引，并跳过对象文件缺失的行。存储从不解码媒体：宽、高和时长只在调用方提供时保存。路由通过 `ctx.inject` 注册到 `webServer`，所以插件在没有 web server 的组合里也能工作。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `vhAssets`：存储、索引重放和内容路由 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md) — 素材、记录和运行时的关系。
- [`@video-harness/oplog`](../oplog/README.zh.md) — 产生和消费素材的记录。

-----

<a id="model-experience"></a>
## 模型体验

无。该存储按内容哈希保存媒体字节，由工具决定什么进入模型。

#### KV Cache 影响

无；该存储不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不支持 `Range` 请求** — 内容路由整文件发送；通过该路由在长视频中跳转会从头下载。
- **不删除** — 项目不再引用的素材留在磁盘上；垃圾回收延期到项目可删除之后。
- **索引不压缩** — 启动时重放每一行；素材极多的存储启动较慢。
