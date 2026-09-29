export type CreationModeId = 't2v' | 'i2v' | 'fl2av' | 'ref2av'

export type CreationModelId = 'fast-ltx2' | 'fast-ltx23' | 'fast-h3' | 'h3-ref2va'

export type AspectRatioId = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16'

export type ResolutionId = '480p' | '720p' | '1080p' | '4k'

export interface CreationModeOption {
  id: CreationModeId
  label: string
  description: string
}

export interface CreationModelOption {
  id: CreationModelId
  label: string
  description: string
  badge?: string
}

export interface MentionOption {
  id: string
  label: string
  kind: 'preset' | 'asset' | 'character'
  description?: string
}

export const CREATION_MODES: CreationModeOption[] = [
  { id: 't2v', label: 'Text to video', description: 'Generate from a text prompt' },
  { id: 'i2v', label: 'Image to video', description: 'Use an image as the first frame' },
  { id: 'ref2av', label: 'Reference to video + audio', description: 'Generate independent shots of the subject in your pictures' },
]

export const UNSUPPORTED_CREATION_MODES: CreationModeOption[] = [
  { id: 'fl2av', label: 'First and last frame', description: 'Coming soon on FastLTX models' },
]

export const CREATION_MODELS: CreationModelOption[] = [
  { id: 'h3-ref2va', label: 'H3 Ref2AV', description: 'MiniMax H3 subject reference generation' },
  {
    id: 'fast-ltx23',
    label: 'FastLTX 2.3',
    description: 'LTX 2.3 with OmniNFT LoRA',
    badge: 'New',
  },
  {
    id: 'fast-ltx2',
    label: 'FastLTX 2',
    description: 'FastLTX 2 for streaming',
  },
  {
    id: 'fast-h3',
    label: 'FastH3',
    description: 'MiniMax H3 with VSA data-free adapter',
  },
]

export const ASPECT_RATIOS: AspectRatioId[] = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']

export const RESOLUTIONS: ResolutionId[] = ['480p', '720p', '1080p']

export const UNSUPPORTED_RESOLUTIONS: ResolutionId[] = ['4k']

export const SEGMENT_COUNTS = [1, 2, 3, 4, 5, 6] as const

export function formatResolutionLabel(resolution: ResolutionId): string {
  return resolution === '4k' ? '4K' : resolution.toUpperCase()
}

export function formatDurationLabel(seconds: number): string {
  return `${seconds}s`
}

export function modeRequiresReference(modeId: CreationModeId): boolean {
  return modeId === 'ref2av' || modeId === 'i2v'
}

/**
 * Offer each labeled story preset as a mention option.
 * @param storyPresets - the presets; one without a label is not offered.
 * @returns one preset mention option per labeled preset, identified by its ID or, without one, its label.
 */
export function buildMentionOptions(
  storyPresets: readonly { id?: string | undefined; label?: string | undefined; description?: string | undefined }[],
): MentionOption[] {
  return storyPresets
    .filter(preset => typeof preset.label === 'string' && preset.label.trim())
    .map(preset => ({
      id: String(preset.id || preset.label),
      label: String(preset.label),
      kind: 'preset' as const,
      ...(typeof preset.description === 'string' ? { description: preset.description } : {}),
    }))
}
