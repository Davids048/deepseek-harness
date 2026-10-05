---
description: "视频 harness 的项目运行时：invoke 与 schedule、把操作日志折叠成状态、agent 草稿 turn、接受、撤销、分支、过期标记、确定性缓存、计划调度和自动重放。"
kind: "package-reference"
---

# @video-harness/runtime

[English](README.md) | 中文

## 概述

使用本包作为改变视频项目的唯一入口。`invoke` 解析输入，在正确的分支上追加记录，运行工具并记录输出；`schedule` 把记录排在其输入所指记录之后，并按成本类别的并发上限运行。`fold` 把任意分支或记录变成视图要显示的状态。agent turn 在草稿分支上工作，`acceptTurn` 把它快进进 `main`；`undoLatestTurn` 把 `main` 移回；`createBranch` 开一个探索分支。已批准的计划逐个镜头调度，确定性结果被缓存，所读记录被替代时确定性消费者自动重放。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@video-harness/assets` 和 `@video-harness/oplog` 之后挂载插件。

```yaml
- id: vh-runtime
  name: '@video-harness/runtime'
  config:
    ffmpegPath: /opt/ffmpeg/bin/ffmpeg
    builtinTools: true
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `ffmpegPath` | 必填 | 内置 `clip.trim` 和占位 `generate.video` 使用的 ffmpeg 二进制 |
| `builtinTools` | `true` | 启动时注册内置工具 |
| `gpuConcurrency` | `1` | 同时运行的 `gpu` 成本工具的调度记录数 |
| `cpuConcurrency` | `4` | 同时运行的 `cpu` 成本工具的调度记录数；`free` 工具不限 |

| 方法 | 行为 |
| --- | --- |
| `createProject({title})` | `main` 分支以一条 `intent` 记录开始的项目 |
| `invoke(projectId, request)` | 立即运行工具并记录；`request` 给出工具、输入（素材 ID、`entity@version`，或已完成记录的 `<record>#<index>` 输出）、参数、actor、surface、intent、turn，以及可选的 `branch`、`base_op`、`supersedes`；输入指向未完成记录时拒绝 |
| `schedule(projectId, request, {after?})` | 立即追加记录，待其输入所指记录和 `after` 记录完成后运行；产生者失败则记录失败 |
| `whenIdle(projectId)` | 项目没有排队或运行中的记录时兑现 |
| `fold(projectId, head?)` | 某分支名或记录 ID 处的 `ProjectState`；默认 `main` |
| `beginTurn(projectId, {actor, surface, intent, branch?})` | 开一个 turn；agent turn 得到从 `main` 分出的 `draft/<turn>`，用户 turn 直接写 `main`，带 `branch` 的 turn 不开草稿直接写该探索分支 |
| `openTurn(turn)` | 开着的 turn 的分支、基点和是否草稿；接受或拒绝后为 undefined；启动时运行时会重新打开日志里每个没有 approve 或 reject 记录的 `draft/<turn>` 头 |
| `acceptTurn` / `rejectTurn` / `undoLatestTurn` / `createBranch` | 把 `main` 快进到草稿（`main` 已移动时拒绝）、留下草稿、把 `main` 移回一个 turn、在任意记录处开分支 |
| `registerTool(spec)` / `tool(name)` / `toolNames()` | 使工具可调用；同名的后注册者替换先注册者；spec 以 `cost` 声明 `free`、`cpu` 或 `gpu` |

内置工具：`asset.upload`、`entity.create`、`entity.update`、`plan.create`、`plan.approve`、`sequence.create`、`sequence.replace`、`sequence.move`、`sequence.set_range`、`sequence.insert`、`sequence.remove`、`clip.trim`，以及渲染纯色片段（颜色随提示词变化）的占位 `generate.video`，让项目在没有模型后端时也能跑通。profile 实际装载的是 [`@video-harness/tools`](../tools/README.zh.md) 注册的带类型 spec。

`plan.approve` 记录指向一条 `plan.create` 或 `plan.update` 记录，其输出是计划文档：带提示词和时长的 `shots`、`references` 和 `continuity`。运行时为每个镜头调度一条 `generate.video` 记录，`chained` 连续性把上一镜头的最后一帧（`<record>#1`）作为 `first_frame` 输入，然后对所有片段调度一条 `sequence.create`。工具可以返回 `report` 事实，例如它抽取的种子，记录把它保存在参数旁边。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

`fold` 一次遍历记录链。输出成为带产生者的素材；`entity.*` 记录构建版本列表；`sequence.*` 记录构建片段列表；`plan` 和 `approve` 记录配对；`base_op` 链把 take 归到各自的根下。第二遍标记过期：某输入的产生者被替代或自身过期，或某实体输入的版本低于实体当前版本时，记录过期；`accept_stale` 记录豁免一条记录。能从 `main` 到达的 turn 视为已接受。

`invoke` 和 `schedule` 都折叠分支头以解析输入，推导 `entity.update` 的隐式 `supersedes`（上一版的记录），并追加待执行记录；指向未完成记录的输出引用在记录运行时才解析。调度器在成本类别有空位时启动每条产生者和 `after` 记录都已完成的排队记录，产生者失败的记录直接失败。一次运行先为确定性工具查缓存（工具、版本、规范化参数和解析后输入都相同的更早成功记录，以 `cost.cached` 记录），否则在一个用后即删的临时目录里执行工具；记录以 `done` 加输出、墙钟时间和工具报告结束，或以 `failed` 加错误结束。`plan.approve` 完成后调度计划中的镜头；带 `supersedes` 的记录完成后，被替换素材的每个确定性消费者带着 `base_op`、`supersedes` 和 `params.replayed_from`（缓存键忽略它）在替换物上重新调度，显示过被替换素材的序列槽位用 `sequence.replace` 重新指向。

| 文件 | 内容 |
| --- | --- |
| [`src/types.ts`](src/types.ts) | `ProjectState`、`InvokeRequest`、`RuntimeToolSpec` |
| [`src/fold.ts`](src/fold.ts) | 折叠和过期规则 |
| [`src/builtins.ts`](src/builtins.ts) | 内置工具 |
| [`src/index.ts`](src/index.ts) | `vhProject`：invoke、turn、撤销、分支、缓存 |

`scripts/video-harness/walkthrough.ts` 通过 `@video-harness/tools` 的 spec 在假生成后端（设置 `VH_BACKEND_URL` 则用真实后端）上跑设计中的六步测试用例并断言预期状态，包括两种连续性模式的计划调度和自动重放。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md) — 整个 harness 中的草稿、撤销、分支和过期。
- [`@video-harness/oplog`](../oplog/README.zh.md) — 运行时写入的记录。
- [`@video-harness/assets`](../assets/README.zh.md) — 工具输出的存放处。

-----

<a id="model-experience"></a>
## 模型体验

间接影响。运行时记录工具调用并折叠状态；它调用的工具拥有每一次模型请求。

#### KV Cache 影响

无；运行时本身不向模型发送任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只能撤销最近的 turn** — 撤销更早的 turn 需要 `revert` 记录，运行时尚未写入；请改为从该 turn 之前开分支。
- **占位生成器** — 内置 `generate.video` 只渲染纯色；profile 挂载带生成后端的 `@video-harness/tools` 才有真实镜头。
- **重放只跟随记录输入** — 通过参数读取素材的确定性记录（如 `sequence.create`）按槽位重新指向而不重跑；被替换素材的非确定性消费者只被标记为过期。
- **调度失败只记录** — 调度记录失败或其产生者失败时，日志里以 `failed` 结束而不通知调用方；`whenIdle` 后再折叠即可看到。
