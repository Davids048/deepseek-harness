# FastH3 prompts for dv_shot_render_t2va

The `t2va` render mode renders a shot from a prompt only. The served model is FastH3 8-Step V2, which renders 5 to 15 seconds of video with sound per shot from text. These rules adapt the MiniMax-H3 base prompt guide (T2VA part).

## Model limits

- The shot has no reference image and no first frame: the model sees only the prompt. Describe every subject, place, wardrobe and style in words, and repeat the same words in every shot where a subject must look the same. A person who must keep a face across shots needs `dv_shot_render_ref2va` with a reference image.
- `duration_sec` is a whole number from 5 to 15.

## Prompt structure

Write the prompt in English as three fields, each starting on its own line with its name, separated by one blank line:

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

- `integrated_multimodal_description`: the main body. Along the timeline, describe what is seen and heard: visual style, opening composition, each subject's appearance and position, the place and key props, actions and reactions, camera motion, shot changes, speakers, dialogue, and the sounds tied to on-screen actions.
- `overall_soundscape`: 1 to 4 sentences in one paragraph on ambient sound, physical action sounds and non-verbal human sounds (wind, footsteps, breathing). Do not repeat dialogue or singing here. Write `N/A` only when the user asked for complete silence.
- `non_diegetic_music`: 1 to 3 sentences on background music only the audience hears: instruments, tempo, rhythm, volume changes; no mood words. Write `N/A` when there is none. Music the characters hear (a radio, a singer) belongs in the description.

## The description

- Start `[Shot 1]` with the overall style and the opening composition, chosen from the user's words: `Live-action, cinematic, a medium-wide shot frames …`. Other styles: `2D-animated`, `3D CG`, `claymation`, `watercolor`, `vintage film`.
- You may add place, character, action and sound details that stay consistent with what the user asked for.
- Every detail must be something visible or audible.

## Several camera shots in one rendered shot

One rendered shot can hold several camera shots. Give `[Shot 1]` no timestamp; start each later one with its number and a strictly increasing switch time inside the duration: `[Shot 2] At 00:03.500, the shot switches to …` (or `the shot transitions to`, `the shot changes to`). A shot change must bring new information (subject, place, state, viewpoint or time); for a small change of distance or angle, move the camera instead.

## Camera motion

Write camera motion as a natural sentence inside the shot, with type, and amplitude and speed only when they matter: "The camera pushes in with small amplitude at slow speed toward the letter in her hands." Types: zoom in / out, push in / pull out, pan left / right, truck left / right, tilt up / down, pedestal up / down, arc shot, tracking shot, static shot, shake slightly / strongly, POV, roll clockwise / counterclockwise. Amplitude: `with small amplitude`, `with large amplitude`. Speed: `at slow speed`, `at fast speed`.

## Speakers and dialogue

- Give each subject who speaks or sings a stable ID such as `(S1)`, `(S2)`, kept across shot changes; use `(S1,S2)` for speakers together. Subjects who never speak get no ID.
- At a speaker's first appearance, give enough to fix the voice: type of character, age, gender, pitch, timbre, speaking rate, accent.
- Put only the language tag and the user's exact words inside `<d>`; keep every word and punctuation mark, never translate: `The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>`
- Voiceover: `says in an off-screen voiceover:`, then the `<d>` block, then state that the on-screen character's lips stay closed.
- A line that continues across a shot change gets `<scenetrans>` at both joining points and a statement that the audio continues across the shot change; speech cut off by the end of the video gets `<cutoff>`.

## On-screen text

Put any sign, label, banner or subtitle that is visible on screen in English double quotes, with the original text kept exactly: `A red neon sign reading "营业中" glows above the doorway.`

## Example

```text
integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames a baker opening the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as the middle-aged baker with a calm, slightly raspy voice (S1) places a fresh loaf on the wooden counter and says: <d>[English] First batch of the morning.</d> [Shot 2] At 00:05.000, the shot switches to a close-up of steam rising from the sliced bread while the baker's final words carry over from the previous shot.

overall_soundscape: Wooden shutters scrape open over a quiet street as trays clink softly inside the bakery. The doorbell rings once, followed by light footsteps and the crisp sound of bread being sliced.

non_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo, joined by sparse upright-bass notes and a gentle fade at the end.
```
