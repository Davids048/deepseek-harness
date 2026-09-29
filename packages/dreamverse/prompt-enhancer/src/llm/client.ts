/**
 * Execute vendor chat-completion requests and read their replies without prompt-feature rules.
 *
 * The reference calls the Cerebras and OpenAI Python SDKs. This port sends the same JSON body with `fetch` to the
 * endpoint each SDK selects, repeats failed requests with each SDK's retry rules, and reproduces the SDK failure
 * messages that reach prompt results.
 *
 * @module @dreamverse/prompt-enhancer/llm/client
 */
import { PROMPT_PROVIDER_PRIORITY } from '../settings.ts'
import { PromptRuntimeError, errorText } from '../utils/errors.ts'
import {
  dictGet, isJsonObject, parsePythonJson, pythonFloatRepr, pythonTypeName, reprPython, stripWhitespace, toPythonFloat,
  type JsonObject, type JsonValue,
} from '../utils/python-text.ts'
import { dumpSdkResponse } from './sdk-response.ts'
import { CEREBRAS_CHAT_COMPLETION, OPENAI_CHAT_COMPLETION } from './sdk-response-models.ts'

/** Groq endpoint used when `FASTVIDEO_PROMPT_GROQ_API_BASE_URL` is absent. */
export const DEFAULT_GROQ_API_BASE_URL = 'https://api.groq.com/openai/v1'
/** Cerebras SDK endpoint used when `CEREBRAS_BASE_URL` is absent. */
export const DEFAULT_CEREBRAS_BASE_URL = 'https://api.cerebras.ai'
/** OpenAI SDK endpoint, which the reference uses for Groq when the Groq base URL is blank. */
const OPENAI_SDK_BASE_URL = 'https://api.openai.com/v1'

/** Receives the reference's `[ENHANCE]` diagnostic lines, which the Python reference prints to stdout. */
export interface PromptDiagnostics {
  /** Record an informational line. */
  info(line: string): void
  /** Record a warning line. */
  warn(line: string): void
}

/** One prompt-feature request before vendor model aliasing. */
export interface ChatRequest {
  readonly systemPrompt: string
  readonly userContent: string
  /** The resolved logical model; the logical default maps to each vendor's alias. */
  readonly model: string
  readonly defaultModel: string
  readonly temperature: number
  readonly maxCompletionTokens: number
}

/**
 * Assistant text and the response kept for diagnostics and feature acceptance. `rawResponse` equals the reference's
 * `response.model_dump(mode="json")` of the model that the vendor SDK builds.
 */
export interface VendorReply {
  readonly text: string
  readonly rawResponse: JsonObject
}

/** Chat-completions URL and bearer credential for one vendor. */
export interface VendorEndpoint {
  readonly url: string
  readonly apiKey: string
}

/** Provider credentials, model aliases, and endpoints captured from the plugin configuration. */
export interface VendorSettings {
  /** `CEREBRAS_API_KEY`. */
  readonly cerebrasApiKey?: string | undefined
  /** `GROQ_API_KEY`. */
  readonly groqApiKey?: string | undefined
  /** `FASTVIDEO_PROMPT_CEREBRAS_MODEL`. */
  readonly cerebrasModel?: string | undefined
  /** `FASTVIDEO_PROMPT_GROQ_MODEL`. */
  readonly groqModel?: string | undefined
  /** `FASTVIDEO_PROMPT_GROQ_API_BASE_URL`; blank selects the OpenAI SDK endpoint like the reference. */
  readonly groqApiBaseUrl: string
  /** `CEREBRAS_BASE_URL`. */
  readonly cerebrasBaseUrl: string
}

/**
 * Send one request with a vendor's model alias and the request body, endpoint, retries, and failure messages of the
 * vendor SDK that the reference uses: the Cerebras SDK for `cerebras` and the OpenAI SDK for `groq`.
 */
export class VendorClient {
  /**
   * @param name - the provider name, `cerebras` or `groq`.
   * @param requestModel - the vendor alias sent for the logical default model.
   * @param endpoint - the chat-completions URL and API key.
   * @param diagnostics - the sink for reply-extraction warnings.
   */
  constructor(
    readonly name: string,
    readonly requestModel: string,
    readonly endpoint: VendorEndpoint,
    protected readonly diagnostics: PromptDiagnostics,
  ) {}

  /**
   * Send one request using this vendor's model alias, retrying like the vendor SDK.
   * @param request - the feature request.
   * @param signal - aborts the HTTP request and any retry wait when the race no longer needs this attempt.
   * @returns the assistant text, empty when absent, and the decoded response body.
   * @throws PromptRuntimeError for an unknown provider; Error with the SDK failure message after the last attempt.
   */
  async complete(request: ChatRequest, signal?: AbortSignal): Promise<VendorReply> {
    let model = stripWhitespace(request.model)
    if (!model || model === request.defaultModel) model = this.requestModel
    if (this.name !== 'groq' && this.name !== 'cerebras') {
      throw new PromptRuntimeError(`Unsupported prompt provider: ${this.name}`)
    }
    const messages = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userContent },
    ]
    // Both SDKs send compact JSON in this key order and write the temperature as a Python float.
    const requestBody = `{"messages":${JSON.stringify(messages)},"model":${JSON.stringify(model)},`
      + `"max_completion_tokens":${JSON.stringify(request.maxCompletionTokens)},`
      + `"temperature":${pythonFloatRepr(request.temperature)}}`
    const policy = this.name === 'groq' ? OPENAI_SDK_RETRY_POLICY : CEREBRAS_SDK_RETRY_POLICY
    const body = await postChatCompletion(this.endpoint, requestBody, policy, signal)
    const rawResponse = dumpSdkResponse(body, this.name === 'groq' ? OPENAI_CHAT_COMPLETION : CEREBRAS_CHAT_COMPLETION)
    if (!isJsonObject(rawResponse)) {
      throw new TypeError(`Unsupported chat completion response type. type=<class '${pythonTypeName(rawResponse)}'>`)
    }
    return { text: extractContentOrEmpty(rawResponse, this.diagnostics), rawResponse }
  }
}

/**
 * Join an SDK base URL and a request path the way both SDKs do: the base gains a trailing slash and the path loses
 * its leading slash.
 * @param baseUrl - the configured base URL.
 * @param path - the SDK request path.
 * @returns the request URL.
 */
function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}${path.replace(/^\/+/, '')}`
}

/**
 * Select the chat-completions endpoint that a vendor SDK would use.
 * @param options.provider - the provider name.
 * @param options.apiKey - the stripped API key.
 * @param options.apiBaseUrl - the configured base URL; `null` selects the SDK default.
 * @returns the endpoint for `VendorClient`.
 * @throws PromptRuntimeError for an unknown provider.
 */
export function buildEndpoint(options: { provider: string; apiKey: string; apiBaseUrl: string | null }): VendorEndpoint {
  if (options.provider === 'cerebras') {
    return { url: joinBaseUrl(options.apiBaseUrl ?? DEFAULT_CEREBRAS_BASE_URL, '/v1/chat/completions'), apiKey: options.apiKey }
  }
  if (options.provider === 'groq') {
    return { url: joinBaseUrl(options.apiBaseUrl ?? OPENAI_SDK_BASE_URL, '/chat/completions'), apiKey: options.apiKey }
  }
  throw new PromptRuntimeError(`Unsupported prompt provider: ${options.provider}`)
}

/**
 * Capture credentials and vendor model aliases, then construct providers in configured order.
 * @param logicalModel - the settings default model that vendor aliases derive from.
 * @param settings - the configured credentials, aliases, and base URLs.
 * @param diagnostics - the sink for reply-extraction warnings.
 * @returns one client per provider in `PROMPT_PROVIDER_PRIORITY` order.
 * @throws PromptRuntimeError naming the first missing API key variable.
 */
export function createVendorClients(
  logicalModel: string,
  settings: VendorSettings,
  diagnostics: PromptDiagnostics,
): VendorClient[] {
  const credentialVariables = { cerebras: 'CEREBRAS_API_KEY', groq: 'GROQ_API_KEY' }
  const credentials = {
    cerebras: stripWhitespace(settings.cerebrasApiKey ?? ''),
    groq: stripWhitespace(settings.groqApiKey ?? ''),
  }
  const requestModels = {
    cerebras: stripWhitespace(settings.cerebrasModel ?? '') || logicalModel,
    groq: stripWhitespace(settings.groqModel ?? '') || `openai/${logicalModel}`,
  }
  const apiBaseUrls = {
    cerebras: settings.cerebrasBaseUrl,
    groq: stripWhitespace(settings.groqApiBaseUrl) || null,
  }
  const clients: VendorClient[] = []
  for (const providerName of PROMPT_PROVIDER_PRIORITY) {
    const apiKey = credentials[providerName]
    if (!apiKey) {
      throw new PromptRuntimeError(`Missing required environment variable: one of ${credentialVariables[providerName]}`)
    }
    const endpoint = buildEndpoint({ provider: providerName, apiKey, apiBaseUrl: apiBaseUrls[providerName] })
    clients.push(new VendorClient(providerName, requestModels[providerName], endpoint, diagnostics))
  }
  return clients
}

/**
 * Format a non-2xx response like the SDKs' `APIStatusError`: the Python `str()` of a JSON body after the status,
 * or the raw text when the body is not JSON.
 * @param status - the HTTP status code.
 * @param bodyText - the response body text.
 * @returns the error message.
 */
function statusErrorMessage(status: number, bodyText: string): string {
  const errText = stripWhitespace(bodyText)
  let body: JsonValue
  try {
    body = parsePythonJson(errText)
  } catch (error) {
    // A SyntaxError means a non-JSON body, which the SDKs report as its text.
    if (!(error instanceof SyntaxError)) throw error
    return errText || `Error code: ${status}`
  }
  return `Error code: ${status} - ${typeof body === 'string' ? body : reprPython(body)}`
}

/** Retry rules that differ between the two vendor SDKs. */
export interface SdkRetryPolicy {
  /** Largest server-directed delay, in seconds, used instead of exponential backoff. */
  readonly retryAfterLimitSeconds: number
  /** Whether a finite server-directed delay above the limit stops retries (OpenAI SDK) or falls back to backoff. */
  readonly stopOnLongRetryAfter: boolean
}

/** Retries after the first attempt, the SDKs' `DEFAULT_MAX_RETRIES`. */
const SDK_MAX_RETRIES = 2
/** First backoff delay in seconds, the SDKs' `INITIAL_RETRY_DELAY`. */
const INITIAL_RETRY_DELAY_SECONDS = 0.5
/** Backoff ceiling in seconds, the SDKs' `MAX_RETRY_DELAY`. */
const MAX_RETRY_DELAY_SECONDS = 8.0
/** Retry rules of the OpenAI Python SDK, which the reference uses for Groq. */
export const OPENAI_SDK_RETRY_POLICY: SdkRetryPolicy = { retryAfterLimitSeconds: 120, stopOnLongRetryAfter: true }
/** Retry rules of the Cerebras Python SDK. */
export const CEREBRAS_SDK_RETRY_POLICY: SdkRetryPolicy = { retryAfterLimitSeconds: 60, stopOnLongRetryAfter: false }
/** undici failure codes that the SDKs' `httpx` transport reports as timeouts. */
const TIMEOUT_FAILURE_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

/**
 * Read the server-directed retry delay like the SDKs' `_parse_retry_after_header`: `retry-after-ms`, then
 * `retry-after` as seconds, then `retry-after` as an HTTP date.
 * @param headers - the failed response headers, or `null` after a connection failure.
 * @returns the delay in seconds, or `undefined` when no header applies.
 */
function parseRetryAfterSeconds(headers: Headers | null): number | undefined {
  if (headers === null) return undefined
  const retryAfterMs = toPythonFloat(headers.get('retry-after-ms'))
  if (retryAfterMs !== undefined) return retryAfterMs / 1000
  const retryAfter = headers.get('retry-after')
  const seconds = toPythonFloat(retryAfter)
  if (seconds !== undefined) return seconds
  const retryDate = retryAfter === null ? Number.NaN : Date.parse(retryAfter)
  return Number.isNaN(retryDate) ? undefined : (retryDate - Date.now()) / 1000
}

/**
 * Decide whether a failed response is retried, like the SDKs' `_should_retry`.
 * @param response - the failed response.
 * @param policy - the vendor SDK's retry rules.
 * @returns true for an `x-should-retry: true` response or a 408, 409, 429, or 5xx status without an override.
 */
function shouldRetry(response: Response, policy: SdkRetryPolicy): boolean {
  const retryAfter = parseRetryAfterSeconds(response.headers)
  if (policy.stopOnLongRetryAfter && retryAfter !== undefined && Number.isFinite(retryAfter)
    && retryAfter > policy.retryAfterLimitSeconds) {
    return false
  }
  const shouldRetryHeader = response.headers.get('x-should-retry')
  if (shouldRetryHeader === 'true') return true
  if (shouldRetryHeader === 'false') return false
  return response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
}

/**
 * Compute the delay before a retry like the SDKs' `_calculate_retry_timeout`: a server-directed delay within the
 * policy limit, otherwise `min(0.5 * 2 ** retriesTaken, 8)` seconds reduced by up to 25% of random jitter.
 * @param retriesTaken - the number of retries already sent.
 * @param headers - the failed response headers, or `null` after a connection failure.
 * @param policy - the vendor SDK's retry rules.
 * @returns the delay in seconds.
 */
export function retryDelaySeconds(retriesTaken: number, headers: Headers | null, policy: SdkRetryPolicy): number {
  const retryAfter = parseRetryAfterSeconds(headers)
  if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0
    && retryAfter <= policy.retryAfterLimitSeconds) {
    return retryAfter
  }
  const sleepSeconds = Math.min(INITIAL_RETRY_DELAY_SECONDS * 2 ** Math.min(retriesTaken, 1000), MAX_RETRY_DELAY_SECONDS)
  const timeout = sleepSeconds * (1 - 0.25 * Math.random())
  return timeout >= 0 ? timeout : 0
}

/**
 * Report whether a `fetch` failure is a transport timeout, which the SDKs raise as `APITimeoutError`.
 * @param error - the `fetch` rejection.
 * @returns true when undici reports a connect, headers, or body timeout.
 */
function isTimeoutFailure(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof Error && TIMEOUT_FAILURE_CODES.has(String((cause as NodeJS.ErrnoException).code))
}

/**
 * Wait before a retry; an abort ends the wait with the abort reason.
 * @param seconds - the delay.
 * @param signal - the attempt's abort signal.
 */
function sleepBeforeRetry(seconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exact cancellation reason is the contract.
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exact cancellation reason is the contract.
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, seconds * 1000)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * POST one chat-completions body with the vendor SDK's retries and decode the JSON object reply.
 *
 * Like the SDK request loop, a connection failure or a retryable status is retried at most twice after the
 * computed delay; the last failure raises the SDK's message.
 * @param endpoint - the vendor URL and API key.
 * @param body - the serialized request body.
 * @param policy - the vendor SDK's retry rules.
 * @param signal - aborts the request and any retry wait.
 * @returns the decoded response JSON, with float literals as `PythonFloat`.
 * @throws Error with the SDK's `Connection error.`, `Request timed out.`, or status message, or the abort reason.
 */
async function postChatCompletion(
  endpoint: VendorEndpoint,
  body: string,
  policy: SdkRetryPolicy,
  signal?: AbortSignal,
): Promise<JsonValue> {
  for (let retriesTaken = 0; ; retriesTaken++) {
    const remainingRetries = SDK_MAX_RETRIES - retriesTaken
    let response: Response
    let bodyText: string
    try {
      response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${endpoint.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body,
        ...signal === undefined ? {} : { signal },
      })
      bodyText = await response.text()
    } catch (error) {
      if (signal?.aborted) throw error
      if (remainingRetries > 0) {
        await sleepBeforeRetry(retryDelaySeconds(retriesTaken, null, policy), signal)
        continue
      }
      throw new Error(isTimeoutFailure(error) ? 'Request timed out.' : 'Connection error.', { cause: error })
    }
    if (!response.ok) {
      if (remainingRetries > 0 && shouldRetry(response, policy)) {
        await sleepBeforeRetry(retryDelaySeconds(retriesTaken, response.headers, policy), signal)
        continue
      }
      throw new Error(statusErrorMessage(response.status, bodyText))
    }
    try {
      return parsePythonJson(bodyText)
    } catch (error) {
      throw new Error(`Chat completion response is not JSON: ${errorText(error)}`, { cause: error })
    }
  }
}

/**
 * Read `choices[0]` and its message like the reference's chained `dict.get` calls, raising Python's
 * `AttributeError` text when either value is not an object.
 * @param responseJson - the decoded response body.
 * @returns the first choice and its message object.
 */
function readFirstMessage(responseJson: JsonObject): { choice: JsonObject; message: JsonObject } {
  const choices = dictGet(responseJson, 'choices')
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Missing choices in chat completion response.')
  }
  const choice = choices[0]
  if (!isJsonObject(choice)) throw new Error(`'${pythonTypeName(choice)}' object has no attribute 'get'`)
  const message = Object.hasOwn(choice, 'message') ? dictGet(choice, 'message') : {}
  if (!isJsonObject(message)) throw new Error(`'${pythonTypeName(message)}' object has no attribute 'get'`)
  return { choice, message }
}

/**
 * Read text from string or multipart assistant content returned by providers.
 * @param responseJson - the decoded response body.
 * @returns the assistant text.
 * @throws Error when the reply has no choices or no assistant text.
 */
export function extractAssistantContent(responseJson: JsonObject): string {
  const { choice, message } = readFirstMessage(responseJson)
  const content = dictGet(message, 'content')
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const chunks: string[] = []
    for (const item of content) {
      if (!isJsonObject(item)) continue
      // Providers use several content-part shapes for assistant text.
      const text = dictGet(item, 'text')
      if (typeof text === 'string') {
        chunks.push(text)
        continue
      }
      if (isJsonObject(text)) {
        const value = dictGet(text, 'value')
        if (typeof value === 'string') {
          chunks.push(value)
          continue
        }
      }
      const altText = dictGet(item, 'output_text')
      if (typeof altText === 'string') chunks.push(altText)
    }
    if (chunks.length > 0) return chunks.join('')
  }
  const finishReason = dictGet(choice, 'finish_reason')
  const refusal = dictGet(message, 'refusal')
  throw new Error('Missing assistant content in chat completion response. '
    + `finish_reason=${reprPython(finishReason)}, refusal=${reprPython(refusal)}`)
}

/**
 * Return the assistant text, or an empty string with a warning that retains the reply's diagnostics.
 * @param responseJson - the decoded response body.
 * @param diagnostics - the warning sink.
 * @returns the assistant text, or `''` when it is absent.
 */
export function extractContentOrEmpty(responseJson: JsonObject, diagnostics: PromptDiagnostics): string {
  try {
    return extractAssistantContent(responseJson)
  } catch (error) {
    const choices = dictGet(responseJson, 'choices')
    const choice = Array.isArray(choices) && choices.length > 0 ? choices[0] : {}
    // The reference's warning reads `choice.get(...)`, which raises again for a non-object choice.
    if (!isJsonObject(choice)) throw new Error(`'${pythonTypeName(choice)}' object has no attribute 'get'`)
    const message = Object.hasOwn(choice, 'message') ? dictGet(choice, 'message') : {}
    const messageKeys = isJsonObject(message) ? reprPython(Object.keys(message)) : 'n/a'
    diagnostics.warn('[ENHANCE][WARN] Failed to extract assistant content: '
      + `${errorText(error)}; finish_reason=${reprPython(dictGet(choice, 'finish_reason'))}; `
      + `usage=${reprPython(dictGet(responseJson, 'usage'))}; message_keys=${messageKeys}`)
    return ''
  }
}
