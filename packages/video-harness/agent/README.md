---
description: "The agent layer of the video harness: agent turns and the human's words reach the project records, chat images become imported assets, the DSH question rule asks the user before plan approvals and costly renders, the state of the session's working branch becomes a system-prompt section, and the directing skills ship with the package."
kind: "package-reference"
---

# @video-harness/agent

English | [中文](README.zh.md)

## Summary

Use this package to run the DSH agent over a video project. `vhAgent` listens to session events and reports each agent turn and the human's words that started it to `dvProject` (`noteTurn`), so the turn's records carry the turn and its first record is preceded by the turn's request record; it imports the images the user attaches in the chat as assets (`asset.import` by the user, which the session's next tool call waits for); it registers the DSH question rule of `plan.approve` and `shot.render` as the `dvProject` tool call check and asks its questions through `userQuestions` when the calling agent is a live root agent; and it contributes a system-prompt section with the state of the session's working branch: characters, locations and styles, timelines and their clips, takes, stale records, plans, the draft, and the rules for resolving references such as "the second clip". The `skills/` directory holds the `video-directing` and `branching-story` skills a profile points `skill-filesystem` at.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount `@video-harness/agent` after the DreamVerse components; it injects `dvProject` and `dvAssetPool` and uses `agents`, `attachments`, `dvShotPlan`, `systemPrompt`, and `userQuestions` when they are present. Configuration: `promptSectionOrder` (default 4900, before the tool SDK section), `approveLabel` and `declineLabel` (the two options of a confirmation question), and `confirmGpuSecondsThreshold` (default 60: the estimated GPU seconds a turn may spend on `shot.render` calls before the user must agree).

Point `skill-filesystem` at this package's `skills/` directory so the agent can load the two skills:

```yaml
- id: skill-filesystem
  config:
    customSkillDirs:
      - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@video-harness/agent/package.json')), 'skills')
```

`vhAgent.promptBlock(sessionId)` returns the section text for one session, `vhAgent.confirm(request)` is the channel the question rule asks through, and `vhAgent.setComposer(channel)` installs the composer's modes, which the composer plugin registers.

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `VhAgent`: the `session/event` listener (`turn/start` notes the turn on `dvProject`, a `user/message` the user typed notes the human's words on that turn and imports its images), the question rule's registration, the confirmation channel, and the prompt section |
| [`src/question-rule.ts`](src/question-rule.ts) | `questionRule`: the `ToolCallCheck` with `QUESTION_RULES`, the `user_approved` and `user_requested` arguments, the turn's GPU budget, and the plan approval question that lists every shot |
| [`src/resolver.ts`](src/resolver.ts) | `renderResolverBlock`: the rules plus the project snapshot of the session's working branch |
| [`skills/video-directing/SKILL.md`](skills/video-directing/SKILL.md) | Plan, approval, rendering, trims, retakes, reference changes, branches, and the reference-to-video prompt rules |
| [`skills/branching-story/SKILL.md`](skills/branching-story/SKILL.md) | Two directions per node, both rendered from the parent, the user picks, unchosen branches stay |

The draft belongs to the chat session: the session's first agent record opens `draft/<session>`, the draft spans turns and also holds the user's edits, and only the user closes it. The agent layer never accepts or discards a draft; the rules tell the model to call `dv_proj_draft_accept` or `dv_proj_draft_discard` only when the user asks, and to end a reply whose draft holds results the user has not judged with "草稿待确认". The prompt section also names what the user last selected in the canvas or the timeline, read from `vhViews` when that plugin is mounted. Confirmation follows the design table: `plan.approve` needs `user_approved: true` or the user's answer to a question; a shot render asks only when the turn's estimated GPU seconds exceed `confirmGpuSecondsThreshold` and the call does not carry `user_requested: true`. The rule only asks: the runner enforces the approval card, and `plan.approve` and `shot.render` refuse a call without reference images in their own precondition, before the rule asks. In the composer's ask mode `confirm` answers yes for `confirm: agent_ask_first` operations, because `dvProject` holds the record behind the composer's approval card, which is the question.

<a id="further-exploration"></a>
## Further Exploration

- [Video harness subsystem](../../../docs/subsystems/video-harness.md)
- [`@dv/project`](../../dv/project/README.md) for the tool call check and the operation tools the agent calls
- [`@video-harness/bundle`](../../bundle/video-harness/README.md) for the profile that mounts everything

<a id="model-experience"></a>
## Model Experience

### Project section

#### What the model sees

One system-prompt section named `video-harness:project`: eight rule lines, then the bound project's working branch, whether a draft is open with its counts of agent changes and human edits, characters, locations and styles with versions and references, every timeline with its clips by position, their assets and producing records, takes, stale records with the record that replaced their input, and plans with approval state. Without a bound project the section is the rules plus one line saying so.

#### Token effect

About 300 tokens for the rules plus roughly 30 tokens per character, location, style, timeline clip, take, stale record, and plan.

#### KV Cache effect

The rules are stable text; the snapshot changes whenever the project changes, so the section invalidates the cache after every structured call.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Confirmation questions reach the user only through `userQuestions`; in a headless run the agent must ask in its reply and call again with `user_approved: true` or `user_requested: true`.
- Turn starts and the human's words come from `session/event`, which is fire-and-forget; a structured call that runs before the listener noted the words of its turn writes no request record for that turn.
- The section is rebuilt on every assembly from the state of the working branch; large projects pay that cost on every step.
