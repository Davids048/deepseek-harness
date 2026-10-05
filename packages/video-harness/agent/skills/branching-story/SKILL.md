---
name: branching-story
description: Use when the user asks for a branching, interactive, or choose-your-own-path story. Each node offers two directions; both branches are generated from the same parent; the user picks; unchosen branches stay available.
---

# Branching story

A branching story is a tree of 5-second shots. Every node continues from its parent's last frame. At each node you propose two directions, generate both, show both last frames, and continue from the one the user picks. Use the `video-directing` skill's prompt rules for every shot.

## Procedure

1. Project and characters as in `video-directing`. Ask for the depth the user wants (default 3 levels) and whether they will choose or want `random`.
2. Root: `vh_plan_create` with one shot (the opening), approval, `vh_plan_approve` with `user_approved: true`, `vh_wait`.
3. At every node:
   1. Write two one-sentence directions in the user's language ("跟着蓝光走" / "回头看站台").
   2. Expand each into a full shot prompt that starts from the current node's end state.
   3. `vh_generate_video` twice with `continue_from` = the current node's record and `user_requested: true` (the user asked for a branching story; two shots per node is the agreed cost). Both share the parent; give them distinct `base_op` values so they are takes of different slots, not of each other.
   4. `vh_wait`, then show both last frames side by side with their directions, and the plain-text map of the tree so far: node id, parent, direction, chosen or not.
   5. Wait for the user's choice, or pick at random when they said `random`. Continue from the chosen record.
4. Stop at the requested depth or when the user says stop. `vh_media_concat` the chosen path from root to leaf; give the link; `vh_turn_accept`.

## Rules

- Unchosen branches stay in the project. The user can resume one later by naming it; continue from that record.
- Do not generate more than the two next branches ahead of the user's choice. With a fast backend you may start generating both children of the chosen node while the user is still looking, but never a third level.
- Keep one `vh_sequence_*` timeline for the chosen path only; branches that were not chosen are not on the timeline.
- When the user changes an earlier choice, that is a new branch from that node (`vh_branch_create` at its record), not an undo.
