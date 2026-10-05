---
description: "视频 harness 的结构化工具：带类型的输入、JSON schema 参数、成本与确认类别，注册到项目运行时，并作为调用即成操作记录的 vh_* 工具暴露给 DSH agent。"
kind: "package-reference"
---

# @video-harness/tools

[English](README.md) | 中文

## 概述

使用本包给 agent 和各视图提供同一套作用于视频项目的工具。每个 `ToolSpec` 声明带类型的输入、JSON schema 参数、输出、成本类别、确认策略和一行摘要。`vhTools` 把每个 spec 注册到项目运行时，并在挂载了 DSH `tools` 注册表时注册为 `vh_<name>` 工具，一次调用即成一条操作记录。自带的 spec 覆盖上传、实体版本、计划、序列编辑、媒体处理、任意命令、经 DreamVerse 生成后端的 `generate.video`，以及经默认模型的 `perception.describe`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@video-harness/assets`、`@video-harness/oplog`、`@video-harness/media` 和 `@video-harness/runtime` 之后挂载插件。挂载了 `dreamverseGeneration` 时出现 `generate.video`，挂载了 `llm`、`agentDefaultModel` 和 `attachments` 时出现 `perception.describe`，挂载了 `tools` 时出现 `vh_*` DSH 工具。

```yaml
- id: vh-tools
  name: '@video-harness/tools'
  config:
    perceptionMaxTokens: 1024
    sessionStateRoot: /var/lib/video-harness/sessions
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `perceptionMaxTokens` | `1024` | 一次 `perception.describe` 回答的输出 token 上限 |
| `imageInput` | `true` | agent 模型是否接受图片；为 `false` 时 `perception.describe` 不调用模型，记录以 `report.unsupported` 结束 |
| `sessionStateRoot` | 必填 | 每个会话一个 JSON 文件的目录，存项目绑定和打开的 turn；重启后的 harness 从这里继续该会话 |

| 工具 | 成本 | 确定性 | 确认 | 效果 |
| --- | --- | --- | --- | --- |
| `asset.upload` | free | 是 | never | 文件路径或 base64 字节成为素材 |
| `entity.character.create` / `.update`、`entity.style.*`、`entity.location.*` | free | 是 | never | 实体版本；更新替代上一版 |
| `plan.create` / `plan.update` | free | 是 | always | 以 JSON 存储的计划文档（镜头、参考、连续性） |
| `plan.approve` | free | 是 | never | 用户的批准；运行时为每个镜头调度一条 `generate.video` 和一条 `sequence.create` |
| `sequence.create` / `replace` / `move` / `set_range` / `insert` / `remove` | free | 是 | never | 由折叠解释的时间线编辑 |
| `clip.trim`、`media.concat`、`media.extract_frame`、`media.probe` | cpu | 是 | never | 经 `vhMedia` 的 ffmpeg 和 ffprobe；`media.extract_frame` 的 `at` 接受 `first`、`last`（默认）或以数字或数字字符串给出的秒数 |
| `command.run` | cpu | 否 | never | 带 `{{in:<n>}}` 和 `{{out:<name>}}` 占位符与声明输出的任意命令 |
| `generate.video` | gpu | 否 | cost | 一个镜头：视频和最后一帧；`reference` 输入携带实体版本或图片，`first_frame` 接续更早的镜头 |
| `perception.describe` | free | 否 | never | 默认模型回答关于某图片素材的问题 |

`vhTools.register(spec)` 添加 spec 并返回其释放函数；`get(name)` 和 `list()` 读取注册表。spec 的 `summarize(op)` 给出聊天卡片或画布节点显示的一行标签。工具把输出之外的事实，例如 `generate.video` 抽取的种子或 `media.probe` 读到的探测结果，放进记录的 `report`。

### DSH 工具

每个 spec 是一个名为 `vh_<把点换成下划线的名字>` 的工具，例如 `vh_generate_video`。除 spec 自己的参数外，每个工具还接受 `reason`（必填；记录的 intent）、`project_id`（默认会话项目）、`inputs`（角色到素材 ID、`entity@version` 或 `<record>#<index>`；接受多个的角色用列表）、`replaces`（本次调用替代的记录）和 `base_op`；`vh_generate_video` 还接受 `continue_from`，即新镜头从其最后一帧开始的那条镜头记录。输入指向未完成记录的调用会被调度并返回 `pending`；否则立即运行并返回 `done`。结果给出记录、状态、摘要、带 `/vh/assets/<id>/content` URL 的输出、运行时因本次调用调度的记录、参数和报告；挂载了附件服务时图片输出还以图片块到达。

一个 agent 会话的记录都进入草稿分支上的一个开着的 turn，直到会话接受或拒绝它。管理工具有 `vh_project_create`、`vh_project_use`、`vh_project_state`、`vh_turn_accept`、`vh_turn_reject`、`vh_undo`、`vh_branch_create`、`vh_branch_use` 和 `vh_wait`；每个都返回项目状态：实体、时间线、计划、过期记录、分支、开着的 turn 和最近的记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`VhTools` 保存 spec 映射并把每个 spec 注册到 `vhProject.registerTool`；在 `ctx.inject(['tools'])` 内创建 DSH 桥接器，它为每个 spec 定义一个 `defineTool` 工具以及管理工具，并在注册表或服务消失时移除它们。桥接器为每个 agent 会话保存一份 `SessionState`（以 agent 的会话 ID 为键，直接调用用 `anonymous`）：项目、开着的 turn 及其项目、探索分支。一次调用解析项目，没有开着的 turn 时以调用的 reason 开一个，按 spec 的角色解析 `inputs`，然后调用 `vhProject.invoke`，输入指向未完成记录时改为 `vhProject.schedule`。

`generate.video` 从 `dreamverseGeneration.model()` 读取模型事实，按参数和模型默认值解析帧尺寸与帧数，用 DreamVerse 规则校验参考图数量，用 `segmentRequestImages` 排列请求图片（先参考图，再前一镜头的最后一帧），没给种子时抽取一个，把片段流写入临时文件，然后以该记录为产生者存储视频和 PNG 最后一帧。

| 文件 | 内容 |
| --- | --- |
| [`src/types.ts`](src/types.ts) | `ToolSpec`、`InputSpec`、`OutputSpec`、`Confirm` |
| [`src/specs-basic.ts`](src/specs-basic.ts) | 上传、实体、计划、序列编辑 |
| [`src/specs-media.ts`](src/specs-media.ts) | 裁剪、拼接、抽帧、探测、`command.run` |
| [`src/specs-generate.ts`](src/specs-generate.ts) | `generate.video` 和 `shotGeometry` |
| [`src/specs-perception.ts`](src/specs-perception.ts) | `perception.describe` |
| [`src/dsh.ts`](src/dsh.ts) | DSH 桥接器：工具定义、会话状态、管理工具、渲染 |
| [`src/index.ts`](src/index.ts) | `vhTools` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md) — 整个 harness 中的记录、草稿、过期和调度。
- [`@video-harness/runtime`](../runtime/README.zh.md) — `invoke`、`schedule`、计划展开和重放。
- [`@video-harness/media`](../media/README.zh.md) — 媒体工具背后的媒体服务。
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.zh.md) — `generate.video` 背后的后端客户端。

-----

<a id="model-experience"></a>
## 模型体验

### DSH 工具定义

#### 模型看到什么

每个已注册 spec 对应一个名为 `vh_<name>` 的工具，描述里带 spec 的摘要、成本类别、确定性和确认策略，参数是 spec 自己的参数加共享的 `reason`、`project_id`、`inputs`、`replaces` 和 `base_op`（`vh_generate_video` 另有 `continue_from`），再加九个管理工具。工具是否可用随挂载的服务而定：`vh_generate_video` 需要生成后端，`vh_perception_describe` 需要模型、默认模型和附件服务。本包不在 `packages/*/tool-*` 下，因此生成的工具目录不列出这些定义；`vhTools.list()` 和 `ctx.tools.schemas()` 是其来源。

#### Token 影响

约三十个工具定义，描述为一到三句话；`inputs` 的描述列出 spec 的角色。

#### KV Cache 影响

挂载的服务和已注册 spec 不变时前缀稳定；挂载或移除某个后端会改变工具列表，并从第一个变化的定义起失去复用。

### 工具结果

#### 模型看到什么

一个文本块：`<status> <record>: <summary>`，每个输出一行（角色、素材 ID、MIME 类型、URL），本次调用调度的记录，JSON 形式的参数和报告；挂载了附件服务时每个图片输出再加一个图片块。管理工具以缩进 JSON 返回项目状态。

#### Token 影响

一次结构化调用是几行加参数；`vh_project_state` 随项目增长，最多列出十二条最近记录。

#### KV Cache 影响

结果追加到对话；不改变更早的内容。

### 感知请求

#### 模型看到什么

`perception.describe` 经 `ctx.llm.stream()` 发送一次请求，使用 `ctx.agentDefaultModel.currentSelection()` 的 provider 和模型，无系统提示词，`maxTokens` 为 `perceptionMaxTokens`，一条用户消息包含图片附件和随后的问题，问题默认为下面的文本。`imageInput` 为 `false`，或所选模型的目录条目没有声明图片输入时，不发送请求：记录以一个文本输出和说明原因的 `report.unsupported` 正常结束，agent 读到原因而不是一条失败记录。

##### 默认问题

```markdown
Describe this image: the subject, the framing, the lighting, and anything that looks wrong.
```

#### Token 影响

每次调用一张图片加问题；回答受 `perceptionMaxTokens` 限制。

#### KV Cache 影响

无；每次调用都是 agent 对话之外的一次性请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **桥自身看不到 turn 边界** — 开着的 turn 以 `vh_turn_accept` 或 `vh_turn_reject` 结束；`@video-harness/agent` 通过 `noteTurn` 和 `settleTurn` 报告 agent loop 的 turn，没有它时一个 turn 可能跨多条用户消息。
- **确认只是建议** — `confirm` 通过工具描述到达模型；高成本调用前不咨询 harness 的审批服务。
- **没有系统提示词章节** — 工作流（项目、参考、实体、计划、批准、生成）只在工具描述里说明。
- **计划文档只有文本** — `plan.create` 把镜头存为 JSON；除记录外没有计划编辑器或预览。
