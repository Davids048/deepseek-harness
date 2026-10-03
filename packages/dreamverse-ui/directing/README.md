---
description: "The DreamVerse prompt timeline as a DSH browser plugin: the original prompt, each rewrite and continuation event, and selection of the clip that each entry produced."
kind: "package-reference"
---

# @dreamverse/ui-directing

English | [中文](README.zh.md)

## Summary

This package draws the prompt timeline of the shown DreamVerse project. The user sees the original prompt and every later rewrite and continuation in order, and selects an entry to play the clip that it produced. The timeline renders what the page passes it and sends nothing to the harness itself.

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
- id: dreamverse-ui-directing
  name: '@dreamverse/ui-directing'
```

The browser half fills `dreamverse.workspace` with `Workspace`, the port of the frontend's `components/Workspace.tsx`, while the kit declares the slot. It also registers the timeline's Chinese and English copy as the `dreamverse.directing` locale namespace, so the profile must mount `@deepseek-ai/dsh-client-locale`, which provides the `locale` service; the timeline shows its badges in the page's active language, and prompt text stays verbatim. The Host half registers nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`Workspace` renders the `PromptEvent` list of `@dreamverse/project-controller/client/promptEvents.ts` that the page passes as `WorkspaceProps`, and reports selections through the `onSelectOriginal`, `onSelectEvent`, and `onSelectCurrent` callbacks.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | The dictionary and slot registrations |
| [`src/client/locales.ts`](src/client/locales.ts) | The `zh` and `en` dictionaries of the `dreamverse.directing` namespace |
| [`src/client/components/Workspace.tsx`](src/client/components/Workspace.tsx) | The prompt timeline |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dreamverse/ui-kit`](../kit/README.md) — the page that builds the prompt events.
- [`@dreamverse/project-controller`](../../dreamverse/project-controller/README.md) — the prompt event module.

-----

<a id="model-experience"></a>
## Model Experience

None, as the timeline only displays prompt events that the page receives.

#### KV Cache effect

None; the timeline adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No package tests** — the package has no `tests/` directory; the kit's page tests render the timeline as the real `dreamverse.workspace` occupant.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
