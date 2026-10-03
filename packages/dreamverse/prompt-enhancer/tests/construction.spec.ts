/** Verify service construction from Config, plugin lifecycle, and per-instance captured choices. */
import fs from 'node:fs'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DreamversePromptEnhancer, { Config, PromptRuntimeError } from '../src/index.ts'
import type { JsonObject } from '../src/utils/python-text.ts'
import { requestBodyText, temporaryDirectory, templatePathOptions, type TemporaryDirectory } from './support.ts'

interface CapturedRequest {
  url: string
  body: JsonObject
}

let temporary: TemporaryDirectory
let tmp: string
let captured: CapturedRequest[]

beforeEach(() => {
  temporary = temporaryDirectory()
  tmp = temporary.directory
  captured = []
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    captured.push({ url, body: JSON.parse(requestBodyText(init)) as JsonObject })
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"prompt":"Detailed river"}' } }] })))
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  temporary.cleanup()
})

/**
 * Build a validated configuration with synthetic keys and test template paths.
 * @param overrides - raw Config fields to replace.
 * @returns the configuration after schema validation and defaults.
 */
function config(overrides: Record<string, unknown> = {}): ReturnType<typeof Config> {
  const raw: Record<string, unknown> = {
    cerebrasApiKey: 'test-cerebras-construction', groqApiKey: 'test-groq-construction', timeoutMs: 20000, ...templatePathOptions(tmp),
    ...overrides,
  }
  return Config(raw)
}

describe('Config', () => {
  it('applies the reference defaults and keeps a blank Groq URL', () => {
    expect(Config({ timeoutMs: 20000 })).toMatchObject({
      groqApiBaseUrl: 'https://api.groq.com/openai/v1',
      cerebrasBaseUrl: 'https://api.cerebras.ai',
    })
    expect(Config({ timeoutMs: 20000, groqApiBaseUrl: '' }).groqApiBaseUrl).toBe('')
  })

  it('requires a positive operation deadline', () => {
    expect(() => Config({})).toThrow()
    expect(() => Config({ timeoutMs: 0 })).toThrow()
  })
})

describe('DreamversePromptEnhancer', () => {
  it('provides the service while mounted and removes it on dispose', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(DreamversePromptEnhancer, config())
    expect(ctx.get('dreamversePromptEnhancer')).toBeInstanceOf(DreamversePromptEnhancer)
    const result = await ctx.dreamversePromptEnhancer.expandClip('A river', { segmentDurationSec: 5 })
    expect([result.prompt, result.fallbackUsed, result.error]).toEqual(['Detailed river', false, null])
    await fiber.dispose()
    expect(ctx.get('dreamversePromptEnhancer')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it.each([
    [{}, 'gpt-oss-120b', { cerebras: 'gpt-oss-120b', groq: 'openai/gpt-oss-120b' }],
    [{ model: '  second-logical-model \n', cerebrasModel: '  cerebras/second \n', groqModel: '  groq/second \n' }, 'second-logical-model',
      { cerebras: 'cerebras/second', groq: 'groq/second' }],
  ])('captures the logical model and vendor aliases %j', async (overrides, logicalModel, aliases) => {
    const service = new DreamversePromptEnhancer(new Context(), config(overrides))
    expect(service.rewriteModel()).toBe(logicalModel)
    const result = await service.expandClip('A river', { segmentDurationSec: 5 })
    expect([result.prompt, result.model, result.fallbackUsed]).toEqual(['Detailed river', logicalModel, false])
    const provider = result.provider as 'cerebras' | 'groq'
    const winning = captured.find(request => request.url.includes(provider === 'cerebras' ? 'cerebras' : 'groq'))
    expect(winning?.body['model']).toBe(aliases[provider])
    expect((winning?.body['messages'] as { content: string }[])[0]?.content).toBe('clip and auto template')
    expect(service.getProviderSuccessCounts()).toEqual({ cerebras: Number(provider === 'cerebras'), groq: Number(provider === 'groq') })
  })

  it('sends each provider to its configured endpoint with its key', async () => {
    const service = new DreamversePromptEnhancer(new Context(), config({
      groqApiBaseUrl: 'https://first.groq.example.test/openai/v1', cerebrasBaseUrl: 'https://first.cerebras.example.test',
    }))
    const headers: Record<string, string>[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      captured.push({ url, body: JSON.parse(requestBodyText(init)) as JsonObject })
      headers.push(init.headers as Record<string, string>)
      return new Promise<Response>((_resolve, reject) => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- like fetch, reject with the exact abort reason.
        init.signal?.addEventListener('abort', () => { reject(init.signal?.reason) })
      })
    }))
    const controller = new AbortController()
    const pending = service.expandClip('A river', { segmentDurationSec: 5, signal: controller.signal })
    await vi.waitFor(() => { expect(captured).toHaveLength(2) })
    controller.abort(new Error('test finished'))
    await expect(pending).rejects.toThrow('test finished')
    expect(captured.map(request => request.url).sort()).toEqual([
      'https://first.cerebras.example.test/v1/chat/completions', 'https://first.groq.example.test/openai/v1/chat/completions',
    ])
    expect(headers.map(header => header['Authorization']).sort()).toEqual([
      'Bearer test-cerebras-construction', 'Bearer test-groq-construction',
    ])
  })

  it('reports a template failure before missing credentials', () => {
    const missingKeys = config({ cerebrasApiKey: undefined, groqApiKey: undefined })
    fs.rmSync(path.join(tmp, 'enhance.md'))
    const construct = () => new DreamversePromptEnhancer(new Context(), missingKeys)
    expect(construct).toThrow(PromptRuntimeError)
    expect(construct).toThrow('next-segment system prompt file not found')
  })

  it.each([['cerebrasApiKey', 'CEREBRAS_API_KEY'], ['groqApiKey', 'GROQ_API_KEY']])('fails plugin start without %s', (field, variable) => {
    for (const value of [undefined, '', ' \t\n ']) {
      expect(() => new DreamversePromptEnhancer(new Context(), config({ [field]: value })))
        .toThrow(new PromptRuntimeError(`Missing required environment variable: one of ${variable}`))
    }
  })

  it('keeps each service\'s template files when another is constructed', async () => {
    const names = ['first', 'second']
    const services = names.map((name) => {
      const directory = path.join(tmp, name)
      fs.mkdirSync(directory)
      const filePath = path.join(directory, 'auto_extension_system_prompt.md')
      fs.writeFileSync(filePath, `${name} auto_extension_system_prompt\n`)
      return new DreamversePromptEnhancer(new Context(), config({ autoSystemPromptPath: `  ${filePath} \n` }))
    })
    for (const [index, name] of names.entries()) {
      captured = []
      await services[index]?.expandClip('A river', { segmentDurationSec: 5 })
      const systemPrompts = captured.map(request => (request.body['messages'] as { content: string }[])[0]?.content)
      expect(systemPrompts.length).toBeGreaterThan(0)
      for (const systemPrompt of systemPrompts) expect(systemPrompt).toBe(`${name} auto_extension_system_prompt`)
    }
  })

  it('routes diagnostics through the plugin logger without format substitution', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '100%s done' } }] })))))
    const ctx = new Context()
    const messages: unknown[][] = []
    // Cordis exports WARN (level 2) only to exporters whose level is at least 2.
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { messages.push(message.args) } })
    const fiber = await ctx.plugin(DreamversePromptEnhancer, config())
    const result = await ctx.dreamversePromptEnhancer.expandClip('A river', { segmentDurationSec: 5 })
    expect(result.fallbackUsed).toBe(true)
    expect(messages).toContainEqual(['%s', expect.stringContaining('assistant_response=100%s done')])
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
