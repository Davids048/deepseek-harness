import { createManagedStore, type ManagedStore } from './createManagedStore.ts'

/** The browser's initial creation label, retained until the first stream starts. */
export interface PendingInitialClip {
  originPromptId: string | null
  label: string
}

/** One announced video stream, with a fresh ID even when replaying the same prompt request. */
export interface LiveClip {
  id: string
  originPromptId: string | null
  label: string
  prompt: string
  promptWindowPrompts: string[]
  /** Completed sequence whose media precedes this continuation round. */
  continuationClipId: string | null
}

/** One received fMP4 segment of a clip, kept for remuxing the clip and for continuation playback. */
export interface ArchivedSegment {
  key: string
  segmentIdx: number | null
  streamId: string
  mime: string
  completed: boolean
  chunks: ArrayBuffer[]
}

/** One clip of the current project whose stream completed, with its media kept in the browser. */
export interface CompletedClip {
  id: string
  originPromptId: string | null
  label: string
  prompt: string
  promptWindowPrompts: string[]
  mime: string
  blob: Blob
  /** Object URL of `blob`; the page revokes it when the project's clips are cleared. */
  objectUrl: string
  /** The received stream chunks in arrival order, including the preceding clip's chunks for a continuation. */
  chunks: ArrayBuffer[]
  archivedSegments: ArchivedSegment[]
  /** `blob` is the remuxed MP4 rather than the concatenated stream chunks. */
  remuxed: boolean
  createdAt: number
}

/** Live and archived playback of the current project. */
export interface StreamState {
  playingSeedPromptIndex: number | null
  generatingSeedPromptIndex: number | null
  /** Prompt window index of each announced segment, by segment index. */
  seedPromptIndexBySegment: Record<number, number>
  completedClips: CompletedClip[]
  activeClipId: string
  /** Derived: the completed clip whose ID is `activeClipId`. */
  activeClip: CompletedClip | null
  activePlaybackStartTime: number
  pendingInitialClip: PendingInitialClip | null
  liveClip: LiveClip | null
  currentThumbnail: string | null
  loadingAnimation: boolean
  avPlaybackStarted: boolean
  mediaAppendError: string | null
  lastVideoCompletedAtMs: number | null
  timeBetweenVideosMs: number | null
}

/** Derive the selected archived clip from its ID. */
function deriveStreamState(state: StreamState): StreamState {
  const completedClips = Array.isArray(state.completedClips) ? state.completedClips : []

  return {
    ...state,
    completedClips,
    activeClip: completedClips.find(clip => clip.id === state.activeClipId) || null,
  }
}

/** The stream state of a page with no project. */
const DEFAULT_STREAM_STATE: StreamState = {
  playingSeedPromptIndex: null,
  generatingSeedPromptIndex: null,
  seedPromptIndexBySegment: {},
  completedClips: [],
  activeClipId: '',
  activeClip: null,
  activePlaybackStartTime: 0,
  pendingInitialClip: null,
  liveClip: null,
  currentThumbnail: null,
  loadingAnimation: false,
  avPlaybackStarted: false,
  mediaAppendError: null,
  lastVideoCompletedAtMs: null,
  timeBetweenVideosMs: null,
}

/** The stream store: the managed state plus playback reset, clip archiving, and clip selection. */
export type StreamStore = ManagedStore<StreamState> & {
  reset: (overrides?: Partial<StreamState>) => StreamState
  resetPlaybackState: () => StreamState
  addCompletedClip: (clip: CompletedClip) => StreamState
  selectClip: (clipId: string, playbackStartTime?: number) => StreamState
}

/**
 * Own playback state and derive the selected clip from its ID.
 * @param initialState - fields that replace the defaults, also on reset.
 * @returns the stream store.
 */
export function createStreamStore(initialState: Partial<StreamState> = {}): StreamStore {
  const store = createManagedStore<StreamState>(
    {
      ...DEFAULT_STREAM_STATE,
      ...initialState,
    },
    deriveStreamState,
  )

  return {
    ...store,
    reset(overrides: Partial<StreamState> = {}) {
      return store.set({
        ...DEFAULT_STREAM_STATE,
        ...initialState,
        ...overrides,
      })
    },
    /** Clear playback metadata and selection; retain completed clips. Page releases media and URLs. */
    resetPlaybackState() {
      return store.patch({
        playingSeedPromptIndex: null,
        generatingSeedPromptIndex: null,
        seedPromptIndexBySegment: {},
        activeClipId: '',
        activePlaybackStartTime: 0,
        pendingInitialClip: null,
        liveClip: null,
        currentThumbnail: null,
        loadingAnimation: false,
        avPlaybackStarted: false,
        mediaAppendError: null,
        lastVideoCompletedAtMs: null,
        timeBetweenVideosMs: null,
      })
    },
    addCompletedClip(clip: CompletedClip) {
      return store.update(state => ({
        ...state,
        completedClips: [...state.completedClips, clip],
      }))
    },
    selectClip(clipId: string, playbackStartTime: number = 0) {
      return store.patch({
        activeClipId: clipId,
        activePlaybackStartTime: Number.isFinite(playbackStartTime) ? Math.max(playbackStartTime, 0) : 0,
      })
    },
  }
}

export { DEFAULT_STREAM_STATE }
