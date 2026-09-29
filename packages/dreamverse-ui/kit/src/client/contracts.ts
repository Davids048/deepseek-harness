/**
 * Slot contracts of the DreamVerse page: the child slots that the kit's `root` occupant renders and the owner props it
 * passes to each occupant. Occupant packages import these types; the kit owns them so no package depends on an
 * occupant. The props mirror the FastVideo DreamVerse component props.
 *
 * @module @dreamverse/ui-kit/contracts
 */
import type { ReactNode, KeyboardEvent, RefCallback } from 'react'
import type {
  AspectRatioId, CreationModeId, CreationModelId, MentionOption, ResolutionId,
} from '@dreamverse/project-controller/client/creationConfig.ts'
import type { LobbyCreationCapabilities, LobbySelection } from '@dreamverse/project-controller/client/creationCapabilities.ts'
import type { StoredProject } from '@dreamverse/project-controller/client/projectStorage.ts'
import type { PromptEvent } from '@dreamverse/project-controller/client/promptEvents.ts'
import type { CompletedClip } from '@dreamverse/project-controller/client/stores/stream.ts'
import type { AssetRecord, AssetUploadPolicy, ReferenceDraft } from '@dreamverse/assets-manager/client/assets.ts'

/** Creation settings of one project, shown as configuration pills. */
export interface ProjectCreationConfig {
  modelId: CreationModelId
  modeId: CreationModeId
  aspectRatio: AspectRatioId
  resolution: ResolutionId
  segmentDurationSec: number
  segmentCount: number
}

/** One story preset offered as a quick-launch shortcut. */
export interface StoryPresetLike {
  id: string
  label: string
  description?: string | undefined
  segmentCount?: number | undefined
  styleTag?: string | undefined
}

/** Sections of the creation navigation rail. */
export type AppNavSection = 'explore' | 'create' | 'assets'

/** Reference image selection shown in the composers. */
export interface ReferencePickerProps {
  references: ReferenceDraft[]
  onReferencesChange: (references: ReferenceDraft[]) => void
  onOpenAssets: () => void
  accept: string
  maxCount: number
  maxBytes: number
}

/** Owner props of `dreamverse.chatbar`: the live directing composer and read-only viewing controls. */
export interface ChatBarProps {
  /** Place generation options below the prompt inside the composer. */
  children?: ReactNode
  referencePicker?: ReferencePickerProps | undefined
  mentionOptions?: MentionOption[]
  promptLabel?: string
  promptDisabled?: boolean
  allowEmptyPrompt?: boolean
  projectStarted?: boolean
  rewriteMode?: boolean
  generationRoundBusy?: boolean
  autoExtensionEnabled?: boolean
  autoExtensionRequested?: boolean
  canChooseAutoExtension?: boolean
  onAutoExtensionRequestChange?: (enabled: boolean) => void
  onStopGeneration?: () => void
  isGenerating?: boolean
  storyPresets?: StoryPresetLike[]
  continuationDraft?: string
  canStartProject?: boolean
  canSubmitContinuation?: boolean
  connectionClosed?: boolean
  projectNotice?: string
  projectResetPending?: boolean
  viewingReadOnly?: boolean
  onPresetGenerate?: (presetId: string) => void
  /** The prompt text after each edit, including a mention the composer inserts. */
  onContinuationInput?: (value: string) => void
  onContinuationKeydown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onGenerate?: () => void
  onSubmitContinuation?: () => void
  onLeave?: () => void
  onStartNewProject?: () => void
  onBackFromViewing?: () => void
  projectCreationConfig?: ProjectCreationConfig | null
  configPillsReadOnly?: boolean
  onProjectModelChange?: (modelId: CreationModelId) => void
  onProjectModeChange?: (modeId: CreationModeId) => void
  onProjectAspectRatioChange?: (aspectRatio: AspectRatioId) => void
  onProjectResolutionChange?: (resolution: ResolutionId) => void
}

/** Owner props of `dreamverse.creation-studio`: the lobby composer and preset shortcuts. */
export interface CreationStudioProps {
  value: string
  disabled?: boolean
  isGenerating?: boolean
  canSubmit?: boolean
  autoExtensionRequested?: boolean
  onAutoExtensionRequestChange?: (enabled: boolean) => void
  selection: LobbySelection
  referencePicker?: ReferencePickerProps | undefined
  mentionOptions?: MentionOption[]
  storyPresets?: StoryPresetLike[]
  activeSection?: AppNavSection
  onValueChange: (value: string) => void
  onSubmit: () => void
  onSelectionChange: (changes: Partial<LobbySelection>) => void
  onPresetGenerate?: (presetId: string) => void
  onOpenAssets?: () => void
  capabilities: LobbyCreationCapabilities | null
  capabilityNotice: string | null
}

/** The selected completed clip and the playback position where the player starts it. */
export type PlayerClip = CompletedClip & { playbackStartTime: number }

/** Owner props of `dreamverse.player`: live and archived playback of the active project. */
export interface VideoPlayerProps {
  videoRef?: RefCallback<HTMLVideoElement>
  archivedPlaybackRef?: RefCallback<HTMLVideoElement>
  activeClip?: PlayerClip | null
  canDownload?: boolean
  projectStarted?: boolean
  avPlaybackStarted?: boolean
  mediaAppendError?: string | null
  gpuAssigned?: boolean
  connected?: boolean
  queuePosition?: number
  loadingAnimation?: boolean
  showLivePlayback?: boolean
  defaultMuted?: boolean
  onPlaying?: () => void
  onDownload?: () => void
}

/** Owner props of `dreamverse.workspace`: the prompt event timeline of the shown project. */
export interface WorkspaceProps {
  promptEvents?: PromptEvent[]
  originalLabel?: string
  projectStarted?: boolean
  onSelectOriginal?: () => void
  onSelectEvent?: (event: PromptEvent) => void
  onSelectCurrent?: () => void
  selectedClipId?: string
  selectedEntryKey?: string
  originalClipId?: string
}

/** Owner props of `dreamverse.sidebar`: the saved project history. */
export interface SidebarProps {
  open?: boolean
  currentProjectId?: string
  currentProjectLabel?: string
  hasCurrentProject?: boolean
  connectionClosed?: boolean
  projectResetPending?: boolean
  savedProjects?: StoredProject[]
  viewingProjectId?: string | null
  isViewingPastProject?: boolean
  onClose?: () => void
  onSelectProject?: (project: StoredProject) => void
  onSelectCurrentProject?: () => void
  onDeleteProject?: (projectId: string) => void
  onNewProject?: () => void
  onOpenAssets?: () => void
}

/** Owner props of `dreamverse.asset-library`: the asset library dialog. */
export interface AssetLibraryProps {
  open: boolean
  assets: AssetRecord[]
  onAssetsChange: (update: (assets: AssetRecord[]) => AssetRecord[]) => void
  uploadPolicy: AssetUploadPolicy | null
  onClose: () => void
  onSelect: (asset: AssetRecord) => void
  onDeleted: (assetId: string) => void
  canSelect: boolean
}

/** The child slots of the DreamVerse page, in the order the kit's `root` registration declares them. */
export const DREAMVERSE_SLOTS = {
  'dreamverse.sidebar': { kind: 'single', scope: 'root' },
  'dreamverse.asset-library': { kind: 'single', scope: 'root' },
  'dreamverse.player': { kind: 'single', scope: 'root' },
  'dreamverse.workspace': { kind: 'single', scope: 'root' },
  'dreamverse.creation-studio': { kind: 'single', scope: 'root' },
  'dreamverse.chatbar': { kind: 'single', scope: 'root' },
} as const

/** The name of one DreamVerse page child slot. */
export type DreamverseSlot = keyof typeof DREAMVERSE_SLOTS

/** Owner props by DreamVerse page child slot. */
export interface DreamverseSlotOwners {
  'dreamverse.sidebar': SidebarProps
  'dreamverse.asset-library': AssetLibraryProps
  'dreamverse.player': VideoPlayerProps
  'dreamverse.workspace': WorkspaceProps
  'dreamverse.creation-studio': CreationStudioProps
  'dreamverse.chatbar': ChatBarProps
}

/**
 * Render one DreamVerse child slot with its owner props. The page receives this function from the `root` registration
 * (the DSH `renderSlot` share); tests pass a function that renders the occupant components directly.
 */
export type DreamverseSlotRenderer = <K extends DreamverseSlot>(name: K, props: DreamverseSlotOwners[K]) => ReactNode

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Saved project history sidebar, declared by the kit's `root` registration. The component receives
     * {@link SidebarProps}; `@dreamverse/ui-project-history` registers it, and without an occupant the page has no
     * project history.
     */
    'dreamverse.sidebar': { kind: 'single'; scope: 'root'; owner: SidebarProps }
    /**
     * Asset library dialog, declared by the kit's `root` registration. The component receives
     * {@link AssetLibraryProps}; `@dreamverse/ui-assets` registers it, and without an occupant the Assets controls open
     * nothing.
     */
    'dreamverse.asset-library': { kind: 'single'; scope: 'root'; owner: AssetLibraryProps }
    /**
     * Live and archived playback of the active project, declared by the kit's `root` registration. The component
     * receives {@link VideoPlayerProps}; `@dreamverse/ui-player` registers it, and without an occupant the project view
     * shows no video.
     */
    'dreamverse.player': { kind: 'single'; scope: 'root'; owner: VideoPlayerProps }
    /**
     * Prompt event timeline of the shown project, declared by the kit's `root` registration. The component receives
     * {@link WorkspaceProps}; `@dreamverse/ui-directing` registers it, and without an occupant the project view shows no
     * timeline.
     */
    'dreamverse.workspace': { kind: 'single'; scope: 'root'; owner: WorkspaceProps }
    /**
     * Lobby composer and preset shortcuts, declared by the kit's `root` registration. The component receives
     * {@link CreationStudioProps}; `@dreamverse/ui-creation` registers it, and without an occupant the lobby cannot
     * start a project.
     */
    'dreamverse.creation-studio': { kind: 'single'; scope: 'root'; owner: CreationStudioProps }
    /**
     * Directing composer of a started project and the read-only controls of an archived one, declared by the kit's
     * `root` registration. The component receives {@link ChatBarProps}; `@dreamverse/ui-creation` registers it, and
     * without an occupant a project accepts no follow-up prompt.
     */
    'dreamverse.chatbar': { kind: 'single'; scope: 'root'; owner: ChatBarProps }
  }
}
