---
description: "视频 harness 的追加写入操作日志：Op 记录类型、每个项目的 JSONL 存储、只前进的补丁、命名分支头、祖先遍历和变更订阅。"
kind: "package-reference"
---

# @video-harness/oplog

[English](README.md) | 中文

## 概述

使用本包作为视频项目的唯一事实来源。每次变化都是一条 `Op` 记录：谁做的、来自哪个视图、请求是什么、工具或命令、输入及其解析结果、参数、输出和父记录。记录只追加不改写；状态变化是追加的补丁行。分支是指向记录的命名指针，因此撤销、草稿和探索只是移动指针和新建分支，任意记录处的状态由折叠其祖先重建。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用一个根目录挂载插件。运行时注入 `vhOpLog`；视图订阅它。

```yaml
- id: vh-oplog
  name: '@video-harness/oplog'
  config:
    root: /home/user/.local/state/video-harness/projects
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | 必填 | 每个项目一个 `<project_id>/` 的目录；不存在时创建 |

| 方法 | 行为 |
| --- | --- |
| `createProject({title})` / `listProjects()` / `project(id)` | 一个日志为空、没有分支头的项目目录 |
| `append(projectId, draft, parent)` | 在 `draft.branch` 上追加记录；`parent` 必须是该分支的头，`branch` 记录除外，它可以跟在任意记录之后并创建其分支 |
| `update(projectId, opId, patch)` | 状态只能前进（`pending → running → done \| failed`），并填入输出、解析后的输入、成本、错误和完成时间 |
| `get` / `all` / `ancestors(projectId, opId)` | 一条记录、按创建顺序的全部记录，或从第一条记录到 `opId` 的链 |
| `heads` / `createBranch(projectId, name, at, turn?)` / `moveHead(projectId, branch, to)` | 分支指针：读取、在某记录处创建、移动 |
| `subscribe(projectId, listener)` | 同步的 `append`、`patch`、`head` 事件，直到调用返回的函数 |

`Op` 类型、`OpDraft` 和 `OpPatch`、ID 品牌类型、`MAIN_BRANCH` 和 `statusAdvances` 导出给运行时和视图使用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

每个项目是 `<root>/<project_id>/`，内含 `project.json`（标题和创建时间）、`ops.jsonl`（按写入顺序的记录和补丁行）和 `heads.json`（分支名到记录 ID，经临时文件原子写入）。启动时服务重放每个目录：先记录，再把补丁应用到它们指向的记录，最后读分支头；指向未知记录的补丁被忽略，没有 `project.json` 的目录被跳过。内存中的日志是记录映射、创建顺序、分支头和监听器；每次变更先写文件，内存状态改变后再通知监听器。

| 文件 | 内容 |
| --- | --- |
| [`src/types.ts`](src/types.ts) | `Op` 记录及其组成部分 |
| [`src/index.ts`](src/index.ts) | `vhOpLog`：存储、重放、追加规则、补丁、分支、订阅 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [视频 harness 子系统](../../../docs/subsystems/video-harness.zh.md) — 记录字段在整个 harness 中的含义。
- [`@video-harness/runtime`](../runtime/README.zh.md) — 运行中的 harness 里唯一写记录的地方。

-----

<a id="model-experience"></a>
## 模型体验

无。该日志保存操作记录和分支头，没有任何模型请求直接读取它们。

#### KV Cache 影响

无；该日志不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **单父记录** — 一条记录只有一个父记录；合并两个分支尚不能表示。
- **单进程** — 日志没有文件锁；两个 harness 进程共用同一根目录会交错写入。
- **整文件重放** — 启动时间随记录数增长；没有折叠状态的快照。
