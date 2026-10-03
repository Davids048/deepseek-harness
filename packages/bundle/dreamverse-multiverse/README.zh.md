---
description: "dreamverse-multiverse profile 层：在 dsh-base 之上挂载 Multiverse 原型、共享的 DreamVerse 项目层和 Multiverse 页面，并选择分支提议模型。"
kind: "package-bundle"
---

# @dreamverse/multiverse-bundle

[English](README.md) | 中文

## 概述

把本层叠加在 `@deepseek-ai/dsh-base` 之上，可运行 Multiverse 原型：带语言模型分支提议的分支视频故事、共享的 DreamVerse 文件存储和项目存储，以及 Multiverse 页面。本层把 Groq `openai/gpt-oss-120b` 选为 profile 的默认模型，因此分支提议需要 `GROQ_API_KEY`。`scripts/dreamverse/launch-multiverse.sh` 创建 `dreamverse-multiverse` profile 并从源码运行它。缺少必需变量时，对应插件在加载时失败。

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

### 安装到 profile

`scripts/dreamverse/setup-multiverse-profile.sh` 创建 `$DSH_HOME/profiles/dreamverse-multiverse`，其中包含 `dsh.profile.bundles` 为 `["@deepseek-ai/dsh-base", "@dreamverse/multiverse-bundle"]` 的清单、一个空的 profile 补丁（已存在时保留），以及指向本包的 `node_modules` 链接。`scripts/dreamverse/launch-multiverse.sh` 先运行该脚本，然后从源码运行该 profile；`DSH_HOME` 默认为 `$HOME/.local/state/dsh-multiverse`，额外参数会传给 `dsh`。

### 环境变量

| 变量 | 行 | 含义 |
| --- | --- | --- |
| `DREAMVERSE_GENERATION_URL` | 生成客户端 | 生成后端的 HTTP 基础 URL；必填 |
| `FASTVIDEO_DREAMVERSE_HOME` | 文件存储、项目存储、multiverse 日志 | 状态根目录；否则为 `$XDG_STATE_HOME/fastvideo/dreamverse`，再否则为 `~/.local/state/fastvideo/dreamverse` |
| `FASTVIDEO_MULTIVERSE_LOG_ROOT` | multiverse director | multiverse 日志目录；否则为 `<state root>/outputs/multiverse_logs` |
| `CEREBRAS_API_KEY`、`GROQ_API_KEY`、`FASTVIDEO_PROMPT_*`、`CEREBRAS_BASE_URL` | 提示词增强器、`llm-pi-ai` | 提供方密钥、模型、端点和模板路径 |
| `MULTIVERSE_BROWSER_HOST`、`MULTIVERSE_BROWSER_PORT` | web 服务器 | 页面的监听地址；主机默认为 `127.0.0.1` |

### 你得到什么

web 服务器在打印出的 `dsh web:` 令牌 URL 上提供 Multiverse 页面，并提供 `/multiverse/api`、`/assets` 和 `/projects` 路由。文件存储和项目存储使用 `<state root>/assets` 和 `<state root>/projects`，与 `dreamverse` profile 的目录相同。[`@dreamverse/multiverse`](../../dreamverse/multiverse/README.zh.md) 和 [`@dreamverse/ui-multiverse`](../../dreamverse-ui/multiverse/README.zh.md) 的 README 负责其行为。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 有一个 `insert` 列表和两处覆盖。insert 列表挂载生成客户端、文件存储、项目存储、片段生成、提示词增强器、三个 Multiverse 入口、带 `compression: none` 的 DSH web 行（其中 `@deepseek-ai/dsh-client-ui-settings` 和 `@deepseek-ai/dsh-client-locale` 提供页面语言和页面行的词典）、`@dreamverse/project-store/routes`，以及页面行 `@dreamverse/ui-multiverse`、`@dreamverse/ui-creation` 和 `@dreamverse/ui-assets`。两处覆盖为 dsh-base 的 `llm-pi-ai` 行提供 `cerebras` 和 `groq` 提供方（其密钥在每次请求时从 `CEREBRAS_API_KEY` 和 `GROQ_API_KEY` 解析），并把 dsh-base 的 `agent-default-model` 行指向提供方 `groq` 和模型 `openai/gpt-oss-120b`。

| 文件 | 内容 |
| --- | --- |
| [`cordis.patch.yml`](cordis.patch.yml) | 补丁文档 |
| [`package.json`](package.json) | `dsh.bundle.patch` 声明和被挂载的包 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——共享项目层中的 Multiverse 工作负载（workload）。
- [`@dreamverse/bundle`](../dreamverse/README.zh.md)——使用同一状态根目录的 DreamVerse profile 层。
- [Bundle 包组](../README.zh.md)——其他 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dreamverse/multiverse` 和 `@dreamverse/prompt-enhancer`：本层挂载它们的行；`agent-default-model` 覆盖选择接收分支提议的模型。

#### KV Cache 影响

无；本层不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **profile 范围的模型选择**——`agent-default-model` 覆盖作用于本 profile 中默认模型选择的每个使用方，而不仅仅是分支提议。
- **共享状态根目录但不共享租约**——在同一状态根目录上同时运行的 `dreamverse` profile 可能在本 profile 处理某个 multiverse 项目时删除该项目或其文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
