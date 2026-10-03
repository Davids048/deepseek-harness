/** The creation-capabilities payload, ported from the `/creation-capabilities` route spec of the project controller. */
import { describe, expect, it } from 'vitest'
import { lobbyCapabilitiesAsDict } from '../src/index.ts'
import { ltxFacts, ref2vaFacts } from './fakes.ts'

const UPLOAD_POLICY = { image: { mime_types: ['image/png'], max_bytes: 1024 } }

describe('lobbyCapabilitiesAsDict', () => {
  it('reports the reference lobby capabilities of a reference-image model in the reference key order', () => {
    const choices = {
      generation_modes: ['ref2va'],
      aspect_ratios: ['16:9'],
      resolutions: ['720p'],
      min_segment_duration_sec: 5,
      max_segment_duration_sec: 15,
      unsupported_generation_modes: {},
      // One of the nine request images stays free for a continued segment's last frame.
      reference_inputs: { media_types: ['image'], max_count: 8, conditioning: 'reference' },
    }
    expect(JSON.stringify(lobbyCapabilitiesAsDict(ref2vaFacts(), UPLOAD_POLICY))).toBe(JSON.stringify({
      model_ids: ['h3-ref2va'],
      segment_counts: [1, 2, 3, 4, 5, 6],
      asset_upload: UPLOAD_POLICY,
      models: { 'h3-ref2va': choices },
      ...choices,
    }))
  })

  it('reports first-frame conditioning with the model image limit for a model without a reference-image mode', () => {
    expect(lobbyCapabilitiesAsDict(ltxFacts(), UPLOAD_POLICY)).toMatchObject({
      generation_modes: ['i2v', 't2va'],
      aspect_ratios: ['16:9', '9:16'],
      resolutions: ['1080p', '480p', '720p'],
      unsupported_generation_modes: { fl2va: 'First/last frame mode (FL2VA) is not supported yet.' },
      reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
    })
  })
})
