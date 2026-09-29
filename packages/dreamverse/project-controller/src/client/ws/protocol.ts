import { isJsonObject, type JsonObject } from '../json.ts'

/** The page reducer's event name for each server event type that the page handles. */
const EVENT_TYPE_MAP = {
  queue_status: 'session/queue_status',
  prompt_received: 'prompt/received',
  prompt_enhancing: 'prompt/enhancing',
  prompt_ready: 'prompt/ready',
  seed_prompts_updated: 'prompt_window/updated',
  rewrite_seed_prompts_complete: 'rewrite/completed',
  generation_round_status: 'session/generation_round_status',
  gpu_assigned: 'session/gpu_assigned',
  ltx2_stream_start: 'stream/started',
  media_init: 'stream/media_init',
  media_segment_complete: 'stream/media_segment_complete',
  ltx2_segment_start: 'segment/started',
  ltx2_stream_complete: 'stream/completed',
  error: 'session/error',
} as const

/** A server event type that the page handles. */
type HandledServerEventType = keyof typeof EVENT_TYPE_MAP

/** A reducer event name: a handled server event, or `server/unhandled` for any other message. */
export type NormalizedSocketEventType = (typeof EVENT_TYPE_MAP)[HandledServerEventType] | 'server/unhandled'

/** One project-socket message: its reducer event name and the message object, whose fields the reducer checks. */
export interface NormalizedSocketMessage {
  type: NormalizedSocketEventType
  payload: JsonObject
}

/** Whether a server event type is one the page handles. */
function isHandledServerEventType(type: string): type is HandledServerEventType {
  return Object.hasOwn(EVENT_TYPE_MAP, type)
}

/**
 * Name one decoded project-socket message for the page reducer.
 * @param data - the decoded JSON value; a value that is not an object becomes an empty unhandled message.
 * @returns the reducer event.
 */
export function normalizeSocketMessage(
  data: unknown,
): NormalizedSocketMessage {
  const payload = isJsonObject(data) ? data : {}
  const rawType = typeof payload.type === 'string' ? payload.type : ''

  return {
    type: isHandledServerEventType(rawType) ? EVENT_TYPE_MAP[rawType] : 'server/unhandled',
    payload,
  }
}
