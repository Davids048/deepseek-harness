/** @vitest-environment jsdom */
/**
 * The page text of the codes that the DreamVerse browser modules report: English matches the wording those modules
 * returned before they reported codes, Chinese comes from the same dictionary keys, and server text stays verbatim.
 */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AssetRequestError } from '@dreamverse/assets-manager/client/assets.ts'
import type { CreationSelectionProblem } from '@dreamverse/project-controller/client/creationCapabilities.ts'
import { ProjectRequestError } from '@dreamverse/project-controller/client/projects.ts'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { assetErrorText, creationProblemText, projectErrorText } from '../src/client/problemText.ts'

const english = makeTranslate(en)

describe('DreamVerse problem text', () => {
  it.each<[CreationSelectionProblem, string]>([
    [{ code: 'mode-notice', notice: 'First/last frame mode (FL2VA) is not supported yet.' }, 'First/last frame mode (FL2VA) is not supported yet.'],
    [{ code: 'mode-unsupported' }, 'Selected mode is not supported yet.'],
    [{ code: 'aspect-ratio-unsupported' }, 'Selected aspect ratio is not supported for this model yet.'],
    [{ code: 'resolution-unsupported' }, 'Selected resolution is not supported for this model yet.'],
    [{ code: 'segment-count-unsupported' }, 'Selected segment count is not supported.'],
    [{ code: 'duration-out-of-range', min: 5, max: 15 }, 'Duration per segment must be a whole number from 5 to 15 seconds.'],
    [{ code: 'references-not-accepted' }, 'Text to video does not accept reference images.'],
    [{ code: 'reference-count', limit: 1 }, 'Select one reference image.'],
    [{ code: 'reference-count', limit: 9 }, 'Select 1 to 9 reference images.'],
    [{ code: 'reference-not-image' }, 'This generation workflow accepts images only.'],
    [{ code: 'reference-too-large' }, 'Reference image exceeds the upload size limit.'],
  ])('describes %j in English', (problem, text) => {
    expect(creationProblemText(problem, english)).toBe(text)
  })

  it('describes request failures in the active language and keeps server text verbatim', () => {
    const chinese = makeTranslate(zh)
    expect(projectErrorText(new ProjectRequestError({ code: 'status', status: 404 }), '', english))
      .toBe('Project request failed (404).')
    expect(assetErrorText(new AssetRequestError({ code: 'upload-invalid' }), '', english))
      .toBe('The asset upload response is not an asset record.')
    expect(creationProblemText({ code: 'reference-count', limit: 9 }, chinese)).toBe('请选择 1 到 9 张参考图。')
    expect(assetErrorText(new AssetRequestError({ code: 'status', status: 413 }), '', chinese)).toBe('素材请求失败（413）。')
    expect(projectErrorText(new Error('This project is open. Close it before deleting.'), 'fallback', chinese))
      .toBe('This project is open. Close it before deleting.')
    expect(assetErrorText('refused', 'fallback', chinese)).toBe('fallback')
  })
})
