---
description: "The DreamVerse project history as a DSH browser plugin: the current project, the stored projects that the harness lists, opening a stored project, deleting one, and starting a new one."
kind: "package-reference"
---

# @dreamverse/ui-project-history

English | [中文](README.zh.md)

## Summary

This package draws the DreamVerse project sidebar. The user sees the current project and the stored projects, newest update first, opens a stored project to continue it, deletes a project, or starts a new one. The harness owns every project, so the list is the same in every browser. The sidebar renders what the page passes it; the page reads and changes the projects through the `/projects` routes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with `@dreamverse/ui-kit`, which declares its slot.

### Minimal configuration

```yaml
- id: dreamverse-ui-project-history
  name: '@dreamverse/ui-project-history'
```

The browser half fills `dreamverse.sidebar` with `Sidebar`, the port of the frontend's `components/Sidebar.tsx`, while the kit declares the slot. The Host half registers nothing. The page fills the list from `GET /projects?kind=dreamverse`, opens a selected project through the `/ws` message `project_open_v1`, and deletes one through `DELETE /projects/<project_id>`; a refused deletion shows its reason in the sidebar.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`Sidebar` receives the project list, the current project, and the open, delete, and new-project callbacks as `SidebarProps`. It omits the current project from the history, because the Current entry shows it.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | The slot registration |
| [`src/client/components/Sidebar.tsx`](src/client/components/Sidebar.tsx) | The project sidebar |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dreamverse/project-store`](../../dreamverse/project-store/README.md) — the `/projects` routes.
- [`@dreamverse/ui-kit`](../kit/README.md) — the page that reads and opens projects.

-----

<a id="model-experience"></a>
## Model Experience

None, as the sidebar only lists, opens, and deletes stored projects.

#### KV Cache effect

None; the sidebar adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **DreamVerse projects only** — the list holds projects of kind `dreamverse` and omits projects of every other kind.
- **No package tests** — the package has no `tests/` directory; the kit's page tests render the sidebar as the real `dreamverse.sidebar` occupant.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
