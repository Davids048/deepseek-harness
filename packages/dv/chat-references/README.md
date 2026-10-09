---
description: "The DreamVerse chat references: dv: mentions in user messages expand into record and asset IDs, mentioned assets and the images a user attaches in a chat go on the canvas of the session's project, and the images become imported assets."
kind: "package-reference"
---

# @dv/chat-references

English | [中文](README.zh.md)

## Summary

Use this package so that what a user points at in a chat message reaches the DreamVerse project. `dvChatReferences` expands the `dv:` mentions of new user messages into a context message with the concrete record and asset IDs, imports the images a user attaches in the chat as assets of the session's project and puts them on its canvas, and puts the assets that a typed message mentions on the canvas.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount `@dv/chat-references` after the DreamVerse components; it injects `dvProject` and `dvAssetPool` and uses `agents` and `attachments` when they are present. It has no configuration.

```yaml
- id: dv-chat-references
  name: '@dv/chat-references'
```

The composer of `@dv/ui-composer` serializes a picked project item as `@[<label>](dv:<kind>/<id>)`. At `agent/pre-step` the plugin finds these mentions in the step's user messages and appends one `dv-mentions` context message that describes each mention with concrete IDs, read from the current state of the session's project. Mention URIs: `dv:asset/<AssetId>`, `dv:record/<RecordId>`, `dv:character/<CharacterId>`, `dv:location/<LocationId>`, `dv:style/<StyleId>`, and `dv:clip/<ClipId>`.

When a user message that the user typed in a live session carries images, the plugin reads them from `attachments` and runs one `asset.import` with `place: true` per image as the user, on the surface `chat`, at the end of the project's history, so each image also goes on the canvas. The session's next tool call waits until the import finished (`dvProject.holdToolCalls`). When such a message mentions assets (`dv:asset/<id>`), the plugin puts the mentioned assets that a record in the current state created and that are not on the canvas yet on it with one `asset.place` by the user, on the surface `chat`. A session without a bound project imports and places nothing.

The mention helpers `parseMentions`, `formatMention`, and `describeMention` are exported for other consumers; `dvChatReferences.expansionMessage(sessionId, messages)` returns the context message for one step.

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `DvChatReferences`: the `agent/pre-step` listener that appends the `dv-mentions` message, the project a mention resolves against (the session's bound project, else the newest project that produced a mentioned asset, else the newest project), and the `session/event` listener that imports chat images and places mentioned assets |
| [`src/expand.ts`](src/expand.ts) | `parseMentions`, `formatMention`, and `describeMention`: each mention URI described with concrete IDs and the record that produced it |

A mention of a clip names the clip by its `ClipId`, which is unique in the project; a placeholder clip names the render record it waits for. A mention of a character, location, or style names its latest version in the current state and tells the model to pass that version as an input.

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse packages](../../../docs/subsystems/video-harness.md)
- [`@dv/project`](../project/README.md) for the current state, the records the expansion describes, and `holdToolCalls`
- [`@dv/ui-composer`](../ui-composer/src/index.ts) for the composer that writes the mentions
- [`@dv/bundle`](../../bundle/dv/README.md) for the profile that mounts everything

<a id="model-experience"></a>
## Model Experience

### Mention context

#### What the model sees

When a new user message holds `@[<label>](dv:<kind>/<id>)` mentions, a context message of source `dv-mentions` follows it: "The user referenced these project items:" and one line per mention with the asset, record, character, location, style, or clip and the record that produced it (tool, status, prompt, duration, inputs, outputs). An imported chat image adds no text of its own; it appears as an asset in the project summary of `@dv/project`.

#### Token effect

About 60 tokens per mention.

#### KV Cache effect

The message is appended after the user's message, so it leaves the cached prefix intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Chat images come from `session/event`, which does not wait for its listeners; the import holds the session's next tool call, but a reply that reads the project before that call does not see the new assets.
