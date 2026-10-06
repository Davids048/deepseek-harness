---
description: "DreamVerse 的项目组件：dvProject 服务，保存每个项目的记录、分支和草稿，运行操作，并计算状态和历史。"
kind: "package-reference"
---

# @dv/project

[English](README.md) | 中文

## 概述

使用本包修改和读取 DreamVerse 项目。每次修改都是一条记录，由 `dvProject.run`（组件操作）或某个 `proj.*` 方法（草稿、撤销、重做、分支）写入。组件用 `registerOperation` 注册操作，用 `registerReducer` 注册状态归约函数。`CONTRACTS.md` 规定了每个内部模块。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

用项目目录挂载插件；它注入素材存储服务。

```yaml
- id: dv-project
  name: '@dv/project'
  config:
    root: $VH_STATE_ROOT/projects
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | 必填 | 每个项目一个 `<ProjectId>/` 的目录；不存在时创建 |
| `cpuConcurrency` | `4` | 可同时运行的已调度 `cpu` 记录数 |
| `gpuConcurrency` | `1` | 可同时运行的已调度 `gpu` 记录数 |

<a id="understand-the-implementation"></a>
## 理解实现

`src/index.ts` 中的服务委托给七个私有模块：记录存储（唯一读写 `project.json`、`records.jsonl` 和 `branches.json` 的代码）、运行器、调度器、草稿与分支、历史、归约函数注册表和订阅。`CONTRACTS.md` 列出每个模块的函数、规则、错误和测试。

<a id="further-exploration"></a>
## 进一步探索

- 本包的 `CONTRACTS.md`：模块约定和测试计划。

<a id="model-experience"></a>
## 模型体验

无；读取项目状态的智能体工具由其他包注册。

#### KV Cache 影响

无；该服务不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有参考图的角色、场景或风格版本解析后不产生任何输入，所以指向这种版本的记录不留下它的痕迹，版本变化后也不会过期。
