---
description: "DreamVerse 的 profile 层：生成方式实现、各组件、对话引用、API、界面插件、video-directing skill 以及模型路由，叠在 dsh-base 加 dsh-web-app 或 dsh-headless 之上。"
kind: "package-bundle"
---

# @dv/bundle

[English](README.md) | 中文

## 概要

用这个 bundle 把 DreamVerse 作为一个 `dsh` profile 运行。它插入生成方式实现（`t2va` 行只在设置了 `DV_T2VA_BACKEND_URL` 时挂载）、DreamVerse 各组件及 `@dv/ffmpeg`、对话引用、API 和 `@dv/ui-*` 界面插件；提供 `video-directing` skill，两处 `skill-filesystem` 行都读取它；声明到集群 SGLang 服务器的 `deepseek-local` 路由；并从环境变量选择智能体模型。`scripts/video-harness/setup-profile.sh` 把它叠在 `dsh-base` 加 `dsh-web-app` 上成为 profile `video-harness`，叠在 `dsh-base` 加 `dsh-headless` 上成为 `video-harness-headless`；`scripts/video-harness/launch.sh web|headless` 从源码运行二者之一。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用这个包

```sh
scripts/video-harness/launch.sh web --trusted-host <public host>   # chat page on DV_PORT (default 8092)
scripts/video-harness/launch.sh headless "给我一个这个人跳舞的视频" --session-id demo   # one task, printed result
```

patch 读取的环境变量：`DV_BACKEND_URL`（`ref2va` 后端；默认 `http://127.0.0.1:8029`）、`DV_T2VA_BACKEND_URL`（`t2va` 后端；未设置时 `dv-fasth3-t2va` 行被禁用，智能体没有 `dv_shot_render_t2va` 工具）、`DV_STATE_ROOT`（默认 `~/.local/state/dv`；下有 `assets`、`projects`、`sessions`，以及 `@dv/api` 保存的视图状态，patch 把它作为 `@dv/api` 的 `stateRoot` 传入）、`DV_FFMPEG`、`DV_FFPROBE`、`DV_PUBLIC_URL`（聊天卡片里素材链接的来源）、`DV_AGENT_PROVIDER` 与 `DV_AGENT_MODEL`（默认 `deepseek-local` / `deepseek-v4.1`；备选 `groq` / `qwen/qwen3.8-27b`）、`DV_AGENT_REASONING`（默认 `low`）、`DV_DEEPSEEK_BASE_URL`（OpenAI 兼容的 SGLang 端点；启动脚本默认为 `http://10.244.6.153:30000/v1`）、`DV_DEEPSEEK_API_KEY`（服务器无需密钥，但 pi-ai 的 OpenAI 路由坚持要一个 bearer token，启动脚本导出 `none`）、`DV_AGENT_VISION`（`0` 让 `inspect.image` 报告不支持图片而不调用模型），以及启动脚本从 `DV_ENV_FILE` 读入的备选密钥 `GROQ_API_KEY`。

<a id="understand-the-implementation"></a>
## 理解实现

[`cordis.patch.yml`](cordis.patch.yml) 有一个 `insert` 列表放 DreamVerse 的行，和三处覆盖：`skill-filesystem`（skill 目录，其中是 `video-directing`；模型的 prompt skill 和 `timeline-editing` 由各自的插件通过 `ctx.skills` 注册）、`llm-pi-ai`（手工声明的 `deepseek-local` 路由：`DV_DEEPSEEK_BASE_URL` 上的 `openai-completions`，唯一模型 `deepseek-v4.1` 声明为文本加图片输入，另有 Groq 路由）、`agent-default-model`（来自环境变量的 provider、model 和推理强度）。不包含 web server 行：web profile 的页面来自 `dsh-web-app`，`dvAssetPool` 在那个服务器上注册 `/dv/assets`。[`tests/composition.spec.ts`](tests/composition.spec.ts) 经 Loader 启动补丁里的生成方式实现行（每行加载该生成方式的一个假实现）、组件行、`dv-chat-references` 行和 `dv-api` 行（带它们的 `!!js` 配置和 `disabled` 标志），检查被禁用的 `t2va` 行不留下 `dv_shot_render_t2va` 工具，并把一次模型工具调用变成一条记录。

<a id="further-exploration"></a>
## 延伸阅读

- [DreamVerse 各包](../../../docs/subsystems/video-harness.zh.md)
- [`@dv/chat-references`](../../dv/chat-references/README.zh.md)
- [`@dv/api`](../../dv/api/README.zh.md)

<a id="model-experience"></a>
## 模型体验

间接地，通过 bundle 挂载的工具、`@dv/project` 的 `dv:project` 提示词段落、`@dv/chat-references` 的提及上下文和 skill；bundle 本身不添加模型可见的文本。

#### KV Cache 影响

本身没有；挂载的插件各自说明。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- ffmpeg 的默认路径是本机的原生构建；其他机器必须设置 `DV_FFMPEG`。
- `deepseek-local` 路由的图片支持只是声明，harness 不做验证；纯文本服务器要设 `DV_AGENT_VISION=0`，否则 `read_image` 在运行时失败。
- SGLang 服务器接受任意 `model` 字符串，所以目录 id `deepseek-v4.1` 原样发送；它的 `/v1/models` 列表里的名字是 `deepseek-ai/DeepSeek-V4.1-Flash`。
