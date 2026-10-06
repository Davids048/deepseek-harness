---
name: video-directing
description: "The procedure for making and changing a video with the vh_* tools: project setup, a plan the user approves, shot prompt writing for the reference-to-video model, generation, edits, retakes, stale handling, drafts, and reference resolution."
whenToUse: "The user wants a video made from references and a description, or wants an existing project's shots generated, trimmed, retaken, reordered, restyled, or assembled."
---

# Video directing

Every `vh_*` call becomes a record the user sees as a chat card, a canvas node, and a timeline clip. The project block in your system prompt is the current state; read it before every call. Follow this procedure in order unless the user asks for something narrower.

## 1. Project setup

1. When the project block names a project, work in it; never create or switch projects. Only a conversation with no project starts one with `dv_proj_create`.
2. `vh_asset_upload` every reference the user gave (`path`, `mime`). Look at each image with `vh_perception_describe` and say in one line what it shows.
3. `vh_entity_character_create` for every person who must stay the same across shots: `entity` (short id such as `c1`), `name`, `description` (wardrobe and mood only, never facial features), `refs` (the uploaded asset ids). `vh_entity_style_create` only when the user named a look (film grain, palette, lens). `vh_entity_location_create` only when one place must stay identical across shots.

## 2. Plan, then stop and ask

1. Shot count = requested duration divided by the shot length (default 5 s, whole seconds inside the model range). "15 秒" is three shots; "30 秒" is six.
2. Choose `continuity`: `chained` when the shots tell one continuous story (each shot starts from the previous last frame); `independent` when they are separate angles or scenes.
3. Write every shot prompt with the rules in section 6.
4. `vh_plan_create` with `title`, `continuity`, `references` (entity versions such as `c1@1`), and `shots` (`prompt`, `duration_sec`). This call needs no confirmation; it records the proposal.
5. Reply with a table (shot, duration, one line of action, camera), the continuity choice, and the cost: about 4 GPU seconds per video second, so "3 × 5 s ≈ 60 GPU 秒". End the turn with one question: start or change something. Do not call `vh_plan_approve` in this turn.
6. Next turn, when the user agrees: `vh_plan_approve` with `plan` = the plan record id and `user_approved: true`, then `dv_proj_wait`, then `dv_proj_state`. The plan approval renders every shot and builds the timeline in this conversation's draft.
7. Report each finished shot with its last frame (you receive it as an image) and its link. Inside an approved plan, never ask again.

If the user changes the plan before approving, `vh_plan_update` with `user_approved: true` only after they agreed to the changed version.

## 3. Edits the user asks for

The `editing-ops` skill has the full table of phrasings and calls. The rules behind it:

- **Retakes carry the same inputs.** A retake of slot N is `vh_generate_video` with `base_op` = the record that produced slot N, `replaces: [that record]`, `inputs.reference` identical to the base record (read it from the project block or `dv_proj_state`; normally `["c1@1"]`), `continue_from` = the same previous-shot record when the original had one, a prompt that changes only what the user named, and `user_requested: true`. Without `inputs.reference` the backend rejects the call ("ref2va requires 1 to 8 reference images").
- **One named change needs no confirmation.** `user_requested: true` means the user asked for exactly this one generation. A change you propose on your own is not user-requested: describe it, estimate its cost, and stop.
- **Deterministic edits run at once.** `vh_sequence_*`, `vh_media_concat`, `vh_media_extract_frame`, `vh_media_probe` cost no GPU and need no confirmation.
- **The timeline is edited by slot.** A trim is `vh_sequence_set_range` (`slot`, `inSec`, `outSec`) and keeps the clip file. A retake goes into its slot with `vh_sequence_replace` (`slot`, `asset`); the original stays as a take the user can switch back to.
- **Reorder warns, it does not regenerate.** After `vh_sequence_move` on chained shots, say which join may no longer be continuous and offer to retake the shot after the move.

## 4. When a reference changes

`vh_entity_character_update` (or a style or location update) makes every record that used the old version stale, and a retake that `replaces` a record makes the records that used its outputs stale. Nothing is redone by itself: stale records wait for the user, who chooses which to redo or keeps them as they are.

1. Read the "Stale records" line of the project block.
2. List the affected shots by slot with the cost to redo them (about 4 GPU seconds per video second each).
3. Ask which to redo. Never regenerate a stale shot without that answer.
4. Redo the agreed ones as retakes (section 3) with the new entity version in `inputs.reference`.

## 5. Drafts

Your records go to this conversation's draft. The draft stays open across turns and also holds the user's own edits; the user sees it as a preview until the user accepts or discards it.

- Never accept or discard the draft on your own. Call `dv_proj_draft_accept` only when the user asks to accept or keep the draft, and `dv_proj_draft_discard` only when the user asks to throw it away; then say what was accepted or discarded.
- A message that builds on the draft or changes it needs no accept first: keep working in the same draft.
- When a draft holds generative results the user has not judged yet, end your reply with "草稿待确认" and the question that settles it. Do not accept it yourself.
- `dv_proj_undo` moves `main` back by one accepted draft or one direct change, and `dv_proj_redo` brings it back. For an earlier step, offer `dv_proj_branch_create` at the record before that step and explain why.
- Exploration ("试另一种风格，但别动现在的"): `dv_proj_branch_create` with `name` and `at` (a record id from the project block, or `main`) creates `explore/<name>` and switches this conversation to it; work there, then `dv_proj_branch_switch` with `name` = `main` to return.

## 6. Prompt rules for reference-to-video

With the user, call this model "DreamVerse 视频模型" ("DreamVerse video model" in English replies), never by a codename or model ID.

Reference images reach the model as `Picture 1 … Picture N` in `inputs.reference` order; with `continue_from`, the previous last frame is the next picture and the shot starts exactly from it.

- Name the subject by picture: "Picture 1 is the main character; he …". Identity comes from the picture; never describe the face, and add appearance details only when the user supplied them.
- One clear action per 5-second shot with a beginning and an end state, so the next shot can start from the end state.
- Camera in plain words: framing ("full-body medium-wide"), movement ("slow push-in", "handheld, following from behind").
- Place and light: "bright white studio, even light"; keep them identical across chained shots and change only action and framing.
- One line of sound: ambience and physical sounds, music or "no dialogue". Dialogue goes in the description as quoted speech with its language.
- A continued shot restates the end state of the previous shot in its first sentence ("The shot begins from the previous frame, arms raised …").
- Under 120 English words per prompt; no adjective lists; keep the same wardrobe words in every shot.

## 7. Reference resolution

- "第 N 段 / clip N" is timeline slot N in the project block: its asset and its producing record. "最后一段" is the highest slot.
- "这个人 / 她 / 他" is a character entity; with one character it is that one.
- "这个 / this" with a reported user selection is that selection.
- "换个角度 / 再来一版 / 重做" is a retake of a slot (section 3); "回到上一版" is `vh_sequence_replace` with the earlier take's asset.
- Two candidates and no selection: ask, do not guess.

## 8. Tool pitfalls

- `vh_media_extract_frame` `at`: pass a number of seconds, or the word `first` or `last`. Never a numeric string such as `"6.3"`.
- `vh_generate_video` requires `prompt` and `inputs.reference`; `continue_from` is a record id, not an asset id; `duration_sec` is a whole number.
- `vh_plan_approve` needs the plan record id and `user_approved: true`; while the user's composer asks first, the call waits for the user's approval card.
- `dv_proj_wait` before `dv_proj_state` when a call returned `scheduled` records.

## 9. Do not

- Do not generate before the first plan is approved, and do not regenerate stale shots before the user chose.
- Do not describe faces or invent appearance details.
- Do not accept or discard a draft unless the user asks.
- Do not change references, style, shot count, or continuity on your own; propose and stop.
- Do not resolve an ambiguous "这个" by guessing.
