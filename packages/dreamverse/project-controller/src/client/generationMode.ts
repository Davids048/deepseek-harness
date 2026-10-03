import type { CreationModeId } from './creationConfig.ts'

/** The wire generation modes, in the order the server lists them. */
export const GENERATION_MODES = ['t2va', 'i2v', 'fl2va', 'ref2va'] as const

export type GenerationMode = (typeof GENERATION_MODES)[number]

export const DEFAULT_GENERATION_MODE: GenerationMode = 't2va'

const CREATION_MODE_TO_GENERATION_MODE: Record<CreationModeId, GenerationMode> = {
  t2v: 't2va',
  i2v: 'i2v',
  fl2av: 'fl2va',
  ref2av: 'ref2va',
}

export function isGenerationMode(value: unknown): value is GenerationMode {
  return GENERATION_MODES.some(mode => mode === value)
}

const GENERATION_MODE_TO_CREATION_MODE: Record<GenerationMode, CreationModeId> = {
  t2va: 't2v',
  i2v: 'i2v',
  fl2va: 'fl2av',
  ref2va: 'ref2av',
}

export function fromGenerationMode(mode: GenerationMode): CreationModeId {
  return GENERATION_MODE_TO_CREATION_MODE[mode]
}

export function toGenerationMode(modeId: CreationModeId): GenerationMode {
  return CREATION_MODE_TO_GENERATION_MODE[modeId]
}
