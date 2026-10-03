---
description: "harness 中的 DreamVerse 项目：项目创建与重新打开、浏览器命令准入、生成计划、已存储的工作负载数据、旧格式迁移以及项目事件日志。"
kind: "package-reference"
---

# @dreamverse/project

[English](README.md) | 中文

## 概述

使用本包在 harness 中运行 DreamVerse 项目。项目接受页面的命令，排队生成轮次，生成每个片段，并存储其提示词、片段和参考图副本，因此用户可以关闭页面并在之后重新打开项目。在第二个窗口中打开项目会把它移到那里并关闭第一个窗口。用户操作作为独立插件接入，每个项目事件都写入一个 JSON Lines 日志。早期版本存储的项目会在启动时迁移。

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

在共享项目层、生成客户端和提示词增强器之后挂载该服务。它注入 `dreamverseGeneration`、`dreamverseAssetsManager`、`dreamversePromptEnhancer`、`dreamverseProjectStore` 和 `dreamverseSegmentGeneration`。

### 最小配置

```yaml
- id: dreamverse-project
  name: '@dreamverse/project'
  config:
    projectLogRoot: /home/user/.local/state/fastvideo/dreamverse/outputs/project_logs
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `projectLogRoot` | 必填 | 项目事件日志的目录 |

### 服务

`dreamverseProjects` 创建并打开项目，并持有用户操作注册表：

- `registerUserAction({actionTypes, handler})` 为其操作类型注册一个处理器，并返回释放函数。没有处理器的操作类型会让其轮次以 `Unsupported project action: <type>` 失败。
- `createProject({socket, holder, payload})` 校验 `project_init_v1` 载荷，存储一个类型为 `dreamverse` 的新项目并取得其租约；被拒绝的载荷抛出 `ProjectValidationError`。
- `openProject({socket, holder, projectId})` 取得一个已存储 `dreamverse` 项目的租约。存储会先撤销当前持有者，该持有者的连接关闭并存储项目。
- `logProjectEvent(projectId, event, payload)` 向项目日志追加一条记录。

一个 `Project` 服务一个 socket：`processBrowserCommand` 准入浏览器命令，`processQueuedGenerationActions` 运行排队的轮次，`closeAndWaitForGeneration` 停止生成并存储最终的工作负载数据，`releaseLease` 结束项目的写入。关闭项目会以 `ProjectClosedError` 中止其生成，因此进行中的片段、提示词等待和生成循环都以该错误结束。

### 已存储的项目

DreamVerse 项目是 `dreamverseProjectStore` 中类型为 `dreamverse` 的项目。其工作负载（workload）数据为 schema 版本 1，包含以下字段：

| 字段 | 内容 |
| --- | --- |
| `creation_config` | `ProjectCreationConfig.as_dict()` 的字段 |
| `prompt_enhancement_enabled` | 项目的提示词增强设置 |
| `prompt_sequence_id`、`prompt_sequence_label` | 浏览器的 `preset_id` 值与预设标签 |
| `segments` | 每个片段：`segment_id`、`prompt`、`source`、`instruction`、`enhanced`、`sequence_index`、`reference_segment_id`、`reference_asset_ids`、`video_asset_id`、`last_frame_asset_id`、`status`、`error`、`mime` 和 `created_at` |
| `completed_sequences` | 每个已完成轮次的片段 ID 显示序列，最早的在前 |
| `reference_copies` | 项目使用过的每个素材库素材 ID，映射到项目副本的 ID |

片段 ID 是 `SegmentId`，指令请求 ID（浏览器的 `prompt_id`）是 `PromptId`。本包导出这两个带品牌的字符串类型，并为它生成的、从工作负载数据读取的或在浏览器命令中收到的 ID 加上品牌。

片段的 fragmented MP4（`<segment_id>.mp4`）和末帧（`<segment_id>.png`）是项目在文件存储中拥有的文件。某个操作第一次使用素材库图片时，项目把它复制进项目，并在 `reference_copies` 中记录副本；之后的操作复用该副本。项目在以下时刻写入工作负载数据：创建时、每个片段结束后、操作记录已完成序列时、轮次失败时以及关闭时。缩略图是最后一个已完成序列中最后一个片段的末帧。标题是预设标签，否则是截断到 60 个码点的第一个提示词，否则是 `Untitled project`。

打开的项目从其工作负载数据重建：处于等待或生成中的片段变为 `cancelled`，最后一个已完成序列的最后一个片段成为追加时延续的片段，项目以空闲状态启动且不带 Auto Extension。打开会拒绝未存储或类型不同的项目（`Project not found`）、`model_id` 不是所服务模型的项目（`Model unavailable`），以及参考图副本不可用的项目（`Invalid reference asset`）。socket 关闭时，进行中的片段变为 `cancelled`（`Project disconnected.`），排队的操作被丢弃，最终的工作负载数据被存储。

### 项目日志

项目日志在每次服务启动时生成一个 JSON Lines 文件，`<projectLogRoot>/<hostname>/<yymmdd_HHMMSS_ffffff>.jsonl`。每条记录以 `ts`、`event`、`hostname` 和 `project_id` 开头，后跟事件载荷，并保留参考实现的事件名和载荷键。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包移植参考实现的 `dreamverse/project/`，但不含用户操作、WebSocket 连接和片段生成。`GenerationPlan` 列出一个轮次的片段，`GenerationPlanController` 通过 `dreamverseSegmentGeneration` 依次生成它们，并把每个视频分块转发给 socket。参考素材通过 `dreamverseAssetsManager` 同步保留和释放，因此浏览器命令与参考实现一样在收到时准入。错误类型对应参考实现的异常类：`DreamverseValueError` 代表 Python `ValueError`，其他任何 `Error` 代表非 `ValueError` 异常。

服务就绪前，它会迁移 `dreamverseProjectStore.listUnrecognized()` 报告的每个 schema 1 `project.json`。对每个项目，迁移会删除早先未完成的运行遗留的文件，把已完成片段的 `segments/<segment_id>.mp4` 和 `.png` 文件移入文件存储，把引用的素材库图片复制进项目，用 `migrate` 写入记录，设置缩略图，并删除 `segments/`。素材库中已不存在的图片会被跳过并发出警告。`schema_version` 不为 1 的记录属于其他工作负载，会被跳过；迁移失败的项目会在下次启动时重试。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dreamverseProjects` 服务与启动迁移 |
| [`src/project.ts`](src/project.ts) | `Project`：命令准入、轮次、存储与生命周期 |
| [`src/project-data.ts`](src/project-data.ts) | DreamVerse 工作负载数据 |
| [`src/legacy-migration.ts`](src/legacy-migration.ts) | schema 1 项目的迁移 |
| [`src/generation-plan.ts`](src/generation-plan.ts)、[`src/generation-plan-controller.ts`](src/generation-plan-controller.ts) | 轮次及其片段生成 |
| [`src/video-segment.ts`](src/video-segment.ts) | 单个片段的状态 |
| [`src/project-logger.ts`](src/project-logger.ts) | 项目事件日志 |

`tests/` 目录覆盖项目、已存储项目与迁移、生成计划以及项目日志。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——DreamVerse 工作负载以及与 Python 参考实现的差异。
- [`@dreamverse/user-actions`](../user-actions/README.zh.md)——运行每个轮次的处理器。
- [`@dreamverse/project-controller`](../project-controller/README.zh.md)——驱动项目的 `/ws` 连接。
- [`@dreamverse/project-store`](../project-store/README.zh.md)——项目记录与租约。

-----

<a id="model-experience"></a>
## 模型体验

### 片段生成输入

#### 模型看到什么

对每个片段，视频模型收到工作负载数据中存储的该片段 `prompt`、取自 `creation_config` 的帧宽、帧高和帧数，以及 `@dreamverse/segment-generation` 根据项目的参考图副本和前一片段末帧排好的请求图片。`promptImageLabels` 把同一批图片的标签（例如 `Picture 1`）交给提示词增强器，因此增强后的提示词所命名的正是其请求发送的图片。

#### Token 影响

每个片段一个提示词；项目不向操作准备好的提示词添加任何文本。

#### KV Cache 影响

每个片段是独立请求；除了前一片段的末帧图片，项目不在请求之间传递任何状态。

### Auto Extension

#### 模型看到什么

Auto Extension 开启时，项目在每个已完成轮次之后排入操作 `{"type": "auto_extend"}`。随后 `append_prompt` 与 `auto_extend` 的处理器在没有引导提示词的情况下向提示词增强器请求续写，并再生成一个片段。

#### Token 影响

每个已完成轮次多一次续写请求和一次片段请求，直到用户关闭 Auto Extension 或项目关闭。

#### KV Cache 影响

独立请求，与用户发起的续写相同。

### 项目日志

#### 模型看到什么

无。项目日志记录 `enhance_request`、`rewrite_done`、`rewrite_exception`、`simple_generate`、`append_prompt`、`segment_start` 以及其他参考事件以供审计；没有任何模型请求读取它。

#### Token 影响

零；日志记录永远不会进入模型请求。

#### KV Cache 影响

无；写日志不会改变任何模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不完整的请求记录**——项目日志记录用户的提示词和增强器的回复，但不记录渲染后的增强器请求，也不记录每个片段最终的视频提示词。工作负载数据保存每个片段最终的 `prompt`。
- **重新打开的项目不带 Auto Extension**——打开已存储的项目永远不会恢复 Auto Extension，即使项目关闭时它处于开启状态。
- **失败轮次之后的追加**——当同一个 socket 服务项目时，失败轮次之后的追加需要先改写；重新打开的项目会追加到其最后一个已完成序列。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
