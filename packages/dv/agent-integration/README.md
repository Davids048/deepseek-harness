---
description: "The DreamVerse agent integration: agent turns and the human's words reach the project records, chat images become imported assets, the DSH question rule asks the user before plan approvals and costly renders, composer modes and approval cards hold ask-first calls, dv: mentions expand into record and asset IDs, the state of the session's working branch becomes a system-prompt section, and the directing skills ship with the package."
kind: "package-reference"
---

# @dv/agent-integration

English | [中文](README.zh.md)

## Summary

Use this package to run the DSH agent over a DreamVerse project. `dvAgentIntegration` connects chat sessions to `dvProject`: it records each agent turn with the human's words that started it, imports the images attached in the chat as assets, asks the user before plan approvals and costly shot renders, holds ask-first calls behind approval cards, expands `dv:` mentions into record and asset IDs, and adds a system-prompt section with the state of the session's working branch. The `skills/` directory holds the directing skills.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount `@dv/agent-integration` after the DreamVerse components; it injects `dvProject` and `dvAssetPool` and uses `agents`, `attachments`, `connection`, `dvApi`, `dvShotPlan`, `systemPrompt`, and `userQuestions` when they are present.

The plugin listens to session events and reports each agent turn and the human's words that started it to `dvProject` (`noteTurn`), so the turn's records carry the turn and its first record is preceded by the turn's request record. It imports the images the user attaches in the chat as assets (`asset.import` by the user, which the session's next tool call waits for). It registers the DSH question rule of `plan.approve` and `shot.render` as the `dvProject` tool call check and asks its questions through `userQuestions` when the calling agent is a live root agent. It keeps each chat session's composer modes and, as `dvProject`'s approval channel, holds the agent's ask-first calls behind approval cards. It expands the `dv:` mentions of new user messages into a context message with record and asset IDs. Its system-prompt section lists characters, locations and styles, timelines and their clips, takes, stale records, plans, the draft, and the rules for resolving references such as "the second clip". The `skills/` directory holds the `video-directing`, `timeline-editing`, and `branching-story` skills a profile points `skill-filesystem` at.

```yaml
- id: dv-agent-integration
  name: '@dv/agent-integration'
  config:
    stateRoot: !!js process.env.DV_STATE_ROOT
```

| Field | Default | Meaning |
| --- | --- | --- |
| `stateRoot` | required | The state directory; the composer modes live in `<stateRoot>/composer-modes.json` |
| `promptSectionOrder` | `4900` | Order of the project section in the system prompt, before the tool SDK section |
| `approveLabel`, `declineLabel` | `Run it`, `Not now` | The two options of a confirmation question |
| `confirmGpuSecondsThreshold` | `60` | The estimated GPU seconds a turn may spend on `shot.render` calls before the user must agree |

Point `skill-filesystem` at this package's `skills/` directory so the agent can load the three skills:

```yaml
- id: skill-filesystem
  config:
    customSkillDirs:
      - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@dv/agent-integration/package.json')), 'skills')
```

While a Connection is mounted, the plugin serves two authenticated routes for `@dv/ui-composer`:

| Route | Method | Request | Response |
| --- | --- | --- | --- |
| `/api/dv/composer/mode` | GET | query `session` | `ComposerMode` `{confirm: ask \| direct, speed: quality \| speed}` |
| `/api/dv/composer/mode` | POST | `{session, confirm?, speed?}` | `ComposerMode` |
| `/api/dv/composer/approvals` | GET | query `session` | `ApprovalCard[]` `{id, session, tool_call, operation, summary, prompt, duration_sec, gpu_seconds, references, created_at}` |
| `/api/dv/composer/approvals` | POST | `{session, id? \| all?, action: approve \| skip}` | `{answered}` |

An error answers with the JSON body `{error, code}` of the `@dv/api` routes: 400 `invalid_params` when `session` is missing, 500 `internal_error` for an unexpected failure.

`dvAgentIntegration.promptBlock(sessionId)` returns the section text for one session; `confirm(request)` is the channel the question rule asks through; `getComposerMode`, `updateComposerMode`, `approvals`, and `answer` read and change the composer modes and the approval cards; `asksFirst` and `requestApproval` are the `ApprovalChannel` that `dvProject` calls. The mention helpers `parseMentions`, `formatMention`, and `describeMention` are exported for other consumers.

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `DvAgentIntegration`: the `session/event` listener (`turn/start` notes the turn on `dvProject`, a `user/message` the user typed notes the human's words on that turn and imports its images), the question rule's registration, the confirmation channel, the approval channel, the composer routes, the `agent/pre-step` mention expansion, and the prompt section |
| [`src/composer.ts`](src/composer.ts) | The composer modes file, the pending approval cards (a plan approval's card lists the shots of the approved version that render, by shot number), the composer Fetch routes, and the `dv-mentions` context message |
| [`src/expand.ts`](src/expand.ts) | `parseMentions` and `describeMention`: the `dv:asset`, `dv:record`, `dv:character`, `dv:location`, `dv:style`, and `dv:clip` mention URIs described with concrete IDs |
| [`src/question-rule.ts`](src/question-rule.ts) | `questionRule`: the `ToolCallCheck` with `QUESTION_RULES`, the `user_approved` and `user_requested` arguments, the turn's GPU budget, and the plan approval question that lists the shots a plan version renders, with their cost |
| [`src/resolver.ts`](src/resolver.ts) | `renderResolverBlock`: the rules plus the project snapshot of the session's working branch |
| [`skills/video-directing/SKILL.md`](skills/video-directing/SKILL.md) | Plan, approval, rendering, trims, retakes, reference changes, branches, and the reference-to-video prompt rules |
| [`skills/timeline-editing/SKILL.md`](skills/timeline-editing/SKILL.md) | The user's editing requests mapped to the exact tool calls and their arguments |
| [`skills/branching-story/SKILL.md`](skills/branching-story/SKILL.md) | Two directions per node, both rendered from the parent, the user picks, unchosen branches stay |

The draft belongs to the chat session: the session's first agent record opens `draft/<session>`, the draft spans turns and also holds the user's edits, and only the user closes it. The agent integration never accepts or discards a draft; the rules tell the model to call `dv_proj_draft_accept` or `dv_proj_draft_discard` only when the user asks, and to end a reply whose draft holds results the user has not judged with "草稿待确认". The prompt section also names what the user last selected in a view, read from `dvApi` when that plugin is mounted. Confirmation follows the design table: `plan.approve` needs `user_approved: true` or the user's answer to a question; a shot render asks only when the turn's estimated GPU seconds exceed `confirmGpuSecondsThreshold` and the call does not carry `user_requested: true`. The rule only asks: the runner enforces the approval card, and `plan.approve` and `shot.render` refuse a call without reference images in their own precondition, before the rule asks. In the composer's ask mode `confirm` answers yes for `confirm: agent_ask_first` operations, because `dvProject` holds the record behind the approval card, which is the question; skipping the card cancels the record, and unloading the plugin skips every pending card. A mention of a clip names the clip by its `ClipId`, which is unique in the project; expansion reads the state of the session's working branch.

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse packages](../../../docs/subsystems/video-harness.md)
- [`@dv/project`](../project/README.md) for the tool call check, the approval channel, and the operation tools the agent calls
- [`@dv/api`](../api/README.md) for the view selection the prompt section names
- [`@dv/ui-composer`](../ui-composer/src/index.ts) for the composer that writes the mentions and shows the approval cards
- [`@dv/bundle`](../../bundle/dv/README.md) for the profile that mounts everything

<a id="model-experience"></a>
## Model Experience

### Project section

#### What the model sees

One system-prompt section named `dv:project`: nine rule lines (one tells the agent to extend, shorten or change a story with `dv_plan_update` on its plan and to create a plan only for a separate story), then the bound project's working branch, whether a draft is open with its counts of agent changes and human edits, characters, locations and styles with versions and references, every timeline with its clips by position, their clip IDs, assets and producing records (a placeholder clip shows `rendering` or `render failed` and the render record it waits for), takes, stale records with the record that replaced their input, each plan once with its latest version, latest approved version and shot count (`- p1 "title": latest v2 (7 shots), v1 approved`), and one line with the session's composer preference. Without a bound project the section is the rules plus one line saying so.

#### Token effect

About 300 tokens for the rules plus roughly 30 tokens per character, location, style, timeline clip, take, stale record, and plan.

#### KV Cache effect

The rules are stable text; the snapshot changes whenever the project changes, so the section invalidates the cache after every structured call.

### Mention expansion

#### What the model sees

When a new user message holds `@[<label>](dv:<kind>/<id>)` mentions, a context message of source `dv-mentions` follows it: "The user referenced these project items:" and one line per mention with the asset, record, character, location, style, or clip and the record that produced it (tool, status, prompt, duration, inputs, outputs).

#### Token effect

About 60 tokens per mention.

#### KV Cache effect

The message is appended after the user's message, so it leaves the cached prefix intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Confirmation questions reach the user only through `userQuestions`; in a headless run the agent must ask in its reply and call again with `user_approved: true` or `user_requested: true`.
- Turn starts and the human's words come from `session/event`, which is fire-and-forget; a structured call that runs before the listener noted the words of its turn writes no request record for that turn.
- The section is rebuilt on every assembly from the state of the working branch; large projects pay that cost on every step.
