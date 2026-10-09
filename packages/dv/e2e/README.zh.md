---
description: "DreamVerse 的浏览器用户故事：用假视频后端和脚本化模型启动随包发布的 video-harness profile，再通过 Playwright 在 Chromium 里操作画布、时间线、素材库、历史面板、对话和导航。"
kind: "package-library"
---

# @dv/e2e

[English](README.md) | 中文

## 概述

使用本包按创作者的使用方式检查 DreamVerse 页面。每个故事用 `dsh web`、假视频后端和脚本化模型启动随包发布的 `video-harness` profile，通过 Playwright 打开 Chromium，执行用户操作，然后断言屏幕、`/api/dv` 路由和模型请求随后显示的内容。故事覆盖画布、时间线编辑器、素材库面板、历史面板、对话，以及项目、对话和面板之间的导航。本包不发布插件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

先构建 `@dv/ui-*` 各包的浏览器 bundle（`pnpm run build`），因为 `dsh web` 提供的是它们的 `lib/client.js` 文件。然后在仓库根目录用本包的配置运行故事，并用 `-t` 按名字选择故事：

```sh
DSH_PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome-linux/chrome \
  node_modules/.bin/vitest run --config packages/dv/e2e/vitest.e2e.config.ts -t "History panel"
```

| 变量 | 含义 |
| --- | --- |
| `DSH_PLAYWRIGHT_EXECUTABLE_PATH` | Playwright 启动的 Chromium 程序；不设置时 Playwright 使用它自己下载的浏览器 |
| `DV_FFMPEG` | 假后端编码视频所用、profile 中 `@dv/ffmpeg` 运行的 ffmpeg 程序；它需要 `libvpx-vp9` 编码器 |
| `DV_E2E_SHOTS`、`DV_NAV_SHOTS` | 失败的对话故事或导航故事在其中留下页面截图的目录 |

| 故事文件 | 故事覆盖的内容 |
| --- | --- |
| [`tests/stories/canvas-timeline.e2e.ts`](tests/stories/canvas-timeline.e2e.ts) | 画布的适配、平移、缩放和浮动编辑器；版本和分镜计划的版本；时间线标签、播放、拆分、裁剪、重排、撤销（没有重做）和导出；没有分支控件、回到这一步 回到更早的状态且之后的状态仍可回到，以及过期标记 |
| [`tests/stories/assets.e2e.ts`](tests/stories/assets.e2e.ts) | 素材库面板：经文件选择器、拖放区和对话导入；项目的每个素材，包括被撤销的导入的素材；预览；插入时间线和画布 |
| [`tests/stories/history.e2e.ts`](tests/stories/history.e2e.ts) | 历史面板：行的顺序、名称、批准折叠、在画布或时间线上定位、实时更新、撤销和 回到这一步 作为唯一一条历史线末尾的 回到「…」 行，以及 Ctrl+Z |
| [`tests/stories/chat.e2e.ts`](tests/stories/chat.e2e.ts) | 对话及其输入框：跨轮次加在历史末尾的智能体修改、撤销之后智能体的修改、在对话中确认、附上的图片、`@` 提及，以及模型请求收到的内容 |
| [`tests/stories/navigation.e2e.ts`](tests/stories/navigation.e2e.ts) | 项目、对话、面板、重新加载、项目链接、浏览器历史和语言切换 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

`tests/harness.ts` 中的 `bootHarness` 在测试进程里启动一个假 streaming_v2 后端和 DSH mock LLM 服务器，写出一个隔离的 DSH home，其 `video-harness` profile 列出 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 和 `@dv/bundle`（链接到本检出），并在一个空闲端口上启动 `apps/cli/src/bin.ts --profile video-harness`。它等待打印出的 token URL，用它换取会话 cookie，并返回一个 `/api/dv` 路由的 JSON 客户端，不经智能体即可准备项目。`close` 停止子进程和两个服务器，并删除临时目录。假后端用极小的画面回应，所以一次渲染不到一秒就完成；`playableVideos` 让它编码颜色随 prompt 变化的 VP9 视频，因为开源 Chromium 构建没有 H.264 解码器。`tests/scripted-model.ts` 中的 `startScriptedModel` 是一个兼容 OpenAI 的 chat-completions 服务器：第一条 `match` 符合最新用户消息的规则提供回复，所以一条消息可以连续驱动多次工具调用，`requests` 保留每个请求供断言使用。

| 文件 | 内容 |
| --- | --- |
| [`tests/harness.ts`](tests/harness.ts) | `bootHarness`、`startFakeBackend`、`waitFor` 和 Playwright 导出 |
| [`tests/scripted-model.ts`](tests/scripted-model.ts) | `startScriptedModel`、`textOf`、`assetIdOf` |
| [`tests/fake-backend-main.ts`](tests/fake-backend-main.ts) | 把假后端作为长期运行的进程启动，供手动浏览器测试使用 |
| [`vitest.e2e.config.ts`](vitest.e2e.config.ts) | 故事测试配置：一次一个文件，测试超时 180 秒 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/bundle`](../../bundle/dv/README.zh.md) —— `video-harness` profile 挂载的插件。
- [`@dv/api`](../api/README.zh.md) —— 测试客户端用来准备项目的路由。
- [`@deepseek-ai/dsh-llm-mock-server`](../../test-support/llm-mock-server/README.zh.md) —— `bootHarness` 的默认模型服务器。

-----

<a id="model-experience"></a>
## 模型体验

无；故事只向脚本化模型发送请求，本包不发布插件、提示词或工具。

#### KV Cache 影响

无；生产环境的模型请求不包含本包的任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **ffmpeg 默认路径与机器相关** —— 没有 `DV_FFMPEG` 时，`tests/harness.ts` 使用 `/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg`；其他机器必须设置这个变量。
- **根目录 e2e 匹配** —— 根目录的 `vitest.e2e.config.ts` 也匹配 `tests/stories/*.e2e.ts`，但钩子超时为 30 秒且并行运行文件，而启动 `dsh web` 最多可能需要 120 秒；请用本包的配置运行故事。
