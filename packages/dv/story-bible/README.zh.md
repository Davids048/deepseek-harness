---
description: "DreamVerse 的设定库组件：dvStoryBible 服务、bible 归约函数，以及创建和更新角色、场景、风格的六个操作和它们的智能体工具。"
kind: "package-reference"
---

# @dv/story-bible

[English](README.md) | 中文

## 概述

使用本包保存项目的角色、场景和风格，每个都带参考图。它向 `dvProject` 注册六个操作，每种一个创建和一个更新（`bible.character_create`、`bible.character_update`，`location` 和 `style` 同理），以及把这些记录变成版本的 `bible` 归约函数。每次调用写出一个 ID 的下一个版本。镜头以输入 `<id>@<version>` 指明一个版本，它代表该版本的参考图。更新会让每条读过上一版本的记录过期。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 `@dv/project` 之后挂载插件。该组件没有配置字段。

```yaml
- id: dv-story-bible
  name: '@dv/story-bible'
```

| 操作 | 工具 | 输入和参数 | 效果 |
| --- | --- | --- | --- |
| `bible.<kind>_create` | `dv_bible_<kind>_create` | 参数 `<kind>`（ID，不含 `@` 或 `#`）、`name`、`description`；输入 `reference`（图片，可多张） | 新 ID 的版本 1；ID 已被某个角色、场景或风格使用时失败 |
| `bible.<kind>_update` | `dv_bible_<kind>_update` | 参数 `<kind>`（ID）、`name`、`description`；输入 `reference` | 下一个版本；保留调用未给出的名称、描述和参考图；ID 未知时失败 |

`<kind>` 是 `character`、`location` 或 `style`。这些操作不写文件（`outputs` 为空），不需要确认，也不是确定性的，因此运行器从不以复用更早的调用代替 ID 检查。更新会取代写出上一版本的记录，因此每条读过上一版本的记录都会过期。

`ProjectState` 的 `bible` 切片是 `StoryBibleState`：`characters`、`locations` 和 `styles`，每个都是从 ID 到按时间先后排列的版本的映射。一个版本（`Character`、`Location`、`Style`）有 `id`、`version`、`name`、`description`、`references`（素材 ID）和 `created_by`（写出它的记录）。ID 类型 `CharacterId`、`LocationId` 和 `StyleId` 定义在 `@dv/project` 中，记录输入用它们标注类型，本包再导出它们。

-----

<a id="understand-the-implementation"></a>
## 理解实现

归约函数只读已完成的 `bible.*` 记录。一个版本的参考图是记录的 `reference` 输入所解析到的素材，因此运行器会检查它们存在，记录也把它们列为它读取的内容。Project 调用 `bible` 键下归约函数的三个可选成员：`assetsOf` 把 `<id>@<version>` 输入解析为其参考图，`createdBy` 指出写出一个版本的记录（Project 把它当作该输入的产生者，用于过期标记和解析 `<id>@<version>`），`conflict` 在 `main` 已有草稿要创建的 ID、或缺少草稿要更新的 ID 时停止接受重放。两个草稿更新同一版本时由 Project 的通用检查处理：两者取代同一条记录。

| 文件 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvStoryBible`：六个操作及其 ID 检查 |
| [`src/reducer.ts`](src/reducer.ts) | 带 `assetsOf`、`createdBy` 和 `conflict` 的 `bible` 归约函数 |
| [`src/types.ts`](src/types.ts) | `Character`、`Location`、`Style`、`StoryBibleState` 和 `ComponentStates` 声明 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dv/project`](../project/README.zh.md)：操作、归约函数、过期标记和接受重放。
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md)：本包遵循的布局。

-----

<a id="model-experience"></a>
## 模型体验

### 工具定义

#### 模型看到什么

六个工具 `dv_bible_character_create`、`dv_bible_character_update`、`dv_bible_location_create`、`dv_bible_location_update`、`dv_bible_style_create` 和 `dv_bible_style_update`，格式与 `@dv/project` 给每个操作工具的一样。每个工具接受以种类命名的 ID 参数（`character`、`location` 或 `style`）、`name`、`description`（"Words carried into every prompt: wardrobe, mood, or look."），以及带素材 ID 的 `inputs.reference`。创建工具的描述说明该种类是什么、镜头以输入 `<character>@1` 指明它，以及 ID 不得已用于另一个角色、场景或风格；更新工具的描述说明下一个版本保留调用未改的内容，并把用上一版本做出的一切标为过期。

#### Token 影响

六个定义约 1,800 个 token，插件挂载期间固定不变；`@dv/project` 的共享参数让每个定义多约 200 个 token。

#### KV Cache 影响

这些定义位于每次智能体请求中固定的工具部分；挂载或移除插件会改变工具列表，使缓存前缀从工具部分起失效。

### 工具结果

#### 模型看到什么

一次调用返回一个文本块：`done <record>: character Lead created`（更新时为 `character c1 updated`）和参数。被拒绝的 ID 返回说明原因的工具错误，例如 "The ID 's1' already names a style; update it, or choose another ID." 或 "Unknown character 'c9'."

#### Token 影响

每次调用约 50 个 token。

#### KV Cache 影响

结果在调用之后追加到对话中；已缓存的前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不能删除**：角色、场景或风格一旦创建就留在项目中；更新只能修改它。
