---
description: "DreamVerse 的分镜组件：dvShotPlan 服务，它的操作 plan.create、plan.update 和 plan.approve 及其智能体工具，以及 plan 状态切片。"
kind: "package-reference"
---

# @dv/shot-plan

[English](README.md) | 中文

## 概述

用这个包在生成任何内容之前规划一段视频。它向 `dvProject` 注册三个操作：`plan.create` 把分镜计划（带提示词和时长的镜头、参考和连续性）存为 JSON 素材，`plan.update` 存储一份较早分镜计划的修改副本，`plan.approve` 记录用户的同意，并为每个镜头调度一条 `shot.render`，再为生成的片段调度一条 `timeline.create`。`dvProject` 把它们变成智能体工具 `dv_plan_create`、`dv_plan_update` 和 `dv_plan_approve`。归约函数维护 `plan` 切片：每个已完成的分镜计划和批准它的记录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 之后挂载本插件。批准需要操作 `shot.render`（镜头生成）和 `timeline.create`（时间线），素材库存储分镜计划文件。

```yaml
- id: dv-shot-plan
  name: '@dv/shot-plan'
```

本插件没有配置字段。

| 操作 | 工具 | 参数 | 输出 | 确认 |
| --- | --- | --- | --- | --- |
| `plan.create` | `dv_plan_create` | `shots`（每个含 `prompt`、`duration_sec?`、`references?`、`seed?`）、`title?`、`continuity?`（`independent` 或 `chained`）、`references?`、`aspect_ratio?`、`resolution?`、`generation_mode?`、`seed?` | `plan`（`plan.json`） | `never` |
| `plan.update` | `dv_plan_update` | `plan.create` 的参数；较早分镜计划的记录放在 `based_on` | `plan`（`plan.json`） | `never` |
| `plan.approve` | `dv_plan_approve` | `plan`（一条 `plan.create` 或 `plan.update` 记录的 ID） | 无 | `agent_ask_first` |

分镜计划由存储它的 `plan.create` 或 `plan.update` 记录的 ID 标识，镜头由它在分镜计划中的位置标识。参考是角色、场景或风格的版本（`c1@1`）或素材 ID。切片 `components.plan` 是 `{plans: [{record, approved, approved_by}]}`，最早的在前。服务方法 `getPlan(project, plan)` 返回一条已完成的分镜计划记录存储的 `Plan`；智能体集成的批准提问和输入框的批准卡片读取它。`approvePlan(context)` 为一次正在运行的 `plan.approve` 调用调度生成。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`plan.create` 和 `plan.update` 由 runner 校验参数，没有镜头的分镜计划会失败，并通过 `context.importAsset` 把分镜计划导入为 `plan.json`。`getPlan` 从记录的参数读取分镜计划，这些参数与文件的字段相同。`plan.approve` 读取分镜计划，并以 `system` actor、在批准记录的界面、会话和轮次中，为每个镜头运行一条 `shot.render`，参数为 `prompt`、`plan`、`shot`（位置）、`duration_sec`、`aspect_ratio`、`resolution`、`generation_mode` 和 `seed`，`reference` 输入取镜头自己的参考，否则取分镜计划的参考。`chained` 连续性下，第一个之后的每个镜头还把前一个镜头的最后静帧（`{record, output: 1}`）作为 `first_frame` 输入并等待它。最后一条带参数 `plan` 的 `timeline.create` 把各镜头的视频作为 `clip` 输入，并等待所有镜头。参考用 `dvProject.parseInputs('shot.render', …)` 解析，所以未知版本会在调度任何生成之前让批准失败。对任何调用方，在写下 `plan.approve` 记录之前，它的 `precondition` 用同样的方式构造每个镜头的 `shot.render` 参数和参考输入，并调用已注册的 `shot.render`（经 `dvProject.listOperations()` 找到）的 `precondition`；有镜头被拒绝时，批准以一个错误被拒绝，错误列出全部这些镜头，例如 "Shot 2, 3 of the plan have no reference image."，后接镜头生成给出的原因。未知的分镜计划记录或未知版本也在这里被拒绝。智能体工具在 `prepareToolCall` 中运行同一个前置条件，所以智能体在提问规则询问用户之前就被拒绝。没有注册 `shot.render` 时不做检查。本组件只以字符串命名其他操作，并通过 `dvProject.run` 运行它们。

归约函数忽略状态不是 `done` 的记录：每条已完成的 `plan.create` 或 `plan.update` 添加一条摘要，一条已完成的 `plan.approve` 标记其 `plan` 参数指向的分镜计划。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvShotPlan`：三个操作、`getPlan` 和 `approvePlan` |
| [`src/reducer.ts`](src/reducer.ts) | `plan` 归约函数 |
| [`src/types.ts`](src/types.ts) | `Plan`、`Shot`、`PlanSummary`、`PlanState` |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、调度运行、归约函数和智能体工具。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：每个组件遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

三个工具 `dv_plan_create`、`dv_plan_update` 和 `dv_plan_approve`，格式与 `@dv/project` 给每个操作工具的格式相同。一次 `dv_plan_create` 调用返回一个文本块，例如 `done <record>: plan with 2 shots`，附带参数和 `plan.json` 输出；一次 `dv_plan_update` 调用返回 `plan updated (2 shots)`。一次 `dv_plan_approve` 调用返回 `done <record>: plan <id> approved` 和已调度的记录；智能体随后用 `dv_proj_wait` 等待。智能体集成的提问规则给 `dv_plan_approve` 加上 `user_approved`。镜头没有参考图的批准在任何记录和提问之前被拒绝，消息列出这些镜头，并告诉智能体向用户要一张参考图、更新分镜计划。

#### KV Cache 影响

插件挂载期间，三个工具 schema 是每个智能体请求的一部分。分镜计划只通过调用自己的参数和结果到达模型。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **分镜计划只有文本**：分镜计划是一个 JSON 文件；除记录和画布节点外没有分镜计划编辑器或预览。
- **批准依赖其他组件的操作**：`plan.approve` 依赖 `shot.render` 和 `timeline.create` 的参数、输入角色和输出顺序；那里的改动需要这里同步修改。
