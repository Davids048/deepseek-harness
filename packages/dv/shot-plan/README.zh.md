---
description: "DreamVerse 的分镜组件：dvShotPlan 服务，带 PlanId 和编号版本的分镜计划，操作 plan.create、plan.update 和 plan.approve 及其智能体工具，以及 plan 状态切片。"
kind: "package-reference"
---

# @dv/shot-plan

[English](README.md) | 中文

## 概述

用这个包在生成任何内容之前规划一段视频。一个分镜计划有一个 `PlanId`（`p1`、`p2`……）和编号的版本。它向 `dvProject` 注册三个操作：`plan.create` 把新分镜计划的版本 1 存为 JSON 素材，`plan.update` 存储已有分镜计划的下一个版本，`plan.approve` 记录用户对一个版本的同意，并调度其新增或修改镜头的渲染，以及排列每个镜头版本的时间线。`dvProject` 把它们变成智能体工具 `dv_plan_create`、`dv_plan_update` 和 `dv_plan_approve`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 之后挂载本插件。批准需要操作 `shot.render`（镜头渲染）、`timeline.create` 和 `timeline.update`（时间线），并读取 `timeline` 切片，素材库存储分镜计划文件。分镜计划的一个版本包含带提示词和时长的镜头、参考和连续性。批准为每个新增或修改的镜头调度一条 `shot.render`，再调度一条 `timeline.update` 或 `timeline.create` 来排列每个镜头的版本。归约函数维护 `plan` 切片：每个分镜计划的每个版本和批准它的记录。

```yaml
- id: dv-shot-plan
  name: '@dv/shot-plan'
```

本插件没有配置字段。

| 操作 | 工具 | 参数 | 输出和报告 | 确认 |
| --- | --- | --- | --- | --- |
| `plan.create` | `dv_plan_create` | `shots`（每个含 `prompt`、`duration_sec?`、`references?`、`seed?`）、`title?`、`continuity?`（`independent` 或 `chained`）、`references?`、`aspect_ratio?`、`resolution?`、`generation_mode?`、`seed?` | `plan`（`plan.json`）；报告 `{plan, version: 1}`，含分配的 PlanId | `never` |
| `plan.update` | `dv_plan_update` | `plan`（PlanId）和 `plan.create` 的参数：完整的下一个版本 | `plan`（`plan.json`）；报告 `{plan, version}` | `never` |
| `plan.approve` | `dv_plan_approve` | `plan`（PlanId）、`version?`（默认最新版本） | 无；报告 `{plan, version, scheduled}`（按镜头顺序调度的镜头渲染，然后是时间线记录） | `agent_ask_first` |

`PlanId` 是 `p<n>`：`plan.create` 分配的编号比项目中任何分支上任何分镜记录在 `report.plan` 中存过的最大编号大一，所以 ID 不会重复使用。版本从 1 编号，镜头由它在版本中从 1 开始的位置标识，所以六个镜头之后添加的镜头是镜头 7。参考是角色、场景或风格的版本（`c1@1`）或素材 ID。切片 `components.plan` 是 `{plans: Record<PlanId, PlanVersion[]>}`，最早的版本在前；`PlanVersion` 是 `Plan` 的字段加上 `version`、`created_by`（`plan.create` 或 `plan.update` 记录）和 `approved_by`（该版本最新一条已完成的 `plan.approve` 记录，或 null）。服务方法 `getPlan(state, plan, version?)` 返回某个分支状态中的一个 `PlanVersion`，`shotsToRender(state, plan, version?)` 返回批准该版本会生成的镜头位置；智能体集成的批准提问和输入框的批准卡片读取这两者。`approvePlan(context)` 为一次正在运行的 `plan.approve` 调用调度生成。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`plan.create` 和 `plan.update` 由 runner 校验参数，没有镜头的分镜计划会失败，并通过 `context.importAsset` 把版本导入为 `plan.json`；对未知分镜计划的 `plan.update` 在写下记录之前被拒绝。`plan.approve` 从状态读取版本，并为每个镜头构造 `shot.render` 参数 `prompt`、`plan`、`plan_version`、`shot`（位置）、`duration_sec`、`aspect_ratio`、`resolution`、`generation_mode` 和 `seed`，`reference` 输入取镜头自己的参考，否则取分镜计划的参考。当批准所在分支上同一分镜计划的一条 done 状态的 `shot.render` 记录除 `plan`、`plan_version` 和 `shot` 外参数相同、参考输入相同、`first_frame` 输入也相同（独立镜头或第一个镜头没有，链式镜头为前一个镜头沿用的版本）时，镜头沿用该版本；沿用最新的那个。所以生成的镜头之后的链式镜头也会生成，修改分镜计划范围的设置会让每个镜头都生成。对其余每个镜头，它以 `system` actor、在批准记录的界面、会话和轮次中运行一条 `shot.render`，等待在它之前调度的生成；`chained` 连续性下，第一个之后的生成镜头还把前一个镜头的最后静帧（`{record, output: 1}`）作为 `first_frame` 输入。最后一条带参数 `timeline` 和 `plan` 的时间线调用按镜头顺序把每个镜头的版本（沿用或生成的）作为 `clip` 输入，并等待这些生成：对分镜计划的时间线（其最新一条已完成的 `timeline.create` 或 `timeline.update` 记录在 `params.plan` 中指定该 PlanId 的时间线）调用 `timeline.update`，否则以下一个空闲 ID（已用最大编号之后的 `t<n>`，项目没有时间线时为 `t1`）调用 `timeline.create` 新建时间线。因此批准分镜计划的较新版本会替换其时间线的片段，批准另一个分镜计划会添加一条时间线。参考用 `dvProject.parseInputs('shot.render', …)` 解析，所以未知版本会在调度任何生成之前让批准失败。对任何调用方，在写下 `plan.approve` 记录之前，它的 `precondition` 拒绝未知的分镜计划或版本，用同样的方式构造每个将要生成的镜头的 `shot.render` 参数和参考输入，并调用已注册的 `shot.render`（经 `dvProject.listOperations()` 找到）的 `precondition`；有镜头被拒绝时，批准以一个错误被拒绝，错误列出全部这些镜头，例如 "Shot 2, 3 of the plan have no reference image."，后接镜头渲染给出的原因。智能体工具在 `prepareToolCall` 中运行同一个前置条件，所以智能体在提问规则询问用户之前就被拒绝。没有注册 `shot.render` 时只检查分镜计划和版本。本组件只以字符串命名其他操作，并通过 `dvProject.run` 运行它们。

归约函数忽略状态不是 `done` 的记录：一条已完成的 `plan.create` 添加其 `report.plan` 指定的分镜计划的版本 1，一条已完成的 `plan.update` 添加其 `plan` 参数指定的分镜计划的下一个版本，一条已完成的 `plan.approve` 设置其 `version` 参数指定的版本的 `approved_by`，否则设置其 `report.version` 指定的版本的。指定未知分镜计划或版本的记录不产生任何效果。智能体摘要把每个分镜计划列一次，形如 `{plan, title, version, approved_version, shots}`：最新版本、最新的已批准版本或 null，以及最新版本的镜头数。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvShotPlan`：三个操作、PlanId 分配、`getPlan`、`shotsToRender` 和 `approvePlan` |
| [`src/reducer.ts`](src/reducer.ts) | `plan` 归约函数 |
| [`src/types.ts`](src/types.ts) | `PlanId`、`Plan`、`Shot`、`PlanVersion`、`PlanState` |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、调度运行、归约函数和智能体工具。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：每个组件遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

### 工具定义

#### 模型看到什么

三个工具 `dv_plan_create`、`dv_plan_update` 和 `dv_plan_approve`，格式与 `@dv/project` 给每个操作工具的格式相同。描述告诉智能体只有另一个故事才新建分镜计划，用 `dv_plan_update` 在故事的分镜计划上延长、缩短或修改故事（传完整的分镜计划，所有镜头按顺序），并且只在用户同意了它展示的分镜计划之后才调用 `dv_plan_approve`；`dv_plan_create` 和 `dv_plan_update` 还带有确定性说明。智能体集成的提问规则给 `dv_plan_approve` 加上 `user_approved`。

#### Token 影响

插件挂载期间，三个定义固定约 1,200 个 token；`@dv/project` 的共享参数给每个定义最多增加约 200 个 token。

#### KV Cache 影响

这些定义位于每个智能体请求固定的工具段中；挂载或移除插件会改变工具列表，使从工具段开始的缓存前缀失效。

### 工具结果

#### 模型看到什么

一次 `dv_plan_create` 调用返回一个文本块，例如 `done <record>: plan with 2 shots`，附带 `plan.json` 输出、参数和报告 `{"plan":"p1","version":1}`；一次 `dv_plan_update` 调用返回 `plan updated (2 shots)` 和带新版本的报告。一次 `dv_plan_approve` 调用返回 `done <record>: plan p1 v2 approved` 和已调度的记录；智能体随后用 `dv_proj_wait` 等待。镜头没有参考图的批准在任何记录和提问之前被拒绝，消息列出这些镜头，并告诉智能体向用户要一张参考图、更新分镜计划。

#### Token 影响

新建或更新的结果在参数里重复分镜计划：约 100 个 token，每个镜头再加约 50 个。批准的结果不到 100 个 token，每条调度的记录再加一个 ID。

#### KV Cache 影响

每个结果在调用之后追加到对话中；已缓存的前缀保持不变。分镜计划只通过调用自己的参数和结果到达模型。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **分镜计划只有文本**：分镜计划是一个 JSON 文件；除记录和画布节点外没有分镜计划编辑器或预览。
- **批准依赖其他组件的操作**：`plan.approve` 依赖 `shot.render`、`timeline.create` 和 `timeline.update` 的参数、输入角色和输出顺序；那里的改动需要这里同步修改。
