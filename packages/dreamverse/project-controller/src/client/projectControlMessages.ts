import { isJsonObject } from './json.ts'

/** The server's phase of the current generation round. */
export type GenerationRoundStatus = 'idle' | 'preparing' | 'generating' | 'failed'

const GENERATION_ROUND_STATUSES: readonly string[] = ['idle', 'preparing', 'generating', 'failed']

/** Whether a server value is a generation round phase. */
function isGenerationRoundStatus(value: unknown): value is GenerationRoundStatus {
  return typeof value === 'string' && GENERATION_ROUND_STATUSES.includes(value)
}

/** The project indicators that server messages set. */
export interface ProjectControlFields {
  queuePosition: number
  generationRoundStatus: GenerationRoundStatus
  autoExtensionEnabled: boolean
  gpuAssigned: boolean
}

/**
 * Update connection allocation and generation round status from server messages.
 * @param state - the current indicators, possibly with other fields that the update keeps.
 * @param data - one decoded server message; other message types and non-object values change nothing.
 * @returns the updated state.
 */
export function applyProjectControlMessage<T extends ProjectControlFields>(
  state: T,
  data: unknown,
): T {
  if (!isJsonObject(data)) {
    return state
  }

  if (data.type === 'queue_status') {
    return {
      ...state,
      queuePosition: typeof data.position === 'number' ? data.position : state.queuePosition,
    }
  }

  if (data.type === 'generation_round_status') {
    return {
      ...state,
      generationRoundStatus: isGenerationRoundStatus(data.status) ? data.status : state.generationRoundStatus,
      autoExtensionEnabled: data.auto_extension_enabled === true,
    }
  }

  if (data.type === 'gpu_assigned') {
    return {
      ...state,
      gpuAssigned: true,
      queuePosition: 0,
    }
  }

  return state
}
