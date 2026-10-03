/**
 * Replay reference-recorded fixtures through the TypeScript `PromptEnhancer`.
 *
 * `fixtures/generate_fixtures.py` ran every fixture through the Python reference with the packaged templates and a
 * scripted vendor. Each replay must send identical request fields and return identical result fields. A request that
 * the reference recorded with a template key carries the packaged template text, because the packaged H3 Ref2VA
 * template differs from the reference template.
 */
import fs from 'node:fs'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { PromptResult } from '../src/features/index.ts'
import type { RolloutResult } from '../src/features/rollout.ts'
import { VendorClient, buildEndpoint, type ChatRequest, type VendorReply } from '../src/llm/client.ts'
import { ProviderRace } from '../src/llm/race.ts'
import { PromptEnhancer } from '../src/prompt-enhancer.ts'
import { PromptSettings } from '../src/settings.ts'
import { PromptTemplates } from '../src/templates/loader.ts'
import { PromptValueError } from '../src/utils/errors.ts'
import { dumpsJson, type JsonObject } from '../src/utils/python-text.ts'
import { FakeVendor, recordingDiagnostics, requestBodyText, testRace } from './support.ts'

/** Snake_case inputs recorded by the generator; the positional argument is included by name. */
interface FixtureArgs {
  conditioning_prompt?: string | null
  prompts?: unknown[]
  segment_duration_sec: number
  segment_count?: number
  locked_segments?: unknown[] | null
  next_segment_idx?: number | null
  prompts_to_rewrite?: unknown
  preset_id?: string | null
  preset_label?: string | null
  rewrite_instruction?: string | null
  generation_mode?: string
  reference_labels?: string[]
}

interface RecordedRequest {
  system_prompt?: string
  system_prompt_template?: string
  user_content: string
  model: string
  default_model: string
  temperature: number
  max_completion_tokens: number
}

interface Fixture {
  name: string
  operation: 'expand_clip' | 'continue_video' | 'rewrite_rollout'
  settings: {
    rewrite_default_model: string
    temperature: number
    rewrite_default_temperature: number
    max_completion_tokens: number
  }
  args: FixtureArgs
  reply: { text: string; raw_response: JsonObject } | null
  requests: RecordedRequest[]
  result: Record<string, unknown> | null
  raises: { type: string; message: string } | null
  provider_success_counts: Record<string, number>
}

/** One scripted HTTP response of an SDK fixture. */
interface ScriptedResponse {
  status: number
  headers: Record<string, string>
  body: string
  delay_ms?: number
}

/** One HTTP request that reached the reference stub server. */
interface RecordedHttpRequest {
  path: string
  authorization: string | null
  raw_body: string
}

/** One request sent through the reference `VendorClient` and a real vendor SDK. */
interface SdkFixture {
  name: string
  provider: 'cerebras' | 'groq'
  scenario: string
  /** Responses in request order; `null` means the connection is refused. */
  responses: ScriptedResponse[] | null
  requests: RecordedHttpRequest[]
  text?: string
  /** `json.dumps(reply.raw_response, ensure_ascii=False)` of the SDK model dump. */
  raw_response_json?: string
  error?: string
  /** Lines the reference printed while reading the reply. */
  diagnostics: string[]
}

/** One `rewrite_rollout` call through the reference enhancer with both real SDK clients. */
interface RaceFixture {
  name: string
  args: FixtureArgs & { prompts: string[]; segment_count: number }
  scenarios: Record<'cerebras' | 'groq', string>
  requests: Record<'cerebras' | 'groq', RecordedHttpRequest[]>
  result: Record<string, unknown>
  provider_success_counts: Record<string, number>
}

interface FixtureFile {
  system_prompts: Record<string, string>
  fixtures: Fixture[]
  sdk_request: RecordedRequest & { system_prompt: string }
  sdk_fixtures: SdkFixture[]
  /** Scripted responses by scenario name for the SDK and race fixtures; `null` refuses the connection. */
  sdk_scenarios: Record<string, ScriptedResponse[] | null>
  race_fixtures: RaceFixture[]
}

const fixtureFile = JSON.parse(fs.readFileSync(new URL('./fixtures/fixtures.json', import.meta.url), 'utf8')) as FixtureFile
const templates = new PromptTemplates({})

/** Map the reference template attribute names to the loaded TypeScript templates. */
const loadedTemplates: Record<string, string> = {
  auto_system_prompt: templates.autoSystemPrompt,
  enhance_system_prompt: templates.enhanceSystemPrompt,
  rewrite_all_system_prompt: templates.rewriteAllSystemPrompt,
  rewrite_user_system_prompt: templates.rewriteUserSystemPrompt,
  ref2va_system_prompt: templates.ref2vaSystemPrompt,
}

/**
 * Apply one fixture's request defaults to fresh settings.
 * @param values - the recorded settings.
 * @returns the settings.
 */
function fixtureSettings(values: Fixture['settings']): PromptSettings {
  const settings = new PromptSettings(undefined)
  settings.rewriteDefaultModel = values.rewrite_default_model
  settings.temperature = values.temperature
  settings.rewriteDefaultTemperature = values.rewrite_default_temperature
  settings.maxCompletionTokens = values.max_completion_tokens
  return settings
}

/**
 * Call the TypeScript operation that corresponds to the recorded Python call.
 * @param enhancer - the enhancer under test.
 * @param fixture - the recorded call.
 * @returns the operation result.
 */
async function runOperation(enhancer: PromptEnhancer, fixture: Fixture): Promise<PromptResult | RolloutResult> {
  const args = fixture.args
  const common = {
    segmentDurationSec: args.segment_duration_sec,
    generationMode: args.generation_mode,
    referenceLabels: args.reference_labels,
  }
  switch (fixture.operation) {
    case 'expand_clip':
      return await enhancer.expandClip(args.conditioning_prompt ?? null, common)
    case 'continue_video':
      return await enhancer.continueVideo(args.conditioning_prompt ?? null, {
        ...common, lockedSegments: args.locked_segments, nextSegmentIdx: args.next_segment_idx,
      })
    case 'rewrite_rollout':
      return await enhancer.rewriteRollout(args.prompts ?? [], {
        ...common,
        segmentCount: args.segment_count ?? 0,
        promptsToRewrite: args.prompts_to_rewrite,
        presetId: args.preset_id,
        presetLabel: args.preset_label,
        rewriteInstruction: args.rewrite_instruction,
      })
  }
}

/**
 * Express a TypeScript result with the reference field names, excluding latency.
 * @param result - the operation result.
 * @returns the snake_case result fields.
 */
function snakeCaseResult(result: PromptResult | RolloutResult): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result)
    .filter(([key]) => key !== 'latencyMs')
    .map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]))
}

describe('reference prompt fixtures', () => {
  it('loads the same packaged template text as the reference, except the H3 Ref2VA template', () => {
    expect({ ...loadedTemplates, ref2va_system_prompt: null }).toEqual({ ...fixtureFile.system_prompts, ref2va_system_prompt: null })
  })

  it('covers all three operations and every generation mode', () => {
    expect(fixtureFile.fixtures.length).toBeGreaterThanOrEqual(170)
    expect(new Set(fixtureFile.fixtures.map(fixture => fixture.operation)))
      .toEqual(new Set(['expand_clip', 'continue_video', 'rewrite_rollout']))
    expect(new Set(fixtureFile.fixtures.map(fixture => fixture.args.generation_mode ?? 't2va')))
      .toEqual(new Set(['t2va', 'i2v', 'ref2va', 'unsupported-mode', 'bogus', 'unsupported']))
  })

  it.each(fixtureFile.fixtures.map(fixture => [fixture.name, fixture] as const))('%s', async (_name, fixture) => {
    const reply: VendorReply | null = fixture.reply === null
      ? null
      : { text: fixture.reply.text, rawResponse: fixture.reply.raw_response }
    const vendor = new FakeVendor('cerebras', () => {
      if (reply === null) return Promise.reject(new Error('No scripted reply'))
      return Promise.resolve(reply)
    })
    const enhancer = new PromptEnhancer(fixtureSettings(fixture.settings), templates, testRace([[vendor]]))

    if (fixture.raises !== null) {
      const failure = runOperation(enhancer, fixture)
      await expect(failure).rejects.toBeInstanceOf(PromptValueError)
      await expect(failure).rejects.toThrow(fixture.raises.message)
    } else {
      const result = await runOperation(enhancer, fixture)
      expect(snakeCaseResult(result)).toEqual(fixture.result)
    }

    expect(vendor.requests.map(request => ({
      systemPrompt: request.systemPrompt,
      user_content: request.userContent,
      model: request.model,
      default_model: request.defaultModel,
      temperature: request.temperature,
      max_completion_tokens: request.maxCompletionTokens,
    }))).toEqual(fixture.requests.map(({ system_prompt: systemPrompt, system_prompt_template: templateKey, ...fields }) => ({
      systemPrompt: templateKey === undefined ? systemPrompt : loadedTemplates[templateKey],
      ...fields,
    })))
    expect(enhancer.getProviderSuccessCounts()).toEqual(fixture.provider_success_counts)
  })
})

/** HTTP requests received per `<provider>/<scenario>` key, like the reference stub server records them. */
const recordedRequests = new Map<string, RecordedHttpRequest[]>()
/** `fetch` calls per key, including refused connections that no server observes. */
const fetchAttempts = new Map<string, number>()

// Answer each `/<provider>/<scenario>/...` request from its scenario script, like the reference stub server.
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    const { pathname } = new URL(url)
    const [provider = '', scenario = ''] = pathname.split('/').slice(1, 3)
    const key = `${provider}/${scenario}`
    const script = fixtureFile.sdk_scenarios[scenario]
    fetchAttempts.set(key, (fetchAttempts.get(key) ?? 0) + 1)
    if (script === null || script === undefined) {
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18401'), { code: 'ECONNREFUSED' })
      return Promise.reject(new TypeError('fetch failed', { cause }))
    }
    const requests = recordedRequests.get(key) ?? []
    recordedRequests.set(key, requests)
    requests.push({ path: pathname, authorization: new Headers(init.headers).get('authorization'), raw_body: requestBodyText(init) })
    const response = script[Math.min(requests.length, script.length) - 1]
    const reply = new Response(response?.body ?? '', { status: response?.status ?? 500, headers: response?.headers ?? {} })
    return new Promise((resolve) => { setTimeout(() => { resolve(reply) }, response?.delay_ms ?? 0) })
  }))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

/** The reference enhancer's base URL for one provider and scenario on the stub server. */
function stubBaseUrl(provider: string, scenario: string): string {
  return `http://127.0.0.1:18400/${provider}/${scenario}`
}

describe('reference SDK fixtures', () => {
  it('covers retries, status errors, connection failures, and successful replies for both SDKs', () => {
    const providers = new Set(fixtureFile.sdk_fixtures.map(fixture => fixture.provider))
    expect(providers).toEqual(new Set(['cerebras', 'groq']))
    expect(fixtureFile.sdk_fixtures.find(fixture => fixture.name === 'sdk/cerebras/status-500-json')?.requests).toHaveLength(3)
  })

  it.concurrent.each(fixtureFile.sdk_fixtures.map(fixture => [fixture.name, fixture] as const))('%s', async (_name, fixture) => {
    const key = `${fixture.provider}/${fixture.scenario}`
    const sdkRequest = fixtureFile.sdk_request
    const request: ChatRequest = {
      systemPrompt: sdkRequest.system_prompt,
      userContent: sdkRequest.user_content,
      model: sdkRequest.model,
      defaultModel: sdkRequest.default_model,
      temperature: sdkRequest.temperature,
      maxCompletionTokens: sdkRequest.max_completion_tokens,
    }
    const endpoint = buildEndpoint({ provider: fixture.provider, apiKey: 'test-key', apiBaseUrl: stubBaseUrl(fixture.provider, fixture.scenario) })
    const diagnostics = recordingDiagnostics()
    const vendor = new VendorClient(fixture.provider, 'vendor-model', endpoint, diagnostics)
    let outcome: { text: string; raw_response_json: string } | { error: string }
    try {
      const reply = await vendor.complete(request)
      outcome = { text: reply.text, raw_response_json: dumpsJson(reply.rawResponse) }
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) }
    }
    expect(outcome).toEqual(fixture.text === undefined
      ? { error: fixture.error }
      : { text: fixture.text, raw_response_json: fixture.raw_response_json })
    expect(diagnostics.lines).toEqual(fixture.diagnostics)
    expect(recordedRequests.get(key) ?? []).toEqual(fixture.requests)
    // The SDKs retry refused connections too; the reference server cannot observe those attempts.
    if (fixture.responses === null) expect(fetchAttempts.get(key)).toBe(3)
  })
})

describe('reference race fixtures', () => {
  it.each(fixtureFile.race_fixtures.map(fixture => [fixture.name, fixture] as const))('%s', async (_name, fixture) => {
    const providers = ['cerebras', 'groq'] as const
    for (const provider of providers) recordedRequests.delete(`${provider}/${fixture.scenarios[provider]}`)
    const settings = new PromptSettings(undefined)
    const diagnostics = recordingDiagnostics()
    const vendors = providers.map(provider => new VendorClient(
      provider,
      provider === 'cerebras' ? settings.rewriteDefaultModel : `openai/${settings.rewriteDefaultModel}`,
      buildEndpoint({ provider, apiKey: 'test-key', apiBaseUrl: stubBaseUrl(provider, fixture.scenarios[provider]) }),
      diagnostics,
    ))
    const enhancer = new PromptEnhancer(settings, templates, ProviderRace.fromConfig(vendors, 20000, diagnostics))
    const {
      prompts, segment_count: segmentCount, segment_duration_sec: segmentDurationSec, rewrite_instruction: rewriteInstruction,
    } = fixture.args
    const result = await enhancer.rewriteRollout(prompts, { segmentCount, segmentDurationSec, rewriteInstruction })
    expect(snakeCaseResult(result)).toEqual(fixture.result)
    for (const provider of providers) {
      expect(recordedRequests.get(`${provider}/${fixture.scenarios[provider]}`) ?? []).toEqual(fixture.requests[provider])
    }
    expect(enhancer.getProviderSuccessCounts()).toEqual(fixture.provider_success_counts)
  })
})
