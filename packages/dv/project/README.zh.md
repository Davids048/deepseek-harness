---
description: "DreamVerse 的项目组件：dvProject 服务，保存每个项目的记录和分支，运行操作，计算状态和历史，把每个操作连同它的确认规则变成它的智能体工具，拥有 dv_proj_* 工具，并提供 dv:project 提示词段落。"
kind: "package-reference"
---

# @dv/project

[English](README.md) | 中文

## 概述

使用本包修改和读取 DreamVerse 项目。每次修改都是一条记录，由 `dvProject.run`（组件操作）或某个 `proj.*` 方法（撤销、重做、接受过期记录）写入；新建、切换和重命名分支只修改 `branches.json`。组件用 `registerOperation` 注册操作，用 `registerReducer` 注册归约函数。挂载了 DSH `tools` 注册表时，每个操作都成为它的智能体工具 `dv_<把点换成下划线的操作名>`，与项目自己的 `dv_proj_*` 工具并列。挂载了 DSH `systemPrompt` 服务时，项目的规则和当前分支的项目摘要作为 `dv:project` 提示词段落到达智能体。`CONTRACTS.md` 规定了每个内部模块。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用项目目录和会话目录挂载插件。素材库加载时用 `registerAssetStore` 注册它的存储，聊天会话用 `bindSession` 绑定到项目。智能体调用前需要用户同意的操作把 `OperationSpec.confirm` 设为 `always` 或 `over_gpu_budget`，并提供 `confirmSummary(call, state)`，它返回 `{text, gpu_seconds}`：这次调用要做什么及其 GPU 估算；没有 `confirmSummary` 的这种 spec 会被 `registerOperation` 拒绝（`invalid_params`）。项目随后给该操作的工具加上仅工具参数 `user_approved`（`always`）或 `user_requested`（`over_gpu_budget`），在适用 `always`，或本轮的 GPU 秒数超过 `confirmGpuSecondsThreshold` 时，拒绝不带该参数的智能体调用，此时不写任何记录；拒绝文字让智能体在对话中询问用户，问题用粗体。该参数不进入记录的 params，用户和系统的调用从不被拒绝。每个归约函数经 `Reducer.agentSummary` 把自己切片的字段加入项目摘要。操作在 `OperationSpec.pendingInputRoles` 中列出可以指向尚未完成的记录输出的输入角色：运行器立即记录并执行这样的调用，`resolved_asset` 为 null，生产记录完成后由记录的当前形式填入（时间线中等待渲染的片段使用它）。

```yaml
- id: dv-project
  name: '@dv/project'
  config:
    root: $DV_STATE_ROOT/projects
    sessionRoot: $DV_STATE_ROOT/sessions
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | 必填 | 每个项目一个 `<ProjectId>/` 的目录；不存在时创建 |
| `cpuConcurrency` | `4` | 可同时运行的已调度 `cpu` 记录数 |
| `gpuConcurrency` | `1` | 可同时运行的已调度 `gpu` 记录数 |
| `sessionRoot` | 必填 | 每个聊天会话一个 `<session>.json` 的目录，记录会话绑定的项目 |
| `confirmGpuSecondsThreshold` | `60` | 用户必须同意之前，一个智能体轮次可在 `over_gpu_budget` 操作上花费的估算 GPU 秒数 |
| `promptSectionOrder` | `4900` | `dv:project` 段落在系统提示词中的顺序；在 5000 的工具 SDK 段落之前 |

<a id="understand-the-implementation"></a>
## 理解实现

`src/index.ts` 中的服务委托给十一个私有模块：记录存储（唯一读写 `project.json`、`records.jsonl` 和 `branches.json` 的代码）、运行器、调度器、分支、历史、归约函数注册表、订阅、聊天会话（绑定、暂缓的工具调用）、智能体工具（每个操作一个 DSH 工具，带确认检查）、`dv_proj_*` 工具和智能体上下文（`dv:project` 提示词段落）。一个项目从分支 `main` 开始；其他分支都是 `b<n>`，从另一个分支分出，分支之间从不合并。`branches.json` 还保存项目的当前分支：每个视图和每个聊天会话都读取它，每个执行者的每次写入都立即进入它。只有两种情况会分出分支：人（或者人要求时的智能体）新建分支，或者撤销后当前分支的 head 停在末端之前时有写入到达；新分支从 head 所在的位置开始，旧分支回到末端并保留被撤销的步骤，新分支成为当前分支。记录带有 `session`、`turn` 和 `tool_call`，作为指向 DSH 会话日志的链接：智能体工具在工具运行时读取轮次，即调用方智能体会话的 DSH 轮次编号，来自智能体循环注册的 `turnBoundary` 会话投影（不在轮次中或没有智能体时为 null）。`CONTRACTS.md` 列出每个模块的函数、规则、错误和测试。`listHistory(query)` 是唯一的历史查询：`dv_proj_history_list` 工具和 `@dv/api` 的 `POST /api/dv/history` 路由都调用它。它的筛选条件（`branch`、`marks`、`actor`、`component`、`operation`、`kind`、`status`、`session`、`turn`、`tool_call`、`records`、`before`）以“且”组合，`limit` 在筛选之后生效；每个条目带有它的标记（`current`、`redo`、`branch`、`undone`）和包含该记录的分支。

<a id="further-exploration"></a>
## 进一步探索

- 本包的 `CONTRACTS.md`：模块约定和测试计划。

<a id="model-experience"></a>
## 模型体验

### 操作工具定义

#### 模型看到什么

挂载了 DSH `tools` 注册表时，每个已注册的操作以一个工具 `dv_<把点换成下划线的操作名>` 到达模型：操作的 `description`，后接资源提示（"Uses the GPU." 或 "Runs on the CPU."）以及只读操作（"A read that writes no record."）和确定性操作（"Repeating a call with the same inputs and params reuses the earlier result."）的说明；它的 `params` 加 `toolParams`，以及按 `confirm` 加上的布尔参数 `user_approved`（"Set true only after the user agreed to this exact call in the conversation. …"）或 `user_requested`（"Set true when the user asked for this exact change, or agreed to it in the conversation. …"）；还有共享参数 `reason`（记录的 intent）、`project_id`、`inputs`（按角色给出 `<asset>`、`<record>#<output>`，或角色、场景、风格版本的 `<id>@<version>`；只用于有输入的操作）、`supersedes` 和 `based_on`（后两个只用于写记录的操作）。

#### Token 影响

共享参数给每个定义最多增加约 200 个 token，确认参数再加约 40 个；其余来自操作的描述和参数，每个组件的 README 给出其工具的总量。

#### KV Cache 影响

这些定义位于挂载了 DSH 工具注册表的智能体每次请求固定的工具段中；注册或移除操作会改变工具列表，使从工具段开始的缓存前缀失效。

### 操作工具结果

#### 模型看到什么

一次调用返回一个文本块：`<status> <record>: <summary>`（只读操作不写记录，为 `<status>: <summary>`）、每个输出一行带素材 ID、媒体类型和 URL、调度的记录、参数和报告；挂载了附件服务时，每个图片输出再跟一个图片块。失败或取消的记录返回带其消息的工具错误，被停止的记录返回 "dv_<name> was stopped before it finished."。需要用户同意却没带参数的调用返回工具错误："dv_<name> needs the user's agreement."（超出预算时为 "dv_<name> would bring this turn to about N GPU seconds, above the M s budget."），然后是 "What it will do:" 加 `confirmSummary` 的文字、估算的 GPU 时间，以及指示：把这些给用户看，在对话中用粗体提问，得到用户回答后带 `user_approved: true` 或 `user_requested: true` 再次调用。

#### Token 影响

每次调用约 50 到 200 个 token 的文本，另加图片块；确认拒绝再加上其摘要文字的长度。

#### KV Cache 影响

每个结果在调用之后追加到对话中；已缓存的前缀保持不变。

### 项目工具

#### 模型看到什么

九个工具：`dv_proj_create`、`dv_proj_open`、`dv_proj_state`、`dv_proj_history_list`、`dv_proj_branch_create`、`dv_proj_undo`、`dv_proj_redo`、`dv_proj_stale_accept` 和 `dv_proj_wait`。`dv_proj_history_list` 按从新到旧返回记录及其标记和所在分支（默认 20 条）；其他工具以缩进 JSON 返回一条分支的项目摘要：`record`（只在写记录的工具之后出现：该调用写下的最新记录）、`project_id`、`head`、`branch`、`branches`（每项为 `{name, title}`）、`records`（数量），然后按组件键顺序是各组件的 `agentSummary` 字段（设定库 `characters`、`locations`、`styles`；分镜 `plans`；时间线 `timelines`），最后是 `stale` 和 `recent`（最多十二条记录，带摘要和输出 URL）。`dv_proj_branch_create` 从当前状态分出一个分支（可选 `title`）并在它上面继续；智能体只在用户要求新分支时调用它。`dv_proj_undo` 和 `dv_proj_redo` 作用于当前分支：`dv_proj_undo` 不带 `to` 时撤销一步，带 `to`（`dv_proj_history_list` 里的记录 ID）时让项目回到该记录之后的状态；`dv_proj_redo` 前进一步。

#### Token 影响

插件挂载期间，九个定义固定约 800 个 token。项目摘要起始约 150 个 token，并随项目增长：每条最近记录、每个角色、场景、风格、分镜计划和片段都加上自己的字段。

#### KV Cache 影响

九个定义是固定工具段中不变的一部分；每个结果在调用之后追加到对话中，所以已缓存的前缀保持不变。

### 项目提示词段落

#### 模型看到什么

挂载了 DSH `systemPrompt` 服务时，每一步的系统提示词都带有 `dv:project` 段落。它以项目的规则开头：智能体的每次调用和用户的每次编辑都立即落在项目的当前分支上，用户不需要接受修改；`dv_proj_undo` 和 `dv_proj_redo` 让分支后退和前进，不用新编辑重建之前的状态，回滚之后写入的修改在新分支上继续，被撤销的步骤留在旧分支上；只在用户要求新分支时调用 `dv_proj_branch_create`；用项目摘要中的 ID 指称对象（记录、`<record>#<n>`、`<id>@<version>`、素材、片段），用户用 + → 引用或 `dv:` 提及指出对象，有歧义的指称要询问而不是猜；因需要用户同意而被拒绝的调用要给用户看，并在对话中用粗体提问；过期记录只在用户同意时重做。对绑定了项目的会话，规则之后是 "This conversation belongs to project <ProjectId> …" 和当前分支的项目摘要（缩进 JSON），与 `dv_proj_state` 返回的摘要相同。对未绑定的会话，规则之后是 "No project is bound to this conversation yet: start the work with dv_proj_create."。该段落不含选中项，也不含用户看不到的偏好。

#### Token 影响

每一步约 450 个 token 的规则，另加当前分支的项目摘要：新项目约 150 个 token，并像项目工具中所述那样随项目增长。

#### KV Cache 影响

该段落位于系统提示词中 `promptSectionOrder` 的位置（4900，在工具 SDK 段落之前），每一步从当前分支重建，所以每条改变摘要的记录和每次切换到另一个分支，都会使从该段落开始的缓存前缀失效；规则本身保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有参考图的角色、场景或风格版本解析后不产生任何输入，所以指向这种版本的记录不留下它的痕迹，版本变化后也不会过期。
