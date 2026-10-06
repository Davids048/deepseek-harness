---
name: editing-ops
description: "Cheat sheet from the user's editing phrasings to the exact dv_* calls and their required arguments: trims, retakes, reference and style changes, reordering, deletion, branches, and going back to an earlier take."
whenToUse: "The user asks for a change to an existing shot or timeline in a video-harness project and you need the exact tool call."
---

# Editing operations

Resolve "第 N 段" to clip N of the first timeline in the project block (or of the timeline the user names) first: the clip's asset id, its producing record id, and (for chained shots) the record it continued from. `reason` is required on every call. Deterministic calls (timeline edits, export, still) and reads (`dv_inspect_asset`, `dv_inspect_image`) run at once; a render that the user asked for by name carries `user_requested: true`; anything you propose yourself is described and left for the user.

| User says | Calls, in order | Required arguments |
| --- | --- | --- |
| 剪掉第 N 段的开头 (X 秒) | `dv_timeline_clip_trim` | `clip` = N, `in_sec` = X (default 1.0 when unspecified; say so), `out_sec` = the clip's current out point when it has one. The clip file stays unchanged. |
| 剪掉第 N 段的结尾 (X 秒) | `dv_inspect_asset` → `dv_timeline_clip_trim` | inspect: `inputs.asset` = clip N's asset (read `duration_sec`). range: `clip` = N, `in_sec` = the clip's current in point when it has one, `out_sec` = duration − X. |
| 第 N 段只要从 A 秒到 B 秒 | `dv_timeline_clip_trim` | `clip` = N, `in_sec` = A, `out_sec` = B. The clip file stays unchanged. |
| 第 N 段换一个角度 / 再来一版 / 重做 | `dv_shot_render` → `dv_timeline_clip_replace` | render: `prompt` (only the named change differs from the base), `inputs.reference` = same as the base record (usually `["c1@1"]`), `continue_from` = same as the base record when it had one, `based_on` = producing record of clip N, `supersedes: [that record]`, `duration_sec` = same, `user_requested: true`. replace: `clip` = N, `asset` = output #0 of the new record. The old take stays available. |
| 换人 / 这个人换成这张图 | `dv_asset_import` → `dv_bible_character_update` → report stale → (after the user chooses) retakes | import: `path`, `mime`. update: `character` = the character id, `inputs.reference` = [new asset id]. Then list the stale shots with cost and ask; redo only the agreed ones as retakes with `inputs.reference` = `c1@<new version>`. |
| 换风格 / 加胶片感 | `dv_bible_style_create` (or `dv_bible_style_update`) → propose retakes | create: `style` (such as `s1`), `name`, `description`. Add `s1@1` to `inputs.reference` of each retake and name it as a picture in the prompt; retakes need the user's go-ahead. |
| 把第 A 段放到第 B 段前面 | `dv_timeline_clip_move` | `clip` = A, `to` = B. After chained shots, warn that the join may not be continuous and offer a retake of the moved-after shot. |
| 删掉第 N 段 | `dv_timeline_clip_remove` | `clip` = N. Later clips move up; say the new numbering. |
| 在第 N 段后面加一段 | `dv_shot_render` → `dv_timeline_clip_insert` | render: `prompt`, `inputs.reference`, `continue_from` = producing record of clip N when chained, `user_requested: true`. insert: `at` = N + 1, `asset` = output #0. |
| 回到第 N 段上一版 | `dv_timeline_clip_replace` | `clip` = N, `asset` = the earlier take's asset (from "Takes" in the project block). No render. |
| 开一个分支试 X | `dv_proj_branch_create` → work there → `dv_proj_branch_switch` to `main` | create: `name` (short, user's word; the branch is `explore/<name>`), `at` = a record id from the project block or `main`. switch: `name` = `main`. Say that `main` is untouched. |
| 撤销 / 回到上一步 | `dv_proj_undo` (one accepted draft or one direct change); `dv_proj_redo` brings it back | none. For an earlier step, offer `dv_proj_branch_create` at the record before it instead. |
| 看一下第 N 段的最后一帧 / 第 t 秒 | `dv_asset_grab_still` → `dv_inspect_image` when a judgment is needed | still: `inputs.video` = clip N's asset, `at` = `last`, `first`, or a number of seconds (never a numeric string). inspect: `inputs.image` = the still asset, `question`. |
| 合成 / 导出成片 | `dv_deliver_timeline_export` | `timeline` = the timeline's ID (default: the first timeline); it trims each clip with an in or out point to that range and joins the clips in timeline order; then give the link. |
| 不要了 / 算了 (the whole draft) | `dv_proj_draft_discard` | none; say what was discarded. |
| 就这样 / 保存 / 确认草稿 | `dv_proj_draft_accept` | none; say what was accepted. |

## Rules that apply to every row

- A retake without `inputs.reference` is refused; copy the base record's references every time.
- `supersedes` marks the records that used the old output stale (stills, exports). Nothing reruns by itself: list them and redo only what the user agrees to. When the user keeps a stale result as it is, call `dv_proj_stale_accept` with its record.
- After any render, `dv_proj_wait` then `dv_proj_state`, and report the last frame and link.
- The draft belongs to this conversation and stays open across turns: work in it directly, and call `dv_proj_draft_accept` or `dv_proj_draft_discard` only when the user asks.
- When "第 N 段" or "这个" has two candidates and no reported selection, ask.
