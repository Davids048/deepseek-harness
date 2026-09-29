import { applyProjectControlMessage, type GenerationRoundStatus } from '../projectControlMessages.ts'
import { createManagedStore, type ManagedStore } from './createManagedStore.ts'

/** Page-owned project indicators, generation controls, and choices retained between projects. */
export interface ProjectControlsState {
  connected: boolean
  connecting: boolean
  /** Local creation began; the project remains viewable after its socket closes. */
  projectStarted: boolean
  queuePosition: number
  gpuAssigned: boolean
  enhancementEnabled: boolean
  /** Draft opt-in captured when the next generation request is submitted. */
  autoExtensionRequested: boolean
  /** Server-confirmed permission to schedule another auto_extension round. */
  autoExtensionEnabled: boolean
  promptExtensionError: string
  /** The server settles each accepted round independently of streamed media playback. */
  generationRoundStatus: GenerationRoundStatus
  /** Shared by the initial-prompt and active continuation inputs. */
  livePromptDraft: string
  projectNotice: string
  livePromptRewriteMode: boolean
  /** An opened project socket closed; received clips remain available. */
  connectionClosed: boolean
  projectResetPending: boolean
}

/** The project controls of a page with no project. */
const DEFAULT_PROJECT_CONTROLS: ProjectControlsState = {
  connected: false,
  connecting: false,
  projectStarted: false,
  queuePosition: 0,
  gpuAssigned: false,
  enhancementEnabled: true,
  autoExtensionRequested: false,
  autoExtensionEnabled: false,
  promptExtensionError: '',
  generationRoundStatus: 'idle',
  livePromptDraft: '',
  projectNotice: '',
  livePromptRewriteMode: false,
  connectionClosed: false,
  projectResetPending: false,
}

/** The project controls store: the managed state plus reset and server message handling. */
export type ProjectControlsStore = ManagedStore<ProjectControlsState> & {
  reset: (overrides?: Partial<ProjectControlsState>) => ProjectControlsState
  applyServerUiMessage: (data: unknown) => ProjectControlsState
}

/**
 * Create controls with default, constructor, and explicit reset overrides in that order.
 * @param initialState - fields that replace the defaults, also on reset.
 * @returns the project controls store.
 */
export function createProjectControlsStore(
  initialState: Partial<ProjectControlsState> = {},
): ProjectControlsStore {
  const store = createManagedStore<ProjectControlsState>({
    ...DEFAULT_PROJECT_CONTROLS,
    ...initialState,
  })

  return {
    ...store,
    reset(overrides: Partial<ProjectControlsState> = {}) {
      return store.set({
        ...DEFAULT_PROJECT_CONTROLS,
        ...initialState,
        ...overrides,
      })
    },
    applyServerUiMessage(data: unknown) {
      return store.update(state => applyProjectControlMessage(state, data))
    },
  }
}

export { DEFAULT_PROJECT_CONTROLS }
