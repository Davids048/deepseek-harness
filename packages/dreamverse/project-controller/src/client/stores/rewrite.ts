import {
  prependPromptEvent,
  updatePromptEvent,
  type PromptEvent,
  type PromptEventUpdate,
} from '../promptEvents.ts'
import { createManagedStore, type ManagedStore } from './createManagedStore.ts'

/** The in-flight rewrite request and the prompt events of the current project. */
export interface RewriteState {
  activeRewritePromptId: string | null
  /** Derived: a rewrite request is in flight. */
  rewritingSeedPrompts: boolean
  promptEvents: PromptEvent[]
}

/** The rewrite state of a page with no project. */
const DEFAULT_REWRITE_STATE: RewriteState = {
  activeRewritePromptId: null,
  rewritingSeedPrompts: false,
  promptEvents: [],
}

/** The rewrite store: the managed state plus rewrite and prompt event operations. */
export type RewriteStore = ManagedStore<RewriteState> & {
  reset: (overrides?: Partial<RewriteState>) => RewriteState
  resetProjectActivity: () => RewriteState
  finishRewriteRequest: (promptId: string | null | undefined) => RewriteState
  trackPromptEvent: (promptId: string, update: PromptEventUpdate) => RewriteState
  addPromptEvent: (event: PromptEvent) => RewriteState
}

/**
 * Own rewrite activity by request ID and retain bounded prompt events.
 * @param initialState - fields that replace the defaults, also on reset.
 * @returns the rewrite store.
 */
export function createRewriteStore(
  initialState: Partial<RewriteState> = {},
): RewriteStore {
  const store = createManagedStore<RewriteState>({
    ...DEFAULT_REWRITE_STATE,
    ...initialState,
  }, state => ({
    ...state,
    rewritingSeedPrompts: state.activeRewritePromptId !== null,
  }))

  return {
    ...store,
    reset(overrides: Partial<RewriteState> = {}) {
      return store.set({
        ...DEFAULT_REWRITE_STATE,
        ...initialState,
        ...overrides,
      })
    },
    /** Clear rewrite activity and its prompt events. */
    resetProjectActivity() {
      return store.patch({
        activeRewritePromptId: null,
        promptEvents: [],
      })
    },
    /** A late terminal response cannot clear another request's activity. */
    finishRewriteRequest(promptId) {
      if (promptId && store.get().activeRewritePromptId === promptId) {
        return store.patch({ activeRewritePromptId: null })
      }
      return store.get()
    },
    trackPromptEvent(promptId, update) {
      return store.update(state => ({
        ...state,
        promptEvents: updatePromptEvent(state.promptEvents, promptId, update),
      }))
    },
    addPromptEvent(event) {
      return store.update(state => ({
        ...state,
        promptEvents: prependPromptEvent(state.promptEvents, event),
      }))
    },
  }
}

export { DEFAULT_REWRITE_STATE }
