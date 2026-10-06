---
description: "视频 harness 的结构化工具：带类型的输入、JSON schema 参数、资源与确认类别，作为操作注册到 dvProject，并作为调用即成项目记录的 vh_* 工具暴露给 DSH agent。"
kind: "package-reference"
---

# @video-harness/tools

[English](README.md) | 中文

## 概述

使用本包给 agent 和各视图提供同一套作用于视频项目的工具。每个 `ToolSpec` 在 `@dv/project` 的 `OperationSpec` 之上加了带类型的输入、输出和一行摘要；它声明 JSON schema 参数、所属组件、资源类别和确认策略。`vhTools` 用 `dvProject.registerOperation` 注册每个 spec，并在挂载了 DSH `tools` 注册表时注册为 `vh_<name>` 工具，一次调用经 `dvProject.run` 运行该操作，成为一条记录。它还注册第 2 阶段的桥接 reducer `timeline`、`bible`、`plan`、`shot`，以及 `dv_proj_*` 注册表工具。自带的 spec 覆盖导入、角色/场景/风格版本、计划、时间线编辑、媒体处理、经 DreamVerse 生成后端的 `generate.video`，以及经默认模型的 `perception.describe`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@video-harness/assets`、`@dv/project` 和 `@video-harness/media` 之后挂载插件。挂载了 `dreamverseGeneration` 时出现 `generate.video`，挂载了 `llm`、`agentDefaultModel` 和 `attachments` 时出现 `perception.describe`，挂载了 `tools` 时出现 `vh_*` 和 `dv_proj_*` DSH 工具。

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
| `imageInput` | `true` | agent 模型是否接受图片；为 `false` 时 `perception.describe` 不调用模型，以 `report.unsupported` 作答 |
| `sessionStateRoot` | 必填 | 每个会话一个 JSON 文件的目录，存项目绑定；重启后的 harness 从这里继续该会话 |

| 工具 | 资源 | 确定性 | 确认 | 效果 |
| --- | --- | --- | --- | --- |
| `asset.upload` | none | 是 | never | 文件路径或 base64 字节成为素材（组件 `asset`） |
| `entity.character.create` / `.update`、`entity.style.*`、`entity.location.*` | none | 是 | never | 角色、场景和风格的版本（组件 `bible`）；更新未知 ID 时记录失败 |
| `plan.create` / `plan.update` | none | 是 | never | 以 JSON 存储的计划文档（镜头、参考、连续性）（组件 `plan`） |
| `plan.approve` | none | 否 | agent_ask_first | 用户的批准（组件 `plan`）；它的 execute 以 `system` actor 经 `dvProject.run` 为每个镜头调度一条 `generate.video` 和一条 `sequence.create`；DSH 提问规则 `always` 需要 `user_approved: true` |
| `sequence.create` / `replace` / `move` / `set_range` / `insert` / `remove` | none | 是 | never | 由 `timeline` 桥接 reducer 解释的时间线编辑（组件 `timeline`） |
| `media.concat`、`media.extract_frame`、`media.probe` | cpu | 是 | never | 经 `vhMedia` 的 ffmpeg 和 ffprobe（组件 `deliver`、`asset`、`inspect`）；`media.extract_frame` 的 `at` 接受 `first`、`last`（默认）或以数字或数字字符串给出的秒数 |
| `clip.trim` | cpu | 是 | never | 经 `vhMedia` 把片段裁到一个范围，供时间线导出（组件 `deliver`）；只供导出的操作：`get(name)` 返回它而 `list()` 不列出它，因此没有 DSH 工具，也没有画布表单 |
| `generate.video` | gpu | 否 | agent_ask_first | 一个镜头：视频和最后一帧（组件 `shot`）；`reference` 输入携带实体版本或图片，`first_frame` 接续更早的镜头；DSH 提问规则 `cost` 在超出本轮 GPU 预算且调用没有带 `user_requested: true` 时提问 |
| `perception.describe` | none | 否 | never | 只读操作（组件 `inspect`）：默认模型在报告里回答关于某图片素材的问题，不写记录 |

`vhTools.register(spec)` 添加 spec 并返回其释放函数；同名注册两次抛出 `operation_exists`。`get(name)` 和 `list()` 读取注册表。spec 的 `summarize(record)` 给出聊天卡片或画布节点显示的一行标签。工具把输出之外的事实，例如 `generate.video` 抽取的种子或 `media.probe` 读到的探测结果，放进记录的 `report`。`confirm: agent_ask_first` 使会话的输入框处于先问模式时，`dvProject` 把 agent 的记录挡在输入框的批准卡片之后；DSH 提问规则（`plan.approve` 为 `always`，`generate.video` 为 `cost`）留在桥接器里。

### DSH 工具

除 `clip.trim` 外，每个已注册 spec 是一个名为 `vh_<把点换成下划线的名字>` 的工具，例如 `vh_generate_video`。除 spec 自己的参数外，每个工具还接受 `reason`（必填；记录的 intent）、`project_id`（默认会话项目）、`inputs`（角色到素材 ID、`entity@version` 或 `<record>#<index>`；接受多个的角色用列表；按会话的当前分支解析）、`replaces`（本次调用替代的记录）和 `base_op`（记录的 `based_on`）；`vh_generate_video` 还接受 `continue_from`，即新镜头从其最后一帧开始的那条镜头记录。输入指向未完成记录的调用会被调度并返回 `pending`；否则立即运行并返回 `done`；以 `failed` 或 `cancelled` 结束的记录作为工具错误报告。结果给出记录（只读操作不写记录，此处为空）、状态、摘要、带 `/vh/assets/<id>/content` URL 的输出、本次调用调度的记录、参数和报告；挂载了附件服务时图片输出还以图片块到达。

一个 agent 会话的记录进入会话的当前分支：agent 的第一次调用打开草稿 `draft/<session>`，它跨越多个轮次，也装着用户的编辑，直到用户接受或丢弃它。注册表工具有 `dv_proj_create`、`dv_proj_open`、`dv_proj_state`、`dv_proj_history_list`、`dv_proj_draft_accept`、`dv_proj_draft_discard`、`dv_proj_undo`、`dv_proj_redo`、`dv_proj_stale_accept`（原样保留一条过期记录）、`dv_proj_branch_create`（一条 `explore/<name>` 分支，会话随后在其上工作）、`dv_proj_branch_switch` 和 `dv_proj_wait`；`dv_proj_history_list` 按从新到旧返回记录及其标记，其他工具返回一条分支的状态：角色、场景和风格，时间线，计划，过期记录，分支，草稿计数和最近的记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`VhTools` 保存 spec 映射，用 `dvProject.registerOperation` 注册每个 spec，并用 `dvProject.registerReducer` 注册 `src/reducers.ts` 里的桥接 reducer；在 `ctx.inject(['tools'])` 内创建 DSH 桥接器，它为除 `clip.trim` 外的每个 spec 定义一个 `defineTool` 工具，再加注册表工具，并在注册表或服务消失时移除它们。桥接器为每个 agent 会话保存一份 `SessionState`（以 agent 的会话 ID 为键，直接调用用 `anonymous`），内容是绑定的项目，存于 `sessionStateRoot` 下，还记着 `noteTurn` 报告的当前轮次和用户的原话。一次调用解析项目，读取会话当前分支的状态，按 spec 的角色解析 `inputs`，应用提问规则，然后以 agent 为 actor、带上会话、轮次、工具调用和本轮的 `request_text` 调用 `dvProject.run`；`request_text` 让本轮第一条记录之前写下本轮的请求记录。`recordChatImages` 把聊天图片作为用户的 `asset.upload` 记录导入到会话的当前分支。

`generate.video` 从 `dreamverseGeneration.model()` 读取模型事实，按参数和模型默认值解析帧尺寸与帧数，用 DreamVerse 规则校验参考图数量，用 `segmentRequestImages` 排列请求图片（先参考图，再前一镜头的最后一帧），没给种子时抽取一个，把片段流写入临时文件，然后经 `importAsset` 以该记录为产生者导入视频和 PNG 最后一帧。

| 文件 | 内容 |
| --- | --- |
| [`src/types.ts`](src/types.ts) | `ToolSpec`、`InputSpec`、`OutputSpec`、桥接 reducer 的状态切片 |
| [`src/specs-basic.ts`](src/specs-basic.ts) | 导入、角色/场景/风格、计划与计划批准、时间线编辑 |
| [`src/specs-media.ts`](src/specs-media.ts) | 裁剪、拼接、抽帧、探测 |
| [`src/specs-generate.ts`](src/specs-generate.ts) | `generate.video` 和 `shotGeometry` |
| [`src/specs-perception.ts`](src/specs-perception.ts) | `perception.describe` |
| [`src/dsh.ts`](src/dsh.ts) | DSH 桥接器：工具定义、会话状态、注册表工具、渲染 |
| [`src/reducers.ts`](src/reducers.ts) | 第 2 阶段的桥接 reducer `timeline`、`bible`、`plan`、`shot` |
| [`src/index.ts`](src/index.ts) | `vhTools` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md) — 整个 harness 中的记录、草稿、过期和调度。
- [`@dv/project`](../../dv/project/README.zh.md) — 记录、草稿、撤销与重做、运行器与调度器、reducer 注册表。
- [`@video-harness/media`](../media/README.zh.md) — 媒体工具背后的媒体服务。
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.zh.md) — `generate.video` 背后的后端客户端。

-----

<a id="model-experience"></a>
## 模型体验

### DSH 工具定义

#### 模型看到什么

除 `clip.trim` 外，每个已注册 spec 对应一个名为 `vh_<name>` 的工具，描述里带 spec 的摘要、资源类别、确定性和提问规则，参数是 spec 自己的参数加共享的 `reason`、`project_id`、`inputs`、`replaces` 和 `base_op`（`vh_generate_video` 另有 `continue_from`），再加十一个注册表工具。工具是否可用随挂载的服务而定：`vh_generate_video` 需要生成后端，`vh_perception_describe` 需要模型、默认模型和附件服务。本包不在 `packages/*/tool-*` 下，因此生成的工具目录不列出这些定义；`vhTools.list()` 和 `ctx.tools.schemas()` 是其来源。

#### Token 影响

约三十个工具定义，描述为一到三句话；`inputs` 的描述列出 spec 的角色。

#### KV Cache 影响

挂载的服务和已注册 spec 不变时前缀稳定；挂载或移除某个后端会改变工具列表，并从第一个变化的定义起失去复用。

### 工具结果

#### 模型看到什么

一个文本块：`<status> <record>: <summary>`（只读操作为 `<status>: <summary>`），每个输出一行（角色、素材 ID、MIME 类型、URL），本次调用调度的记录，JSON 形式的参数和报告；挂载了附件服务时每个图片输出再加一个图片块。注册表工具以缩进 JSON 返回分支状态或历史。

#### Token 影响

一次结构化调用是几行加参数；`dv_proj_state` 随项目增长，最多列出十二条最近记录。

#### KV Cache 影响

结果追加到对话；不改变更早的内容。

### 感知请求

#### 模型看到什么

`perception.describe` 经 `ctx.llm.stream()` 发送一次请求，使用 `ctx.agentDefaultModel.currentSelection()` 的 provider 和模型，无系统提示词，`maxTokens` 为 `perceptionMaxTokens`，一条用户消息包含图片附件和随后的问题，问题默认为下面的文本。`imageInput` 为 `false`，或所选模型的目录条目没有声明图片输入时，不发送请求：报告里的 `unsupported` 说明原因，agent 读到原因而不是一次失败的调用。

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

- **轮次来自 agent 层** — `@video-harness/agent` 通过 `noteTurn` 报告每个轮次和用户的原话；没有它时记录不带轮次，也不写请求记录。
- **DSH 提问规则只是建议** — `always` 和 `cost` 通过工具描述以及 `user_approved` / `user_requested` 参数到达模型；只有输入框的先问模式经 `dvProject` 的批准通道把调用挡到用户回答为止。
- **没有系统提示词章节** — 工作流（项目、参考、实体、计划、批准、生成）只在工具描述里说明。
- **计划文档只有文本** — `plan.create` 把镜头存为 JSON；除记录外没有计划编辑器或预览。
