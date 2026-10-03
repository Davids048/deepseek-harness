---
description: "以 DSH 浏览器插件实现的 DreamVerse 素材库对话框：浏览、上传、预览、删除和选择素材库中的图片、视频与音频。"
kind: "package-reference"
---

# @dreamverse/ui-assets

[English](README.md) | 中文

## 概述

本包绘制 DreamVerse 素材库对话框。用户浏览素材库，在 harness 上传策略允许的范围内上传图片、视频和音频，预览和删除文件，并选择一张图片作为下一次生成的参考图。对话框只处理素材库文件；属于项目的文件不会出现在其中。

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

与在 DreamVerse 页面上声明其 slot 的 `@dreamverse/ui-kit` 一起挂载该插件。

### 最小配置

```yaml
- id: dreamverse-ui-assets
  name: '@dreamverse/ui-assets'
```

在页面声明该 slot 期间，浏览器部分用 `AssetLibrary`（前端 `components/assets/AssetLibrary.tsx` 的移植）填充 `dreamverse.asset-library`。Host 部分不注册任何内容。对话框通过 `@dreamverse/assets-manager/client/assets.ts` 使用 `/assets` 路由列出、上传和删除文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`AssetLibrary` 每次打开时刷新列表，并通过 `onAssetsChange` 共享页面缓存的列表，因此用户在刷新进行期间所做的修改优先于该次刷新。

| 文件 | 内容 |
| --- | --- |
| [`src/client/index.ts`](src/client/index.ts) | slot 注册 |
| [`src/client/components/assets/AssetLibrary.tsx`](src/client/components/assets/AssetLibrary.tsx) | 素材库对话框 |

`tests/` 目录覆盖该对话框。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@dreamverse/assets-manager`](../../dreamverse/assets-manager/README.zh.md)——文件存储、其上传策略与 `/assets` 路由。
- [`@dreamverse/ui-creation`](../creation/README.zh.md)——打开该对话框的参考图选择器。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@dreamverse/segment-generation`：它把用户在这里选中的素材库图片的项目副本作为请求图片发送给视频模型。

#### KV Cache 影响

无；对话框不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有素材库文件**——对话框无法显示或删除项目的文件；harness 会随项目一起删除它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
