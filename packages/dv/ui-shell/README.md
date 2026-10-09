---
description: "The DreamVerse shell over the DSH web app: the entry page and the project workspace (canvas or timeline) in the center, the project navigator in the left sidebar, and the 对话 / 轨迹 tabs in the right panel."
kind: "package-reference"
---

# @dv/ui-shell

English | [中文](README.zh.md)

## Summary

Use this package to turn the DSH web app into DreamVerse. With no project open, the center shows the entry page: the chat composer and recent projects. With a project open, it shows the canvas or the timeline editor, switched by 画布 | 时间线 / Canvas | Timeline in the top bar. The left sidebar shows the navigator: 新建项目 / Create project, 首页 / Home, and the project → chat session tree. The right panel gets the 对话 / Chat and 轨迹 / Trajectory tabs. Outside text fields, Ctrl+Z (Cmd+Z on macOS) moves the open project one step back and Shift+Ctrl+Z (Shift+Cmd+Z) one step forward; these keys move the current position of the history list and write no record.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that stacks `dsh-web-app` (which provides the sidebars, the session and Workspace services, and the client module loader) and `@dv/api` (which serves the routes the shell calls). Mount `@dv/ui-asset-pool` and `@dv/ui-history` too: the right-panel button and the right-panel guide open their tabs. Build the browser bundle first: `pnpm run build` writes `lib/client.js`.

```yaml
- id: dv-ui-shell
  name: '@dv/ui-shell'
```

The Host half registers nothing. The browser half registers the center, the navigator, and the brand name DreamVerse at priority -1 over DSH's entries, the `dv-chat` and `dv-trajectory` tab types with their tab bodies, and the right-panel guide that offers 对话, 素材库, 历史, and 轨迹. It also hides DSH chrome that DreamVerse does not use (the welcome notice, the sidebar's brand mark, New Session button and Plugins entry, the composer statistics, the context meter, and the host slash commands) rewords a few DSH strings, and shows the DreamVerse icon in the browser tab in place of DSH's. The workspace top bar also shows the project name (a double-click renames it), the chat session title, and the right-panel button (the right sidebar's panel icon, labelled 打开右侧面板 / Open the right panel), shown only while the right panel is collapsed, in the corner where the panel's own collapse control sits while it is shown, and which opens 对话, 素材库, and 轨迹; the entry page shows the headline 今天想做一个什么视频？ / What video do you want to make? and up to eight recent projects. The URL hash has the form `#project=<id>&view=timeline&timeline=t2&session=<id>`, so a reload, Back, and Forward restore the location.

| Gesture | Request or event |
| --- | --- |
| Page load, then every 4 seconds | `GET /api/dv/workspaces` for the projects, their Workspaces, and the session bindings |
| 新建项目 / Create project | `POST /api/dv/projects` with the first free title 未命名项目 / Untitled project (numbered), then `POST /api/dv/workspaces` to link the Workspace created for it; a blank chat session opens in it |
| Open a project (navigator row or recent project card) | `GET /api/dv/workspaces/sessions` for its stored chat sessions; the main session moves to its latest non-blank chat session, else to a blank one |
| ＋ on a project row, or DSH's New Session | a blank chat session in the project's Workspace; on the entry page, DSH's New Session equals 首页 |
| Rename a project (double-click the name or the row menu) | `POST /api/dv/projects/rename`; the project's Workspace is renamed to match |
| Delete a project (row menu, then the confirmation) | `POST /api/dv/projects/delete` (the project moves to the trash directory); the linked Workspace is deleted and an open project returns to 首页 |
| Rename or delete a chat session (row menu) | DSH's session rename, or archive with its activity stopped |
| A main session that sits in a project's Workspace without a binding | `POST /api/dv/workspaces/bind` |
| 插入片段 / Insert clip in the 素材库 panel (`dv:timeline-insert` `{assetId}`) | `POST /api/dv/operation` with `timeline.clip_insert` at the end of the selected timeline (else the first one), or `timeline.create` of `t1` holding the clip when the current state has no timeline, `surface: 'timeline'`; then the timeline view shows |
| `dv:canvas-focus` | the canvas view shows |
| `dv:timeline-focus` `{timelineId, clipId}` | the timeline is selected and the timeline view shows |
| `dv:trajectory-focus` `{session, toolCall}` | the main session moves to `session`, then 轨迹 opens scrolled to that tool call |

The workspace sends the chat session to the canvas and the timeline editor only while the main session belongs to the open project; until then their edits carry no chat session. Every change of the open project is published as `dv:current-project` for the other DreamVerse bundles.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`CenterPanel` restores the URL location once the project links and DSH's session and Workspace lists are ready, after DSH's own startup restore of its last session (or 4 seconds without one), because DSH's late restore would replace the session the shell opened. Afterwards it adopts the project of a main session that moves to another project by itself, such as the entry chat that the agent binds to a project it created. A project's chat sessions are the sessions of its Workspace, the sessions bound to it, and the sessions the server stores under its directory; a session bound to another project belongs to that project. Each browser tab keeps its own blank chat session per Workspace in `sessionStorage`, because DSH's `openWorkspace` reuses any blank session and two tabs would share one chat. The entry Workspace (the directory that holds chats started before a project exists, titled DreamVerse) replaces DSH's first-use default Workspace. Closing 轨迹 remounts the 对话 tab's chat, because the hidden composer of 轨迹 unbinds the session's composer editor when it unmounts.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The Host half, which registers nothing |
| [`src/css-modules.d.ts`](src/css-modules.d.ts) | The type of the CSS Module imports |
| [`src/client/index.ts`](src/client/index.ts) | Registrations, the New Session and first-use default Workspace overrides, the links poll, and the `dv:trajectory-focus` listener |
| [`src/client/actions.ts`](src/client/actions.ts) | `ShellActions`: create, open, rename, and delete projects and chat sessions, the entry page, and the right-panel tabs |
| [`src/client/store.ts`](src/client/store.ts) | The shared state (open project, view, timeline, main session, links), the URL hash mirror, and the session → project lookup |
| [`src/client/Center.tsx`](src/client/Center.tsx) | The center: URL restore, the entry page, recent projects, the workspace top bar, the views, and the window event listeners |
| [`src/client/Navigator.tsx`](src/client/Navigator.tsx) | The left navigator and the brand name |
| [`src/client/tabs.tsx`](src/client/tabs.tsx) | The 对话 and 轨迹 tab types and bodies |
| [`src/client/undo-keys.ts`](src/client/undo-keys.ts) | `historyKey` and `listenHistoryKeys`: the window listener that calls `/api/dv/undo` on Ctrl+Z (Cmd+Z) and `/api/dv/redo` on Shift+Ctrl+Z (Shift+Cmd+Z) |
| [`src/client/chrome.tsx`](src/client/chrome.tsx) | Hidden and reworded DSH chrome, the right-panel guide, and tab titles that follow the interface language |
| [`src/client/InlineRename.tsx`](src/client/InlineRename.tsx) | The inline title field and the ⋯ row menu |
| [`src/client/views.ts`](src/client/views.ts) | The canvas and timeline views, imported from their packages' sources into this bundle |
| [`src/client/shell.module.css`](src/client/shell.module.css) | Styles of the center, the navigator, and the tabs |
| [`src/client/chrome.module.css`](src/client/chrome.module.css) | Styles of the right-panel guide |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/api`](../api/README.md) — the project, Workspace, binding, and operation routes.
- [`@dv/ui-canvas`](../ui-canvas/README.md) — the canvas the center shows.
- [`@dv/ui-timeline`](../ui-timeline/README.md) — the timeline editor the center shows.
- [`@dv/ui-history`](../ui-history/README.md) — the History tab and the `dv:trajectory-focus` link.
- [`@dv/ui-kit`](../ui-kit/README.md) — the API client, the wire types, the window events, and the current project and timeline.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dv/project`; the session bindings the shell saves and the records its 插入片段 / Insert clip writes reach the model only through the `dv:project` prompt section and the `dv_proj_*` and operation tools of [`@dv/project`](../project/README.md).

#### KV Cache effect

None; the shell sends nothing to a model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Hidden DSH chrome depends on DSH internals** — the shell finds the hidden controls by CSS Module class name suffixes and accessible labels, rewrites DSH dictionary entries and the host command fetcher through private fields, and replaces `uiWorkspace.startSession` and `workspaces.initializeDefault` on the services; a DSH change to any of them shows the chrome again or breaks the override without an error.
- **Links poll** — projects and bindings that the agent creates appear in the navigator up to 4 seconds later.
