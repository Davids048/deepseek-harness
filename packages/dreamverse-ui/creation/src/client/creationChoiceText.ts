/**
 * Localized names of the creation choices that `@dreamverse/project-controller` identifies only by ID: creation
 * modes, models, resolutions, and segment durations.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CreationModeId, CreationModelId, ResolutionId } from '@dreamverse/project-controller/client/creationConfig.ts'
import type { DreamverseCreationKey } from './locales.ts'

/** The `dreamverse.creation` translate function that the creation components receive. */
type CreationTranslate = TranslateNS<'dreamverse.creation'>

const MODE_KEYS: Record<CreationModeId, { name: DreamverseCreationKey; summary: DreamverseCreationKey }> = {
  t2v: { name: 'mode.t2v', summary: 'mode.t2v.description' },
  i2v: { name: 'mode.i2v', summary: 'mode.i2v.description' },
  ref2av: { name: 'mode.ref2av', summary: 'mode.ref2av.description' },
  fl2av: { name: 'mode.fl2av', summary: 'mode.fl2av.description' },
}

const MODEL_KEYS: Record<CreationModelId, { name: DreamverseCreationKey; summary: DreamverseCreationKey }> = {
  'h3-ref2va': { name: 'model.h3Ref2va', summary: 'model.h3Ref2va.description' },
  'fast-ltx23': { name: 'model.fastLtx23', summary: 'model.fastLtx23.description' },
  'fast-ltx2': { name: 'model.fastLtx2', summary: 'model.fastLtx2.description' },
  'fast-h3': { name: 'model.fastH3', summary: 'model.fastH3.description' },
}

const RESOLUTION_KEYS: Record<ResolutionId, DreamverseCreationKey> = {
  '480p': 'resolution.480p',
  '720p': 'resolution.720p',
  '1080p': 'resolution.1080p',
  '4k': 'resolution.4k',
}

/**
 * Name of a creation mode.
 * @param modeId - the mode.
 * @param t - the creation translate function.
 * @returns the localized mode name.
 */
export function modeName(modeId: CreationModeId, t: CreationTranslate): string {
  return t(MODE_KEYS[modeId].name)
}

/**
 * One-line explanation of a creation mode.
 * @param modeId - the mode.
 * @param t - the creation translate function.
 * @returns the localized explanation.
 */
export function modeSummary(modeId: CreationModeId, t: CreationTranslate): string {
  return t(MODE_KEYS[modeId].summary)
}

/**
 * Name of a model.
 * @param modelId - the model.
 * @param t - the creation translate function.
 * @returns the localized model name.
 */
export function modelName(modelId: CreationModelId, t: CreationTranslate): string {
  return t(MODEL_KEYS[modelId].name)
}

/**
 * One-line explanation of a model.
 * @param modelId - the model.
 * @param t - the creation translate function.
 * @returns the localized explanation.
 */
export function modelSummary(modelId: CreationModelId, t: CreationTranslate): string {
  return t(MODEL_KEYS[modelId].summary)
}

/**
 * Display form of a resolution.
 * @param resolution - the resolution.
 * @param t - the creation translate function.
 * @returns the localized resolution, such as `720P`.
 */
export function resolutionName(resolution: ResolutionId, t: CreationTranslate): string {
  return t(RESOLUTION_KEYS[resolution])
}

/**
 * Display form of a duration in whole seconds.
 * @param seconds - the duration.
 * @param t - the creation translate function.
 * @returns the localized duration, such as `5s`.
 */
export function secondsName(seconds: number, t: CreationTranslate): string {
  return t('duration.seconds', { seconds })
}
