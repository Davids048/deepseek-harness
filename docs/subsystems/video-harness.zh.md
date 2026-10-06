# DreamVerse 各包

[English](video-harness.md) | 中文

DreamVerse 各包是 DeepSeek Harness 内视频制作的项目层。本页定义 `packages/dv/` 下这些包和 [`packages/video-harness/`](../../packages/video-harness/README.zh.md) 包组的词汇和跨包规则：分层、操作记录、视图和智能体如何写入，以及过期、草稿、撤销和分支如何工作。各包 README 各自说明配置和服务 API。

## 分层

```text
views (chat, timeline, canvas) and the agent      run operations; they hold no project state
  │  dvProject.run(operation, inputs, params, origin)
  ▼
Project (@dv/project)                             records, branches, drafts, undo and redo, stale marks, state, agent tools
  │
  ├── components (@dv/story-bible, @dv/shot-plan, @dv/shot-render, @dv/timeline, @dv/deliver, @dv/inspector)
  └── asset pool (@dv/asset-pool)                 immutable bytes by SHA-256, with the record that created them
```

组件用 `dvProject.registerOperation` 注册操作，用 `dvProject.registerReducer` 注册状态归约函数（[`@dv/project`](../../packages/dv/project/README.zh.md)）。每个操作同时是智能体工具 `dv_<操作名，点换成下划线>`，一次调用成为一条记录。素材库的 `dv_asset_import` 和 `dv_asset_grab_still` 添加素材；设定库的 `dv_bible_*` 工具创建和更新角色、场景和风格的版本；分镜的 `dv_plan_create`、`dv_plan_update` 和 `dv_plan_approve` 写入分镜计划，批准一个计划会为每个镜头排定一次 `shot.render`，并排定一次对该计划时间线的 `timeline.update`，计划还没有时间线时则排定一次 `timeline.create`；镜头渲染的 `dv_shot_render` 在 DreamVerse 生成后端之上渲染一个版本；时间线的 `dv_timeline_*` 工具创建、更新、重命名和删除时间线，并插入、移动、移除、拆分、裁剪和替换按片段 ID 指定的片段，不创建文件；交付的 `dv_deliver_timeline_export` 把一条时间线写成一个视频；检查器的 `dv_inspect_image` 和 `dv_inspect_asset` 读取素材，不写记录。ffmpeg 的工作经 [`@dv/ffmpeg`](../../packages/dv/ffmpeg/README.zh.md) 运行。项目组件自己的 `dv_proj_*` 工具创建和打开项目、读取状态和历史、接受和丢弃草稿、撤销、重做、接受过期记录、创建和切换分支，以及等待排定的记录。操作声明资源类别（`none`、`cpu`、`gpu`）和确认策略（`never`、`agent_ask_first`）；项目组件的调度器按类别并发上限运行排定的记录。

## 操作记录

项目的每次变化都是项目 `records.jsonl` 文件中的一条记录，只有 `@dv/project` 读写这个文件。一条记录包含：谁（`actor`：`user`、`agent` 或 `system`）、来自哪个视图（`surface`）、人的原话或对手势的描述（`intent`）、所属组件（`component`）和操作（`operation`）及其版本、产生它的轮次、对话和工具调用、参数、各输入及其解析到的素材（`resolved_asset`）、输出、状态、父记录，以及两个链接：`based_on`（本记录带修改地重复那条记录，例如改了提示词的新版本）和 `supersedes`（本记录替代那些记录的输出）。记录的 `kind` 为 `'operation'`，只有 `request` 记录例外，它保存开启一个智能体轮次的人的原话。记录只追加不改写；状态变化、成本和报告以更新行追加，`branches.json` 保存分支指针。项目组件自己的动作也是记录（`proj.draft_accept`、`proj.draft_discard`、`proj.undo`、`proj.redo`、`proj.branch_create`、`proj.branch_switch`、`proj.stale_accept`），而 `dv_proj_state`、`dv_proj_history_list` 和 `inspect.*` 操作这类读取不写记录。

## 操作如何运行

视图和智能体到达同样的操作。时间线或画布上的手势通过 `@dv/api` 的路由运行一个操作，带 `actor: 'user'`，`surface` 设为该视图。智能体调用该操作的 `dv_*` 工具，工具以 `actor: 'agent'`、`surface: 'chat'`、轮次、对话和工具调用 ID 运行它；该轮次的第一条记录跟在一条保存人的原话的 `request` 记录之后。每次调用都经过 `dvProject.run` 的运行器。运行器先校验参数；然后在项目锁内把每个输入解析为素材，并调用操作的 `precondition`，它在写入任何记录之前拒绝调用，对每个调用方都生效：所用模型从参考图渲染时，`shot.render` 和 `plan.approve` 拒绝没有参考图的渲染。运行器随后追加 `pending` 记录，并把操作自己的 `supersedes` 指出的记录加入该记录的 `supersedes`。对 `confirm: agent_ask_first` 的操作，来自先问模式对话的智能体调用等待输入框的批准卡片，被拒绝的卡片以 `cancelled` 结束该记录。最后运行器在锁外运行所属组件的实现，并追加带输出、成本和报告的最终更新行。输入指向未完成记录的调用，以及批准计划时排定的每次渲染，都在项目组件的调度器中等待，直到其输入完成。

## 项目状态

分支的状态由它的记录计算得出：项目组件从分支头往回走，遇到 `proj.undo` 和 `proj.redo` 记录时跳到它所指的记录，再把这些记录按从旧到新的顺序交给每个已注册的归约函数。每个组件的归约函数把自己的记录变成 `ProjectState.components` 中自己的切片（设定库 `bible`、分镜 `plan`、镜头渲染 `shot`、时间线 `timeline`），项目组件自己的归约函数维护 `proj` 切片：记录、过期和被替代的记录，以及创建每个素材的记录。归约函数的 `agentSummary` 把该组件的字段加入 `dv_proj_state` 和其他 `dv_proj_*` 工具返回给智能体的项目摘要。没有视图持有项目状态：画布和时间线获取它们所示分支的状态，并在实时事件流的每个事件后重新获取。

## 草稿、接受、撤销、分支

每个对话在每个项目中最多有一个打开的草稿，即分支 `draft/<session>`。会话的当前分支是它打开的草稿，否则是它切换到的探索分支，再否则是 `main`；该会话中智能体的调用和人的编辑都写入当前分支。会话在没有打开的草稿时，智能体的第一次写入在会话当前分支的头处打开草稿；`user` 和 `system` 的写入从不打开草稿。草稿跨越多个轮次，直到人接受或丢弃它，项目组件从不自行关闭草稿。接受（`proj.draft_accept`）在草稿分出的那个分支没有移动时把它移到草稿；若期间另一个会话的草稿已被接受，项目组件把草稿的记录作为副本在移动后的分支头上重放，并在某条记录替代了那里已被替代的记录，或某个组件的归约函数报告冲突时，以 `DraftConflictError` 拒绝且不写入任何东西。丢弃（`proj.draft_discard`）删除该分支并把它的记录留在历史里；当智能体修改数和人的编辑数与确认对话框显示的数目不同时，丢弃被拒绝。草稿中有记录处于 pending 或 running 时，两者都被拒绝。撤销（`proj.undo`）把 `main` 后退一个变化（整个被接受的草稿，或直接写在 `main` 上的一条记录），方法是追加一条记录，其 `params.to` 指出 `main` 回到其状态的那条记录；重做（`proj.redo`）追加一条记录，让 `main` 回到那次撤销之前的状态，之后 `main` 上的任何变化都使重做不再可用。记录从不被改写或删除。`proj.branch_create` 在任意记录或分支头处开始一个探索分支 `explore/<name>`，`proj.branch_switch` 把会话切换到它或切回 `main`。

## 智能体集成

[`@dv/agent-integration`](../../packages/dv/agent-integration/README.zh.md) 把 DSH 智能体循环接到项目组件上。它把每个智能体轮次和开启该轮次的人的原话报告给 `dvProject`，使该轮次的记录带上轮次并跟在该轮次的请求记录之后；它用 `asset.import` 导入用户在对话中附上的图片；它把 DSH 提问规则注册为 `dvProject` 的工具调用检查：`plan.approve` 调用除非带 `user_approved: true`，否则询问用户，问题中列出计划的每个镜头及其 GPU 预估；`shot.render` 调用在本轮次已花费的 GPU 秒数加上本次调用的预估超过 `confirmGpuSecondsThreshold` 且调用没有带 `user_requested: true` 时询问。会话处于先问模式时，运行器为 `agent_ask_first` 操作显示的批准卡片就是这个问题；否则在挂载了 DSH user-questions 服务时，规则通过它询问在线根智能体的用户；再否则，工具结果告诉模型在对话中询问，然后带上该标志重新调用。规则只负责询问：只有运行器强制执行 `confirm`。对话的草稿跨越多个轮次，直到人接受或丢弃它；会话处于先问模式时，`confirm: agent_ask_first` 的操作等待输入框的批准卡片。一节系统提示词携带会话当前分支的状态（角色、场景和风格，时间线及其片段，版本，过期记录，计划，草稿），让模型把指代解析成具体 ID，`video-directing`、`timeline-editing` 和 `branching-story` 三个 skill 承载工作流程。同一个包保存每个对话的输入框模式，持有批准卡片，并把用户消息里的 `dv:` 提及展开成它们所指的具体记录和素材 ID。[`@dv/bundle`](../../packages/bundle/dv/README.zh.md) 把这一切组成 `video-harness` 和 `video-harness-headless` 两个 profile。

## API 和视图

[`@dv/api`](../../packages/dv/api/README.zh.md) 是项目组件面向浏览器的 HTTP 面：`/api/dv/state` 把一个分支的状态返回为一份 JSON 文档，`/api/dv/operation` 以用户身份运行一个操作，其记录带 `surface: 'canvas'`、`'timeline'` 或 `'asset_pool'`，`/api/dv/drafts/accept`、`/api/dv/drafts/discard`、`/api/dv/undo`、`/api/dv/redo`、`/api/dv/branches/create`、`/api/dv/branches/switch` 和 `/api/dv/stale/accept` 暴露草稿、撤销、重做、分支和过期操作，`/dv/events` 推送每一次记录和分支变化。[`@dv/ui-canvas`](../../packages/dv/ui-canvas/README.zh.md) 和 [`@dv/ui-timeline`](../../packages/dv/ui-timeline/README.zh.md) 是 web 应用右侧栏的标签类型，因此在同一个 profile 里与对话页并存：画布把所示分支的记录按素材流向画成 DAG（角色、场景和风格是源头，计划折叠成一个节点，版本挨着它所基于的记录，草稿用虚线，过期记录有标记），让用户修改某条记录的参数并把修改写成替代记录或新版本；时间线把每条时间线画成一条轨道，把插入、移动、移除、拆分和裁剪手势变成 `timeline.*` 记录，把导出变成一条 `deliver.timeline_export` 记录。两者都不保存项目状态：它们渲染宿主发来的东西，每次事件都重新拉取，并把选中的节点或片段报告给 `/api/dv/selection`，以便告诉智能体用户指向了什么。[`@dv/ui-kit`](../../packages/dv/ui-kit/README.zh.md) 放两者共用的浏览器代码。

## 过期

项目组件的归约函数标记过期记录，不重跑任何东西。当一条记录在 `supersedes` 中列出记录 X 时，每条读取了 X 的输出的记录，以及这类记录下游的每条记录，都变为过期；之后读取的输入若其产生者已被替代或已过期，该记录也过期。输入的产生者是创建其素材的记录；对角色、场景或风格的版本，是写入该版本的记录。调用替代哪些记录由所属操作通过 `OperationSpec.supersedes` 决定：`bible.character_update`、`bible.location_update` 和 `bible.style_update` 替代创建上一版本的记录，因此读取了上一版本的每条记录都过期。调用方也可以在 `supersedes` 中指定记录，智能体为替换某个镜头的重拍就这样做。过期记录只在智能体或人决定时重跑；`proj.stale_accept` 清除一条记录的标记，并使其消费者不再因它而过期。

## 确定性复用

当 `deterministic: true` 的操作以与一条更早的 `done` 记录相同的操作和版本、相等的参数和相同的已解析输入素材被调用时，运行器复用那条记录的输出而不运行该操作；本次调用仍被记录，并带 `cost.reused: true`。渲染不是确定性的：再次渲染一个镜头得到一个新版本，即一条 `based_on` 指向更早那次渲染的 `shot.render` 记录，镜头渲染的归约函数把一个镜头的各版本归到它的第一次渲染之下。
