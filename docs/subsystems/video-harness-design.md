# Video harness design

English | [中文](video-harness-design.zh.md)

This page is a pointer. The design rationale behind the [DreamVerse packages](video-harness.md) lives in the published design document, [视频 Harness 分层设计](https://claude.ai/artifact/5CoTU4WaDUfmGPC7wRPyZA), and its interactive walkthrough, [操作日志与三视图可视化](https://claude.ai/artifact/KgwBnYzWMYZa1ewkJumAiN). The [DreamVerse packages page](video-harness.md) owns the current types and the generated Cordis API.

## What the design document covers

- Terms: project, asset, operation record, turn, branch, tool, command, plan, characters and locations, view.
- The six layers from the DeepSeek Harness kernel to the three views, and why the views and the agent are peers that write only through tools.
- The operation record: append-only, single-parent DAG, named heads, folding as replay, undo as a pointer move, and the deterministic cache.
- How chat, timeline, and canvas derive from one log and how each surface's gestures become records.
- Structured tools versus arbitrary commands, and which commands become tools.
- The policies for staleness, drafts, confirmation, scheduling modes, reference resolution, characters and locations, and agent edits to manual work.
- The six-step test case and the two acknowledged awkward points.
- The minimal scope and the extension points.

## Where the implementation lives

The packages under `packages/dv/` and [`packages/video-harness/`](../../packages/video-harness/README.md) implement the design, and the [DreamVerse packages page](video-harness.md) describes them; the [DreamVerse page](dreamverse.md) lists which DreamVerse packages the harness reuses and which it supersedes.
