/**
 * Branded IDs of the DreamVerse page's project protocol. Each type uses the brand label of the host type that owns the
 * ID, so an ID that the page sends back to the harness has the same type on both sides: `ProjectId` of
 * `@dreamverse/project-store`, and `SegmentId` and `PromptId` of `@dreamverse/project`. The page module that receives an
 * ID from a response or a socket event, or generates one, applies the brand with `brandString`.
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** The harness ID of one stored project. */
export type ProjectId = Branded<'DreamverseProjectId'>

/** The harness ID of one segment of a DreamVerse project. */
export type SegmentId = Branded<'DreamverseSegmentId'>

/** The ID of one prompt request: the `prompt_id` that the page sends and the events about the request carry. */
export type PromptId = Branded<'DreamversePromptId'>
