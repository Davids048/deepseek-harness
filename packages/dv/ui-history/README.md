---
description: "The DreamVerse History panel: the steps of a project's current branch, one row per action, newest first, with approval folds, output previews, and focus of a record on the canvas or the timeline, and a branch tree of every branch."
kind: "package-reference"
---

# @dv/ui-history

English | [中文](README.zh.md)

## Summary

Use this package to give the web application a History panel beside the chat. The panel's header holds the branch menu (`BranchMenu` of `@dv/ui-kit`, the same as the bottom bar's), the 列表 | 分支树 / List | Branch tree switch between the two views, and undo and redo. The list view (列表 / List) shows the steps of the open project's current branch from every actor, surface, and chat session, newest first, one row per operation record, with who did it, when, the status, and a thumbnail, and selecting a row plays its output and focuses the record on the canvas or timeline. The tree view (分支树 / Branch tree) draws every branch of the project as a lane graph, and every row's ⋮ menu offers 回到这一步 / Go back to this step and 从这里新建分支 / New branch from here. The `dv-history` right-Sidebar tab type shows the panel of the project the shell has open.

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

The list view asks for the entries marked `current` and `redo`: the steps of the current branch up to its head, and the steps after the head that redo brings back. Each row shows the tool label with its subject (修改分镜计划 p1 → v2, 参考图生成镜头 7 / Render shot from references 7, 新建角色「name」), who did it (你 / You, 智能体 / Agent, 自动 / Automatic), how long ago, the status, and one thumbnail (an image, a take's still for a video, else a video frame; other files have none). An agent row also shows on its second line the record's own `intent`, the reason the agent gave for the call. The renders and the timeline record that a plan approval scheduled (`report.scheduled`) fold under the approval's row behind the toggle 渲染 n 个镜头 / Render n shots. The undo and redo records themselves are not rows. The current step carries 当前 / Current, and the steps redo can bring back (`WireState.redo_steps`) are dimmed. Each row ends in a ⋮ button (更多操作 / More actions) whose menu offers 回到这一步 / Go back to this step on every step before the current one (`/api/dv/undo` with `to` = that record, so the branch returns to just after it) and 从这里新建分支 / New branch from here on every step.

```yaml
- id: dv-ui-history
  name: '@dv/ui-history'
```

The tree view asks for the entries marked `current`, `redo`, and `branch`: every step on the line of any branch. Each row is one step: a dot in the lane of the branch that owns it, the lines of the branches that pass the row, a small thumbnail, and the tool label with its subject. A forked branch's lane bends into the dot of the step it was forked at; a branch without steps of its own yet ends in a hollow marker there. Each branch's label (主线 / Main, 分支 n / Branch n, or the title the human gave it), outlined in its lane's color, sits on the row where its lane starts; the current branch's label, filled, sits on its head step. The head step's row is tinted with an accent edge and carries 当前 / Current, and the tree scrolls it into view when the tree opens and whenever the head moves; the steps redo brings back are dimmed. Clicking a step selects it and focuses its record like the list view. Each node ends in the same ⋮ menu: 回到这一步 / Go back to this step, on every step except the head, makes the step's branch current and moves that branch's head to the step: the current branch when its line holds the step, else the branch that owns it.

The Host half registers nothing. The browser half registers the `dv-history` tab type (a page the Sidebar's guide offers as "History") and the tab body under its own id `@dv/ui-history`, and opens the tab when a `dv:history-focus` window event arrives.

| Gesture | Request or event |
| --- | --- |
| Open the panel, switch the view, page with "Load more" | `POST /api/dv/history` with the view's `marks`; 50 entries per page, `before` for the next page |
| Select a render, story bible, plan, or asset row | `dv:canvas-focus` `{recordId}`; the shell shows the canvas and the canvas opens the record's node |
| Select a Timeline row or a timeline export | `dv:timeline-focus` `{timelineId, clipId}`; the shell shows the timeline and the editor selects the clip |
| "Show in trajectory" in a selected agent row | `dv:trajectory-focus` `{session, toolCall}`; the shell opens 轨迹 on that chat session |
| Undo, Redo in the header; 回到这一步 in a list row's ⋮ menu | `POST /api/dv/undo` (with `to` for a row), `/api/dv/redo` with `surface: 'history'` |
| Switch, 新建分支 / New branch, or rename (✎) in the header's branch menu | `POST /api/dv/branches/switch`, `/api/dv/branches/create`, or `/api/dv/branches/rename` with `surface: 'history'`; a refusal shows the server's message |
| 回到这一步 / Go back to this step in a tree node's ⋮ menu | `POST /api/dv/branches/switch` `{branch, to}` with `surface: 'history'` |
| 从这里新建分支 / New branch from here in a row's or node's ⋮ menu | `POST /api/dv/branches/create` `{branch, to}` with `surface: 'history'`: `branch` is the branch whose line holds the step (the current branch when its line does), `to` the step; the new branch becomes current |

A `dv:history-focus` event `{session, toolCall}` shows the list view, finds the record that tool call wrote, loads pages until its row is loaded, and selects it. Only records marked `current` move the center; `proj.*` records are only selected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`HistoryPanel` reads the state of the project's current branch with `useProjectState` for the branches, the current step, the redo steps, the timelines and the records. `branchTree` lays out the tree view from the loaded entries and the branches: the owner of a step is the branch it was written on when that branch's line still holds it, else the first branch whose line holds it (`HistoryEntry.branches`); a forked branch's lane runs from its newest step down to its `forked_at` row, or to the bottom while that row is not loaded. Lanes take columns: `main` the first, every other lane the leftmost column no other lane covers in its rows, at most `TREE_COLUMNS` (6). Each tree row draws its lane lines, forks, and dot as one inline SVG. On `/dv/events`, an `update` event replaces the record in the loaded rows, and any other event refetches the loaded window, debounced by 200 ms.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | Registrations and the tab opening on `dv:history-focus` |
| [`src/client/definition.ts`](src/client/definition.ts) | The tab type |
| [`src/client/HistoryPanel.tsx`](src/client/HistoryPanel.tsx) | The panel, its header (branch menu, view switch, undo and redo buttons), rows with their ⋮ menus, preview, the branch tree, and the tab body |
| [`src/client/rows.ts`](src/client/rows.ts) | Action rows and approval folds, labels with subjects, thumbnails, relative times, timeline record sets, center focus, the current branch's steps, and the branch tree layout |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/api`](../api/README.md) — the history route, the branch switch route, and the undo and redo routes.
- [`@dv/project`](../project/README.md) — the history query, the marks and branch lines of its entries, and the branches.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, the window events, and the tool labels.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dv/project`; the records the History panel's undo, redo, and branch switches write, and the current branch they choose, reach the model only through the `dv:project` prompt section and the `dv_proj_*` and operation tools of [`@dv/project`](../project/README.md).

#### KV Cache effect

None; the panel sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Six tree columns** — when more than six lanes cover the same rows, the extra lanes share the last column and their lines overlap.
- **Window refetch** — every `record` or `branch` event refetches the loaded window (up to 200 entries); a long history scrolled far back reloads slowly.
- **Tree view pages like the list** — the tree draws the loaded entries only; a lane whose fork point is on a page not loaded yet runs to the bottom until "Load more" loads it.
