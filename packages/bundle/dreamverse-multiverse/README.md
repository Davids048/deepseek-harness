---
description: "The dreamverse-multiverse profile layer: mounts the Multiverse prototype, the shared DreamVerse project layer, and the Multiverse page over dsh-base, and selects the branch-proposal model."
kind: "package-bundle"
---

# @dreamverse/multiverse-bundle

English | [中文](README.zh.md)

## Summary

Stack this layer on `@deepseek-ai/dsh-base` to run the Multiverse prototype: branching video stories with language-model branch proposals, the shared DreamVerse file store and project store, and the Multiverse page. The layer selects Groq `openai/gpt-oss-120b` as the profile's default model, so proposals need `GROQ_API_KEY`. `scripts/dreamverse/launch-multiverse.sh` creates the `dreamverse-multiverse` profile and runs it from source. A missing required variable fails its plugin at load.

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

### Install into a profile

`scripts/dreamverse/setup-multiverse-profile.sh` creates `$DSH_HOME/profiles/dreamverse-multiverse` with a manifest whose `dsh.profile.bundles` is `["@deepseek-ai/dsh-base", "@dreamverse/multiverse-bundle"]`, an empty profile patch (kept when it already exists), and a `node_modules` link to this package. `scripts/dreamverse/launch-multiverse.sh` runs that script and then the profile from source; `DSH_HOME` defaults to `$HOME/.local/state/dsh-multiverse`, and extra arguments go to `dsh`.

### Environment

| Variable | Rows | Meaning |
| --- | --- | --- |
| `DREAMVERSE_GENERATION_URL` | generation client | HTTP base URL of the generation backend; required |
| `FASTVIDEO_DREAMVERSE_HOME` | file store, project store, multiverse log | State root; else `$XDG_STATE_HOME/fastvideo/dreamverse`, else `~/.local/state/fastvideo/dreamverse` |
| `FASTVIDEO_MULTIVERSE_LOG_ROOT` | multiverse director | Multiverse log directory; else `<state root>/outputs/multiverse_logs` |
| `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `FASTVIDEO_PROMPT_*`, `CEREBRAS_BASE_URL` | prompt enhancer, `llm-pi-ai` | Provider keys, models, endpoints, and template paths |
| `MULTIVERSE_BROWSER_HOST`, `MULTIVERSE_BROWSER_PORT` | web server | Listen address of the page; the host defaults to `127.0.0.1` |

### What you get

The web server serves the Multiverse page at the printed `dsh web:` token URL and the `/multiverse/api`, `/assets`, and `/projects` routes. The file store and the project store use `<state root>/assets` and `<state root>/projects`, the same directories as the `dreamverse` profile. The [`@dreamverse/multiverse`](../../dreamverse/multiverse/README.md) and [`@dreamverse/ui-multiverse`](../../dreamverse-ui/multiverse/README.md) READMEs own the behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) has one `insert` list and two overrides. The insert list mounts the generation client, the file store, the project store, segment generation, the prompt enhancer, the three Multiverse entries, the DSH web rows with `compression: none` (including `@deepseek-ai/dsh-client-ui-settings` and `@deepseek-ai/dsh-client-locale`, which provide the page language and the dictionaries of the page rows), `@dreamverse/project-store/routes`, and the page rows `@dreamverse/ui-multiverse`, `@dreamverse/ui-creation`, and `@dreamverse/ui-assets`. The overrides give dsh-base's `llm-pi-ai` row the `cerebras` and `groq` providers, whose keys resolve per request from `CEREBRAS_API_KEY` and `GROQ_API_KEY`, and point dsh-base's `agent-default-model` row at provider `groq` and model `openai/gpt-oss-120b`.

| File | Content |
| --- | --- |
| [`cordis.patch.yml`](cordis.patch.yml) | The patch document |
| [`package.json`](package.json) | The `dsh.bundle.patch` declaration and the mounted packages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the Multiverse workload in the shared project layer.
- [`@dreamverse/bundle`](../dreamverse/README.md) — the DreamVerse profile layer over the same state root.
- [Bundle package group](../README.md) — the other profile layers.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dreamverse/multiverse` and `@dreamverse/prompt-enhancer`, whose rows this layer mounts; the `agent-default-model` override selects the model that receives branch proposals.

#### KV Cache effect

None; the layer adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Profile-wide model selection** — the `agent-default-model` override applies to every consumer of the default model selection in this profile, not only to branch proposals.
- **Shared state root without shared leases** — a `dreamverse` profile that runs at the same time over the same state root can delete a multiverse project or its files while this profile works on it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
