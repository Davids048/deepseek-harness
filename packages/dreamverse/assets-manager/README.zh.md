---
description: "DreamVerse 文件存储：带媒体校验的素材库上传、项目所有的文件、参考图副本、延迟删除，以及 /assets HTTP 路由。"
kind: "package-reference"
---

# @dreamverse/assets-manager

[English](README.md) | 中文

## 概述

使用本包把所有 DreamVerse 文件放在一处：用户上传到素材库的图片、视频和音频，以及属于项目的片段视频、末帧和参考图副本。上传按 FastVideo 参考实现校验，harness 写入的文件只在完整后才出现，正在使用的文件在最后一个读取者结束前保持可读。删除项目会删除其文件；删除素材库文件永远不会改变项目。视频与音频检查需要 `ffprobe`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

每个 harness 挂载一次该服务；每个 DreamVerse 工作负载（workload）都注入 `dreamverseAssetsManager`。

### 最小配置

DreamVerse 组合包用状态根目录下的 `assets` 目录挂载该服务：

```yaml
- id: dreamverse-assets-manager
  name: '@dreamverse/assets-manager'
  config:
    root: /home/user/.local/state/fastvideo/dreamverse/assets
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | 必填 | 存放 `files/<asset_id>` 和 SQLite 索引 `index.sqlite3` 的目录 |

### 文件所有者

每个文件恰好有一个所有者：用户的素材库（`library`）或一个项目（`project:<project_id>`，由 `projectOwner(projectId)` 构造）。记录只保存文件本身可见的事实：名称、媒体类型、MIME 类型、大小、尺寸、时长和创建时间。素材 ID 是带品牌的字符串 `AssetId`：服务为它创建的、从索引或 `/assets` 路径读取的 ID 加上品牌，从请求读取素材 ID 的调用方用 `@deepseek-ai/dsh-brand` 的 `brandString` 为其加上品牌。

- `add` 存储一次素材库上传。图片经过 `sharp`（内容格式、像素上限、动画、完整解码）；视频和音频按参考实现的参数经过 `ffprobe`。被拒绝的上传抛出带参考消息的 `MediaValidationError` 或 `UploadTooLargeError`。
- `createWriter` 把 harness 产生的文件（例如流式传输中的片段视频）写到 `files/<asset_id>.partial`。`commit` 检查该文件（不套用上传上限）、重命名并建立索引；`abort` 和失败的提交会删除该部分文件。`addBytes` 以同样方式写入一个完整文件。
- `copy` 给另一个所有者一份带新 ID 的自有副本。项目会复制它使用的每张素材库图片，因此删除任一文件都不影响另一份。
- `retain` 和 `release` 包住每次生成请求和每次内容响应。`delete` 和 `deleteOwnedBy` 立即隐藏文件，并在最后一次释放后删除被保留的文件。

### HTTP 路由

在 DSH web 服务器（`webServer`）可用期间，服务注册一个 `/assets` 前缀路由。素材 JSON 携带 `asset_id`、`owner`、`name`、`media_type`、`mime_type`、`size_bytes`、`width`、`height`、`duration_sec`、`created_at` 和 `content_url`。

| 路由 | 行为 |
| --- | --- |
| `GET /assets` | `{"assets": [...]}`：素材库的文件，最新的在前 |
| `POST /assets` | 向素材库上传 multipart `file`：201 并返回记录；被拒绝的上传返回 400 或 413；缺少 `file` 字段返回 422 |
| `GET /assets/{asset_id}/content` | 任意所有者的文件，支持 `Range`；未知或已删除的文件返回 404 |
| `DELETE /assets/{asset_id}` | 素材库文件返回 204；未知或已删除的文件返回 404；项目的文件返回 409，它随项目一起删除 |

DSH 页面外壳从 `./assets/` 加载自己的脚本和样式，因此 `/assets` 下未匹配任何素材路由的 GET 或 HEAD 请求会通过 `@deepseek-ai/dsh-host-frontend-static` 提供外壳的文件。浏览器模块 `@dreamverse/assets-manager/client/assets.ts` 为页面列出、上传和删除素材库文件，并用宿主类型的品牌标签声明页面的 `AssetId`；它为每个响应中的素材 ID 加上品牌。没有服务器 `detail` 而失败的请求抛出带 `failure` 代码的 `AssetRequestError`，由页面翻译；服务器的 `detail` 仍作为错误消息。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`AssetLibrary` 拥有文件目录和索引，索引由 `node:sqlite` 打开。索引在 `PRAGMA user_version` 中记录 `SCHEMA_VERSION`（1）。未标版本的索引（参考实现的布局）在一个事务中迁移：已有文件归素材库所有，`created_at` 取自每个文件的修改时间，早期 harness 构建中的 `asset_references` 表被删除。版本更新的索引无法打开，报错会同时给出两个版本。服务启动时会删除残留的 `.partial` 文件。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dreamverseAssetsManager` 服务及其 `/assets` 路由注册 |
| [`src/library.ts`](src/library.ts) | 文件、索引、所有者、写入器、副本、保留与删除 |
| [`src/media.ts`](src/media.ts) | 上传策略，以及用 `sharp` 和 `ffprobe` 进行的媒体检查 |
| [`src/asset-routes.ts`](src/asset-routes.ts)、[`src/file-response.ts`](src/file-response.ts) | `/assets` 路由与分段文件响应 |
| [`src/shell-files.ts`](src/shell-files.ts) | 回退到 DSH 页面外壳文件的处理 |
| [`src/client/assets.ts`](src/client/assets.ts) | 页面的素材客户端 |

`tests/` 目录覆盖素材库、媒体检查、路由和服务生命周期。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——共享项目层中的文件所有者与参考图副本。
- [`@dreamverse/project-store`](../project-store/README.zh.md)——删除项目时一并删除其文件。
- [`@dreamverse/segment-generation`](../segment-generation/README.zh.md)——写入每个片段的视频和末帧。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dreamverse/segment-generation`：它读取工作负载选中的已存储图片文件，并把它们作为请求图片发送给视频模型。

#### KV Cache 影响

无；文件存储不向模型请求添加任何内容，也不保留模型提供方会复用的状态。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **固定的上传上限**——上传策略使用代码中的参考值：图片最大 15 MiB、16,777,216 像素；视频最大 100 MiB、8,294,400 像素、30 秒；音频最大 100 MiB、30 秒、2 个声道。没有 `Config` 字段可以修改它们。
- **保留按进程计数**——`retain` 计数只存在于一个 harness 进程中。在同一个 `root` 上运行的两个 harness 进程看不到对方的保留，因此一个进程中的删除可能移除另一个进程已保留的文件。
- **从 `PATH` 查找 `ffprobe`**——当 `PATH` 上没有 `ffprobe` 可执行文件时，视频和音频上传以 `MediaValidationError` 失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
