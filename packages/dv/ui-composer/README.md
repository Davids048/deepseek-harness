---
description: "The DreamVerse additions to the DSH chat composer: the @ source for project items, the ask-first and quality/speed toggles, approval cards for waiting renders and plan approvals, tool rows with creator-facing names and a Show in history link, and the dv:compose prefill."
kind: "package-reference"
---

# @dv/ui-composer

English | [中文](README.zh.md)

## Summary

Use this package to fit the DSH chat composer to a DreamVerse project. Typing `@` lists the open project's clips, characters, locations, styles, and assets as reference chips. Two toggles beside the input choose whether renders wait for approval and whether the agent favors quality or speed. Approval cards above the input approve or skip waiting renders and plan approvals. DreamVerse tool rows in the chat show creator-facing names, the render card shows its video, and the link 在历史中查看 / Show in history selects a call's record. The canvas and the asset pool panel prefill the composer through `dv:compose`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that stacks `dsh-web-app` (which provides the chat, the input triggers, the UI slots, and the right Sidebar), `@dv/api` (which serves the state and operation routes), and `@dv/agent-integration` (which serves the composer routes and expands the `dv:` mentions). Build the browser bundle first: `pnpm run build` writes `lib/client.js`.

```yaml
- id: dv-ui-composer
  name: '@dv/ui-composer'
```

The Host half registers nothing. The browser half registers the `@` source `dv-project` and the UI slot entries `conversation.input.left` (the toggles), `conversation.input.dock` (the approval cards), `conversation.input.permission` (an empty entry), and `tool.call.toolview` for every tool in `DV_TOOL_LABELS`. It also adds a `tool.name.<tool>` entry per labelled tool to DSH's `chat` dictionaries, which the running group title reads.

| Gesture | Request or event |
| --- | --- |
| Type `@` | `GET /api/dv/state` for `main` of the open project; the entry page lists nothing |
| Change a toggle | `POST /api/dv/composer/mode` `{session, confirm?, speed?}`; the toggles read `GET /api/dv/composer/mode` when they mount |
| Wait for approval | `GET /api/dv/composer/approvals` every 1.5 s while a `dv_shot_render` card or the approval area is mounted |
| 批准 / Approve, 跳过 / Skip, 全部批准 / Approve all | `POST /api/dv/composer/approvals` `{session, id, action}` or `{session, all: true, action}` |
| 在历史中查看 / Show in history | `dv:history-focus` `{session, toolCall}`; the History panel selects the record that tool call wrote |
| `dv:compose` from another view | The newest mounted composer replaces its draft with the text and appends one chip per reference; nothing is sent |

The `@` list reads the state of `main`: every clip by timeline name and position (时间线 1 · 片段 2 / Timeline 1 · Clip 2 for an unnamed timeline), the latest version of each character, location, and style, and the 40 newest image and video assets; a pick inserts a chip whose text is `@[<label>](dv:<kind>/<id>)`. The toggles are 渲染前先问 / Ask first or 直接渲染 / Render directly, and 质量 / Quality or 速度 / Speed. An approval card shows the prompt, the reference images, the duration, and the estimated GPU seconds, with 批准 / Approve and 跳过 / Skip, plus 全部批准 / Approve all when several wait. Every settled row whose call wrote a record has the link 在历史中查看 / Show in history. A `dv:compose` event also brings the 对话 / Chat tab to the front. The package hides DSH's file-permission chip.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A `dv:compose` event that arrives while no composer is mounted waits for the next composer that mounts; a chip the input refuses falls back to its plain reference text. The approval list of each chat session lives in one shared store, so every card and the approval area read the same list; a failed refresh keeps the last list. A tool row reads whether its call wrote a record from the presentation metadata of the call's result: an operation tool and a `dv_proj_*` tool that writes records name the record they wrote in `record`, a read operation such as `inspect.image` names `record: ''`, and a read `dv_proj_*` tool (`dv_proj_open`, `dv_proj_state`, `dv_proj_history_list`, `dv_proj_wait`) or a failed call carries no metadata.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The Host half, which registers nothing |
| [`src/client/index.ts`](src/client/index.ts) | Registrations: the `@` source, the UI slot entries, the tool names, and the `dv:compose` listener |
| [`src/client/mention.ts`](src/client/mention.ts) | The `@` source, its project items, and the reference text |
| [`src/client/compose.ts`](src/client/compose.ts) | Delivery of `dv:compose` to the newest mounted composer |
| [`src/client/api.ts`](src/client/api.ts) | The shared API client and the per-session approval store |
| [`src/client/views.tsx`](src/client/views.tsx) | The toggles, the approval area and cards, the render card, the tool rows, and the history link |
| [`src/client/tool-labels.ts`](src/client/tool-labels.ts) | The tool names added to DSH's `chat` dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/agent-integration`](../agent-integration/README.md) — the composer routes, the approval channel, the `dv:` mention expansion, and the prompt section that carries the composer modes.
- [`@dv/ui-history`](../ui-history/README.md) — the History panel that answers `dv:history-focus`.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, the compose event, and the tool labels.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the agent integration (`@dv/agent-integration`), which turns the `dv:` mentions of a sent message into a context message and the composer modes into lines of its project prompt section.

#### KV Cache effect

None from this package; changing a toggle changes the agent integration's prompt section, whose effect that package's README describes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Approval polling** — the approval list is polled every 1.5 s per chat session while a `dv_shot_render` card or the approval area is mounted, so a new card can take that long to appear.
