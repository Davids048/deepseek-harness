import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import { continuesPreviousSegment, referenceImageLimit, segmentImageLabels, segmentRequestImages } from '../src/index.ts'
import { FakeAssets, ltxFacts, ref2vaFacts } from './fakes.ts'

let assets: FakeAssets | undefined
afterEach(() => { assets?.dispose() })

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

  it('keeps the selected images Picture 1 to K and labels a continued segment last frame after them', () => {
    expect(segmentImageLabels(ref2vaFacts(), 'ref2va', 2, false)).toEqual({
      referenceLabels: ['Picture 1', 'Picture 2'], firstFrameLabel: null,
    })
    expect(segmentImageLabels(ref2vaFacts(), 'ref2va', 2, true)).toEqual({
      referenceLabels: ['Picture 1', 'Picture 2'], firstFrameLabel: 'Picture 3',
    })
  })

  it('names no images for a model without numbered labels', () => {
    expect(segmentImageLabels(ltxFacts(), 'i2v', 1, true)).toEqual({ referenceLabels: [], firstFrameLabel: null })
  })

  it('keeps one ref2va request image for the last frame and limits other modes to the model maximum', () => {
    expect(referenceImageLimit(ref2vaFacts(), 'ref2va')).toBe(8)
    expect(referenceImageLimit(ltxFacts(), 'i2v')).toBe(1)
  })

  it('reads the selected images in selection order, then the last frame of a continued ref2va segment', async () => {
    assets = new FakeAssets()
    const side = assets.put('project:p1', 'side.png', Buffer.from('side'))
    const front = assets.put('project:p1', 'front.png', Buffer.from('front'))
    const frame = assets.put('project:p1', 'segment-1.png', Buffer.from('last frame'))
    expect((await segmentRequestImages(ref2vaFacts(), 'ref2va', [side, front], null)).map(String)).toEqual(['side', 'front'])
    expect((await segmentRequestImages(ref2vaFacts(), 'ref2va', [side, front], frame)).map(String))
      .toEqual(['side', 'front', 'last frame'])
  })

  it('starts a continued first-frame shot from the last frame alone', async () => {
    assets = new FakeAssets()
    const image = assets.put('project:p1', 'image.png', Buffer.from('image'))
    const frame = assets.put('project:p1', 'segment-1.png', Buffer.from('last frame'))
    expect((await segmentRequestImages(ltxFacts(), 'i2v', [image], null)).map(String)).toEqual(['image'])
    expect((await segmentRequestImages(ltxFacts(), 'i2v', [image], frame)).map(String)).toEqual(['last frame'])
  })
})
