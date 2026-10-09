---
description: "Shot plan component of DreamVerse: the dvShotPlan service, plans with a PlanId and numbered versions, the operations plan.create, plan.update and plan.approve with their agent tools, and the plan state slice."
kind: "package-reference"
---

# @dv/shot-plan

English | [中文](README.zh.md)

## Summary

Use this package to plan a video before anything is rendered. A plan has a `PlanId` (`p1`, `p2`, …) and numbered versions, and each shot of a plan names its render mode. `plan.create` stores version 1 of a new plan, `plan.update` stores the next version, and `plan.approve` records the user's go-ahead for one version, schedules a render of each new or changed shot with the Shot render operation of its render mode, and lays out every shot's take on a timeline. The agent calls them as `dv_plan_create`, `dv_plan_update` and `dv_plan_approve`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project`. The approval needs the Shot render operation of every render mode its shots name (`shot.render_ref2va`, `shot.render_t2va`), the operations `timeline.create` and `timeline.update` (Timeline), and reads the `timeline` slice, and the asset pool stores the plan files. A plan version holds the shots, each with its render mode (`mode`), prompt, duration and inputs, and the references the `ref2va` shots share. The approval schedules one render per new or changed shot and one `timeline.update` or `timeline.create` that lays out every shot's take. The reducer keeps the `plan` slice: every version of every plan and the record that approved it.

```yaml
- id: dv-shot-plan
  name: '@dv/shot-plan'
```

The plugin has no configuration fields.

| Operation | Tool | Params | Outputs and report | Confirm |
| --- | --- | --- | --- | --- |
| `plan.create` | `dv_plan_create` | `shots` (each `mode` (`ref2va` or `t2va`), `prompt`, `duration_sec?`, `references?` (`ref2va` only), `continue_previous?` (`ref2va` only, never on shot 1), `seed?`), `title?`, `references?` (shared by the `ref2va` shots), `aspect_ratio?`, `resolution?`, `seed?` | `plan` (`plan.json`); report `{plan, version: 1, shots, gpu_seconds}` with the assigned PlanId | `never` |
| `plan.update` | `dv_plan_update` | `plan` (PlanId) and the params of `plan.create`: the complete next version | `plan` (`plan.json`); report `{plan, version, shots, gpu_seconds}` | `never` |
| `plan.approve` | `dv_plan_approve` | `plan` (PlanId), `version?` (default the latest) | none; report `{plan, version, scheduled}` (the scheduled shot renders in shot order, then the timeline record) | `always`, with `confirmSummary` |

A `PlanId` is `p<n>`: `plan.create` assigns one more than the highest number any Shot plan record of the project stored in `report.plan`, anywhere in the history, undone records included, so IDs are never reused. A version is numbered from 1, and a shot by its 1-based position in the version, so a shot added after six shots is shot 7. A reference is a character, location or style version (`c1@1`) or an asset ID. The slice `components.plan` is `{plans: Record<PlanId, PlanVersion[]>}`, oldest version first; a `PlanVersion` is the `Plan` fields with `version`, `created_by` (the `plan.create` or `plan.update` record) and `approved_by` (the latest finished `plan.approve` record of the version, or null). The service method `getPlan(state, plan, version?)` returns one `PlanVersion` of a project state, and `shotsToRender(state, plan, version?)` the shot positions an approval of that version would render. `approvePlan(context)` schedules the renders of a running `plan.approve` call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`plan.create` and `plan.update` validate their params with the runner, fail a plan without shots, and import the version as `plan.json` through `context.importAsset`; before their record is written, for every caller, they refuse a plan of an unknown PlanId (`plan.update`), a shot whose render mode has no registered Shot render operation (`shot.render_<mode>`, found through `dvProject.listOperations()`), a `t2va` shot with references, and `continue_previous` on shot 1 or on a `t2va` shot, with one error that names every shot and its problem; they also refuse a reference that names an unknown character, location or style version. Their report adds `shots`, one line per shot of the version, and `gpu_seconds`, the GPU estimate of approving the version in the state they wrote: the same lines and sum as the `confirmSummary` of `plan.approve` (below). So a plan names only render modes the deployment serves: without a mounted `t2va` render mode, a `t2va` shot is refused with the render modes that are available. `plan.approve` reads the version from the state and builds, for every shot, the render operation of its mode, the params `prompt`, `plan`, `plan_version`, `shot` (the position), `duration_sec`, `aspect_ratio`, `resolution` and `seed`, and for a `ref2va` shot the `reference` inputs of the shot's own references, else the plan's references; a `t2va` shot has no inputs. A shot keeps its take when a done record of the same render operation for the same plan in the approving state has the same params apart from `plan`, `plan_version` and `shot`, the same reference inputs, and the same `first_frame` input (none for a shot without `continue_previous`, the kept take of the previous shot for a shot with it); the newest such take is kept. So a continuing shot after a rendered shot renders too, a shot whose render mode changed renders, and a changed plan-wide setting renders every shot. For every other shot it runs, as the `system` actor in the approving record's surface, session and turn, one call of the shot's render operation that waits for the render scheduled before it; a rendered shot with `continue_previous` also takes the previous shot's last still (`{record, output: 1}`) as its `first_frame` input. A last Timeline call with the params `timeline` and `plan` takes every shot's take, kept or rendered, as its `clip` inputs in shot order (`{record, output: 0}`) and runs at once, so the timeline lists every shot right after the approval, a shot whose render is not done as a placeholder clip: `timeline.update` of the plan's timeline (the timeline whose latest finished `timeline.create` or `timeline.update` record names the PlanId in `params.plan`), else `timeline.create` of a new timeline with the next free ID (`t<n>` after the highest number in use, `t1` in a project without timelines). Approving a later version of a plan therefore replaces the clips of its timeline, and approving another plan adds a timeline. The references are parsed with `dvProject.parseInputs` against the shot's render operation, so an unknown version refuses the approval before any render is scheduled. Before any `plan.approve` record is written, for every caller, its `precondition` refuses an unknown plan or version and the shot problems that `plan.create` refuses (a render mode can be unmounted after the plan was written), builds the params and inputs of each shot that would render the same way, and calls the `precondition` of the shot's render operation when it has one (`shot.render_ref2va`: the reference-image rule); when shots are refused, the approval is refused with one error that names all of them, such as "Shot 2, 3 of the plan are refused by its render operation.", followed by the first render's reason. The agent tool runs the same precondition in `prepareToolCall`, so the agent is refused before Project asks it to get the user's agreement. `plan.approve` has `confirm: always`: Project refuses an agent call without `user_approved: true` and puts the text of `confirmSummary` in the refusal: one line per shot (its render mode, duration, whether it continues the previous shot, and the first 80 characters of its prompt, or that it keeps its take) and the sum of the render operations' `estimate` for the shots it renders as the GPU seconds. The component names the other operations only as strings and runs them through `dvProject.run`.

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

### Tool definitions

#### What the model sees

Three tools, `dv_plan_create`, `dv_plan_update` and `dv_plan_approve`, in the format `@dv/project` gives every operation tool. The descriptions tell the agent to create a plan only for a separate story, to give each shot a render mode whose tool it has and a prompt written for that mode, to extend, shorten or change a story with `dv_plan_update` on its plan (passing the complete plan, every shot in order), and to call `dv_plan_approve` only after it showed the plan and the user agreed in the conversation; `dv_plan_create` and `dv_plan_update` also carry the deterministic note. Project adds `user_approved` to `dv_plan_approve` because its `confirm` is `always`.

#### Token effect

About 1,500 tokens for the three definitions, fixed while the plugin is mounted; the shared arguments of `@dv/project` add up to about 200 tokens to each definition.

#### KV Cache effect

The definitions sit in the stable tool section of every agent request; mounting or removing the plugin changes the tool list and invalidates the cached prefix from the tool section on.

### Tool results

#### What the model sees

A `dv_plan_create` call returns one text block such as `done <record>: plan with 2 shots` with the `plan.json` output, the params, and the report `{"plan":"p1","version":1,"shots":[…],"gpu_seconds":20}`, so the agent can show the GPU estimate before it asks; a `dv_plan_update` call returns `plan updated (2 shots)` and the report with the new version, whose shot lines name the shots that keep their takes. A plan with a shot that the deployment cannot render is refused before any record with one sentence per problem, such as the render modes that are available. A `dv_plan_approve` call without `user_approved: true` is refused with the shot lines and GPU estimate of `confirmSummary` and the instruction to ask the user in the conversation, the question in bold. A `dv_plan_approve` call with it returns `done <record>: plan p1 v2 approved` and the scheduled records; the agent then waits with `dv_proj_wait`. An approval whose `ref2va` shots have no reference images is refused before any record with a message that names the shots and the render operation's reason.

#### Token effect

A create or update result repeats the plan in its params and adds one shot line to the report: roughly 100 tokens plus about 80 per shot. An approval result is under 100 tokens plus one ID per scheduled record.

#### KV Cache effect

Each result is appended to the conversation after its call; the cached prefix stays intact. A plan reaches the model only through the call's own params and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text-only plans**: the plan is a JSON file; there is no plan editor or preview beyond the record and the canvas node.
- **The approval names other components' operations**: `plan.approve` builds the operation name `shot.render_<mode>` from each shot's render mode and depends on the params, input roles and output order of the render operations, `timeline.create` and `timeline.update`; a change there needs a change here. The render modes a shot can name (`ref2va`, `t2va`) are the type `Shot['mode']` in `src/types.ts` and `RENDER_MODES` in `src/index.ts`; a new render mode adds its value to both, and to the sets of modes that take references or continue the previous shot when it does.
