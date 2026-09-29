# dreamverse-ui/ — the DreamVerse page

This package group is the DreamVerse page: a port of the FastVideo DreamVerse Next.js frontend (`apps/dreamverse/web/src/` in the FastVideo checkout) as DSH browser plugins. The harness serves the page on `DREAMVERSE_BROWSER_PORT`, and the page talks to the harness through the same `/ws` protocol and HTTP routes that the Next.js frontend used ([`../dreamverse/`](../dreamverse/README.md)). The page keeps the frontend's own components, Tailwind theme, and layout. It loads no DSH UI component package (`ui-primitives`, `ui-theme`, `ui-layout`) and no DSH agent chat UI.

## Page composition

```
DSH page shell (@deepseek-ai/dsh-web-app), loads /plugins/<id>/client.js through @deepseek-ai/dsh-client-modules
  @deepseek-ai/dsh-client-ui-renderer    mounts the `root` slot
    @dreamverse/ui-kit                   `root` occupant: DreamverseApp, Header, Toaster, stylesheet
      dreamverse.sidebar          <- @dreamverse/ui-project-history   Sidebar
      dreamverse.asset-library    <- @dreamverse/ui-assets            AssetLibrary
      dreamverse.player           <- @dreamverse/ui-player            VideoPlayer
      dreamverse.workspace        <- @dreamverse/ui-directing         Workspace
      dreamverse.creation-studio  <- @dreamverse/ui-creation          CreationStudio
      dreamverse.chatbar          <- @dreamverse/ui-creation          ChatBar
```

`@dreamverse/ui-kit` registers `root` with six child slots (`DREAMVERSE_SLOTS` in `kit/src/client/contracts.ts`). `DreamverseApp` (the port of `app/page.tsx`) renders each child through `renderSlot(name, props)` with the props that the frontend's page passed to that component (`DreamverseSlotOwners`). Each occupant package registers its component into its slot while the kit declares that slot (`ctx.slots.inject`). The renderer wraps `root` in a `session-maybe` scope, so the kit installs a `session` scope adapter whose binding is always absent; DreamVerse has no DSH Sessions.

The page's protocol and state code are the frontend's React-free modules in `packages/dreamverse/project-controller/src/client/` (`ws/`, `stores/`, creation configuration, project storage) and `packages/dreamverse/assets-manager/src/client/assets.ts`. The page imports them as `@dreamverse/project-controller/client/<path>.ts` and `@dreamverse/assets-manager/client/assets.ts`.

## Packages

| Package           | Slots                                              | Port of (FastVideo `apps/dreamverse/web/src/`)                                                                                                                                                               |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kit`             | `root`                                             | `app/page.tsx`, the page settings of `app/layout.tsx`, `app/globals.css`, `components/ui/`, `components/Header.tsx`, `components/assets/AssetPreview.tsx`, `hooks/useStore.ts`, `lib/media/`, `lib/utils.ts` |
| `creation`        | `dreamverse.creation-studio`, `dreamverse.chatbar` | `components/creation/`, `components/ChatBar.tsx`, `HeroTagline.tsx`, `LeaveProjectModal.tsx`, `components/assets/{ReferencePicker,ReferenceImageGrid,AssetPreviewDialog}.tsx`                                |
| `player`          | `dreamverse.player`                                | `components/VideoPlayer.tsx`                                                                                                                                                                                 |
| `directing`       | `dreamverse.workspace`                             | `components/Workspace.tsx`                                                                                                                                                                                   |
| `assets`          | `dreamverse.asset-library`                         | `components/assets/AssetLibrary.tsx`                                                                                                                                                                         |
| `project-history` | `dreamverse.sidebar`                               | `components/Sidebar.tsx`                                                                                                                                                                                     |

The Host half of `@dreamverse/ui-kit` (`kit/src/index.ts`) serves the frontend's `/logo.svg`, `/k2.png`, and `/icon-simple.svg` from `kit/public/` on the DSH web server. The bundle patch `packages/bundle/dreamverse/cordis.patch.yml` mounts all six packages.

## Build

`pnpm run build:lib:client` builds every browser bundle (`tsc -b tsconfig.client.json`, then `tsdown`) through `clientBundle` in `packages/client/tsdown.client.ts`. Restart the harness to serve rebuilt bundles. Before bundling, `kit/tsdown.config.ts` runs Tailwind CSS 4 (`@tailwindcss/postcss`) over `kit/src/client/styles/app.css` and writes the git-ignored `app.generated.css` that the kit bundle imports. Tailwind generates utilities for the class names in every `packages/dreamverse-ui/*/src/client/` file.

The packages follow the repository's compiler options and lint rules; the port matches the frontend in behavior, not in source text. `scripts/verify-client-ui-i18n.ts` skips this group because the page keeps the frontend's English copy.

## Test

```sh
node node_modules/vitest/vitest.mjs run packages/dreamverse-ui
```

The repository's `vitest` run includes these `*.client.spec.{ts,tsx}` files, and `tsconfig.client.json` typechecks them. Each spec runs in jsdom and first imports `kit/tests/support/setup.client.ts`, the port of the frontend's test setup. The tests are ports of the frontend's component tests and page tests (`kit/tests/app/`) without the cases of the features that the page omits. Page tests render `DreamverseApp` with `kit/tests/support/renderDreamverseSlot.client.tsx`, which renders each slot with its real occupant component.

## Differences from the FastVideo frontend

- The page omits the developer tools (`NEXT_PUBLIC_INCLUDE_DEVTOOLS`), the rewrite inspector, the monitor page, the LoRA controls, and voice input (the microphone button). Demo mode (`?demo=1`) works as in the frontend.
- The first visit opens the `dsh web:` token URL that the harness prints at startup; the page then sets a cookie. That visit redirects to `/` without the other query parameters, so demo mode needs a second visit to `/?demo=1`.
- Images are plain `<img>` elements, so the K2 logo shows the original PNG instead of the Next.js image optimizer's downsampled copy.
- The frontend's stylesheet imports IBM Plex from Google Fonts after the `@font-face` rules of `next/font`, so browsers ignore that import and render system fonts. The page omits the import and renders the same system fonts.

## Known Limitations and Deferred Work

- Each package bundles its own copy of the libraries it imports; only React and Cordis are shared through the DSH platform modules. `@carbon/icons-react` is not tree-shaken, so every bundle that imports a Carbon icon holds the whole icon library (`@dreamverse/ui-player` is 3.9 MB), and the web server sends bundles uncompressed (`compression: none`).
- The project stores in `packages/dreamverse/project-controller/src/client/stores/` keep the frontend's developer-tools state and operations (editable prompt drafts, curated prompt limits, prompt editor flags), which the page never enables.
