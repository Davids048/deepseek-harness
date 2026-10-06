---
description: "Shot plan component of DreamVerse: the dvShotPlan service, its operations plan.create, plan.update and plan.approve with their agent tools, and the plan state slice."
kind: "package-reference"
---

# @dv/shot-plan

English | [中文](README.zh.md)

## Summary

Use this package to plan a video before anything is rendered. It registers three operations with `dvProject`: `plan.create` stores a plan (the shots with prompts and durations, the references, and the continuity) as a JSON asset, `plan.update` stores a changed copy of an earlier plan, and `plan.approve` records the user's go-ahead and schedules one `shot.render` per shot and one `timeline.create` of the rendered clips. `dvProject` turns them into the agent tools `dv_plan_create`, `dv_plan_update` and `dv_plan_approve`. The reducer keeps the `plan` slice: every finished plan and the record that approved it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project`. The approval needs the operations `shot.render` (Shot render) and `timeline.create` (Timeline), and the asset pool stores the plan files.

```yaml
- id: dv-shot-plan
  name: '@dv/shot-plan'
```

The plugin has no configuration fields.

| Operation | Tool | Params | Outputs | Confirm |
| --- | --- | --- | --- | --- |
| `plan.create` | `dv_plan_create` | `shots` (each `prompt`, `duration_sec?`, `references?`, `seed?`), `title?`, `continuity?` (`independent` or `chained`), `references?`, `aspect_ratio?`, `resolution?`, `generation_mode?`, `seed?` | `plan` (`plan.json`) | `never` |
| `plan.update` | `dv_plan_update` | the params of `plan.create`; the earlier plan's record goes in `based_on` | `plan` (`plan.json`) | `never` |
| `plan.approve` | `dv_plan_approve` | `plan` (the record ID of a `plan.create` or `plan.update` record) | none | `agent_ask_first` |

A plan is identified by the record ID of the `plan.create` or `plan.update` record that stored it, and a shot by its position in the plan. A reference is a character, location or style version (`c1@1`) or an asset ID. The slice `components.plan` is `{plans: [{record, approved, approved_by}]}`, oldest first. The service method `getPlan(project, plan)` returns the `Plan` a finished plan record stored; the approval question of the agent integration and the approval card of the composer read it. `approvePlan(context)` schedules the renders of a running `plan.approve` call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`plan.create` and `plan.update` validate their params with the runner, fail a plan without shots, and import the plan as `plan.json` through `context.importAsset`. `getPlan` reads the plan from the record's params, which hold the same fields as the file. `plan.approve` reads the plan and runs, as the `system` actor in the approving record's surface, session and turn, one `shot.render` per shot with the params `prompt`, `plan`, `shot` (the position), `duration_sec`, `aspect_ratio`, `resolution`, `generation_mode` and `seed`, and the `reference` inputs of the shot's own references, else the plan's references. With `chained` continuity each shot after the first also takes the predecessor's last still (`{record, output: 1}`) as its `first_frame` input and waits for it. A last `timeline.create` with the param `plan` takes the shots' videos as its `clip` inputs and waits for every shot. The references are parsed with `dvProject.parseInputs('shot.render', …)`, so an unknown version fails the approval before any render is scheduled. Before any `plan.approve` record is written, for every caller, its `precondition` builds each shot's `shot.render` params and reference inputs the same way and calls the `precondition` of the registered `shot.render` (found through `dvProject.listOperations()`); when shots are refused, the approval is refused with one error that names all of them, such as "Shot 2, 3 of the plan have no reference image.", followed by the render's reason. An unknown plan record or an unknown version is refused there too. The agent tool runs the same precondition in `prepareToolCall`, so the agent is refused before the question rule asks the user. Without a registered `shot.render`, nothing is checked. The component names the other operations only as strings and runs them through `dvProject.run`.

The reducer ignores records that are not `done`: each finished `plan.create` or `plan.update` adds a summary, and a finished `plan.approve` marks the plan its `plan` param names.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvShotPlan`: the three operations, `getPlan` and `approvePlan` |
| [`src/reducer.ts`](src/reducer.ts) | The `plan` reducer |
| [`src/types.ts`](src/types.ts) | `Plan`, `Shot`, `PlanSummary`, `PlanState` |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, scheduled runs, reducers and agent tools.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): the layout every component follows.

-----

<a id="model-experience"></a>
## Model Experience

Three tools, `dv_plan_create`, `dv_plan_update` and `dv_plan_approve`, in the format `@dv/project` gives every operation tool. A `dv_plan_create` call returns one text block such as `done <record>: plan with 2 shots` with the params and the `plan.json` output; a `dv_plan_update` call returns `plan updated (2 shots)`. A `dv_plan_approve` call returns `done <record>: plan <id> approved` and the scheduled records; the agent then waits with `dv_proj_wait`. The agent integration's question rule adds `user_approved` to `dv_plan_approve`. An approval whose shots have no reference images is refused before any record or question with a message that names the shots and tells the agent to ask the user for a reference image and update the plan.

#### KV Cache effect

The three tool schemas are part of every agent request while the plugin is mounted. A plan reaches the model only through the call's own params and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text-only plans**: the plan is a JSON file; there is no plan editor or preview beyond the record and the canvas node.
- **The approval names other components' operations**: `plan.approve` depends on the params, input roles and output order of `shot.render` and `timeline.create`; a change there needs a change here.
