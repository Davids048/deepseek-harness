---
description: "DreamVerse 历史面板：项目历史列表中的步骤，每个操作一行，最新的在前，标出当前位置，之后的步骤变灰，带批准折叠、产出预览、撤销和重做、行上的 回到这一步，并能在画布或时间线上定位记录。"
kind: "package-reference"
---

# @dv/ui-history

[English](README.md) | 中文

## 概述

使用本包让 web 应用在对话旁边多一个历史面板。面板与图像编辑器的历史记录面板相同（[历史规则](../../../docs/subsystems/video-harness.zh.md#history-rules)）：它是一张列表，列出所打开项目来自所有发起者、来源和对话的步骤，最新的在前。当前位置的那一步带 当前，之后的步骤（重做能带回的步骤）变灰。每行显示谁做的、何时、状态和缩略图；选中一行会播放它的产出，若该步骤在当前位置或之前，还会在画布或时间线上定位它。顶部放着撤销和重做按钮，每一行的 ⋮ 菜单提供 回到这一步 / Go back to this step。这些移动不写记录；移动之后的新步骤会丢弃变灰的步骤。右侧栏的 `dv-history` 标签类型显示 shell 所打开项目的面板。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在叠了 `dsh-web-app`（提供右侧栏和客户端模块加载器）和 `@dv/api`（提供面板调用的路由）的 profile 里挂载插件。先构建浏览器 bundle：`pnpm run build` 会写出 `lib/client.js`。

面板请求项目历史列表中的步骤，最新的在前。每行显示带主体的工具名称（修改分镜计划 p1 → v2、参考图生成镜头 7、新建角色「名字」）、谁做的（你、智能体、自动）、多久以前、状态，以及只有渲染行才有的一张缩略图（版本的静帧，没有静帧时用视频画面，什么都没产出时用空方块，让渲染行保持对齐）；其他行只显示文字。智能体行的第二行显示记录自身的 `intent`，即智能体为这次调用给出的理由。分镜计划批准安排的渲染和时间线记录（`report.scheduled`）折叠在批准行下面，由 渲染 n 个镜头 开关展开。当前位置的一行带 当前，它之后的行变灰：文字变淡，缩略图变成黑白。其他每一行末尾有一个 ⋮ 按钮（更多操作），它的菜单提供 回到这一步（`/api/dv/undo` 带 `to` = 该步骤），把当前位置移到那一步，可在当前一步之前或之后。

```yaml
- id: dv-ui-history
  name: '@dv/ui-history'
```

Host 半边不注册任何东西。浏览器半边注册 `dv-history` 标签类型（侧栏指南页以"历史"提供的页面）和以自身 id `@dv/ui-history` 为键的标签主体，并在收到 `dv:history-focus` 窗口事件时打开该标签。

| 手势 | 请求或事件 |
| --- | --- |
| 打开面板、点"加载更多"翻页 | `POST /api/dv/history`；每页 50 条，下一页用 `before` |
| 选中当前状态中渲染、设定、分镜计划或素材的行 | `dv:canvas-focus` `{recordId}`；shell 显示画布，画布打开记录的节点 |
| 选中当前状态中时间线记录或时间线导出的行 | `dv:timeline-focus` `{timelineId, clipId}`；shell 显示时间线，编辑器选中该片段 |
| 选中的智能体行里的"在轨迹中查看" | `dv:trajectory-focus` `{session, toolCall}`；shell 在该对话上打开 轨迹 |
| 顶部的撤销（提示 撤销（Ctrl+Z / ⌘Z）） | `POST /api/dv/undo`；被拒绝时显示服务端的消息 |
| 顶部的重做（提示 重做（Shift+Ctrl+Z / ⇧⌘Z）），当前位置是最后一步时不可用 | `POST /api/dv/redo` |
| 行 ⋮ 菜单里的 回到这一步 | `POST /api/dv/undo` `{to}` |

`dv:history-focus` 事件 `{session, toolCall}` 找到该工具调用写下的记录，翻页直到它的行已加载，然后选中它。只有在当前位置或之前的步骤会移动中间区域；变灰的步骤只被选中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`HistoryPanel` 用 `useProjectState` 读取项目的当前状态，以得到时间线和当前状态的记录，并通过 `POST /api/dv/history` 列出历史。`actionRows` 把排定的记录折叠到它们的批准下面，`actionLabel` 为每条记录命名，`centerFocus` 决定选中的行定位什么（变灰的步骤不定位）。每个条目的 `place` 决定 当前 标记、变灰的行，以及哪些行提供 回到这一步。在 `/dv/events` 上，`update` 事件替换已加载行中的记录，`record` 或 `line` 事件以 200 ms 防抖重新拉取已加载的窗口。

| 文件 | 内容 |
| --- | --- |
| [`src/css-modules.d.ts`](src/css-modules.d.ts) | CSS Module 导入的类型 |
| [`src/client/index.ts`](src/client/index.ts) | 注册，以及收到 `dv:history-focus` 时打开标签 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/HistoryPanel.tsx`](src/client/HistoryPanel.tsx) | 面板、带撤销和重做按钮的顶部、带 ⋮ 菜单的行、预览和标签主体 |
| [`src/client/HistoryPanel.module.css`](src/client/HistoryPanel.module.css) | 面板的样式 |
| [`src/client/rows.ts`](src/client/rows.ts) | 操作行和批准折叠、带主体的名称、缩略图、相对时间和中间区域定位 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [历史规则](../../../docs/subsystems/video-harness.zh.md#history-rules) — 哪些修改是步骤，以及撤销、重做和 回到这一步 做什么。
- [`@dv/api`](../api/README.zh.md) — 历史路由以及撤销和重做路由。
- [`@dv/project`](../project/README.zh.md) — 历史查询、撤销和重做。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — API 客户端、wire 类型、窗口事件和工具名称。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dv/project`；历史面板的移动改变当前状态，当前状态只经由 [`@dv/project`](../project/README.zh.md) 的 `dv:project` 提示词段落以及 `dv_proj_*` 和操作工具到达模型。

#### KV Cache 影响

无；面板不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **重新拉取整个窗口** — 每个 `record` 或 `line` 事件都重新拉取已加载的窗口（最多 200 条）；翻到很早的长历史重新加载慢。
