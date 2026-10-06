---
description: "The agent layer of the video harness: agent-loop turns become drafts, confirmation questions reach the user, the project state becomes a system-prompt section, and the directing skills ship with the package."
kind: "package-reference"
---

# @video-harness/agent

English | [中文](README.zh.md)

## Summary

Use this package to run the DSH agent over a video project. `vhAgent` listens to session turn events so every structured call of one agent-loop turn lands on one draft branch, settled when the turn ends; it answers the tool bridge's confirmation requests through `userQuestions` when the calling agent is a live root agent; and it contributes a system-prompt section with the project's entities, timeline slots, takes, stale records, plans, and the rules for resolving references such as "the second clip". The `skills/` directory holds the `video-directing` and `branching-story` skills a profile points `skill-filesystem` at.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount `@video-harness/agent` after `@video-harness/tools`; it injects `vhProject` and `vhTools` and uses `agents`, `systemPrompt`, and `userQuestions` when they are present. Configuration: `promptSectionOrder` (default 4900, before the tool SDK section), `approveLabel` and `declineLabel` (the two options of a confirmation question).

Point `skill-filesystem` at this package's `skills/` directory so the agent can load the two skills:

```yaml
- id: skill-filesystem
  config:
    customSkillDirs:
      - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@video-harness/agent/package.json')), 'skills')
```

`vhAgent.promptBlock(sessionId)` returns the section text for one session, and `vhAgent.confirm(request)` is the channel the bridge calls.

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `VhAgent`: the `session/event` listener (`turn/start` notes the turn on the bridge, `turn/end` settles the draft: accepted into `main` when the turn completed and every record is deterministic or carries `user_requested: true`, kept for the user when it holds other generative work or a `confirm: always` tool or the turn was interrupted, rejected when it was aborted or empty), the confirmation channel, and the prompt section |
| [`src/resolver.ts`](src/resolver.ts) | `renderResolverBlock`: the rules plus the project snapshot folded from the branch the session writes to |
| [`skills/video-directing/SKILL.md`](skills/video-directing/SKILL.md) | Plan, approval, generation, trims, retakes, reference changes, branches, and the reference-to-video prompt rules |
| [`skills/branching-story/SKILL.md`](skills/branching-story/SKILL.md) | Two directions per node, both generated from the parent, the user picks, unchosen branches stay |

A draft opened in one agent-loop turn cannot be extended by a later turn: the bridge refuses the call until `vh_turn_accept` or `vh_turn_reject` closes it, and the prompt section says so. When a turn completes, the bridge accepts the draft into `main` by itself if every record is deterministic (uploads, entities, plans, sequence edits, joins, frames, probes) or carries `user_requested: true`, and none of them is a `confirm: always` tool; any other completed draft, and every interrupted draft with records, stays open, and the rules tell the model to end such a reply with "草稿待确认". A draft whose `main` moved while it was open (a view wrote to it) is kept as well. The prompt section also names what the user last selected in the canvas or the timeline, read from `vhViews` when that plugin is mounted. Confirmation follows the design table: `always` tools need `user_approved: true` or the user's answer to a question; `cost` tools ask only when the turn's estimated GPU seconds exceed the bridge's budget and the call does not carry `user_requested: true`.

<a id="further-exploration"></a>
## Further Exploration

- [Video harness subsystem](../../../docs/subsystems/video-harness.md)
- [`@video-harness/tools`](../tools/README.md) for the bridge the agent layer drives
- [`@video-harness/bundle`](../../bundle/video-harness/README.md) for the profile that mounts everything

<a id="model-experience"></a>
## Model Experience

### Project section

#### What the model sees

One system-prompt section named `video-harness:project`: seven rule lines, then the bound project's branch, open draft, entities with versions and references, timeline slots with their assets and producing records, takes, stale records with the record that replaced their input, and plans with approval state. Without a bound project the section is the rules plus one line saying so.

#### Token effect

About 300 tokens for the rules plus roughly 30 tokens per entity, slot, take, stale record, and plan.

#### KV Cache effect

The rules are stable text; the snapshot changes whenever the project changes, so the section invalidates the cache after every structured call.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Confirmation questions reach the user only through `userQuestions`; in a headless run the agent must ask in its reply and call again with `user_approved: true` or `user_requested: true`.
- Turn boundaries come from `session/event`, which is fire-and-forget; a draft of a turn that ends while a scheduled generation is still running is settled before that generation finishes.
- The section is rebuilt on every assembly from a full fold; large projects pay that cost on every step.
