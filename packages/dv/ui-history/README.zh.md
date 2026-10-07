---
description: "DreamVerse 历史面板：项目的编辑历史，每个操作一行，最新的在前，带标记、批准折叠、筛选、产出预览，并能在画布或时间线上定位记录。"
kind: "package-reference"
---

# @dv/ui-history

[English](README.md) | 中文

## 概述

使用本包让 web 应用在对话旁边多一个历史面板。`HistoryPanel` 列出所打开项目来自所有发起者、来源和对话的操作，最新的在前，每条操作记录一行，显示谁做的、何时、状态、缩略图和标记（草稿、已接受、已撤销等）。筛选按发起者、分支、操作类型和时间线缩小行。选中一行会播放它的产出，并在画布或时间线上定位该记录。右侧栏的 `dv-history` 标签类型显示 shell 所打开项目的面板。

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

每行显示带主体的工具名称（修改分镜计划 p1 → v2、参考图生成镜头 7、新建角色「名字」）、谁做的（你、智能体、自动）、多久以前、状态，以及一张缩略图（图片；视频用其版本的静帧，没有静帧时用视频画面；其他文件没有缩略图）。智能体行的第二行显示记录自身的 `intent`，即智能体为这次调用给出的理由。分镜计划批准安排的渲染和时间线记录（`report.scheduled`）折叠在批准行下面，由 渲染 n 个镜头 开关展开。标记有：打开的草稿上为 草稿，草稿被接受后为 已接受，以及 已撤销、已丢弃、已重放；撤销和丢弃的行仍然列出，变淡并划线。撤销和重做记录本身不成行。在当前分支上，当前的一步带 当前，之前的每一步提供 回到这一步（`/api/dv/undo` 带 `to` = 该记录，分支回到这条记录之后），重做能带回的步骤（`WireState.redo_steps`）变淡但不划线；撤销之后的新写入会清空这些步骤，这些行随后划线。一栏放筛选和顶部操作。

```yaml
- id: dv-ui-history
  name: '@dv/ui-history'
```

Host 半边不注册任何东西。浏览器半边注册 `dv-history` 标签类型（侧栏指南页以"历史"提供的页面）和以自身 id `@dv/ui-history` 为键的标签主体，并在收到 `dv:history-focus` 窗口事件时打开该标签。

| 手势 | 请求或事件 |
| --- | --- |
| 打开面板、点"加载更多"翻页、改筛选 | `POST /api/dv/history`，筛选作为 `HistoryQuery` 字段；每页 50 条，下一页用 `before` |
| 选中渲染、设定、分镜计划或素材的行 | `dv:canvas-focus` `{recordId}`；shell 显示画布，画布打开记录的节点 |
| 选中时间线记录或时间线导出的行 | `dv:timeline-focus` `{timelineId, clipId}`；shell 显示时间线，编辑器选中该片段 |
| 选中的智能体行里的"在轨迹中查看" | `dv:trajectory-focus` `{session, toolCall}`；shell 在该对话上打开 轨迹 |
| 顶部的 接受草稿、丢弃、撤销、重做；行上的 回到这一步 | `POST /api/dv/drafts/accept`、`/api/dv/drafts/discard`（经过确认对话框）、`/api/dv/undo`（行上带 `to`）、`/api/dv/redo`，`surface: 'history'` |

`dv:history-focus` 事件 `{session, toolCall}` 清空筛选，找到该工具调用写下的记录，翻页直到它的行已加载，然后选中它。只有标记为 `main` 或 `draft` 的记录会移动中间区域；`proj.*` 记录只被选中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`HistoryPanel` 用 `useProjectState` 读 `main` 的状态以得到分支和对话打开的草稿，并读该对话当前分支的状态以得到时间线和记录。分支筛选 `main` 请求标记 `main` 和 `undone`，草稿请求其 `draft` 记录。时间线筛选发送 `timelineRecords` 从当前分支算出的记录集合：该时间线或其片段的时间线记录和导出（片段属于其 `report.clips` 分配了它的记录所在的时间线），以及创建其片段素材的记录。在 `/dv/events` 上，`update` 事件替换已加载行中的记录，其他事件以 200 ms 防抖重新拉取已加载的窗口。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | 注册，以及收到 `dv:history-focus` 时打开标签 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/HistoryPanel.tsx`](src/client/HistoryPanel.tsx) | 面板、顶部的接受、丢弃、撤销、重做按钮、筛选、行、预览和标签主体 |
| [`src/client/rows.ts`](src/client/rows.ts) | 操作行和批准折叠、带主体的名称、缩略图、相对时间、标记徽标、分支筛选的查询、时间线记录集合和中间区域定位 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/api`](../api/README.zh.md) — 历史路由，以及草稿、撤销和重做的路由。
- [`@dv/project`](../project/README.zh.md) — 历史查询和其条目的标记。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — API 客户端、wire 类型、窗口事件和工具名称。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dv/project`；历史面板的接受、丢弃、撤销和重做写下的记录只经由 [`@dv/project`](../project/README.zh.md) 的 `dv:project` 提示词段落以及 `dv_proj_*` 和操作工具到达模型。

#### KV Cache 影响

无；面板不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **时间线筛选只看当前分支** — 时间线的记录集合来自对话的当前分支，所以丢弃的草稿和其他草稿的记录不会匹配。
- **重新拉取整个窗口** — 每个 `record` 或 `branch` 事件都重新拉取已加载的窗口（最多 200 条）；翻到很早的长历史重新加载慢。
