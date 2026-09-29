/** Verify vendor construction, request bodies, endpoints, failure messages, and response reading. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CEREBRAS_SDK_RETRY_POLICY, DEFAULT_GROQ_API_BASE_URL, OPENAI_SDK_RETRY_POLICY, VendorClient, buildEndpoint,
  createVendorClients, extractContentOrEmpty, retryDelaySeconds, type ChatRequest, type VendorSettings,
} from '../src/llm/client.ts'
import { PromptRuntimeError } from '../src/utils/errors.ts'
import type { JsonObject } from '../src/utils/python-text.ts'
import { recordingDiagnostics } from './support.ts'

const CHAT_REQUEST: ChatRequest = {
  systemPrompt: 'system instructions',
  userContent: '{"idea":"a film"}',
  model: 'default-model',
  defaultModel: 'default-model',
  temperature: 0.4,
  maxCompletionTokens: 512,
}

interface CapturedRequest {
  url: string
  init: RequestInit
}

/**
 * Replace `fetch` with a stub that records each request and answers with one response.
 * @param respond - builds the response for a captured request.
 * @returns the captured requests.
 */
function stubFetch(respond: (request: CapturedRequest) => Promise<Response> | Response): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const request = { url, init }
    captured.push(request)
    return await respond(request)
  }))
  return captured
}

/** Build a JSON response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Settings with synthetic credentials, aliases, and base URLs. */
function vendorSettings(overrides: Partial<VendorSettings> = {}): VendorSettings {
  return {
    cerebrasApiKey: '  test-cerebras-first \n',
    groqApiKey: '\t test-groq-first  ',
    cerebrasModel: 'cerebras-fixture-model',
    groqModel: 'groq-fixture-model',
    groqApiBaseUrl: 'https://groq.example.test/openai/v1',
    cerebrasBaseUrl: 'https://cerebras.example.test',
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('buildEndpoint', () => {
  it.each([
    ['cerebras', 'https://api.cerebras.ai', 'https://api.cerebras.ai/v1/chat/completions'],
    ['cerebras', 'https://cerebras.example.test/base/', 'https://cerebras.example.test/base/v1/chat/completions'],
    ['groq', 'https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
    ['groq', null, 'https://api.openai.com/v1/chat/completions'],
  ])('uses the %s SDK path under %j', (provider, apiBaseUrl, url) => {
    expect(buildEndpoint({ provider, apiKey: 'test-key', apiBaseUrl })).toEqual({ url, apiKey: 'test-key' })
  })

  it('rejects an unknown provider', () => {
    expect(() => buildEndpoint({ provider: 'unsupported', apiKey: 'k', apiBaseUrl: null }))
      .toThrow('Unsupported prompt provider: unsupported')
  })
})

describe('VendorClient.complete', () => {
  it.each(['cerebras', 'groq'])('maps the default model alias and sends the reference body for %s', async (provider) => {
    for (const selectedModel of ['default-model', 'selected-model', '  ']) {
      for (const maxCompletionTokens of [512, 8192, 16384]) {
        const rawResponse = { choices: [{ message: { content: 'assistant text' } }] }
        const captured = stubFetch(() => jsonResponse(rawResponse))
        const vendor = new VendorClient(provider, `${provider}/default`, { url: 'https://vendor.test/chat', apiKey: 'key-1' },
          recordingDiagnostics())
        const reply = await vendor.complete({ ...CHAT_REQUEST, model: selectedModel, maxCompletionTokens })
        const expectedModel = selectedModel === 'selected-model' ? selectedModel : vendor.requestModel
        // Byte-identical to the body both SDKs send: compact JSON in SDK key order.
        expect(captured[0]?.init.body).toBe('{"messages":[{"role":"system","content":"system instructions"},'
          + `{"role":"user","content":"{\\"idea\\":\\"a film\\"}"}],"model":"${expectedModel}",`
          + `"max_completion_tokens":${maxCompletionTokens},"temperature":0.4}`)
        expect(captured[0]?.url).toBe('https://vendor.test/chat')
        expect(captured[0]?.init.method).toBe('POST')
        expect(captured[0]?.init.headers).toMatchObject({ 'Authorization': 'Bearer key-1', 'Content-Type': 'application/json' })
        expect(reply.text).toBe('assistant text')
        // The raw response is the SDK model dump: every declared top-level field in the SDK model's order.
        expect(Object.keys(reply.rawResponse)).toEqual(provider === 'groq'
          ? ['id', 'choices', 'created', 'model', 'object', 'metadata', 'moderation', 'service_tier', 'system_fingerprint', 'usage']
          : ['id', 'choices', 'created', 'model', 'object', 'system_fingerprint', 'service_tier', 'time_info', 'usage'])
      }
    }
  })

  it('rejects an unknown provider before sending a request', async () => {
    const captured = stubFetch(() => jsonResponse({}))
    const vendor = new VendorClient('unsupported', 'default-model', { url: 'https://vendor.test', apiKey: 'k' }, recordingDiagnostics())
    await expect(vendor.complete(CHAT_REQUEST)).rejects.toThrow('Unsupported prompt provider: unsupported')
    expect(captured).toEqual([])
  })

  it.each([
    ['plain text', 'plain text'],
    [[{ text: 'one ' }, { text: { value: 'two ' } }, { output_text: 'three' }, 'ignored'], 'one two three'],
    [[], ''],
  ])('reads assistant content %j from the SDK model dump', async (content, expected) => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] }))
    const vendor = new VendorClient('cerebras', 'default-model', { url: 'https://vendor.test', apiKey: 'k' }, recordingDiagnostics())
    const reply = await vendor.complete(CHAT_REQUEST)
    expect(reply.text).toBe(expected)
    expect(reply.rawResponse['choices']).toEqual([{
      index: null, message: { role: null, content, reasoning: null, tool_calls: null }, finish_reason: 'stop', logprobs: null,
      reasoning_logprobs: null,
    }])
  })

  // Messages recorded from the Python SDK error paths (`APIStatusError`, `APIConnectionError`).
  it.each([
    [429, '{"error": {"message": "Rate limited", "type": "rate_limit", "code": null, "retry": true}}',
      'Error code: 429 - {\'error\': {\'message\': \'Rate limited\', \'type\': \'rate_limit\', \'code\': None, \'retry\': True}}'],
    [400, '"oops"', 'Error code: 400 - oops'],
    [502, '  bad gateway \n', 'bad gateway'],
    [500, '', 'Error code: 500'],
  ])('reports HTTP %i like the SDKs after their retries', async (status, body, message) => {
    const captured = stubFetch(() => new Response(body, { status, headers: { 'retry-after-ms': '1' } }))
    const vendor = new VendorClient('groq', 'm', { url: 'https://vendor.test', apiKey: 'k' }, recordingDiagnostics())
    await expect(vendor.complete(CHAT_REQUEST)).rejects.toThrow(message)
    expect(captured).toHaveLength(status === 400 ? 1 : 3)
  })

  it('retries a network failure twice, then reports a connection error', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const captured = stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    const vendor = new VendorClient('groq', 'm', { url: 'https://vendor.test', apiKey: 'k' }, recordingDiagnostics())
    await expect(vendor.complete(CHAT_REQUEST)).rejects.toThrow('Connection error.')
    expect(captured).toHaveLength(3)
  })

  it('reports a transport timeout as a timed-out request', async () => {
    const cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    stubFetch(() => Promise.reject(new TypeError('fetch failed', { cause })))
    const vendor = new VendorClient('cerebras', 'm', { url: 'https://vendor.test', apiKey: 'k' }, recordingDiagnostics())
    await expect(vendor.complete(CHAT_REQUEST)).rejects.toThrow('Request timed out.')
  })

  it('stops retrying when the request is aborted during the retry wait', async () => {
    const captured = stubFetch(() => new Response('busy', { status: 503 }))
    const vendor = new VendorClient('groq', 'm', { url: 'https://vendor.test', apiKey: 'k' }, recordingDiagnostics())
    const controller = new AbortController()
    const pending = vendor.complete(CHAT_REQUEST, controller.signal)
    await vi.waitFor(() => { expect(captured).toHaveLength(1) })
    const reason = new Error('race finished')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(captured).toHaveLength(1)
  })

  it('rejects with the abort reason when the race aborts the request', async () => {
    stubFetch(({ init }) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    }))
    const vendor = new VendorClient('groq', 'm', { url: 'https://vendor.test', apiKey: 'k' }, recordingDiagnostics())
    const controller = new AbortController()
    const pending = vendor.complete(CHAT_REQUEST, controller.signal)
    const reason = new Error('stage finished')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})

describe('extractContentOrEmpty', () => {
  // Warning lines recorded from the Python `_extract_content_or_empty`.
  it.each([
    [{ choices: [{ finish_reason: 'length', message: { content: null, refusal: null } }], usage: { completion_tokens: 5 } },
      '[ENHANCE][WARN] Failed to extract assistant content: Missing assistant content in chat completion response. '
      + 'finish_reason=\'length\', refusal=None; finish_reason=\'length\'; usage={\'completion_tokens\': 5}; '
      + 'message_keys=[\'content\', \'refusal\']'],
    [{ choices: [{ message: null }] },
      '[ENHANCE][WARN] Failed to extract assistant content: \'NoneType\' object has no attribute \'get\'; '
      + 'finish_reason=None; usage=None; message_keys=n/a'],
    [{ choices: [] },
      '[ENHANCE][WARN] Failed to extract assistant content: Missing choices in chat completion response.; '
      + 'finish_reason=None; usage=None; message_keys=[]'],
    [{ choices: [{ message: { content: [{ type: 'image' }] } }] },
      '[ENHANCE][WARN] Failed to extract assistant content: Missing assistant content in chat completion response. '
      + 'finish_reason=None, refusal=None; finish_reason=None; usage=None; message_keys=[\'content\']'],
  ])('returns empty text and warns for %j', (response, line) => {
    const diagnostics = recordingDiagnostics()
    expect(extractContentOrEmpty(response as JsonObject, diagnostics)).toBe('')
    expect(diagnostics.lines).toEqual([line])
  })

  it('raises the reference AttributeError text for a non-object choice', () => {
    expect(() => extractContentOrEmpty({ choices: ['x'] }, recordingDiagnostics())).toThrow('\'str\' object has no attribute \'get\'')
  })
})

describe('createVendorClients', () => {
  it('strips credentials and builds clients in provider order', () => {
    const clients = createVendorClients('logical-fixture', vendorSettings(), recordingDiagnostics())
    expect(clients.map(vendor => vendor.name)).toEqual(['cerebras', 'groq'])
    expect(clients.map(vendor => vendor.requestModel)).toEqual(['cerebras-fixture-model', 'groq-fixture-model'])
    expect(clients.map(vendor => vendor.endpoint)).toEqual([
      { url: 'https://cerebras.example.test/v1/chat/completions', apiKey: 'test-cerebras-first' },
      { url: 'https://groq.example.test/openai/v1/chat/completions', apiKey: 'test-groq-first' },
    ])
  })

  it.each(['cerebrasApiKey', 'groqApiKey'] as const)('rejects a missing %s with the reference message', (field) => {
    const variable = field === 'cerebrasApiKey' ? 'CEREBRAS_API_KEY' : 'GROQ_API_KEY'
    for (const value of [undefined, '', ' \t\n ']) {
      expect(() => createVendorClients('logical-fixture', vendorSettings({ [field]: value }), recordingDiagnostics()))
        .toThrow(new PromptRuntimeError(`Missing required environment variable: one of ${variable}`))
    }
  })

  it('reports the Cerebras key first when both keys are missing', () => {
    expect(() => createVendorClients('m', vendorSettings({ cerebrasApiKey: undefined, groqApiKey: undefined }), recordingDiagnostics()))
      .toThrow('one of CEREBRAS_API_KEY')
  })

  it.each([
    [undefined, undefined, ['logical-fixture', 'openai/logical-fixture']],
    ['', '', ['logical-fixture', 'openai/logical-fixture']],
    [' \t ', '\n ', ['logical-fixture', 'openai/logical-fixture']],
    ['  cerebras/custom \n', '\t groq/custom  ', ['cerebras/custom', 'groq/custom']],
    ['cerebras/custom', undefined, ['cerebras/custom', 'openai/logical-fixture']],
    [undefined, 'groq/custom', ['logical-fixture', 'groq/custom']],
  ])('resolves vendor aliases %j and %j independently', (cerebrasModel, groqModel, expected) => {
    const clients = createVendorClients('logical-fixture', vendorSettings({ cerebrasModel, groqModel }), recordingDiagnostics())
    expect(clients.map(vendor => vendor.requestModel)).toEqual(expected)
  })

  it.each([
    [DEFAULT_GROQ_API_BASE_URL, 'https://api.groq.com/openai/v1/chat/completions'],
    ['', 'https://api.openai.com/v1/chat/completions'],
    [' \t\n ', 'https://api.openai.com/v1/chat/completions'],
    ['  https://groq.example.test/padded \n', 'https://groq.example.test/padded/chat/completions'],
    ['not a URL', 'not a URL/chat/completions'],
  ])('selects the Groq endpoint for base URL %j', (groqApiBaseUrl, url) => {
    const clients = createVendorClients('logical-fixture', vendorSettings({ groqApiBaseUrl }), recordingDiagnostics())
    expect(clients[0]?.endpoint).toEqual({ url: 'https://cerebras.example.test/v1/chat/completions', apiKey: 'test-cerebras-first' })
    expect(clients[1]?.endpoint.url).toBe(url)
  })
})

describe('retryDelaySeconds', () => {
  it('backs off exponentially with up to 25% jitter below the 8-second ceiling', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect([0, 1, 2, 3, 4, 5].map(retries => retryDelaySeconds(retries, null, OPENAI_SDK_RETRY_POLICY))).toEqual([0.5, 1, 2, 4, 8, 8])
    vi.spyOn(Math, 'random').mockReturnValue(1)
    expect(retryDelaySeconds(1, null, CEREBRAS_SDK_RETRY_POLICY)).toBe(0.75)
  })

  it.each([
    [{ 'retry-after-ms': '250' }, 0.25, 0.25],
    [{ 'retry-after-ms': 'soon', 'retry-after': '3' }, 3, 3],
    [{ 'retry-after': '90' }, 90, 0.5],
    [{ 'retry-after': '500' }, 0.5, 0.5],
    [{ 'retry-after': '0' }, 0.5, 0.5],
    [{ 'retry-after': 'nan' }, 0.5, 0.5],
  ])('honors server-directed delay %j within each SDK limit', (headers, openAiDelay, cerebrasDelay) => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(retryDelaySeconds(0, new Headers(headers), OPENAI_SDK_RETRY_POLICY)).toBe(openAiDelay)
    expect(retryDelaySeconds(0, new Headers(headers), CEREBRAS_SDK_RETRY_POLICY)).toBe(cerebrasDelay)
  })

  it('reads an HTTP-date retry-after header', () => {
    const delay = retryDelaySeconds(0, new Headers({ 'retry-after': new Date(Date.now() + 5000).toUTCString() }), OPENAI_SDK_RETRY_POLICY)
    expect(delay).toBeGreaterThan(3)
    expect(delay).toBeLessThanOrEqual(5)
  })
})
