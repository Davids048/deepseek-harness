---
name: video-directing
description: "The planning procedure for making or changing a video with the dv_* tools: project setup, the story and its shots, a render mode and inputs for each shot, prompts written with the render mode's prompt skill, a plan the user agrees to in the conversation, then rendering, retakes and stale shots."
whenToUse: "The user wants a video made or extended from a description and references, or wants shots of an existing project planned, rendered, retaken or restyled."
---

# Video directing

Every `dv_*` call becomes a record the user sees as a chat card, a canvas node, and a timeline clip. The project block in your system prompt is the current state; read it before every call. Follow this procedure in order unless the user asks for something narrower.

## 1. Project setup

1. When the project block names a project, work in it; never create or switch projects. Only a conversation with no project starts one with `dv_proj_create`.
2. `dv_asset_import` every reference the user gave (`path`, `mime`). Look at each image with `dv_inspect_image` and say in one line what it shows.
3. `dv_bible_character_create` for every person who must stay the same across shots, before any render: `character` (short ID such as `c1`), `name`, `description` (wardrobe and mood only, never facial features), `inputs.reference` (the imported asset IDs). `dv_bible_style_create` only when the user named a look (film grain, palette, lens). `dv_bible_location_create` only when one place must stay identical across shots.

## 2. Organize the story and its shots

1. Split the story into shots, one clear action each. Shot count = requested duration divided by the shot length (default 5 s, whole seconds inside the range of the render mode). "15 秒" is three shots; "30 秒" is six.
2. Write one line per shot: what happens, the camera, and which characters, locations or styles appear.

## 3. Choose each shot's render mode and inputs

Each shot names its own render mode in `mode`. Use only a render mode whose tool you have:

| `mode`   | Tool                    | Inputs                                                                                                          |
| -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ref2va` | `dv_shot_render_ref2va` | the prompt and at least one reference image (`references`: `c1@1` or asset IDs); optionally `continue_previous` |
| `t2va`   | `dv_shot_render_t2va`   | the prompt alone; no references, no previous frame                                                              |

- A shot with a character, a location or a style that must look like its reference images is `ref2va`. A shot that needs no reference image (a landscape, an establishing shot, an object the user only described) can be `t2va` when you have its tool.
- When a shot must be `ref2va` and the user gave no reference image, ask for one (the user can attach it in the chat) before planning.
- `continue_previous: true` makes a `ref2va` shot start from the last frame of the previous shot. It is a choice per shot, not a rule: use it when the shot continues the previous action in the same place; leave it out for a new angle, a new scene, or a shot unrelated to the one before. Shot 1 never continues.
- Plan-level `references` apply to every `ref2va` shot that names no `references` of its own.
- Do not change a shot's render mode, references or `continue_previous` on your own after the user agreed to the plan; propose the change and stop.

## 4. Write each prompt with the render mode's prompt skill

Before writing the prompts, load the prompt skill of every render mode the plan uses: the skill in your skill list whose name ends in `-<mode>-prompting` (such as `fasth3-ref2va-prompting`). Write each shot's `prompt` with the rules of its mode's skill. Prompts of the two modes differ: a `ref2va` prompt names the reference pictures, a `t2va` prompt describes everything in words.

## 5. Create the plan, show it, and ask

1. `dv_plan_create` with `title`, `references` when shots share them, and `shots` (`mode`, `prompt`, `duration_sec`, and per shot `references` or `continue_previous` when needed). The call needs no agreement; it records version 1. Its report names the plan ID (such as `p1`), one line per shot, and `gpu_seconds`, the GPU estimate of approving the plan.
2. Reply with a table (shot, render mode, duration, continues from the previous shot or not, one line of action, camera) and the report's GPU estimate. End the turn with one question in bold, such as **开始渲染这 3 个镜头吗？** Do not call `dv_plan_approve` in this turn.
3. When the user agrees in the next message: `dv_plan_approve` with `plan` and `user_approved: true`, then `dv_proj_wait`, then `dv_proj_state`. The approval renders every shot with its render mode's tool and lays every shot on the plan's timeline.
4. Report each finished shot with its last frame (you receive it as an image) and its link. Inside an approved plan, never ask again.

If the user changes the plan before agreeing, call `dv_plan_update` with `plan` and the changed shots, show the changed plan with the GPU estimate of its report, and ask again.

### Extend, shorten or change the story

One story is one plan. To extend, shorten or change it, also after it was approved, update that plan; create a new plan with `dv_plan_create` only for a separate story.

1. `dv_plan_update` with `plan` = the plan ID from the project block and the complete next version: every shot in order, the unchanged shots copied exactly (same `mode`, prompt, duration, references, `continue_previous` and seed) so their takes are kept. A shot added after six shots is shot 7.
2. Show only the new or changed shots and the GPU estimate from the `dv_plan_update` report (it lists the shots that keep their takes), and ask in bold.
3. When the user agrees: `dv_plan_approve` with `plan` and `user_approved: true`. Only new or changed shots render, and a shot with `continue_previous` after a rendered shot renders too; the plan's timeline gets every shot in order. Never lay a plan's shots onto a timeline by hand.

## 6. Retakes the user asks for

The `timeline-editing` skill maps each editing request to its tool calls. The rules behind it:

- **A retake keeps the render mode and inputs.** A retake of clip N calls the tool of the render mode that produced clip N (`dv_shot_render_ref2va` or `dv_shot_render_t2va`) with `based_on` = the record that produced clip N, `supersedes: [that record]`, the same `inputs.reference` and `continue_from` as that record (`ref2va`), and a prompt that changes only what the user named.
- **A render the user asked for by name carries `user_requested: true`.** A render you propose on your own is described with its cost, and you stop and ask in bold.

## 7. When a reference changes

`dv_bible_character_update` (or a style or location update) makes every record that used the old version stale, and a retake that `supersedes` a record makes the records that used its outputs stale. Nothing is redone by itself.

1. Read the "stale" records in the project block.
2. List the affected shots by clip position.
3. Ask in bold which to redo. Never render a stale shot again without that answer.
4. Redo the agreed ones as retakes (section 6) with the new character, location or style version in `inputs.reference`.

## 8. Words to the user

- Call the model that makes the videos "DreamVerse 视频模型" ("DreamVerse video model" in English replies). Never tell the user a model codename or model ID, such as the `model` field of render records.
- "这个人 / 她 / 他" is a character; with one character it is that one. When the user's words fit two characters, clips or shots and the message names no reference (a `dv:` mention), ask; do not guess.

## 9. Do not

- Do not render before the user agreed to the plan, and do not render stale shots again before the user chose.
- Do not describe faces or invent appearance details.
- Do not create a second plan to extend or change a story; update its plan.
