# DreamVerse 各包

[English](video-harness.md) | 中文

DreamVerse 各包是 DeepSeek Harness 内视频制作的项目层。本页定义 `packages/dv/` 下这些包和 [`packages/video-harness/`](../../packages/video-harness/README.zh.md) 包组的词汇和跨包规则：分层及其角色、生成方式、操作记录、[历史规则](#history-rules)、视图和智能体如何写入、在对话中确认、项目状态、智能体读到什么、过期、[新行为的归属位置](#where-new-behavior-goes)，以及代码、记录、工具和界面文案所用名称的[术语表](#glossary)。各包 README 各自说明配置和服务 API。

## 分层和角色

```text
views          @dv/ui-shell @dv/ui-canvas @dv/ui-timeline @dv/ui-asset-pool @dv/ui-composer @dv/ui-history (+ library @dv/ui-kit)
  │ HTTP: /api/dv/…, /dv/events
  ▼
API            @dv/api                    routes that read state and run operations as the user; the event stream
  │ dvProject.run, getState, listHistory
  ▼
registry       @dv/project                records, the history line, undo, state, agent tools, the dv:project prompt section
  ▲ registerOperation, registerReducer             ▲ dvProject.run (asset.import, asset.place), current-state reads
  │                                                │
components     @dv/asset-pool @dv/story-bible      chat references   @dv/chat-references   dv: mentions, chat images
               @dv/shot-plan @dv/shot-render
               @dv/timeline @dv/deliver @dv/inspector
  │ ctx.dvRef2va, ctx.dvT2va (Consumer: @dv/shot-render)
  ▼
render modes   @dv/render-modes           Service Definitions dvRef2va, dvT2va
  ▲ subclass and register the service
  │
providers      @dv/fasth3-ref2va @dv/fasth3-t2va   each with its prompt skill

bundle         @dv/bundle                 the cordis.patch.yml rows of every package above, the video-directing skill
```

每个箭头从一个包指向它所依赖的包，没有反方向的依赖。一个组件只通过 `dvProject.run` 按名字运行另一个组件的操作。用 DeepSeek Harness 的术语说，各层的角色如下：

| 层      | 包                                                                                                                                                                                                                                                                     | 角色                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 注册表    | [`@dv/project`](../../packages/dv/project/README.zh.md)                                                                                                                                                                                                               | `dvProject` 服务：组件向它注册操作和归约函数，就像工具向 `ctx.tools` 注册一样。它是项目文件唯一的写入者，把每个操作变成一个 DSH 工具，并注册 `dv:project` 系统提示词段。          |
| 组件     | `@dv/asset-pool`、`@dv/story-bible`、`@dv/shot-plan`、`@dv/shot-render`、`@dv/timeline`、`@dv/deliver`、`@dv/inspector`                                                                                                                                                     | 各自拥有一项能力的插件：它的数据（一个状态切片及其归约函数）、它的操作，以及智能体读到的关于它们的文字。外部程序经 [`@dv/ffmpeg`](../../packages/dv/ffmpeg/README.zh.md) 运行。 |
| 生成方式   | [`@dv/render-modes`](../../packages/dv/render-modes/README.zh.md)、[`@dv/fasth3-ref2va`](../../packages/dv/fasth3-ref2va/README.zh.md)、[`@dv/fasth3-t2va`](../../packages/dv/fasth3-t2va/README.zh.md)、[`@dv/shot-render`](../../packages/dv/shot-render/README.zh.md) | 每种生成方式一个能力 seam：`@dv/render-modes` 持有 Service Definition，两个 FastH3 包是 Service Provider，镜头渲染是 Consumer。              |
| API    | [`@dv/api`](../../packages/dv/api/README.zh.md)                                                                                                                                                                                                                       | DSH `connection` 服务上的 Fetch 路由和 `webServer` 上的事件流；视图读取或修改项目的唯一途径。                                                   |
| 对话引用   | [`@dv/chat-references`](../../packages/dv/chat-references/README.zh.md)                                                                                                                                                                                               | `agent/pre-step` 和 `session/event` 上的监听器，把用户在对话消息中指向的东西变成项目 ID 和素材。                                                 |
| 视图     | `@dv/ui-*`                                                                                                                                                                                                                                                            | DSH Web 客户端的右侧栏标签类型和中央视图；`@dv/ui-kit` 是它们共用的库。                                                                      |
| bundle | [`@dv/bundle`](../../packages/bundle/dv/README.zh.md)                                                                                                                                                                                                                 | profile 层：把每一行组成 `video-harness` 和 `video-harness-headless` 两个 profile，并附带 `video-directing` skill。                 |

组件用 `dvProject.registerOperation` 注册操作，用 `dvProject.registerReducer` 注册归约函数。每个操作同时是智能体工具 `dv_<操作名，点换成下划线>`，一次调用成为一条记录。素材库的 `dv_asset_import` 和 `dv_asset_grab_still` 添加素材，`dv_asset_place` 和 `dv_asset_unplace` 把素材放到画布上和从画布移除；设定库的 `dv_bible_*` 工具创建和更新角色、场景和风格的版本；分镜的 `dv_plan_create` 写入一个新分镜计划的版次 1，该计划得到一个 `PlanId`（`p1`、`p2`、…），`dv_plan_update` 写入 `plan` 参数所指计划的下一个版次，`dv_plan_approve` 批准一个版次；镜头渲染的 `dv_shot_render_ref2va` 和 `dv_shot_render_t2va` 按各自的[生成方式](#render-modes)渲染镜头的一个版本，`duration_sec` 是所用模型范围内的整秒数（默认为模型的最小值）；时间线的 `dv_timeline_*` 工具创建、更新、重命名和删除时间线，并插入、移动、移除、拆分、裁剪和替换片段，不创建文件；交付的 `dv_deliver_timeline_export` 把一条时间线写成一个视频；检查器的 `dv_inspect_image` 和 `dv_inspect_asset` 读取素材，不写记录。项目组件自己的 `dv_proj_*` 工具创建和打开项目、读取状态和历史、撤销、接受过期记录，以及等待排定的记录。操作声明资源类别（`none`、`cpu`、`gpu`）和确认策略（`never`、`always`、`over_gpu_budget`；见[在对话中确认](#confirmation-in-the-conversation)）；项目组件的调度器按类别并发上限运行排定的记录。

批准分镜计划时，以 `system` 发起者为所批准版次中每个新增或改动的镜头运行一次该镜头的渲染操作（`shot.render_<mode>`），参数为 `plan`、`plan_version` 和 `shot`（镜头从 1 起的位置，镜头在各版次间保持这个编号）。若当前状态中同一计划有一条同一渲染操作的 `done` 记录，其参数除 `plan`、`plan_version` 和 `shot` 外相同，参考图输入相同，首帧也相同，则该镜头未改动；批准复用最新的这样一个版本而不渲染。随后它对该计划的时间线（最新的创建或修改记录指向该计划的那条时间线）运行一次 `timeline.update`，按镜头顺序放入每个镜头的版本，计划还没有时间线时则运行一次 `timeline.create`；渲染尚未完成的镜头先显示为占位片段，直到渲染完成。批准在 `report.scheduled` 中列出排定的记录。片段有一个 `ClipId`（`cl1`、`cl2`、…），由插入它的时间线操作分配并存入记录的 `report.clips`；该 ID 在项目内唯一、从不复用，每个片段操作都用 `clip` 参数按它指定片段。

<a id="render-modes"></a>
## 生成方式

生成方式是镜头由其输入渲染出来的方式。`ref2va` 由一段提示词、1 到模型 `maxReferenceImages` 张参考图和一张可选的首帧渲染；`t2va` 只由一段提示词渲染。每种生成方式都返回一段带音频的视频及其最后一张静帧，镜头渲染把两者存为一个版本的两个输出。

每种生成方式各自是一个能力 seam。Service Definition 是 `@dv/render-modes` 中的抽象类（`Ref2vaRenderer` 即 `ctx.dvRef2va`，`T2vaRenderer` 即 `ctx.dvT2va`），方法为 `model()`、`ready()` 和 `render(request, signal)`。Service Provider 为一个后端继承该抽象类：`@dv/fasth3-ref2va` 和 `@dv/fasth3-t2va` 服务 FastVideo streaming_v2 服务器背后的 FastH3 模型，并各自用 `ctx.skills` 注册自己的提示词 skill（`fasth3-ref2va-prompting`、`fasth3-t2va-prompting`）。Consumer 是 `@dv/shot-render`：它只在 `dvRef2va` 挂载时注册 `shot.render_ref2va`，只在 `dvT2va` 挂载时注册 `shot.render_t2va`，因此只有部署所服务的生成方式才有对应的 `dv_shot_render_<mode>` 工具。`DV_T2VA_BACKEND_URL` 未设置时，bundle 禁用 `dv-fasth3-t2va` 这一行。

`shot.render_ref2va` 的 precondition 对每个调用方都拒绝没有参考图的调用；这条规则属于 `ref2va` 生成方式，`t2va` 渲染则完全没有参考图。分镜计划的每个镜头在 `mode` 中写明自己的生成方式，`continue_previous: true` 让一个 `ref2va` 镜头从上一个镜头的最后一张静帧开始。`plan.create`、`plan.update` 和 `plan.approve` 拒绝生成方式没有已注册渲染操作的镜头、带参考图的 `t2va` 镜头，以及镜头 1 或 `t2va` 镜头上的 `continue_previous`。

## 操作记录

项目的每次变化都是项目 `records.jsonl` 文件中的一条记录，只有 `@dv/project` 读写这个文件。每条记录的 `kind` 都是 `'operation'`：它是一次操作调用。一条记录包含：谁（`actor`：`user`、`agent` 或 `system`）、来源（`surface`：`chat`、`canvas`、`timeline`、`asset_pool`、`history` 或 `api`）、原因（`intent`：智能体的 `reason` 参数，或对人的手势的简短描述）、所属组件（`component`）和操作（`operation`）及其版本、参数、各输入及其解析到的素材（`resolved_asset`）、输出、状态、父记录，以及两个链接：`based_on`（本记录带修改地重复那条记录，例如改了提示词的新版本）和 `supersedes`（本记录替代那些记录的输出）。字段 `session`、`turn` 和 `tool_call` 把记录链接到产生它的对话的 DSH 会话日志：对话 ID、该会话的 DSH 轮次编号和工具调用 ID；对话本身留在会话日志中。记录只追加不改写；状态变化、成本和报告以更新行追加。每条记录的父记录是紧挨在它之前写入的记录，所以一个项目的记录排成一条线，最后一条记录是项目的 head。项目组件自己的动作也是记录（`proj.create`、`proj.undo`、`proj.stale_accept`），而 `dv_proj_state`、`dv_proj_history_list` 和 `inspect.*` 操作这类读取不写记录。

<a id="history-rules"></a>
## 历史规则

这些规则说明哪些修改是历史中的步骤。这些规则也说明"回到"和撤销做什么。这些规则适用于用户、智能体和系统。

1. **修改项目内容是一步。** 项目内容是素材、画布上的素材、设定库、分镜计划、渲染、时间线和导出。修改视图不是一步。视图是平移、缩放、节点位置、选中项、所显示的视图和打开的面板。修改项目名称不是一步。删除项目不是一步。
2. **历史只增长。** 每一步都加在历史的末尾。一步进入历史后不再改变。没有操作会从历史中删除一步。历史不分叉。用户的步骤和智能体的步骤在同一条线上，按时间顺序排列。
3. **"回到"和撤销会加一步。**
   - 回到某一步时，历史末尾会加一个新步骤。这个新步骤让当前状态等于所选步骤刚完成时的状态。所选步骤之后的步骤留在历史中。以后可以回到这些步骤。
   - 撤销让当前状态后退一步。Ctrl+Z、撤销按钮和不带 `to` 的 `dv_proj_undo` 都执行撤销。每多撤销一次，就再后退一步。没有重做。要取消一次撤销，就回到那次撤销之前的一步。
4. **导入的素材一直保留；生成的素材跟随当前状态。**
   - 导入的素材是某一步导入的素材。导入的素材在整个历史中都留在素材库中。撤销不会去掉导入的素材。"回到"也不会去掉导入的素材。
   - 生成的素材是某一步生成的素材，例如渲染、静帧或导出。只有当生成它的那一步在当前状态中时，素材库才显示这个生成的素材。撤销或"回到"把那一步移出当前状态后，素材库不显示这个生成的素材。那一步回到当前状态后，素材库再次显示这个生成的素材。
   - 所有素材的文件都留在磁盘上。
5. **回到之前的步骤后，渲染继续运行。** 回到更早的一步时，如果有渲染正在运行，这个渲染会继续运行。这一步渲染留在历史中。渲染完成后，该渲染在历史中的那一行显示结果。要使用这个结果，就回到那一行。

`@dv/project` 实现这些规则。每次写入都把记录追加在项目最后一条记录之后。"回到"或撤销会追加一条 `proj.undo` 记录，其 `params.to` 指出项目回到其状态的那条记录：撤销时是当前状态最后一步之前的记录，"回到"时是所选的记录。`dvProject.undo` 拒绝尚未结束的记录（`invalid_params`），也拒绝项目已经显示其状态的记录（`nothing_to_undo`）。

## 操作如何运行

视图和智能体到达同样的操作。画布、时间线、素材库面板或历史面板上的手势通过 `@dv/api` 的路由运行一个操作，带 `actor: 'user'`，`surface` 设为该视图。智能体调用该操作的 `dv_*` 工具，工具以 `actor: 'agent'`、`surface: 'chat'`、对话、轮次和工具调用 ID 运行它。智能体的调用运行之前，操作的 `prepareToolCall` 可以拒绝或修改它，然后项目组件应用该操作的 `confirm` 策略。每次调用都经过 `dvProject.run` 的运行器。运行器先校验参数；然后在项目锁内把每个输入解析为素材，并调用操作的 `precondition`，它在写入任何记录之前拒绝调用，对每个调用方都生效（`shot.render_ref2va` 和 `plan.approve` 拒绝没有参考图的 `ref2va` 渲染）。运行器随后追加 `pending` 记录，并把操作自己的 `supersedes` 指出的记录加入该记录的 `supersedes`。最后运行器在锁外运行所属组件的实现，并追加带输出、成本和报告的最终更新行。输入指向未完成记录的调用，以及批准计划时排定的每次渲染，都在项目组件的调度器中等待，直到其输入完成。

<a id="confirmation-in-the-conversation"></a>
## 在对话中确认

智能体在对话中征得用户同意，问题用粗体显示。`OperationSpec.confirm` 声明智能体的调用何时需要这一同意：

| `confirm`         | 仅工具参数            | 智能体调用被拒绝的条件                                                                          | 操作                                      |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| `never`           | —                | 从不                                                                                   | 其他所有操作                                  |
| `always`          | `user_approved`  | 没有带 `user_approved: true`                                                            | `plan.approve`                          |
| `over_gpu_budget` | `user_requested` | 没有带 `user_requested: true`，且本轮次的 GPU 秒数超过 `dvProject` 的 `confirmGpuSecondsThreshold` | `shot.render_ref2va`、`shot.render_t2va` |

本轮次的 GPU 秒数是本轮次已完成记录的成本、未完成记录的 `estimate`，加上本次调用的 GPU 预估。`confirm` 不为 `never` 的操作提供 `confirmSummary(call, state)`，它返回 `{text, gpu_seconds}`：调用将做什么（对 `plan.approve`，每个镜头一行，写出其生成方式、时长、是否接上一镜头和提示词）及其 GPU 预估。拒绝是一个工具错误，它带着这段文字，并告诉智能体把它展示给用户、在对话中用粗体提问，在用户同意后带上该参数重新调用。被拒绝的调用不写入任何东西，该参数从不进入记录的参数，人和 system 的调用从不被拒绝。

## 项目状态

归约函数读取记录并计算状态；它不写记录。运行器和记录存储是仅有的写入者。当前状态是把项目最后一条记录的有效链交给归约函数折叠的结果：项目组件从这条记录往回走，遇到 `proj.undo` 记录时跳到其 `params.to` 所指的记录，再把保留下来的记录按从旧到新的顺序交给每个已注册的归约函数。每个组件的归约函数把自己的记录变成 `ProjectState.components` 中自己的切片（设定库 `bible`、分镜 `plan`、镜头渲染 `shot`、时间线 `timeline`），项目组件自己的归约函数维护 `proj` 切片：有效链上的记录、过期和被替代的记录，以及创建每个素材的记录。归约函数的 `agentSummary` 把该组件的字段加入 `dv_proj_*` 工具和 `dv:project` 提示词段交给智能体的项目摘要。

视图显示的要么是记录，要么是状态。历史面板列出记录：项目的每一条记录，最新的在前，包括 `proj.undo` 记录。画布、时间线编辑器和素材库面板显示状态：当前状态，因此撤销或"回到"会改变它们画出的内容。素材库面板列出当前状态中的每个素材，以及历史中每个导入的素材（[历史规则](#history-rules)第 4 条）。没有视图持有项目状态：每个视图获取当前状态，并在实时事件流的每个事件后重新获取。

## 智能体读到什么

智能体通过三个渠道读取项目，每个渠道归拥有其内容的包所有：

- **工具。** 每个操作的 `description` 说明它的工具怎么用；[`@dv/project`](../../packages/dv/project/README.zh.md) 根据 `OperationSpec` 构建工具。
- **`dv:project` 提示词段。** `@dv/project` 在 DSH `systemPrompt` 服务挂载时注册它。它先写项目组件的规则（只增长的一条历史线，带或不带 `to` 的撤销作为一条新记录，如何称呼记录、素材、版本和片段，在对话中确认，过期记录），再写当前状态的项目摘要。它不包含用户看不到的任何东西：没有视图中的选中项，也没有偏好。
- **对话引用。** [`@dv/chat-references`](../../packages/dv/chat-references/README.zh.md) 在 `agent/pre-step` 把输入框为 `@` 和 `+ → 引用` 写下的 `dv:` 提及展开成一条带具体记录和素材 ID 的上下文消息，以用户身份用 `asset.import` 导入用户在对话中附上的图片，并把这些图片和消息提及的素材放到画布上；会话的下一次工具调用等待导入完成。

skill 承载工作流程和模型专属的规则，各由其主人注册：

| Skill                                             | 主人                                                                              | 注册途径                  | 内容                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| `video-directing`                                 | [`@dv/bundle`](../../packages/bundle/dv/README.zh.md)（`skills/video-directing`） | `skill-filesystem` 目录 | 跨组件的做计划流程：故事及其镜头、每个镜头的生成方式和输入、按生成方式的提示词 skill 写提示词、用户同意的分镜计划，然后渲染和重拍 |
| `timeline-editing`                                | [`@dv/timeline`](../../packages/dv/timeline/README.zh.md)                       | `ctx.skills`          | 编辑时间线和片段                                                             |
| `fasth3-ref2va-prompting`、`fasth3-t2va-prompting` | 各生成方式的 Service Provider                                                         | `ctx.skills`          | 该生成方式下模型的限制和提示词规则                                                    |

## API 和视图

[`@dv/api`](../../packages/dv/api/README.zh.md) 是项目组件面向浏览器的 HTTP 面：`/api/dv/state` 把项目的当前状态返回为一份 JSON 文档，`/api/dv/operations` 列出已注册的操作，`/api/dv/operation` 以用户身份运行一个操作，其记录带 `surface: 'canvas'`、`'timeline'` 或 `'asset_pool'`，`/api/dv/history` 返回历史的一页，`/api/dv/undo` 和 `/api/dv/stale/accept` 暴露撤销和过期操作，其他路由管理项目、素材导入、画布布局（节点位置和视口）和 Workspace 链接，`/dv/events` 推送每一次记录追加和记录更新。

界面各包是 web 应用的右侧栏标签类型和中央视图，因此在同一个 profile 里与对话页并存。[`@dv/ui-shell`](../../packages/dv/ui-shell/README.zh.md) 把项目工作区放在中央，把 对话 / Chat 和 轨迹 / Trajectory 标签放在右侧，把 画布 / Canvas 和 时间线 / Timeline 切换按钮放在顶栏，并把 Ctrl+Z 绑定到撤销。[`@dv/ui-canvas`](../../packages/dv/ui-canvas/README.zh.md) 把当前状态画成按素材流向相连的节点：处于当前版本的角色、场景和风格，导入的素材，处于最新版次的每个分镜计划（写出每个镜头的生成方式，设置了的写出 接上一镜头 / Continues the previous shot），以及带生成方式的版本；过期记录有标记，它的编辑器以用户记录渲染新版本或替换参考图。[`@dv/ui-timeline`](../../packages/dv/ui-timeline/README.zh.md) 把每条时间线画成一条轨道，把插入、移动、移除、拆分和裁剪手势变成按 `ClipId` 指定片段的 `timeline.*` 记录，把导出变成一条 `deliver.timeline_export` 记录。`@dv/ui-asset-pool` 列出项目的每个素材并导入文件；`@dv/ui-composer` 为对话加上 `@` 和 `+ → 引用` 引用、渲染卡片和面向创作者的工具名。

## 历史和轨迹

历史是项目按顺序排列的记录，来自每个发起者、视图和对话；轨迹是智能体在一个对话中的步骤。记录通过它的 `session` 和 `tool_call` 字段把两者连起来。[`@dv/ui-history`](../../packages/dv/ui-history/README.zh.md) 是历史面板（标签类型 `dv-history`）。它把项目的每一条记录各列为一行，最新的在前，显示动作、谁做的（你 / You、智能体 / Agent、自动 / Automatic）、状态和一张输出缩略图；最新的一行标 当前 / Current，撤销行写作 回到「…」 / Go back to “…” 并写出它回到的那一步，批准分镜计划时排定的记录折叠在该批准行之下。它的顶部放着撤销按钮。每一行的 ⋮ 菜单提供 回到这一步 / Go back to this step，它加一步，让项目回到紧接那一行之后的状态（[历史规则](#history-rules)）。选中当前状态中某条记录的那一行，会在画布上聚焦该记录的节点（`dv:canvas-focus`）或在时间线上聚焦它的片段（`dv:timeline-focus`）；行内的 在轨迹中查看 / Show in trajectory 链接发出 `dv:trajectory-focus`，`@dv/ui-shell` 随即在那个对话的那次工具调用处打开 轨迹。在对话中，写入记录的工具的每个已结束行都有 在历史中查看 / Show in history 链接，它发出 `dv:history-focus`，让历史面板选中那次工具调用写入的记录。

## 过期

项目组件的归约函数标记过期记录，不重跑任何东西。当一条记录在 `supersedes` 中列出记录 X 时，每条读取了 X 的输出的记录，以及这类记录下游的每条记录，都变为过期；之后读取的输入若其产生者已被替代或已过期，该记录也过期。输入的产生者是创建其素材的记录；对角色、场景或风格的版本，是写入该版本的记录。调用替代哪些记录由所属操作通过 `OperationSpec.supersedes` 决定：`bible.character_update`、`bible.location_update` 和 `bible.style_update` 替代创建上一版本的记录，因此读取了上一版本的每条记录都过期。调用方也可以在 `supersedes` 中指定记录，智能体为替换某个镜头的重拍就这样做。过期记录只在智能体或人决定时重跑；`proj.stale_accept` 清除一条记录的标记，并使其消费者不再因它而过期。

## 确定性复用

当 `deterministic: true` 的操作以与一条更早的 `done` 记录相同的操作和版本、相等的参数和相同的已解析输入素材被调用时，运行器复用那条记录的输出而不运行该操作；本次调用仍被记录，并带 `cost.reused: true`。渲染不是确定性的：再次渲染一个镜头得到一个新版本，即一条 `based_on` 指向更早那次渲染的渲染操作记录，镜头渲染的归约函数把一个镜头的各版本归到它的第一次渲染之下，不论每个版本用的是哪种生成方式。

<a id="where-new-behavior-goes"></a>
## 新行为的归属位置

DreamVerse 的新行为挂在某个包已拥有的扩展点上，就像 DeepSeek Harness 的新行为遵循[架构页](../architecture.zh.md)中“新行为的归属位置”一节那样。

### 原则

1. **每样东西只有一个主人。** 每份数据、每项能力、每段给智能体的文字都属于一个插件，由这个插件自己到扩展点上注册。
2. **插件能用一句话说出自己拥有什么。** 只能描述成“把 A 接到 B”的插件什么也不拥有，要拆分给 A 和 B 的主人。
3. **新行为挂在已有的扩展点上**，扩展点从下面的查表中选。
4. **只有可替换的能力才做成能力 seam。** 有两个或更多可互换实现的能力，才做成一个 Service Definition 包加若干 Service Provider 包。
5. **依赖只朝一个方向：** 视图 → `@dv/api` → `@dv/project` ← 组件 → Service Definition ← Service Provider。没有包反方向依赖，也没有包在代码里写死别的插件的操作名。
6. **给智能体的文字跟着主人走**，按下表放置：

| 文字讲的是                | 放在哪里                                                     |
| -------------------- | -------------------------------------------------------- |
| 一个组件的工具怎么用           | 该操作的 `description`                                       |
| 跨多个组件的做事流程           | `@dv/bundle` 中的一个 skill                                  |
| 模型的限制和提示词写法，例如必须有参考图 | 该模型的 Service Provider 的提示词 skill                         |
| 每轮都会变的项目状态           | `@dv/project` 的 `dv:project` 提示词段，经由归约函数的 `agentSummary` |

### 流程

加一样新东西时，按顺序回答这些问题：

1. 它是哪一类：项目数据、操作、可替换能力、模型、给智能体的文字、视图，还是接到智能体循环上的逻辑？
2. 它的主人是谁？没有包拥有它时，新建一个组件，并写下说明它拥有什么的那一句话。
3. 它挂在哪个扩展点上？查下面的查表。
4. 它需要可替换吗？需要就做成能力 seam；不需要，它就是普通插件中的一个注册项。
5. 它带不带给智能体的文字？带的话，按原则中的文字表把文字放到它的主人那里。

最后检查：主人的那一句话仍然成立；代码里没有写死另一个包的插件名；没有依赖违背原则 5 的方向。

### 查表

| 要加的东西       | 做法                                                             | 例子                            |
| ----------- | -------------------------------------------------------------- | ----------------------------- |
| 项目数据        | 加进主人组件的归约函数状态，并在 `agentSummary` 中给出摘要                          | 镜头的配乐                         |
| 操作          | 在主人组件中 `registerOperation`；项目组件据此生成工具、API 路由、历史和撤销             | `timeline.clip_split`         |
| 可替换能力       | 一个 Service Definition 包加若干 Service Provider 包；用到它的组件是 Consumer | 生成方式、3D 渲染                    |
| 模型          | 已有 seam 下的一个 Service Provider 包，带自己的提示词 skill                  | MiniMax H3 的 Service Provider |
| 给智能体的文字     | 按原则中的文字表放置                                                     | “先出分镜计划再渲染”                   |
| 视图          | 一个只通过 `@dv/api` 读写的 `@dv/ui-*` 插件                              | 画布                            |
| 接到智能体循环上的逻辑 | 由数据的主人在 DSH 事件上注册，例如 `agent/pre-step` 或 `tools/pre-execute`    | `dv:` 提及展开                    |

### 例子：不带参考图的渲染

1. 类别：一种生成方式，即一项可替换能力。
2. 主人：`t2va` seam；由模型支持 `t2va` 的 Service Provider 实现。
3. 扩展点：`@dv/render-modes` 定义 `dvT2va`，`@dv/fasth3-t2va` 提供它，`@dv/shot-render` 注册 `shot.render_t2va`，于是智能体得到工具 `dv_shot_render_t2va`。
4. 可替换：是；每种生成方式各自是一个 seam。
5. 文字：`t2va` 的提示词规则是该 Service Provider 的 skill `fasth3-t2va-prompting`；“每个镜头必须有参考图”只是 `ref2va` 的输入要求，写在 `dv_shot_render_ref2va` 的说明和 `ref2va` Service Provider 的 skill 里。

<a id="glossary"></a>
## 术语表

代码、记录字段、工具描述、文档和界面文案都使用这些名称，每个名称只有一个含义。zh / en 一列是界面显示的文案。

### 概念

| 术语              | zh / en 文案            | 含义                                                                                                                                          |
| --------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| component       | 组件 / Component        | 拥有一项能力的插件：它的实现、数据、操作、归约函数和工具。                                                                                                               |
| operation       | 操作 / Operation        | 组件实现的一个改变项目的动作，或它提供的一次读取。                                                                                                                   |
| record          | 记录 / Record           | 一次操作调用写入的一条日志。                                                                                                                              |
| tool            | 工具 / Tool             | 智能体可以调用的东西；组件工具（智能体工具 / agent tool）包装一个操作。                                                                                                  |
| reducer         | —                     | 组件的一个函数，读取记录并计算出项目状态中它的切片；它不写记录。DSH 中对应的是会话投影（`ctx.sessionProjections`），它折叠的是会话日志。                                                          |
| render mode     | 生成方式 / Render mode    | 镜头由其输入渲染出来的方式：`ref2va`（参考图生成 / From references：提示词加参考图）或 `t2va`（文字生成 / From text：只有提示词）。每种生成方式是一个能力 seam。                                   |
| capability seam | —                     | 一项可替换的能力，有三种角色：Service Definition（`@dv/render-modes`）、Service Provider（`@dv/fasth3-ref2va`、`@dv/fasth3-t2va`）和 Consumer（`@dv/shot-render`）。 |
| turn            | 轮次 / Turn             | 智能体从一条用户消息到它的回复的一次运行；记录用 DSH 轮次编号指出它。                                                                                                       |
| current state   | 当前 / Current          | 项目最后一条记录处的状态；每个视图显示它，每次写入都接在它之后。                                                                                                            |
| history         | 历史 / History          | 项目按顺序排列的记录：一条只增长的线（[历史规则](#history-rules)）。                                                                                                 |
| step            | 一步 / Step             | 历史中的一条记录；撤销让当前状态后退一步。`proj.create` 和 `proj.undo` 记录不算撤销的步骤。                                                                                 |
| trajectory      | 轨迹 / Trajectory       | 智能体在一个对话中的步骤。                                                                                                                               |
| surface         | 来源 / Surface          | 记录字段，写出调用来自哪里：`chat`、`canvas`、`timeline`、`asset_pool`、`history` 或 `api`。                                                                    |

### ID 和类型

| 术语        | 类型                   | ID                                | 所属   | zh / en 文案                                        |
| --------- | -------------------- | --------------------------------- | ---- | ------------------------------------------------- |
| project   | `Project`            | `ProjectId`                       | 项目   | 项目 / Project                                      |
| record    | `ProjectRecord`      | `RecordId`                        | 项目   | 记录 / Record                                       |
| turn      | —                    | `TurnId`                          | 项目   | 轮次 / Turn                                         |
| asset     | `Asset`              | `AssetId`                         | 素材库  | 素材 / Asset                                        |
| still     | `Asset`              | `AssetId`                         | 素材库  | 静帧 / Still                                        |
| character | `Character`          | `CharacterId`，版本 `<id>@<version>` | 设定库  | 角色 / Character                                    |
| location  | `Location`           | `LocationId`，版本 `<id>@<version>`  | 设定库  | 场景 / Location                                     |
| style     | `Style`              | `StyleId`，版本 `<id>@<version>`     | 设定库  | 风格 / Style                                        |
| plan      | `Plan`、`PlanVersion` | `PlanId`（`p1`、`p2`、…），版次 `p1@2`   | 分镜   | 分镜计划 / Plan；分镜计划的版本叫版次                            |
| shot      | `Shot`               | 它在计划中从 1 起的位置                     | 分镜   | 镜头 / Shot                                         |
| take      | `Take`               | `TakeId`                          | 镜头渲染 | 版本 / Take                                         |
| timeline  | `Timeline`           | `TimelineId`（`t1`、`t2`、…）         | 时间线  | 时间线 / Timeline；没有名字的时间线显示为 时间线 {n} / Timeline {n} |
| clip      | `Clip`               | `ClipId`（`cl1`、`cl2`、…）           | 时间线  | 片段 / Clip                                         |

记录类型叫 `ProjectRecord`，因为 `Record` 是 TypeScript 内置类型。智能体把引用写成 `<asset>`、`<record>#<output>` 或 `<id>@<version>`。一个 `Shot` 包含 `prompt`、`mode`（它的生成方式），以及可选的 `duration_sec`、`references`、`seed` 和 `continue_previous`。

### 组件和其他包

| 组件               | 键          | 包                 | 服务             | 操作                                                                                                                                                                                                            |
| ---------------- | ---------- | ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project 项目       | `proj`     | `@dv/project`     | `dvProject`    | `proj.create` `proj.undo` `proj.stale_accept`；读取工具 `dv_proj_open` `dv_proj_state` `dv_proj_history_list` `dv_proj_wait`                                                                                       |
| Asset pool 素材库   | `asset`    | `@dv/asset-pool`  | `dvAssetPool`  | `asset.import` `asset.grab_still` `asset.place` `asset.unplace`                                                                                                                                               |
| Story bible 设定库  | `bible`    | `@dv/story-bible` | `dvStoryBible` | `bible.character_create` `bible.character_update` `bible.location_create` `bible.location_update` `bible.style_create` `bible.style_update`                                                                   |
| Shot plan 分镜     | `plan`     | `@dv/shot-plan`   | `dvShotPlan`   | `plan.create` `plan.update` `plan.approve`                                                                                                                                                                    |
| Shot render 镜头渲染 | `shot`     | `@dv/shot-render` | `dvShotRender` | `shot.render_ref2va`（`dvRef2va` 挂载时）`shot.render_t2va`（`dvT2va` 挂载时）                                                                                                                                          |
| Timeline 时间线     | `timeline` | `@dv/timeline`    | `dvTimeline`   | `timeline.create` `timeline.update` `timeline.rename` `timeline.delete` `timeline.clip_insert` `timeline.clip_move` `timeline.clip_remove` `timeline.clip_split` `timeline.clip_trim` `timeline.clip_replace` |
| Deliver 交付       | `deliver`  | `@dv/deliver`     | `dvDeliver`    | `deliver.timeline_export`                                                                                                                                                                                     |
| Inspector 检查器    | `inspect`  | `@dv/inspector`   | `dvInspector`  | 读取 `inspect.image` `inspect.asset`                                                                                                                                                                            |

操作名为 `<key>.<verb>` 或 `<key>.<object>_<verb>`，它的智能体工具名是 `dv_` 加上把 `.` 换成 `_` 的操作名（`timeline.clip_move` → `dv_timeline_clip_move`）。模型读到的文字写工具名，从不写操作名。其他包是生成方式的 Service Definition `@dv/render-modes`（`dvRef2va`、`dvT2va`）及其 Service Provider `@dv/fasth3-ref2va` 和 `@dv/fasth3-t2va`、对话引用 `@dv/chat-references`（`dvChatReferences`）、API 接口（`@dv/api`，`dvApi`）、bundle（`@dv/bundle`）和界面（`@dv/ui-shell`、`@dv/ui-canvas`、`@dv/ui-timeline`、`@dv/ui-asset-pool`、`@dv/ui-composer`、`@dv/ui-history`，以及库 `@dv/ui-kit`）。以产品命名的名称用 `dv`：路由 `/api/dv/…` 和 `/dv/events`、窗口事件 `dv:…`、页面全局变量 `__dv…`、测试 ID `dv-<area>-<thing>`。

### 动词

每个动词只有一个含义：

| 动词                                                | 含义                                                  |
| ------------------------------------------------- | --------------------------------------------------- |
| `create` `update` `delete` `rename`               | 项目、角色、场景、风格、分镜计划和时间线。                               |
| `import`                                          | 把文件导入素材库。                                           |
| `grab`                                            | 从视频截取静帧。                                            |
| `render`                                          | 把镜头变成版本。                                            |
| `export`                                          | 把时间线变成一个视频素材。                                       |
| `insert` `move` `remove` `split` `trim` `replace` | 片段。                                                 |
| `approve`                                         | 分镜计划的一个版次。                                          |
| `accept`                                          | 过期记录（`proj.stale_accept`）。                          |
| `undo`                                            | 让当前状态后退一步，或回到某一步；它会加一步。                             |
| `inspect`                                         | 对图片或素材的只读分析。                                        |
| `get` `list`                                      | 按 ID 读取一个；读取多个。                                     |

### 界面文案

| zh                               | en                                                             | 用途                                                         |
| -------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| 渲染新版本                            | Render new take                                                | 再次渲染一个版本；渲染 是 render 的 zh 动词。                              |
| 生成方式 / 参考图生成 / 文字生成              | Render mode / From references / From text                      | 版本或镜头的生成方式（`ref2va`、`t2va`）。                               |
| 参考图生成镜头 / 文字生成镜头                 | Render shot from references / Render shot from text            | 对话和历史中的工具 `dv_shot_render_ref2va` 和 `dv_shot_render_t2va`。 |
| 接上一镜头                            | Continues the previous shot                                    | 带 `continue_previous: true` 的镜头。                           |
| 渲染结果                             | Rendered                                                       | 版本的素材筛选。                                                   |
| 导入                               | Imported                                                       | 导入文件的素材筛选。                                                 |
| 参考图                              | Reference images                                               | 角色、场景、风格或镜头据以渲染的图片。                                        |
| 场景和风格                            | Locations and styles                                           | 设定库中 角色 / Characters 之后的部分。                                |
| 新建时间线 / 修改时间线                    | Create timeline / Update timeline                              | 添加时间线或替换其片段的时间线操作。                                         |
| 插入片段 / 移动片段 / 移除片段 / 拆分片段 / 裁剪片段 | Insert clip / Move clip / Remove clip / Split clip / Trim clip | 片段操作；文案中片段显示为 片段 N / Clip N。                               |
| 仍然保留                             | Keep anyway                                                    | `proj.stale_accept` 唯一的标签。                                 |
| 分镜计划版次 / v{version}              | Plan versions / v{version}                                     | 画布上分镜计划各版次间的切换。                                            |
| 你 / 智能体 / 自动                     | You / Agent / Automatic                                        | 历史面板中的发起者。                                                 |
| 渲染 {n} 个镜头                       | Render {n} shots                                               | 批准时排定的渲染的折叠开关。                                             |
| 当前                               | Current                                                        | 历史面板中最新那一步的标记。                                             |
| 撤销 / 回到这一步 / 回到「{step}」          | Undo / Go back to this step / Go back to “{step}”              | 撤销按钮、历史行的 ⋮ 菜单项，以及撤销行。                                     |
| 在历史中查看 / 在轨迹中查看                  | Show in history / Show in trajectory                           | 对话和历史面板之间的链接。                                              |
