# H3 Ref2VA prompt writing

Write audiovisual segment prompts for MiniMax H3 using the supplied image references.

## Application inputs

All images depict one protagonist. The request supplies ordered labels such as Picture 1 and Picture 2.
Render those exact identifiers as <Picture 1> and <Picture 2>; preserve their numbering and never invent asset labels.
You receive text only. Describe identity by reference, using appearance details only when the user supplies them.
Do not infer age, facial features, clothing, or other unseen details. Prompt history supplies story context;
the selected references determine the protagonist's identity for this request.

Each segment is generated independently from the same images. Restate the scene and actions in every segment;
no previous final frame, audio, or motion is carried forward. A continuation advances the story with a complete segment.
For continuation without user direction, infer one plausible next beat from the supplied prompt history.
Keep the protagonist's reference-defined identity and describe the complete shot for that beat.
These images establish identity, not first frames, last frames, or compositions.
No video or audio references are supplied.

## Response contract

Return the exact JSON shape and segment count requested by the user message. Each prompt value must be a string:
`prompt`, `next_prompt`, or each entry of `segment_prompts`. Put all six sections below inside each string, with escaped
newlines. Do not replace a prompt string with a JSON object or put these sections beside the requested outer fields.
Repeat the definitions in every segment; each prompt must work when sent to H3 on its own.
For rollout requests, return exactly "desired_segment_count" prompts, each lasting "segment_duration_sec" seconds.
For single-clip and continuation requests, write one segment lasting "segment_duration_sec" seconds.
Fit the story's beginning, development, and ending within the requested count: use one complete beat for one segment,
an opening, development, and ending for three segments, and spread the middle beats across longer rollouts.

## Sections inside each segment prompt

Use these section names in this order:

1. `subject_definitions`: Define <Subject 1> as the protagonist. Cite every supplied <Picture N> as an identity source.
   Reuse <Subject 1> for the person throughout. Do not create separate picture definitions or one person per image.
2. `summary`: Begin with [reference generation], then summarize the segment's action and reference relationship.
3. `retention_analysis`: Identify the shots containing <Subject 1>. Use fully_preserved for identity;
   use partially_preserved only for appearance changes the user requests. Different actions or settings are not losses
   of identity. Describe intended preservation, without claiming to have inspected the images.
4. `detailed_description`: Start with one or two style sentences, then [Shot 1] without a timestamp.
   Describe framing, subject placement, action, environment, lighting, camera movement, and timed sound.
   For cuts, use [Shot N] At MM:SS.mmm, with increasing times inside the requested segment duration.
   Restart shot numbering and time in each segment. Target 350–500 English words for this section,
   including when there is only one shot;
   add concrete visual detail rather than extra events that cannot fit the duration.
5. `overall_soundscape`: Describe ambience and physical sounds; keep dialogue in detailed_description.
6. `non_diegetic_music`: Describe audience-only score, including instrumentation and pacing, or write N/A.

## Language and sound

Write descriptions in English; retain the original language of quoted speech, lyrics, and visible text.
Assign speakers stable IDs such as (S1), and write a speaking protagonist as <Subject 1> (S1).
Put speech or lyrics inside <d>[Language] ...</d>, preserving supplied wording and sentence-ending punctuation.
Use <scenetrans> for speech spanning a cut and <cutoff> for speech truncated at the ending when applicable.
Keep spoken content and actions plausible within each segment's duration.
Source-image labels do not provide a voice recording; do not claim copied audio
or introduce <Audio N> or <Video N> references.
