---
description: "Shot plan component of DreamVerse: the dvShotPlan service, plans with a PlanId and numbered versions, the operations plan.create, plan.update and plan.approve with their agent tools, and the plan state slice."
kind: "package-reference"
---

# @dv/shot-plan

English | [中文](README.zh.md)

## Summary

Use this package to plan a video before anything is rendered. A plan has a `PlanId` (`p1`, `p2`, …) and numbered versions. It registers three operations with `dvProject`: `plan.create` stores version 1 of a new plan (the shots with prompts and durations, the references, and the continuity) as a JSON asset, `plan.update` stores the next version of an existing plan, and `plan.approve` records the user's go-ahead for one version, schedules one `shot.render` per new or changed shot, and one `timeline.update` or `timeline.create` that lays out every shot's take. `dvProject` turns them into the agent tools `dv_plan_create`, `dv_plan_update` and `dv_plan_approve`. The reducer keeps the `plan` slice: every version of every plan and the record that approved it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project`. The approval needs the operations `shot.render` (Shot render), `timeline.create` and `timeline.update` (Timeline), and reads the `timeline` slice, and the asset pool stores the plan files.

```yaml
- id: dv-shot-plan
  name: '@dv/shot-plan'
```

The plugin has no configuration fields.

| Operation | Tool | Params | Outputs and report | Confirm |
| --- | --- | --- | --- | --- |
| `plan.create` | `dv_plan_create` | `shots` (each `prompt`, `duration_sec?`, `references?`, `seed?`), `title?`, `continuity?` (`independent` or `chained`), `references?`, `aspect_ratio?`, `resolution?`, `generation_mode?`, `seed?` | `plan` (`plan.json`); report `{plan, version: 1}` with the assigned PlanId | `never` |
| `plan.update` | `dv_plan_update` | `plan` (PlanId) and the params of `plan.create`: the complete next version | `plan` (`plan.json`); report `{plan, version}` | `never` |
| `plan.approve` | `dv_plan_approve` | `plan` (PlanId), `version?` (default the latest) | none; report `{plan, version, scheduled}` (the scheduled shot renders in shot order, then the timeline record) | `agent_ask_first` |

A `PlanId` is `p<n>`: `plan.create` assigns one more than the highest number any Shot plan record of the project stored in `report.plan`, on any branch, so IDs are never reused. A version is numbered from 1, and a shot by its 1-based position in the version, so a shot added after six shots is shot 7. A reference is a character, location or style version (`c1@1`) or an asset ID. The slice `components.plan` is `{plans: Record<PlanId, PlanVersion[]>}`, oldest version first; a `PlanVersion` is the `Plan` fields with `version`, `created_by` (the `plan.create` or `plan.update` record) and `approved_by` (the latest finished `plan.approve` record of the version, or null). The service method `getPlan(state, plan, version?)` returns one `PlanVersion` of a branch state, and `shotsToRender(state, plan, version?)` the shot positions an approval of that version would render; the approval question of the agent integration and the approval card of the composer read both. `approvePlan(context)` schedules the renders of a running `plan.approve` call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`plan.create` and `plan.update` validate their params with the runner, fail a plan without shots, and import the version as `plan.json` through `context.importAsset`; `plan.update` of an unknown plan is refused before its record. `plan.approve` reads the version from the state and builds, for every shot, the `shot.render` params `prompt`, `plan`, `plan_version`, `shot` (the position), `duration_sec`, `aspect_ratio`, `resolution`, `generation_mode` and `seed`, and the `reference` inputs of the shot's own references, else the plan's references. A shot keeps its take when a done `shot.render` record of the same plan on the approving branch has the same params apart from `plan`, `plan_version` and `shot`, the same reference inputs, and the same `first_frame` input (none for an independent or first shot, the kept take of the previous shot for a chained shot); the newest such take is kept. So a chained shot after a rendered shot renders too, and a changed plan-wide setting renders every shot. For every other shot it runs, as the `system` actor in the approving record's surface, session and turn, one `shot.render` that waits for the render scheduled before it; with `chained` continuity a rendered shot after the first also takes the previous shot's last still (`{record, output: 1}`) as its `first_frame` input. A last Timeline call with the params `timeline` and `plan` takes every shot's take, kept or rendered, as its `clip` inputs in shot order and waits for the renders: `timeline.update` of the plan's timeline (the timeline whose latest finished `timeline.create` or `timeline.update` record names the PlanId in `params.plan`), else `timeline.create` of a new timeline with the next free ID (`t<n>` after the highest number in use, `t1` in a project without timelines). Approving a later version of a plan therefore replaces the clips of its timeline, and approving another plan adds a timeline. The references are parsed with `dvProject.parseInputs('shot.render', …)`, so an unknown version fails the approval before any render is scheduled. Before any `plan.approve` record is written, for every caller, its `precondition` refuses an unknown plan or version, builds the `shot.render` params and reference inputs of each shot that would render the same way, and calls the `precondition` of the registered `shot.render` (found through `dvProject.listOperations()`); when shots are refused, the approval is refused with one error that names all of them, such as "Shot 2, 3 of the plan have no reference image.", followed by the render's reason. The agent tool runs the same precondition in `prepareToolCall`, so the agent is refused before the question rule asks the user. Without a registered `shot.render`, only the plan and version are checked. The component names the other operations only as strings and runs them through `dvProject.run`.

The reducer ignores records that are not `done`: a finished `plan.create` adds version 1 of the plan its `report.plan` names, a finished `plan.update` adds the next version of the plan its `plan` param names, and a finished `plan.approve` sets `approved_by` of the version its `version` param names, else of the version its `report.version` names. Records that name an unknown plan or version apply nothing. The agent summary lists each plan once as `{plan, title, version, approved_version, shots}`: the latest version, the latest approved version or null, and the shot count of the latest version.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvShotPlan`: the three operations, PlanId assignment, `getPlan`, `shotsToRender` and `approvePlan` |
| [`src/reducer.ts`](src/reducer.ts) | The `plan` reducer |
| [`src/types.ts`](src/types.ts) | `PlanId`, `Plan`, `Shot`, `PlanVersion`, `PlanState` |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, scheduled runs, reducers and agent tools.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): the layout every component follows.

-----

<a id="model-experience"></a>
## Model Experience

Three tools, `dv_plan_create`, `dv_plan_update` and `dv_plan_approve`, in the format `@dv/project` gives every operation tool. A `dv_plan_create` call returns one text block such as `done <record>: plan with 2 shots` with the params, the `plan.json` output and the report `{"plan":"p1","version":1}`; a `dv_plan_update` call returns `plan updated (2 shots)` and the report with the new version. A `dv_plan_approve` call returns `done <record>: plan p1 v2 approved` and the scheduled records; the agent then waits with `dv_proj_wait`. The tool descriptions tell the agent to extend, shorten or change a story with `dv_plan_update` on its plan and to create a plan only for a separate story. The agent integration's question rule adds `user_approved` to `dv_plan_approve`. An approval whose shots have no reference images is refused before any record or question with a message that names the shots and tells the agent to ask the user for a reference image and update the plan.

#### KV Cache effect

The three tool schemas are part of every agent request while the plugin is mounted. A plan reaches the model only through the call's own params and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text-only plans**: the plan is a JSON file; there is no plan editor or preview beyond the record and the canvas node.
- **The approval names other components' operations**: `plan.approve` depends on the params, input roles and output order of `shot.render`, `timeline.create` and `timeline.update`; a change there needs a change here.
