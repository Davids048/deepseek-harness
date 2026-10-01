import { describe, expect, it } from 'vitest'
import { continuesPreviousSegment, referenceImageLimit, segmentImageLabels } from '../src/index.ts'
import { ltxFacts, ref2vaFacts } from './fakes.ts'

describe('segment conditioning', () => {
  it.each([
    [{ append: false, index: 0, referenceCount: 1 }, false],
    [{ append: false, index: 1, referenceCount: 1 }, true],
    [{ append: true, index: 0, referenceCount: 1 }, true],
  ])('continues a ref2va segment at %j: %s', (position, continues) => {
    expect(continuesPreviousSegment(ref2vaFacts(), 'ref2va', position)).toBe(continues)
  })

  it('starts an appended first-frame shot from its supplied image and continues one without an image', () => {
    expect(continuesPreviousSegment(ltxFacts(), 'i2v', { append: true, index: 0, referenceCount: 1 })).toBe(false)
    expect(continuesPreviousSegment(ltxFacts(), 'i2v', { append: true, index: 0, referenceCount: 0 })).toBe(true)
  })

  it('continues no segment of a model that ignores the previous frame', () => {
    const facts = { ...ref2vaFacts(), usesPreviousFrame: false }
    expect(continuesPreviousSegment(facts, 'ref2va', { append: true, index: 1, referenceCount: 1 })).toBe(false)
  })

  it('labels a continued segment last frame Picture 1 and shifts its reference labels by one', () => {
    expect(segmentImageLabels(ref2vaFacts(), 'ref2va', 2, false)).toEqual({
      referenceLabels: ['Picture 1', 'Picture 2'], firstFrameLabel: null,
    })
    expect(segmentImageLabels(ref2vaFacts(), 'ref2va', 2, true)).toEqual({
      referenceLabels: ['Picture 2', 'Picture 3'], firstFrameLabel: 'Picture 1',
    })
  })

  it('names no images for a model without numbered labels', () => {
    expect(segmentImageLabels(ltxFacts(), 'i2v', 1, true)).toEqual({ referenceLabels: [], firstFrameLabel: null })
  })

  it('keeps one ref2va request image for the last frame and limits other modes to the model maximum', () => {
    expect(referenceImageLimit(ref2vaFacts(), 'ref2va')).toBe(8)
    expect(referenceImageLimit(ltxFacts(), 'i2v')).toBe(1)
  })
})
