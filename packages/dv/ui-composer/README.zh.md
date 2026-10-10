---
description: "DreamVerse 对 DSH 对话输入框的补充：项目内容的 @ 来源和引用行、渲染工具卡片、带面向创作者名称和在历史中查看链接的工具行，以及 dv:compose 预填。"
kind: "package-reference"
---

# @dv/ui-composer

[English](README.md) | 中文

## 概述

使用本包让 DSH 对话输入框适配 DreamVerse 项目。输入 `@`，或在输入框的 ＋ 菜单里选 引用，会把所打开项目的片段、角色、场景、风格和素材列为引用标签。对话里的 DreamVerse 工具行显示面向创作者的名称，渲染卡片显示提示词、状态和渲染出的视频，在历史中查看 链接选中调用的记录。画布和素材库面板通过 `dv:compose` 预填输入框。智能体在对话里征求用户同意。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在叠了 `dsh-web-app`（提供对话、输入触发器、UI 插槽和右侧栏）、`@dv/api`（提供状态和操作路由）和 `@dv/chat-references`（展开已发送消息里的 `dv:` 提及）的 profile 里挂载插件。先构建浏览器 bundle：`pnpm run build` 会写出 `lib/client.js`。

```yaml
- id: dv-ui-composer
  name: '@dv/ui-composer'
```

Host 半边不注册任何东西。浏览器半边注册 `@` 来源 `dv-project`；DSH 的 `commandUi` 服务挂载时，通过它注册 ＋ 菜单行 引用；以及 UI 插槽条目 `conversation.input.left`（ID 为 `dv-composer-compose`，不渲染任何内容，让每个已挂载的会话输入框成为 `dv:compose` 的目标）、`conversation.input.permission`（一个空条目）、`conversation.chat.markdown`（一个 chain 条目，按 `/dv/assets/<id>` 路径匹配链接、图片和表格），并为 `DV_TOOL_LABELS` 里的每个工具注册 `tool.call.toolview`：`dv_shot_render_ref2va` 和 `dv_shot_render_t2va` 用 `RenderCard`，其他每个工具用 `ToolLabelRow`。它还为每个有名称的工具在 DSH 的 `chat` 字典里加一条 `tool.name.<tool>`，运行中分组的标题读取它。

| 手势 | 请求或事件 |
| --- | --- |
| 输入 `@`，或在 ＋ 菜单里选 引用 | 对所打开项目的当前状态调用 `GET /api/dv/state`；入口页不列出任何内容 |
| 在历史中查看 | `dv:history-focus` `{session, toolCall}`；历史面板选中该工具调用写下的记录 |
| 发送带 `dv:asset/<id>` 标签或附加图片的消息 | 消息原样发出；Host 上的 `@dv/chat-references` 导入这些图片，并把它们和被提及的素材放到画布上 |
| 来自其他视图的 `dv:compose` | 最新挂载的输入框用其文字替换草稿，并为每个引用追加一个标签；不发送任何内容 |

`@` 列表读项目的当前状态：按时间线名字和位置列出的每个片段（未命名的时间线为 时间线 1 · 片段 2），每个角色、场景和风格的最新版本，以及最新的 40 个图片和视频素材；选中一项会插入一个标签，其文字为 `@[<label>](dv:<kind>/<id>)`。引用 行在草稿末尾打开同一个列表。渲染卡片显示工具名称（参考图生成镜头 或 文字生成镜头）、提示词、状态 渲染中…、已渲染 或 未渲染，以及渲染出的视频。其他每个有名称的工具行显示工具名称和状态 进行中…、完成 或 未完成。每张已结束的渲染卡片，以及调用写了记录的每个已结束的行，都有 在历史中查看 链接。`dv:compose` 事件还会把 对话 标签提到前面。本包隐藏 DSH 的文件权限标签，并用 DreamVerse 主题变量绘制 对话 标签里的输入框卡片、＋ 按钮和发送按钮。

在已结束的对话 Markdown 里，路径为 `/dv/assets/<id>` 且素材为视频的链接变成一张 16:9 小卡片，显示视频首帧、播放标记，下方是说明文字：镜头 N，N 是输出包含该视频的 `shot.render_ref2va` 或 `shot.render_t2va` 记录的 `shot` 参数；没有这样带镜头号的记录时为 视频；点击后在覆盖整个页面的播放器中带控件播放视频，播放器上方显示与卡片相同的说明，播放器从卡片放大出来，放大结束后开始播放，关闭时缩回卡片（`@dv/ui-kit/zoom.ts`）；按 Escape、点击背景或关闭按钮关闭播放器，不离开页面。每个表体行都链接这类视频的表格变成三列卡片网格，每张卡片的说明是该行其他单元格用 ` · ` 连接的文字（例如 `1 · 直播间开场「来一把吧」`）。图片素材的 Markdown 图片变成最宽 240 px 的缩略图，点击后在同样覆盖整个页面的查看器中放大显示，查看器从缩略图放大出来，关闭时缩回缩略图。素材类型和镜头号来自所打开项目的当前状态，每次项目事件后重新获取；素材类型变化时，已打开的播放器继续播放。其他链接、图片和表格保持 DSH 的渲染。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

没有输入框挂载时到达的 `dv:compose` 事件会等到下一个挂载的输入框；输入框拒绝的标签退回为其纯文本引用。工具行从调用结果的展示元数据得知调用是否写了记录：操作工具和写记录的 `dv_proj_*` 工具在 `record` 中写明所写的记录，只读操作（如 `inspect.image`）写 `record: ''`，只读的 `dv_proj_*` 工具（`dv_proj_open`、`dv_proj_state`、`dv_proj_history_list`、`dv_proj_wait`）和失败的调用没有元数据。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Host 半边，不注册任何东西 |
| [`src/css-modules.d.ts`](src/css-modules.d.ts) | CSS Module 导入的类型 |
| [`src/client/index.ts`](src/client/index.ts) | 注册：`@` 来源、＋ 菜单行、UI 插槽条目、工具名称和 `dv:compose` 监听 |
| [`src/client/mention.ts`](src/client/mention.ts) | `@` 来源、其项目内容和引用文字 |
| [`src/client/asset-kinds.ts`](src/client/asset-kinds.ts) | 所打开项目素材的视频与图片索引，以及每个镜头视频的镜头号 |
| [`src/client/chat-media.ts`](src/client/chat-media.ts) | `conversation.chat.markdown` 条目，以及它对链接、图片和表格的选择 |
| [`src/client/ChatMedia.tsx`](src/client/ChatMedia.tsx) | 视频卡片、镜头网格和图片缩略图 |
| [`src/client/compose.ts`](src/client/compose.ts) | 把 `dv:compose` 交给最新挂载的输入框 |
| [`src/client/views.tsx`](src/client/views.tsx) | 渲染卡片、工具行和历史链接 |
| [`src/client/views.module.css`](src/client/views.module.css) | 渲染卡片、工具行和历史链接的样式 |
| [`src/client/composer.css`](src/client/composer.css) | 对话 标签里输入框卡片、＋ 按钮和发送按钮的样式 |
| [`src/client/tool-labels.ts`](src/client/tool-labels.ts) | 加到 DSH `chat` 字典里的工具名称 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/chat-references`](../chat-references/README.zh.md) — 把已发送消息里的 `dv:` 提及展开成一条带记录和素材 ID 的上下文消息。
- [`@dv/project`](../project/README.zh.md) — `dv:project` 提示词段落，它让智能体在对话里征求用户同意，并把问题加粗。
- [`@dv/ui-history`](../ui-history/README.zh.md) — 响应 `dv:history-focus` 的历史面板。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — API 客户端、wire 类型、compose 事件和工具名称。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dv/chat-references`：它把已发送消息里的 `dv:` 提及变成一条 `dv-mentions` 上下文消息。

#### KV Cache 影响

本包本身无影响；`dv-mentions` 上下文消息跟在它所展开的用户消息之后，其影响见 `@dv/chat-references` 的 README。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **`@` 列表读当前状态** — `@` 列表和 引用 行读项目的当前状态，所以被撤销移出状态的片段、角色、场景或风格不会列出；素材仍会列出，因为状态列出了历史中的每个素材。
- **卡片等待素材索引** — 所打开项目的状态加载完成前，以及当前状态未列出的素材（当前位置之后的步骤渲染的镜头），其链接和图片保持 DSH 的渲染。
