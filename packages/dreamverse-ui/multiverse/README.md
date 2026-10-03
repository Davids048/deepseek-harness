---
description: "The DreamVerse Multiverse page as a DSH browser plugin: create a branching story, play your own world line full screen with choices at the end of each scene, and inspect every world line in dev mode."
kind: "package-reference"
---

# @dreamverse/ui-multiverse

English | [中文](README.zh.md)

## Summary

This package is the page of the `dreamverse-multiverse` profile. The user starts a story in the DreamVerse creation studio and then plays it full screen: when a scene ends, its two continuations appear as buttons, and choosing one generates the next scene while the screen holds the last frame. The player sees only their own world line and never goes back. Dev mode draws every world line horizontally and can generate any proposed branch. The page URL reopens a multiverse after a harness restart.

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

Mount the plugin with `@dreamverse/ui-creation` and `@dreamverse/ui-assets`, which fill its slots, and with `@dreamverse/multiverse`, which serves its API. The [`@dreamverse/multiverse-bundle`](../../bundle/dreamverse-multiverse/README.md) patch mounts all of them.

### Minimal configuration

```yaml
- id: multiverse-ui
  name: '@dreamverse/ui-multiverse'
```

The browser half fills the shell's `root` slot with the Multiverse page and declares two of the DreamVerse page slots, `dreamverse.creation-studio` and `dreamverse.asset-library`. It installs the same absent `session` scope as `@dreamverse/ui-kit` and bundles the kit's Tailwind stylesheet, header, and button, without mounting the kit. It registers the page's Chinese and English copy, including the labels of the kit header that it renders, as the `dreamverse.multiverse` locale namespace and declares that namespace on the `root` registration, so the profile must mount `@deepseek-ai/dsh-client-locale`, which provides the `locale` service. The page shows its copy in the page's active language; node labels and directions, scene errors, and server error messages stay verbatim. The Host half registers nothing, so the profile serves no `/logo.svg` or icons.

### Page modes

- **Creation** — `MultiverseApp` loads the creation capabilities from `/multiverse/api/capabilities`, uploads the attached references to the library with `resolveReferenceAssetIds`, and creates the multiverse with `buildCreationInitPayload` plus the prompt. The harness copies the selected library images into the multiverse's project.
- **Player mode** — `PlayerView`, the default, plays the player's current scene full screen. When the scene has played to the end, its branches appear as translucent buttons at the bottom of the frame; choosing one generates it while the screen holds the previous scene's last frame, then the new scene plays.
- **Dev mode** — the selected scene plays above `WorldLines`, which draws every world line with time running left to right. The player's world line runs straight along the top lane and is drawn solid; every other world line keeps its lane through each scene's first branch, and every other branch opens a lane below. A Choose button generates any proposed branch, and dev mode selects each scene that finishes generating.

The page URL keeps the multiverse (`multiverse`), the player's current scene (`node`), and dev mode (`dev=1`).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page reads `GET /multiverse/api/multiverses/<id>` once a second instead of the server-sent `events` route, because a Cloudflare quick tunnel holds back that route's body until the response ends. While a scene plays, the page loads the scene's last frame in a hidden image, so the frame that it holds during the next generation shows at once.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | Document settings, the `session` scope, the dictionary registration, and the `root` registration |
| [`src/client/locales.ts`](src/client/locales.ts) | The `zh` and `en` dictionaries of the `dreamverse.multiverse` namespace |
| [`src/client/MultiverseApp.tsx`](src/client/MultiverseApp.tsx) | Creation, the URL state, and the mode switch |
| [`src/client/PlayerView.tsx`](src/client/PlayerView.tsx) | Player mode |
| [`src/client/WorldLines.tsx`](src/client/WorldLines.tsx) | The dev-mode world lines |
| [`src/client/api.ts`](src/client/api.ts) | The `/multiverse/api` client, the polling, the display text of failed calls, and the page's `NodeId`, which brands each response's node IDs with the host type's label |

The `tests/` directory covers the page and the plugin registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dreamverse/multiverse`](../../dreamverse/multiverse/README.md) — the API, the tree, and the branch proposals.
- [`@dreamverse/ui-creation`](../creation/README.md) and [`@dreamverse/ui-assets`](../assets/README.md) — the reused DreamVerse page packages.
- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the Multiverse workload.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dreamverse/multiverse`, which turns the opening prompt and the branches that the user chooses here into prompt-enhancement, branch-proposal, and segment requests.

#### KV Cache effect

None; the page adds nothing to a model request beyond the user's own input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No logo or icons** — the profile serves no `/logo.svg` or `/icon-simple.svg`, so the header's logo image does not load and the tab has no DreamVerse icon.
- **Playback after generation** — a scene plays only after it finishes generating; the page has no progressive playback.
- **Polling** — the page reads the whole multiverse once a second while it is open.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
