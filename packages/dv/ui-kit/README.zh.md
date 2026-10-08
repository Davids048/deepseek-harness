---
description: "DreamVerse 各视图共用的浏览器代码：/api/dv 客户端、wire 类型、参数表单模型、轨道几何、窗口事件、视图会话 hook、分支切换器、当前分支按钮和分支栏。"
kind: "package-reference"
---

# @dv/ui-kit

[English](README.md) | 中文

## 概述

在 DreamVerse 的浏览器插件里使用本包与 `@dv/api` 通信，并读取它发来的状态。`DvClient` 封装每条 `/api/dv` 路由并跟随 `/dv/events`；`fieldsOf` 和 `paramsOf` 把操作的参数 schema 变成表单字段再变回参数；`useViewSession` 让视图的项目、项目当前分支的状态和操作与宿主同步；`BranchStatus` 是工作区底栏里的小按钮，显示当前分支，展开的列表可以切换分支；`BranchSwitcher` 在历史面板里显示当前分支，并切换、新建和重命名分支；`BranchBar` 是侧栏视图的项目和撤销栏；事件模块拥有各面板之间交换的 `dv:*` 窗口事件和页面全局变量。本包是一个库：它不注册任何东西，会被打进每个消费者的 bundle。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把 `@dv/ui-kit` 加进浏览器插件的 `devDependencies`，按模块逐个导入；包的 `./*` 导出映射到 `src/client/*`，DSH 客户端 bundle 会内联导入的内容。没有 Loader 行。

```ts
import { DvClient } from '@dv/ui-kit/api.ts'
import { useViewSession } from '@dv/ui-kit/useView.ts'
import { DV_TIMELINE_INSERT_EVENT } from '@dv/ui-kit/workspace-events.ts'
```

| 模块 | 内容 |
| --- | --- |
| `types.ts` | `WireState`、`ProjectRecord`、`Branch`、`Asset`、`Timeline`、`Clip`、`WireOperation`、`WireProject`、`ProjectEvent`、`OperationRequest`、`HistoryQuery`、`HistoryEntry`、`WireHistory`、`PlanVersion`、`Shot`（带生成方式 `mode`，即 `ref2va` 或 `t2va`，以及 `continue_previous`）：`@dv/api` 收发的 JSON 的结构类型 |
| `api.ts` | `DvClient`（`listProjects`、`getState`（读当前分支）、`listOperations`、`runOperation`、`importAsset`、`createBranch`、`switchBranch`、`renameBranch`、`undo`、`redo`、`acceptStale`、`listHistory`，项目、布局、工作区和对话调用，`subscribe`）、`ViewSurface`、`DvApiError`、`assetUrl` |
| `form.ts` | `fieldsOf(params, values)`、`paramsOf(fields)`、`FieldParseError`：每个 schema 属性一个控件，带类型转换 |
| `timeline.ts` | `FALLBACK_CLIP_SECONDS`、`timelineName(timeline, numbered)`、`formatSeconds` |
| `references.ts` | `shotReferences(version, shot)`、`referenceImages(state, references)`、`pictureParts(prompt)`：一个镜头发给视频模型的参考图，按提示词里 `Picture 1`、`Picture 2`…… 的编号顺序排列，以及在这些标记处切开的提示词；`t2va` 镜头没有参考图 |
| `state.ts` | `branchLabel`（分支标题；没有标题时 `main` 为 主线 / Main，`b<n>` 为 分支 n / Branch n，其他为分支名）、`entryBranch`（历史条目属于哪个分支：当前分支的线包含该记录时为当前分支，否则为写入记录的分支，再否则为第一个包含该记录的分支）、`assetIndex`、`videoAssets` |
| `useProject.ts` | `useProjects`、`useOperations`、`useProjectState`：每次项目事件都重新拉取的加载器 |
| `useView.ts` | `useViewSession(client, surface, session?)`：项目选择、项目当前分支的状态、操作、最近一次失败和分支栏回调；`sessionFromLocation` 从页面地址的 `?session=` 读对话，让视图打开该对话的项目 |
| `BranchBar.tsx` | 侧栏的栏：项目选择器、新建项目按钮和撤销；文案以 `labels` 传入，由所属插件先本地化 |
| `BranchStatus.tsx` | `BranchStatus`：工作区底栏的 当前分支：<名称> / Current branch: <name> 按钮；点击后展开所有分支的列表（测试 ID `dv-kit-branch-status`、`dv-kit-branch-option`），选择另一个分支时调用 `onSwitch`；按 Escape 或点击外面关闭列表 |
| `BranchSwitcher.tsx` | `BranchSwitcher`：在所有分支的列表里显示当前分支，选择即切换项目的当前分支，另有 新建分支 / New branch 和 重命名 / Rename 按钮（测试 ID `dv-kit-branch-switcher`，属性 `data-branch`）；`branchActions(client, project, surface, run)` 把它们绑定到分支路由 |
| `compose.ts`、`workspace-events.ts` | 窗口事件 `dv:compose`、`dv:timeline-insert`、`dv:canvas-focus`、`dv:history-focus`、`dv:trajectory-focus`、`dv:timeline-focus`（`DV_*_EVENT`）和素材拖拽类型 `application/x-dv-asset` |
| `tool-labels.ts` | `DV_TOOL_LABELS`：每个 `dv_*` 工具的中英文标签，由输入框的工具卡片和历史面板显示 |
| `current-project.ts`、`current-timeline.ts` | 打开的项目和选中的时间线，存在 `window.__dvCurrentProject` 和 `window.__dvCurrentTimeline` 上，用 `dv:current-project` 和 `dv:current-timeline` 通知 |
| `locale.ts` | `useText`、`pickText`：按 `<html lang>` 取一对中英文字符串中的一个 |

`subscribe` 在浏览器有 `EventSource` 时用它，否则每三秒轮询一次。跟随项目的每个 bundle 通过 `window.__dvEventSources` 为每个项目共享一条流；`window.__dvStreams` 记录打开的流数。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`DvClient` 把每个错误响应体解码成 `DvApiError`，保留 HTTP 状态和 `ProjectError` 代码。`useLoader` 在重新加载期间保留上一个值，并忽略输入已变化的响应；`useProjectState` 读取项目的当前分支，并把一阵项目事件合成一次重新拉取，所以任何地方切换分支都会刷新每个视图。`types.ts` 里的类型手工照抄 `@dv/project` 和各组件的类型，因为宿主包不能被导入进浏览器 bundle；记录以 `ProjectRecord` 到达，输入的 `ref` 是存储时的对象。

| 文件 | 内容 |
| --- | --- |
| [`src/client/api.ts`](src/client/api.ts) | 客户端和共享的事件流 |
| [`src/client/form.ts`](src/client/form.ts) | 表单模型 |
| [`src/client/timeline.ts`](src/client/timeline.ts) | 时间线辅助函数 |
| [`src/client/references.ts`](src/client/references.ts) | 镜头参考图和 `Picture N` 标记 |
| [`src/client/useProject.ts`](src/client/useProject.ts)、[`src/client/useView.ts`](src/client/useView.ts) | hook |
| [`src/client/BranchBar.tsx`](src/client/BranchBar.tsx) | 共用的栏 |
| [`src/client/BranchSwitcher.tsx`](src/client/BranchSwitcher.tsx)、[`src/client/BranchStatus.tsx`](src/client/BranchStatus.tsx) | 分支切换器及其 API 绑定，以及当前分支按钮 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/api`](../api/README.zh.md) — 这个客户端读取的路由和 JSON。
- [`@dv/ui-canvas`](../ui-canvas/README.zh.md) 与 [`@dv/ui-timeline`](../ui-timeline/README.zh.md) — 使用这些 hook 和分支栏的两个视图。
- [DreamVerse 各包](../../../docs/subsystems/video-harness.zh.md) — 记录、分支和过期标记的含义。

-----

<a id="model-experience"></a>
## 模型体验

无；浏览器侧的客户端、表单和轨道辅助代码，不触碰任何提示词、schema 或工具结果。

#### KV Cache 影响

无；本包不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **手工复制的 wire 类型** — `types.ts` 照抄宿主的类型；宿主侧新增字段要手工加到这里。
- **扁平表单** — 表单模型把嵌套对象和数组渲染成一个 JSON 文本框。
- **轮询回退** — 没有 `EventSource` 时视图每三秒轮询一次，无法知道变了什么。
