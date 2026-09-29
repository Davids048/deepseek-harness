/** The number of prompt events that the page retains, newest first. */
export const MAX_PROMPT_EVENTS = 24

/** Where a prompt event is in its lifecycle: user submission, server enhancement, generation, or LLM rewrite. */
export type PromptEventStatus =
  | 'submitted'
  | 'queued'
  | 'enhancing'
  | 'ready'
  | 'consumed'
  | 'failed'
  | 'rewrite_requested'
  | 'rewrite_ready'
  | 'rewrite_raw_output'
  | 'rewrite_error'

/** One prompt the page shows in the directing timeline: a user prompt, an enhanced prompt, or an LLM rewrite. */
export interface PromptEvent {
  promptId: string
  status: PromptEventStatus
  /** The prompt's origin, for example `user_raw`, `user_rewrite`, `llm_rewrite`, or a server prompt source. */
  source?: string | undefined
  text?: string | undefined
  model?: string | undefined
  latencyMs?: number | null | undefined
  /** Frame captured when the user submitted the prompt. */
  thumbnail?: string | null | undefined
  /** Frame captured from the clip that the prompt produced. */
  resultThumbnail?: string | null | undefined
  /** The completed clip that the prompt produced. */
  clipId?: string | undefined
  /** The prompt window that a rewrite request edited. */
  sourcePromptWindowPrompts?: string[] | undefined
}

/** Fields that a later server message or clip archive sets on an existing prompt event. */
export type PromptEventUpdate = Partial<Omit<PromptEvent, 'promptId'>>

/**
 * Apply an update to the event with the given prompt ID.
 * @param events - retained events, newest first.
 * @param promptId - the prompt ID to update; no event changes when none matches.
 * @param update - fields that replace the event's fields.
 * @returns the events with the matching event updated.
 */
export function updatePromptEvent(
  events: readonly PromptEvent[],
  promptId: string,
  update: PromptEventUpdate,
): PromptEvent[] {
  return events.map(event => (
    event.promptId === promptId
      ? { ...event, ...update }
      : event
  ))
}

/**
 * Add an event as the newest one and drop events beyond {@link MAX_PROMPT_EVENTS}.
 * @param events - retained events, newest first.
 * @param event - the new event.
 * @returns the retained events with the new event first.
 */
export function prependPromptEvent(
  events: readonly PromptEvent[],
  event: PromptEvent,
): PromptEvent[] {
  return [event, ...events].slice(0, MAX_PROMPT_EVENTS)
}
