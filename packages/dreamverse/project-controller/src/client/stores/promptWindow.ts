import type { StoryPreset } from '../presets.ts'
import { createManagedStore, type ManagedStore } from './createManagedStore.ts'

/**
 * Keep the nonempty prompt strings of a list in order, trimmed.
 * @param nextPrompts - a prompt list; any other value counts as an empty list.
 * @returns the trimmed nonempty prompts.
 */
function normalizePromptList(
  nextPrompts: unknown,
): string[] {
  if (!Array.isArray(nextPrompts)) {
    return []
  }

  return nextPrompts
    .map(prompt =>
      typeof prompt === 'string' ? prompt.trim() : '',
    )
    .filter(prompt => prompt.length > 0)
}

/** Story preset selection, the developer prompt editor's drafts, and the server's accepted prompt window. */
export interface PromptWindowState {
  editableMode: boolean
  storyPresets: StoryPreset[]
  selectedPresetId: string
  /** Derived: the story preset whose ID is `selectedPresetId`. */
  selectedPreset: StoryPreset | null
  previewSegments: string[]
  maxCuratedPromptCount: number
  curatedPromptLimit: number
  outboundCuratedPrompts: string[]
  seedPrompts: string[]
  currentPromptWindowPrompts: string[]
  initialPrompts: string[]
  initialPromptSelectionReady: boolean
  editableSegments: string[]
  sanitizedEditableSegments: string[]
  editablePromptsValid: boolean
  editableDirty: boolean
  customPresetId: string
  customPresetLabel: string
}

/** Derive initial prompts, selection readiness, and the displayed prompt window from drafts and presets. */
function derivePromptWindowState(
  state: PromptWindowState,
): PromptWindowState {
  const storyPresets = Array.isArray(state.storyPresets)
    ? state.storyPresets
    : []

  let selectedPresetId =
    typeof state.selectedPresetId === 'string'
      ? state.selectedPresetId
      : ''
  const [firstPreset] = storyPresets
  if (
    selectedPresetId &&
    firstPreset &&
    !storyPresets.some(preset => preset.id === selectedPresetId)
  ) {
    selectedPresetId = firstPreset.id
  }
  const selectedPreset =
    storyPresets.find(preset => preset.id === selectedPresetId) ||
    null

  const editableSegments = Array.isArray(state.editableSegments)
    ? state.editableSegments
    : []
  const sanitizedEditableSegments =
    normalizePromptList(editableSegments)
  const editablePromptsValid = sanitizedEditableSegments.length >= 2

  const previewSegments = state.editableMode
    ? sanitizedEditableSegments
    : normalizePromptList(selectedPreset?.segment_prompts)

  const maxCuratedPromptCount = previewSegments.length
  let curatedPromptLimit = Number.parseInt(String(state.curatedPromptLimit), 10)
  if (!Number.isFinite(curatedPromptLimit)) {
    curatedPromptLimit = 0
  }
  if (maxCuratedPromptCount === 0) {
    curatedPromptLimit = 0
  } else if (
    curatedPromptLimit < 1 ||
    curatedPromptLimit > maxCuratedPromptCount
  ) {
    curatedPromptLimit = maxCuratedPromptCount
  }

  const outboundCuratedPrompts =
    curatedPromptLimit > 0
      ? previewSegments.slice(0, curatedPromptLimit)
      : []
  const seedPrompts = normalizePromptList(state.seedPrompts)
  const initialPrompts = outboundCuratedPrompts
  const currentPromptWindowPrompts =
    seedPrompts.length > 0 ? seedPrompts : initialPrompts
  const initialPromptSelectionReady = state.editableMode
    ? editablePromptsValid
    : Boolean(selectedPreset)

  return {
    ...state,
    storyPresets,
    selectedPresetId,
    selectedPreset,
    editableSegments,
    sanitizedEditableSegments,
    editablePromptsValid,
    previewSegments,
    maxCuratedPromptCount,
    curatedPromptLimit,
    seedPrompts,
    outboundCuratedPrompts,
    initialPrompts,
    currentPromptWindowPrompts,
    initialPromptSelectionReady,
  }
}

/** The prompt window state of a page with no presets or project. */
const DEFAULT_PROMPT_WINDOW_STATE: PromptWindowState = {
  editableMode: false,
  storyPresets: [],
  selectedPresetId: '',
  selectedPreset: null,
  previewSegments: [],
  maxCuratedPromptCount: 0,
  curatedPromptLimit: 0,
  outboundCuratedPrompts: [],
  seedPrompts: [],
  currentPromptWindowPrompts: [],
  initialPrompts: [],
  initialPromptSelectionReady: false,
  editableSegments: [],
  sanitizedEditableSegments: [],
  editablePromptsValid: false,
  editableDirty: false,
  customPresetId: '',
  customPresetLabel: '',
}

/** Options of {@link PromptWindowStore.replacePromptWindow}. */
export interface ReplacePromptWindowOptions {
  /** In editable mode, also replace the editor drafts with the accepted prompts. */
  syncEditable?: boolean
}

/** The prompt window store: the managed state plus preset, prompt window, and editor operations. */
export type PromptWindowStore = ManagedStore<PromptWindowState> & {
  reset: (overrides?: Partial<PromptWindowState>) => PromptWindowState
  resetProjectPromptState: () => PromptWindowState
  setStoryPresets: (
    nextStoryPresets: StoryPreset[],
  ) => PromptWindowState
  appendStoryPreset: (
    preset: StoryPreset,
  ) => PromptWindowState
  setSelectedPresetId: (
    selectedPresetId: string,
  ) => PromptWindowState
  setCuratedPromptLimit: (
    curatedPromptLimit: number,
  ) => PromptWindowState
  setSeedPrompts: (nextPrompts: unknown) => PromptWindowState
  replacePromptWindow: (
    nextPrompts: unknown,
    options?: ReplacePromptWindowOptions,
  ) => PromptWindowState
  addEditableSegment: () => PromptWindowState
  removeEditableSegment: (index: number) => PromptWindowState
  updateEditableSegment: (
    index: number,
    value: string,
  ) => PromptWindowState
  setCustomPresetId: (
    customPresetId: string,
  ) => PromptWindowState
  setCustomPresetLabel: (
    customPresetLabel: string,
  ) => PromptWindowState
}

/**
 * Own prompt selections and drafts, plus the server's accepted prompt window.
 * @param initialState - fields that replace the defaults, also on reset.
 * @returns the prompt window store.
 */
export function createPromptWindowStore(
  initialState: Partial<PromptWindowState> = {},
): PromptWindowStore {
  const store = createManagedStore<PromptWindowState>(
    {
      ...DEFAULT_PROMPT_WINDOW_STATE,
      ...initialState,
    },
    derivePromptWindowState,
  )

  return {
    ...store,
    reset(overrides: Partial<PromptWindowState> = {}) {
      return store.set({
        ...DEFAULT_PROMPT_WINDOW_STATE,
        ...initialState,
        ...overrides,
      })
    },
    /** Clear accepted prompts while retaining selections and drafts. */
    resetProjectPromptState() {
      return store.patch({
        seedPrompts: [],
      })
    },
    setStoryPresets(nextStoryPresets: StoryPreset[]) {
      return store.patch({
        storyPresets: Array.isArray(nextStoryPresets)
          ? nextStoryPresets
          : [],
      })
    },
    appendStoryPreset(preset: StoryPreset) {
      return store.update(state => ({
        ...state,
        storyPresets: [...state.storyPresets, preset],
      }))
    },
    setSelectedPresetId(selectedPresetId: string) {
      return store.patch({ selectedPresetId })
    },
    setCuratedPromptLimit(curatedPromptLimit: number) {
      return store.patch({ curatedPromptLimit })
    },
    setSeedPrompts(nextPrompts: unknown) {
      return store.patch({
        seedPrompts: normalizePromptList(nextPrompts),
      })
    },
    replacePromptWindow(
      nextPrompts: unknown,
      { syncEditable = false }: ReplacePromptWindowOptions = {},
    ) {
      const normalized = normalizePromptList(nextPrompts)
      return store.update(state => ({
        ...state,
        seedPrompts: normalized,
        editableSegments:
          syncEditable &&
          state.editableMode &&
          normalized.length > 0
            ? [...normalized]
            : state.editableSegments,
        editableDirty:
          syncEditable &&
          state.editableMode &&
          normalized.length > 0
            ? false
            : state.editableDirty,
      }))
    },
    addEditableSegment() {
      return store.update(state => ({
        ...state,
        editableSegments: [...state.editableSegments, ''],
        editableDirty: true,
      }))
    },
    removeEditableSegment(index: number) {
      return store.update((state) => {
        const nextSegments = state.editableSegments.filter(
          (_, i) => i !== index,
        )
        return {
          ...state,
          editableSegments:
            nextSegments.length > 0 ? nextSegments : [''],
          editableDirty: true,
        }
      })
    },
    updateEditableSegment(index: number, value: string) {
      return store.update(state => ({
        ...state,
        editableSegments: state.editableSegments.map((segment, i) =>
          i === index ? value : segment,
        ),
        editableDirty: true,
      }))
    },
    setCustomPresetId(customPresetId: string) {
      return store.patch({
        customPresetId,
        editableDirty: true,
      })
    },
    setCustomPresetLabel(customPresetLabel: string) {
      return store.patch({
        customPresetLabel,
        editableDirty: true,
      })
    },
  }
}

export { DEFAULT_PROMPT_WINDOW_STATE, normalizePromptList }
