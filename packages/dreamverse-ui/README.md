---
description: "The dreamverse-ui package group: the DreamVerse page as DSH browser plugins, for readers choosing or navigating the family."
kind: "package-group"
---

# dreamverse-ui/ — the DreamVerse page

English | [中文](README.zh.md)

## Summary

These packages draw the DreamVerse page in the browser: the creation studio, the live composer, the video player, the prompt timeline, the asset library, and the project history. They port the FastVideo DreamVerse Next.js frontend to DSH browser plugins and keep its components, Tailwind theme, and layout; each package registers Chinese and English locale dictionaries for the copy that it renders. The page talks to the harness through the `/ws` protocol and the HTTP routes of [`../dreamverse/`](../dreamverse/README.md).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

`@dreamverse/ui-kit` fills the shell's `root` slot and declares the page's child slots; each other package fills one or two of them.

| Package | Slots | Role |
| --- | --- | --- |
| [`kit`](kit/README.md) | `root` | The page frame, its shared components, its stylesheet, and its static images |
| [`creation`](creation/README.md) | `dreamverse.creation-studio`, `dreamverse.chatbar` | Project creation and the live directing composer |
| [`player`](player/README.md) | `dreamverse.player` | Live and archived playback |
| [`directing`](directing/README.md) | `dreamverse.workspace` | The prompt event timeline of the shown project |
| [`assets`](assets/README.md) | `dreamverse.asset-library` | The asset library dialog |
| [`project-history`](project-history/README.md) | `dreamverse.sidebar` | The stored project list |

<a id="related-documentation"></a>
## Related documentation

- [DreamVerse subsystem](../../docs/subsystems/dreamverse.md) — process layout, workloads, and the differences from the FastVideo frontend.
- [`dreamverse/`](../dreamverse/README.md) — the harness packages that the page talks to.
- [Slots subsystem](../../docs/subsystems/slots.md) — how slot owners and occupants compose the page.

<a id="dev-note"></a>
## Dev Note

None.
