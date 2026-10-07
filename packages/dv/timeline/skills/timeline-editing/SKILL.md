# Timeline editing

Resolve "第 N 段 / clip N" first: it is clip N of the first timeline in the project block, or of the timeline the user names. Read the clip's clip ID (such as `cl3`, the `clip` argument of every `dv_timeline_clip_*` call except insert), its asset ID, the record that produced it, that record's tool (`dv_shot_render_ref2va` or `dv_shot_render_t2va`), and, for a shot that continued the previous one, the record it continued from. `reason` is required on every call. Deterministic calls (timeline edits, export, still) and reads (`dv_inspect_asset`, `dv_inspect_image`) run at once; a render that the user asked for by name carries `user_requested: true`; anything you propose yourself is described and left for the user to agree to, with the question in bold.

| User says | Calls, in order | Required arguments |
| --- | --- | --- |
| 剪掉第 N 段的开头 (X 秒) | `dv_timeline_clip_trim` | `clip` = clip N's clip ID, `in_sec` = X (default 1.0 when unspecified; say so), `out_sec` = the clip's current out point when it has one. The clip file stays unchanged. |
| 剪掉第 N 段的结尾 (X 秒) | `dv_inspect_asset` → `dv_timeline_clip_trim` | inspect: `inputs.asset` = clip N's asset (read `duration_sec`). trim: `clip` = clip N's clip ID, `in_sec` = the clip's current in point when it has one, `out_sec` = duration − X. |
| 第 N 段只要从 A 秒到 B 秒 | `dv_timeline_clip_trim` | `clip` = clip N's clip ID, `in_sec` = A, `out_sec` = B. The clip file stays unchanged. |
| 第 N 段换一个角度 / 再来一版 / 重做 | the tool of clip N's render mode (`dv_shot_render_ref2va` or `dv_shot_render_t2va`) → `dv_timeline_clip_replace` | render: `prompt` (only the named change differs from the base), `based_on` = the record that produced clip N, `supersedes: [that record]`, `duration_sec` = same, `user_requested: true`; for `ref2va` also `inputs.reference` = same as the base record (usually `["c1@1"]`) and `continue_from` = same as the base record when it had one. replace: `clip` = clip N's clip ID, `asset` = output #0 of the new record. The old take stays available. |
| 换人 / 这个人换成这张图 | `dv_asset_import` → `dv_bible_character_update` → report stale → (after the user chooses) retakes | import: `path`, `mime`. update: `character` = the character ID, `inputs.reference` = [new asset ID]. Then list the stale shots and ask in bold; redo only the agreed ones as retakes with `inputs.reference` = `c1@<new version>`. |
| 换风格 / 加胶片感 | `dv_bible_style_create` (or `dv_bible_style_update`) → propose retakes | create: `style` (such as `s1`), `name`, `description`. Add `s1@1` to `inputs.reference` of each `dv_shot_render_ref2va` retake and name it as a picture in the prompt; retakes need the user's agreement, asked in bold. |
| 把第 A 段放到第 B 段前面 | `dv_timeline_clip_move` | `clip` = clip A's clip ID, `to` = B (a position). When a moved shot or the shot after it continued its previous shot, say that the join may not be continuous and offer a retake. |
| 删掉第 N 段 | `dv_timeline_clip_remove` | `clip` = clip N's clip ID. Later clips move up; say the new numbering. |
| 故事再长一点 / 再加几个镜头 / 改一下故事 (a timeline that a plan made) | `dv_plan_update` → show the changed shots and their cost, ask in bold → (after the user agrees) `dv_plan_approve` | update: `plan` = the plan ID from the project block, every shot of the next version in order with the unchanged shots copied exactly (a shot added after six shots is shot 7). approve: `plan`, `user_approved: true`; only new or changed shots render and the plan's timeline gets every shot. Never create a second plan for the same story. |
| 在第 N 段后面加一段 | `dv_shot_render_ref2va` or `dv_shot_render_t2va` → `dv_timeline_clip_insert` | render: `prompt`, `user_requested: true`; for `ref2va` also `inputs.reference`, and `continue_from` = the record that produced clip N when the new shot continues it. insert: `at` = N + 1, `asset` = output #0. |
| 回到第 N 段上一版 | `dv_timeline_clip_replace` | `clip` = clip N's clip ID, `asset` = the earlier take's asset (from the takes in the project block). No render. |
| 撤销 / 回到上一步 | `dv_proj_undo` | none: it undoes one step on the branch you write to (your draft, else `main`). `dv_proj_redo` moves forward one step. |
| 回到之前 / 撤销到… / 回到上一版 (the project, not one clip) / roll back | `dv_proj_history_list` → `dv_proj_undo` | list: find the record of the step to return to. undo: `to` = that record ID; the project returns to its state just after it. Never rebuild the earlier state with new edits (clip replaces, a new plan version). |
| 看一下第 N 段的最后一帧 / 第 t 秒 | `dv_asset_grab_still` → `dv_inspect_image` when a judgment is needed | still: `inputs.video` = clip N's asset, `at` = `last`, `first`, or a number of seconds (never a numeric string). inspect: `inputs.image` = the still asset, `question`. |
| 合成 / 导出成片 | `dv_deliver_timeline_export` | `timeline` = the timeline's ID (default: the first timeline); it trims each clip with an in or out point to that range and joins the clips in timeline order; then give the link. |
| 不要了 / 算了 (the whole draft) | `dv_proj_draft_discard` | none; say what was discarded. |
| 就这样 / 保存 / 确认草稿 | `dv_proj_draft_accept` | none; say what was accepted. |

## Rules that apply to every row

- A `dv_shot_render_ref2va` retake without `inputs.reference` is refused; copy the base record's references every time. A `dv_shot_render_t2va` retake takes no references.
- `supersedes` marks the records that used the old output stale (stills, exports). Nothing reruns by itself: list them and redo only what the user agrees to. When the user keeps a stale result as it is, call `dv_proj_stale_accept` with its record.
- After any render, `dv_proj_wait` then `dv_proj_state`, and report the last frame and link.
- When "第 N 段" or "这个" fits two clips and the message names no reference (a `dv:` mention), ask.
