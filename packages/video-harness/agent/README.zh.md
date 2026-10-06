---
description: "视频 harness 的 agent 层：agent loop 的 turn 变成草稿，确认问题送达用户，项目状态成为系统提示词的一节，导演 skill 随包发布。"
kind: "package-reference"
---

# @video-harness/agent

[English](README.md) | 中文

## 概要

用这个包在视频项目上运行 DSH agent。`vhAgent` 监听会话的 turn 事件，使一个 agent loop turn 里的全部结构化调用落在同一条草稿分支上，并在 turn 结束时处置草稿；当调用方是活着的根 agent 时，它通过 `userQuestions` 服务回答工具桥的确认请求；它还贡献一节系统提示词，内容是项目的实体、时间线槽位、take、过期记录、plan，以及解析"第二段"这类指代的规则。`skills/` 目录放着 `video-directing` 和 `branching-story` 两个 skill，由 profile 把 `skill-filesystem` 指向它。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用这个包

在 `@video-harness/tools` 之后挂载 `@video-harness/agent`；它注入 `vhProject` 和 `vhTools`，并在 `agents`、`systemPrompt`、`userQuestions` 存在时使用它们。配置：`promptSectionOrder`（默认 4900，在工具 SDK 一节之前）、`approveLabel` 与 `declineLabel`（确认问题的两个选项）。

把 `skill-filesystem` 指向本包的 `skills/` 目录，agent 才能加载这两个 skill：

```yaml
- id: skill-filesystem
  config:
    customSkillDirs:
      - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@video-harness/agent/package.json')), 'skills')
```

`vhAgent.promptBlock(sessionId)` 返回某个会话的提示词节文本，`vhAgent.confirm(request)` 是工具桥调用的确认通道。

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 作用 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `VhAgent`：`session/event` 监听（`turn/start` 把 turn 号记到桥上，`turn/end` 处置草稿：正常完成且每条记录都是确定性的或带 `user_requested: true` 则并入 `main`，含其他生成式工作或 `confirm: always` 工具、或 turn 被打断则保留给用户，中止或为空则拒绝）、确认通道、提示词节 |
| [`src/resolver.ts`](src/resolver.ts) | `renderResolverBlock`：规则加上从会话写入分支折叠出的项目快照 |
| [`skills/video-directing/SKILL.md`](skills/video-directing/SKILL.md) | 计划、批准、生成、裁剪、重拍、换参考图、分支，以及参考图生视频的 prompt 规则 |
| [`skills/branching-story/SKILL.md`](skills/branching-story/SKILL.md) | 每个节点两个方向，都从父节点生成，用户选，未选分支保留 |

某个 agent loop turn 打开的草稿不能被后面的 turn 继续写：桥会拒绝调用，直到 `vh_turn_accept` 或 `vh_turn_reject` 关闭它，提示词节也会说明这一点。turn 正常完成时，若每条记录都是确定性的（上传、实体、plan、序列编辑、拼接、抽帧、探测）或带 `user_requested: true`，且没有一条是 `confirm: always` 工具，桥会自行把草稿并入 `main`；其他正常完成的草稿和所有被打断且带记录的草稿保持打开，规则要求模型以"草稿待确认"结束这样的回复。草稿打开期间 `main` 被视图改动过的，同样保留。提示词节还会写出用户最近在画布或时间线上选中的对象，装载了 `vhViews` 插件时从它读取。确认遵循设计表：`always` 工具需要 `user_approved: true` 或用户对问题的回答；`cost` 工具只在本 turn 的预估 GPU 秒数超过桥的预算、且调用没有带 `user_requested: true` 时才问。

<a id="further-exploration"></a>
## 延伸阅读

- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md)
- [`@video-harness/tools`](../tools/README.zh.md)，agent 层驱动的桥
- [`@video-harness/bundle`](../../bundle/video-harness/README.zh.md)，挂载全部组件的 profile

<a id="model-experience"></a>
## 模型体验

### 项目节

#### 模型看到什么

一节名为 `video-harness:project` 的系统提示词：七行规则，然后是绑定项目的分支、打开的草稿、带版本和参考的实体、带资产和产生记录的时间线槽位、take、带替代记录的过期记录、以及带批准状态的 plan。没有绑定项目时，这一节只有规则加一行说明。

#### Token 影响

规则约 300 个 token，每个实体、槽位、take、过期记录、plan 约 30 个 token。

#### KV Cache 影响

规则是固定文本；快照随项目变化而变化，所以每次结构化调用之后这一节都会让缓存失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 确认问题只能经 `userQuestions` 送达用户；无界面运行时 agent 必须在回复里问，然后带 `user_approved: true` 或 `user_requested: true` 再调一次。
- turn 边界来自 `session/event`，它不等待监听者；如果 turn 在一个已排队的生成仍在运行时结束，草稿会在那次生成完成之前被处置。
- 这一节每次组装都从完整折叠重建；大项目每一步都要付这个代价。
