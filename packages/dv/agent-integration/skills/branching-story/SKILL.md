---
name: branching-story
description: Use when the user asks for a branching, interactive, or choose-your-own-path story. Each node offers two directions; both branches are rendered from the same parent; the user picks; unchosen branches stay available.
---

# Branching story

A branching story is a tree of 5-second shots. Every node continues from its parent's last frame. At each node you propose two directions, render both, show both last frames, and continue from the one the user picks. Use the `video-directing` skill's prompt rules for every shot.

## Procedure

1. Project and characters as in `video-directing`. Ask for the depth the user wants (default 3 levels) and whether they will choose or want `random`.
2. Root: `dv_plan_create` with one shot (the opening), approval, `dv_plan_approve` with `plan` = the plan ID from its report and `user_approved: true`, `dv_proj_wait`.
3. At every node:
   1. Write two one-sentence directions in the user's language ("跟着蓝光走" / "回头看站台").
   2. Expand each into a full shot prompt that starts from the current node's end state.
   3. `dv_shot_render` twice with `continue_from` = the current node's record and `user_requested: true` (the user asked for a branching story; two shots per node is the agreed cost). Both share the parent; give them distinct `based_on` values so they are takes of different shots, not of each other.
   4. `dv_proj_wait`, then show both last frames side by side with their directions, and the plain-text map of the tree so far: node id, parent, direction, chosen or not.
   5. Wait for the user's choice, or pick at random when they said `random`. Continue from the chosen record.
4. Stop at the requested depth or when the user says stop. Put the chosen path from root to leaf on a timeline with `dv_timeline_create` (`assets` in path order) and export that timeline with `dv_deliver_timeline_export`; give the link; when the user asks to keep the result, `dv_proj_draft_accept`.

## Rules

- Unchosen branches stay in the project. The user can resume one later by naming it; continue from that record.
- Do not render more than the two next branches ahead of the user's choice. With a fast backend you may start rendering both children of the chosen node while the user is still looking, but never a third level.
- Keep one timeline for the chosen path only; branches that were not chosen are not on the timeline.
- When the user changes an earlier choice, that is a new branch from that node (`dv_proj_branch_create` at its record), not an undo. When the user asks to go back without choosing differently, use `dv_proj_undo` with `to`.
