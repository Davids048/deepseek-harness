# DreamVerse 各包

[English](video-harness.md) | 中文

DreamVerse 各包是 DeepSeek Harness 内视频制作的项目层。本页定义 `packages/dv/` 下这些包和 [`packages/video-harness/`](../../packages/video-harness/README.zh.md) 包组的词汇和跨包规则：分层、操作记录、视图和智能体如何写入，过期、草稿、撤销和分支如何工作，以及代码、记录、工具和界面文案所用名称的[术语表](#glossary)。各包 README 各自说明配置和服务 API。

## 分层

```text
views (chat, canvas, timeline, asset pool, History) and the agent  run operations; they hold no project state
  │  dvProject.run(operation, inputs, params, origin)
  ▼
Project (@dv/project)                                              records, branches, drafts, undo and redo, stale marks, state, agent tools
  │
  ├── components (@dv/story-bible, @dv/shot-plan, @dv/shot-render, @dv/timeline, @dv/deliver, @dv/inspector)
  └── asset pool (@dv/asset-pool)                                  immutable bytes by SHA-256, with the record that created them
```

组件用 `dvProject.registerOperation` 注册操作，用 `dvProject.registerReducer` 注册状态归约函数（[`@dv/project`](../../packages/dv/project/README.zh.md)）。每个操作同时是智能体工具 `dv_<操作名，点换成下划线>`，一次调用成为一条记录。素材库的 `dv_asset_import` 和 `dv_asset_grab_still` 添加素材；设定库的 `dv_bible_*` 工具创建和更新角色、场景和风格的版本；分镜的 `dv_plan_create` 写入一个新分镜计划的版次 1，该计划得到一个 `PlanId`（`p1`、`p2`、…），`dv_plan_update` 写入 `plan` 参数所指计划的下一个版次，`dv_plan_approve` 批准一个版次；镜头渲染的 `dv_shot_render` 在 DreamVerse 生成后端之上渲染一个版本，`duration_sec` 是所用模型范围内的整秒数（默认为模型的最小值）；时间线的 `dv_timeline_*` 工具创建、更新、重命名和删除时间线，并插入、移动、移除、拆分、裁剪和替换片段，不创建文件；交付的 `dv_deliver_timeline_export` 把一条时间线写成一个视频；检查器的 `dv_inspect_image` 和 `dv_inspect_asset` 读取素材，不写记录。ffmpeg 的工作经 [`@dv/ffmpeg`](../../packages/dv/ffmpeg/README.zh.md) 运行。项目组件自己的 `dv_proj_*` 工具创建和打开项目、读取状态和历史、接受和丢弃草稿、撤销、重做、接受过期记录、创建和切换分支，以及等待排定的记录。操作声明资源类别（`none`、`cpu`、`gpu`）和确认策略（`never`、`agent_ask_first`）；项目组件的调度器按类别并发上限运行排定的记录。

批准分镜计划时，以 `system` 发起者为所批准版次中每个新增或改动的镜头运行一次 `shot.render`，参数为 `plan`、`plan_version` 和 `shot`（镜头从 1 起的位置，镜头在各版次间保持这个编号）。若批准所在分支上同一计划有一条 `done` 的 `shot.render` 记录，其参数除 `plan`、`plan_version` 和 `shot` 外相同，参考图输入相同，首帧也相同，则该镜头未改动；批准复用最新的这样一个版本而不渲染。随后它对该计划的时间线（最新的创建或修改记录指向该计划的那条时间线）运行一次 `timeline.update`，按镜头顺序放入每个镜头的版本，计划还没有时间线时则运行一次 `timeline.create`，并在 `report.scheduled` 中列出排定的记录。片段有一个 `ClipId`（`cl1`、`cl2`、…），由插入它的时间线操作分配并存入记录的 `report.clips`；该 ID 在项目内唯一、从不复用，每个片段操作都用 `clip` 参数按它指定片段。

## 操作记录

项目的每次变化都是项目 `records.jsonl` 文件中的一条记录，只有 `@dv/project` 读写这个文件。一条记录包含：谁（`actor`：`user`、`agent` 或 `system`）、来源（`surface`：`chat`、`canvas`、`timeline`、`asset_pool`、`history` 或 `api`）、人的原话或对手势的描述（`intent`）、所属组件（`component`）和操作（`operation`）及其版本、产生它的轮次、对话和工具调用、参数、各输入及其解析到的素材（`resolved_asset`）、输出、状态、父记录，以及两个链接：`based_on`（本记录带修改地重复那条记录，例如改了提示词的新版本）和 `supersedes`（本记录替代那些记录的输出）。记录的 `kind` 为 `'operation'`，只有 `request` 记录例外，它保存开启一个智能体轮次的人的原话。记录只追加不改写；状态变化、成本和报告以更新行追加，`branches.json` 保存分支指针。项目组件自己的动作也是记录（`proj.draft_accept`、`proj.draft_discard`、`proj.undo`、`proj.redo`、`proj.branch_create`、`proj.branch_switch`、`proj.stale_accept`），而 `dv_proj_state`、`dv_proj_history_list` 和 `inspect.*` 操作这类读取不写记录。

## 操作如何运行

视图和智能体到达同样的操作。画布、时间线、素材库面板或历史面板上的手势通过 `@dv/api` 的路由运行一个操作，带 `actor: 'user'`，`surface` 设为该视图。智能体调用该操作的 `dv_*` 工具，工具以 `actor: 'agent'`、`surface: 'chat'`、轮次、对话和工具调用 ID 运行它；该轮次的第一条记录跟在一条保存人的原话的 `request` 记录之后。每次调用都经过 `dvProject.run` 的运行器。运行器先校验参数；然后在项目锁内把每个输入解析为素材，并调用操作的 `precondition`，它在写入任何记录之前拒绝调用，对每个调用方都生效：所用模型从参考图渲染时，`shot.render` 和 `plan.approve` 拒绝没有参考图的渲染。运行器随后追加 `pending` 记录，并把操作自己的 `supersedes` 指出的记录加入该记录的 `supersedes`。对 `confirm: agent_ask_first` 的操作，来自先问模式对话的智能体调用等待输入框的批准卡片，被拒绝的卡片以 `cancelled` 结束该记录。最后运行器在锁外运行所属组件的实现，并追加带输出、成本和报告的最终更新行。输入指向未完成记录的调用，以及批准计划时排定的每次渲染，都在项目组件的调度器中等待，直到其输入完成。

## 项目状态

分支的状态由它的记录计算得出：项目组件从分支头往回走，遇到 `proj.undo` 和 `proj.redo` 记录时跳到它所指的记录，再把这些记录按从旧到新的顺序交给每个已注册的归约函数。每个组件的归约函数把自己的记录变成 `ProjectState.components` 中自己的切片（设定库 `bible`、分镜 `plan`、镜头渲染 `shot`、时间线 `timeline`），项目组件自己的归约函数维护 `proj` 切片：记录、过期和被替代的记录，以及创建每个素材的记录。归约函数的 `agentSummary` 把该组件的字段加入 `dv_proj_state` 和其他 `dv_proj_*` 工具返回给智能体的项目摘要。没有视图持有项目状态：画布和时间线获取它们所示分支的状态，并在实时事件流的每个事件后重新获取。

## 草稿、接受、撤销、分支

每个对话在每个项目中最多有一个打开的草稿，即分支 `draft/<session>`。会话的当前分支是它打开的草稿，否则是它切换到的探索分支，再否则是 `main`；该会话中智能体的调用和人的编辑都写入当前分支。会话在没有打开的草稿时，智能体的第一次写入在会话当前分支的头处打开草稿；`user` 和 `system` 的写入从不打开草稿。草稿跨越多个轮次，直到人接受或丢弃它，项目组件从不自行关闭草稿。接受（`proj.draft_accept`）在草稿分出的那个分支没有移动时把它移到草稿；若期间另一个会话的草稿已被接受，项目组件把草稿的记录作为副本在移动后的分支头上重放，并在某条记录替代了那里已被替代的记录，或某个组件的归约函数报告冲突时，以 `DraftConflictError` 拒绝且不写入任何东西。丢弃（`proj.draft_discard`）删除该分支并把它的记录留在历史里；当智能体修改数和人的编辑数与确认对话框显示的数目不同时，丢弃被拒绝。草稿中有记录处于 pending 或 running 时，两者都被拒绝。撤销（`proj.undo`）把 `main` 后退一个变化（整个被接受的草稿，或直接写在 `main` 上的一条记录），方法是追加一条记录，其 `params.to` 指出 `main` 回到其状态的那条记录；重做（`proj.redo`）追加一条记录，让 `main` 回到那次撤销之前的状态，之后 `main` 上的任何变化都使重做不再可用。记录从不被改写或删除。`proj.branch_create` 在任意记录或分支头处开始一个探索分支 `explore/<name>`，`proj.branch_switch` 把会话切换到它或切回 `main`。

## 智能体集成

[`@dv/agent-integration`](../../packages/dv/agent-integration/README.zh.md) 把 DSH 智能体循环接到项目组件上。它把每个智能体轮次和开启该轮次的人的原话报告给 `dvProject`，使该轮次的记录带上轮次并跟在该轮次的请求记录之后；它用 `asset.import` 导入用户在对话中附上的图片；它把 DSH 提问规则注册为 `dvProject` 的工具调用检查：`plan.approve` 调用除非带 `user_approved: true`，否则询问用户，问题中列出这次批准要渲染的镜头及其 GPU 预估；`shot.render` 调用在本轮次已花费的 GPU 秒数加上本次调用的预估超过 `confirmGpuSecondsThreshold` 且调用没有带 `user_requested: true` 时询问。会话处于先问模式时，运行器为 `agent_ask_first` 操作显示的批准卡片就是这个问题；否则在挂载了 DSH user-questions 服务时，规则通过它询问在线根智能体的用户；再否则，工具结果告诉模型在对话中询问，然后带上该标志重新调用。规则只负责询问：只有运行器强制执行 `confirm`。对话的草稿跨越多个轮次，直到人接受或丢弃它；会话处于先问模式时，`confirm: agent_ask_first` 的操作等待输入框的批准卡片。一节系统提示词携带会话当前分支的状态（角色、场景和风格，时间线及其片段，版本，过期记录，计划，草稿），让模型把指代解析成具体 ID，`video-directing`、`timeline-editing` 和 `branching-story` 三个 skill 承载工作流程。同一个包保存每个对话的输入框模式，持有批准卡片，并把用户消息里的 `dv:` 提及展开成它们所指的具体记录和素材 ID。[`@dv/bundle`](../../packages/bundle/dv/README.zh.md) 把这一切组成 `video-harness` 和 `video-harness-headless` 两个 profile。

## API 和视图

[`@dv/api`](../../packages/dv/api/README.zh.md) 是项目组件面向浏览器的 HTTP 面：`/api/dv/state` 把一个分支的状态返回为一份 JSON 文档，`/api/dv/operations` 列出已注册的操作，`/api/dv/operation` 以用户身份运行一个操作，其记录带 `surface: 'canvas'`、`'timeline'` 或 `'asset_pool'`，`/api/dv/history` 返回历史的一页，`/api/dv/drafts/accept`、`/api/dv/drafts/discard`、`/api/dv/undo`、`/api/dv/redo`、`/api/dv/branches/create`、`/api/dv/branches/switch` 和 `/api/dv/stale/accept` 暴露草稿、撤销、重做、分支和过期操作，`/dv/events` 推送每一次记录和分支变化。

界面各包是 web 应用的右侧栏标签类型和中央视图，因此在同一个 profile 里与对话页并存。[`@dv/ui-shell`](../../packages/dv/ui-shell/README.zh.md) 把项目工作区放在中央，把 对话 / Chat 和 轨迹 / Trajectory 标签放在右侧。[`@dv/ui-canvas`](../../packages/dv/ui-canvas/README.zh.md) 把所示分支的记录按素材流向画成 DAG：角色、场景和风格是源头，每个分镜计划一个节点并可在其版次间切换，版本挨着它所基于的记录，打开的草稿用虚线，过期记录有标记；它的编辑器把修改后的记录写成替代记录或新版本。[`@dv/ui-timeline`](../../packages/dv/ui-timeline/README.zh.md) 把每条时间线画成一条轨道，把插入、移动、移除、拆分和裁剪手势变成按 `ClipId` 指定片段的 `timeline.*` 记录，把导出变成一条 `deliver.timeline_export` 记录。`@dv/ui-asset-pool` 列出项目的素材并导入文件，`@dv/ui-composer` 为对话输入框加上批准卡片、渲染卡片和 `@` 提及。画布和时间线编辑器显示 [`@dv/ui-kit`](../../packages/dv/ui-kit/README.zh.md) 的当前分支栏：它写出该视图的编辑写入哪个分支（当前分支：草稿 / Working branch: Draft，否则为 `main`），并接受或丢弃打开的草稿。每次丢弃都经过同一个确认对话框，它显示服务端报告的智能体修改数和人的编辑数，并带着这些数目发送丢弃；若草稿在此期间有变化，服务端以 `draft_changed` 拒绝，对话框显示当前的数目。没有视图保存项目状态：每个视图渲染宿主发来的东西，每次事件都重新拉取，并把选中的节点或片段报告给 `/api/dv/selection`，以便告诉智能体用户指向了什么。

## 历史和轨迹

历史是项目按顺序排列的记录，来自每个发起者、视图和对话；轨迹是智能体在一个对话中的步骤。记录通过它的 `session` 和 `tool_call` 字段把两者连起来。[`@dv/ui-history`](../../packages/dv/ui-history/README.zh.md) 是历史面板（标签类型 `dv-history`）：每条操作记录一行，最新的在前，显示动作、谁做的（你 / You、智能体 / Agent、自动 / Automatic）、状态、一张输出缩略图和一个标记（草稿 / Draft、已接受、已撤销、已丢弃、已重放或探索分支名）；批准分镜计划时排定的记录折叠在该批准行之下。选中一行会在画布上聚焦该记录的节点（`dv:canvas-focus`）或在时间线上聚焦它的片段（`dv:timeline-focus`）；行内的 在轨迹中查看 / Show in trajectory 链接发出 `dv:trajectory-focus`，`@dv/ui-shell` 随即在那个对话的那次工具调用处打开 轨迹。在对话中，写入记录的工具的每个已结束行都有 在历史中查看 / Show in history 链接，它发出 `dv:history-focus`，让历史面板选中那次工具调用写入的记录。

## 过期

项目组件的归约函数标记过期记录，不重跑任何东西。当一条记录在 `supersedes` 中列出记录 X 时，每条读取了 X 的输出的记录，以及这类记录下游的每条记录，都变为过期；之后读取的输入若其产生者已被替代或已过期，该记录也过期。输入的产生者是创建其素材的记录；对角色、场景或风格的版本，是写入该版本的记录。调用替代哪些记录由所属操作通过 `OperationSpec.supersedes` 决定：`bible.character_update`、`bible.location_update` 和 `bible.style_update` 替代创建上一版本的记录，因此读取了上一版本的每条记录都过期。调用方也可以在 `supersedes` 中指定记录，智能体为替换某个镜头的重拍就这样做。过期记录只在智能体或人决定时重跑；`proj.stale_accept` 清除一条记录的标记，并使其消费者不再因它而过期。

## 确定性复用

当 `deterministic: true` 的操作以与一条更早的 `done` 记录相同的操作和版本、相等的参数和相同的已解析输入素材被调用时，运行器复用那条记录的输出而不运行该操作；本次调用仍被记录，并带 `cost.reused: true`。渲染不是确定性的：再次渲染一个镜头得到一个新版本，即一条 `based_on` 指向更早那次渲染的 `shot.render` 记录，镜头渲染的归约函数把一个镜头的各版本归到它的第一次渲染之下。

<a id="glossary"></a>
## 术语表

代码、记录字段、工具描述、文档和界面文案都使用这些名称，每个名称只有一个含义。zh / en 一列是界面显示的文案。

### 概念

| 术语           | zh / en 文案              | 含义                                                                                         |
| -------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| component      | 组件 / Component          | 拥有一项能力的插件：它的实现、数据、操作、归约函数和工具。                                   |
| integration    | 集成 / Integration        | 把人或智能体连到组件、自身不拥有能力的插件。                                                 |
| operation      | 操作 / Operation          | 组件实现的一个改变项目的动作，或它提供的一次读取。                                           |
| record         | 记录 / Record             | 一次操作调用写入的一条日志，或一个轮次的 `request` 记录。                                    |
| tool           | 工具 / Tool               | 智能体可以调用的东西；组件工具（智能体工具 / agent tool）包装一个操作。                      |
| reducer        | —                         | 组件的一个函数，把它的记录变成项目状态中它的切片。                                           |
| turn           | 轮次 / Turn               | 智能体从一个请求到它的回复的一次运行。                                                       |
| draft          | 草稿 / Draft              | 一个对话打开的分支；它跨越多个轮次，保存智能体的记录和人的编辑。                             |
| branch         | 分支 / Branch             | 一条有名字的记录线；`main` 是已接受的项目。                                                  |
| working branch | 当前分支 / Working branch | 一个对话中的人和智能体写入的分支：它的草稿，否则为 `main`。                                  |
| history        | 历史 / History            | 项目按顺序排列的记录。                                                                       |
| trajectory     | 轨迹 / Trajectory         | 智能体在一个对话中的步骤。                                                                   |
| surface        | 来源 / Surface            | 记录字段，写出调用来自哪里：`chat`、`canvas`、`timeline`、`asset_pool`、`history` 或 `api`。 |

### ID 和类型

| 术语      | 类型                  | ID                                                | 所属     | zh / en 文案                                                        |
| --------- | --------------------- | ------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| project   | `Project`             | `ProjectId`                                       | 项目     | 项目 / Project                                                      |
| record    | `ProjectRecord`       | `RecordId`                                        | 项目     | 记录 / Record                                                       |
| branch    | `Branch`              | 名称：`main`、`draft/<session>`、`explore/<name>` | 项目     | 分支 / Branch                                                       |
| turn      | —                     | `TurnId`                                          | 项目     | 轮次 / Turn                                                         |
| asset     | `Asset`               | `AssetId`                                         | 素材库   | 素材 / Asset                                                        |
| still     | `Asset`               | `AssetId`                                         | 素材库   | 静帧 / Still                                                        |
| character | `Character`           | `CharacterId`，版本 `<id>@<version>`              | 设定库   | 角色 / Character                                                    |
| location  | `Location`            | `LocationId`，版本 `<id>@<version>`               | 设定库   | 场景 / Location                                                     |
| style     | `Style`               | `StyleId`，版本 `<id>@<version>`                  | 设定库   | 风格 / Style                                                        |
| plan      | `Plan`、`PlanVersion` | `PlanId`（`p1`、`p2`、…），版次 `p1@2`            | 分镜     | 分镜计划 / Plan；分镜计划的版本叫版次                               |
| shot      | `Shot`                | 它在计划中从 1 起的位置                           | 分镜     | 镜头 / Shot                                                         |
| take      | `Take`                | `TakeId`                                          | 镜头渲染 | 版本 / Take                                                         |
| timeline  | `Timeline`            | `TimelineId`（`t1`、`t2`、…）                     | 时间线   | 时间线 / Timeline；没有名字的时间线显示为 时间线 {n} / Timeline {n} |
| clip      | `Clip`                | `ClipId`（`cl1`、`cl2`、…）                       | 时间线   | 片段 / Clip                                                         |

记录类型叫 `ProjectRecord`，因为 `Record` 是 TypeScript 内置类型。智能体把引用写成 `<asset>`、`<record>#<output>` 或 `<id>@<version>`。

### 组件和集成

| 组件                 | 键         | 包                | 服务           | 操作                                                                                                                                                                                                                        |
| -------------------- | ---------- | ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project 项目         | `proj`     | `@dv/project`     | `dvProject`    | `proj.create` `proj.draft_accept` `proj.draft_discard` `proj.undo` `proj.redo` `proj.branch_create` `proj.branch_switch` `proj.stale_accept`；读取工具 `dv_proj_open` `dv_proj_state` `dv_proj_history_list` `dv_proj_wait` |
| Asset pool 素材库    | `asset`    | `@dv/asset-pool`  | `dvAssetPool`  | `asset.import` `asset.grab_still`                                                                                                                                                                                           |
| Story bible 设定库   | `bible`    | `@dv/story-bible` | `dvStoryBible` | `bible.character_create` `bible.character_update` `bible.location_create` `bible.location_update` `bible.style_create` `bible.style_update`                                                                                 |
| Shot plan 分镜       | `plan`     | `@dv/shot-plan`   | `dvShotPlan`   | `plan.create` `plan.update` `plan.approve`                                                                                                                                                                                  |
| Shot render 镜头渲染 | `shot`     | `@dv/shot-render` | `dvShotRender` | `shot.render`                                                                                                                                                                                                               |
| Timeline 时间线      | `timeline` | `@dv/timeline`    | `dvTimeline`   | `timeline.create` `timeline.update` `timeline.rename` `timeline.delete` `timeline.clip_insert` `timeline.clip_move` `timeline.clip_remove` `timeline.clip_split` `timeline.clip_trim` `timeline.clip_replace`               |
| Deliver 交付         | `deliver`  | `@dv/deliver`     | `dvDeliver`    | `deliver.timeline_export`                                                                                                                                                                                                   |
| Inspector 检查器     | `inspect`  | `@dv/inspector`   | `dvInspector`  | 读取 `inspect.image` `inspect.asset`                                                                                                                                                                                        |

操作名为 `<key>.<verb>` 或 `<key>.<object>_<verb>`，它的智能体工具名是 `dv_` 加上把 `.` 换成 `_` 的操作名（`timeline.clip_move` → `dv_timeline_clip_move`）。模型读到的文字写工具名，从不写操作名。集成各包是 API 接口（`@dv/api`，`dvApi`）、智能体集成（`@dv/agent-integration`，`dvAgentIntegration`）、bundle（`@dv/bundle`）和界面（`@dv/ui-shell`、`@dv/ui-canvas`、`@dv/ui-timeline`、`@dv/ui-asset-pool`、`@dv/ui-composer`、`@dv/ui-history`，以及库 `@dv/ui-kit`）。以产品命名的名称用 `dv`：路由 `/api/dv/…` 和 `/dv/events`、窗口事件 `dv:…`、页面全局变量 `__dv…`、测试 ID `dv-<area>-<thing>`。

### 动词

每个动词只有一个含义：

| 动词                                              | 含义                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `create` `update` `delete` `rename`               | 项目、角色、场景、风格、分镜计划和时间线。                       |
| `import`                                          | 把文件导入素材库。                                               |
| `grab`                                            | 从视频截取静帧。                                                 |
| `render`                                          | 把镜头变成版本。                                                 |
| `export`                                          | 把时间线变成一个视频素材。                                       |
| `insert` `move` `remove` `split` `trim` `replace` | 片段。                                                           |
| `approve`                                         | 分镜计划的一个版次，或一次等待确认的渲染。                       |
| `accept`                                          | 草稿（`proj.draft_accept`），或过期记录（`proj.stale_accept`）。 |
| `discard`                                         | 草稿。                                                           |
| `undo` `redo`                                     | `main` 上的一个变化。                                            |
| `inspect`                                         | 对图片或素材的只读分析。                                         |
| `get` `list`                                      | 按 ID 读取一个；读取多个。                                       |
| `switch`                                          | 把对话移到另一个分支。                                           |

### 界面文案

| zh                                                   | en                                                             | 用途                                             |
| ---------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| 渲染镜头 / 渲染新版本                                | Render shot / Render new take                                  | 渲染镜头；渲染 是 render 的 zh 动词。            |
| 渲染前先问 / 直接渲染                                | Ask first / Render directly                                    | 智能体渲染的输入框模式。                         |
| 渲染结果                                             | Rendered                                                       | 版本的素材筛选。                                 |
| 导入                                                 | Imported                                                       | 导入文件的素材筛选。                             |
| 参考图                                               | Reference images                                               | 角色、场景、风格或镜头据以渲染的图片。           |
| 场景和风格                                           | Locations and styles                                           | 设定库中 角色 / Characters 之后的部分。          |
| 新建时间线 / 修改时间线                              | Create timeline / Update timeline                              | 添加时间线或替换其片段的时间线操作。             |
| 插入片段 / 移动片段 / 移除片段 / 拆分片段 / 裁剪片段 | Insert clip / Move clip / Remove clip / Split clip / Trim clip | 片段操作；文案中片段显示为 片段 N / Clip N。     |
| 当前分支：{branch}                                   | Working branch: {branch}                                       | 当前分支栏。                                     |
| 丢弃草稿？ / 丢弃                                    | Discard the draft? / Discard                                   | 丢弃确认对话框；丢弃 是各处 discard 的 zh 动词。 |
| 仍然保留                                             | Keep anyway                                                    | `proj.stale_accept` 唯一的标签。                 |
| 分镜计划版次 / v{version}                            | Plan versions / v{version}                                     | 画布上分镜计划各版次间的切换。                   |
| 你 / 智能体 / 自动                                   | You / Agent / Automatic                                        | 历史面板中的发起者。                             |
| 渲染 {n} 个镜头                                      | Render {n} shots                                               | 批准时排定的渲染的折叠开关。                     |
| 已接受 / 已撤销 / 已丢弃 / 已重放                    | Accepted / Undone / Discarded / Replayed                       | 草稿 / Draft 之外的历史标记。                    |
| 发起者 / 操作类型                                    | Actor / Operation kind                                         | 历史筛选。                                       |
| 在历史中查看 / 在轨迹中查看                          | Show in history / Show in trajectory                           | 对话和历史面板之间的链接。                       |
