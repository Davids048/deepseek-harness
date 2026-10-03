/** @vitest-environment jsdom */
import { assetUploadPolicy, imageAsset } from './assetFixtures.client.ts'
import { describe, expect, it } from 'vitest'

import {
  clampLobbySelectionToCapabilities,
  parseLobbyCapabilities,
  validateLobbyCreationSelection,
  type LobbyCreationCapabilities,
  type LobbySelection,
} from '../../src/client/creationCapabilities.ts'

const ltxCapabilities: LobbyCreationCapabilities = {
  model_id: 'fast-ltx23',
  generation_modes: ['t2va', 'i2v'],
  aspect_ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  resolutions: ['480p', '720p', '1080p'],
  min_segment_duration_sec: 1, max_segment_duration_sec: 20, segment_counts: [1, 2, 3, 4, 5, 6],
  unsupported_generation_modes: { fl2va: 'First/last frame mode (FL2VA) is not supported yet.' },
  reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
  asset_upload: assetUploadPolicy,
}
const h3Capabilities: LobbyCreationCapabilities = {
  ...ltxCapabilities, model_id: 'fast-h3', min_segment_duration_sec: 5, max_segment_duration_sec: 15, aspect_ratios: ['16:9'], resolutions: ['720p'],
}
const { model_id: servedModel, segment_counts, asset_upload, ...modelRecord } = ltxCapabilities
const servedPayload = { model_ids: [servedModel], models: { [servedModel]: modelRecord }, segment_counts, asset_upload }

describe('creationCapabilities', () => {
  it.each(['fast-ltx23', 'fast-ltx2', 'fast-h3'] as const)('parses the single served model %s', (modelId) => {
    const expected = modelId === 'fast-h3' ? h3Capabilities : { ...ltxCapabilities, model_id: modelId }
    const { model_id, segment_counts, asset_upload, ...record } = expected
    expect(parseLobbyCapabilities({
      model_ids: [model_id], models: { [model_id]: record }, segment_counts, asset_upload,
    })).toEqual(expected)
  })

  it.each([
    { reason: 'missing payload', payload: undefined },
    { reason: 'null payload', payload: null },
    { reason: 'array payload', payload: [] },
    { reason: 'missing model IDs', payload: { models: servedPayload.models } },
    { reason: 'empty model IDs', payload: { ...servedPayload, model_ids: [] } },
    { reason: 'multiple models', payload: { ...servedPayload, model_ids: ['fast-ltx23', 'fast-h3'] } },
    { reason: 'unknown model', payload: { ...servedPayload, model_ids: ['other'] } },
    { reason: 'wrong model type', payload: { ...servedPayload, model_ids: 'fast-ltx23' } },
    { reason: 'missing model map', payload: { ...servedPayload, models: undefined } },
    { reason: 'missing served record', payload: { ...servedPayload, models: { 'fast-h3': modelRecord } } },
    { reason: 'null served record', payload: { ...servedPayload, models: { [servedModel]: null } } },
  ])('returns unavailable for $reason', ({ payload }) => {
    expect(parseLobbyCapabilities(payload)).toBeNull()
  })

  it.each([
    ['generation_modes', undefined], ['generation_modes', []], ['generation_modes', ['other']],
    ['generation_modes', ['t2va', 'typo']],
    ['aspect_ratios', undefined], ['aspect_ratios', []], ['aspect_ratios', ['2:1']],
    ['resolutions', undefined], ['resolutions', []], ['resolutions', ['360p']],
    ['min_segment_duration_sec', undefined], ['min_segment_duration_sec', []], ['min_segment_duration_sec', '5'],
    ['max_segment_duration_sec', undefined], ['max_segment_duration_sec', []], ['max_segment_duration_sec', '15'],
    ['unsupported_generation_modes', undefined], ['unsupported_generation_modes', { fl2va: 1 }],
    ['unsupported_generation_modes', { fl2va: '' }],
    ['reference_inputs', undefined],
    ['reference_inputs', { media_types: ['video'], max_count: 9, conditioning: 'reference' }],
    ['reference_inputs', { media_types: ['image'], max_count: 0, conditioning: 'reference' }],
    ['reference_inputs', { media_types: ['image'], max_count: 9, conditioning: 'unknown' }],
  ])('rejects a malformed required record field %s=%j', (field, value) => {
    expect(parseLobbyCapabilities({
      ...servedPayload, models: { [servedModel]: { ...modelRecord, [field]: value } },
    })).toBeNull()
  })

  it.each([0, -5, 5.5, Infinity, NaN, '15', null, [5, 10, 15]])('rejects invalid maximum duration %j', (duration) => {
    expect(parseLobbyCapabilities({
      ...servedPayload, models: { [servedModel]: { ...modelRecord, max_segment_duration_sec: duration } },
    })).toBeNull()
  })

  it.each([0, -1, 1.5, Infinity, NaN, '5', null, 21])('rejects invalid minimum duration %j', (duration) => {
    expect(parseLobbyCapabilities({
      ...servedPayload, models: { [servedModel]: { ...modelRecord, min_segment_duration_sec: duration } },
    })).toBeNull()
  })

  it('uses the LTX minimum independently of H3 limits', () => {
    expect(validateLobbyCreationSelection({
      capabilities: ltxCapabilities, modeId: 't2v', aspectRatio: '16:9', resolution: '720p',
      segmentDurationSec: 1, segmentCount: 3,
    })).toBeNull()
  })

  it.each([undefined, [], [0], [7], [1.5], ['3'], [true], '6'])('rejects invalid application segment counts %j', (counts) => {
    expect(parseLobbyCapabilities({ ...servedPayload, segment_counts: counts })).toBeNull()
  })

  it('reads the model maximum duration as one limit', () => {
    expect(parseLobbyCapabilities({
      ...servedPayload, models: { [servedModel]: { ...modelRecord, min_segment_duration_sec: 5, max_segment_duration_sec: 15 } },
    })?.max_segment_duration_sec).toBe(15)
  })

  it.each([5, 7, 15])('accepts requested duration %s within the model maximum', (segmentDurationSec) => {
    expect(validateLobbyCreationSelection({
      capabilities: h3Capabilities, modeId: 't2v', aspectRatio: '16:9', resolution: '720p',
      segmentDurationSec, segmentCount: 3,
    })).toBeNull()
  })

  it.each([0, -1, 4, 7.5, 16, Infinity, NaN])('rejects requested duration %s outside the integer range', (segmentDurationSec) => {
    expect(validateLobbyCreationSelection({
      capabilities: h3Capabilities, modeId: 't2v', aspectRatio: '16:9', resolution: '720p',
      segmentDurationSec, segmentCount: 3,
    })).toEqual({ code: 'duration-out-of-range', min: 5, max: 15 })
  })

  it.each([[0, 5], [7, 7], [16, 15]])('bounds duration %s to %s without changing count', (segmentDurationSec, expected) => {
    expect(clampLobbySelectionToCapabilities({
      capabilities: h3Capabilities, modeId: 't2v', aspectRatio: '16:9', resolution: '720p',
      segmentDurationSec, segmentCount: 3,
    })).toMatchObject({ segmentDurationSec: expected, segmentCount: 3 })
  })

  it.each([0, 7, 2.5])('rejects unsupported requested segment count %s', (segmentCount) => {
    expect(validateLobbyCreationSelection({
      capabilities: ltxCapabilities, modeId: 't2v', aspectRatio: '16:9', resolution: '720p',
      segmentDurationSec: 5, segmentCount,
    })).toEqual({ code: 'segment-count-unsupported' })
  })

  /** Only the matching model record defines accepted choices and their fallback order. */
  it('preserves per-model choice ordering despite contradictory top-level fields', () => {
    const record = { ...modelRecord, min_segment_duration_sec: 2, max_segment_duration_sec: 20, segment_counts: [1], resolutions: ['1080p', '480p'] }
    expect(parseLobbyCapabilities({
      ...servedPayload, models: { [servedModel]: record },
      generation_modes: ['fl2va'], aspect_ratios: ['1:1'], resolutions: ['4k'], min_segment_duration_sec: 3, max_segment_duration_sec: 10, segment_counts: [1, 2, 3, 4, 5, 6],
      reference_inputs: { media_types: [], max_count: 0 },
    })).toEqual({ model_id: servedModel, ...record, segment_counts, asset_upload })
  })

  it.each([
    { modeId: 'i2v' }, { aspectRatio: '9:16' }, { resolution: '480p' }, { segmentDurationSec: 10, segmentCount: 6 },
    { modeId: 'i2v', aspectRatio: '9:16', resolution: '480p', segmentDurationSec: 10, segmentCount: 6 },
  ] satisfies Partial<LobbySelection>[])('preserves supported preferences %j', (changes) => {
    const selection: LobbySelection = {
      modeId: 't2v', aspectRatio: '16:9', resolution: '720p', segmentDurationSec: 5, segmentCount: 6, ...changes,
    }
    expect(clampLobbySelectionToCapabilities({ capabilities: ltxCapabilities, ...selection })).toEqual(selection)
  })

  it('reconciles LTX geometry against H3 while retaining supported mode and duration', () => {
    expect(clampLobbySelectionToCapabilities({
      capabilities: h3Capabilities, modeId: 'i2v', aspectRatio: '9:16', resolution: '480p', segmentDurationSec: 10, segmentCount: 6,
    })).toEqual({ modeId: 'i2v', aspectRatio: '16:9', resolution: '720p', segmentDurationSec: 10, segmentCount: 6 })
  })

  /** Unsupported geometry uses advertised order while an in-range segment length stays selected. */
  it('uses the first advertised geometry and preserves an in-range duration', () => {
    expect(clampLobbySelectionToCapabilities({
      capabilities: {
        ...ltxCapabilities, generation_modes: ['i2v'], aspect_ratios: ['9:16', '1:1'],
        resolutions: ['480p', '1080p'], min_segment_duration_sec: 5, max_segment_duration_sec: 15, segment_counts: [1, 2, 3, 4, 5, 6],
      },
      modeId: 't2v', aspectRatio: '16:9', resolution: '720p', segmentDurationSec: 5, segmentCount: 6,
    })).toEqual({ modeId: 'i2v', aspectRatio: '9:16', resolution: '480p', segmentDurationSec: 5, segmentCount: 6 })
  })

  /** Unsupported geometry uses advertised choices and excessive segment length uses the model maximum. */
  it('clamps unsupported lobby selections to advertised choices', () => {
    expect(
      clampLobbySelectionToCapabilities({
        capabilities: h3Capabilities,
        modeId: 'fl2av',
        aspectRatio: '9:16',
        resolution: '4k',
        segmentDurationSec: 99, segmentCount: 6,
      }),
    ).toEqual({
      modeId: 't2v',
      aspectRatio: '16:9',
      resolution: '720p',
      segmentDurationSec: 15, segmentCount: 6,
    })
  })

  /** The served explanation remains the actionable error for an unsupported mode. */
  it('rejects unsupported generation modes with the served explanation', () => {
    expect(
      validateLobbyCreationSelection({
        capabilities: ltxCapabilities,
        modeId: 'fl2av',
        aspectRatio: '16:9',
        resolution: '720p',
        segmentDurationSec: 5, segmentCount: 6,
      }),
    ).toEqual({ code: 'mode-notice', notice: 'First/last frame mode (FL2VA) is not supported yet.' })
  })

  /** A resolution outside the accepted model choices cannot pass admission validation. */
  it('rejects unsupported resolutions for ltx models', () => {
    expect(
      validateLobbyCreationSelection({
        capabilities: ltxCapabilities,
        modeId: 't2v',
        aspectRatio: '16:9',
        resolution: '4k',
        segmentDurationSec: 5, segmentCount: 6,
      }),
    ).toEqual({ code: 'resolution-unsupported' })
  })

  /** Text generation passes the same capability validation used before a project socket opens. */
  it('accepts supported text-mode selection without a reference', () => {
    expect(validateLobbyCreationSelection({
      capabilities: h3Capabilities,
      modeId: 't2v',
      aspectRatio: '16:9',
      resolution: '720p',
      segmentDurationSec: 5, segmentCount: 6,
    })).toBeNull()
  })

  /** Reference presence belongs to capability validation before serialization begins. */
  it('requires an image for supported reference-guided mode', () => {
    expect(validateLobbyCreationSelection({
      capabilities: h3Capabilities,
      modeId: 'i2v',
      aspectRatio: '16:9',
      resolution: '720p',
      segmentDurationSec: 5, segmentCount: 6,
      references: [],
    })).toEqual({ code: 'reference-count', limit: 1 })
  })

  /** Each advertised image MIME can satisfy a reference-guided selection. */
  it.each(['image/png', 'image/jpeg', 'image/webp'])('accepts a supported %s reference', (mimeType) => {
    expect(validateLobbyCreationSelection({
      capabilities: h3Capabilities,
      modeId: 'i2v',
      aspectRatio: '16:9',
      resolution: '720p',
      segmentDurationSec: 5, segmentCount: 6,
      references: [{ draftId: 'one', kind: 'localFile', file: new File(['image'], 'reference', { type: mimeType }) }],
    })).toBeNull()
  })

  /** A video cannot satisfy the reference-image requirement accepted by this model's capabilities. */
  it('rejects video MIME through active reference validation', () => {
    expect(validateLobbyCreationSelection({
      capabilities: h3Capabilities,
      modeId: 'i2v',
      aspectRatio: '16:9',
      resolution: '720p',
      segmentDurationSec: 5, segmentCount: 6,
      references: [{ draftId: 'one', kind: 'localFile', file: new File(['video'], 'clip.mp4', { type: 'video/mp4' }) }],
    })).toEqual({ code: 'reference-not-image' })
  })

  /** Saved subject pictures follow the same lower and upper generation limits as local files. */
  it.each([0, 1, 9, 10])('enforces H3 Ref2AV subject picture count at %s', (count) => {
    const validation = validateLobbyCreationSelection({
      capabilities: {
        ...h3Capabilities, model_id: 'h3-ref2va', generation_modes: ['ref2va'],
        reference_inputs: { media_types: ['image'], max_count: 9, conditioning: 'reference' },
      },
      modeId: 'ref2av', aspectRatio: '16:9', resolution: '720p', segmentDurationSec: 5, segmentCount: 6,
      references: Array.from({ length: count }, (_, index) => ({
        draftId: String(index), kind: 'savedAsset', asset: imageAsset(`${index}.png`),
      })),
    })
    if (count === 1 || count === 9) expect(validation).toBeNull()
    else expect(validation).toEqual({ code: 'reference-count', limit: 9 })
  })
})
