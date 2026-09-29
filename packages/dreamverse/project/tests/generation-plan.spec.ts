import { describe, expect, it } from 'vitest'
import { DreamverseValueError, GenerationPlan, VideoSegment, type CreationConfig, type VideoSegmentInit } from '../src/index.ts'

const creationConfig: CreationConfig = {
  model_id: 'fast-ltx23', generation_mode: 't2va', aspect_ratio: '16:9', resolution: '720p',
  segment_count: 2, segment_duration_sec: 5, frame_width: 1280, frame_height: 704, num_frames: 121,
}

function segment(segmentId: string, fields: Partial<VideoSegmentInit> = {}): VideoSegment {
  return new VideoSegment({ prompt: segmentId, creationConfig, source: 'preset', segmentId, ...fields })
}

describe('GenerationPlan', () => {
  it('waits for a dependency that is displayed after its dependent', () => {
    const first = segment('first')
    const second = segment('second', { referenceSegmentId: 'first' })
    const records = new Map([['first', first], ['second', second]])
    const plan = new GenerationPlan(['second', 'first'], ['second', 'first'])
    plan.validate(records)
    expect(plan.nextReadySegment(records)).toBe(first)
    first.status = 'completed'
    expect(plan.nextReadySegment(records)).toBe(second)
    expect(plan.sequenceIds).toEqual(['second', 'first'])
  })

  it.each(['missing', 'second'])('rejects a %s reference before any segment is submitted', (reference) => {
    const records = new Map([
      ['first', segment('first', { referenceSegmentId: reference })],
      ['second', segment('second', { referenceSegmentId: 'first' })],
    ])
    const plan = new GenerationPlan(['first', 'second'], ['first', 'second'])
    expect(() => { plan.validate(records) }).toThrow(
      new DreamverseValueError('Segment references contain a cycle or an unavailable dependency.'))
  })

  it.each([
    [[], [], 'A generation plan requires distinct segment IDs.'],
    [['first', 'first'], ['first'], 'A generation plan requires distinct segment IDs.'],
    [['first'], ['first', 'first'], 'A video sequence requires distinct segment IDs.'],
    [['first'], ['second'], 'Every planned segment must appear in the video sequence.'],
    [['first'], ['first', 'unknown'], 'The video sequence references an unknown segment.'],
  ])('rejects plan %j with sequence %j', (segmentIds, sequenceIds, message) => {
    const records = new Map([['first', segment('first')], ['second', segment('second')]])
    const plan = new GenerationPlan(segmentIds, sequenceIds)
    expect(() => { plan.validate(records) }).toThrow(DreamverseValueError)
    expect(() => { plan.validate(records) }).toThrow(message)
  })

  it('rejects reused work and resolves dependencies on completed records outside the plan', () => {
    const completed = segment('completed')
    completed.status = 'completed'
    const records = new Map([['completed', completed], ['next', segment('next', { referenceSegmentId: 'completed' })]])
    expect(() => { new GenerationPlan(['completed'], ['completed']).validate(records) }).toThrow(
      'Only pending segments can enter a generation plan.')
    const append = new GenerationPlan(['next'], ['completed', 'next'], true)
    append.validate(records)
    expect(append.nextReadySegment(records)?.segmentId).toBe('next')
    expect(Object.isFrozen(append) && Object.isFrozen(append.segmentIds)).toBe(true)
  })
})

describe('VideoSegment', () => {
  it.each([
    ['preset', false, 'curated'],
    ['automatic', true, 'auto_enhanced'],
    ['user', true, 'user_enhanced'],
    ['user', false, 'user_raw'],
  ] as const)('labels %s segments with enhanced=%s as %s', (source, enhanced, wireSource) => {
    expect(segment('segment', { source, enhanced }).wireSource).toBe(wireSource)
  })
})
