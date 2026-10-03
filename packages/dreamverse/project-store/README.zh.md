---
description: "共享的 DreamVerse 项目存储：所有工作负载的项目记录、不透明的工作负载数据、单写者租约、旧记录迁移钩子，以及 /projects HTTP 路由。"
kind: "package-reference"
---

# @dreamverse/project-store

[English](README.md) | 中文

## 概述

使用本包保存每个 DreamVerse 工作负载（workload）的项目：每个项目的标题、缩略图、时间戳、类型，以及工作负载自己的数据，每个项目存为一个 JSON 文件。同一时刻只有一个持有者可以写入某个项目，新持有者通过撤销当前持有者来接管，因此两个浏览器窗口永远不会同时写同一个项目。`/projects` 路由为任意页面列出、读取和删除已存储的项目。删除项目会删除其在文件存储中的文件。租约只存在于单个 harness 进程内。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载存储服务；在有 web 服务器的 harness 上同时挂载其路由插件。该服务注入 `dreamverseAssetsManager`。

### 最小配置

```yaml
- id: dreamverse-project-store
  name: '@dreamverse/project-store'
  config:
    root: /home/user/.local/state/fastvideo/dreamverse/projects
- id: dreamverse-project-routes
  name: '@dreamverse/project-store/routes'
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | 必填 | 每个项目一个 `<project_id>/project.json` 的目录；不存在时服务会创建它 |

### 项目与工作负载数据

`create` 用一个 `kind`、一个标题和工作负载数据 `{schemaVersion, data}` 存储项目，其中 `data` 可以是任意 JSON 值。类型指明所属工作负载，例如 `dreamverse`，且永不改变。`list({kind})` 按最近更新在前返回项目；`get` 读取单个项目。存储保存工作负载数据但不解释它，项目的文件是归 `projectOwner(projectId)` 所有的文件存储素材。

### 租约

`acquire(projectId, holder)` 返回每次写入（`updateWorkload`、`setTitle`、`setThumbnail`）都要使用的租约；用已释放或已撤销的租约写入会抛出 `StaleLeaseError`。若项目已有持有者，`acquire` 会调用该持有者的 `revoke()`，等待其完成，然后才授予新租约。对同一项目的并发 `acquire` 调用按调用顺序授予。由各工作负载决定哪一方持有其项目。对被持有的项目，`delete` 抛出 `ProjectInUseError`；否则它先用 `deleteOwnedBy` 删除项目文件，再删除项目目录。

### 早期格式的记录

`list` 与 `get` 会跳过 `project.json` 不是 schema 2 记录的目录。`listUnrecognized` 报告这些目录及其解析出的记录（无效 JSON 为 null），也包括只剩 `project.legacy.json` 的目录（迁移在两个步骤之间中断）。`migrate` 把无法识别的 `project.json` 重命名为 `project.legacy.json` 并写入 schema 2 记录，由拥有旧格式的工作负载完成转换。

### HTTP 路由

`@dreamverse/project-store/routes` 在 DSH web 服务器上注册一个 `/projects` 前缀路由：

| 路由 | 行为 |
| --- | --- |
| `GET /projects?kind=<kind>` | `{"projects": [{project_id, kind, title, created_at, updated_at, thumbnail_url}]}`，最近更新的在前；`kind` 可选；`thumbnail_url` 为 `/assets/<asset_id>/content` 或 null |
| `GET /projects/<project_id>` | 列表项加上 `held`、`workload: {schema_version, data}` 和 `assets`（项目的文件及其 `content_url`）；404 `{"detail": "Project not found."}` |
| `DELETE /projects/<project_id>` | 删除项目及其文件后返回 204；未知项目返回 404；有持有者持有时返回 409 `{"detail": "This project is open. Close it before deleting."}` |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个项目是一个目录 `<root>/<project_id>/project.json`，内容为 `{"schema_version": 2, "project_id", "kind", "title", "created_at", "updated_at", "thumbnail_asset_id", "workload": {"schema_version", "data"}}`。项目 ID 匹配 `[A-Za-z0-9_-]{1,128}`。每次写入都通过临时文件加重命名替换 `project.json` 并设置 `updated_at`；写入是同步的，因此对同一项目的写入永不交错。该服务只依赖 Cordis、Schemastery、Node 和 `@dreamverse/assets-manager`；只有路由插件使用 DSH web 服务器。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dreamverseProjectStore` 服务：记录、租约、删除与迁移钩子 |
| [`src/records.ts`](src/records.ts) | schema 2 记录格式及其解析器 |
| [`src/routes.ts`](src/routes.ts)、[`src/http.ts`](src/http.ts) | `/projects` 路由插件 |

`tests/` 目录覆盖记录、租约、删除、迁移钩子和路由。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [DreamVerse 子系统](../../../docs/subsystems/dreamverse.zh.md)——共享项目层中的项目、类型与租约。
- [`@dreamverse/assets-manager`](../assets-manager/README.zh.md)——保存项目文件的文件存储。
- [`@dreamverse/project`](../project/README.zh.md)——DreamVerse 工作负载数据及其迁移。

-----

<a id="model-experience"></a>
## 模型体验

无。该存储保存项目记录和工作负载数据，没有任何模型请求直接读取它们。

#### KV Cache 影响

无；该存储不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **租约只在单个进程内**——在同一个 `root` 上运行的两个 harness 进程看不到对方的租约。一个进程可能在另一个进程写入某个项目时删除或覆盖该项目。
- **没有分页或搜索**——`GET /projects` 在一个响应中返回所请求类型的全部项目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
