---
description: "dreamverse-ui 包组：以 DSH 浏览器插件形式实现的 DreamVerse 页面以及 Multiverse 页面，供选择或浏览该包族的读者使用。"
kind: "package-group"
---

# dreamverse-ui/ — the DreamVerse page

[English](README.md) | 中文

## 概述

这些包在浏览器中绘制 DreamVerse 页面：创作工作室、实时编辑器、视频播放器、提示词时间线、素材库和项目历史。它们把 FastVideo DreamVerse Next.js 前端移植为 DSH 浏览器插件，并保留其组件、Tailwind 主题和布局；每个包为自己渲染的文案注册中文和英文 locale 词典。页面通过 [`../dreamverse/`](../dreamverse/README.zh.md) 的 `/ws` 协议和 HTTP 路由与 harness 通信。Multiverse 页面复用创作工作室和素材库。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

`@dreamverse/ui-kit` 填充外壳的 `root` slot 并声明页面的子 slot；其他每个包填充其中一个或两个。

| 包 | Slot | 角色 |
| --- | --- | --- |
| [`kit`](kit/README.zh.md) | `root` | 页面框架、共享组件、样式表和静态图片 |
| [`creation`](creation/README.zh.md) | `dreamverse.creation-studio`、`dreamverse.chatbar` | 项目创建与实时导演编辑器 |
| [`player`](player/README.zh.md) | `dreamverse.player` | 实时与归档播放 |
| [`directing`](directing/README.zh.md) | `dreamverse.workspace` | 当前显示项目的提示词事件时间线 |
| [`assets`](assets/README.zh.md) | `dreamverse.asset-library` | 素材库对话框 |
| [`project-history`](project-history/README.zh.md) | `dreamverse.sidebar` | 已存储项目列表 |
| [`multiverse`](multiverse/README.zh.md) | `root` | Multiverse 页面：分支故事的玩家模式与开发模式 |

<a id="related-documentation"></a>
## 相关文档

- [DreamVerse 子系统](../../docs/subsystems/dreamverse.zh.md)——进程布局、工作负载（workload），以及与 FastVideo 前端的差异。
- [`dreamverse/`](../dreamverse/README.zh.md)——页面所通信的 harness 包。
- [Slots 子系统](../../docs/subsystems/slots.zh.md)——slot 所有者与占用者如何组合出页面。

<a id="dev-note"></a>
## 开发备注

无。
