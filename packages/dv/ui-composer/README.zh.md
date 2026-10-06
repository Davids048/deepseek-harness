---
description: "DreamVerse 对 DSH 对话输入框的补充：项目内容的 @ 来源、渲染前先问和质量/速度开关、等待中的渲染和分镜计划批准的批准卡片、带面向创作者名称和在历史中查看链接的工具行，以及 dv:compose 预填。"
kind: "package-reference"
---

# @dv/ui-composer

[English](README.md) | 中文

## 概述

使用本包让 DSH 对话输入框适配 DreamVerse 项目。输入 `@` 会把所打开项目的片段、角色、场景、风格和素材列为引用标签。输入框旁边的两个开关选择渲染是否等待批准，以及智能体偏重质量还是速度。输入框上方的批准卡片批准或跳过等待中的渲染和分镜计划批准。对话里的 DreamVerse 工具行显示面向创作者的名称，渲染卡片显示其视频，在历史中查看 链接选中调用的记录。画布和素材库面板通过 `dv:compose` 预填输入框。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在叠了 `dsh-web-app`（提供对话、输入触发器、UI 插槽和右侧栏）、`@dv/api`（提供状态和操作路由）和 `@dv/agent-integration`（提供输入框路由并展开 `dv:` 提及）的 profile 里挂载插件。先构建浏览器 bundle：`pnpm run build` 会写出 `lib/client.js`。

```yaml
- id: dv-ui-composer
  name: '@dv/ui-composer'
```

Host 半边不注册任何东西。浏览器半边注册 `@` 来源 `dv-project`，以及 UI 插槽条目 `conversation.input.left`（开关）、`conversation.input.dock`（批准卡片）、`conversation.input.permission`（一个空条目），并为 `DV_TOOL_LABELS` 里的每个工具注册 `tool.call.toolview`。它还为每个有名称的工具在 DSH 的 `chat` 字典里加一条 `tool.name.<tool>`，运行中分组的标题读取它。

| 手势 | 请求或事件 |
| --- | --- |
| 输入 `@` | 对所打开项目的 `main` 调用 `GET /api/dv/state`；入口页不列出任何内容 |
| 切换开关 | `POST /api/dv/composer/mode` `{session, confirm?, speed?}`；开关挂载时读 `GET /api/dv/composer/mode` |
| 等待批准 | `dv_shot_render` 卡片或批准区域挂载期间，每 1.5 秒调用一次 `GET /api/dv/composer/approvals` |
| 批准、跳过、全部批准 | `POST /api/dv/composer/approvals` `{session, id, action}` 或 `{session, all: true, action}` |
| 在历史中查看 | `dv:history-focus` `{session, toolCall}`；历史面板选中该工具调用写下的记录 |
| 来自其他视图的 `dv:compose` | 最新挂载的输入框用其文字替换草稿，并为每个引用追加一个标签；不发送任何内容 |

`@` 列表读 `main` 的状态：按时间线名字和位置列出的每个片段（未命名的时间线为 时间线 1 · 片段 2），每个角色、场景和风格的最新版本，以及最新的 40 个图片和视频素材；选中一项会插入一个标签，其文字为 `@[<label>](dv:<kind>/<id>)`。开关是 渲染前先问 或 直接渲染，以及 质量 或 速度。批准卡片显示提示词、参考图、时长和预计 GPU 秒数，带 批准 和 跳过，多个等待时另有 全部批准。调用写了记录的每个已结束的行都有 在历史中查看 链接。`dv:compose` 事件还会把 对话 标签提到前面。本包隐藏 DSH 的文件权限标签。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

没有输入框挂载时到达的 `dv:compose` 事件会等到下一个挂载的输入框；输入框拒绝的标签退回为其纯文本引用。每个对话的批准列表放在一个共享的 store 里，所以每张卡片和批准区域读同一个列表；刷新失败时保留上一次的列表。工具行从调用结果的展示元数据得知调用是否写了记录：操作工具和写记录的 `dv_proj_*` 工具在 `record` 中写明所写的记录，只读操作（如 `inspect.image`）写 `record: ''`，只读的 `dv_proj_*` 工具（`dv_proj_open`、`dv_proj_state`、`dv_proj_history_list`、`dv_proj_wait`）和失败的调用没有元数据。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Host 半边，不注册任何东西 |
| [`src/client/index.ts`](src/client/index.ts) | 注册：`@` 来源、UI 插槽条目、工具名称和 `dv:compose` 监听 |
| [`src/client/mention.ts`](src/client/mention.ts) | `@` 来源、其项目内容和引用文字 |
| [`src/client/compose.ts`](src/client/compose.ts) | 把 `dv:compose` 交给最新挂载的输入框 |
| [`src/client/api.ts`](src/client/api.ts) | 共享的 API 客户端和每个对话的批准 store |
| [`src/client/views.tsx`](src/client/views.tsx) | 开关、批准区域和卡片、渲染卡片、工具行和历史链接 |
| [`src/client/tool-labels.ts`](src/client/tool-labels.ts) | 加到 DSH `chat` 字典里的工具名称 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/agent-integration`](../agent-integration/README.zh.md) — 输入框路由、批准通道、`dv:` 提及展开，以及携带输入模式的提示词段落。
- [`@dv/ui-history`](../ui-history/README.zh.md) — 响应 `dv:history-focus` 的历史面板。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — API 客户端、wire 类型、compose 事件和工具名称。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过智能体集成（`@dv/agent-integration`）：它把已发送消息里的 `dv:` 提及变成一条上下文消息，把输入模式变成其项目提示词段落里的几行。

#### KV Cache 影响

本包本身无影响；切换开关会改变智能体集成的提示词段落，其影响见该包的 README。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **轮询批准列表** — `dv_shot_render` 卡片或批准区域挂载期间，每个对话每 1.5 秒轮询一次批准列表，所以新卡片最多要这么久才出现。
