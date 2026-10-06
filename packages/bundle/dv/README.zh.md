---
description: "DreamVerse 的 profile 层：生成客户端、各组件、API、智能体集成、界面插件、导演 skill 以及模型路由，叠在 dsh-base 加 dsh-web-app 或 dsh-headless 之上。"
kind: "package-bundle"
---

# @dv/bundle

[English](README.md) | 中文

## 概要

用这个 bundle 把 DreamVerse 作为一个 `dsh` profile 运行。它插入 DreamVerse 生成客户端、组件 `@dv/project`、`@dv/asset-pool`、`@dv/inspector`、`@dv/story-bible`、`@dv/shot-plan`、`@dv/shot-render`、`@dv/timeline` 和 `@dv/deliver` 及 ffmpeg 执行器 `@dv/ffmpeg`，API `@dv/api`、智能体集成 `@dv/agent-integration`，以及界面插件 `@dv/ui-composer`、`@dv/ui-canvas`、`@dv/ui-timeline`、`@dv/ui-asset-pool` 和 `@dv/ui-shell`，把 `skill-filesystem` 指向 `@dv/agent-integration` 的 skill，声明到集群 SGLang 服务器的 `deepseek-local` 路由，并从环境变量选择智能体模型。`scripts/video-harness/setup-profile.sh` 把它叠在 `dsh-base` 加 `dsh-web-app` 上成为 profile `video-harness`，叠在 `dsh-base` 加 `dsh-headless` 上成为 `video-harness-headless`；`scripts/video-harness/launch.sh web|headless` 从源码运行二者之一。

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

patch 读取的环境变量：`DV_BACKEND_URL`（默认 `http://127.0.0.1:8029`）、`DV_STATE_ROOT`（默认 `~/.local/state/dv`；下有 `assets`、`projects`、`sessions`，以及 `@dv/api` 和 `@dv/agent-integration` 保存的视图状态，patch 把它作为二者的 `stateRoot` 传入）、`DV_FFMPEG`、`DV_FFPROBE`、`DV_PUBLIC_URL`（聊天卡片里素材链接的来源）、`DV_AGENT_PROVIDER` 与 `DV_AGENT_MODEL`（默认 `deepseek-local` / `deepseek-v4.1`；备选 `groq` / `qwen/qwen3.8-27b`）、`DV_AGENT_REASONING`（默认 `low`）、`DV_DEEPSEEK_BASE_URL`（OpenAI 兼容的 SGLang 端点；启动脚本默认为 `http://10.244.6.153:30000/v1`）、`DV_DEEPSEEK_API_KEY`（服务器无需密钥，但 pi-ai 的 OpenAI 路由坚持要一个 bearer token，启动脚本导出 `none`）、`DV_AGENT_VISION`（`0` 让 `inspect.image` 报告不支持图片而不调用模型），以及启动脚本从 `DV_ENV_FILE` 读入的备选密钥 `GROQ_API_KEY`。

<a id="understand-the-implementation"></a>
## 理解实现

[`cordis.patch.yml`](cordis.patch.yml) 有一个 `insert` 列表放 DreamVerse 的行，和三处覆盖：`skill-filesystem`（skill 目录）、`llm-pi-ai`（手工声明的 `deepseek-local` 路由：`DV_DEEPSEEK_BASE_URL` 上的 `openai-completions`，唯一模型 `deepseek-v4.1` 声明为文本加图片输入，另有 Groq 路由）、`agent-default-model`（来自环境变量的 provider、model 和推理强度）。不包含 web server 行：web profile 的页面来自 `dsh-web-app`，`dvAssetPool` 在那个服务器上注册 `/dv/assets`。[`tests/composition.spec.ts`](tests/composition.spec.ts) 经 Loader 启动补丁里的组件行、`dv-api` 行和 `dv-agent-integration` 行（带它们的 `!!js` 配置），并把一次模型工具调用变成一条记录。

<a id="further-exploration"></a>
## 延伸阅读

- [DreamVerse 各包](../../../docs/subsystems/video-harness.zh.md)
- [`@dv/agent-integration`](../../dv/agent-integration/README.zh.md)
- [`@dv/api`](../../dv/api/README.zh.md)

<a id="model-experience"></a>
## 模型体验

间接地，通过 bundle 挂载的工具、智能体集成的项目提示词段落和 skill；bundle 本身不添加模型可见的文本。

#### KV Cache 影响

本身没有；挂载的插件各自说明。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- ffmpeg 的默认路径是本机的原生构建；其他机器必须设置 `DV_FFMPEG`。
- `deepseek-local` 路由的图片支持只是声明，harness 不做验证；纯文本服务器要设 `DV_AGENT_VISION=0`，否则 `read_image` 在运行时失败。
- SGLang 服务器接受任意 `model` 字符串，所以目录 id `deepseek-v4.1` 原样发送；它的 `/v1/models` 列表里的名字是 `deepseek-ai/DeepSeek-V4.1-Flash`。
