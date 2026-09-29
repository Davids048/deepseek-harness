/** Exercise the public prompt API through real settings, vendor requests, and response acceptance. */
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PromptResult } from '../src/features/index.ts'
import type { RolloutResult } from '../src/features/rollout.ts'
import { VendorClient } from '../src/llm/client.ts'
import { PromptEnhancer } from '../src/prompt-enhancer.ts'
import { PACKAGED_TEMPLATE_DIRECTORY } from '../src/templates/loader.ts'
import { PromptValueError } from '../src/utils/errors.ts'
import type { JsonObject } from '../src/utils/python-text.ts'
import { UNUSED_ENDPOINT, recordingDiagnostics, requestBodyText, temporaryDirectory, testRace, testSettings, testTemplates, type TemporaryDirectory } from './support.ts'

/** Vendor request bodies recorded by the stubbed `fetch`, and the assistant text or failure it answers with. */
interface SdkStub {
  content: string
  failure: string | null
  requests: JsonObject[]
}

let temporary: TemporaryDirectory
let tmp: string
let enhancer: PromptEnhancer
let sdk: SdkStub

beforeEach(() => {
  temporary = temporaryDirectory()
  tmp = temporary.directory
  sdk = { content: '', failure: null, requests: [] }
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    sdk.requests.push(JSON.parse(requestBodyText(init)) as JsonObject)
    // A non-retryable status reaches the result on the first attempt, like the reference SDK stub's exception.
    if (sdk.failure !== null) return Promise.resolve(new Response(sdk.failure, { status: 400 }))
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: sdk.content } }] })))
  }))
  const vendor = new VendorClient('cerebras', 'vendor-model', UNUSED_ENDPOINT, recordingDiagnostics())
  enhancer = new PromptEnhancer(testSettings(), testTemplates(tmp), testRace([[vendor]]))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  temporary.cleanup()
})

/** Decode the user message of a recorded request body. */
function userPayload(body: JsonObject | undefined): Record<string, unknown> {
  const messages = body?.['messages'] as { content: string }[]
  return JSON.parse(messages[1]?.content ?? '{}') as Record<string, unknown>
}

/** Read the system prompt of a recorded request body. */
function systemPrompt(body: JsonObject | undefined): string | undefined {
  return (body?.['messages'] as { content: string }[])[0]?.content
}

type Operation = (options: { generationMode?: string; referenceLabels?: string[]; segmentDurationSec: number }) =>
Promise<PromptResult | RolloutResult>

const operations: [string, Operation, string, (result: PromptResult | RolloutResult) => unknown, unknown, string][] = [
  ['clip', options => enhancer.expandClip('A moonbase', options), '{"prompt":"Detailed moonbase"}',
    result => (result as PromptResult).prompt, 'Detailed moonbase', 'clip and auto template'],
  ['guided-continuation', options => enhancer.continueVideo('Lights go out', { ...options, lockedSegments: ['A moonbase'] }),
    '{"next_prompt":"The corridor darkens"}', result => (result as PromptResult).prompt, 'The corridor darkens', 'continuation template'],
  ['automatic-continuation', options => enhancer.continueVideo(null, { ...options, lockedSegments: ['A moonbase'] }),
    '{"next_prompt":"A door opens"}', result => (result as PromptResult).prompt, 'A door opens', 'continuation template'],
  ['edit-rollout', options => enhancer.rewriteRollout(['one', 'two'], { ...options, segmentCount: 6 }),
    '{"segment_prompts":["A","B"]}', result => (result as RolloutResult).prompts, ['A', 'B'], 'rewrite template'],
  ['initial-rollout', options => enhancer.rewriteRollout([], { ...options, segmentCount: 6, rewriteInstruction: 'A moonbase' }),
    '{"segment_prompts":["A","B","C","D","E","F"]}', result => (result as RolloutResult).prompts, ['A', 'B', 'C', 'D', 'E', 'F'],
    'initial rollout template'],
]

describe('PromptEnhancer operations', () => {
  it.each(operations)('%s selects the template by generation mode and keeps labels as request data', async (_name, run, reply, read, expected, template) => {
    for (const generationMode of ['t2va', 'i2v', 'ref2va']) {
      for (const referenceLabels of [[], ['Picture 1', 'Picture 2']]) {
        for (const segmentDurationSec of [5, 15]) {
          sdk.requests = []
          sdk.content = reply
          const successes = enhancer.getProviderSuccessCounts()['cerebras'] ?? 0
          const result = await run({ generationMode, referenceLabels, segmentDurationSec })
          expect(read(result)).toEqual(expected)
          expect([result.fallbackUsed, result.error, result.provider, result.model]).toEqual([false, null, 'cerebras', 'gpt-test'])
          expect(sdk.requests[0]?.['model']).toBe('vendor-model')
          expect(sdk.requests[0]?.['max_completion_tokens']).toBe(generationMode === 'ref2va' ? 8192 : 512)
          expect(systemPrompt(sdk.requests[0])).toBe(generationMode === 'ref2va' ? 'reference shot template' : template)
          const payload = userPayload(sdk.requests[0])
          expect(payload['segment_duration_sec']).toBe(segmentDurationSec)
          expect(payload['protagonist_reference_labels'] ?? []).toEqual(referenceLabels)
          expect(enhancer.getProviderSuccessCounts()).toEqual({ cerebras: successes + 1, groq: 0 })
        }
      }
    }
  })

  it.each([
    ['expandClip', () => enhancer.expandClip('A moonbase', { segmentDurationSec: 5, generationMode: 'unsupported-mode' })],
    ['continueVideo', () => enhancer.continueVideo(null, { segmentDurationSec: 5, lockedSegments: ['A moonbase'], generationMode: 'unsupported-mode' })],
    ['rewriteRollout', () => enhancer.rewriteRollout(['A moonbase'], { segmentCount: 6, segmentDurationSec: 5, generationMode: 'unsupported-mode' })],
  ])('%s rejects an unknown generation mode before a vendor request', async (_name, run) => {
    await expect(run()).rejects.toThrow(new PromptValueError('Unsupported prompt enhancement generation mode: unsupported-mode'))
    expect(sdk.requests).toEqual([])
  })

  it.each([['t2va', 1, 5], ['t2va', 7, 15], ['ref2va', 1, 5], ['ref2va', 7, 15]])(
    'continues without direction in %s after %i accepted prompts', async (generationMode, historyCount, segmentDurationSec) => {
      enhancer.templates.enhanceSystemPrompt = fs.readFileSync(path.join(PACKAGED_TEMPLATE_DIRECTORY, 'next_segment_system_prompt.md'), 'utf8').trim()
      enhancer.templates.ref2vaSystemPrompt = fs.readFileSync(path.join(PACKAGED_TEMPLATE_DIRECTORY, 'ref2va_system_prompt.md'), 'utf8').trim()
      const history = Array.from({ length: historyCount }, (_, index) => `Accepted scene ${index + 1}`)
      const labels = generationMode === 'ref2va' ? ['Picture 1', 'Picture 2'] : []
      sdk.content = '{"next_prompt":"The protagonist follows the river around a bend."}'
      const result = await enhancer.continueVideo(null, {
        lockedSegments: history, segmentDurationSec, generationMode, referenceLabels: labels,
      })
      expect([result.prompt, result.fallbackUsed, result.error]).toEqual(['The protagonist follows the river around a bend.', false, null])
      const system = systemPrompt(sdk.requests[0]) ?? ''
      expect(system).toBe(generationMode === 'ref2va' ? enhancer.templates.ref2vaSystemPrompt : enhancer.templates.enhanceSystemPrompt)
      expect(system.toLowerCase()).toContain('without user direction')
      expect(system).toContain('next_prompt')
      const payload = userPayload(sdk.requests[0])
      expect(payload['segment_duration_sec']).toBe(segmentDurationSec)
      expect(payload['protagonist_reference_labels'] ?? []).toEqual(labels)
      const request = String(payload['request'])
      expect(request).not.toContain('<conditioning_prompt>')
      expect(request).toContain(`Write exactly one new segment (segment_${historyCount + 1})`)
      history.forEach((prompt, index) => {
        expect(request).toContain(`segment_${index + 1} (${index * segmentDurationSec}-${(index + 1) * segmentDurationSec}s): "${prompt}"`)
      })
    })

  it.each(['t2va', 'ref2va'])('reports invalid automatic-continuation output in %s', async (generationMode) => {
    for (const content of ['{"prompt":"Wrong clip field"}', '{"next_prompt":""}', 'Unstructured prose']) {
      sdk.content = content
      const result = await enhancer.continueVideo(null, {
        lockedSegments: ['A protagonist reaches a river'], segmentDurationSec: 7, generationMode,
        referenceLabels: generationMode === 'ref2va' ? ['Picture 1'] : [],
      })
      expect([result.prompt, result.fallbackUsed]).toEqual(['', true])
      expect(result.error).toContain(content)
      expect(enhancer.getProviderSuccessCounts()['cerebras']).toBe(0)
    }
  })

  it('reports a provider failure instead of an empty continuation', async () => {
    sdk.failure = 'Provider unavailable during auto_extension'
    const result = await enhancer.continueVideo(null, { lockedSegments: ['A protagonist reaches a river'], segmentDurationSec: 15 })
    expect([result.prompt, result.fallbackUsed]).toEqual(['', true])
    expect(result.error).toContain('Provider unavailable during auto_extension')
    expect(enhancer.getProviderSuccessCounts()['cerebras']).toBe(0)
  })

  it.each([
    ['expandClip', () => enhancer.expandClip('A moonbase', { segmentDurationSec: 5 }), '{"prompt":"A detailed moonbase"}'],
    ['continueVideo', () => enhancer.continueVideo(null, { segmentDurationSec: 5, lockedSegments: ['A moonbase'] }), '{"next_prompt":"A door opens"}'],
    ['rewriteRollout', () => enhancer.rewriteRollout([], { segmentCount: 6, segmentDurationSec: 5, rewriteInstruction: 'A moonbase' }),
      '{"segment_prompts":["A","B","C","D","E","F"]}'],
  ] as const)('%s preserves a configured budget above the Ref2VA floor', async (_name, run, reply) => {
    enhancer.settings.maxCompletionTokens = 16384
    sdk.content = reply
    const result = await run()
    expect(result.fallbackUsed).toBe(false)
    expect(sdk.requests[0]?.['max_completion_tokens']).toBe(16384)
  })

  it('sends the request defaults and keeps shared success counts', async () => {
    expect(enhancer.rewriteModel()).toBe('gpt-test')
    sdk.content = '{"prompt":"Detailed clip"}'
    expect((await enhancer.expandClip('A moonbase', { segmentDurationSec: 5 })).fallbackUsed).toBe(false)
    expect(sdk.requests.at(-1)?.['temperature']).toBe(0.4)
    sdk.content = '{"segment_prompts":["A","B"]}'
    const result = await enhancer.rewriteRollout(['one', 'two'], { segmentCount: 6, segmentDurationSec: 5 })
    expect([result.fallbackUsed, result.model]).toEqual([false, 'gpt-test'])
    expect(sdk.requests.at(-1)?.['model']).toBe('vendor-model')
    expect(sdk.requests.at(-1)?.['temperature']).toBe(0.4)
    expect(systemPrompt(sdk.requests.at(-1))).toBe('rewrite template')
    expect(enhancer.getProviderSuccessCounts()).toEqual({ cerebras: 2, groq: 0 })
  })
})

describe('PromptEnhancer rollout sources and templates', () => {
  it.each([null, [], ['  ', null, 7], 'invalid window', { prompt: 'one' }])('uses stored prompts for browser window %j', async (window) => {
    sdk.content = '{"segment_prompts":["A","B"]}'
    const result = await enhancer.rewriteRollout([' stored one ', 'stored two'], {
      segmentCount: 6, segmentDurationSec: 5, promptsToRewrite: window, rewriteInstruction: 'Make it cinematic',
    })
    expect([result.fallbackUsed, result.sourcePrompts, result.prompts]).toEqual([false, ['stored one', 'stored two'], ['A', 'B']])
    expect(systemPrompt(sdk.requests[0])).toBe('rewrite template')
    const payload = userPayload(sdk.requests[0])
    expect(payload['mode']).toBe('edit_existing_rollout')
    expect((payload['current_rollout'] as Record<string, unknown>)['segment_prompts']).toEqual(result.sourcePrompts)
    expect(payload['user_instruction']).toBe('Make it cinematic')
  })

  it.each([1, 3, 6, 7])('preserves %i source prompts after continuation', async (sourceCount) => {
    const sourcePrompts = Array.from({ length: sourceCount }, (_, index) => `Source segment ${index + 1}`)
    const rewritten = Array.from({ length: sourceCount }, (_, index) => `Rewritten segment ${index + 1}`)
    sdk.content = JSON.stringify({ segment_prompts: rewritten })
    const result = await enhancer.rewriteRollout(sourcePrompts, { segmentCount: 3, segmentDurationSec: 5, rewriteInstruction: 'Make the lighting warmer' })
    expect([result.fallbackUsed, result.prompts, result.sourcePrompts]).toEqual([false, rewritten, sourcePrompts])
    const payload = userPayload(sdk.requests[0])
    expect([payload['desired_segment_count'], payload['segment_duration_sec']]).toEqual([sourceCount, 5])
    expect((payload['current_rollout'] as Record<string, unknown>)['segment_prompts']).toEqual(sourcePrompts)
  })

  it('prefers the cleaned browser window without mutating it', async () => {
    sdk.content = '{"segment_prompts":["A","B"]}'
    const window = [' browser one ', '', null, 7, 'browser two']
    const result = await enhancer.rewriteRollout(['stored one', 'stored two', 'stored three'], {
      segmentCount: 6, segmentDurationSec: 5, promptsToRewrite: window, rewriteInstruction: 'cinematic',
    })
    expect([result.fallbackUsed, result.sourcePrompts]).toEqual([false, ['browser one', 'browser two']])
    expect(systemPrompt(sdk.requests[0])).toBe('rewrite template')
    expect(window).toEqual([' browser one ', '', null, 7, 'browser two'])
  })

  it.each([1, 3, 6])('selects the creation template for an empty source and %i segments', async (segmentCount) => {
    const prompts = Array.from({ length: segmentCount }, (_, index) => `Generated segment ${index + 1}`)
    sdk.content = JSON.stringify({ segment_prompts: prompts })
    const result = await enhancer.rewriteRollout([], {
      segmentCount, segmentDurationSec: 5, promptsToRewrite: [' ', null, 7], rewriteInstruction: 'A moonbase thriller',
    })
    expect([result.fallbackUsed, result.sourcePrompts, result.prompts]).toEqual([false, [], prompts])
    expect(systemPrompt(sdk.requests[0])).toBe('initial rollout template')
    const payload = userPayload(sdk.requests[0])
    expect([payload['mode'], payload['desired_segment_count'], payload['segment_duration_sec']]).toEqual(['new_rollout', segmentCount, 5])
  })

  it.each([[[]], [['An opening shot']]])('uses the Ref2VA template for source %j', async (prompts) => {
    for (const referenceLabels of [[], ['Picture 1']]) {
      for (const segmentCount of [1, 3, 6]) {
        sdk.requests = []
        const expected = prompts.length > 0 ? ['A'] : Array.from({ length: segmentCount }, (_, index) => `Generated segment ${index + 1}`)
        sdk.content = JSON.stringify({ segment_prompts: expected })
        const result = await enhancer.rewriteRollout(prompts, {
          segmentCount, segmentDurationSec: 5, generationMode: 'ref2va', referenceLabels, rewriteInstruction: 'Visit the harbor',
        })
        expect([result.fallbackUsed, result.prompts, result.sourcePrompts]).toEqual([false, expected, prompts])
        expect(systemPrompt(sdk.requests[0])).toBe('reference shot template')
        expect(userPayload(sdk.requests[0])['desired_segment_count']).toBe(expected.length)
      }
    }
  })
})
