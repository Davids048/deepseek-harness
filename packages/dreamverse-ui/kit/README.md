---
description: "The DreamVerse page frame as a DSH browser plugin: the root slot and its child slots, the page component, shared UI components, the media playback pipeline, the Tailwind stylesheet, and the page's static images."
kind: "package-reference"
---

# @dreamverse/ui-kit

English | [中文](README.zh.md)

## Summary

This package draws the DreamVerse page frame in the DSH page shell. It fills the shell's `root` slot with the DreamVerse page and declares the six child slots that the other DreamVerse page packages fill, passing each the props that the FastVideo frontend passed to that component. It also ships the components, hooks, media pipeline, and Tailwind stylesheet that those packages share, and it serves the page's logo and icons. The page keeps the frontend's English copy and needs no DSH Session.

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

Mount the kit after `@deepseek-ai/dsh-client-ui-renderer`; the other DreamVerse page packages fill its slots.

### Minimal configuration

```yaml
- id: dreamverse-ui-kit
  name: '@dreamverse/ui-kit'
```

The browser half registers `root` with the child slots `dreamverse.sidebar`, `dreamverse.asset-library`, `dreamverse.player`, `dreamverse.workspace`, `dreamverse.creation-studio`, and `dreamverse.chatbar` (`DREAMVERSE_SLOTS` in `src/client/contracts.ts`). `DreamverseApp`, the port of the frontend's `app/page.tsx`, renders each child through `renderSlot(name, props)` with the props in `DreamverseSlotOwners`. The browser half also sets the document title and favicon, applies the stored dark theme, and installs a `session` scope adapter whose binding is always absent, because the renderer wraps `root` in a `session-maybe` scope and DreamVerse has no DSH Sessions.

The Host half serves `/logo.svg`, `/k2.png`, and `/icon-simple.svg` from `public/` on the DSH web server while one is available.

### Build and test

`pnpm run build:lib:client` builds every browser bundle. Before bundling, `tsdown.config.ts` runs Tailwind CSS 4 over `src/client/styles/app.css` and writes the git-ignored `app.generated.css`; Tailwind generates utilities for the class names in every `packages/dreamverse-ui/*/src/client/` file. A running harness serves the bundles that it loaded at start, so restart it after a rebuild.

```sh
node node_modules/vitest/vitest.mjs run packages/dreamverse-ui
```

Each `*.client.spec.{ts,tsx}` file runs in jsdom and first imports `tests/support/setup.client.ts`, the port of the frontend's test setup. The page tests in `tests/app/` render `DreamverseApp` with `tests/support/renderDreamverseSlot.client.tsx`, which renders each slot with its real occupant component.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`DreamverseApp` holds the page state that the frontend's page held: it reads the creation capabilities, opens and reopens project sockets through the modules of `@dreamverse/project-controller`, lists stored projects, and feeds the media pipeline. `src/client/media/` plays the streamed fMP4 chunks through `MediaSource` or `ManagedMediaSource`, archives them by segment, and assembles archived segments into one MP4 file for saved clips and downloads. The other packages import the shared components and helpers as `@dreamverse/ui-kit/<path>`.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The Host half: the static image routes |
| [`src/client/index.ts`](src/client/index.ts) | The browser half: document settings, the `session` scope, and the `root` registration |
| [`src/client/contracts.ts`](src/client/contracts.ts) | The child slots and their owner props |
| [`src/client/app/DreamverseApp.tsx`](src/client/app/DreamverseApp.tsx) | The page |
| [`src/client/components/`](src/client/components/) | `Header`, `AssetPreview`, and the `ui/` components |
| [`src/client/media/`](src/client/media/) | The fMP4 playback pipeline |
| [`src/client/styles/app.css`](src/client/styles/app.css) | The Tailwind source stylesheet |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dreamverse-ui/`](../README.md) — the packages that fill the kit's slots.
- [Slots subsystem](../../../docs/subsystems/slots.md) — slot owners, occupants, and scopes.
- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the differences from the FastVideo frontend.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dreamverse/project`, which turns the prompts and settings that the page sends in `project_init_v1` and later commands into prompt-enhancement and segment requests.

#### KV Cache effect

None; the page adds nothing to a model request beyond the user's own input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Large uncompressed bundles** — each package bundles its own copy of the libraries it imports; only React and Cordis are shared through the DSH platform modules. `@carbon/icons-react` is not tree-shaken, so every bundle that imports a Carbon icon holds the whole icon library, and the DreamVerse bundles set the web server's `compression` to `none`.
- **English only** — the page keeps the frontend's inline English copy, so `scripts/verify-client-ui-i18n.ts` skips `packages/dreamverse-ui/`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
