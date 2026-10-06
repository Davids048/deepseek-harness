---
description: "DreamVerse 的项目组件：dvProject 服务，保存每个项目的记录、分支和草稿，运行操作，计算状态和历史，把每个操作变成它的智能体工具，并拥有 dv_proj_* 工具。"
kind: "package-reference"
---

# @dv/project

[English](README.md) | 中文

## 概述

使用本包修改和读取 DreamVerse 项目。每次修改都是一条记录，由 `dvProject.run`（组件操作）或某个 `proj.*` 方法（草稿、撤销、重做、分支）写入。组件用 `registerOperation` 注册操作，用 `registerReducer` 注册状态归约函数。挂载了 DSH `tools` 注册表时，每个已注册的操作还成为它的智能体工具 `dv_<把点换成下划线的操作名>`，项目还加上自己的 `dv_proj_*` 工具，它们把聊天会话绑定到项目并返回项目摘要。`CONTRACTS.md` 规定了每个内部模块。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用项目目录和会话目录挂载插件。素材库加载时用 `registerAssetStore` 注册它的存储，聊天会话用 `bindSession` 绑定到项目，智能体集成经 `registerToolCallCheck` 检查每次智能体工具调用。每个归约函数经 `Reducer.agentSummary` 把自己切片的字段加入项目摘要。操作在 `OperationSpec.pendingInputRoles` 中列出可以指向尚未完成的记录输出的输入角色：运行器立即记录并执行这样的调用，`resolved_asset` 为 null，生产记录完成后由记录的当前形式填入（时间线中等待渲染的片段使用它）。

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

<a id="understand-the-implementation"></a>
## 理解实现

`src/index.ts` 中的服务委托给十个私有模块：记录存储（唯一读写 `project.json`、`records.jsonl` 和 `branches.json` 的代码）、运行器、调度器、草稿与分支、历史、归约函数注册表、订阅、聊天会话（绑定、轮次、暂缓的工具调用）、智能体工具（每个操作一个 DSH 工具）和 `dv_proj_*` 工具。`CONTRACTS.md` 列出每个模块的函数、规则、错误和测试。`listHistory(query)` 是唯一的历史查询：`dv_proj_history_list` 工具和 `@dv/api` 的 `POST /api/dv/history` 路由都调用它。它的筛选条件（`branch`、`marks`、`actor`、`component`、`operation`、`kind`、`status`、`session`、`turn`、`tool_call`、`records`、`before`）以“且”组合，`limit` 在筛选之后生效。

<a id="further-exploration"></a>
## 进一步探索

- 本包的 `CONTRACTS.md`：模块约定和测试计划。

<a id="model-experience"></a>
## 模型体验

### 操作工具定义

#### 模型看到什么

挂载了 DSH `tools` 注册表时，每个已注册的操作以一个工具 `dv_<把点换成下划线的操作名>` 到达模型：操作的 `description`，后接资源提示（"Uses the GPU." 或 "Runs on the CPU."）以及只读操作（"A read that writes no record."）和确定性操作（"Repeating a call with the same inputs and params reuses the earlier result."）的说明；它的 `params` 加 `toolParams`，以及智能体集成的提问规则加上的参数；还有共享参数 `reason`（记录的 intent）、`project_id`、`inputs`（按角色给出 `<asset>`、`<record>#<output>`，或角色、场景、风格版本的 `<id>@<version>`；只用于有输入的操作）、`supersedes` 和 `based_on`（后两个只用于写记录的操作）。

#### Token 影响

共享参数给每个定义最多增加约 200 个 token；其余来自操作的描述和参数，每个组件的 README 给出其工具的总量。

#### KV Cache 影响

这些定义位于挂载了 DSH 工具注册表的智能体每次请求固定的工具段中；注册或移除操作会改变工具列表，使从工具段开始的缓存前缀失效。

### 操作工具结果

#### 模型看到什么

一次调用返回一个文本块：`<status> <record>: <summary>`（只读操作不写记录，为 `<status>: <summary>`）、每个输出一行带素材 ID、媒体类型和 URL、调度的记录、参数和报告；挂载了附件服务时，每个图片输出再跟一个图片块。失败或取消的记录返回带其消息的工具错误，用户拒绝的调用返回 "The user declined dv_<name>. Do not retry it unchanged."。

#### Token 影响

每次调用约 50 到 200 个 token 的文本，另加图片块。

#### KV Cache 影响

每个结果在调用之后追加到对话中；已缓存的前缀保持不变。

### 项目工具

#### 模型看到什么

十二个工具：`dv_proj_create`、`dv_proj_open`、`dv_proj_state`、`dv_proj_history_list`、`dv_proj_draft_accept`、`dv_proj_draft_discard`、`dv_proj_undo`、`dv_proj_redo`、`dv_proj_stale_accept`、`dv_proj_branch_create`、`dv_proj_branch_switch` 和 `dv_proj_wait`。`dv_proj_history_list` 按从新到旧返回记录及其标记（默认 20 条）；其他工具以缩进 JSON 返回一条分支的项目摘要：`record`（只在写记录的工具之后出现：该调用写下的最新记录）、`project_id`、`head`、`branch`、`draft`（计数或 null）、`branches`、`records`（数量），然后按组件键顺序是各组件的 `agentSummary` 字段（设定库 `characters`、`locations`、`styles`；分镜 `plans`；时间线 `timelines`），最后是 `stale` 和 `recent`（最多十二条操作记录，带摘要和输出 URL）。`dv_proj_undo` 和 `dv_proj_redo` 作用于智能体写入的分支（它的草稿，否则是 `main`）：`dv_proj_undo` 不带 `to` 时撤销一步，带 `to`（`dv_proj_history_list` 里的记录 ID）时让项目回到该记录之后的状态；`dv_proj_redo` 前进一步。

#### Token 影响

插件挂载期间，十二个定义固定约 1,000 个 token。项目摘要起始约 150 个 token，并随项目增长：每条最近记录、每个角色、场景、风格、分镜计划和片段都加上自己的字段。

#### KV Cache 影响

十二个定义是固定工具段中不变的一部分；每个结果在调用之后追加到对话中，所以已缓存的前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有参考图的角色、场景或风格版本解析后不产生任何输入，所以指向这种版本的记录不留下它的痕迹，版本变化后也不会过期。
