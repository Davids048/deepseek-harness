---
description: "dreamverse profile 层：在 dsh-base 之上挂载 DreamVerse harness 包、DSH web 行和 DreamVerse 页面，并从 DreamVerse 环境变量读取配置。"
kind: "package-bundle"
---

# @dreamverse/bundle

[English](README.md) | 中文

## 概述

把本层叠加在 `@deepseek-ai/dsh-base` 之上，可把一个 DSH profile 变成 DreamVerse 应用：页面、`/ws` 项目协议、项目、用户操作、提示词增强、文件存储和生成后端客户端。每一行都从环境变量读取设置，因此同一个 profile 可以服务任意状态目录和后端。`scripts/dreamverse/launch-harness.sh` 创建 `dreamverse` profile 并从源码运行它。缺少必需变量时，对应插件在加载时失败。

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

`scripts/dreamverse/setup-profile.sh` 创建 `$DSH_HOME/profiles/dreamverse`，其中包含 `dsh.profile.bundles` 为 `["@deepseek-ai/dsh-base", "@dreamverse/bundle"]` 的清单、一个空的 profile 补丁（已存在时保留），以及指向本包的 `node_modules` 链接。`scripts/dreamverse/launch-harness.sh` 先运行该脚本，然后在检出目录中运行 `node --import tsx/esm apps/cli/src/bin.ts --profile dreamverse`。

### 环境变量

| 变量 | 行 | 含义 |
| --- | --- | --- |
| `DREAMVERSE_GENERATION_URL` | 生成客户端 | 生成后端的 HTTP 基础 URL；必填 |
| `FASTVIDEO_DREAMVERSE_HOME` | 文件存储、项目存储、项目日志 | 状态根目录；否则为 `$XDG_STATE_HOME/fastvideo/dreamverse`，再否则为 `~/.local/state/fastvideo/dreamverse` |
| `FASTVIDEO_PROJECT_LOG_ROOT` | 项目 | 项目日志目录；否则为 `<state root>/outputs/project_logs` |
| `CEREBRAS_API_KEY`、`GROQ_API_KEY`、`FASTVIDEO_PROMPT_*`、`CEREBRAS_BASE_URL` | 提示词增强器 | 提供方密钥、模型、端点和模板路径 |
| `DREAMVERSE_BROWSER_HOST`、`DREAMVERSE_BROWSER_PORT` | web 服务器 | 页面的监听地址；主机默认为 `127.0.0.1` |

### 你得到什么

文件存储使用 `<state root>/assets`，项目存储使用 `<state root>/projects`。web 服务器在 harness 启动时打印的 `dsh web:` 令牌 URL 上提供 DreamVerse 页面，并提供 `/ws` socket，以及 `/assets`、`/projects`、健康、就绪和创建能力路由。[`dreamverse/`](../../dreamverse/README.zh.md) 和 [`dreamverse-ui/`](../../dreamverse-ui/README.zh.md) 的包 README 负责每一行的行为。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 是一个 `insert` 列表。它先挂载 DreamVerse harness 行（生成客户端、文件存储、项目存储、片段生成、提示词增强器、项目和四个用户操作），然后挂载 DSH web 行：带 `compression: none` 的 `@deepseek-ai/dsh-host-webserver`、`@dreamverse/project-store/routes`、`@deepseek-ai/dsh-web-app`（作为 web 服务器回退路由的页面外壳和打印出的令牌 URL）、`@deepseek-ai/dsh-client-modules`、`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-api-remotes` 和 `@deepseek-ai/dsh-client-ui-renderer`。六个 `@dreamverse/ui-*` 页面行和 `@dreamverse/project-controller` 排在最后。web 服务器不发送压缩响应，因此路由响应与参考实现保持逐字节一致。

| 文件 | 内容 |
| --- | --- |
| [`cordis.patch.yml`](cordis.patch.yml) | 补丁文档 |
| [`package.json`](package.json) | `dsh.bundle.patch` 声明和被挂载的包 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——本层组合出的进程布局。
- [Bundle 包组](../README.zh.md)——其他 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dreamverse/prompt-enhancer` 和 `@dreamverse/segment-generation`：本层挂载并配置它们的行；每个被挂载的包负责其面向模型的行为。

#### KV Cache 影响

无；本层不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **共享状态根目录但不共享租约**——运行 `dreamverse` profile 的每个 harness 进程都使用 `<state root>/assets` 和 `<state root>/projects` 目录。项目租约和文件保留只存在于单个 harness 进程内，因此在同一状态根目录上同时运行的两个进程可能删除对方正在使用的文件或项目。
- **没有压缩**——web 服务器以未压缩形式发送页面 bundle。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
