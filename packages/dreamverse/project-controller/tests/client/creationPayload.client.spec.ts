/** @vitest-environment jsdom */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId } from '@dreamverse/assets-manager/client/assets.ts'
import { describe, expect, it } from 'vitest'
import { buildCreationInitPayload, parseEchoedCreationConfig } from '../../src/client/creationPayload.ts'

describe('creation asset payload', () => {
  it('serializes ordered stable IDs without media bytes', () => {
    const ids = ['side', 'front'].map(id => brandString<AssetId>(id))
    const payload = buildCreationInitPayload({ modelId: 'h3-ref2va', modeId: 'ref2av', aspectRatio: '16:9', resolution: '720p', segmentDurationSec: 5, segmentCount: 6, referenceAssetIds: ids })
    ids.reverse()
    expect(payload).toEqual({ model_id: 'h3-ref2va', aspect_ratio: '16:9', resolution: '720p', segment_duration_sec: 5, segment_count: 6, reference_asset_ids: ['side', 'front'] })
  })
  it.each([['h3-ref2va', 'ref2va', 'ref2av'], ['fast-h3', 'i2v', 'i2v'], ['fast-ltx23', 't2va', 't2v']])('parses echoed %s mode %s', (model, mode, expected) => {
    expect(parseEchoedCreationConfig({ creation_config: { model_id: model, generation_mode: mode, aspect_ratio: '16:9', resolution: '720p', segment_duration_sec: 5, segment_count: 6 } })).toEqual({ modelId: model, modeId: expected, aspectRatio: '16:9', resolution: '720p', segmentDurationSec: 5, segmentCount: 6 })
  })
  it.each([1, 3, 6])('serializes the selected segment count %s', (segmentCount) => {
    expect(buildCreationInitPayload({
      modelId: 'fast-h3', modeId: 't2v', aspectRatio: '16:9', resolution: '720p',
      segmentDurationSec: 5, segmentCount, referenceAssetIds: [],
    })).toMatchObject({ segment_count: segmentCount, segment_duration_sec: 5 })
  })
  it.each([0, 7, 2.5, '3', null])('rejects invalid echoed segment count %s', (segmentCount) => {
    expect(parseEchoedCreationConfig({ creation_config: {
      model_id: 'fast-h3', generation_mode: 't2va', aspect_ratio: '16:9', resolution: '720p',
      segment_duration_sec: 5, segment_count: segmentCount,
    } })).toBeNull()
  })
  it.each([null, {}, { creation_config: {} }, { creation_config: { model_id: 'unknown' } }])('rejects incomplete echoes', (payload) => {
    expect(parseEchoedCreationConfig(payload)).toBeNull()
  })
})
