/** Creation validation ported from the reference `tests/test_project_creation.py`, driven by served model facts. */
import { describe, expect, it } from 'vitest'
import { DreamverseValueError, parseProjectCreationConfig, pythonFormatG, pythonRepr } from '../src/index.ts'
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

  it.each([[4, '4'], [2.5, '2.5'], [4 / 3, '1.33333'], [123456.7, '123457']])('format(%d, "g") is %s', (value, expected) => {
    expect(pythonFormatG(value)).toBe(expected)
  })
})
