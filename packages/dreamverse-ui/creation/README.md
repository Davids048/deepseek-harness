---
description: "The DreamVerse creation studio and live composer as DSH browser plugins: creation settings, story presets, reference image selection, Auto Extension, and the Rewrite or Continue prompt action."
kind: "package-reference"
---

# @dreamverse/ui-creation

English | [中文](README.zh.md)

## Summary

This package draws the two places where a DreamVerse user writes prompts. The creation studio starts a project: the user types an idea or picks a story preset, chooses among the creation settings that the served model offers, attaches reference images, and turns Auto Extension on or off. The live composer directs a running project: each prompt either rewrites the sequence or continues from the last segment. The Multiverse page reuses the creation studio to start a multiverse.

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

Mount the plugin with a page that declares its slots: `@dreamverse/ui-kit` on the DreamVerse page, or `@dreamverse/ui-multiverse` on the Multiverse page.

### Minimal configuration

```yaml
- id: dreamverse-ui-creation
  name: '@dreamverse/ui-creation'
```

The browser half requires the `locale` service of `@deepseek-ai/dsh-client-locale`. It registers the Chinese and English dictionaries of the `dreamverse.creation` locale namespace, and it fills `dreamverse.creation-studio` with `CreationStudio` and `dreamverse.chatbar` with `ChatBar` while the page declares each slot. Both occupants render their copy from that namespace in the page's active language, including the mode, model, resolution, and duration names that `@dreamverse/project-controller` identifies by ID; preset labels, the served model's mode explanations, and the notices that the page passes in render as given. The Host half registers nothing.

The live composer's **Prompt action** selection (`LivePromptModePill`) offers **Rewrite**, the default, which sends `rewrite_seed_prompts`, and **Continue from the last segment**, which sends `append_prompt`. The choice is `projectControlsStore.livePromptRewriteMode`; demo mode hides the selection and always continues.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The components port the frontend's `components/creation/`, `components/ChatBar.tsx`, `HeroTagline.tsx`, `LeaveProjectModal.tsx`, and the reference picker components of `components/assets/`. They receive their data and callbacks as slot props from the page, and they read the creation configuration helpers of `@dreamverse/project-controller`.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | The dictionary and slot registrations |
| [`src/client/locales.ts`](src/client/locales.ts) | The `dreamverse.creation` Chinese and English dictionaries |
| [`src/client/creationChoiceText.ts`](src/client/creationChoiceText.ts) | Localized names of the creation modes, models, resolutions, and durations |
| [`src/client/components/creation/`](src/client/components/creation/) | `CreationStudio`, the composer, the setting pills, the preset rail, and the Prompt action selection |
| [`src/client/components/ChatBar.tsx`](src/client/components/ChatBar.tsx) | The live composer |
| [`src/client/components/assets/`](src/client/components/assets/) | Reference image selection and preview |

The `tests/` directory covers the composers, the preset rail, and the reference picker.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dreamverse/ui-kit`](../kit/README.md) — the page that passes the slot props.
- [`@dreamverse/user-actions`](../../dreamverse/user-actions/README.md) — what each submitted prompt does in the harness.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dreamverse/user-actions`, which turns the prompts and presets that the user submits here into prompt-enhancement and segment requests.

#### KV Cache effect

None; the components add nothing to a model request beyond the user's own input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **500-character live prompts** — the live composer accepts at most 500 characters per prompt, as the frontend does.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
