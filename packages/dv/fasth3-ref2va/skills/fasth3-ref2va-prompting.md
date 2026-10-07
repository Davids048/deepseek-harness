# FastH3 prompts for dv_shot_render_ref2va

The `ref2va` render mode renders a shot from a prompt and reference images. The served model is FastH3 Ref2VA, which renders 5 to 15 seconds of video with sound per shot.

## Model limits

- **Every shot needs at least one reference image.** The model renders only from reference images: an imported image, or a character, location or style version with reference images (`c1@1`) in `inputs.reference`. A shot without one is refused before anything renders. When the user gave no reference image, ask for one (they can attach it in the chat) before planning the shot.
- One shot carries at most 8 reference images, plus the first frame.
- `duration_sec` is a whole number from 5 to 15.

## How the prompt names the images

The images reach the model as `Picture 1 … Picture N`: the reference images in `inputs.reference` order (a character version counts each of its reference images), then the first frame. With `continue_from` (or a plan shot with `continue_previous`), the previous shot's last still is the next picture after the reference images, and the shot starts exactly from it.

## Prompt rules

- Name the subject by picture: "Picture 1 is the main character; he …". Identity comes from the picture; never describe the face, and add appearance details only when the user supplied them.
- One clear action per 5-second shot with a beginning and an end state, so the next shot can start from the end state.
- Camera in plain words: framing ("full-body medium-wide"), movement ("slow push-in", "handheld, following from behind").
- Place and light: "bright white studio, even light"; keep them identical across continued shots and change only action and framing.
- One line of sound: ambience and physical sounds, music or "no dialogue". Dialogue goes in the description as quoted speech with its language.
- A shot that starts from the previous last still restates the end state of the previous shot in its first sentence ("The shot begins from the previous frame, arms raised …").
- Under 120 English words per prompt; no adjective lists; keep the same wardrobe words in every shot.
