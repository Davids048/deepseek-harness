---
description: "The DreamVerse asset library dialog as a DSH browser plugin: browse, upload, preview, delete, and select library images, video, and audio."
kind: "package-reference"
---

# @dreamverse/ui-assets

English | [中文](README.zh.md)

## Summary

This package draws the DreamVerse asset library dialog. The user browses the library, uploads images, video, and audio within the harness's upload policy, previews and deletes files, and selects an image as a reference for the next generation. The dialog works on library files only; files that belong to projects stay out of it.

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

Mount the plugin with `@dreamverse/ui-kit`, which declares its slot on the DreamVerse page.

### Minimal configuration

```yaml
- id: dreamverse-ui-assets
  name: '@dreamverse/ui-assets'
```

The browser half fills `dreamverse.asset-library` with `AssetLibrary`, the port of the frontend's `components/assets/AssetLibrary.tsx`, while the page declares the slot. It also registers the dialog's Chinese and English copy as the `dreamverse.assets` locale namespace, so the profile must mount `@deepseek-ai/dsh-client-locale`, which provides the `locale` service; the dialog shows its copy in the page's active language, and file names and server error messages stay verbatim. The Host half registers nothing. The dialog lists, uploads, and deletes files through the `/assets` routes with `@dreamverse/assets-manager/client/assets.ts`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`AssetLibrary` refreshes the list each time it opens and shares the page's cached list through `onAssetsChange`, so a change that the user makes while a refresh runs wins over the refresh.

| File | Content |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | The dictionary and slot registrations |
| [`src/client/locales.ts`](src/client/locales.ts) | The `zh` and `en` dictionaries of the `dreamverse.assets` namespace |
| [`src/client/components/assets/AssetLibrary.tsx`](src/client/components/assets/AssetLibrary.tsx) | The asset library dialog |

The `tests/` directory covers the dialog.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dreamverse/assets-manager`](../../dreamverse/assets-manager/README.md) — the file store, its upload policy, and the `/assets` routes.
- [`@dreamverse/ui-creation`](../creation/README.md) — the reference picker that opens the dialog.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dreamverse/segment-generation`, which sends the project's copies of the library images that the user selects here to the video model as request images.

#### KV Cache effect

None; the dialog adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Library files only** — the dialog cannot show or delete a project's files; the harness deletes them with their project.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
