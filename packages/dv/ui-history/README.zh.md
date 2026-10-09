---
description: "DreamVerse 历史面板：项目唯一一条历史线上的每一条记录，每个操作一行，最新的在前，带批准折叠、产出预览、行上的 回到这一步，并能在画布或时间线上定位记录。"
kind: "package-reference"
---

# @dv/ui-history

[English](README.md) | 中文

## 概述

使用本包让 web 应用在对话旁边多一个历史面板。项目只有一条只增长的历史线（[历史规则](../../../docs/subsystems/video-harness.zh.md#history-rules)），所以面板是一张列表，列出所打开项目来自所有发起者、来源和对话的每一条记录，最新的在前，包括撤销记录。每行显示谁做的、何时、状态和缩略图；选中一行会播放它的产出，若该记录在当前状态中，还会在画布或时间线上定位它。顶部放着撤销按钮，每一行的 ⋮ 菜单提供 回到这一步 / Go back to this step。右侧栏的 `dv-history` 标签类型显示 shell 所打开项目的面板。

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

面板请求项目的每一条记录，最新的在前。每行显示带主体的工具名称（修改分镜计划 p1 → v2、参考图生成镜头 7、新建角色「名字」）、谁做的（你、智能体、自动）、多久以前、状态，以及一张缩略图（图片；视频用其版本的静帧，没有静帧时用视频画面；其他文件没有缩略图）。智能体行的第二行显示记录自身的 `intent`，即智能体为这次调用给出的理由。撤销记录写作 回到「…」，并写出它回到的那一步的名称（那一步尚未加载时写作 回到之前的一步）。分镜计划批准安排的渲染和时间线记录（`report.scheduled`）折叠在批准行下面，由 渲染 n 个镜头 开关展开。最新的一行带 当前。每行末尾有一个 ⋮ 按钮（更多操作），它的菜单提供 回到这一步（`/api/dv/undo` 带 `to` = 该记录，加一步让项目回到紧接这条记录之后的状态）；最新的一行、尚未结束的记录，以及最新一次撤销已经回到的那条记录不提供它（`canGoBack`）。

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
| 顶部的撤销（提示 撤销（Ctrl+Z / ⌘Z）） | `POST /api/dv/undo`，`surface: 'history'` |
| 行 ⋮ 菜单里的 回到这一步 | `POST /api/dv/undo` `{to}`，`surface: 'history'`；被拒绝时显示服务端的消息 |

`dv:history-focus` 事件 `{session, toolCall}` 找到该工具调用写下的记录，翻页直到它的行已加载，然后选中它。只有当前状态中的记录（`state.components.proj.records`）会移动中间区域；其他记录只被选中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`HistoryPanel` 用 `useProjectState` 读取项目的当前状态，以得到时间线和当前状态的记录，并通过 `POST /api/dv/history` 列出历史。`actionRows` 把排定的记录折叠到它们的批准下面，`actionLabel` 为每条记录命名（撤销记录按它的目标命名，沿撤销记录一直找到它回到的那一步），`centerFocus` 决定选中的行定位什么，`canGoBack` 决定哪些行提供 回到这一步。在 `/dv/events` 上，`update` 事件替换已加载行中的记录，`record` 事件以 200 ms 防抖重新拉取已加载的窗口。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | 注册，以及收到 `dv:history-focus` 时打开标签 |
| [`src/client/definition.ts`](src/client/definition.ts) | 标签类型 |
| [`src/client/HistoryPanel.tsx`](src/client/HistoryPanel.tsx) | 面板、带撤销按钮的顶部、带 ⋮ 菜单的行、预览和标签主体 |
| [`src/client/rows.ts`](src/client/rows.ts) | 操作行和批准折叠、带主体的名称、缩略图、相对时间、中间区域定位和 `canGoBack` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [历史规则](../../../docs/subsystems/video-harness.zh.md#history-rules) — 哪些修改是步骤，以及撤销和 回到这一步 做什么。
- [`@dv/api`](../api/README.zh.md) — 历史路由和撤销路由。
- [`@dv/project`](../project/README.zh.md) — 历史查询和撤销。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — API 客户端、wire 类型、窗口事件和工具名称。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dv/project`；历史面板写下的撤销记录只经由 [`@dv/project`](../project/README.zh.md) 的 `dv:project` 提示词段落以及 `dv_proj_*` 和操作工具到达模型。

#### KV Cache 影响

无；面板不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **重新拉取整个窗口** — 每个 `record` 事件都重新拉取已加载的窗口（最多 200 条）；翻到很早的长历史重新加载慢。
- **撤销名称需要目标已加载** — 目标在尚未加载的页上的撤销行写作 回到之前的一步，直到"加载更多"加载那一页。
