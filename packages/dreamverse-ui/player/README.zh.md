---
description: "以 DSH 浏览器插件实现的 DreamVerse 视频播放器：流式项目视频的实时播放、归档片段播放、连接与生成状态，以及片段下载。"
kind: "package-reference"
---

# @dreamverse/ui-player

[English](README.md) | 中文

## 概述

本包绘制 DreamVerse 视频播放器。它在 harness 流式传输项目视频时实时播放，播放用户选中的归档片段，在用户等待时显示连接和生成状态，并提供片段下载。它渲染页面传入的内容，自身不向 harness 发送任何内容。

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

与声明其 slot 的 `@dreamverse/ui-kit` 一起挂载该插件。

### 最小配置

```yaml
- id: dreamverse-ui-player
  name: '@dreamverse/ui-player'
```

在 kit 声明该 slot 期间，浏览器部分用 `VideoPlayer`（前端 `components/VideoPlayer.tsx` 的移植）填充 `dreamverse.player`。kit 的媒体管线通过 `videoRef` 和 `archivedPlaybackRef` props 接管实时和归档 video 元素。Host 部分不注册任何内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`VideoPlayer` 是展示组件：页面拥有流、归档和下载，并把它们的状态和回调作为 `VideoPlayerProps` 传入。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | slot 注册 |
| [`src/client/components/VideoPlayer.tsx`](src/client/components/VideoPlayer.tsx) | 播放器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dreamverse/ui-kit`](../kit/README.zh.md)——为播放器提供数据的页面和媒体管线。
- [`dreamverse-ui/`](../README.zh.md)——其他页面包。

-----

<a id="model-experience"></a>
## 模型体验

无。播放器只显示页面收到的视频和状态。

#### KV Cache 影响

无；播放器不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **bundle 体积大**——bundle 包含整个 `@carbon/icons-react` 库（约 3.9 MB），DreamVerse web 服务器以未压缩形式发送它。
- **没有包内测试**——本包没有 `tests/` 目录；kit 的页面测试把播放器作为真实的 `dreamverse.player` 占用者渲染。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
