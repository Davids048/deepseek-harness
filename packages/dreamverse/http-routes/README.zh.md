---
description: "为插件注册在 DSH web 服务器上的 DreamVerse 路由提供 Starlette 兼容的 HTTP 路由分发，以及 FastAPI 风格的 JSON 与纯文本响应。"
kind: "package-library"
---

# @dreamverse/http-routes

[English](README.md) | 中文

## 概述

当 DreamVerse 插件提供的 HTTP 路由必须与 FastVideo Python 参考实现完全一致地响应时，使用本库。它按 Starlette 路由器的方式通过路由表分发请求，对未匹配的路径和方法返回 FastAPI 的 JSON 404 和 405，并在路由失败时返回 Starlette 的纯文本 500。在 DSH web 服务器上注册路由的 DreamVerse 插件导入它；它自身不注册任何内容。

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

### 何时使用

`@dreamverse/assets-manager`、`@dreamverse/project-store/routes`、`@dreamverse/project-controller` 和 `@dreamverse/multiverse/controller` 在它们用 `ctx.webServer.register()` 注册的处理器内导入本库。每个插件注册自己的路径；本库只在单个插件的路由表内匹配请求。

### 入口

```text
import { serveRoutes, sendJson, type Route } from '@dreamverse/http-routes'

const routes: Route[] = [
  { method: 'GET', path: /^\/health$/, handle: (request, response) => { sendJson(response, 200, { status: 'ok' }) } },
]
// inside a DSH web server handler:
serveRoutes(routes, request, response, logger)
```

第一个模式匹配百分号解码后路径且方法匹配的路由处理请求，模式的捕获组作为解码后的路径参数传入。路径匹配但方法不同时返回 405 `{"detail": "Method Not Allowed"}` 并带 `allow` 头；没有匹配时返回 404 `{"detail": "Not Found"}`。处理器失败时，若响应尚未开始则以状态 500 返回 `Internal Server Error`，否则销毁响应。本库还导出 `sendJson`、`sendPlainText`、`sendInternalServerError` 和 `requestPath`，以及 FastAPI 校验错误的 `ValidationIssue` 类型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

整个库是一个模块 [`src/index.ts`](src/index.ts)。`requestPath` 去掉查询部分，并把路径按 UTF-8 百分号解码（无效字节用替换字符），与 Starlette 匹配所用的 ASGI `path` 一致。响应设置的 `content-length` 和 `content-type` 与 FastAPI 的 `JSONResponse` 和 Starlette 的 `PlainTextResponse` 完全相同，因此 DreamVerse 路由返回与参考实现相同的字节。使用本库的插件的路由测试覆盖了本库。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 服务器子系统](../../../docs/subsystems/web-server.zh.md)——各使用方插件采用的路由注册。
- [`@dreamverse/project-controller`](../project-controller/README.zh.md)——一个带精确路由和 WebSocket 升级的使用方。

-----

<a id="model-experience"></a>
## 模型体验

无。本库只为浏览器路由格式化 HTTP 响应和匹配请求路径。

#### KV Cache 影响

无；本库不向模型请求添加任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有自动 HEAD**——每个路由只匹配一种方法。Starlette 会为每个 GET 路由加上 HEAD，而在这里，除非插件添加 HEAD 路由，否则对只有 GET 的路径发出的 HEAD 请求返回 405。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
