---
description: "视频 harness 的 profile 层：DreamVerse 生成客户端、harness 的运行时、工具、agent、浏览器 API 和视图插件、导演 skill 以及模型路由，叠在 dsh-base 加 dsh-web-app 或 dsh-headless 之上。"
kind: "package-bundle"
---

# @video-harness/bundle

[English](README.md) | 中文

## 概要

用这个 bundle 把视频 harness 作为一个 `dsh` profile 运行。它插入 DreamVerse 生成客户端和九个 harness 插件（`media`、`assets`、`oplog`、`runtime`、`tools`、`agent`、`views`、`ui-canvas`、`ui-timeline`），把 `skill-filesystem` 指向 agent 包的 skill，声明到集群 SGLang 服务器的 `deepseek-local` 路由，并从环境变量选择 agent 模型。`scripts/video-harness/setup-profile.sh` 把它叠在 `dsh-base` 加 `dsh-web-app` 上成为 profile `video-harness`，叠在 `dsh-base` 加 `dsh-headless` 上成为 `video-harness-headless`；`scripts/video-harness/launch.sh web|headless` 从源码运行二者之一。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用这个包

```sh
scripts/video-harness/launch.sh web --trusted-host <public host>   # chat page on VH_PORT (default 8092)
scripts/video-harness/launch.sh headless "给我一个这个人跳舞的视频" --session-id demo   # one task, printed result
```

patch 读取的环境变量：`VH_BACKEND_URL`（默认 `http://127.0.0.1:8029`）、`VH_STATE_ROOT`（默认 `~/.local/state/video-harness`；下有 `assets`、`projects`、`sessions`）、`VH_FFMPEG`、`VH_FFPROBE`、`VH_PUBLIC_URL`（聊天卡片里资产链接的来源）、`VH_AGENT_PROVIDER` 与 `VH_AGENT_MODEL`（默认 `deepseek-local` / `deepseek-v4.1`；备选 `groq` / `qwen/qwen3.8-27b`）、`VH_AGENT_REASONING`（默认 `low`）、`VH_DEEPSEEK_BASE_URL`（OpenAI 兼容的 SGLang 端点；启动脚本默认为 `http://10.244.6.153:30000/v1`）、`VH_DEEPSEEK_API_KEY`（服务器无需密钥，但 pi-ai 的 OpenAI 路由坚持要一个 bearer token，启动脚本导出 `none`）、`VH_AGENT_VISION`（`0` 让 `perception.describe` 报告不支持图片而不调用模型），以及启动脚本从 `VH_ENV_FILE` 读入的备选密钥 `GROQ_API_KEY`。

<a id="understand-the-implementation"></a>
## 理解实现

[`cordis.patch.yml`](cordis.patch.yml) 有一个 `insert` 列表放 harness 的行，和三处覆盖：`skill-filesystem`（skill 目录）、`llm-pi-ai`（手工声明的 `deepseek-local` 路由：`VH_DEEPSEEK_BASE_URL` 上的 `openai-completions`，唯一模型 `deepseek-v4.1` 声明为文本加图片输入，另有 Groq 路由）、`agent-default-model`（来自环境变量的 provider、model 和推理强度）。不包含 web server 行：web profile 的页面来自 `dsh-web-app`，`vhAssets` 在那个服务器上注册 `/vh/assets`。

<a id="further-exploration"></a>
## 延伸阅读

- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md)
- [`@video-harness/agent`](../../video-harness/agent/README.zh.md)
- [`@video-harness/tools`](../../video-harness/tools/README.zh.md)

<a id="model-experience"></a>
## 模型体验

间接地，通过 bundle 挂载的工具、agent 节和 skill；bundle 本身不添加模型可见的文本。

#### KV Cache 影响

本身没有；挂载的插件各自说明。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- ffmpeg 的默认路径是本机的原生构建；其他机器必须设置 `VH_FFMPEG`。
- `deepseek-local` 路由的图片支持只是声明，harness 不做验证；纯文本服务器要设 `VH_AGENT_VISION=0`，否则 `read_image` 在运行时失败。
- SGLang 服务器接受任意 `model` 字符串，所以目录 id `deepseek-v4.1` 原样发送；它的 `/v1/models` 列表里的名字是 `deepseek-ai/DeepSeek-V4.1-Flash`。
