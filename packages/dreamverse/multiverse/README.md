---
description: "The DreamVerse Multiverse prototype: branching video stories stored as projects, scene generation, language-model branch proposals, the /multiverse/api routes, and the multiverse model-call log."
kind: "package-reference"
---

# @dreamverse/multiverse

English | [中文](README.zh.md)

## Summary

Use this package to grow a story as a tree of video scenes. The user writes an opening scene and picks character images; the harness generates it and asks a language model for two different continuations. Choosing a continuation generates only that scene, which starts from its parent's last frame and gets two new continuations; unchosen ones stay available. Each multiverse is a stored project, so it survives a harness restart, and every model call is logged. Branch proposals need a key for the selected model provider. Superseded by the [video harness](../../../docs/subsystems/video-harness.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the three plugin entries with the shared project layer, the generation client, the prompt enhancer, and a harness `llm` service with an `agentDefaultModel` selection. The [`@dreamverse/multiverse-bundle`](../../bundle/dreamverse-multiverse/README.md) patch mounts all of them.

### Minimal configuration

```yaml
- id: multiverse-tree
  name: '@dreamverse/multiverse/tree'
- id: multiverse-director
  name: '@dreamverse/multiverse/director'
  config:
    logRoot: /home/user/.local/state/fastvideo/dreamverse/outputs/multiverse_logs
    proposalMaxTokens: 800
- id: multiverse-controller
  name: '@dreamverse/multiverse/controller'
  config:
    keepaliveMs: 15000
```

| Plugin entry | Service key | Responsibility |
| --- | --- | --- |
| `@dreamverse/multiverse/tree` | `dreamverseMultiverseTree` | Loads every multiverse project at start, holds the trees in memory, saves a tree to its project with the project lease, and notifies change listeners |
| `@dreamverse/multiverse/director` | `dreamverseMultiverseDirector` | Creates multiverses, generates chosen nodes one at a time per multiverse, proposes branches, and writes the multiverse log |
| `@dreamverse/multiverse/controller` | none | Serves `/multiverse/api` on the DSH web server |

| Field | Default | Meaning |
| --- | --- | --- |
| `logRoot` (director) | required | Directory of the multiverse log; the bundle uses `FASTVIDEO_MULTIVERSE_LOG_ROOT`, else `<state root>/outputs/multiverse_logs` |
| `proposalMaxTokens` (director) | required | Output cap, in tokens, of one branch-proposal call; the bundle sets 800 |
| `keepaliveMs` (controller) | required | Interval, in milliseconds, of the comment lines that keep idle event streams open through proxies; the bundle sets 15000 |

### Routes

| Route | Behavior |
| --- | --- |
| `GET /multiverse/api/capabilities` | The `GET /creation-capabilities` payload with `segment_counts` `[1]`, so the page reuses the DreamVerse creation studio |
| `GET /multiverse/api/multiverses` | Every multiverse, oldest first |
| `POST /multiverse/api/multiverses` | Body `{prompt, reference_asset_ids, segment_duration_sec, enhancement_enabled?}` plus the DreamVerse creation fields; `reference_asset_ids` names library images; 201 with the multiverse, whose root is generating |
| `GET /multiverse/api/multiverses/<id>` | One multiverse: `multiverse_id`, `created_at`, `root_id`, `segment_duration_sec`, and `nodes` in creation order; each node carries `has_clip` and `has_last_frame` |
| `GET /multiverse/api/multiverses/<id>/events` | Server-sent `multiverse` events with the multiverse at once and after every change |
| `POST .../nodes/<node_id>/choose` | 202; generates a proposed or failed node; 400 while another node of the multiverse generates |
| `POST .../nodes/<node_id>/propose` | 202; proposes branches again under a generated node that has none |
| `GET .../nodes/<node_id>/clip`, `GET .../nodes/<node_id>/last-frame` | The node's fMP4 video and last-frame PNG with the stored MIME type and `Range` support; 404 until generated |

Unknown IDs answer 404 and rejected requests answer 400; both carry `detail`. A creation request that names a missing file or a project's file answers 400.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each multiverse is a project of kind `multiverse` in `dreamverseProjectStore`, and the multiverse ID is the project ID, a `ProjectId`. The title is the opening prompt cut to 60 characters, and the thumbnail is the root's last frame. The workload data (schema version 1) holds the creation settings, the prompt-enhancement choice, the project's reference copies, the root ID, and every node in creation order: node ID, parent, depth, label, direction, status, prompt, error, and the asset IDs of the node's video and last frame. The director copies each selected library image into the project when it creates the multiverse, so deleting the library image does not affect the multiverse; `DELETE /projects/<id>` deletes the multiverse and its files. Node IDs are `NodeId`, the branded string type that `@dreamverse/multiverse/tree` exports; the controller brands the multiverse and node IDs of each request path.

Generating a node follows the shared rules of `@dreamverse/segment-generation`: `continuesPreviousSegment` and `segmentImageLabels` decide whether a branch starts from its parent's last frame and which labels its prompt uses, and `dreamverseSegmentGeneration.generate` stores the video and last frame as project files named after the node ID. A failed generation marks the node `failed`, and choosing it again retries it. A failed proposal is stored as the generated node's `error`, and `POST .../propose` asks again; `parseProposals` requires two nonempty, distinctly labeled branches.

The director is the only writer of multiverse projects. It holds a project's lease only while it works on that multiverse and releases it when no work remains; a party that takes the lease aborts that work, and the director then writes nothing more. At the next start, the tree marks a node left `generating` as `failed` and a generated node without branches or error with the error `Interrupted by a restart.`, so the user can retry both. A stored multiverse whose workload data does not parse is skipped with a warning.

| File | Content |
| --- | --- |
| [`src/tree.ts`](src/tree.ts) | `dreamverseMultiverseTree`: nodes, workload data, saves, and restart repair |
| [`src/director.ts`](src/director.ts) | `dreamverseMultiverseDirector`: creation, generation, proposals, leases, and log events |
| [`src/branch-proposals.ts`](src/branch-proposals.ts) | The proposal request and reply validation |
| [`src/event-log.ts`](src/event-log.ts) | The multiverse log file |
| [`src/controller.ts`](src/controller.ts) | The `/multiverse/api` routes |

The `tests/` directory covers the director, the branch proposals, and the routes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the Multiverse workload in the shared project layer.
- [`@dreamverse/ui-multiverse`](../../dreamverse-ui/multiverse/README.md) — the Multiverse page.
- [`@dreamverse/segment-generation`](../segment-generation/README.md) — the shared generation rules.
- [`@dreamverse/prompt-enhancer`](../prompt-enhancer/README.md) — the scene prompt requests.

-----

<a id="model-experience"></a>
## Model Experience

### Branch proposal system prompt

#### What the model sees

Each proposal call sends one request through `ctx.llm.stream()` with the provider and model of `ctx.agentDefaultModel.currentSelection()`, `maxTokens` set to `proposalMaxTokens`, the system prompt below, and one user message that describes the story on the path from the root to the generated node. The model answers JSON with two branches.

##### Proposal system prompt

```markdown
You plan a branching short-film story. Each scene is one continuous shot of a few seconds.
Given the premise and the scenes so far, propose exactly two different ways the story continues in the next scene.
The two options must lead the story in clearly different directions, keep the same characters and setting, and
follow on directly from the end of the last scene.
Respond with JSON only, no other text, in this form:
{"branches": [{"label": "...", "direction": "..."}, {"label": "...", "direction": "..."}]}
label: two to six words naming the choice. direction: one or two sentences describing what happens in the scene.
```

##### Proposal user message

```markdown
Premise: <root direction>

Scenes so far:
1. <label>: <direction>
2. <label>: <direction>
```

#### Token effect

The fixed system prompt plus one line per scene on the path, so the input grows with the node's depth; the reply is capped at `proposalMaxTokens` tokens. The user message ends with `(only the opening scene so far)` for the root.

#### KV Cache effect

Independent request per proposal. The system prompt is a byte-stable prefix for every proposal call with the same model; the user message differs per node.

### Scene prompt enhancement

#### What the model sees

When the multiverse's `enhancement_enabled` is true (the default), the director sends the root's direction to `expandClip`, and a branch's direction to `continueVideo` with the prompts on the path from the root as the locked segments, the next segment index, the reference labels, and the first-frame label when the branch starts from its parent's last frame. The deadline is the prompt enhancer's `timeoutMs`. The video model then receives the enhanced prompt, or the node's direction when enhancement is off.

#### Token effect

One enhancement request per generated node; a continuation's input grows with the node's depth because it repeats every prompt on the path.

#### KV Cache effect

Independent requests; the locked segments are sent again in full for each branch.

### Multiverse log

#### What the model sees

Nothing. The director appends every model call to `<logRoot>/<hostname>/<yymmdd_HHMMSS_ffffff>.jsonl`, one JSON line per event with `ts`, `event`, `hostname`, `multiverse_id`, and `node_id`: `branch_proposal_request` (the complete request: provider, model, reasoning effort, `system`, `messages`, and `max_tokens`), `branch_proposal_response` (the raw `output`, `reasoning`, `finish_reason`, and the `branches` or the `error`), `prompt_enhance_request` (the operation, `expand_clip` or `continue_video`, with every input that the prompt enhancer receives), and `prompt_enhance_response` (the prompt, provider, model, latency, fallback flag, and error). A failed log write only warns.

#### Token effect

Zero; log entries never enter a model request.

#### KV Cache effect

None; logging changes no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No progressive playback** — `GET .../clip` serves a node's video only after the node completes.
- **Leases inside one process** — a `dreamverse` profile that runs at the same time over the same state root can delete a multiverse project while the director works on it.
- **Aborted node after a takeover** — after another party takes a multiverse's lease, a node whose generation the director aborted stays `generating` in memory until the next start.
- **Event stream behind a quick tunnel** — a Cloudflare quick tunnel holds back the body of the `events` route until the response ends, so the page reads `GET /multiverse/api/multiverses/<id>` instead.
- **Enhancer request not rendered in the log** — `prompt_enhance_request` records the enhancer's inputs; the template and user message that the prompt enhancer renders from them are not logged.
- **Superseded by the video harness** — the [video harness](../../../docs/subsystems/video-harness.md) replaces this package with plan continuity plus branches in `@video-harness/runtime`; the package remains only for the `dreamverse` and `dreamverse-multiverse` profiles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
