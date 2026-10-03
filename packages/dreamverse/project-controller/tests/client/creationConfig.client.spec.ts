/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'

import {
  CREATION_MODELS,
  buildMentionOptions,
  modeRequiresReference,
} from '../../src/client/creationConfig.ts'

describe('creationConfig', () => {
  it('includes all Dreamverse lobby models', () => {
    expect(CREATION_MODELS.map(model => model.id)).toEqual(['h3-ref2va', 'fast-ltx23', 'fast-ltx2', 'fast-h3'])
  })

  it('builds mention options from presets', () => {
    expect(
      buildMentionOptions([
        { id: 'preset-a', label: 'Preset A', description: 'A short preset' },
        { label: 'Missing id' },
      ]),
    ).toEqual([
      {
        id: 'preset-a',
        label: 'Preset A',
        kind: 'preset',
        description: 'A short preset',
      },
      {
        id: 'Missing id',
        label: 'Missing id',
        kind: 'preset',
        description: undefined,
      },
    ])
  })

  it('derives mode-specific reference requirements', () => {
    expect(modeRequiresReference('ref2av')).toBe(true)
    expect(modeRequiresReference('t2v')).toBe(false)
    expect(modeRequiresReference('i2v')).toBe(true)
  })

})
