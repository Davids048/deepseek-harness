---
description: "以 DSH 浏览器插件实现的 DreamVerse 页面框架：root slot 及其子 slot、页面组件、共享 UI 组件、媒体播放管线、Tailwind 样式表，以及页面的静态图片。"
kind: "package-reference"
---

# @dreamverse/ui-kit

[English](README.md) | 中文

## 概述

本包在 DSH 页面外壳中绘制 DreamVerse 页面框架。它用 DreamVerse 页面填充外壳的 `root` slot，并声明其他 DreamVerse 页面包所填充的六个子 slot，向每个 slot 传入 FastVideo 前端曾传给对应组件的 props。它还随附这些包共享的组件、hook、媒体管线和 Tailwind 样式表，并提供页面的标志和图标。页面框架的文案来自中文和英文 locale 词典，且页面不需要 DSH 会话。

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

在 `@deepseek-ai/dsh-client-ui-renderer` 和 `@deepseek-ai/dsh-client-locale` 之后挂载 kit；其他 DreamVerse 页面包填充它的 slot。

### 最小配置

```yaml
- id: dreamverse-ui-kit
  name: '@dreamverse/ui-kit'
```

浏览器部分注册 `root`，并带有子 slot `dreamverse.sidebar`、`dreamverse.asset-library`、`dreamverse.player`、`dreamverse.workspace`、`dreamverse.creation-studio` 和 `dreamverse.chatbar`（`src/client/contracts.ts` 中的 `DREAMVERSE_SLOTS`）。`DreamverseApp` 是前端 `app/page.tsx` 的移植，它用 `DreamverseSlotOwners` 中的 props 通过 `renderSlot(name, props)` 渲染每个子 slot。浏览器部分还设置文档标题和 favicon，应用已存储的深色主题，并安装一个绑定始终缺席的 `session` scope 适配器，因为渲染器把 `root` 包在 `session-maybe` scope 中，而 DreamVerse 没有 DSH 会话。

浏览器部分注入 `slots` 和 `locale`。它向 locale 服务注册 `src/client/locales.ts` 中的 `dreamverse.kit` 词典，并以 `locale: 'dreamverse.kit'` 声明 `root`，因此 `DreamverseRoot` 获得 `t` 席位并把它传给 `DreamverseApp`；`DreamverseApp` 用它翻译页头、页面提示、后端就绪提示以及默认的片段与项目标签。`src/client/problemText.ts` 通过调用方的翻译函数，把 `@dreamverse/project-controller` 和 `@dreamverse/assets-manager` 以代码报告的选择问题和请求失败转为文本；kit、`@dreamverse/ui-assets` 和 `@dreamverse/ui-multiverse` 在各自的词典中定义它的键。共享组件 `Header`、`ThemeToggle` 和 `AssetPreview` 不拥有任何文案：每个渲染位置从自己的命名空间传入它们的 `labels`。其他每个 DreamVerse 页面包为自己渲染的文案注册各自的命名空间。

在有 DSH web 服务器可用期间，Host 部分从 `public/` 提供 `/logo.svg`、`/k2.png` 和 `/icon-simple.svg`。

### 构建与测试

`pnpm run build:lib:client` 构建所有浏览器 bundle。打包前，`tsdown.config.ts` 对 `src/client/styles/app.css` 运行 Tailwind CSS 4，并写出被 git 忽略的 `app.generated.css`；Tailwind 为每个 `packages/dreamverse-ui/*/src/client/` 文件中的类名生成工具类。运行中的 harness 提供的是它启动时加载的 bundle，因此重新构建后需要重启它。

```sh
node node_modules/vitest/vitest.mjs run packages/dreamverse-ui
```

每个 `*.client.spec.{ts,tsx}` 文件在 jsdom 中运行，并首先导入 `tests/support/setup.client.ts`（前端测试初始化的移植）。`tests/app/` 中的页面测试用 `tests/support/renderDreamverseSlot.client.tsx` 渲染 `DreamverseApp`，它用真实的占用组件渲染每个 slot，并用各包的英文词典翻译该包的文案。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`DreamverseApp` 保存前端页面曾保存的页面状态：它读取创建能力，通过 `@dreamverse/project-controller` 的模块打开和重新打开项目 socket，列出已存储的项目，并为媒体管线提供数据。`src/client/media/` 通过 `MediaSource` 或 `ManagedMediaSource` 播放流式传输的 fMP4 分块，按片段归档它们，并把归档的片段组装成一个 MP4 文件，用于保存的片段和下载。其他包以 `@dreamverse/ui-kit/<path>` 导入共享组件和辅助函数。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Host 部分：静态图片路由 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器部分：文档设置、`session` scope 与 `root` 注册 |
| [`src/client/contracts.ts`](src/client/contracts.ts) | 子 slot 及其所有者 props |
| [`src/client/locales.ts`](src/client/locales.ts) | `dreamverse.kit` 中文与英文词典 |
| [`src/client/problemText.ts`](src/client/problemText.ts) | DreamVerse 浏览器模块以代码报告的选择问题和请求失败的本地化文本 |
| [`src/client/app/DreamverseApp.tsx`](src/client/app/DreamverseApp.tsx) | 页面 |
| [`src/client/components/`](src/client/components/) | `Header`、`AssetPreview` 和 `ui/` 组件 |
| [`src/client/media/`](src/client/media/) | fMP4 播放管线 |
| [`src/client/styles/app.css`](src/client/styles/app.css) | Tailwind 源样式表 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dreamverse-ui/`](../README.zh.md)——填充 kit 各 slot 的包。
- [Slots 子系统](../../../docs/subsystems/slots.zh.md)——slot 所有者、占用者与 scope。
- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——与 FastVideo 前端的差异。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dreamverse/project`：它把页面在 `project_init_v1` 和后续命令中发送的提示词与设置转换为提示词增强请求和片段请求。

#### KV Cache 影响

无；除了用户自己的输入，页面不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **体积大且未压缩的 bundle**——每个包都打包自己导入的库的副本；只有 React 和 Cordis 通过 DSH 平台模块共享。`@carbon/icons-react` 没有 tree-shaking，因此每个导入 Carbon 图标的 bundle 都包含整个图标库，且 DreamVerse 组合包把 web 服务器的 `compression` 设为 `none`。
- **没有语言切换**——DreamVerse profile 不挂载设置页，因此浏览器语言为中文或英文时页面显示该语言，否则显示英文。来自后端的文本，例如就绪详情、服务器错误和所服务模型对模式的说明，保持后端所写的语言。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
