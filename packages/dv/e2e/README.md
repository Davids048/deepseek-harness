---
description: "Browser stories of DreamVerse: boot the shipped video-harness profile with a fake video backend and a scripted model, then drive the canvas, timeline, asset pool, History panel, chat, and navigation in Chromium through Playwright."
kind: "package-library"
---

# @dv/e2e

English | [中文](README.zh.md)

## Summary

Use this package to check DreamVerse pages the way a creator uses them. Each story boots the shipped `video-harness` profile with `dsh web`, a fake video backend, and a scripted model, opens Chromium through Playwright, performs user actions, and asserts what the screen, the `/api/dv` routes, and the model requests show afterwards. The stories cover the canvas, the timeline editor, the asset pool panel, the History panel, the chat, and navigation between projects, chat sessions, and panels. The package ships no plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Build the browser bundles of the `@dv/ui-*` packages first (`pnpm run build`), because `dsh web` serves their `lib/client.js` files. Then run the stories from the repository root with the package config, and select stories by name with `-t`:

```sh
DSH_PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome-linux/chrome \
  node_modules/.bin/vitest run --config packages/dv/e2e/vitest.e2e.config.ts -t "History panel"
```

| Variable | Meaning |
| --- | --- |
| `DSH_PLAYWRIGHT_EXECUTABLE_PATH` | The Chromium binary that Playwright launches; without it Playwright uses its own downloaded browser |
| `DV_FFMPEG` | The ffmpeg binary that the fake backend encodes videos with and that the profile's `@dv/ffmpeg` runs; it needs the `libvpx-vp9` encoder |
| `DV_E2E_SHOTS`, `DV_NAV_SHOTS` | A directory where a failed chat story or navigation story leaves screenshots of its pages |

| Story file | What the stories cover |
| --- | --- |
| [`tests/stories/canvas-timeline.e2e.ts`](tests/stories/canvas-timeline.e2e.ts) | Canvas fit, pan, zoom, and floating editors; takes and plan versions; timeline tabs, playback, split, trim, reorder, undo, and export; the working branch, discard confirmation, and stale marks |
| [`tests/stories/assets.e2e.ts`](tests/stories/assets.e2e.ts) | The asset pool panel: imports through the file chooser, the drop zone, and the chat; draft flags; previews; insertion into the timeline and the canvas |
| [`tests/stories/history.e2e.ts`](tests/stories/history.e2e.ts) | The History panel: row order, labels, marks, approval folds, filters, focus on the canvas or the timeline, and live updates |
| [`tests/stories/chat.e2e.ts`](tests/stories/chat.e2e.ts) | The chat and its composer: drafts across turns, confirmation in the conversation, attached images, `@` mentions, and what the model request received |
| [`tests/stories/navigation.e2e.ts`](tests/stories/navigation.e2e.ts) | Projects, chat sessions, panels, reloads, project links, browser history, and the language switch |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`bootHarness` in `tests/harness.ts` starts a fake streaming_v2 backend and the DSH mock LLM server in the test process, writes an isolated DSH home whose `video-harness` profile names `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and `@dv/bundle` (linked to this checkout), and spawns `apps/cli/src/bin.ts --profile video-harness` on a free port. It waits for the printed token URL, exchanges it for the session cookie, and returns a JSON client for the `/api/dv` routes that seeds projects without an agent. `close` stops the child and both servers and removes the scratch directory. The fake backend answers with tiny frames, so a render finishes in under a second; `playableVideos` makes it encode VP9 videos whose color follows the prompt, because the open-source Chromium build has no H.264 decoder. `startScriptedModel` in `tests/scripted-model.ts` is an OpenAI-compatible chat-completions server: the first rule whose `match` fits the newest user message supplies the reply, so one message can drive several tool calls in a row, and `requests` keeps every request for assertions.

| File | Content |
| --- | --- |
| [`tests/harness.ts`](tests/harness.ts) | `bootHarness`, `startFakeBackend`, `waitFor`, and the Playwright export |
| [`tests/scripted-model.ts`](tests/scripted-model.ts) | `startScriptedModel`, `textOf`, `assetIdOf` |
| [`tests/fake-backend-main.ts`](tests/fake-backend-main.ts) | Runs the fake backend as a long-lived process for manual browser testing |
| [`vitest.e2e.config.ts`](vitest.e2e.config.ts) | The story lane: one file at a time, 180-second test timeout |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/bundle`](../../bundle/dv/README.md) — the plugins that the `video-harness` profile mounts.
- [`@dv/api`](../api/README.md) — the routes that the harness client seeds projects through.
- [`@deepseek-ai/dsh-llm-mock-server`](../../test-support/llm-mock-server/README.md) — the default model server of `bootHarness`.

-----

<a id="model-experience"></a>
## Model Experience

None, as the stories only send requests to a scripted model, and the package ships no plugin, prompt, or tool.

#### KV Cache effect

None; no production model request includes anything from this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Machine-specific ffmpeg default** — without `DV_FFMPEG`, `tests/harness.ts` uses `/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg`; other machines must set the variable.
- **Root e2e glob** — the root `vitest.e2e.config.ts` also matches `tests/stories/*.e2e.ts`, with a 30-second hook timeout and parallel files, while booting `dsh web` may take up to 120 seconds; run the stories with the package config.
