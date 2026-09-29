/** Verify feature instructions, accepted responses, and failure results through real provider races. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { continueVideo } from '../src/features/continuation.ts'
import type { PromptResult } from '../src/features/index.ts'
import { rewriteRollout, type RolloutResult } from '../src/features/rollout.ts'
import { expandClip } from '../src/features/single-clip.ts'
import { VendorClient } from '../src/llm/client.ts'
import type { ProviderRace } from '../src/llm/race.ts'
import type { PromptSettings } from '../src/settings.ts'
import type { JsonObject } from '../src/utils/python-text.ts'
import { FakeVendor, UNUSED_ENDPOINT, recordingDiagnostics, requestBodyText, testRace, testSettings, textReply } from './support.ts'

const SYSTEM_PROMPT = 'caller-selected system prompt'

/** Feature inputs supplied by `PromptEnhancer`. */
interface Dependencies {
  settings: PromptSettings
  systemPrompt: string
  maxCompletionTokens: number
  race: ProviderRace
}

/** Vendor request bodies recorded by the stubbed `fetch`, and the response body it returns. */
interface SdkStub {
  payload: JsonObject
  requests: JsonObject[]
}

/** A chat completion carrying assistant text. */
function response(content: string): JsonObject {
  return { choices: [{ message: { content } }] }
}

/**
 * Construct settings, a real vendor client, and a race whose HTTP requests reach an in-memory stub.
 * @param requestModel - the vendor alias for the logical default model.
 * @returns the feature dependencies and the stub.
 */
function promptDependencies(requestModel = 'gpt-test'): { deps: Dependencies; sdk: SdkStub } {
  const sdk: SdkStub = { payload: {}, requests: [] }
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    sdk.requests.push(JSON.parse(requestBodyText(init)) as JsonObject)
    return Promise.resolve(new Response(JSON.stringify(sdk.payload)))
  }))
  const vendor = new VendorClient('cerebras', requestModel, UNUSED_ENDPOINT, recordingDiagnostics())
  return { deps: { settings: testSettings(), systemPrompt: SYSTEM_PROMPT, maxCompletionTokens: 512, race: testRace([[vendor]]) }, sdk }
}

/** Decode the user message of a recorded request body. */
function userPayload(body: JsonObject | undefined): Record<string, unknown> {
  const messages = body?.['messages'] as { content: string }[]
  return JSON.parse(messages[1]?.content ?? '{}') as Record<string, unknown>
}

/** Read the system message of a recorded request body. */
function systemMessage(body: JsonObject | undefined): unknown {
  return (body?.['messages'] as unknown[])[0]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

type FeatureCall = (deps: Dependencies) => Promise<PromptResult | RolloutResult>

describe('prompt features', () => {
  it.each([5, 10, 15])('expands a clip with the supplied template and default model for %i seconds', async (duration) => {
    const { deps, sdk } = promptDependencies()
    sdk.payload = response('{"prompt":"Extended single clip"}')
    const result = await expandClip('A forest walk', { ...deps, segmentDurationSec: duration })
    expect([result.prompt, result.model, result.provider]).toEqual(['Extended single clip', 'gpt-test', 'cerebras'])
    expect(result.fallbackUsed).toBe(false)
    expect(result.error).toBeNull()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(sdk.requests[0]?.['model']).toBe('gpt-test')
    expect(systemMessage(sdk.requests[0])).toEqual({ role: 'system', content: SYSTEM_PROMPT })
    const { request: instruction, ...payload } = userPayload(sdk.requests[0])
    expect(instruction).toContain('"prompt"')
    expect(instruction).not.toContain('LTX')
    expect(instruction).toContain(`${duration}-second`)
    expect(payload).toEqual({ user_prompt: 'A forest walk', segment_duration_sec: duration })
  })

  it.each([
    ['A user live prompt', '<conditioning_prompt>A user live prompt</conditioning_prompt>'],
    [null, 'Infer the next narrative beat from this history.'],
  ])('continues history with direction %j', async (direction, instruction) => {
    for (const duration of [5, 10, 15]) {
      const { deps, sdk } = promptDependencies()
      sdk.payload = response('{"next_prompt":"Next scene"}')
      const result = await continueVideo(direction, {
        ...deps, segmentDurationSec: duration, lockedSegments: ['Segment 1', 'Segment 2'], nextSegmentIdx: 3,
      })
      expect([result.prompt, result.model, result.fallbackUsed, result.error]).toEqual(['Next scene', 'gpt-test', false, null])
      expect(sdk.requests[0]?.['model']).toBe('gpt-test')
      const payload = userPayload(sdk.requests[0])
      const requestText = String(payload['request'])
      expect(payload['segment_duration_sec']).toBe(duration)
      expect(requestText).toContain(`segment_1 (0-${duration}s): "Segment 1"`)
      expect(requestText).toContain(`segment_2 (${duration}-${2 * duration}s): "Segment 2"`)
      expect(requestText).toContain('segment_3')
      expect(requestText).toContain(`The segment lasts ${duration} seconds.`)
      expect(requestText).toContain(instruction)
    }
  })

  it.each([
    ['expandClip', (deps: Dependencies) => expandClip('   ', { ...deps, segmentDurationSec: 5 })],
    ['continueVideo', (deps: Dependencies) => continueVideo('   ', { ...deps, segmentDurationSec: 5 })],
  ] as [string, FeatureCall][])('%s fails an empty direction without a vendor request', async (_name, call) => {
    const { deps, sdk } = promptDependencies()
    const result = await call(deps) as PromptResult
    expect([result.prompt, result.fallbackUsed, result.error]).toEqual(['', true, 'No valid prompt provided.'])
    expect(sdk.requests).toEqual([])
  })

  it.each([
    [(deps: Dependencies) => expandClip('An idea', { ...deps, segmentDurationSec: 5 }), 'plain prose'],
    [(deps: Dependencies) => expandClip('An idea', { ...deps, segmentDurationSec: 5 }), '{"segment_prompts":["A","B"]}'],
    [(deps: Dependencies) => continueVideo('User direction', { ...deps, segmentDurationSec: 5 }), 'plain prose'],
    [(deps: Dependencies) => continueVideo(null, { ...deps, segmentDurationSec: 5 }), 'plain prose'],
  ] as [FeatureCall, string][])('returns an empty prompt for rejected content %#', async (call, content) => {
    const { deps, sdk } = promptDependencies()
    sdk.payload = response(content)
    const result = await call(deps) as PromptResult
    expect([result.prompt, result.fallbackUsed]).toEqual(['', true])
    expect(result.error).toContain(content)
    expect(deps.race.getProviderSuccessCounts()['cerebras']).toBe(0)
  })

  it.each([
    ['{"id":"r","label":"Rollout","segment_prompts":["A","B"]}', 'r', 'Rollout'],
    ['{"rewritten_prompts":["A","B"]}', 'preset_a', 'Preset A'],
    ['{"segments":[{"prompt":"A"},{"text":"B"}]}', 'preset_a', 'Preset A'],
    ['Here are the cinematic prompts:\n1. A\n2. B', 'preset_a', 'Preset A'],
    ['{"rollout":{"id":"r","label":"Rollout","segment_prompts":["A","B"]}}', 'r', 'Rollout'],
    ['{"segment_1":"A","segment_2":"B"}', 'preset_a', 'Preset A'],
  ])('accepts rollout format %j', async (content, rolloutId, rolloutLabel) => {
    const { deps, sdk } = promptDependencies()
    sdk.payload = response(content)
    const result = await rewriteRollout(['one', 'two'], {
      ...deps, segmentCount: 6, segmentDurationSec: 5, presetId: 'preset_a', presetLabel: 'Preset A', rewriteInstruction: 'cinematic',
    })
    expect(result.prompts).toEqual(['A', 'B'])
    expect([result.rolloutId, result.rolloutLabel, result.fallbackUsed, result.error]).toEqual([rolloutId, rolloutLabel, false, null])
    expect(result.rawResponseText).toBe(content)
  })

  it('sends the complete source rollout and supplied template when editing', async () => {
    const { deps, sdk } = promptDependencies()
    sdk.payload = response('{"segment_prompts":["A","B"]}')
    const result = await rewriteRollout(['prompt one', 'prompt two'], {
      ...deps, segmentCount: 6, segmentDurationSec: 5, presetId: 'preset_a', presetLabel: 'Preset A',
      rewriteInstruction: 'cinematic',
    })
    expect([result.fallbackUsed, result.model]).toEqual([false, 'gpt-test'])
    expect(sdk.requests[0]?.['model']).toBe('gpt-test')
    expect(sdk.requests[0]?.['temperature']).toBe(0.4)
    expect(systemMessage(sdk.requests[0])).toEqual({ role: 'system', content: SYSTEM_PROMPT })
    const { request: instruction, ...payload } = userPayload(sdk.requests[0])
    expect(instruction).toContain('"segment_prompts"')
    expect(instruction).toContain('exactly 2')
    expect(payload).toEqual({
      mode: 'edit_existing_rollout',
      user_instruction: 'cinematic',
      desired_segment_count: 2,
      segment_duration_sec: 5,
      current_rollout: { id: 'preset_a', label: 'Preset A', segment_prompts: ['prompt one', 'prompt two'] },
    })
  })

  it.each([1, 3, 6])('creates %i prompts from an initial instruction', async (segmentCount) => {
    const { deps, sdk } = promptDependencies()
    const prompts = Array.from({ length: segmentCount }, (_, index) => `Generated segment ${index + 1}`)
    sdk.payload = response(JSON.stringify({ id: 'custom', label: 'Custom rollout', segment_prompts: prompts }))
    const result = await rewriteRollout([], {
      ...deps, segmentCount, segmentDurationSec: 5, presetId: 'custom', presetLabel: 'Custom rollout',
      rewriteInstruction: 'A moonbase corridor thriller',
    })
    expect(result.fallbackUsed).toBe(false)
    expect(result.prompts).toEqual(prompts)
    const { request: instruction, ...payload } = userPayload(sdk.requests[0])
    expect(instruction).toContain('"segment_prompts"')
    expect(instruction).toContain(`exactly ${segmentCount}`)
    expect(payload).toEqual({
      mode: 'new_rollout',
      user_instruction: 'A moonbase corridor thriller',
      desired_segment_count: segmentCount,
      segment_duration_sec: 5,
      rollout_id_hint: 'custom',
      rollout_label_hint: 'Custom rollout',
    })
  })

  it.each([1, 3, 6])('rejects shorter and longer rollouts of %i segments in every format', async (segmentCount) => {
    for (const offset of [-1, 1]) {
      for (const format of ['json-list', 'json-indexed', 'numbered-prose']) {
        const { deps, sdk } = promptDependencies()
        const prompts = Array.from({ length: segmentCount + offset }, (_, index) => `Generated segment ${index + 1}`)
        const content = format === 'json-list'
          ? JSON.stringify({ segment_prompts: prompts })
          : format === 'json-indexed'
            ? JSON.stringify(Object.fromEntries(prompts.map((prompt, index) => [`segment_${index + 1}`, prompt])))
            : prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')
        sdk.payload = response(content)
        const result = await rewriteRollout([], {
          ...deps, segmentCount, segmentDurationSec: 5, rewriteInstruction: 'A moonbase corridor thriller',
        })
        expect([result.fallbackUsed, result.prompts]).toEqual([true, []])
        expect(result.error).toBeTruthy()
        expect(deps.race.getProviderSuccessCounts()['cerebras']).toBe(0)
      }
    }
  })

  it.each(['invalid prose', '{"segment_prompts":["A"]}', '{"segment_prompts":["A",""]}'])(
    'keeps the source prompts and diagnostics for rejected rollout %j', async (content) => {
      const { deps, sdk } = promptDependencies()
      sdk.payload = response(content)
      const result = await rewriteRollout(['one', 'two'], {
        ...deps, segmentCount: 6, segmentDurationSec: 5, rewriteInstruction: 'cinematic',
      })
      expect([result.fallbackUsed, result.prompts, result.sourcePrompts]).toEqual([true, ['one', 'two'], ['one', 'two']])
      expect([result.rolloutId, result.rolloutLabel]).toEqual(['current_rollout', 'Current rollout'])
      expect(result.error).toContain(content)
      expect(result.rawResponseText).toBeNull()
      expect(deps.race.getProviderSuccessCounts()['cerebras']).toBe(0)
    })

  it('reports the serialized response when the rollout reply has no assistant text', async () => {
    const { deps, sdk } = promptDependencies()
    sdk.payload = { choices: [{ finish_reason: 'length', message: { content: [], refusal: null } }] }
    const result = await rewriteRollout(['one', 'two'], { ...deps, segmentCount: 6, segmentDurationSec: 5, rewriteInstruction: 'cinematic' })
    expect([result.fallbackUsed, result.prompts, result.rawResponseText]).toEqual([true, ['one', 'two'], null])
    expect(result.error).toContain('"finish_reason": "length"')
  })

  const acceptedCases: [string, FeatureCall, string, (result: PromptResult | RolloutResult) => unknown, unknown][] = [
    ['single-clip', deps => expandClip('An idea', { ...deps, segmentDurationSec: 5 }), '{"prompt":"Accepted prompt"}',
      result => (result as PromptResult).prompt, 'Accepted prompt'],
    ['guided-continuation', deps => continueVideo('An idea', { ...deps, segmentDurationSec: 5 }),
      '{"next_prompt":"Accepted prompt"}', result => (result as PromptResult).prompt, 'Accepted prompt'],
    ['automatic-continuation', deps => continueVideo(null, { ...deps, segmentDurationSec: 5 }),
      '{"next_prompt":"Accepted prompt"}', result => (result as PromptResult).prompt, 'Accepted prompt'],
    ['rollout', deps => rewriteRollout(['one', 'two'], { ...deps, segmentCount: 6, segmentDurationSec: 5 }),
      '{"segment_prompts":["A","B"]}', result => (result as RolloutResult).prompts, ['A', 'B']],
  ]

  it.each(acceptedCases)('%s accepts a slower valid reply after a fast invalid reply', async (_name, call, content, read, expected) => {
    for (const invalidContent of ['not JSON', '{"unexpected_field":"wrong shape"}']) {
      let invalidReturned: () => void = () => {}
      const invalidDone = new Promise<void>((resolve) => { invalidReturned = resolve })
      const cerebras = new FakeVendor('cerebras', () => {
        invalidReturned()
        return Promise.resolve(textReply(invalidContent))
      })
      const groq = new FakeVendor('groq', async () => {
        await invalidDone
        await Promise.resolve()
        return textReply(content)
      })
      const race = testRace([[cerebras, groq]])
      const result = await call({ settings: testSettings(), systemPrompt: SYSTEM_PROMPT, maxCompletionTokens: 512, race })
      expect(read(result)).toEqual(expected)
      expect([result.fallbackUsed, result.error, result.provider]).toEqual([false, null, 'groq'])
      expect(race.getProviderSuccessCounts()).toEqual({ cerebras: 0, groq: 1 })
    }
  })

  const modelCases: [string, FeatureCall, string][] = [
    ['single-clip', deps => expandClip('An idea', { ...deps, segmentDurationSec: 5 }), '{"prompt":"Accepted prompt"}'],
    ['guided-continuation', deps => continueVideo('An idea', { ...deps, segmentDurationSec: 5 }), '{"next_prompt":"Accepted prompt"}'],
    ['automatic-continuation', deps => continueVideo(null, { ...deps, segmentDurationSec: 5 }), '{"next_prompt":"Accepted prompt"}'],
    ['rollout', deps => rewriteRollout(['one', 'two'], { ...deps, segmentCount: 6, segmentDurationSec: 5 }), '{"segment_prompts":["A","B"]}'],
  ]

  it.each(modelCases)('%s maps the default model to the vendor alias', async (_name, call, content) => {
    const { deps, sdk } = promptDependencies('vendor-specific-model')
    sdk.payload = response(content)
    const result = await call(deps)
    expect([result.fallbackUsed, result.error]).toEqual([false, null])
    expect(result.model).toBe('gpt-test')
    expect(sdk.requests[0]?.['model']).toBe('vendor-specific-model')
  })

  const labelCases: [(deps: Dependencies, labels: string[]) => Promise<PromptResult | RolloutResult>, string][] = [
    [(deps, labels) => expandClip('Walk by the harbor', { ...deps, segmentDurationSec: 5, referenceLabels: labels }),
      '{"prompt":"Picture 1 walks by the harbor"}'],
    [(deps, labels) => continueVideo('Enter the cafe', {
      ...deps, segmentDurationSec: 5, lockedSegments: ['A man in a blue suit'], referenceLabels: labels,
    }), '{"next_prompt":"Picture 1 enters the cafe"}'],
    [(deps, labels) => continueVideo(null, {
      ...deps, segmentDurationSec: 5, lockedSegments: ['A man in a blue suit'], referenceLabels: labels,
    }), '{"next_prompt":"Picture 1 enters the cafe"}'],
    [(deps, labels) => rewriteRollout(['A man in a blue suit'], {
      ...deps, segmentCount: 6, segmentDurationSec: 5, rewriteInstruction: 'Move to the harbor', referenceLabels: labels,
    }), '{"segment_prompts":["Picture 1 walks by the harbor"]}'],
    [(deps, labels) => rewriteRollout([], {
      ...deps, segmentCount: 6, segmentDurationSec: 5, rewriteInstruction: 'A harbor visit', referenceLabels: labels,
    }), '{"segment_prompts":["A","B","C","D","E","F"]}'],
  ]

  it.each(labelCases)('preserves the supplied template, budget, and reference labels %#', async (call, reply) => {
    for (const maxCompletionTokens of [256, 8192]) {
      const { deps, sdk } = promptDependencies()
      sdk.payload = response(reply)
      const payloads: Record<string, unknown>[] = []
      for (const labels of [[], ['Picture 1', 'Picture 2']]) {
        const result = await call({ ...deps, maxCompletionTokens }, labels)
        expect(result.fallbackUsed).toBe(false)
        const body = sdk.requests.at(-1)
        expect(body?.['max_completion_tokens']).toBe(maxCompletionTokens)
        expect(systemMessage(body)).toEqual({ role: 'system', content: SYSTEM_PROMPT })
        const { protagonist_reference_labels: sentLabels = [], ...payload } = userPayload(body)
        expect(sentLabels).toEqual(labels)
        payloads.push(payload)
      }
      expect(payloads[0]).toEqual(payloads[1])
    }
  })

  it('rethrows the caller abort instead of returning a fallback result', async () => {
    const vendor = new FakeVendor('cerebras', (_request, signal) => new Promise((_resolve, reject) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- like fetch, reject with the exact abort reason.
      signal?.addEventListener('abort', () => { reject(signal.reason) })
    }))
    const controller = new AbortController()
    const pending = expandClip('An idea', {
      settings: testSettings(), systemPrompt: SYSTEM_PROMPT, maxCompletionTokens: 512, race: testRace([[vendor]]),
      segmentDurationSec: 5, signal: controller.signal,
    })
    const reason = new Error('closed')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})
