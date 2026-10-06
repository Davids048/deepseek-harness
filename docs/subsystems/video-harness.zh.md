# 视频 harness

[English](video-harness.md) | 中文

视频 harness 是 DeepSeek Harness 内视频制作的项目层。本页定义 [`packages/video-harness/`](../../packages/video-harness/README.zh.md) 包组的词汇和跨包规则：分层、操作记录、视图和 agent 如何写入，以及过期、草稿、撤销和分支如何工作。各包 README 各自说明配置和服务 API。

## 分层

```text
views (chat, timeline, canvas) and the agent     clients of the runtime; they only invoke tools
  │  vhProject.invoke(tool, inputs, params, who/where/why)
  ▼
runtime (@video-harness/runtime)                 fold, turns, drafts, undo, branches, staleness, deterministic cache
  │
  ├── oplog (@video-harness/oplog)               append-only records and branch heads, one directory per project
  └── assets (@video-harness/assets)             immutable bytes by SHA-256, with the operation that produced them
```

工具在运行时上注册（`registerTool`）。运行时自带上传、实体、计划、序列编辑、通过 ffmpeg 实现的确定性 `clip.trim`，以及渲染纯色片段的占位 `generate.video`。profile 挂载 [`@video-harness/tools`](../../packages/video-harness/tools/README.zh.md) 获得带类型的 spec：它把 spec 注册到运行时，把每个 spec 暴露为调用即成一条记录的 `vh_<name>` DSH 工具，并在 DreamVerse 生成后端之上挂载 `generate.video`、在默认模型之上挂载 `perception.describe`。媒体工具经 [`@video-harness/media`](../../packages/video-harness/media/README.zh.md) 运行。spec 声明成本类别（`free`、`cpu`、`gpu`）；运行时的 `schedule` 按类别并发上限运行排队记录，并把已批准的计划展开为每镜头一次生成。

## 操作记录

项目的每次变化都是一条记录：谁（`actor`）、来自哪个视图（`surface`）、用户的原话或手势（`intent`）、工具、各输入及其解析到的素材、参数、输出、状态、turn、父记录，以及驱动过期的两个链接：`base_op`（本记录修改了那条记录的副本）和 `supersedes`（本记录替代了那些记录的输出）。记录只追加不改写；状态变化以补丁行追加。分支是指向记录的命名指针。

## 视图如何写入

时间线或画布上的手势变成一次工具调用，`surface` 设为该视图；聊天消息变成一条 `intent` 记录，后面跟着 agent 的工具调用。没有视图持有项目状态，视图之间也不通信：每个视图订阅它所展示分支的日志并折叠。

## 草稿、接受、撤销、分支

agent turn 在 `main` 头处开 `draft/<turn>` 并写入其中。`acceptTurn` 追加一条 `approve` 记录并把 `main` 移到它；若 `main` 自草稿分出后已移动则拒绝，agent 需在当前 `main` 上重新规划。`rejectTurn` 把草稿留在日志里。`undoLatestTurn` 把 `main` 移回最近一个 turn 之前的记录；记录保留。`createBranch` 在任意记录或分支头处开探索分支，折叠该分支即得到那一点的状态。

## agent 层

[`@video-harness/agent`](../../packages/video-harness/agent/README.zh.md) 通过 [`@video-harness/tools`](../../packages/video-harness/tools/README.zh.md) 里的工具桥把 DSH agent loop 接到运行时上。`turn/start` 会话事件告诉桥某个会话处于 agent loop 的哪个 turn；该 turn 的第一次结构化调用打开草稿，更早 turn 打开的草稿在 `vh_turn_accept` 或 `vh_turn_reject` 关闭它之前不会被继续写。turn 正常完成的 `turn/end` 时，记录全部是确定性的或带 `user_requested: true`、且其中没有 `confirm: always` 工具的草稿被并入 `main`；其他带记录的草稿保持打开等用户决定，空的或被中止的草稿被拒绝。确认遵循每个 spec 的 `confirm` 类别：`always` 只在带 `user_approved: true` 或用户回答了 `userQuestions` 的问题后运行；`cost` 只在本 turn 的预估 GPU 秒数超过桥的预算且调用没有带 `user_requested: true` 时才问；`never` 直接运行。一节系统提示词携带绑定项目的实体、时间线槽位、take、过期记录和 plan，让模型把指代解析成具体 id，`video-directing` 和 `branching-story` 两个 skill 承载操作流程。[`@video-harness/bundle`](../../packages/bundle/video-harness/README.zh.md) 把这一切组成 `video-harness` 和 `video-harness-headless` 两个 profile。

## 视图

[`@video-harness/views`](../../packages/video-harness/views/README.zh.md) 是运行时面向浏览器的 HTTP 面：`/api/vh/state` 把一个 head 折叠成一份 JSON 文档，`/api/vh/invoke` 以用户 turn 运行一个工具，其记录带 `surface: 'canvas'` 或 `'timeline'`，`/api/vh/turn`、`/api/vh/undo` 和 `/api/vh/branch` 暴露草稿、撤销和分支操作，`/vh/events` 推送每一次日志变化。[`@video-harness/ui-canvas`](../../packages/video-harness/ui-canvas/README.zh.md) 和 [`@video-harness/ui-timeline`](../../packages/video-harness/ui-timeline/README.zh.md) 是 web 应用右侧栏的标签类型，因此在同一个 profile 里与聊天页并存：画布把所示 head 的记录按素材流向画成 DAG（实体是源头，计划折叠成一个节点，版本挨着它的基准，草稿用虚线，过期记录有标记），让用户修改某条记录的参数并把修改写成替代记录或新版本；时间线把折叠出的序列画成一条轨道，把排序、设范围、裁剪、插入手势变成 `sequence.*` 记录，把导出变成 `clip.trim` 和 `media.concat` 记录。两者都不保存项目状态：它们折叠宿主发来的东西，每次事件都重新拉取，并把选中的节点或片段报告给 `/api/vh/selection`，以便告诉 agent 用户指向了什么。[`@video-harness/ui-kit`](../../packages/video-harness/ui-kit/README.zh.md) 放两者共用的浏览器代码。

## 过期

一条记录过期的条件：某个输入由一条被后来记录 `supersedes` 的记录产生；某个输入的产生者自身过期；或某个实体输入的版本低于该实体的当前版本（`entity.update` 替代上一版）。折叠只报告过期记录，不重跑任何东西。确定性工具可以通过缓存在新输入上重放；生成类工具只在 agent 或用户决定时重跑。`accept_stale` 记录清除一条记录的标记。

## 确定性缓存

确定性工具若名称、版本、参数和解析后的输入与一条更早的成功记录相同，就复用那条记录的输出；本次调用仍被记录，并设置 `cost.cached`。生成类工具从不缓存：同样的请求再跑一次是一个新 take，通过 `base_op` 与原记录归为一组。
