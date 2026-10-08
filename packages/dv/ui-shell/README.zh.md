---
description: "DSH web 应用之上的 DreamVerse 外壳：中间区域的首页和项目工作区（画布或时间线）、左侧栏的项目导航，以及右侧面板的 对话 / 轨迹 标签。"
kind: "package-reference"
---

# @dv/ui-shell

[English](README.md) | 中文

## 概述

使用本包把 DSH web 应用变成 DreamVerse。没有打开项目时，中间区域显示首页：对话输入框和最近项目。打开项目后，它显示画布或时间线编辑器，用顶栏的 画布 | 时间线 切换。视图下方的底栏放着当前分支按钮（`@dv/ui-kit` 的 `BranchStatus`），显示 当前分支：<名称>；点击后展开所有分支的列表，选择一个就切换项目的当前分支，每个视图都显示当前分支。新建和重命名分支放在历史面板里。左侧栏显示导航：新建项目、首页，以及 项目 → 对话 树。右侧面板多出 对话 和 轨迹 标签。在文本框以外，Ctrl+Z 和 Shift+Ctrl+Z（macOS 上用 Cmd）撤销和重做项目的当前分支。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在叠了 `dsh-web-app`（提供侧栏、会话和 Workspace 服务以及客户端模块加载器）和 `@dv/api`（提供外壳调用的路由）的 profile 里挂载插件。同时挂载 `@dv/ui-asset-pool` 和 `@dv/ui-history`：右侧面板按钮和右侧面板的指南页会打开它们的标签。先构建浏览器 bundle：`pnpm run build` 会写出 `lib/client.js`。

```yaml
- id: dv-ui-shell
  name: '@dv/ui-shell'
```

Host 半边不注册任何东西。浏览器半边以优先级 -1 注册中间区域、导航和品牌名 DreamVerse 以覆盖 DSH 的条目，注册 `dv-chat` 和 `dv-trajectory` 标签类型及其标签主体，以及提供 对话、素材库、历史 和 轨迹 的右侧面板指南页。它还隐藏 DreamVerse 不用的 DSH 界面（欢迎提示、侧栏的品牌图标、新会话按钮和插件入口、输入框统计、上下文用量、Host 斜杠命令），改写几条 DSH 文字，并在浏览器标签页上用 DreamVerse 图标替换 DSH 的图标。工作区顶栏还显示项目名（双击可重命名）、对话标题和右侧面板按钮（右侧栏同款的面板图标，标签为 打开右侧面板 / Open the right panel），只在右侧面板收起时出现，位置就是面板展开时它自己收起按钮所在的角落，点击后打开 对话、素材库 和 轨迹；首页显示标题 今天想做一个什么视频？ 和最多八个最近项目。URL hash 的形式为 `#project=<id>&view=timeline&timeline=t2&session=<id>`，所以刷新、后退和前进都能恢复位置。

| 手势 | 请求或事件 |
| --- | --- |
| 页面加载，之后每 4 秒 | `GET /api/dv/workspaces`，读取项目、其 Workspace 和会话绑定 |
| 新建项目 | `POST /api/dv/projects`，标题取第一个未被占用的 未命名项目（带编号），然后 `POST /api/dv/workspaces` 关联为它创建的 Workspace；在其中打开一个空白对话 |
| 打开项目（导航行或最近项目卡片） | `GET /api/dv/workspaces/sessions` 读取其存储的对话；主会话移到其最近的非空白对话，否则移到一个空白对话 |
| 项目行上的 ＋，或 DSH 的新会话 | 在项目的 Workspace 里新建空白对话；在首页上，DSH 的新会话等于 首页 |
| 重命名项目（双击名字或行菜单） | `POST /api/dv/projects/rename`；项目的 Workspace 同步改名 |
| 删除项目（行菜单，然后确认） | `POST /api/dv/projects/delete`（项目移到回收目录）；关联的 Workspace 被删除，打开中的项目回到 首页 |
| 重命名或删除对话（行菜单） | DSH 的会话重命名，或停止其活动后归档 |
| 主会话位于某项目的 Workspace 但没有绑定 | `POST /api/dv/workspaces/bind` |
| 在底栏 当前分支 的列表中选择一个分支 | `POST /api/dv/branches/switch`，`surface` 为当前显示的视图；然后重新读取状态，被拒绝时显示服务端的消息 |
| 素材库 面板里的 插入片段（`dv:timeline-insert` `{assetId}`） | `POST /api/dv/operation`，`timeline.clip_insert` 插在所选时间线（否则第一条）末尾；当前分支没有时间线时为 `timeline.create`，新建包含该片段的 `t1`；`surface: 'timeline'`；然后显示时间线视图 |
| `dv:canvas-focus` | 显示画布视图 |
| `dv:timeline-focus` `{timelineId, clipId}` | 选中该时间线并显示时间线视图 |
| `dv:trajectory-focus` `{session, toolCall}` | 主会话移到 `session`，然后打开 轨迹 并滚动到该工具调用 |

只有主会话属于打开的项目时，工作区才把对话传给画布和时间线编辑器；在此之前它们的编辑写入 `main`。打开的项目每次变化都以 `dv:current-project` 发布给其他 DreamVerse bundle。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`CenterPanel` 在项目关联和 DSH 的会话、Workspace 列表就绪后恢复 URL 位置，并等到 DSH 自己在启动时恢复上次会话（或 4 秒内没有）之后，因为 DSH 迟到的恢复会替换外壳打开的会话。此后，主会话自己移到另一个项目时（例如智能体把首页对话绑定到它创建的项目），中间区域跟随该项目。项目的对话是其 Workspace 的会话、绑定到它的会话，以及服务器在其目录下存储的会话；绑定到其他项目的会话属于那个项目。每个浏览器标签页在 `sessionStorage` 里为每个 Workspace 保留自己的空白对话，因为 DSH 的 `openWorkspace` 会复用任何空白会话，两个标签页会共用一个对话。首页 Workspace（存放项目创建之前开始的对话的目录，标题为 DreamVerse）替代 DSH 首次使用时的默认 Workspace。关闭 轨迹 会重新挂载 对话 标签的对话，因为 轨迹 中隐藏的输入框在卸载时解除了会话输入编辑器的绑定。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Host 半边，不注册任何东西 |
| [`src/css-modules.d.ts`](src/css-modules.d.ts) | CSS Module 导入的类型 |
| [`src/client/index.ts`](src/client/index.ts) | 注册、新会话和首次使用默认 Workspace 的覆盖、关联轮询，以及 `dv:trajectory-focus` 监听 |
| [`src/client/actions.ts`](src/client/actions.ts) | `ShellActions`：新建、打开、重命名和删除项目与对话，首页，以及右侧面板标签 |
| [`src/client/store.ts`](src/client/store.ts) | 共享状态（打开的项目、视图、时间线、主会话、关联）、URL hash 同步，以及会话 → 项目查找 |
| [`src/client/Center.tsx`](src/client/Center.tsx) | 中间区域：URL 恢复、首页、最近项目、工作区顶栏、视图、带当前分支按钮的底栏，以及窗口事件监听 |
| [`src/client/Navigator.tsx`](src/client/Navigator.tsx) | 左侧导航和品牌名 |
| [`src/client/tabs.tsx`](src/client/tabs.tsx) | 对话 和 轨迹 的标签类型与主体 |
| [`src/client/undo-keys.ts`](src/client/undo-keys.ts) | 调用 `/api/dv/undo` 和 `/api/dv/redo` 的 Ctrl+Z / Shift+Ctrl+Z 窗口监听 |
| [`src/client/chrome.tsx`](src/client/chrome.tsx) | 隐藏和改写的 DSH 界面、右侧面板指南页，以及随界面语言变化的标签标题 |
| [`src/client/InlineRename.tsx`](src/client/InlineRename.tsx) | 行内标题输入框和 ⋯ 行菜单 |
| [`src/client/views.ts`](src/client/views.ts) | 画布和时间线视图，从各自包的源码引入本 bundle |
| [`src/client/shell.module.css`](src/client/shell.module.css) | 中间区域、导航和标签的样式 |
| [`src/client/chrome.module.css`](src/client/chrome.module.css) | 右侧面板指南页的样式 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/api`](../api/README.zh.md) — 项目、Workspace、绑定和操作的路由。
- [`@dv/ui-canvas`](../ui-canvas/README.zh.md) — 中间区域显示的画布。
- [`@dv/ui-timeline`](../ui-timeline/README.zh.md) — 中间区域显示的时间线编辑器。
- [`@dv/ui-history`](../ui-history/README.zh.md) — 历史标签和 `dv:trajectory-focus` 链接。
- [`@dv/ui-kit`](../ui-kit/README.zh.md) — API 客户端、wire 类型、窗口事件，以及当前项目和时间线。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dv/project`；外壳保存的会话绑定和其 插入片段 写下的记录只经由 [`@dv/project`](../project/README.zh.md) 的 `dv:project` 提示词段落以及 `dv_proj_*` 和操作工具到达模型。

#### KV Cache 影响

无；外壳不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **隐藏 DSH 界面依赖 DSH 内部实现** — 外壳按 CSS Module 类名后缀和无障碍标签找到要隐藏的控件，通过私有字段改写 DSH 词典条目和 Host 命令获取函数，并替换服务上的 `uiWorkspace.startSession` 和 `workspaces.initializeDefault`；DSH 改动其中任何一项，被隐藏的界面会重新出现，或覆盖失效而不报错。
- **关联轮询** — 智能体创建的项目和绑定最多 4 秒后才出现在导航里。
