---
description: "Starlette-compatible HTTP route dispatch and FastAPI-style JSON and plain-text responses for the DreamVerse routes that plugins register on the DSH web server."
kind: "package-library"
---

# @dreamverse/http-routes

English | [中文](README.zh.md)

## Summary

Use this library when a DreamVerse plugin serves HTTP routes that must answer exactly like the FastVideo Python reference. It dispatches a request through a route table the way Starlette's router does, answers FastAPI's JSON 404 and 405 for unmatched paths and methods, and answers Starlette's plain 500 when a route fails. The DreamVerse plugins that register routes on the DSH web server import it; it registers nothing itself.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

`@dreamverse/assets-manager`, `@dreamverse/project-store/routes`, `@dreamverse/project-controller`, and `@dreamverse/multiverse/controller` import this library inside the handler that they register with `ctx.webServer.register()`. Each plugin registers its own paths; this library only matches a request within one plugin's route table.

### Entry point

```text
import { serveRoutes, sendJson, type Route } from '@dreamverse/http-routes'

const routes: Route[] = [
  { method: 'GET', path: /^\/health$/, handle: (request, response) => { sendJson(response, 200, { status: 'ok' }) } },
]
// inside a DSH web server handler:
serveRoutes(routes, request, response, logger)
```

The first route whose pattern matches the percent-decoded path and whose method matches handles the request, and the pattern's groups arrive as the decoded path parameters. A path match with another method answers 405 `{"detail": "Method Not Allowed"}` with an `allow` header; no match answers 404 `{"detail": "Not Found"}`. A failing handler answers `Internal Server Error` with status 500 before the response starts and destroys the response afterwards. `sendJson`, `sendPlainText`, `sendInternalServerError`, and `requestPath` are also exported, with the `ValidationIssue` type of FastAPI's validation errors.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The whole library is one module, [`src/index.ts`](src/index.ts). `requestPath` drops the query and percent-decodes the path as UTF-8 with replacement characters, like the ASGI `path` that Starlette matches. The responses set `content-length` and `content-type` exactly as FastAPI's `JSONResponse` and Starlette's `PlainTextResponse` do, so the DreamVerse routes return the reference bytes. The consuming plugins' route tests exercise the library.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web server subsystem](../../../docs/subsystems/web-server.md) — the route registration that each consuming plugin uses.
- [`@dreamverse/project-controller`](../project-controller/README.md) — a consumer with exact routes and a WebSocket upgrade.

-----

<a id="model-experience"></a>
## Model Experience

None, as the library only formats HTTP responses and matches request paths for browser routes.

#### KV Cache effect

None; the library adds nothing to a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No automatic HEAD** — a route matches one method only. Starlette adds HEAD to every GET route, but here a HEAD request to a GET-only path answers 405 unless the plugin adds a HEAD route.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
