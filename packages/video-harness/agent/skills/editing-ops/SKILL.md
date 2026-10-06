---
name: editing-ops
description: "Cheat sheet from the user's editing phrasings to the exact vh_* calls and their required arguments: trims, retakes, reference and style changes, reordering, deletion, branches, and going back to an earlier take."
whenToUse: "The user asks for a change to an existing shot or timeline in a video-harness project and you need the exact tool call."
---

# Editing operations

Resolve "第 N 段" to timeline slot N in the project block first: the slot's asset id, its producing record id, and (for chained shots) the record it continued from. `reason` is required on every call. Deterministic calls (trim, concat, sequence, probe, frame) run at once; a generation that the user asked for by name carries `user_requested: true`; anything you propose yourself is described and left for the user.

| User says | Calls, in order | Required arguments |
| --- | --- | --- |
| 剪掉第 N 段的开头 (X 秒) | `vh_sequence_set_range` | `slot` = N, `inSec` = X (default 1.0 when unspecified; say so), `outSec` = the slot's current out point when it has one. The clip file stays unchanged. |
| 剪掉第 N 段的结尾 (X 秒) | `vh_media_probe` → `vh_sequence_set_range` | probe: `inputs.media` = slot N asset (read `durationSec`). range: `slot` = N, `inSec` = the slot's current in point when it has one, `outSec` = duration − X. |
| 第 N 段只要从 A 秒到 B 秒 | `vh_sequence_set_range` | `slot` = N, `inSec` = A, `outSec` = B. The clip file stays unchanged. |
| 第 N 段换一个角度 / 再来一版 / 重做 | `vh_generate_video` → `vh_sequence_replace` | generate: `prompt` (only the named change differs from the base), `inputs.reference` = same as the base record (usually `["c1@1"]`), `continue_from` = same as the base record when it had one, `base_op` = producing record of slot N, `replaces: [that record]`, `duration_sec` = same, `user_requested: true`. replace: `slot` = N, `asset` = output #0 of the new record. The old take stays available. |
| 换人 / 这个人换成这张图 | `vh_asset_upload` → `vh_entity_character_update` → report stale → (after the user chooses) retakes | upload: `path`, `mime`. update: `entity` = the character id, `refs` = [new asset id]. Then list the stale shots with cost and ask; redo only the agreed ones as retakes with `inputs.reference` = `c1@<new version>`. |
| 换风格 / 加胶片感 | `vh_entity_style_create` (or `_update`) → propose retakes | create: `entity` (such as `s1`), `name`, `description`. Add `s1@1` to `inputs.reference` of each retake and name it as a picture in the prompt; retakes need the user's go-ahead. |
| 把第 A 段放到第 B 段前面 | `vh_sequence_move` | `from` = A, `to` = B. After chained shots, warn that the join may not be continuous and offer a retake of the moved-after shot. |
| 删掉第 N 段 | `vh_sequence_remove` | `slot` = N. Later slots move up; say the new numbering. |
| 在第 N 段后面加一段 | `vh_generate_video` → `vh_sequence_insert` | generate: `prompt`, `inputs.reference`, `continue_from` = producing record of slot N when chained, `user_requested: true`. insert: `at` = N + 1, `asset` = output #0. |
| 回到第 N 段上一版 | `vh_sequence_replace` | `slot` = N, `asset` = the earlier take's asset (from "Takes" in the project block). No generation. |
| 开一个分支试 X | `dv_proj_branch_create` → work there → `dv_proj_branch_switch` to `main` | create: `name` (short, user's word; the branch is `explore/<name>`), `at` = a record id from the project block or `main`. switch: `name` = `main`. Say that `main` is untouched. |
| 撤销 / 回到上一步 | `dv_proj_undo` (one accepted draft or one direct change); `dv_proj_redo` brings it back | none. For an earlier step, offer `dv_proj_branch_create` at the record before it instead. |
| 看一下第 N 段的最后一帧 / 第 t 秒 | `vh_media_extract_frame` → `vh_perception_describe` when a judgment is needed | frame: `inputs.clip` = slot N asset, `at` = `last`, `first`, or a number of seconds (never a numeric string). describe: `inputs.image` = the frame asset, `question`. |
| 合成 / 导出成片 | `vh_media_concat` | `inputs.clip` = the slot assets in timeline order; then give the link. |
| 不要了 / 算了 (the whole draft) | `dv_proj_draft_discard` | none; say what was discarded. |
| 就这样 / 保存 / 确认草稿 | `dv_proj_draft_accept` | none; say what was accepted. |

## Rules that apply to every row

- A retake without `inputs.reference` fails with "ref2va requires 1 to 8 reference images"; copy the base record's references every time.
- `replaces` marks the records that used the old output stale (frames, joins). Nothing reruns by itself: list them and redo only what the user agrees to. When the user keeps a stale result as it is, call `dv_proj_stale_accept` with its record.
- After any generation, `dv_proj_wait` then `dv_proj_state`, and report the last frame and link.
- The draft belongs to this conversation and stays open across turns: work in it directly, and call `dv_proj_draft_accept` or `dv_proj_draft_discard` only when the user asks.
- When "第 N 段" or "这个" has two candidates and no reported selection, ask.
