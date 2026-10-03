---
description: "以 DSH 浏览器插件实现的 DreamVerse 项目历史：当前项目、harness 列出的已存储项目、打开已存储项目、删除项目以及新建项目。"
kind: "package-reference"
---

# @dreamverse/ui-project-history

[English](README.md) | 中文

## 概述

本包绘制 DreamVerse 项目侧边栏。用户看到当前项目和已存储的项目（最近更新的在前），打开一个已存储项目继续创作，删除项目，或新建项目。harness 拥有每个项目，因此每个浏览器中的列表都相同。侧边栏渲染页面传入的内容；页面通过 `/projects` 路由读取和修改项目。

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
- id: dreamverse-ui-project-history
  name: '@dreamverse/ui-project-history'
```

在 kit 声明该 slot 期间，浏览器部分用 `Sidebar`（前端 `components/Sidebar.tsx` 的移植）填充 `dreamverse.sidebar`。Host 部分不注册任何内容。页面用 `GET /projects?kind=dreamverse` 填充列表，通过 `/ws` 消息 `project_open_v1` 打开选中的项目，并通过 `DELETE /projects/<project_id>` 删除项目；被拒绝的删除会在侧边栏中显示原因。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`Sidebar` 以 `SidebarProps` 接收项目列表、当前项目，以及打开、删除和新建项目的回调。它在历史中省略当前项目，因为 Current 条目已显示该项目。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | slot 注册 |
| [`src/client/components/Sidebar.tsx`](src/client/components/Sidebar.tsx) | 项目侧边栏 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dreamverse/project-store`](../../dreamverse/project-store/README.zh.md)——`/projects` 路由。
- [`@dreamverse/ui-kit`](../kit/README.zh.md)——读取并打开项目的页面。

-----

<a id="model-experience"></a>
## 模型体验

无。侧边栏只列出、打开和删除已存储的项目。

#### KV Cache 影响

无；侧边栏不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有 DreamVerse 项目**——列表包含类型为 `dreamverse` 的项目，并省略其他所有类型的项目。
- **没有包内测试**——本包没有 `tests/` 目录；kit 的页面测试把侧边栏作为真实的 `dreamverse.sidebar` 占用者渲染。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
