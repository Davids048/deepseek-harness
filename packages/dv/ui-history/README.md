---
description: "The DreamVerse History panel: the edit history of a project, one row per action, newest first, with marks, approval folds, filters, output previews, and focus of a record on the canvas or the timeline."
kind: "package-reference"
---

# @dv/ui-history

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a History panel beside the chat. `HistoryPanel` lists the actions of the open project from every actor, surface, and chat session, newest first, one row per operation record, with who did it, when, the status, a thumbnail, and the mark (草稿 / Draft, 已接受 / Accepted, 已撤销 / Undone, and others). Filters narrow the rows by actor, branch, operation kind, and timeline. Selecting a row plays its output and focuses the record on the canvas or timeline. The `dv-history` right-Sidebar tab type shows the panel of the project the shell has open.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that stacks `dsh-web-app` (which provides the right Sidebar and the client module loader) and `@dv/api` (which serves the routes the panel calls). Build the browser bundle first: `pnpm run build` writes `lib/client.js`.

Each row shows the tool label with its subject (修改分镜计划 p1 → v2, 参考图生成镜头 7 / Render shot from references 7, 新建角色「name」), who did it (你 / You, 智能体 / Agent, 自动 / Automatic), how long ago, the status, and one thumbnail (an image, a take's still for a video, else a video frame; other files have none). An agent row also shows on its second line the record's own `intent`, the reason the agent gave for the call. The renders and the timeline record that a plan approval scheduled (`report.scheduled`) fold under the approval's row behind the toggle 渲染 n 个镜头 / Render n shots. The marks are 草稿 / Draft on an open draft, 已接受 / Accepted after the draft was accepted, 已撤销 / Undone, 已丢弃 / Discarded, 已重放 / Replayed; undone and discarded rows stay listed, dimmed and struck. The undo and redo records themselves are not rows. On the working branch, the current step carries 当前 / Current, every step before it offers 回到这一步 / Go back to this step (`/api/dv/undo` with `to` = that record, so the branch returns to just after it), and the steps redo can bring back (`WireState.redo_steps`) are dimmed without the strike; a write after an undo empties that set, and those rows are then struck. One bar holds the filters and the header actions.

```yaml
- id: dv-ui-history
  name: '@dv/ui-history'
```

The Host half registers nothing. The browser half registers the `dv-history` tab type (a page the Sidebar's guide offers as "History") and the tab body under its own id `@dv/ui-history`, and opens the tab when a `dv:history-focus` window event arrives.

| Gesture | Request or event |
| --- | --- |
| Open the panel, page with "Load more", change a filter | `POST /api/dv/history` with the filters as `HistoryQuery` fields; 50 entries per page, `before` for the next page |
| Select a render, story bible, plan, or asset row | `dv:canvas-focus` `{recordId}`; the shell shows the canvas and the canvas opens the record's node |
| Select a Timeline row or a timeline export | `dv:timeline-focus` `{timelineId, clipId}`; the shell shows the timeline and the editor selects the clip |
| "Show in trajectory" in a selected agent row | `dv:trajectory-focus` `{session, toolCall}`; the shell opens 轨迹 on that chat session |
| Accept the draft, Discard, Undo, Redo in the header; 回到这一步 on a row | `POST /api/dv/drafts/accept`, `/api/dv/drafts/discard` (through the confirmation dialog), `/api/dv/undo` (with `to` for a row), `/api/dv/redo` with `surface: 'history'` |

A `dv:history-focus` event `{session, toolCall}` clears the filters, finds the record that tool call wrote, loads pages until its row is loaded, and selects it. Only records marked `main` or `draft` move the center; `proj.*` records are only selected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`HistoryPanel` reads the state of `main` with `useProjectState` for the branches and the chat session's open draft, and the state of the session's working branch for its timelines and records. The branch filter `main` asks for marks `main` and `undone`, and a draft for its `draft` records. The timeline filter sends the record set that `timelineRecords` computes from the working branch: Timeline records and exports of the timeline or of its clips (a clip belongs to the timeline of the record whose `report.clips` assigned it), and the records that created the assets of its clips. On `/dv/events`, an `update` event replaces the record in the loaded rows, and any other event refetches the loaded window, debounced by 200 ms.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | Registrations and the tab opening on `dv:history-focus` |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/HistoryPanel.tsx`](src/client/HistoryPanel.tsx) | The panel, its header buttons (accept, discard, undo, redo), filters, rows, preview, and the tab body |
| [`src/client/rows.ts`](src/client/rows.ts) | Action rows and approval folds, labels with subjects, thumbnails, relative times, mark badges, the branch filter query, timeline record sets, and center focus |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/api`](../api/README.md) — the history route and the draft, undo, and redo routes.
- [`@dv/project`](../project/README.md) — the history query and the marks of its entries.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, the window events, and the tool labels.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dv/project`; the records the History panel's accept, discard, undo, and redo write reach the model only through the `dv:project` prompt section and the `dv_proj_*` and operation tools of [`@dv/project`](../project/README.md).

#### KV Cache effect

None; the panel sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Timeline filter covers the working branch** — the record set of a timeline comes from the chat session's working branch, so records of discarded drafts and other drafts do not match it.
- **Window refetch** — every `record` or `branch` event refetches the loaded window (up to 200 entries); a long history scrolled far back reloads slowly.
