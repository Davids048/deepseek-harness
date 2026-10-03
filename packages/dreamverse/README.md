---
description: "The dreamverse package group: the DreamVerse and Multiverse harness packages, the shared project layer, and the generation backend client, for readers choosing or navigating the family."
kind: "package-group"
---

# dreamverse/ — DreamVerse on DeepSeek Harness

English | [中文](README.zh.md)

## Summary

These packages run DreamVerse, an interactive video-story application, inside DeepSeek Harness. A user creates a project from a prompt and reference images, directs it segment by segment, and reopens it later; the harness enhances prompts, asks a FastVideo backend for each video segment, and stores every project and file. The shared project layer (file store, project store, segment generation) serves every workload, and the Multiverse prototype reuses it for branching stories. The page lives in [`../dreamverse-ui/`](../dreamverse-ui/README.md).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The [DreamVerse subsystem page](../../docs/subsystems/dreamverse.md) explains how these packages fit together.

| Package | Role |
| --- | --- |
| [`assets-manager`](assets-manager/README.md) | The file store: library uploads, every project file, and the `/assets` routes |
| [`project-store`](project-store/README.md) | Project records of every workload, write leases, and the `/projects` routes |
| [`segment-generation`](segment-generation/README.md) | Generates one segment for any workload and stores its video and last frame; holds the shared generation rules |
| [`generation-client`](generation-client/README.md) | Client for the FastVideo generation backend API |
| [`prompt-enhancer`](prompt-enhancer/README.md) | Turns user ideas into complete video prompts through Cerebras and Groq |
| [`project`](project/README.md) | DreamVerse projects: state, action admission, generation plans, and the project log |
| [`user-actions`](user-actions/README.md) | One plugin per DreamVerse user action |
| [`project-controller`](project-controller/README.md) | The `/ws` project protocol, the health and capability routes, and the page's protocol modules |
| [`multiverse`](multiverse/README.md) | The Multiverse prototype: branching stories as projects of kind `multiverse` |
| [`http-routes`](http-routes/README.md) | Starlette-compatible responses and route dispatch for the DreamVerse HTTP routes |

<a id="related-documentation"></a>
## Related documentation

- [DreamVerse subsystem](../../docs/subsystems/dreamverse.md) — process layout, the shared project layer, workloads, and the differences from the Python reference.
- [`dreamverse-ui/`](../dreamverse-ui/README.md) — the DreamVerse and Multiverse pages.
- [`@dreamverse/bundle`](../bundle/dreamverse/README.md) — the `dreamverse` profile layer.
- [`@dreamverse/multiverse-bundle`](../bundle/dreamverse-multiverse/README.md) — the `dreamverse-multiverse` profile layer.

<a id="dev-note"></a>
## Dev Note

None.
