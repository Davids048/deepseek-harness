---
description: "DreamVerse Multiverse 原型：作为项目存储的分支视频故事、场景生成、语言模型分支提议、/multiverse/api 路由，以及 multiverse 模型调用日志。"
kind: "package-reference"
---

# @dreamverse/multiverse

[English](README.md) | 中文

## 概述

使用本包把故事生长为一棵视频场景树。用户写下开场场景并挑选角色图片；harness 生成该场景，并请语言模型给出两个不同的后续走向。选择一个走向只会生成该场景，它从父场景的末帧开始，并得到两个新的后续走向；未被选择的走向保持可用。每个 multiverse 都是一个已存储的项目，因此能在 harness 重启后保留，且每次模型调用都会被记录。分支提议需要所选模型提供商的密钥。 已被 [video harness](../../../docs/subsystems/video-harness.zh.md) 取代。

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

把三个插件入口与共享项目层、生成客户端、提示词增强器，以及带 `agentDefaultModel` 选择的 harness `llm` 服务一起挂载。[`@dreamverse/multiverse-bundle`](../../bundle/dreamverse-multiverse/README.zh.md) 补丁会挂载所有这些内容。

### 最小配置

```yaml
- id: multiverse-tree
  name: '@dreamverse/multiverse/tree'
- id: multiverse-director
  name: '@dreamverse/multiverse/director'
  config:
    logRoot: /home/user/.local/state/fastvideo/dreamverse/outputs/multiverse_logs
    proposalMaxTokens: 800
- id: multiverse-controller
  name: '@dreamverse/multiverse/controller'
  config:
    keepaliveMs: 15000
```

| 插件入口 | 服务键 | 职责 |
| --- | --- | --- |
| `@dreamverse/multiverse/tree` | `dreamverseMultiverseTree` | 启动时加载每个 multiverse 项目，在内存中保存这些树，用项目租约把树保存到其项目，并通知变更监听者 |
| `@dreamverse/multiverse/director` | `dreamverseMultiverseDirector` | 创建 multiverse，在每个 multiverse 中一次生成一个被选中的节点，提议分支，并写入 multiverse 日志 |
| `@dreamverse/multiverse/controller` | 无 | 在 DSH web 服务器上提供 `/multiverse/api` |

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `logRoot`（director） | 必填 | multiverse 日志的目录；组合包使用 `FASTVIDEO_MULTIVERSE_LOG_ROOT`，否则使用 `<state root>/outputs/multiverse_logs` |
| `proposalMaxTokens`（director） | 必填 | 一次分支提议调用的输出上限，单位 token；组合包设为 800 |
| `keepaliveMs`（controller） | 必填 | 让空闲事件流穿过代理保持打开的注释行的间隔，单位毫秒；组合包设为 15000 |

### 路由

| 路由 | 行为 |
| --- | --- |
| `GET /multiverse/api/capabilities` | 带 `segment_counts` `[1]` 的 `GET /creation-capabilities` 载荷，使页面能复用 DreamVerse 创作工作室 |
| `GET /multiverse/api/multiverses` | 所有 multiverse，最早的在前 |
| `POST /multiverse/api/multiverses` | 请求体 `{prompt, reference_asset_ids, segment_duration_sec, enhancement_enabled?}` 加上 DreamVerse 创建字段；`reference_asset_ids` 指定素材库图片；返回 201 和根节点正在生成的 multiverse |
| `GET /multiverse/api/multiverses/<id>` | 单个 multiverse：`multiverse_id`、`created_at`、`root_id`、`segment_duration_sec`，以及按创建顺序排列的 `nodes`；每个节点带 `has_clip` 和 `has_last_frame` |
| `GET /multiverse/api/multiverses/<id>/events` | 服务器发送的 `multiverse` 事件：立即发送一次 multiverse，之后每次变更再发送 |
| `POST .../nodes/<node_id>/choose` | 202；生成一个被提议或失败的节点；该 multiverse 的另一个节点正在生成时返回 400 |
| `POST .../nodes/<node_id>/propose` | 202；在没有分支的已生成节点下再次提议分支 |
| `GET .../nodes/<node_id>/clip`、`GET .../nodes/<node_id>/last-frame` | 节点的 fMP4 视频和末帧 PNG，带存储的 MIME 类型并支持 `Range`；生成前返回 404 |

未知 ID 返回 404，被拒绝的请求返回 400；两者都带 `detail`。指定了不存在的文件或某个项目文件的创建请求返回 400。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个 multiverse 是 `dreamverseProjectStore` 中类型为 `multiverse` 的项目，multiverse ID 就是项目 ID，即 `ProjectId`。标题是截断到 60 个字符的开场提示词，缩略图是根节点的末帧。工作负载（workload）数据（schema 版本 1）保存创建设置、提示词增强选项、项目的参考图副本、根 ID，以及按创建顺序排列的每个节点：节点 ID、父节点、深度、标签、方向、状态、提示词、错误，以及节点视频和末帧的素材 ID。director 在创建 multiverse 时把每张选中的素材库图片复制进项目，因此删除素材库图片不影响该 multiverse；`DELETE /projects/<id>` 会删除该 multiverse 及其文件。节点 ID 是 `@dreamverse/multiverse/tree` 导出的带品牌字符串类型 `NodeId`；controller 为每个请求路径中的 multiverse ID 和节点 ID 加上品牌。

节点生成遵循 `@dreamverse/segment-generation` 的共享规则：`continuesPreviousSegment` 和 `segmentImageLabels` 决定分支是否从父节点的末帧开始以及其提示词使用哪些标签，`dreamverseSegmentGeneration.generate` 把视频和末帧存为以节点 ID 命名的项目文件。生成失败会把节点标为 `failed`，再次选择它会重试。提议失败会存为已生成节点的 `error`，`POST .../propose` 会再次请求；`parseProposals` 要求两个非空且标签不同的分支。

director 是 multiverse 项目唯一的写入者。它只在处理某个 multiverse 时持有其项目租约，没有剩余工作时就释放；取得租约的另一方会中止该工作，此后 director 不再写入。下次启动时，树会把仍处于 `generating` 的节点标为 `failed`，并给没有分支也没有错误的已生成节点设置错误 `Interrupted by a restart.`，使用户可以重试两者。工作负载数据无法解析的已存储 multiverse 会被跳过并发出警告。

| 文件 | 内容 |
| --- | --- |
| [`src/tree.ts`](src/tree.ts) | `dreamverseMultiverseTree`：节点、工作负载数据、保存与重启修复 |
| [`src/director.ts`](src/director.ts) | `dreamverseMultiverseDirector`：创建、生成、提议、租约与日志事件 |
| [`src/branch-proposals.ts`](src/branch-proposals.ts) | 提议请求与回复校验 |
| [`src/event-log.ts`](src/event-log.ts) | multiverse 日志文件 |
| [`src/controller.ts`](src/controller.ts) | `/multiverse/api` 路由 |

`tests/` 目录覆盖 director、分支提议和路由。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——共享项目层中的 Multiverse 工作负载。
- [`@dreamverse/ui-multiverse`](../../dreamverse-ui/multiverse/README.zh.md)——Multiverse 页面。
- [`@dreamverse/segment-generation`](../segment-generation/README.zh.md)——共享生成规则。
- [`@dreamverse/prompt-enhancer`](../prompt-enhancer/README.zh.md)——场景提示词请求。

-----

<a id="model-experience"></a>
## 模型体验

### 分支提议系统提示词

#### 模型看到什么

每次提议调用通过 `ctx.llm.stream()` 发送一个请求，使用 `ctx.agentDefaultModel.currentSelection()` 的提供方和模型、设为 `proposalMaxTokens` 的 `maxTokens`、下面的系统提示词，以及一条描述从根节点到该已生成节点路径上故事的用户消息。模型以包含两个分支的 JSON 回答。

##### 提议系统提示词

```markdown
You plan a branching short-film story. Each scene is one continuous shot of a few seconds.
Given the premise and the scenes so far, propose exactly two different ways the story continues in the next scene.
The two options must lead the story in clearly different directions, keep the same characters and setting, and
follow on directly from the end of the last scene.
Respond with JSON only, no other text, in this form:
{"branches": [{"label": "...", "direction": "..."}, {"label": "...", "direction": "..."}]}
label: two to six words naming the choice. direction: one or two sentences describing what happens in the scene.
```

##### 提议用户消息

```markdown
Premise: <root direction>

Scenes so far:
1. <label>: <direction>
2. <label>: <direction>
```

#### Token 影响

固定的系统提示词加上路径上每个场景一行，因此输入随节点深度增长；回复上限为 `proposalMaxTokens` 个 token。对根节点，用户消息以 `(only the opening scene so far)` 结尾。

#### KV Cache 影响

每次提议是独立请求。对同一模型的每次提议调用，系统提示词都是逐字节稳定的前缀；用户消息因节点而异。

### 场景提示词增强

#### 模型看到什么

当 multiverse 的 `enhancement_enabled` 为 true（默认值）时，director 把根节点的方向发给 `expandClip`，把分支的方向连同以下内容发给 `continueVideo`：从根节点出发的路径上的提示词作为锁定片段、下一个片段序号、参考标签，以及分支从父节点末帧开始时的首帧标签。截止时间为提示词增强器的 `timeoutMs`。随后视频模型收到增强后的提示词；增强关闭时收到节点的方向。

#### Token 影响

每个已生成节点一次增强请求；续写的输入随节点深度增长，因为它会重复路径上的每个提示词。

#### KV Cache 影响

独立请求；每个分支都会完整地再次发送锁定片段。

### Multiverse 日志

#### 模型看到什么

无。director 把每次模型调用追加到 `<logRoot>/<hostname>/<yymmdd_HHMMSS_ffffff>.jsonl`，每个事件一行 JSON，带 `ts`、`event`、`hostname`、`multiverse_id` 和 `node_id`：`branch_proposal_request`（完整请求：提供方、模型、推理强度、`system`、`messages` 和 `max_tokens`）、`branch_proposal_response`（原始 `output`、`reasoning`、`finish_reason`，以及 `branches` 或 `error`）、`prompt_enhance_request`（操作 `expand_clip` 或 `continue_video`，以及提示词增强器收到的每个输入），以及 `prompt_enhance_response`（提示词、提供方、模型、延迟、回退标志和错误）。日志写入失败只会发出警告。

#### Token 影响

零；日志记录永远不会进入模型请求。

#### KV Cache 影响

无；写日志不会改变任何模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有渐进播放**——`GET .../clip` 只在节点完成后提供其视频。
- **租约只在单个进程内**——在同一状态根目录上同时运行的 `dreamverse` profile 可能在 director 处理某个 multiverse 项目时删除它。
- **接管后被中止的节点**——在另一方取得 multiverse 的租约后，director 已中止生成的节点会在内存中保持 `generating`，直到下次启动。
- **快速隧道后的事件流**——Cloudflare 快速隧道会扣住 `events` 路由的响应体，直到响应结束，因此页面改为读取 `GET /multiverse/api/multiverses/<id>`。
- **日志中没有渲染后的增强器请求**——`prompt_enhance_request` 记录增强器的输入；提示词增强器据此渲染出的模板和用户消息不会被记录。
- **已被 video harness 取代**——[video harness](../../../docs/subsystems/video-harness.zh.md) 用`@video-harness/runtime` 中的 plan continuity 加分支取代了本包；本包仅为 `dreamverse` 与 `dreamverse-multiverse` profile 保留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
