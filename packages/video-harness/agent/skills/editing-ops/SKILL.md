---
name: editing-ops
description: "Cheat sheet from the user's editing phrasings to the exact vh_* calls and their required arguments: trims, speed, retakes, reference and style changes, reordering, deletion, branches, and going back to an earlier take."
whenToUse: "The user asks for a change to an existing shot or timeline in a video-harness project and you need the exact tool call."
---

# Editing operations

Resolve "第 N 段" to timeline slot N in the project block first: the slot's asset id, its producing record id, and (for chained shots) the record it continued from. `reason` is required on every call. Deterministic calls (trim, concat, sequence, probe, frame) run at once; a generation that the user asked for by name carries `user_requested: true`; anything you propose yourself is described and left for the user.

| User says | Calls, in order | Required arguments |
| --- | --- | --- |
| 剪掉第 N 段的开头 (X 秒) | `vh_clip_trim` → `vh_sequence_replace` | trim: `inputs.clip` = slot N asset, `startSec` = X (default 1.0 when unspecified; say so). replace: `slot` = N, `asset` = the trim output asset. |
| 剪掉第 N 段的结尾 (X 秒) | `vh_media_probe` → `vh_clip_trim` → `vh_sequence_replace` | probe: `inputs.media` = slot N asset (read `durationSec`). trim: `startSec` = 0, `endSec` = duration − X. replace as above. |
| 第 N 段只要从 A 秒到 B 秒 | `vh_sequence_set_range` | `slot` = N, `inSec` = A, `outSec` = B. Non-destructive; use `vh_clip_trim` only when the user wants a new file. |
| 第 N 段加快 / 放慢 | `vh_command_run` → `vh_sequence_replace` | run: `inputs.in` = [slot N asset], `argv` = ffmpeg with `{{in:0}}` as the input path, `setpts`/`atempo` filters, and `{{out:fast.mp4}}` as the output path; `outputs` = [{name: "fast.mp4", mime: "video/mp4"}]. replace into slot N with the output asset. |
| 第 N 段换一个角度 / 再来一版 / 重做 | `vh_generate_video` → `vh_sequence_replace` | generate: `prompt` (only the named change differs from the base), `inputs.reference` = same as the base record (usually `["c1@1"]`), `continue_from` = same as the base record when it had one, `base_op` = producing record of slot N, `replaces: [that record]`, `duration_sec` = same, `user_requested: true`. replace: `slot` = N, `asset` = output #0 of the new record. The old take stays available. |
| 换人 / 这个人换成这张图 | `vh_asset_upload` → `vh_entity_character_update` → report stale → (after the user chooses) retakes | upload: `path`, `mime`. update: `entity` = the character id, `refs` = [new asset id]. Then list the stale shots with cost and ask; redo only the agreed ones as retakes with `inputs.reference` = `c1@<new version>`. |
| 换风格 / 加胶片感 | `vh_entity_style_create` (or `_update`) → propose retakes | create: `entity` (such as `s1`), `name`, `description`. Add `s1@1` to `inputs.reference` of each retake and name it as a picture in the prompt; retakes need the user's go-ahead. |
| 把第 A 段放到第 B 段前面 | `vh_sequence_move` | `from` = A, `to` = B. After chained shots, warn that the join may not be continuous and offer a retake of the moved-after shot. |
| 删掉第 N 段 | `vh_sequence_remove` | `slot` = N. Later slots move up; say the new numbering. |
| 在第 N 段后面加一段 | `vh_generate_video` → `vh_sequence_insert` | generate: `prompt`, `inputs.reference`, `continue_from` = producing record of slot N when chained, `user_requested: true`. insert: `at` = N + 1, `asset` = output #0. |
| 回到第 N 段上一版 | `vh_sequence_replace` | `slot` = N, `asset` = the earlier take's asset (from "Takes" in the project block). No generation. |
| 开一个分支试 X | `vh_branch_create` → work there → `vh_branch_use main` | create: `name` (short, user's word), `at` = a record id from the project block or `main`. Say that `main` is untouched. |
| 撤销 / 回到上一步 | `vh_undo` (latest accepted turn only) | none. For an earlier step, offer `vh_branch_create` at the record before it instead. |
| 看一下第 N 段的最后一帧 / 第 t 秒 | `vh_media_extract_frame` → `vh_perception_describe` when a judgment is needed | frame: `inputs.clip` = slot N asset, `at` = `last`, `first`, or a number of seconds (never a numeric string). describe: `inputs.image` = the frame asset, `question`. |
| 合成 / 导出成片 | `vh_media_concat` | `inputs.clip` = the slot assets in timeline order; then give the link. |
| 不要了 / 算了 | `vh_turn_reject` | none; say what was discarded. |

## Rules that apply to every row

- A retake without `inputs.reference` fails with "ref2va requires 1 to 8 reference images"; copy the base record's references every time.
- `replaces` marks consumers of the old output stale; the runtime replays deterministic ones (trims) on the new output by itself. Do not redo them by hand.
- After any generation, `vh_wait` then `vh_project_state`, and report the last frame and link.
- If the earlier turn's draft is still open, `vh_turn_accept` (user built on it) or `vh_turn_reject` (user dropped it) comes before any row above.
- When "第 N 段" or "这个" has two candidates and no reported selection, ask.
