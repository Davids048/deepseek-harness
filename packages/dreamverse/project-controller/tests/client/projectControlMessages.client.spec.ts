/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'

import { applyProjectControlMessage } from '../../src/client/projectControlMessages.ts'

interface ProjectControlState {
  generationRoundStatus: 'idle' | 'preparing' | 'generating' | 'failed'
  autoExtensionEnabled: boolean
  gpuAssigned: boolean
  queuePosition: number
}

const initialState: ProjectControlState = {
  generationRoundStatus: 'idle',
  autoExtensionEnabled: false,
  gpuAssigned: false,
  queuePosition: 0,
}

describe('applyProjectControlMessage', () => {
  it('updates queue position from queue_status', () => {
    const next = applyProjectControlMessage(initialState, {
      type: 'queue_status',
      position: 3,
    })

    expect(next.queuePosition).toBe(3)
    expect(next.gpuAssigned).toBe(false)
  })

  it('updates state on gpu_assigned', () => {
    const next = applyProjectControlMessage(initialState, {
      type: 'gpu_assigned',
    })

    expect(next.gpuAssigned).toBe(true)
    expect(next.queuePosition).toBe(0)
    expect(next).toEqual({ ...initialState, gpuAssigned: true })
  })

  it.each(['preparing', 'generating', 'idle', 'failed'] as const)('applies authoritative round status %s', (status) => {
    const next = applyProjectControlMessage(initialState, { type: 'generation_round_status', auto_extension_enabled: false, status })

    expect(next.generationRoundStatus).toBe(status)
    expect(next.autoExtensionEnabled).toBe(false)
    expect(next.gpuAssigned).toBe(false)
  })

  it('confirms automatic scheduling without changing the accepted round phase', () => {
    const generating = { ...initialState, generationRoundStatus: 'generating' as const }
    const enabled = applyProjectControlMessage(generating, {
      type: 'generation_round_status', status: 'generating', auto_extension_enabled: true,
    })
    expect(enabled).toEqual({ ...generating, autoExtensionEnabled: true })
    const disabled = applyProjectControlMessage(enabled, {
      type: 'generation_round_status', status: 'generating', auto_extension_enabled: false,
    })
    expect(disabled).toEqual(generating)
  })

})
