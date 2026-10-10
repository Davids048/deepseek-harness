---
description: "The DreamVerse History panel: the steps of a project's history list, one row per action, newest first, with the current position marked, steps after it greyed, approval folds, output previews, undo and redo, 回到这一步 on a row, and focus of a record on the canvas or the timeline."
kind: "package-reference"
---

# @dv/ui-history

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a History panel beside the chat. The panel works like the History panel of an image editor ([history rules](../../../docs/subsystems/video-harness.md#history-rules)): it is one list of the steps of the open project from every actor, surface, and chat session, newest first. The step at the current position carries 当前 / Current, and the steps after it, which redo brings back, are greyed. Each row shows who did it, when, the status, and a thumbnail; selecting a row plays its output and, for a step at or before the current position, focuses it on the canvas or timeline. The header holds the undo and redo buttons, and each row's ⋮ menu offers 回到这一步 / Go back to this step. These moves write no record; a new step after a move discards the greyed steps. The `dv-history` right-Sidebar tab type shows the panel of the project the shell has open.

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

The panel asks for the steps of the project's history list, newest first. Each row shows the tool label with its subject (修改分镜计划 p1 → v2, 参考图生成镜头 7 / Render shot from references 7, 新建角色「name」), who did it (你 / You, 智能体 / Agent, 自动 / Automatic), how long ago, the status, and, on a render row only, one thumbnail (the take's still, else a video frame, else an empty square that keeps render rows aligned); other rows are text only. An agent row also shows on its second line the record's own `intent`, the reason the agent gave for the call. The renders and the timeline record that a plan approval scheduled (`report.scheduled`) fold under the approval's row behind the toggle 渲染 n 个镜头 / Render n shots. The row of the current position carries 当前 / Current, and the rows after it are greyed: faded text and a black-and-white thumbnail. Every other row ends in a ⋮ button (更多操作 / More actions) whose menu offers 回到这一步 / Go back to this step (`/api/dv/undo` with `to` = that step), which moves the current position to that step, before or after the current one.

```yaml
- id: dv-ui-history
  name: '@dv/ui-history'
```

The Host half registers nothing. The browser half registers the `dv-history` tab type (a page the Sidebar's guide offers as "History") and the tab body under its own id `@dv/ui-history`, and opens the tab when a `dv:history-focus` window event arrives.

| Gesture | Request or event |
| --- | --- |
| Open the panel, page with "Load more" | `POST /api/dv/history`; 50 entries per page, `before` for the next page |
| Select a render, story bible, plan, or asset row of the current state | `dv:canvas-focus` `{recordId}`; the shell shows the canvas and the canvas opens the record's node |
| Select a Timeline row or a timeline export of the current state | `dv:timeline-focus` `{timelineId, clipId}`; the shell shows the timeline and the editor selects the clip |
| "Show in trajectory" in a selected agent row | `dv:trajectory-focus` `{session, toolCall}`; the shell opens 轨迹 on that chat session |
| Undo in the header (tooltip 撤销（Ctrl+Z / ⌘Z）) | `POST /api/dv/undo`; a refusal shows the server's message |
| Redo in the header (tooltip 重做（Shift+Ctrl+Z / ⇧⌘Z）), disabled while the current position is the last step | `POST /api/dv/redo` |
| 回到这一步 / Go back to this step in a row's ⋮ menu | `POST /api/dv/undo` `{to}` |

A `dv:history-focus` event `{session, toolCall}` finds the record that tool call wrote, loads pages until its row is loaded, and selects it. Only steps at or before the current position move the center; greyed steps are only selected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`HistoryPanel` reads the project's current state with `useProjectState` for the timelines and the records of the current state, and lists the history through `POST /api/dv/history`. `actionRows` folds the scheduled records under their approval, `actionLabel` names each record, and `centerFocus` decides what a selected row focuses (nothing for a greyed step). Each entry's `place` sets the 当前 mark, the grey rows, and the rows that offer 回到这一步. On `/dv/events`, an `update` event replaces the record in the loaded rows, and a `record` or `line` event refetches the loaded window, debounced by 200 ms.

| File | Content |
| --- | --- |
| [`src/css-modules.d.ts`](src/css-modules.d.ts) | The type of the CSS Module imports |
| [`src/client/index.ts`](src/client/index.ts) | Registrations and the tab opening on `dv:history-focus` |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/HistoryPanel.tsx`](src/client/HistoryPanel.tsx) | The panel, its header with the undo and redo buttons, rows with their ⋮ menus, preview, and the tab body |
| [`src/client/HistoryPanel.module.css`](src/client/HistoryPanel.module.css) | Styles of the panel |
| [`src/client/rows.ts`](src/client/rows.ts) | Action rows and approval folds, labels with subjects, thumbnails, relative times, and center focus |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [History rules](../../../docs/subsystems/video-harness.md#history-rules) — which changes are steps, and what undo, redo and 回到这一步 do.
- [`@dv/api`](../api/README.md) — the history route and the undo and redo routes.
- [`@dv/project`](../project/README.md) — the history query, undo and redo.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, the window events, and the tool labels.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dv/project`; the moves of the History panel change the current state, which reaches the model only through the `dv:project` prompt section and the `dv_proj_*` and operation tools of [`@dv/project`](../project/README.md).

#### KV Cache effect

None; the panel sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Window refetch** — every `record` or `line` event refetches the loaded window (up to 200 entries); a long history scrolled far back reloads slowly.
