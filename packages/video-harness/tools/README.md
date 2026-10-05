---
description: "Structured tools of the video harness: typed inputs, JSON-schema params, cost and confirmation classes, registered with the project runtime and exposed to the DSH agent as vh_* tools whose calls become operation records."
kind: "package-reference"
---

# @video-harness/tools

English | [中文](README.zh.md)

## Summary

Use this package to give the agent and the views one set of tools over a video project. Each `ToolSpec` declares typed inputs, JSON-schema params, outputs, a cost class, a confirmation policy, and a one-line summary. `vhTools` registers every spec with the project runtime and, when the DSH `tools` registry is mounted, as a `vh_<name>` tool whose call becomes one operation record. The shipped specs cover uploads, entity versions, plans, sequence edits, media processing, arbitrary commands, `generate.video` through the DreamVerse generation backend, and `perception.describe` through the default model.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@video-harness/assets`, `@video-harness/oplog`, `@video-harness/media`, and `@video-harness/runtime`. `generate.video` appears when `dreamverseGeneration` is mounted, `perception.describe` when `llm`, `agentDefaultModel`, and `attachments` are, and the `vh_*` DSH tools when `tools` is.

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
| `imageInput` | `true` | Whether the agent model accepts images; `false` makes `perception.describe` end its record with `report.unsupported` instead of calling the model |
| `sessionStateRoot` | required | Directory of one JSON file per session with its project binding and open turn; a restarted harness continues the session from it |

| Tool | Cost | Deterministic | Confirm | Effect |
| --- | --- | --- | --- | --- |
| `asset.upload` | free | yes | never | A file path or base64 bytes become an asset |
| `entity.character.create` / `.update`, `entity.style.*`, `entity.location.*` | free | yes | never | Entity versions; an update supersedes the previous version |
| `plan.create` / `plan.update` | free | yes | always | A plan document (shots, references, continuity) stored as JSON |
| `plan.approve` | free | yes | never | The user's approval; the runtime schedules one `generate.video` per shot and a `sequence.create` |
| `sequence.create` / `replace` / `move` / `set_range` / `insert` / `remove` | free | yes | never | Timeline edits the fold interprets |
| `clip.trim`, `media.concat`, `media.extract_frame`, `media.probe` | cpu | yes | never | ffmpeg and ffprobe through `vhMedia`; `media.extract_frame` takes `at` as `first`, `last` (default), or seconds as a number or numeric string |
| `command.run` | cpu | no | never | Any command with `{{in:<n>}}` and `{{out:<name>}}` placeholders and declared outputs |
| `generate.video` | gpu | no | cost | One shot: video and last frame; `reference` inputs carry entity versions or images, `first_frame` continues an earlier shot |
| `perception.describe` | free | no | never | The default model answers a question about an image asset |

`vhTools.register(spec)` adds a spec and returns its disposer; `get(name)` and `list()` read the registry. A spec's `summarize(op)` gives the one-line label a chat card or canvas node shows. Tools report facts beyond their outputs, such as the seed `generate.video` drew or the probe `media.probe` read, in the record's `report`.

### DSH tools

Every spec is a tool named `vh_<name with dots as underscores>`, such as `vh_generate_video`. Beside the spec's own params, each takes `reason` (required; the record's intent), `project_id` (defaults to the session project), `inputs` (role to asset ID, `entity@version`, or `<record>#<index>`; a list for roles that take several), `replaces` (records this call supersedes), and `base_op`; `vh_generate_video` also takes `continue_from`, a shot record whose last frame the new shot starts from. A call whose inputs name an unfinished record is scheduled and returns `pending`; otherwise it runs and returns `done`. The result names the record, its status, the summary, the outputs with `/vh/assets/<id>/content` URLs, records the runtime scheduled because of the call, the params, and the report; image outputs also arrive as image blocks when an attachment service is mounted.

Records of one agent session go to one open turn on a draft branch until the session accepts or rejects it. The management tools are `vh_project_create`, `vh_project_use`, `vh_project_state`, `vh_turn_accept`, `vh_turn_reject`, `vh_undo`, `vh_branch_create`, `vh_branch_use`, and `vh_wait`; each returns the project state: entities, timeline, plans, stale records, branches, the open turn, and recent records.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`VhTools` keeps the spec map and registers each spec with `vhProject.registerTool`; inside `ctx.inject(['tools'])` it creates the DSH bridge, which defines one `defineTool` per spec and the management tools, and removes them when the registry or the service goes away. The bridge keeps one `SessionState` per agent session (keyed by the agent's session ID, or `anonymous` for direct calls): the project, the open turn and its project, and the exploration branch. A call resolves the project, opens a turn with the call's reason when none is open, parses `inputs` against the spec's roles, and calls `vhProject.invoke`, or `vhProject.schedule` when an input names an unfinished record.

`generate.video` reads the model facts from `dreamverseGeneration.model()`, resolves frame size and frame count from the params with the model's defaults, validates the reference count with the DreamVerse rules, orders the request images with `segmentRequestImages` (references first, then the predecessor's last frame), draws a seed when none is given, streams the segment into a scratch file, and stores the video and the PNG last frame with the record as producer.

| File | Content |
| --- | --- |
| [`src/types.ts`](src/types.ts) | `ToolSpec`, `InputSpec`, `OutputSpec`, `Confirm` |
| [`src/specs-basic.ts`](src/specs-basic.ts) | Upload, entities, plans, sequence edits |
| [`src/specs-media.ts`](src/specs-media.ts) | Trim, concat, frame, probe, `command.run` |
| [`src/specs-generate.ts`](src/specs-generate.ts) | `generate.video` and `shotGeometry` |
| [`src/specs-perception.ts`](src/specs-perception.ts) | `perception.describe` |
| [`src/dsh.ts`](src/dsh.ts) | The DSH bridge: tool definitions, session state, management tools, rendering |
| [`src/index.ts`](src/index.ts) | `vhTools` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Video harness subsystem](../../../docs/subsystems/video-harness.md) — the record, drafts, staleness, and scheduling across the harness.
- [`@video-harness/runtime`](../runtime/README.md) — `invoke`, `schedule`, plan expansion, and replay.
- [`@video-harness/media`](../media/README.md) — the media service behind the media tools.
- [`@dreamverse/generation-client`](../../dreamverse/generation-client/README.md) — the backend client behind `generate.video`.

-----

<a id="model-experience"></a>
## Model Experience

### DSH tool definitions

#### What the model sees

One tool per registered spec, named `vh_<name>` with the spec's summary, cost class, determinism, and confirmation policy in the description, the spec's params plus the shared `reason`, `project_id`, `inputs`, `replaces`, and `base_op` params (and `continue_from` on `vh_generate_video`), and the nine management tools. Tool availability follows the mounted services: `vh_generate_video` needs the generation backend and `vh_perception_describe` the model, default model, and attachment services. The package lives outside `packages/*/tool-*`, so the generated tool catalog does not list these definitions; `vhTools.list()` and `ctx.tools.schemas()` are the sources.

#### Token effect

About thirty tool definitions with one- to three-sentence descriptions; the `inputs` description lists the spec's roles.

#### KV Cache effect

Prefix-stable while the mounted services and registered specs are unchanged; mounting or removing a backend changes the tool list and invalidates reuse from the first changed definition.

### Tool results

#### What the model sees

One text block: `<status> <record>: <summary>`, one line per output with role, asset ID, MIME type, and URL, the records scheduled by the call, the params as JSON, and the report as JSON; then one image block per image output when an attachment service is mounted. Management tools return the project state as indented JSON.

#### Token effect

A structured call is a few lines plus the params; `vh_project_state` grows with the project and lists at most twelve recent records.

#### KV Cache effect

Results append to the conversation; they do not change earlier content.

### Perception request

#### What the model sees

`perception.describe` sends one request through `ctx.llm.stream()` with the provider and model of `ctx.agentDefaultModel.currentSelection()`, no system prompt, `maxTokens` set to `perceptionMaxTokens`, and one user message with the image attachment followed by the question, which defaults to the text below. When `imageInput` is `false`, or the selected model's catalog entry declares no image input, no request is sent: the record ends `done` with a text output and `report.unsupported` saying why, so the agent reads the reason instead of a failed record.

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

- **The bridge sees no turn boundaries itself** — the open turn ends with `vh_turn_accept` or `vh_turn_reject`; `@video-harness/agent` reports the agent loop's turns through `noteTurn` and `settleTurn`, and without it a turn can span several user messages.
- **Confirmation is advice** — `confirm` reaches the model through the tool description; the harness approval service is not consulted before a costly call.
- **No system prompt section** — the workflow (project, references, entities, plan, approval, generation) is described only in the tool descriptions.
- **Text-only plan documents** — `plan.create` stores the shots as JSON; there is no plan editor or preview beyond the record.
