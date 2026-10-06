---
description: "Structured tools of the video harness: typed inputs, JSON-schema params, resource and confirmation classes, registered with dvProject as operations and exposed to the DSH agent as vh_* tools whose calls become project records."
kind: "package-reference"
---

# @video-harness/tools

English | [中文](README.zh.md)

## Summary

Use this package to give the agent and the views one set of tools over a video project. Each `ToolSpec` extends the `OperationSpec` of `@dv/project` with typed inputs, outputs, and a one-line summary; it declares JSON-schema params, the owning component, a resource class, and a confirmation policy. `vhTools` registers every spec with `dvProject.registerOperation` and, when the DSH `tools` registry is mounted, as a `vh_<name>` tool whose call runs the operation through `dvProject.run` and becomes one record. It also registers the stage 2 bridge reducers `timeline`, `bible`, `plan`, and `shot`, and the `dv_proj_*` registry tools. The shipped specs cover imports, character, location and style versions, plans, timeline edits, media processing, `generate.video` through the DreamVerse generation backend, and `perception.describe` through the default model.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@video-harness/assets`, `@dv/project`, and `@video-harness/media`. `generate.video` appears when `dreamverseGeneration` is mounted, `perception.describe` when `llm`, `agentDefaultModel`, and `attachments` are, and the `vh_*` and `dv_proj_*` DSH tools when `tools` is.

```yaml
- id: vh-tools
  name: '@video-harness/tools'
  config:
    perceptionMaxTokens: 1024
    sessionStateRoot: /var/lib/video-harness/sessions
```

| Field | Default | Meaning |
| --- | --- | --- |
| `perceptionMaxTokens` | `1024` | The output token cap of one `perception.describe` answer |
| `imageInput` | `true` | Whether the agent model accepts images; `false` makes `perception.describe` answer with `report.unsupported` instead of calling the model |
| `sessionStateRoot` | required | Directory of one JSON file per session with its project binding; a restarted harness continues the session from it |

| Tool | Resource | Deterministic | Confirm | Effect |
| --- | --- | --- | --- | --- |
| `asset.upload` | none | yes | never | A file path or base64 bytes become an asset (component `asset`) |
| `entity.character.create` / `.update`, `entity.style.*`, `entity.location.*` | none | yes | never | Character, location, and style versions (component `bible`); an update of an unknown ID fails its record |
| `plan.create` / `plan.update` | none | yes | never | A plan document (shots, references, continuity) stored as JSON (component `plan`) |
| `plan.approve` | none | no | agent_ask_first | The user's approval (component `plan`); its execute schedules one `generate.video` per shot and a `sequence.create` through `dvProject.run` as the `system` actor; the DSH question rule `always` needs `user_approved: true` |
| `sequence.create` / `replace` / `move` / `set_range` / `insert` / `remove` | none | yes | never | Timeline edits the `timeline` bridge reducer interprets (component `timeline`) |
| `media.concat`, `media.extract_frame`, `media.probe` | cpu | yes | never | ffmpeg and ffprobe through `vhMedia` (components `deliver`, `asset`, `inspect`); `media.extract_frame` takes `at` as `first`, `last` (default), or seconds as a number or numeric string |
| `clip.trim` | cpu | yes | never | Trims a clip to a range through `vhMedia` for the timeline export (component `deliver`); an export-only operation: `get(name)` returns it while `list()` leaves it out, so it has no DSH tool and no canvas form |
| `generate.video` | gpu | no | agent_ask_first | One shot: video and last frame (component `shot`); `reference` inputs carry entity versions or images, `first_frame` continues an earlier shot; the DSH question rule `cost` asks past the turn's GPU budget unless the call carries `user_requested: true` |
| `perception.describe` | none | no | never | A read (component `inspect`): the default model answers a question about an image asset in the report, and no record is written |

`vhTools.register(spec)` adds a spec and returns its disposer; registering a name twice throws `operation_exists`. `get(name)` and `list()` read the registry. A spec's `summarize(record)` gives the one-line label a chat card or canvas node shows. Tools report facts beyond their outputs, such as the seed `generate.video` drew or the probe `media.probe` read, in the record's `report`. `confirm: agent_ask_first` makes `dvProject` hold an agent's record behind the composer's approval card while the session's composer asks first; the DSH question rule (`always` for `plan.approve`, `cost` for `generate.video`) stays in the bridge.

### DSH tools

Every registered spec except `clip.trim` is a tool named `vh_<name with dots as underscores>`, such as `vh_generate_video`. Beside the spec's own params, each takes `reason` (required; the record's intent), `project_id` (defaults to the session project), `inputs` (role to asset ID, `entity@version`, or `<record>#<index>`; a list for roles that take several; read against the session's working branch), `replaces` (records this call supersedes), and `base_op` (the record's `based_on`); `vh_generate_video` also takes `continue_from`, a shot record whose last frame the new shot starts from. A call whose inputs name an unfinished record is scheduled and returns `pending`; otherwise it runs and returns `done`; a record that ends `failed` or `cancelled` is reported as a tool error. The result names the record (empty for a read, which writes none), its status, the summary, the outputs with `/vh/assets/<id>/content` URLs, the records the call scheduled, the params, and the report; image outputs also arrive as image blocks when an attachment service is mounted.

Records of one agent session go to the session's working branch: the first agent call opens the draft `draft/<session>`, which spans turns and also holds the user's edits until the user accepts or discards it. The registry tools are `dv_proj_create`, `dv_proj_open`, `dv_proj_state`, `dv_proj_history_list`, `dv_proj_draft_accept`, `dv_proj_draft_discard`, `dv_proj_undo`, `dv_proj_redo`, `dv_proj_stale_accept` (keeps a stale record as it is), `dv_proj_branch_create` (an `explore/<name>` branch the session then works on), `dv_proj_branch_switch`, and `dv_proj_wait`; `dv_proj_history_list` returns records newest first with their marks, and the others return the state of a branch: characters, locations and styles, timelines, plans, stale records, branches, the draft counts, and recent records.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`VhTools` keeps the spec map, registers each spec with `dvProject.registerOperation`, and registers the bridge reducers of `src/reducers.ts` with `dvProject.registerReducer`; inside `ctx.inject(['tools'])` it creates the DSH bridge, which defines one `defineTool` per spec except `clip.trim` plus the registry tools, and removes them when the registry or the service goes away. The bridge keeps one `SessionState` per agent session (keyed by the agent's session ID, or `anonymous` for direct calls) with the bound project, saved under `sessionStateRoot`, and the current turn and the human's words that `noteTurn` reports. A call resolves the project, reads the state of the session's working branch, parses `inputs` against the spec's roles, applies the question rule, and calls `dvProject.run` with the agent as actor, the session, the turn, the tool call, and the turn's `request_text`, which writes the turn's request record before the turn's first record. `recordChatImages` imports chat images as `asset.upload` records of the user on the session's working branch.

`generate.video` reads the model facts from `dreamverseGeneration.model()`, resolves frame size and frame count from the params with the model's defaults, validates the reference count with the DreamVerse rules, orders the request images with `segmentRequestImages` (references first, then the predecessor's last frame), draws a seed when none is given, streams the segment into a scratch file, and imports the video and the PNG last frame through `importAsset`, with the record as producer.

| File | Content |
| --- | --- |
| [`src/types.ts`](src/types.ts) | `ToolSpec`, `InputSpec`, `OutputSpec`, the slices of the bridge reducers |
| [`src/specs-basic.ts`](src/specs-basic.ts) | Import, characters, locations and styles, plans and plan approval, timeline edits |
| [`src/specs-media.ts`](src/specs-media.ts) | Trim, concat, frame, probe |
| [`src/specs-generate.ts`](src/specs-generate.ts) | `generate.video` and `shotGeometry` |
| [`src/specs-perception.ts`](src/specs-perception.ts) | `perception.describe` |
| [`src/dsh.ts`](src/dsh.ts) | The DSH bridge: tool definitions, session state, registry tools, rendering |
| [`src/reducers.ts`](src/reducers.ts) | The stage 2 bridge reducers `timeline`, `bible`, `plan`, and `shot` |
| [`src/index.ts`](src/index.ts) | `vhTools` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Video harness subsystem](../../../docs/subsystems/video-harness.md) — the record, drafts, staleness, and scheduling across the harness.
- [`@dv/project`](../../dv/project/README.md) — records, drafts, undo and redo, the runner and scheduler, and the reducer registry.
- [`@video-harness/media`](../media/README.md) — the media service behind the media tools.
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.md) — the backend client behind `generate.video`.

-----

<a id="model-experience"></a>
## Model Experience

### DSH tool definitions

#### What the model sees

One tool per registered spec except `clip.trim`, named `vh_<name>` with the spec's summary, resource class, determinism, and question rule in the description, the spec's params plus the shared `reason`, `project_id`, `inputs`, `replaces`, and `base_op` params (and `continue_from` on `vh_generate_video`), and the eleven registry tools. Tool availability follows the mounted services: `vh_generate_video` needs the generation backend and `vh_perception_describe` the model, default model, and attachment services. The package lives outside `packages/*/tool-*`, so the generated tool catalog does not list these definitions; `vhTools.list()` and `ctx.tools.schemas()` are the sources.

#### Token effect

About thirty tool definitions with one- to three-sentence descriptions; the `inputs` description lists the spec's roles.

#### KV Cache effect

Prefix-stable while the mounted services and registered specs are unchanged; mounting or removing a backend changes the tool list and invalidates reuse from the first changed definition.

### Tool results

#### What the model sees

One text block: `<status> <record>: <summary>` (`<status>: <summary>` for a read), one line per output with role, asset ID, MIME type, and URL, the records scheduled by the call, the params as JSON, and the report as JSON; then one image block per image output when an attachment service is mounted. Registry tools return the branch state or the history as indented JSON.

#### Token effect

A structured call is a few lines plus the params; `dv_proj_state` grows with the project and lists at most twelve recent records.

#### KV Cache effect

Results append to the conversation; they do not change earlier content.

### Perception request

#### What the model sees

`perception.describe` sends one request through `ctx.llm.stream()` with the provider and model of `ctx.agentDefaultModel.currentSelection()`, no system prompt, `maxTokens` set to `perceptionMaxTokens`, and one user message with the image attachment followed by the question, which defaults to the text below. When `imageInput` is `false`, or the selected model's catalog entry declares no image input, no request is sent: the report's `unsupported` says why, so the agent reads the reason instead of a failed call.

##### Default question

```markdown
Describe this image: the subject, the framing, the lighting, and anything that looks wrong.
```

#### Token effect

One image plus the question per call; the answer is capped by `perceptionMaxTokens`.

#### KV Cache effect

None; each call is a one-shot request outside the agent's conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Turns come from the agent layer** — `@video-harness/agent` reports each turn and the human's words through `noteTurn`; without it the records carry no turn and no request record is written.
- **The DSH question rule is advice** — `always` and `cost` reach the model through the tool description and the `user_approved` / `user_requested` arguments; only the composer's ask mode, through `dvProject`'s approval channel, holds a call until the user answers.
- **No system prompt section** — the workflow (project, references, entities, plan, approval, generation) is described only in the tool descriptions.
- **Text-only plan documents** — `plan.create` stores the shots as JSON; there is no plan editor or preview beyond the record.
