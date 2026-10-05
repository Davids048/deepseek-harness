---
description: "DreamVerse 浏览器协议：支持创建、打开与接管的 /ws 项目 socket，健康、就绪与创建能力路由，以及页面中不依赖 React 的协议与状态模块。"
kind: "package-reference"
---

# @dreamverse/project-controller

[English](README.md) | 中文

## 概述

本包把 DreamVerse 页面连接到 harness。页面为每个项目打开一个 WebSocket，用来创建项目或重新打开已存储的项目、发送命令，并接收提示词事件和视频流；打开同一项目的第二个窗口会接管它，第一个窗口会被告知原因。本包还响应健康、就绪和创建能力请求，并随附页面的协议客户端、状态 store 和故事预设。socket 每 20 秒 ping 一次，以便在空闲的代理后面保持打开。 已被 [video harness](../../../docs/subsystems/video-harness.zh.md) 取代。

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

在 DSH web 服务器和 DreamVerse 服务之后挂载该插件；它注入 `webServer`、`dreamverseGeneration`、`dreamverseAssetsManager` 和 `dreamverseProjects`，且没有配置。

### 最小配置

```yaml
- id: dreamverse-project-controller
  name: '@dreamverse/project-controller'
```

### 路由

插件在 `ctx.effect` 内用 `registerUpgrade()` 注册 `/ws`，用 `register()` 注册每个 HTTP 路由。每个 HTTP 路由都经 `@dreamverse/http-routes` 分发，因此已知路径上的其他方法返回 FastAPI 的 405，失败的路由返回 Starlette 的纯文本 500。

| 路由 | 行为 |
| --- | --- |
| `/ws` | 每个 socket 一个项目。第一条消息是创建项目的 `project_init_v1`，或打开已存储项目的 `{"type": "project_open_v1", "project_id": ...}`；其他任何第一条消息、缺少 `project_id` 或无法打开的项目都会回复 `{"type": "error", "message": ...}` 并以 1003 关闭。随后发送携带 `project_id` 的 `gpu_assigned`；打开的项目接着报告 `generation_round_status` 为 `idle`。 |
| `GET /health`、`GET /healthz` | `{"status": "ok", "service": "ltx2-streaming-backend", "ts": ...}` |
| `GET /readyz` | 生成后端就绪时返回 200 `{"status": "ready", ...}`；否则返回 503 `{"status": "warming", ..., "detail": "Generation backend is unreachable."}` |
| `GET /creation-capabilities` | 由所服务模型的事实和上传策略构建的参考实现 `lobby_capabilities_as_dict` 载荷 |

连接在 `dreamverseProjectStore` 中持有项目的租约。当另一个连接打开同一项目时，存储会撤销较早的连接：它的项目关闭并被存储，它的浏览器收到 `{"type": "error", "message": "This project was opened in another window."}` 和关闭，然后项目为较晚的连接打开。`/assets` 和 `/projects` 路由属于 `@dreamverse/assets-manager` 和 `@dreamverse/project-store/routes`。

### 页面模块

`src/client/` 存放前端中不依赖 React 的模块，`@dreamverse/ui-*` 各包以 `@dreamverse/project-controller/client/<path>.ts` 导入它们：WebSocket 客户端与 reducer（`ws/`）、页面 store（`stores/`）、创建配置与能力、创建载荷、故事预设、提示词事件，通过 `/projects` 列出、读取、打开和删除已存储项目的 `projects.ts`，以及用宿主类型的品牌标签声明页面 `ProjectId`、`SegmentId` 和 `PromptId` 的 `ids.ts`。这些模块为每个响应和 socket 事件中的 ID 加上品牌，页面为它生成的提示词 ID 加上品牌。这些模块不含页面文案：创建表只保存模式和模型 ID，选择校验函数返回 `CreationSelectionProblem` 代码，没有服务器 `detail` 而失败的项目请求抛出带 `failure` 代码的 `ProjectRequestError`，socket reducer 通过页面的 `noticeText` 回调读取它的两条页面提示。`@dreamverse/ui-*` 各包用自己的 locale 词典翻译这些值；所服务模型对模式的说明和服务器消息保持原样。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`DreamverseProjectController` 用 `ws` 接受每次升级，把 socket 包装为 `BrowserProjectSocket`，并为每个 socket 运行一个 `ProjectConnection`（参考实现 `ProjectConnection` 的移植）。连接是项目的租约持有者：它读取第一条消息，通过 `dreamverseProjects` 创建或打开项目，向其转发浏览器命令，并驱动其排队的轮次。socket 关闭会关闭项目，从而取消进行中的片段并存储项目。卸载插件会移除路由，终止每个 socket，并等待连接完成清理。服务器每 20 秒 ping 一次每个 socket（与参考实现的 uvicorn 服务器默认行为一致），使 Cloudflare 隧道等代理保持空闲 socket 打开。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 插件及其路由注册 |
| [`src/project-controller.ts`](src/project-controller.ts) | 升级、ping 定时器、HTTP 分发与关闭 |
| [`src/project-connection.ts`](src/project-connection.ts)、[`src/project-socket.ts`](src/project-socket.ts) | 单个项目 socket 及其连接 |
| [`src/health-routes.ts`](src/health-routes.ts)、[`src/creation-route.ts`](src/creation-route.ts) | 健康、就绪与创建能力 |
| [`src/client/`](src/client/) | 页面的协议与状态模块 |

`tests/` 目录覆盖控制器、socket 和页面模块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dreamverse/project`](../project/README.zh.md)——每个 socket 驱动的项目。
- [`dreamverse-ui/`](../../dreamverse-ui/README.zh.md)——使用这些协议模块的页面。
- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——进程布局以及与 Python 参考实现的差异。

-----

<a id="model-experience"></a>
## 模型体验

### 故事预设提示词

#### 模型看到什么

当用户从故事预设开始项目时，页面把 [`src/client/prompts/selected_ltx2_continuation_story_presets.json`](src/client/prompts/selected_ltx2_continuation_story_presets.json) 中该预设的 `segment_prompts` 作为 `project_init_v1` 的 `curated_prompts` 发送。没有种子想法时，每条提示词成为一个片段提示词，视频模型原样收到它。

#### Token 影响

每条预设提示词就是一个片段请求的全部文本输入；除非用户改写，预设不产生语言模型请求。

#### KV Cache 影响

每个片段是独立请求；预设是包内的固定文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **固定的 ping 间隔**——20 秒的 socket ping 是代码中的常量；没有 `Config` 字段可以修改它。
- **未使用的开发者工具状态**——`src/client/stores/` 中的页面 store 保留了前端的开发者工具状态和操作（可编辑的提示词草稿、精选提示词上限、提示词编辑器标志），页面从不启用它们。
- **健康载荷使用参考服务名**——`/health`、`/healthz` 和 `/readyz` 报告参考实现的服务名 `ltx2-streaming-backend`。
- **已被 video harness 取代**——[video harness](../../../docs/subsystems/video-harness.zh.md) 用`@video-harness/views` 与 harness 的推流路由取代了本包；本包仅为 `dreamverse` 与 `dreamverse-multiverse` profile 保留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
