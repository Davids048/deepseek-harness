# DreamVerse component template

This file is the recipe for one DreamVerse component package under `packages/dv`. `@dv/inspector` is the reference component: copy its layout, its registration code, its tests and its README. Every public name, and every word for a DreamVerse concept in code, docs and copy, comes from the [glossary](../../docs/subsystems/video-harness.md#glossary).

## Contents

1. [What a component is](#1-what-a-component-is)
2. [Package layout](#2-package-layout)
3. [Operations, reducer and tools](#3-operations-reducer-and-tools)
4. [Configuration and wiring](#4-configuration-and-wiring)
5. [Tests](#5-tests)
6. [README](#6-readme)
7. [Checks](#7-checks)

## 1. What a component is

A component owns one capability: its implementation, its data, its operations, the reducer that turns its records into its state slice, and (through Project) the agent tool of each operation. It depends only on `@dv/project` (to register and run operations) and on the asset pool (to read and import assets); outside tools such as ffmpeg come through `@dv/ffmpeg`. A component never imports another component's package for code. It reads another component's state only through `ProjectState`; a type-only import of another component (for its `ComponentStates` slice) is allowed. It runs another component's operation only through `dvProject.run` by name.

## 2. Package layout

```
packages/dv/<dir>/                 package @dv/<dir>, service dv<Name> (glossary: components)
  package.json                     private, type module, exports ./src/index.ts; deps listed in section 4
  tsconfig.json                    extends ../../../tsconfig.base.json, rootDir src, outDir lib/types, references
  src/index.ts                     the service class (default export), Config, declare module Context
  src/types.ts                     types only: the state slice, IDs, `declare module '@dv/project'` (if state)
  src/reducer.ts                   the pure reducer (if the component has state)
  src/<area>.ts                    operation specs and helpers when index.ts grows past one screen per operation
  tests/<dir>.spec.ts              Loader composition test (copy inspector/tests/inspector.spec.ts)
  tests/reducer.spec.ts            pure reducer tests (if state)
  README.md, README.zh.md, README.i18n.yaml
  node_modules/                    untracked symlinks, see section 4
```

`src/types.ts` holds no runtime code. Tests live in `tests/`. Use `.ts` in relative imports.

## 3. Operations, reducer and tools

**Service.** One `Service` subclass per component, registered as `dv<Name>`:

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { dvTimeline: DvTimeline }
}

export default class DvTimeline extends Service {
  static inject = ['dvProject', 'dvAssetPool']
  static Config = Config

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'dvTimeline')
    ctx.effect(() => ctx.dvProject.registerReducer('timeline', timelineReducer), 'dvTimeline reducer')
    for (const spec of this.operations()) ctx.effect(() => ctx.dvProject.registerOperation(spec), `dvTimeline ${spec.name}`)
  }
}
```

Every registration is inside `ctx.effect`, so disposal removes it. An operation that needs an optional service (the model, the generation client) is registered inside `ctx.inject([...], child => child.effect(...))`, as `inspect.image` is. Service methods named by registry verbs (`insertClip`, `renderShot`, `exportTimeline`) do the work; each operation's `execute` calls one of them.

**Operation spec** (`OperationSpec` of `@dv/project`; read its JSDoc in `packages/dv/project/src/types.ts`):

| Field             | Rule                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `name`            | `<component key>.<verb>` or `<component key>.<object>_<verb>` from the glossary; the runner checks it |
| `component`       | the component key (`asset bible plan shot timeline deliver inspect`)                              |
| `version`         | `'1'`; bump when the meaning of `params` changes                                                  |
| `description`     | model-facing and canvas-facing text; registry words only                                          |
| `params`          | DSH parameter schema in snake_case registry words (`timeline`, `clip`, `in_sec`)                  |
| `inputs`          | role → `{type, description, required?, many?, bible?}`; `bible: true` accepts `<id>@<version>`    |
| `outputs`         | the roles of the assets `execute` returns, in order                                               |
| `summarize`       | one line for chat cards and canvas nodes, from a finished record                                  |
| `confirm`         | `agent_ask_first` only for renders the human must approve (`shot.render`, `plan.approve`)         |
| `deterministic`   | true when the same params and inputs give the same outputs (the runner then reuses outputs)       |
| `resource`        | `gpu`, `cpu` or `none`; `estimate(params)` for `gpu` operations                                   |
| `readOnly`        | true for reads; no record, no confirmation, the answer is `report`                                |
| `supersedes`      | the records a call replaces (a character update replaces the record of the previous version)      |
| `toolParams`      | tool-only arguments, removed from `params` before the run (`continue_from` of `shot.render`)      |
| `precondition`    | refuses a call of any caller before a record is written (the reference-image rule)                |
| `prepareToolCall` | component logic before an agent call (`continue_from`); never a confirmation gate                 |
| `execute`         | does the work; creates files only through `context.importAsset`; throws to fail the record        |

**Tools.** `registerOperation` also registers the agent tool `dv_<name with _>` while the DSH `tools` registry is mounted, with the shared arguments `reason`, `project_id`, `inputs`, `supersedes` and `based_on`, and the result `{record, status, summary, outputs, scheduled, params, report?, images?}`. A component writes no tool code. The DSH question rule (`user_approved`, `user_requested`, the GPU budget) is the agent integration's `ToolCallCheck` (`packages/dv/agent-integration/src/question-rule.ts`), which applies to operations by name: an operation that needs the user's approval before an agent call gets its rule there. A rule that every caller must meet belongs in the operation's `precondition`, which the runner calls for every caller.

**Reducer.** Declare the slice in `src/types.ts` and register the reducer under the component key:

```ts
declare module '@dv/project' {
  interface ComponentStates { timeline: TimelineState }
}
```

The reducer is pure: `initial()`, and `reduce(slice, record)` that ignores records of other components (match on `record.operation`) and records that are not `done`. Add the optional members where they apply:

| Member         | Who                              | Meaning                                                                                                                                     |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `createdBy`    | Story bible                      | the record that wrote a character, location or style version; Project uses it for stale marks and for `<id>@<n>` parsing                    |
| `assetsOf`     | Story bible                      | the reference images a version stands for; the runner resolves version inputs with it                                                       |
| `conflict`     | Timeline, Story bible            | why a draft record cannot apply on a moved `main` (a clip that `main` removed, a version that `main` superseded); accept replay stops there |
| `agentSummary` | Story bible, Shot plan, Timeline | the fields of the slice that the agent reads in the project summary of `dv_proj_state`; field names unique across components                |

At most one registered reducer defines `createdBy` and at most one defines `assetsOf`; Project calls the one that does, under whatever key it is registered.

## 4. Configuration and wiring

**Config.** Every deployment-varying value is a `Config` field with a schemastery default (or `required()`), read from the bundle row; no `DEFAULT_*` constants for tunables.

**package.json.** `dependencies`: `@dv/project` and every other workspace package `src/` imports at runtime or for types (`workspace:*`; vendor packages `workspace:~` in `peerDependencies` and `devDependencies`, as in inspector). Test-only packages go in `devDependencies`.

**Registration in shared files** (add only your component's lines):

1. `tsconfig.base.json` `paths`: `"@dv/<dir>": ["./packages/dv/<dir>/src/index.ts"]` next to the other `@dv/*` rows.
2. `tsconfig.host.json` `references`: `{ "path": "./packages/dv/<dir>" }` next to the other `packages/dv` rows.
3. `packages/bundle/dv/cordis.patch.yml`: one row `- id: dv-<dir>` / `name: '@dv/<dir>'` with its config, in the `insert` list after the rows it injects; and `@dv/<dir>` in that bundle's `package.json`.
4. Every consumer's `tsconfig.json` `references` and `package.json` `dependencies` (api, agent-integration for a slice type).

**node_modules.** Run `pnpm install` from the worktree root; it links `@dv/<dir>` into every package that lists it in `dependencies` and records the package in `pnpm-lock.yaml`.

## 5. Tests

**Unit tests** in `packages/dv/<dir>/tests`, run from `packages/dv` with `../../node_modules/.bin/vitest run --config vitest.config.ts <dir>`:

- one Loader composition test (copy `inspector/tests/inspector.spec.ts`): a test-only `cordis.yml` with `system-prompt`, `tools`, the asset pool, `dv-project`, `dv-ffmpeg` when used, and your plugin; fakes only for outside services (model, generation backend). Assert through the agent tool (`ctx.tools.execute` with an agent) and through `dvProject.run`: the record (actor, component, operation, params, inputs, outputs), the state slice, the tool result, and that disposing your plugin removes its operations and tools;
- one test per operation for its failures (`execute` throws → record `failed` with the message; invalid params → `invalid_params` before any record);
- pure reducer tests: every operation's effect on the slice, records of other components ignored, `createdBy`, `assetsOf`, `conflict` and `agentSummary` where present.

**E2E stories.** Add or update the stories that exercise your component, and run every suite you touched, from the worktree root: `node_modules/.bin/vitest run --config packages/dv/e2e/vitest.e2e.config.ts <story>` (stories: `navigation`, `chat`, `canvas-timeline`, `assets`). The scripted model in `e2e/tests/scripted-model.ts` and the rules in each story name tools by their `dv_*` names.

## 6. README

Copy `packages/dv/inspector/README.md` and `README.zh.md`: front matter (`description`, `kind: "package-reference"`), Summary, Table of Contents, Use this package (mount row, Config table, operation table with tool, inputs and params, report or outputs), Understand the implementation (with a file table), Further Exploration, Model Experience (the tool schemas and results; KV cache effect), Known Limitations and Deferred Work. Both languages line-aligned; Chinese links point to `README.zh.md` files. Record the pair from the worktree root: `node_modules/.bin/tsx scripts/verify-translation-pairing.ts --write packages/dv/<dir>/README.md`, then run it without `--write`; it must report all pairs consistent. Update the README pairs of every package you changed in the same way.

## 7. Checks

From the worktree root:

1. `node_modules/.bin/tsc -b tsconfig.host.json` and `node_modules/.bin/tsc -b tsconfig.client.json`: 0 errors (the host check includes every `packages/*/*/tests` file).
2. Unit tests: `packages/dv` (section 5): all pass.
3. Lint, including untracked files: `{ git diff --name-only -- '*.ts' '*.tsx'; git ls-files --others --exclude-standard -- '*.ts' '*.tsx'; } | xargs node_modules/.bin/tsx scripts/run-oxlint.ts --config .oxlintrc.staged.json --fix --no-error-on-unmatched-pattern`: 0 errors.
4. Client bundles rebuilt for every changed `ui-*` package: `cd packages/dv/<ui-pkg> && ../../../node_modules/.bin/tsdown`.
5. The e2e suites that exercise your component: all pass.
6. `node_modules/.bin/tsx scripts/verify-translation-pairing.ts`: all pairs consistent.
