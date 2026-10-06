---
description: "视频 harness 的 agent 层：agent 的轮次和用户的原话进入项目记录，聊天图片成为已导入的素材，DSH 提问规则在批准分镜计划和高成本镜头生成之前询问用户，会话当前分支的状态成为系统提示词的一节，导演 skill 随包发布。"
kind: "package-reference"
---

# @video-harness/agent

[English](README.md) | 中文

## 概要

用这个包在视频项目上运行 DSH agent。`vhAgent` 监听会话事件，把每个 agent 轮次和开启它的用户原话报告给 `dvProject`（`noteTurn`），使本轮的记录带上轮次，并在本轮第一条记录之前写下本轮的请求记录；它把用户在聊天里附上的图片导入为素材（由用户执行的 `asset.import`，会话的下一次工具调用会等它完成）；它把 `plan.approve` 和 `shot.render` 的 DSH 提问规则注册为 `dvProject` 的工具调用检查，当调用方是活着的根 agent 时经 `userQuestions` 服务提问；它还贡献一节系统提示词，内容是会话当前分支的状态：角色、场景和风格，时间线及其片段，版本，过期记录，分镜计划，草稿，以及解析"第二段"这类指代的规则。`skills/` 目录放着 `video-directing` 和 `branching-story` 两个 skill，由 profile 把 `skill-filesystem` 指向它。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用这个包

在 DreamVerse 组件之后挂载 `@video-harness/agent`；它注入 `dvProject` 和 `dvAssetPool`，并在 `agents`、`attachments`、`dvShotPlan`、`systemPrompt`、`userQuestions` 存在时使用它们。配置：`promptSectionOrder`（默认 4900，在工具 SDK 一节之前）、`approveLabel` 与 `declineLabel`（确认问题的两个选项）、`confirmGpuSecondsThreshold`（默认 60：一轮在用户同意之前可花在 `shot.render` 调用上的预估 GPU 秒数）。

把 `skill-filesystem` 指向本包的 `skills/` 目录，agent 才能加载这两个 skill：

```yaml
- id: skill-filesystem
  config:
    customSkillDirs:
      - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@video-harness/agent/package.json')), 'skills')
```

`vhAgent.promptBlock(sessionId)` 返回某个会话的提示词节文本，`vhAgent.confirm(request)` 是提问规则使用的确认通道，`vhAgent.setComposer(channel)` 装入输入框的模式，由输入框插件注册。

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 作用 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `VhAgent`：`session/event` 监听（`turn/start` 把轮次记到 `dvProject` 上，用户输入的 `user/message` 把用户原话记到该轮次并导入其中的图片）、提问规则的注册、确认通道、提示词节 |
| [`src/question-rule.ts`](src/question-rule.ts) | `questionRule`：带 `QUESTION_RULES`、`user_approved` 与 `user_requested` 参数、本轮 GPU 预算、以及列出每个镜头的分镜计划批准问题的 `ToolCallCheck` |
| [`src/resolver.ts`](src/resolver.ts) | `renderResolverBlock`：规则加上会话当前分支的项目快照 |
| [`skills/video-directing/SKILL.md`](skills/video-directing/SKILL.md) | 计划、批准、渲染、裁剪、重拍、换参考图、分支，以及参考图生视频的 prompt 规则 |
| [`skills/branching-story/SKILL.md`](skills/branching-story/SKILL.md) | 每个节点两个方向，都从父节点渲染，用户选，未选分支保留 |

草稿属于聊天会话：会话的第一条 agent 记录打开 `draft/<session>`，草稿跨越多个轮次，也装着用户的编辑，只有用户能关闭它。agent 层从不接受或丢弃草稿；规则要求模型只在用户要求时调用 `dv_proj_draft_accept` 或 `dv_proj_draft_discard`，草稿里有用户尚未评判的结果时以"草稿待确认"结束回复。提示词节还会写出用户最近在画布或时间线上选中的对象，装载了 `vhViews` 插件时从它读取。确认遵循设计表：`plan.approve` 需要 `user_approved: true` 或用户对问题的回答；镜头生成只在本轮的预估 GPU 秒数超过 `confirmGpuSecondsThreshold`、且调用没有带 `user_requested: true` 时才问。规则只负责提问：批准卡片由运行器强制执行，没有参考图的调用由 `plan.approve` 和 `shot.render` 自己的前置条件在提问之前拒绝。在输入框的先问模式下，`confirm` 对 `confirm: agent_ask_first` 的操作回答可以，因为 `dvProject` 把记录挡在输入框的批准卡片之后，卡片就是提问。

<a id="further-exploration"></a>
## 延伸阅读

- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md)
- [`@dv/project`](../../dv/project/README.zh.md)，工具调用检查和 agent 调用的操作工具
- [`@video-harness/bundle`](../../bundle/video-harness/README.zh.md)，挂载全部组件的 profile

<a id="model-experience"></a>
## 模型体验

### 项目节

#### 模型看到什么

一节名为 `video-harness:project` 的系统提示词：八行规则，然后是绑定项目的当前分支、是否有打开的草稿及其 agent 修改数和人工编辑数、带版本和参考的角色/场景/风格、每条时间线及其按位置排列的片段（带素材和产生记录）、版本、带替代记录的过期记录、以及带批准状态的分镜计划。没有绑定项目时，这一节只有规则加一行说明。

#### Token 影响

规则约 300 个 token，每个角色、场景、风格、片段、版本、过期记录、分镜计划约 30 个 token。

#### KV Cache 影响

规则是固定文本；快照随项目变化而变化，所以每次结构化调用之后这一节都会让缓存失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 确认问题只能经 `userQuestions` 送达用户；无界面运行时 agent 必须在回复里问，然后带 `user_approved: true` 或 `user_requested: true` 再调一次。
- 轮次开始和用户原话来自 `session/event`，它不等待监听者；如果一次结构化调用在监听者记下本轮原话之前运行，本轮不写请求记录。
- 这一节每次组装都从当前分支的状态重建；大项目每一步都要付这个代价。
