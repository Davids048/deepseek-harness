/** Creation validation ported from the reference `tests/test_project_creation.py`, driven by served model facts. */
import { DreamverseValueError, ProjectValidationError } from '@dreamverse/generation-client'
import { describe, expect, it } from 'vitest'
import {
  parseProjectCreationConfig, parseReferenceAssetIds, validateProjectCreation, validateReferenceAssets,
} from '../src/index.ts'
import { pythonRepr } from '../src/python-values.ts'
import { ltxFacts, ref2vaFacts } from './fakes.ts'

/**
 * @param payload - the `project_init_v1` fields.
 * @param facts - the served model's facts.
 * @returns the message of the `DreamverseValueError` that creation validation raises.
 */
function creationError(payload: Record<string, unknown>, facts = ltxFacts()): string {
  try {
    parseProjectCreationConfig(payload, facts)
  } catch (error) {
    if (error instanceof DreamverseValueError) return error.message
    throw error
  }
  throw new Error('expected a creation rejection')
}

describe('parseProjectCreationConfig', () => {
  it('resolves omitted choices to the application defaults and the model geometry', () => {
    const config = parseProjectCreationConfig({ segment_duration_sec: 5 }, ltxFacts())
    expect(config).toEqual({
      model_id: 'fast-ltx23', generation_mode: 't2va', aspect_ratio: '16:9', resolution: '720p', segment_count: 6,
      segment_duration_sec: 5, frame_width: 1280, frame_height: 704, num_frames: 121,
    })
    // `ProjectCreationConfig.as_dict()` key order.
    expect(Object.keys(config)).toEqual([
      'model_id', 'generation_mode', 'aspect_ratio', 'resolution', 'segment_count', 'segment_duration_sec',
      'frame_width', 'frame_height', 'num_frames',
    ])
  })

  it('uses the served model and its first generation mode when the browser omits them', () => {
    expect(parseProjectCreationConfig({ segment_duration_sec: 6, segment_count: 2 }, ref2vaFacts())).toEqual({
      model_id: 'h3-ref2va', generation_mode: 'ref2va', aspect_ratio: '16:9', resolution: '720p', segment_count: 2,
      segment_duration_sec: 6, frame_width: 1344, frame_height: 768, num_frames: 158,
    })
  })

  it('preserves the selected mode, geometry, and segment count and strips the labels', () => {
    const config = parseProjectCreationConfig({
      model_id: ' fast-ltx23 ', generation_mode: ' i2v ', aspect_ratio: '9:16 ', resolution: ' 480p',
      segment_count: 3, segment_duration_sec: 10,
    }, ltxFacts())
    expect(config).toEqual({
      model_id: 'fast-ltx23', generation_mode: 'i2v', aspect_ratio: '9:16', resolution: '480p', segment_count: 3,
      segment_duration_sec: 10, frame_width: 512, frame_height: 896, num_frames: 241,
    })
  })

  it.each([
    [{ model_id: 'fast-ltx2' }, "This server serves fast-ltx23; requested model 'fast-ltx2' is unavailable."],
    [{ model_id: "it's" }, 'This server serves fast-ltx23; requested model "it\'s" is unavailable.'],
    [{ model_id: 5 }, 'model_id must be a string.'],
    [{ model_id: null }, 'model_id must be a string.'],
  ])('rejects the model choice %j', (payload, message) => {
    expect(creationError({ ...payload, segment_duration_sec: 5 })).toBe(message)
  })

  it.each([
    [{ generation_mode: 'fl2va' }, 'First/last frame mode (FL2VA) is not supported yet.'],
    [{ generation_mode: 't2v' }, 'Unsupported generation_mode: t2v'],
    [{ generation_mode: 'toString' }, 'Unsupported generation_mode: toString'],
    [{ aspect_ratio: '2:1' }, 'Unsupported aspect_ratio: 2:1'],
    [{ resolution: '4k' }, 'Unsupported resolution: 4k'],
  ])('rejects the unavailable choice %j', (payload, message) => {
    expect(creationError({ ...payload, segment_duration_sec: 5 })).toBe(message)
  })

  it.each([0, -1, 7, 3.5, Number.NaN, null, false, true, '6', '', [], {}])(
    'rejects the explicit segment_count %j', (segmentCount) => {
      expect(creationError({ segment_count: segmentCount })).toBe('segment_count must be an integer from 1 to 6.')
    })

  it.each([5.5, null, false, true, '5', '', [], {}])('rejects the non-integer segment_duration_sec %j', (duration) => {
    expect(creationError({ segment_duration_sec: duration })).toBe('segment_duration_sec is required and must be an integer.')
  })

  it('requires segment_duration_sec', () => {
    expect(creationError({})).toBe('segment_duration_sec is required and must be an integer.')
    expect(creationError({}, ref2vaFacts())).toBe('segment_duration_sec is required and must be an integer.')
  })

  it.each([
    [ltxFacts(), 0, 'segment_duration_sec must be from 1 to 20 for fast-ltx23.'],
    [ltxFacts(), -5, 'segment_duration_sec must be from 1 to 20 for fast-ltx23.'],
    [ltxFacts(), 21, 'segment_duration_sec must be from 1 to 20 for fast-ltx23.'],
    [ref2vaFacts(), 4, 'segment_duration_sec must be from 5 to 15 for h3-ref2va.'],
    [ref2vaFacts(), 16, 'segment_duration_sec must be from 5 to 15 for h3-ref2va.'],
  ])('rejects a duration outside the model range (%#)', (facts, duration, message) => {
    expect(creationError({ segment_duration_sec: duration }, facts)).toBe(message)
  })

  it('takes every in-range frame count from the model facts', () => {
    const facts = ref2vaFacts()
    for (let duration = facts.minSegmentDurationSec; duration <= facts.maxSegmentDurationSec; duration += 1) {
      expect(parseProjectCreationConfig({ segment_duration_sec: duration }, facts).num_frames)
        .toBe(facts.numFramesByDurationSec[String(duration)])
    }
  })
})

describe('Python message formatting', () => {
  it.each([
    ['fast-ltx2', "'fast-ltx2'"],
    ["it's", '"it\'s"'],
    ['say "hi" it\'s', "'say \"hi\" it\\'s'"],
    ['tab\tline\nback\\slash', "'tab\\tline\\nback\\\\slash'"],
    ['\u0000\u007f\u00a0\u2028\u00e9', "'\\x00\\x7f\\xa0\\u2028é'"],
  ])('repr(%j) is %s', (text, expected) => {
    expect(pythonRepr(text)).toBe(expected)
  })
})

describe('validateProjectCreation', () => {
  it('reports a rejected creation choice as a validation error for the creation config', () => {
    expect(() => validateProjectCreation({ segment_duration_sec: 99 }, ref2vaFacts()))
      .toThrow(new ProjectValidationError('segment_duration_sec must be from 5 to 15 for h3-ref2va.', 'Invalid creation config'))
  })
})

describe('reference selections', () => {
  it('accepts an ordered list of library IDs', () => {
    expect(parseReferenceAssetIds({ reference_asset_ids: ['b', 'a'] })).toEqual(['b', 'a'])
    expect(parseReferenceAssetIds({})).toEqual([])
  })

  it.each([
    [{ initial_image: 'data' }, 'Upload references through /assets and supply reference_asset_ids.'],
    [{ reference_asset_ids: 'a' }, 'reference_asset_ids must be a list of nonempty asset IDs.'],
    [{ reference_asset_ids: [' '] }, 'reference_asset_ids must be a list of nonempty asset IDs.'],
    [{ reference_asset_ids: ['a', 'a'] }, 'reference_asset_ids must not contain duplicates.'],
  ])('rejects the selection %j', (payload, message) => {
    expect(() => parseReferenceAssetIds(payload)).toThrow(new DreamverseValueError(message))
  })

  it('keeps one ref2va request image for the last frame and refuses images in a text mode', () => {
    expect(() => { validateReferenceAssets(ref2vaFacts(), 'ref2va', 8) }).not.toThrow()
    expect(() => { validateReferenceAssets(ref2vaFacts(), 'ref2va', 9) })
      .toThrow(new DreamverseValueError('ref2va requires 1 to 8 reference images.'))
    expect(() => { validateReferenceAssets(ref2vaFacts(), 'ref2va', 0) })
      .toThrow(new DreamverseValueError('ref2va requires 1 to 8 reference images.'))
    expect(() => { validateReferenceAssets(ltxFacts(), 't2va', 1) })
      .toThrow(new DreamverseValueError('Text-to-video mode does not accept reference images.'))
  })
})
