---
description: "The DreamVerse profile layer: the render mode providers, the components, the chat references, the API, the interface plugins, the video-directing skill, and the model routes, stacked on dsh-base and dsh-web-app or dsh-headless."
kind: "package-bundle"
---

# @dv/bundle

English | [中文](README.zh.md)

## Summary

Use this bundle to run DreamVerse as a `dsh` profile. It inserts the render mode providers (the `t2va` row only when `DV_T2VA_BACKEND_URL` is set), the DreamVerse components with `@dv/ffmpeg`, the chat references, the API and the `@dv/ui-*` interface plugins; ships the `video-directing` skill, which both `skill-filesystem` rows read; declares the `deepseek-local` route to the cluster's SGLang server; and selects the agent model from the environment. `scripts/video-harness/setup-profile.sh` stacks it on `dsh-base` plus `dsh-web-app` as profile `video-harness` and on `dsh-base` plus `dsh-headless` as `video-harness-headless`; `scripts/video-harness/launch.sh web|headless` runs either from source.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

```sh
scripts/video-harness/launch.sh web --trusted-host <public host>   # chat page on DV_PORT (default 8092)
scripts/video-harness/launch.sh headless "给我一个这个人跳舞的视频" --session-id demo   # one task, printed result
```

Environment the patch reads: `DV_BACKEND_URL` (the `ref2va` backend; default `http://127.0.0.1:8029`), `DV_T2VA_BACKEND_URL` (the `t2va` backend; unset, the `dv-fasth3-t2va` row is disabled and the agent has no `dv_shot_render_t2va` tool), `DV_STATE_ROOT` (default `~/.local/state/dv`; holds `assets`, `projects`, `sessions`, and the view state that `@dv/api` keeps, which the patch passes to it as its `stateRoot`), `DV_FFMPEG`, `DV_FFPROBE`, `DV_PUBLIC_URL` (origin for asset links in chat cards), `DV_AGENT_PROVIDER` and `DV_AGENT_MODEL` (default `deepseek-local` / `deepseek-v4.1`; fallback `groq` / `qwen/qwen3.8-27b`), `DV_AGENT_REASONING` (default `low`), `DV_DEEPSEEK_BASE_URL` (the OpenAI-compatible SGLang endpoint; the launch script defaults it to `http://10.244.6.153:30000/v1`), `DV_DEEPSEEK_API_KEY` (the launch script exports `none` for the keyless server, because pi-ai's OpenAI route insists on a bearer token), `DV_AGENT_VISION` (`0` makes `inspect.image` report that images are unsupported instead of calling the model), and the fallback key `GROQ_API_KEY`, which the launch script sources from `DV_ENV_FILE`.

<a id="understand-the-implementation"></a>
## Understand the implementation

[`cordis.patch.yml`](cordis.patch.yml) has one `insert` list for the DreamVerse rows and three overrides: `skill-filesystem` (the skills directory, which holds `video-directing`; the model prompt skills and `timeline-editing` are registered by their own plugins through `ctx.skills`), `llm-pi-ai` (the hand-declared `deepseek-local` route: `openai-completions` at `DV_DEEPSEEK_BASE_URL` with one model `deepseek-v4.1` declared as text and image input, plus the Groq route), and `agent-default-model` (provider, model, and reasoning effort from the environment). No web server row is included: the web profile takes its page from `dsh-web-app`, and `dvAssetPool` registers `/dv/assets` on that server. [`tests/composition.spec.ts`](tests/composition.spec.ts) boots the render mode provider rows (each loading a fake provider of its render mode), the component rows, the `dv-chat-references` row and the `dv-api` row of the patch, with their `!!js` configuration and `disabled` flags, through the Loader, checks that the disabled `t2va` row leaves no `dv_shot_render_t2va` tool, and turns a model tool call into a record.

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse packages](../../../docs/subsystems/video-harness.md)
- [`@dv/chat-references`](../../dv/chat-references/README.md)
- [`@dv/api`](../../dv/api/README.md)

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tools, the `dv:project` prompt section of `@dv/project`, the mention context of `@dv/chat-references`, and the skills the bundle mounts; the bundle itself adds no model-visible text.

#### KV Cache effect

None of its own; the mounted plugins describe theirs.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The ffmpeg default path is this host's native build; other machines must set `DV_FFMPEG`.
- The `deepseek-local` route's image support is declared, not verified by the harness; set `DV_AGENT_VISION=0` for a text-only server, otherwise `read_image` fails at run time.
- The SGLang server accepts any `model` string, so the catalog id `deepseek-v4.1` is sent as-is; its `/v1/models` listing names `deepseek-ai/DeepSeek-V4.1-Flash`.
