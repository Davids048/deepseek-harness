---
description: "DreamVerse 的智能体集成：智能体的轮次和用户的原话进入项目记录，对话图片成为已导入的素材，DSH 提问规则在批准分镜计划和高成本镜头渲染之前询问用户，输入框模式和批准卡片挡住先问的调用，dv: 提及展开为记录和素材 ID，对话当前分支的状态成为系统提示词的一节，导演 skill 随包发布。"
kind: "package-reference"
---

# @dv/agent-integration

[English](README.md) | 中文

## 概要

用这个包在 DreamVerse 项目上运行 DSH 智能体。`dvAgentIntegration` 把对话连到 `dvProject`：它记录每个智能体轮次及开启它的用户原话，把对话里附上的图片导入为素材，在批准分镜计划和高成本镜头渲染之前询问用户，把先问的调用挡在批准卡片之后，把 `dv:` 提及展开为记录和素材 ID，并贡献一节系统提示词，内容是对话当前分支的状态。`skills/` 目录放着导演 skill。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用这个包

在 DreamVerse 组件之后挂载 `@dv/agent-integration`；它注入 `dvProject` 和 `dvAssetPool`，并在 `agents`、`attachments`、`connection`、`dvApi`、`dvShotPlan`、`systemPrompt`、`userQuestions` 存在时使用它们。

插件监听会话事件，把每个智能体轮次和开启它的用户原话报告给 `dvProject`（`noteTurn`），使本轮的记录带上轮次，并在本轮第一条记录之前写下本轮的请求记录。它把用户在对话里附上的图片导入为素材（由用户执行的 `asset.import`，对话的下一次工具调用会等它完成）。它把 `plan.approve` 和 `shot.render` 的 DSH 提问规则注册为 `dvProject` 的工具调用检查，当调用方是活着的根智能体时经 `userQuestions` 服务提问。它保存每个对话的输入框模式，并作为 `dvProject` 的批准通道，把智能体先问的调用挡在批准卡片之后。它把新用户消息里的 `dv:` 提及展开为一条带记录和素材 ID 的上下文消息。它的系统提示词节列出角色、场景和风格，时间线及其片段，版本，过期记录，分镜计划，草稿，以及解析"第二段"这类指代的规则。`skills/` 目录放着 `video-directing`、`timeline-editing` 和 `branching-story` 三个 skill，由 profile 把 `skill-filesystem` 指向它。

```yaml
- id: dv-agent-integration
  name: '@dv/agent-integration'
  config:
    stateRoot: !!js process.env.DV_STATE_ROOT
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `stateRoot` | 必填 | 状态目录；输入框模式存放在 `<stateRoot>/composer-modes.json` |
| `promptSectionOrder` | `4900` | 项目节在系统提示词中的顺序，在工具 SDK 一节之前 |
| `approveLabel`、`declineLabel` | `Run it`、`Not now` | 确认问题的两个选项 |
| `confirmGpuSecondsThreshold` | `60` | 一轮在用户同意之前可花在 `shot.render` 调用上的预估 GPU 秒数 |

把 `skill-filesystem` 指向本包的 `skills/` 目录，智能体才能加载这三个 skill：

```yaml
- id: skill-filesystem
  config:
    customSkillDirs:
      - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@dv/agent-integration/package.json')), 'skills')
```

挂载了 Connection 时，插件为 `@dv/ui-composer` 提供两个需要认证的路由：

| 路由 | 方法 | 请求 | 响应 |
| --- | --- | --- | --- |
| `/api/dv/composer/mode` | GET | 查询参数 `session` | `ComposerMode` `{confirm: ask \| direct, speed: quality \| speed}` |
| `/api/dv/composer/mode` | POST | `{session, confirm?, speed?}` | `ComposerMode` |
| `/api/dv/composer/approvals` | GET | 查询参数 `session` | `ApprovalCard[]` `{id, session, tool_call, operation, summary, prompt, duration_sec, gpu_seconds, references, created_at}` |
| `/api/dv/composer/approvals` | POST | `{session, id? \| all?, action: approve \| skip}` | `{answered}` |

出错时返回与 `@dv/api` 路由相同的 JSON 正文 `{error, code}`：缺少 `session` 时为 400 `invalid_params`，意外失败时为 500 `internal_error`。

`dvAgentIntegration.promptBlock(sessionId)` 返回某个对话的提示词节文本；`confirm(request)` 是提问规则使用的确认通道；`getComposerMode`、`updateComposerMode`、`approvals`、`answer` 读取和修改输入框模式与批准卡片；`asksFirst` 和 `requestApproval` 是 `dvProject` 调用的 `ApprovalChannel`。提及辅助函数 `parseMentions`、`formatMention`、`describeMention` 供其他使用者导出。

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 作用 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `DvAgentIntegration`：`session/event` 监听（`turn/start` 把轮次记到 `dvProject` 上，用户输入的 `user/message` 把用户原话记到该轮次并导入其中的图片）、提问规则的注册、确认通道、批准通道、输入框路由、`agent/pre-step` 提及展开、提示词节 |
| [`src/composer.ts`](src/composer.ts) | 输入框模式文件、待批准卡片（分镜计划批准的卡片按镜头编号列出所批准版本中要生成的镜头）、输入框 Fetch 路由，以及 `dv-mentions` 上下文消息 |
| [`src/expand.ts`](src/expand.ts) | `parseMentions` 与 `describeMention`：用具体 ID 描述 `dv:asset`、`dv:record`、`dv:character`、`dv:location`、`dv:style`、`dv:clip` 提及 URI |
| [`src/question-rule.ts`](src/question-rule.ts) | `questionRule`：带 `QUESTION_RULES`、`user_approved` 与 `user_requested` 参数、本轮 GPU 预算、以及列出分镜计划版本要生成的镜头及其成本的分镜计划批准问题的 `ToolCallCheck` |
| [`src/resolver.ts`](src/resolver.ts) | `renderResolverBlock`：规则加上对话当前分支的项目快照 |
| [`skills/video-directing/SKILL.md`](skills/video-directing/SKILL.md) | 计划、批准、渲染、裁剪、重拍、换参考图、分支，以及参考图生视频的 prompt 规则 |
| [`skills/timeline-editing/SKILL.md`](skills/timeline-editing/SKILL.md) | 把用户的编辑请求对应到确切的工具调用及其参数 |
| [`skills/branching-story/SKILL.md`](skills/branching-story/SKILL.md) | 每个节点两个方向，都从父节点渲染，用户选，未选分支保留 |

草稿属于对话：对话的第一条智能体记录打开 `draft/<session>`，草稿跨越多个轮次，也装着用户的编辑，只有用户能关闭它。智能体集成从不接受或丢弃草稿；规则要求模型只在用户要求时调用 `dv_proj_draft_accept` 或 `dv_proj_draft_discard`，草稿里有用户尚未评判的结果时以"草稿待确认"结束回复。提示词节还会写出用户最近在视图里选中的对象，装载了 `dvApi` 插件时从它读取。确认遵循设计表：`plan.approve` 需要 `user_approved: true` 或用户对问题的回答；镜头渲染只在本轮的预估 GPU 秒数超过 `confirmGpuSecondsThreshold`、且调用没有带 `user_requested: true` 时才问。规则只负责提问：批准卡片由运行器强制执行，没有参考图的调用由 `plan.approve` 和 `shot.render` 自己的前置条件在提问之前拒绝。在输入框的先问模式下，`confirm` 对 `confirm: agent_ask_first` 的操作回答可以，因为 `dvProject` 把记录挡在批准卡片之后，卡片就是提问；跳过卡片会取消记录，卸载插件会跳过所有待批准卡片。片段提及用 `ClipId` 指明片段，`ClipId` 在项目内唯一；展开读取对话当前分支的状态。

<a id="further-exploration"></a>
## 延伸阅读

- [DreamVerse 各包](../../../docs/subsystems/video-harness.zh.md)
- [`@dv/project`](../project/README.zh.md)，工具调用检查、批准通道和智能体调用的操作工具
- [`@dv/api`](../api/README.zh.md)，提示词节写出的视图选中对象
- [`@dv/ui-composer`](../ui-composer/src/index.ts)，写出提及并显示批准卡片的输入框
- [`@dv/bundle`](../../bundle/dv/README.zh.md)，挂载全部组件的 profile

<a id="model-experience"></a>
## 模型体验

### 项目节

#### 模型看到什么

一节名为 `dv:project` 的系统提示词：九行规则（其中一行告诉智能体用 `dv_plan_update` 在故事的分镜计划上延长、缩短或修改故事，只有另一个故事才新建分镜计划），然后是绑定项目的当前分支、是否有打开的草稿及其智能体修改数和人工编辑数、带版本和参考图的角色/场景/风格、每条时间线及其按位置排列的片段（带片段 ID、素材和产生记录）、版本、带替代记录的过期记录、每个分镜计划一行及其最新版本、最新的已批准版本和镜头数（`- p1 "title": latest v2 (7 shots), v1 approved`），以及一行对话的输入框偏好。没有绑定项目时，这一节只有规则加一行说明。

#### Token 影响

规则约 300 个 token，每个角色、场景、风格、片段、版本、过期记录、分镜计划约 30 个 token。

#### KV Cache 影响

规则是固定文本；快照随项目变化而变化，所以每次结构化调用之后这一节都会让缓存失效。

### 提及展开

#### 模型看到什么

新用户消息里有 `@[<label>](dv:<kind>/<id>)` 提及时，它后面跟一条来源为 `dv-mentions` 的上下文消息："The user referenced these project items:"，每个提及一行，写出素材、记录、角色、场景、风格或片段，以及产生它的记录（工具、状态、prompt、时长、输入、输出）。

#### Token 影响

每个提及约 60 个 token。

#### KV Cache 影响

这条消息追加在用户消息之后，不改动已缓存的前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 确认问题只能经 `userQuestions` 送达用户；无界面运行时智能体必须在回复里问，然后带 `user_approved: true` 或 `user_requested: true` 再调一次。
- 轮次开始和用户原话来自 `session/event`，它不等待监听者；如果一次结构化调用在监听者记下本轮原话之前运行，本轮不写请求记录。
- 这一节每次组装都从当前分支的状态重建；大项目每一步都要付这个代价。
