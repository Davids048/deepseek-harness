# DreamVerse

[English](dreamverse.md) | 中文

DreamVerse 是一个交互式视频故事应用，以 Cordis 插件形式运行在 DeepSeek Harness 内。本页拥有 [`packages/dreamverse/`](../../packages/dreamverse/README.zh.md) 与 [`packages/dreamverse-ui/`](../../packages/dreamverse-ui/README.zh.md) 两个包组的词汇和跨包规则：进程布局、共享项目层、使用该层的工作负载（workload），以及与 FastVideo Python 参考实现的有意差异。各包 README 拥有各自的配置、路由与服务 API。

## 进程布局

每个用户运行一个 harness 实例。用户看到和决定的一切都归 harness 所有：页面、浏览器协议、项目、用户操作、提示词增强、文件存储和产品规则。GPU 机器上的 FastVideo 生成后端负责生成视频；harness 通过 HTTP 访问它，GPU 细节永远不会到达用户。

```text
Browser (the DreamVerse page at the `dsh web:` token URL)
   │  WebSocket /ws and HTTP routes
   ▼
dsh --profile dreamverse  (Node, one instance per user)
   @dreamverse/ui-*                 the page as browser plugins
   @dreamverse/project-controller   /ws project protocol, health, readiness, creation capabilities
   @dreamverse/project              DreamVerse projects, action admission, generation plans, project log
   @dreamverse/user-actions/*       one plugin per user action
   @dreamverse/prompt-enhancer      prompt templates and the Cerebras/Groq provider race
   @dreamverse/segment-generation   one segment's generation and its files
   @dreamverse/project-store        project records, write leases, /projects routes
   @dreamverse/assets-manager       file store, /assets routes
   @dreamverse/generation-client    client for the generation backend API
   │  HTTP requests and server-sent event responses
   ▼
fastvideo serve with a streaming_v2 config  (Python, on the GPU machine)
```

Python 只保留需要 GPU、torch 或 FastVideo 的工作。生成提供方更换时保持不变的一切都属于 harness。`dreamverse-multiverse` profile 用 Multiverse 的行替换 DreamVerse 工作负载的行，并保留相同的共享行。

## 共享项目层

三个包组成一个供所有工作负载使用的薄层。它们不依赖任何工作负载包，也不使用任何 DSH 会话、Workspace 或存储包。

| 包 | 服务 | 职责 |
| --- | --- | --- |
| [`@dreamverse/assets-manager`](../../packages/dreamverse/assets-manager/README.zh.md) | `dreamverseAssetsManager` | 唯一的文件存储：素材库上传以及每个项目的所有文件 |
| [`@dreamverse/project-store`](../../packages/dreamverse/project-store/README.zh.md) | `dreamverseProjectStore` | 项目记录、工作负载数据、写租约和 `/projects` 路由 |
| [`@dreamverse/segment-generation`](../../packages/dreamverse/segment-generation/README.zh.md) | `dreamverseSegmentGeneration` | 单个片段的生成、其已存储的视频与末帧，以及共享生成规则 |

该层使用以下术语：

| 术语 | 含义 |
| --- | --- |
| 项目 | 一个用户工作单元，带有 ID、标题、缩略图和工作负载数据。harness 拥有每个项目；页面不保存项目内容。 |
| 类型（kind） | 拥有项目的工作负载，例如 `dreamverse` 或 `multiverse`。一个项目恰好有一种类型，创建时固定。 |
| 工作负载数据 | 工作负载自己的 JSON 值及其 schema 版本。项目存储保存它但不解释它。 |
| 文件所有者 | 用户上传的文件为 `library`，某个项目的文件为 `project:<project_id>`。每个文件恰好有一个所有者。删除项目会删除其文件。 |
| 参考图副本 | 项目使用的素材库图片在项目中的自有副本。删除素材库图片不会改变该项目。 |
| 租约 | 写入某个项目的权利。同一时刻只有一个持有者持有项目的租约；新持有者会先撤销当前持有者。租约只存在于单个 harness 进程内。 |
| 片段 | 一段生成的视频及其末帧，作为请求它的项目的两个文件存储。 |

## 工作负载

工作负载是一组包，为某一类型的项目提供行为和页面。

- **DreamVerse**（`dreamverse`）：[`@dreamverse/project`](../../packages/dreamverse/project/README.zh.md) 保存项目状态及其日志，[`@dreamverse/user-actions`](../../packages/dreamverse/user-actions/README.zh.md) 执行用户操作，[`@dreamverse/project-controller`](../../packages/dreamverse/project-controller/README.zh.md) 提供 `/ws` 协议，[`dreamverse-ui`](../../packages/dreamverse-ui/README.zh.md) 各包绘制页面。[`@dreamverse/bundle`](../../packages/bundle/dreamverse/README.zh.md) 补丁挂载它们。
- **Multiverse**（`multiverse`）：[`@dreamverse/multiverse`](../../packages/dreamverse/multiverse/README.zh.md) 把分支故事作为片段树来生长，[`@dreamverse/ui-multiverse`](../../packages/dreamverse-ui/multiverse/README.zh.md) 绘制它。[`@dreamverse/multiverse-bundle`](../../packages/bundle/dreamverse-multiverse/README.zh.md) 补丁挂载它们。

## 生成后端

FastVideo 拥有 [`@dreamverse/generation-client`](../../packages/dreamverse/generation-client/README.zh.md) 调用的 streaming_v2 API。一次请求生成一个片段，后端在请求之间不保留状态。harness 负责片段之间的连续性：[`@dreamverse/segment-generation`](../../packages/dreamverse/segment-generation/README.zh.md) 决定每个请求携带哪些图片，并存储下一个片段起始所用的末帧。

## 与 Python 参考实现的差异

FastVideo 检出目录中 `apps/dreamverse/dreamverse/` 下的 Python DreamVerse 服务器是行为参考。对于相同的浏览器消息、模型回复和生成媒体，harness 按相同顺序发送相同的浏览器事件，并写入相同的项目日志事件，以下差异除外：

- harness 不发送 `queue_status`，GPU 状态留在后端内：不提供 `/status` 与 `/internal/monitor/capacity`，`/readyz` 报告后端就绪状态但不含 GPU 数量，`gpu_assigned` 项目日志事件不带 `gpu_id`。
- 移除了提示词安全过滤器。
- 不提供仅用于 LTX 的 LoRA 路由。
- DSH web 服务器响应所有未被 DreamVerse 路由认领的路径：`/` 提供受令牌保护的 DreamVerse 页面，其他未认领路径得到 web 服务器的响应，而不是 FastAPI 的 JSON 404。在 `/assets` 下，未匹配任何素材 GET 路由的 GET 和 HEAD 请求会提供 DSH 页面外壳的文件。
- 未移植开发者工具：harness 不提供 `/curated-presets`、`/curated-presets/append` 或 `/prompt-system-config` 路由，提示词模板加载时不使用 `prompts.local` 开发者覆盖层。
- 浏览器不能选择改写设置：`project_init_v1` 和 `rewrite_seed_prompts` 忽略 `rewrite_model`、`rewrite_temperature`、`rewrite_window_system_prompt` 和 `rewrite_user_system_prompt`，`set_rewrite_model` 与 `set_rewrite_temperature` 是不受支持的命令。
- 片段之间的条件输入由 harness 而非后端保存：每个延续片段把前一片段的末帧作为请求图片发送，一次选择最多比模型的请求上限少一张图片。
- 项目比其 socket 存活更久：harness 存储每个项目，通过 `project_open_v1` 重新打开它，并允许后来的连接通过项目租约接管已打开的项目。项目会复制它使用的每张素材库图片。
- 创建项目的 socket 的 `websocket_connected` 项目日志事件携带连接 UUID 而非项目 ID，因为项目存储在第一条消息之后才分配项目 ID。
- 片段流失败时用片段 ID 而非显示位置来指称该片段。
- 打包的 `ref2va_system_prompt.md` 模板遵循 MiniMax H3 参考模式提示词指南，而不与参考模板一致。
- 所服务的模型不报告任何不受支持的生成模式，`fl2va` 项目以 `Unsupported generation_mode: fl2va` 失败。

页面与 FastVideo Next.js 前端也有差异：

- 页面省略了开发者工具（`NEXT_PUBLIC_INCLUDE_DEVTOOLS`）、改写检查器、监控页、LoRA 控件和语音输入。
- 实时编辑器有一个 **Prompt action** 选项：**Rewrite** 发送 `rewrite_seed_prompts`，**Continue from the last segment** 发送 `append_prompt`。前端只在其开发者工具中提供此选项。
- 页面不在浏览器中存储项目。项目历史列出 harness 的项目，打开项目会重建其已存储的轮次，项目 socket 关闭时显示 **Reconnect**。前端把项目保存到 IndexedDB，并以只读方式显示已保存的项目。
- 首次访问打开 `dsh web:` 令牌 URL；这次访问会重定向到不带其他查询参数的 `/`，因此演示模式需要再访问一次 `/?demo=1`。
- 图片是普通 `<img>` 元素，因此 K2 标志显示原始 PNG，而不是 Next.js 图片优化器生成的副本。
- 页面省略了前端中不起作用的 Google Fonts 导入，渲染相同的系统字体。
- 页面以中文或英文显示文案：每个 dreamverse-ui 包为自己渲染的文案注册 locale 词典，页面跟随浏览器语言。前端只显示英文。
