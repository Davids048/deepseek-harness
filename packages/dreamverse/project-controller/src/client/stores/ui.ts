import { createManagedStore, type ManagedStore } from './createManagedStore.ts'

/** Page modes and the developer prompt editor's controls. */
export interface UiState {
  isMonitorRoute: boolean
  demoMode: boolean
  devtoolsMode: boolean
  editableMode: boolean
  appendingPromptWindow: boolean
  appendPromptWindowStatus: string
  appendPromptWindowError: string
  promptConfigEditorOpen: boolean
  promptConfigLoading: boolean
  promptConfigSaving: boolean
  promptConfigLoaded: boolean
  promptConfigError: string
  promptConfigStatus: string
  nextSegmentPromptEditorOpen: boolean
  autoExtensionPromptEditorOpen: boolean
  rewriteWindowPromptEditorOpen: boolean
  nextSegmentSystemPromptDraft: string
  autoExtensionSystemPromptDraft: string
  rewriteWindowSystemPromptDraft: string
}

/** The UI state of the regular page: no page mode enabled and every editor closed except the rewrite window. */
const DEFAULT_UI_STATE: UiState = {
  isMonitorRoute: false,
  demoMode: false,
  devtoolsMode: false,
  editableMode: false,
  appendingPromptWindow: false,
  appendPromptWindowStatus: '',
  appendPromptWindowError: '',
  promptConfigEditorOpen: false,
  promptConfigLoading: false,
  promptConfigSaving: false,
  promptConfigLoaded: false,
  promptConfigError: '',
  promptConfigStatus: '',
  nextSegmentPromptEditorOpen: false,
  autoExtensionPromptEditorOpen: false,
  rewriteWindowPromptEditorOpen: true,
  nextSegmentSystemPromptDraft: '',
  autoExtensionSystemPromptDraft: '',
  rewriteWindowSystemPromptDraft: '',
}

/** The UI store: the managed state plus reset operations. */
export type UiStore = ManagedStore<UiState> & {
  reset: (overrides?: Partial<UiState>) => UiState
  resetPromptEditorState: () => UiState
}

/**
 * Own page modes and developer prompt-editor controls.
 * @param initialState - fields that replace the defaults, also on reset.
 * @returns the UI store.
 */
export function createUiStore(
  initialState: Partial<UiState> = {},
): UiStore {
  const store = createManagedStore<UiState>({
    ...DEFAULT_UI_STATE,
    ...initialState,
  })

  return {
    ...store,
    reset(overrides: Partial<UiState> = {}) {
      return store.set({
        ...DEFAULT_UI_STATE,
        ...initialState,
        ...overrides,
      })
    },
    /** Restore editor drafts, flags, and operation status while retaining page modes. */
    resetPromptEditorState() {
      return store.patch({
        appendingPromptWindow: false,
        appendPromptWindowStatus: '',
        appendPromptWindowError: '',
        promptConfigEditorOpen: false,
        promptConfigLoading: false,
        promptConfigSaving: false,
        promptConfigLoaded: false,
        promptConfigError: '',
        promptConfigStatus: '',
        nextSegmentPromptEditorOpen: false,
        autoExtensionPromptEditorOpen: false,
        rewriteWindowPromptEditorOpen: true,
        nextSegmentSystemPromptDraft: '',
        autoExtensionSystemPromptDraft: '',
        rewriteWindowSystemPromptDraft: '',
      })
    },
  }
}

export { DEFAULT_UI_STATE }
