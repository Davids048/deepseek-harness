---
description: "The dreamverse profile layer: mounts the DreamVerse harness packages, the DSH web rows, and the DreamVerse page over dsh-base, configured from the DreamVerse environment variables."
kind: "package-bundle"
---

# @dreamverse/bundle

English | [中文](README.zh.md)

## Summary

Stack this layer on `@deepseek-ai/dsh-base` to turn a DSH profile into the DreamVerse application: the page, the `/ws` project protocol, projects, user actions, prompt enhancement, the file store, and the generation backend client. Every row reads its settings from environment variables, so one profile serves any state directory and backend. `scripts/dreamverse/launch-harness.sh` creates the `dreamverse` profile and runs it from source. A missing required variable fails its plugin at load.

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

`scripts/dreamverse/setup-profile.sh` creates `$DSH_HOME/profiles/dreamverse` with a manifest whose `dsh.profile.bundles` is `["@deepseek-ai/dsh-base", "@dreamverse/bundle"]`, an empty profile patch (kept when it already exists), and a `node_modules` link to this package. `scripts/dreamverse/launch-harness.sh` runs that script and then `node --import tsx/esm apps/cli/src/bin.ts --profile dreamverse` from the checkout.

### Environment

| Variable | Rows | Meaning |
| --- | --- | --- |
| `DREAMVERSE_GENERATION_URL` | generation client | HTTP base URL of the generation backend; required |
| `FASTVIDEO_DREAMVERSE_HOME` | file store, project store, project log | State root; else `$XDG_STATE_HOME/fastvideo/dreamverse`, else `~/.local/state/fastvideo/dreamverse` |
| `FASTVIDEO_PROJECT_LOG_ROOT` | project | Project log directory; else `<state root>/outputs/project_logs` |
| `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `FASTVIDEO_PROMPT_*`, `CEREBRAS_BASE_URL` | prompt enhancer | Provider keys, models, endpoints, and template paths |
| `DREAMVERSE_BROWSER_HOST`, `DREAMVERSE_BROWSER_PORT` | web server | Listen address of the page; the host defaults to `127.0.0.1` |

### What you get

The file store uses `<state root>/assets` and the project store uses `<state root>/projects`. The web server serves the DreamVerse page at the `dsh web:` token URL that the harness prints at start, the `/ws` socket, and the `/assets`, `/projects`, health, readiness, and creation capability routes. The [`dreamverse/`](../../dreamverse/README.md) and [`dreamverse-ui/`](../../dreamverse-ui/README.md) package READMEs own the behavior of each row.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) is one `insert` list. It mounts the DreamVerse harness rows (generation client, file store, project store, segment generation, prompt enhancer, project, and the four user actions), then the DSH web rows: `@deepseek-ai/dsh-host-webserver` with `compression: none`, `@dreamverse/project-store/routes`, `@deepseek-ai/dsh-web-app` (the page shell as the web server's fallback route and the printed token URL), `@deepseek-ai/dsh-client-modules`, `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-api-remotes`, `@deepseek-ai/dsh-client-ui-settings` (the `configForms` service that the locale row requires), `@deepseek-ai/dsh-client-locale` (the page language and the dictionaries of the page rows), and `@deepseek-ai/dsh-client-ui-renderer`. The six `@dreamverse/ui-*` page rows and `@dreamverse/project-controller` come last. The web server sends no compressed responses, so route responses stay byte-identical to the reference.

| File | Content |
| --- | --- |
| [`cordis.patch.yml`](cordis.patch.yml) | The patch document |
| [`package.json`](package.json) | The `dsh.bundle.patch` declaration and the mounted packages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DreamVerse subsystem](../../../docs/subsystems/dreamverse.md) — the process layout that this layer composes.
- [Bundle package group](../README.md) — the other profile layers.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@dreamverse/prompt-enhancer` and `@dreamverse/segment-generation`, whose rows this layer mounts and configures; each mounted package owns its model-facing behavior.

#### KV Cache effect

None; the layer adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Shared state root without shared leases** — every harness process that runs the `dreamverse` profile uses `<state root>/assets` and `<state root>/projects`. Project leases and file retentions exist inside one harness process, so two processes that run at the same time over one state root can delete files or projects that the other process is using.
- **No compression** — the web server sends the page bundles uncompressed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
