---
description: "Project component of DreamVerse: the dvProject service that stores every project's records, branches and drafts, runs operations, and computes state and history."
kind: "package-reference"
---

# @dv/project

English | [中文](README.zh.md)

## Summary

Use this package to change and read DreamVerse projects. Every change is a record written by `dvProject.run` (component operations) or by a `proj.*` method (drafts, undo, redo, branches). Components register their operations with `registerOperation` and their state reducers with `registerReducer`. `CONTRACTS.md` specifies each internal module.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the projects directory; it injects the asset store service.

```yaml
- id: dv-project
  name: '@dv/project'
  config:
    root: $VH_STATE_ROOT/projects
```

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory holding one `<ProjectId>/` per project; created when missing |
| `cpuConcurrency` | `4` | Scheduled `cpu` records that may run at the same time |
| `gpuConcurrency` | `1` | Scheduled `gpu` records that may run at the same time |

<a id="understand-the-implementation"></a>
## Understand the implementation

The service in `src/index.ts` delegates to seven private modules: the record store (the only code that touches `project.json`, `records.jsonl` and `branches.json`), the runner, the scheduler, drafts and branches, history, the reducer registry, and subscriptions. `CONTRACTS.md` lists each module's functions, rules, errors and tests.

<a id="further-exploration"></a>
## Further Exploration

- `CONTRACTS.md` in this package: module contracts and the test plan.

<a id="model-experience"></a>
## Model Experience

None; the agent tools that read project state are registered by other packages.

#### KV Cache effect

None; the service adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A character, location or style version without reference images resolves to no input, so a record that names such a version keeps no trace of it and does not become stale when the version changes.
