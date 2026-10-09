---
description: "DreamVerse 的分镜组件：dvShotPlan 服务，带 PlanId 和编号版本的分镜计划，操作 plan.create、plan.update 和 plan.approve 及其智能体工具，以及 plan 状态切片。"
kind: "package-reference"
---

# @dv/shot-plan

[English](README.md) | 中文

## 概述

用这个包在生成任何内容之前规划一段视频。一个分镜计划有一个 `PlanId`（`p1`、`p2`……）和编号的版本，分镜计划的每个镜头写明自己的生成方式。`plan.create` 存储新分镜计划的版本 1，`plan.update` 存储下一个版本，`plan.approve` 记录用户对一个版本的同意，用每个新增或修改镜头的生成方式对应的镜头渲染操作调度它的渲染，并把每个镜头的版本排进一条时间线。智能体以 `dv_plan_create`、`dv_plan_update` 和 `dv_plan_approve` 调用它们。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 之后挂载本插件。批准需要镜头所写的每种生成方式对应的镜头渲染操作（`shot.render_ref2va`、`shot.render_t2va`）、操作 `timeline.create` 和 `timeline.update`（时间线），并读取 `timeline` 切片，素材库存储分镜计划文件。分镜计划的一个版本包含镜头（每个镜头有生成方式 `mode`、提示词、时长和输入），以及 `ref2va` 镜头共用的参考。批准为每个新增或修改的镜头调度一次渲染，再调度一条 `timeline.update` 或 `timeline.create` 来排列每个镜头的版本。归约函数维护 `plan` 切片：每个分镜计划的每个版本和批准它的记录。

```yaml
- id: dv-shot-plan
  name: '@dv/shot-plan'
```

本插件没有配置字段。

| 操作 | 工具 | 参数 | 输出和报告 | 确认 |
| --- | --- | --- | --- | --- |
| `plan.create` | `dv_plan_create` | `shots`（每个含 `mode`（`ref2va` 或 `t2va`）、`prompt`、`duration_sec?`、`references?`（仅 `ref2va`）、`continue_previous?`（仅 `ref2va`，镜头 1 不可用）、`seed?`）、`title?`、`references?`（`ref2va` 镜头共用）、`aspect_ratio?`、`resolution?`、`seed?` | `plan`（`plan.json`）；报告 `{plan, version: 1, shots, gpu_seconds}`，含分配的 PlanId | `never` |
| `plan.update` | `dv_plan_update` | `plan`（PlanId）和 `plan.create` 的参数：完整的下一个版本 | `plan`（`plan.json`）；报告 `{plan, version, shots, gpu_seconds}` | `never` |
| `plan.approve` | `dv_plan_approve` | `plan`（PlanId）、`version?`（默认最新版本） | 无；报告 `{plan, version, scheduled}`（按镜头顺序调度的镜头渲染，然后是时间线记录） | `always`，带 `confirmSummary` |

`PlanId` 是 `p<n>`：`plan.create` 分配的编号比项目整个历史中（包括已撤销的记录）任何分镜记录在 `report.plan` 中存过的最大编号大一，所以 ID 不会重复使用。版本从 1 编号，镜头由它在版本中从 1 开始的位置标识，所以六个镜头之后添加的镜头是镜头 7。参考是角色、场景或风格的版本（`c1@1`）或素材 ID。切片 `components.plan` 是 `{plans: Record<PlanId, PlanVersion[]>}`，最早的版本在前；`PlanVersion` 是 `Plan` 的字段加上 `version`、`created_by`（`plan.create` 或 `plan.update` 记录）和 `approved_by`（该版本最新一条已完成的 `plan.approve` 记录，或 null）。服务方法 `getPlan(state, plan, version?)` 返回某个项目状态中的一个 `PlanVersion`，`shotsToRender(state, plan, version?)` 返回批准该版本会生成的镜头位置。`approvePlan(context)` 为一次正在运行的 `plan.approve` 调用调度生成。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`plan.create` 和 `plan.update` 由 runner 校验参数，没有镜头的分镜计划会失败，并通过 `context.importAsset` 把版本导入为 `plan.json`；对任何调用方，在写下记录之前，它们拒绝未知 PlanId 的分镜计划（`plan.update`）、生成方式没有已注册镜头渲染操作（`shot.render_<mode>`，经 `dvProject.listOperations()` 查找）的镜头、带参考的 `t2va` 镜头，以及镜头 1 或 `t2va` 镜头上的 `continue_previous`，用一个错误列出每个镜头及其问题；它们还拒绝指向未知角色、场景或风格版本的参考。它们的报告加上 `shots`（版本的每个镜头一行）和 `gpu_seconds`（在它们写入的状态中批准该版本的 GPU 估算），与 `plan.approve` 的 `confirmSummary`（见下）用相同的行和总和。所以分镜计划只会写部署提供的生成方式：没有挂载 `t2va` 生成方式时，`t2va` 镜头被拒绝，错误列出可用的生成方式。`plan.approve` 从状态读取版本，并为每个镜头构造其生成方式的渲染操作、参数 `prompt`、`plan`、`plan_version`、`shot`（位置）、`duration_sec`、`aspect_ratio`、`resolution` 和 `seed`；`ref2va` 镜头的 `reference` 输入取镜头自己的参考，否则取分镜计划的参考；`t2va` 镜头没有输入。当批准时的状态中同一分镜计划、同一渲染操作的一条 done 状态记录除 `plan`、`plan_version` 和 `shot` 外参数相同、参考输入相同、`first_frame` 输入也相同（没有 `continue_previous` 的镜头没有，有 `continue_previous` 的镜头为前一个镜头沿用的版本）时，镜头沿用该版本；沿用最新的那个。所以生成的镜头之后接上一镜头的镜头也会生成，改了生成方式的镜头会生成，修改分镜计划范围的设置会让每个镜头都生成。对其余每个镜头，它以 `system` actor、在批准记录的界面、会话和轮次中运行一次该镜头的渲染操作，等待在它之前调度的生成；带 `continue_previous` 的生成镜头还把前一个镜头的最后静帧（`{record, output: 1}`）作为 `first_frame` 输入。最后一条带参数 `timeline` 和 `plan` 的时间线调用按镜头顺序把每个镜头的版本（沿用或生成的）作为 `clip` 输入（`{record, output: 0}`），并立即运行，所以批准后时间线马上列出每个镜头，渲染尚未完成的镜头是占位片段：对分镜计划的时间线（其最新一条已完成的 `timeline.create` 或 `timeline.update` 记录在 `params.plan` 中指定该 PlanId 的时间线）调用 `timeline.update`，否则以下一个空闲 ID（已用最大编号之后的 `t<n>`，项目没有时间线时为 `t1`）调用 `timeline.create` 新建时间线。因此批准分镜计划的较新版本会替换其时间线的片段，批准另一个分镜计划会添加一条时间线。参考用 `dvProject.parseInputs` 按镜头的渲染操作解析，所以未知版本会在调度任何生成之前让批准被拒绝。对任何调用方，在写下 `plan.approve` 记录之前，它的 `precondition` 拒绝未知的分镜计划或版本，以及 `plan.create` 拒绝的那些镜头问题（分镜计划写好之后，生成方式可能被卸载），用同样的方式构造每个将要生成的镜头的参数和输入，并在镜头的渲染操作有 `precondition` 时调用它（`shot.render_ref2va`：参考图规则）；有镜头被拒绝时，批准以一个错误被拒绝，错误列出全部这些镜头，例如 "Shot 2, 3 of the plan are refused by its render operation."，后接第一个镜头渲染给出的原因。智能体工具在 `prepareToolCall` 中运行同一个前置条件，所以智能体在 Project 要求它征得用户同意之前就被拒绝。`plan.approve` 的 `confirm` 是 `always`：Project 拒绝不带 `user_approved: true` 的智能体调用，并把 `confirmSummary` 的文字放进拒绝消息：每个镜头一行（生成方式、时长、是否接上一个镜头、提示词的前 80 个字符，或沿用其版本），以及将要生成的镜头的渲染操作 `estimate` 之和作为 GPU 秒数。本组件只以字符串命名其他操作，并通过 `dvProject.run` 运行它们。

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

三个工具 `dv_plan_create`、`dv_plan_update` 和 `dv_plan_approve`，格式与 `@dv/project` 给每个操作工具的格式相同。描述告诉智能体只有另一个故事才新建分镜计划，给每个镜头选一个它有工具的生成方式、按该生成方式写提示词，用 `dv_plan_update` 在故事的分镜计划上延长、缩短或修改故事（传完整的分镜计划，所有镜头按顺序），并且只在展示分镜计划、用户在对话中同意之后才调用 `dv_plan_approve`；`dv_plan_create` 和 `dv_plan_update` 还带有确定性说明。因为 `confirm` 是 `always`，Project 给 `dv_plan_approve` 加上 `user_approved`。

#### Token 影响

插件挂载期间，三个定义固定约 1,500 个 token；`@dv/project` 的共享参数给每个定义最多增加约 200 个 token。

#### KV Cache 影响

这些定义位于每个智能体请求固定的工具段中；挂载或移除插件会改变工具列表，使从工具段开始的缓存前缀失效。

### 工具结果

#### 模型看到什么

一次 `dv_plan_create` 调用返回一个文本块，例如 `done <record>: plan with 2 shots`，附带 `plan.json` 输出、参数和报告 `{"plan":"p1","version":1,"shots":[…],"gpu_seconds":20}`，所以智能体在询问之前就能展示 GPU 估算；一次 `dv_plan_update` 调用返回 `plan updated (2 shots)` 和带新版本的报告，其镜头行标出沿用版本的镜头。含有部署无法渲染的镜头的分镜计划在任何记录之前被拒绝，每个问题一句话，例如可用的生成方式。不带 `user_approved: true` 的 `dv_plan_approve` 调用被拒绝，拒绝消息带有 `confirmSummary` 的镜头行和 GPU 估算，并要求在对话中询问用户、问题用粗体。带它的 `dv_plan_approve` 调用返回 `done <record>: plan p1 v2 approved` 和已调度的记录；智能体随后用 `dv_proj_wait` 等待。`ref2va` 镜头没有参考图的批准在任何记录之前被拒绝，消息列出这些镜头和渲染操作给出的原因。

#### Token 影响

新建或更新的结果在参数里重复分镜计划，并在报告中为每个镜头加一行：约 100 个 token，每个镜头再加约 80 个。批准的结果不到 100 个 token，每条调度的记录再加一个 ID。

#### KV Cache 影响

每个结果在调用之后追加到对话中；已缓存的前缀保持不变。分镜计划只通过调用自己的参数和结果到达模型。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **分镜计划只有文本**：分镜计划是一个 JSON 文件；除记录和画布节点外没有分镜计划编辑器或预览。
- **批准依赖其他组件的操作**：`plan.approve` 按每个镜头的生成方式拼出操作名 `shot.render_<mode>`，并依赖这些渲染操作以及 `timeline.create`、`timeline.update` 的参数、输入角色和输出顺序；那里的改动需要这里同步修改。镜头可写的生成方式（`ref2va`、`t2va`）是 `src/types.ts` 中的类型 `Shot['mode']` 和 `src/index.ts` 中的 `RENDER_MODES`；新的生成方式要在两处加上它的值，若它接受参考或能接上一个镜头，还要加进对应的集合。
