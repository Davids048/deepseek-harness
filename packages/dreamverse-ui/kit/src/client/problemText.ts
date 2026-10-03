/**
 * Localized text of the structured problems and request failures that the `@dreamverse/project-controller` and
 * `@dreamverse/assets-manager` browser modules report without wording. Each page package that shows one of these
 * passes its own translate function; its dictionary must define the keys of the matching key union, which the
 * `Translate<Key>` parameter type checks.
 *
 * @module @dreamverse/ui-kit/problemText
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { AssetRequestError, type AssetRequestFailure } from '@dreamverse/assets-manager/client/assets.ts'
import type { CreationSelectionProblem } from '@dreamverse/project-controller/client/creationCapabilities.ts'
import { ProjectRequestError, type ProjectRequestFailure } from '@dreamverse/project-controller/client/projects.ts'

/** Dictionary keys of {@link creationProblemText}. */
export type CreationProblemKey =
  | 'problem.modeUnsupported'
  | 'problem.aspectRatioUnsupported'
  | 'problem.resolutionUnsupported'
  | 'problem.segmentCountUnsupported'
  | 'problem.durationOutOfRange'
  | 'problem.referencesNotAccepted'
  | 'problem.referenceCount.one'
  | 'problem.referenceCount.other'
  | 'problem.referenceNotImage'
  | 'problem.referenceTooLarge'

/** Dictionary keys of {@link assetErrorText}. */
export type AssetFailureKey =
  | 'assetRequest.status'
  | 'assetRequest.listInvalid'
  | 'assetRequest.listEntryInvalid'
  | 'assetRequest.uploadInvalid'

/** Dictionary keys of {@link projectErrorText}. */
export type ProjectFailureKey =
  | 'projectRequest.status'
  | 'projectRequest.listInvalid'
  | 'projectRequest.listEntryInvalid'
  | 'projectRequest.projectInvalid'

/**
 * Describe why a lobby or reference selection cannot start a request.
 * @param problem - the validation problem.
 * @param t - the showing package's translate function.
 * @returns the served model's own explanation for `mode-notice`, otherwise the localized message.
 */
export function creationProblemText(problem: CreationSelectionProblem, t: Translate<CreationProblemKey>): string {
  switch (problem.code) {
    case 'mode-notice': return problem.notice
    case 'mode-unsupported': return t('problem.modeUnsupported')
    case 'aspect-ratio-unsupported': return t('problem.aspectRatioUnsupported')
    case 'resolution-unsupported': return t('problem.resolutionUnsupported')
    case 'segment-count-unsupported': return t('problem.segmentCountUnsupported')
    case 'duration-out-of-range': return t('problem.durationOutOfRange', { min: problem.min, max: problem.max })
    case 'references-not-accepted': return t('problem.referencesNotAccepted')
    case 'reference-count':
      return problem.limit === 1
        ? t('problem.referenceCount.one')
        : t('problem.referenceCount.other', { limit: problem.limit })
    case 'reference-not-image': return t('problem.referenceNotImage')
    case 'reference-too-large': return t('problem.referenceTooLarge')
    default: return assertNever(problem, 'creationProblemText')
  }
}

/** Localized message of one asset request failure. */
function assetFailureText(failure: AssetRequestFailure, t: Translate<AssetFailureKey>): string {
  switch (failure.code) {
    case 'status': return t('assetRequest.status', { status: failure.status })
    case 'list-invalid': return t('assetRequest.listInvalid')
    case 'list-entry-invalid': return t('assetRequest.listEntryInvalid')
    case 'upload-invalid': return t('assetRequest.uploadInvalid')
    default: return assertNever(failure, 'assetFailureText')
  }
}

/** Localized message of one project request failure. */
function projectFailureText(failure: ProjectRequestFailure, t: Translate<ProjectFailureKey>): string {
  switch (failure.code) {
    case 'status': return t('projectRequest.status', { status: failure.status })
    case 'list-invalid': return t('projectRequest.listInvalid')
    case 'list-entry-invalid': return t('projectRequest.listEntryInvalid')
    case 'project-invalid': return t('projectRequest.projectInvalid')
    default: return assertNever(failure, 'projectFailureText')
  }
}

/**
 * Describe a rejected asset request for display.
 * @param error - the rejection of an `@dreamverse/assets-manager` browser call.
 * @param fallback - the localized text for a rejection that is not an `Error`.
 * @param t - the showing package's translate function.
 * @returns the localized failure, the server's `detail` verbatim, or `fallback`.
 */
export function assetErrorText(error: unknown, fallback: string, t: Translate<AssetFailureKey>): string {
  if (error instanceof AssetRequestError) return assetFailureText(error.failure, t)
  return error instanceof Error ? error.message : fallback
}

/**
 * Describe a rejected project request for display.
 * @param error - the rejection of an `@dreamverse/project-controller` project call.
 * @param fallback - the localized text for a rejection that is not an `Error`.
 * @param t - the showing package's translate function.
 * @returns the localized failure, the server's `detail` verbatim, or `fallback`.
 */
export function projectErrorText(error: unknown, fallback: string, t: Translate<ProjectFailureKey>): string {
  if (error instanceof ProjectRequestError) return projectFailureText(error.failure, t)
  return error instanceof Error ? error.message : fallback
}
