---
description: "The DreamVerse additions to the DSH chat composer: the @ source and the Reference row for project items, the render tool cards, tool rows with creator-facing names and a Show in history link, and the dv:compose prefill."
kind: "package-reference"
---

# @dv/ui-composer

English | [中文](README.zh.md)

## Summary

Use this package to fit the DSH chat composer to a DreamVerse project. Typing `@`, or picking 引用 / Reference in the composer's ＋ menu, lists the open project's clips, characters, locations, styles, and assets as reference chips. DreamVerse tool rows in the chat show creator-facing names, the render card shows the prompt, the status, and the rendered video, and the link 在历史中查看 / Show in history selects a call's record. The canvas and the asset pool panel prefill the composer through `dv:compose`. The agent asks for the user's agreement in the conversation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that stacks `dsh-web-app` (which provides the chat, the input triggers, the UI slots, and the right Sidebar), `@dv/api` (which serves the state and operation routes), and `@dv/chat-references` (which expands the `dv:` mentions of a sent message). Build the browser bundle first: `pnpm run build` writes `lib/client.js`.

```yaml
- id: dv-ui-composer
  name: '@dv/ui-composer'
```

The Host half registers nothing. The browser half registers the `@` source `dv-project`, the ＋ menu row 引用 / Reference through DSH's `commandUi` service when it is mounted, and the UI slot entries `conversation.input.left` (ID `dv-composer-compose`, which renders nothing and makes each mounted session composer a target of `dv:compose`), `conversation.input.permission` (an empty entry), `conversation.chat.markdown` (a chain entry, present while the open project has video or image assets), and `tool.call.toolview` for every tool in `DV_TOOL_LABELS`: `RenderCard` for `dv_shot_render_ref2va` and `dv_shot_render_t2va`, and `ToolLabelRow` for every other tool. It also adds a `tool.name.<tool>` entry per labelled tool to DSH's `chat` dictionaries, which the running group title reads.

| Gesture | Request or event |
| --- | --- |
| Type `@`, or pick 引用 / Reference in the ＋ menu | `GET /api/dv/state` for `main` of the open project; the entry page lists nothing |
| 在历史中查看 / Show in history | `dv:history-focus` `{session, toolCall}`; the History panel selects the record that tool call wrote |
| Send a message that holds a `dv:asset/<id>` chip or attached images | `POST /api/dv/layout` with those assets in `placed`, which adds them to the open project's canvas list; an attached image's asset ID is the SHA-256 hex of its bytes, the ID `@dv/chat-references` imports it under |
| `dv:compose` from another view | The newest mounted composer replaces its draft with the text and appends one chip per reference; nothing is sent |

The `@` list reads the state of `main`: every clip by timeline name and position (时间线 1 · 片段 2 / Timeline 1 · Clip 2 for an unnamed timeline), the latest version of each character, location, and style, and the 40 newest image and video assets; a pick inserts a chip whose text is `@[<label>](dv:<kind>/<id>)`. The 引用 / Reference row opens the same list at the end of the draft. The render card shows the tool's name (参考图生成镜头 / Render shot from references or 文字生成镜头 / Render shot from text), the prompt, the status 渲染中… / Rendering…, 已渲染 / Rendered, or 未渲染 / Not rendered, and the rendered video. Every other labelled tool row shows the tool's name and the status 进行中… / Running…, 完成 / Done, or 未完成 / Failed. Every settled render card and every settled row whose call wrote a record has the link 在历史中查看 / Show in history. A `dv:compose` event also brings the 对话 / Chat tab to the front. The package hides DSH's file-permission chip and draws the 对话 / Chat tab's composer card, its ＋ button, and its send button with the DreamVerse theme tokens.

In settled chat Markdown, a link whose path is `/dv/assets/<id>` and whose asset is a video becomes a small 16:9 card with the video's first frame, a play badge, and the link text under it; a click plays the video in the card with controls and does not leave the page. A table in which every body row links such a video becomes a three-column grid of these cards, each captioned with the row's other cells joined by ` · ` (for example `1 · 直播间开场「来一把吧」`). A Markdown image of an image asset becomes a thumbnail at most 240 px wide, and a click opens it in DSH's image preview. The kinds come from the state of `main` and of every open draft branch of the open project, fetched again after each project event; other links, images, and tables keep DSH's rendering.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A `dv:compose` event that arrives while no composer is mounted waits for the next composer that mounts; a chip the input refuses falls back to its plain reference text. A tool row reads whether its call wrote a record from the presentation metadata of the call's result: an operation tool and a `dv_proj_*` tool that writes records name the record they wrote in `record`, a read operation such as `inspect.image` names `record: ''`, and a read `dv_proj_*` tool (`dv_proj_open`, `dv_proj_state`, `dv_proj_history_list`, `dv_proj_wait`) or a failed call carries no metadata.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The Host half, which registers nothing |
| [`src/css-modules.d.ts`](src/css-modules.d.ts) | The type of the CSS Module imports |
| [`src/client/index.ts`](src/client/index.ts) | Registrations: the `@` source, the ＋ menu row, the UI slot entries, the tool names, and the `dv:compose` listener |
| [`src/client/mention.ts`](src/client/mention.ts) | The `@` source, its project items, and the reference text |
| [`src/client/attachments.ts`](src/client/attachments.ts) | The canvas placement of the images a chat message sends |
| [`src/client/asset-kinds.ts`](src/client/asset-kinds.ts) | The video and image index of the open project's assets |
| [`src/client/chat-media.ts`](src/client/chat-media.ts) | The `conversation.chat.markdown` entry and its choice of links, images, and tables |
| [`src/client/ChatMedia.tsx`](src/client/ChatMedia.tsx) | The video cards, the shot grid, and the image thumbnail |
| [`src/client/compose.ts`](src/client/compose.ts) | Delivery of `dv:compose` to the newest mounted composer |
| [`src/client/views.tsx`](src/client/views.tsx) | The render card, the tool rows, and the history link |
| [`src/client/views.module.css`](src/client/views.module.css) | Styles of the render card, the tool rows, and the history link |
| [`src/client/composer.css`](src/client/composer.css) | Styles of the 对话 / Chat tab's composer card, ＋ button, and send button |
| [`src/client/tool-labels.ts`](src/client/tool-labels.ts) | The tool names added to DSH's `chat` dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/chat-references`](../chat-references/README.md) — the expansion of the `dv:` mentions of a sent message into a context message with record and asset IDs.
- [`@dv/project`](../project/README.md) — the `dv:project` prompt section, which tells the agent to ask for the user's agreement in the conversation with the question in bold.
- [`@dv/ui-history`](../ui-history/README.md) — the History panel that answers `dv:history-focus`.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, the compose event, and the tool labels.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dv/chat-references`, which turns the `dv:` mentions of a sent message into a `dv-mentions` context message.

#### KV Cache effect

None from this package; the `dv-mentions` context message follows the user message it expands, and the README of `@dv/chat-references` describes its effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **`@` list of `main`** — the `@` list and the 引用 / Reference row read the state of `main`, so an item that exists only in the chat session's draft is not listed.
- **Cards wait for the asset index** — until the open project's state loads, and for an asset that neither `main` nor an open draft mentions, asset links and images keep DSH's rendering. Each change of the index registers the chain entry again, which remounts the cards and stops a video that plays in a card.
