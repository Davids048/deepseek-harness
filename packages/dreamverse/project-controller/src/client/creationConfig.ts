export type CreationModeId = 't2v' | 'i2v' | 'fl2av' | 'ref2av'

export type CreationModelId = 'fast-ltx2' | 'fast-ltx23' | 'fast-h3' | 'h3-ref2va'

export type AspectRatioId = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16'

export type ResolutionId = '480p' | '720p' | '1080p' | '4k'

/** One selectable model; the page translates its name and description from the model ID. */
export interface CreationModelOption {
  id: CreationModelId
  /** Marks a recently added model; the page shows its localized badge. */
  badge?: 'new'
}

export interface MentionOption {
  id: string
  label: string
  kind: 'preset' | 'asset' | 'character'
  description?: string
}

/** The creation modes that the lobby offers, in display order; the page translates each mode ID. */
export const CREATION_MODES: CreationModeId[] = ['t2v', 'i2v', 'ref2av']

/** The creation modes that the lobby lists as unavailable; the page translates each mode ID. */
export const UNSUPPORTED_CREATION_MODES: CreationModeId[] = ['fl2av']

/** The models that the lobby can show, in display order. */
export const CREATION_MODELS: CreationModelOption[] = [
  { id: 'h3-ref2va' },
  { id: 'fast-ltx23', badge: 'new' },
  { id: 'fast-ltx2' },
  { id: 'fast-h3' },
]

export const ASPECT_RATIOS: AspectRatioId[] = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']

export const RESOLUTIONS: ResolutionId[] = ['480p', '720p', '1080p']

export const UNSUPPORTED_RESOLUTIONS: ResolutionId[] = ['4k']

export const SEGMENT_COUNTS = [1, 2, 3, 4, 5, 6] as const

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
