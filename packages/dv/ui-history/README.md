---
description: "The DreamVerse History panel: every record of a project's one history line, one row per action, newest first, with approval folds, output previews, 回到这一步 on a row, and focus of a record on the canvas or the timeline."
kind: "package-reference"
---

# @dv/ui-history

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a History panel beside the chat. A project has one history line that only grows ([history rules](../../../docs/subsystems/video-harness.md#history-rules)), so the panel is one list of every record of the open project from every actor, surface, and chat session, newest first, undo records included. Each row shows who did it, when, the status, and a thumbnail; selecting a row plays its output and, for a record of the current state, focuses it on the canvas or timeline. The header holds the undo button, and each row's ⋮ menu offers 回到这一步 / Go back to this step. The `dv-history` right-Sidebar tab type shows the panel of the project the shell has open.

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

The panel asks for every record of the project, newest first. Each row shows the tool label with its subject (修改分镜计划 p1 → v2, 参考图生成镜头 7 / Render shot from references 7, 新建角色「name」), who did it (你 / You, 智能体 / Agent, 自动 / Automatic), how long ago, the status, and one thumbnail (an image, a take's still for a video, else a video frame; other files have none). An agent row also shows on its second line the record's own `intent`, the reason the agent gave for the call. An undo record reads 回到「…」 / Go back to “…” with the label of the step it returned to (回到之前的一步 / Go back to an earlier step when that step is not loaded). The renders and the timeline record that a plan approval scheduled (`report.scheduled`) fold under the approval's row behind the toggle 渲染 n 个镜头 / Render n shots. The newest row carries 当前 / Current. Each row ends in a ⋮ button (更多操作 / More actions) whose menu offers 回到这一步 / Go back to this step (`/api/dv/undo` with `to` = that record, which adds a step that returns the project to its state just after the record), except on the newest row, on a record that has not finished, and on the record the newest undo already returned to (`canGoBack`).

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
| Undo in the header (tooltip 撤销（Ctrl+Z / ⌘Z）) | `POST /api/dv/undo` with `surface: 'history'` |
| 回到这一步 / Go back to this step in a row's ⋮ menu | `POST /api/dv/undo` `{to}` with `surface: 'history'`; a refusal shows the server's message |

A `dv:history-focus` event `{session, toolCall}` finds the record that tool call wrote, loads pages until its row is loaded, and selects it. Only records in the current state (`state.components.proj.records`) move the center; other records are only selected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`HistoryPanel` reads the project's current state with `useProjectState` for the timelines and the records of the current state, and lists the history through `POST /api/dv/history`. `actionRows` folds the scheduled records under their approval, `actionLabel` names each record (an undo record by its target, followed through undo records to the step it returned to), `centerFocus` decides what a selected row focuses, and `canGoBack` decides which rows offer 回到这一步. On `/dv/events`, an `update` event replaces the record in the loaded rows, and a `record` event refetches the loaded window, debounced by 200 ms.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | Registrations and the tab opening on `dv:history-focus` |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/HistoryPanel.tsx`](src/client/HistoryPanel.tsx) | The panel, its header with the undo button, rows with their ⋮ menus, preview, and the tab body |
| [`src/client/rows.ts`](src/client/rows.ts) | Action rows and approval folds, labels with subjects, thumbnails, relative times, center focus, and `canGoBack` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [History rules](../../../docs/subsystems/video-harness.md#history-rules) — which changes are steps, and what undo and 回到这一步 do.
- [`@dv/api`](../api/README.md) — the history route and the undo route.
- [`@dv/project`](../project/README.md) — the history query and undo.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, the window events, and the tool labels.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dv/project`; the undo records the History panel writes reach the model only through the `dv:project` prompt section and the `dv_proj_*` and operation tools of [`@dv/project`](../project/README.md).

#### KV Cache effect

None; the panel sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Window refetch** — every `record` event refetches the loaded window (up to 200 entries); a long history scrolled far back reloads slowly.
- **Undo labels need the target loaded** — an undo row whose target is on a page not loaded yet reads 回到之前的一步 / Go back to an earlier step until "Load more" loads that page.
