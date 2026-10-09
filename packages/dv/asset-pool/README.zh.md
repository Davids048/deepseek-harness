---
description: "DreamVerse 的素材库组件：dvAssetPool 服务、带 /dv/assets 路由的内容寻址素材存储、当前状态的画布摆放，以及操作 asset.import、asset.grab_still、asset.place 和 asset.unplace 及其智能体工具。"
kind: "package-reference"
---

# @dv/asset-pool

[English](README.md) | 中文

## 概述

使用本包把项目的每张图片、每段视频、每个音频和文本文件只保存一次，并且永不修改。素材的 ID 是其字节的 SHA-256，因此引用某个素材的记录永远指向同样的字节。本服务是项目的素材存储，并向 `dvProject` 注册四个操作：`asset.import`，把一个文件或 base64 字节变成素材；`asset.grab_still`，把视频的一帧变成 PNG 静帧；`asset.place` 和 `asset.unplace`，把素材放到画布上和从画布移除。DSH web server 运行时，本服务在 `/dv/assets/<AssetId>` 提供素材文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 和 `@dv/ffmpeg` 之后挂载插件。其他插件注入 `dvAssetPool`。本服务经 `dvProject.registerAssetStore` 注册自己，因此同一文件导入两次只是一个素材。`asset.import` 经 `dvFfmpeg` 读取图片或视频的像素尺寸和时长，`asset.grab_still` 经 `dvFfmpeg` 运行，`dvProject` 把这四个操作变成智能体工具 `dv_asset_import`、`dv_asset_grab_still`、`dv_asset_place` 和 `dv_asset_unplace`。`asset` 归约函数维护 `placed`，即当前状态中画布上的素材，按放上的顺序排列；`proj` 切片的 `created_by` 记着创建每个素材的记录。画布上有哪些素材属于项目内容：每次摆放都是一条记录，因此历史会列出它，撤销能把它退回。

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
| `asset.import` | `dv_asset_import` | 参数 `path`（本机上的文件）或 `base64`（字节）、`mime`（必填）、`name`（默认：文件名）、`place`（为 true 时同时把素材放到画布上） | `asset` |
| `asset.grab_still` | `dv_asset_grab_still` | 输入 `video`，参数 `at`：`first`、`last`（默认）或以秒计的时间 | `still`（PNG） |
| `asset.place` | `dv_asset_place` | 输入 `asset`（一个或多个）；素材既不是项目的任何记录（包括被丢弃的记录）导入的、也不是当前状态中某一步生成的时返回 `invalid_inputs`，全部素材已在画布上时返回 `invalid_params` | 无 |
| `asset.unplace` | `dv_asset_unplace` | 输入 `asset`（一个或多个）；没有一个素材在画布上时返回 `invalid_params`；素材仍留在素材库 | 无 |

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

`importAsset` 先把字节写到 `objects/<sha>.partial`，再改名到位，因此崩溃不会在哈希名下留下写了一半的对象。索引每个素材一行 `Asset` JSON，在对象文件存在之后追加；启动时服务重放索引，跳过对象文件缺失的行。`asset.import` 用 ffprobe（`dvFfmpeg.probe`）读取条目还不知道的图片或视频的宽、高和时长；文件头里没有时长的视频（浏览器录制的 WebM 文件）用 `-progress pipe:1` 解码一遍，最后一个 `out_time` 就是它的时长。`describe` 把更新后的条目追加到索引，重放时同一 ID 以最后一行为准。探测失败时这些值保持为 null，导入不会因此失败。`grabStill` 对第一帧或给定时间直接定位；对最后一帧，它先探测视频，尝试在视频流结尾前做输入定位，再尝试保留最后一帧的完整解码，因为来自流式后端的分片 MP4 头部没有可靠的时长。路由通过 `ctx.inject` 注册在 `webServer` 上，因此插件在没有 web server 的组合中也能工作。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvAssetPool`：存储、索引重放、路由、四个操作和 `grabStill` |
| [`src/reducer.ts`](src/reducer.ts) | `asset` 归约函数：由 `asset.place`、`asset.unplace` 和带 `place` 的 `asset.import` 得出 `placed` |
| [`src/types.ts`](src/types.ts) | `Asset`，即 `index.jsonl` 的一行，以及 `asset` 切片 `AssetState` |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、智能体工具和素材存储的注册。
- [`@dv/ffmpeg`](../ffmpeg/README.zh.md)：`grabStill` 使用的 ffmpeg 执行器。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：本组件遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

### 工具定义

#### 模型看到什么

四个工具 `dv_asset_import`、`dv_asset_grab_still`、`dv_asset_place` 和 `dv_asset_unplace`，采用 `@dv/project` 给每个操作工具的格式。`dv_asset_import` 的描述是 "Bring a file into the asset pool: a path on this machine, or base64 bytes. Returns the asset ID to reference later."，参数为 `path`、`base64`、`mime`（必填）、`name` 和 `place`（"Also put the asset on the canvas."）。`dv_asset_grab_still` 的描述是 "Grab one frame of a video as a PNG still, to look at it or to use it as a reference." 和 "Runs on the CPU."，接受输入 `video` 和参数 `at`（`'first'`、`'last'` 或以秒计的时间；默认 last）。这两个描述都以 "Repeating a call with the same inputs and params reuses the earlier result." 结尾。`dv_asset_place` 的描述是 "Put assets of the project on the canvas, where the user sees each one as a node. The assets must come from a record in the current state of the project."，`dv_asset_unplace` 的描述是 "Take assets off the canvas. The assets stay in the asset pool."；两者都接受输入 `asset`。

#### Token 影响

四个定义约 1,100 个 token，插件挂载期间固定不变；`@dv/project` 的共享参数让每个定义多约 200 个 token。

#### KV Cache 影响

这些定义位于每次智能体请求中固定的工具部分；挂载或移除插件会改变工具列表，使缓存前缀从工具部分起失效。

### 工具结果

#### 模型看到什么

一次调用返回一个文本块：`done <record>: <summary>`（`imported face.png`、`still at last`、`placed 2 asset(s) on the canvas`），每个输出一行，带素材 ID（其字节的 SHA-256）、媒体类型和 `/dv/assets/<AssetId>` URL，以及参数。挂载了附件服务时，图片输出还以图片块到达。

#### Token 影响

每次调用约 80 个 token 的文本，大部分是 64 个字符的素材 ID 和 URL。带 `base64` 的 `dv_asset_import` 调用会在回显的参数里重复这些字节，因此其结果的开销约等于其参数再来一遍。每个图片块按模型对一张图片的计费计算。

#### KV Cache 影响

结果在调用之后追加到对话中；已缓存的前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不支持 `Range` 请求**：路由发送整个文件；通过该路由在长视频里跳转会从头下载。
- **不删除**：项目中未被引用的素材留在磁盘上；垃圾回收延后到项目可以删除时再做。
- **索引不压缩**：启动时重放读取每一行；素材很多的素材库启动较慢。
