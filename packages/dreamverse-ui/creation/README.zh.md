---
description: "以 DSH 浏览器插件实现的 DreamVerse 创作工作室与实时编辑器：创建设置、故事预设、参考图选择、Auto Extension，以及 Rewrite 或 Continue 提示词操作。"
kind: "package-reference"
---

# @dreamverse/ui-creation

[English](README.md) | 中文

## 概述

本包绘制 DreamVerse 用户书写提示词的两个位置。创作工作室用于开始项目：用户输入想法或挑选故事预设，在所服务模型提供的创建设置中做出选择，附加参考图，并开启或关闭 Auto Extension。实时编辑器用于导演运行中的项目：每条提示词要么改写序列，要么从最后一个片段继续。

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

与在 DreamVerse 页面上声明其 slot 的 `@dreamverse/ui-kit` 一起挂载该插件。

### 最小配置

```yaml
- id: dreamverse-ui-creation
  name: '@dreamverse/ui-creation'
```

在页面声明各 slot 期间，浏览器部分用 `CreationStudio` 填充 `dreamverse.creation-studio`，用 `ChatBar` 填充 `dreamverse.chatbar`。Host 部分不注册任何内容。

实时编辑器的 **Prompt action** 选项（`LivePromptModePill`）提供默认的 **Rewrite**（发送 `rewrite_seed_prompts`）和 **Continue from the last segment**（发送 `append_prompt`）。该选择保存在 `projectControlsStore.livePromptRewriteMode`；演示模式隐藏此选项并总是继续。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

这些组件移植前端的 `components/creation/`、`components/ChatBar.tsx`、`HeroTagline.tsx`、`LeaveProjectModal.tsx`，以及 `components/assets/` 中的参考图选择组件。它们从页面以 slot props 接收数据和回调，并读取 `@dreamverse/project-controller` 的创建配置辅助函数。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | slot 注册 |
| [`src/client/components/creation/`](src/client/components/creation/) | `CreationStudio`、编辑器、设置胶囊、预设栏与 Prompt action 选项 |
| [`src/client/components/ChatBar.tsx`](src/client/components/ChatBar.tsx) | 实时编辑器 |
| [`src/client/components/assets/`](src/client/components/assets/) | 参考图选择与预览 |

`tests/` 目录覆盖编辑器、预设栏和参考图选择器。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dreamverse/ui-kit`](../kit/README.zh.md)——传入 slot props 的页面。
- [`@dreamverse/user-actions`](../../dreamverse/user-actions/README.zh.md)——每条提交的提示词在 harness 中的作用。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dreamverse/user-actions`：它把用户在这里提交的提示词和预设转换为提示词增强请求和片段请求。

#### KV Cache 影响

无；除了用户自己的输入，这些组件不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **实时提示词限 500 个字符**——与前端一样，实时编辑器每条提示词最多接受 500 个字符。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
