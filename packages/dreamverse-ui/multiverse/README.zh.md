---
description: "以 DSH 浏览器插件实现的 DreamVerse Multiverse 页面：创建分支故事，全屏播放你自己的世界线并在每个场景结束时选择，在开发模式中查看每条世界线。"
kind: "package-reference"
---

# @dreamverse/ui-multiverse

[English](README.md) | 中文

## 概述

本包是 `dreamverse-multiverse` profile 的页面。用户在 DreamVerse 创作工作室中开始一个故事，然后全屏播放它：一个场景结束时，它的两个后续走向显示为按钮，选择其中一个会生成下一个场景，同时画面停留在最后一帧。玩家只看到自己的世界线，永远不能回退。开发模式水平绘制每条世界线，并可以生成任何被提议的分支。页面 URL 能在 harness 重启后重新打开 multiverse。

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

与填充其 slot 的 `@dreamverse/ui-creation` 和 `@dreamverse/ui-assets`，以及提供其 API 的 `@dreamverse/multiverse` 一起挂载该插件。[`@dreamverse/multiverse-bundle`](../../bundle/dreamverse-multiverse/README.zh.md) 补丁会挂载所有这些内容。

### 最小配置

```yaml
- id: multiverse-ui
  name: '@dreamverse/ui-multiverse'
```

浏览器部分用 Multiverse 页面填充外壳的 `root` slot，并声明两个 DreamVerse 页面 slot：`dreamverse.creation-studio` 和 `dreamverse.asset-library`。它安装与 `@dreamverse/ui-kit` 相同的缺席 `session` scope，并打包 kit 的 Tailwind 样式表、页头和按钮，但不挂载 kit。它把页面的中英文文案（包括它所渲染的 kit 页头的标签）注册为 `dreamverse.multiverse` locale 命名空间，并在 `root` 注册上声明该命名空间，因此 profile 必须挂载提供 `locale` 服务的 `@deepseek-ai/dsh-client-locale`。页面以页面当前语言显示文案；节点标签与走向、场景错误和服务器错误消息保持原样。Host 部分不注册任何内容，因此该 profile 不提供 `/logo.svg` 或图标。

### 页面模式

- **创建**——`MultiverseApp` 从 `/multiverse/api/capabilities` 加载创建能力，用 `resolveReferenceAssetIds` 把附加的参考图上传到素材库，并用 `buildCreationInitPayload` 加上提示词创建 multiverse。harness 把选中的素材库图片复制进 multiverse 的项目。
- **玩家模式**——默认的 `PlayerView` 全屏播放玩家的当前场景。场景播放到结尾时，它的分支作为半透明按钮出现在画面底部；选择一个会生成它，同时画面停留在上一个场景的最后一帧，然后播放新场景。
- **开发模式**——选中的场景在 `WorldLines` 上方播放，`WorldLines` 以从左到右的时间轴绘制每条世界线。玩家的世界线沿顶部车道笔直延伸并以实线绘制；其他每条世界线在每个场景的第一个分支处保持其车道，其他每个分支在下方开辟一条车道。Choose 按钮可以生成任何被提议的分支，开发模式会选中每个完成生成的场景。

页面 URL 保存 multiverse（`multiverse`）、玩家的当前场景（`node`）和开发模式（`dev=1`）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

页面每秒读取一次 `GET /multiverse/api/multiverses/<id>`，而不是使用服务器发送的 `events` 路由，因为 Cloudflare 快速隧道会扣住该路由的响应体，直到响应结束。场景播放期间，页面在一个隐藏图片中加载该场景的最后一帧，因此下一次生成期间停留的画面能立即显示。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | 文档设置、`session` scope、字典注册与 `root` 注册 |
| [`src/client/locales.ts`](src/client/locales.ts) | `dreamverse.multiverse` 命名空间的 `zh` 与 `en` 字典 |
| [`src/client/MultiverseApp.tsx`](src/client/MultiverseApp.tsx) | 创建、URL 状态与模式切换 |
| [`src/client/PlayerView.tsx`](src/client/PlayerView.tsx) | 玩家模式 |
| [`src/client/WorldLines.tsx`](src/client/WorldLines.tsx) | 开发模式的世界线 |
| [`src/client/api.ts`](src/client/api.ts) | `/multiverse/api` 客户端、轮询、失败调用的显示文本，以及页面的 `NodeId`，它用宿主类型的标签为每个响应中的节点 ID 加上品牌 |

`tests/` 目录覆盖页面和插件注册。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dreamverse/multiverse`](../../dreamverse/multiverse/README.zh.md)——API、树和分支提议。
- [`@dreamverse/ui-creation`](../creation/README.zh.md) 与 [`@dreamverse/ui-assets`](../assets/README.zh.md)——被复用的 DreamVerse 页面包。
- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——Multiverse 工作负载（workload）。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dreamverse/multiverse`：它把开场提示词和用户在这里选择的分支转换为提示词增强请求、分支提议请求和片段请求。

#### KV Cache 影响

无；除了用户自己的输入，页面不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有标志或图标**——该 profile 不提供 `/logo.svg` 或 `/icon-simple.svg`，因此页头的标志图片无法加载，标签页也没有 DreamVerse 图标。
- **生成后才播放**——场景只在完成生成后播放；页面没有渐进播放。
- **轮询**——页面打开期间每秒读取一次完整的 multiverse。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
