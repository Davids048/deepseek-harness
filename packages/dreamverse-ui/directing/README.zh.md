---
description: "以 DSH 浏览器插件实现的 DreamVerse 提示词时间线：原始提示词、每次改写与续写事件，以及选择每个条目生成的片段。"
kind: "package-reference"
---

# @dreamverse/ui-directing

[English](README.md) | 中文

## 概述

本包绘制当前显示的 DreamVerse 项目的提示词时间线。用户按顺序看到原始提示词以及之后的每次改写和续写，并选择一个条目来播放它生成的片段。时间线渲染页面传入的内容，自身不向 harness 发送任何内容。

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
- id: dreamverse-ui-directing
  name: '@dreamverse/ui-directing'
```

在 kit 声明该 slot 期间，浏览器部分用 `Workspace`（前端 `components/Workspace.tsx` 的移植）填充 `dreamverse.workspace`。Host 部分不注册任何内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`Workspace` 渲染页面作为 `WorkspaceProps` 传入的、来自 `@dreamverse/project-controller/client/promptEvents.ts` 的 `PromptEvent` 列表，并通过 `onSelectOriginal`、`onSelectEvent` 和 `onSelectCurrent` 回调报告选择。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | slot 注册 |
| [`src/client/components/Workspace.tsx`](src/client/components/Workspace.tsx) | 提示词时间线 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dreamverse/ui-kit`](../kit/README.zh.md)——构建提示词事件的页面。
- [`@dreamverse/project-controller`](../../dreamverse/project-controller/README.zh.md)——提示词事件模块。

-----

<a id="model-experience"></a>
## 模型体验

无。时间线只显示页面收到的提示词事件。

#### KV Cache 影响

无；时间线不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有包内测试**——本包没有 `tests/` 目录；kit 的页面测试把时间线作为真实的 `dreamverse.workspace` 占用者渲染。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
