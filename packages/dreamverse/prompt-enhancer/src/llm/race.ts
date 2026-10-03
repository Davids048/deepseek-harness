/**
 * Coordinate provider stages until a prompt feature accepts a reply.
 *
 * @module @dreamverse/prompt-enhancer/llm/race
 */
import { PROMPT_PROVIDER_PRIORITY } from '../settings.ts'
import { errorText } from '../utils/errors.ts'
import { stripWhitespace, truncateCodePoints } from '../utils/python-text.ts'
import type { ChatRequest, PromptDiagnostics, VendorClient, VendorReply } from './client.ts'

/** Minimum per-attempt deadline in the last stage. */
export const PROMPT_HTTP_TIMEOUT_MS = 3000
/** Deadline of the first stage when a later fallback stage exists. */
export const PROMPT_INITIAL_STAGE_TIMEOUT_MS = 1500
/** Stage topology: every configured provider races in one stage. */
export const PROMPT_PROVIDER_RUNTIME_STAGES: readonly (readonly string[])[] = [PROMPT_PROVIDER_PRIORITY]

/** Longest assistant-reply excerpt, in code points, appended to a rejected attempt's error. */
const RESPONSE_PREVIEW_CODE_POINTS = 240

/** Deadlines applied by `firstAccepted`. */
export interface ProviderRaceTimeouts {
  readonly initialStageTimeoutMs: number
  readonly httpTimeoutMs: number
  /** Deadline of one operation, from the plugin's `timeoutMs` Config field. */
  readonly timeoutMs: number
}

/** Per-operation inputs of `firstAccepted`. */
export interface FirstAcceptedOptions {
  /** The operation name used in diagnostics and the aggregated failure message. */
  readonly operationName: string
  /** Aborts every attempt; `firstAccepted` then rejects with the abort reason after the attempts settle. */
  readonly signal?: AbortSignal | undefined
}

/** One settled attempt reported to the waiting stage. */
type AttemptOutcome<T> =
  | { readonly status: 'success'; readonly providerName: string; readonly value: T }
  | { readonly status: 'error'; readonly providerName: string; readonly message: string }

/** Deliver attempt outcomes in completion order to one waiting stage. */
class AttemptOutcomeQueue<T> {
  private readonly ready: AttemptOutcome<T>[] = []
  private waiter: ((outcome: AttemptOutcome<T>) => void) | undefined

  /** Record an outcome for the current or next `next()` call. */
  push(outcome: AttemptOutcome<T>): void {
    const waiter = this.waiter
    this.waiter = undefined
    if (waiter === undefined) this.ready.push(outcome)
    else waiter(outcome)
  }

  /**
   * Wait for the next outcome, rejecting with the caller's abort reason when the caller aborts first.
   * @param signal - the caller's abort signal.
   * @returns the next outcome in completion order.
   */
  next(signal: AbortSignal | undefined): Promise<AttemptOutcome<T>> {
    const outcome = this.ready.shift()
    if (outcome !== undefined) return Promise.resolve(outcome)
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiter = undefined
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exact cancellation reason is the contract.
        reject(signal?.reason)
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiter = (value) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
    })
  }
}

/** Own provider stages, request deadlines, and accepted-response counters. */
export class ProviderRace {
  private readonly successCounts: Map<string, number>

  /**
   * Use nonempty stages of configured clients for each prompt operation.
   * @param stages - the provider stages in fallback order.
   * @param timeouts - the stage and attempt deadlines.
   * @param diagnostics - the sink for fallback and failure lines.
   */
  constructor(
    readonly stages: VendorClient[][],
    readonly timeouts: ProviderRaceTimeouts,
    private readonly diagnostics: PromptDiagnostics,
  ) {
    this.successCounts = new Map(stages.flatMap(stage => stage.map(client => [client.name, 0] as const)))
  }

  /**
   * Arrange supplied vendor clients into configured race stages.
   * @param clients - the constructed vendor clients.
   * @param timeoutMs - the deadline of one operation in milliseconds.
   * @param diagnostics - the sink for fallback and failure lines.
   * @returns a race with the reference stage deadlines and the given operation deadline.
   */
  static fromConfig(clients: readonly VendorClient[], timeoutMs: number, diagnostics: PromptDiagnostics): ProviderRace {
    const clientByName = new Map(clients.map(client => [client.name, client]))
    const stages: VendorClient[][] = []
    for (const stageNames of PROMPT_PROVIDER_RUNTIME_STAGES) {
      const stage = stageNames.flatMap(name => clientByName.get(name) ?? [])
      if (stage.length > 0) stages.push(stage)
    }
    return new ProviderRace(stages, {
      initialStageTimeoutMs: PROMPT_INITIAL_STAGE_TIMEOUT_MS,
      httpTimeoutMs: PROMPT_HTTP_TIMEOUT_MS,
      timeoutMs,
    }, diagnostics)
  }

  /** The provider named in failure results: the first client of the first stage. */
  get providerLabel(): string {
    const client = this.stages[0]?.[0]
    if (client === undefined) throw new TypeError('ProviderRace has no provider stages.')
    return client.name
  }

  /**
   * Count accepted replies per provider.
   * @returns counts for every priority provider followed by any other configured provider.
   */
  getProviderSuccessCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const name of PROMPT_PROVIDER_PRIORITY) counts[name] = this.successCounts.get(name) ?? 0
    for (const [name, count] of this.successCounts) counts[name] = count
    return counts
  }

  /**
   * Select the first accepted reply and settle all attempts before returning or rejecting.
   *
   * Each stage starts every client at once. A reply wins only when `accept` returns; a rejected reply, a vendor
   * failure, or a deadline records an error and leaves the other attempts running. The first stage uses the initial
   * stage deadline only when a fallback stage exists. Losing attempts are aborted and awaited before exit. A caller
   * abort, including one that arrives while losers settle after acceptance, rejects with the abort reason once every
   * attempt has settled.
   * @param request - the feature request.
   * @param accept - validates a reply and returns the feature value, or throws to reject it.
   * @param options - the operation name and caller abort signal.
   * @returns the winning provider name and the accepted value.
   * @throws Error aggregating every provider failure, or the caller's abort reason.
   */
  async firstAccepted<T>(
    request: ChatRequest,
    accept: (reply: VendorReply) => T,
    options: FirstAcceptedOptions,
  ): Promise<[string, T]> {
    const { operationName, signal } = options
    const fallbackTimeoutSeconds = Math.max(this.timeouts.timeoutMs, this.timeouts.httpTimeoutMs) / 1000
    let initialTimeoutMs = this.timeouts.initialStageTimeoutMs
    if (initialTimeoutMs <= 0) initialTimeoutMs = PROMPT_INITIAL_STAGE_TIMEOUT_MS

    const errors: string[] = []
    for (const [stageIndex, stageClients] of this.stages.entries()) {
      let stageTimeoutSeconds = fallbackTimeoutSeconds
      if (stageIndex === 0 && this.stages.length > 1) stageTimeoutSeconds = initialTimeoutMs / 1000
      if (stageIndex > 0) {
        this.diagnostics.info(`[ENHANCE][INFO] ${operationName} entering fallback stage with providers=`
          + stageClients.map(client => client.name).join(','))
      }

      signal?.throwIfAborted()
      const accepted = await this.runStage(stageClients, request, accept, stageTimeoutSeconds, operationName, errors,
        signal)
      // A caller abort during loser cleanup wins over an accepted reply, as cancellation does in the reference.
      signal?.throwIfAborted()
      if (accepted !== undefined) return accepted
    }
    throw new Error(`${operationName} failed for all providers. ${errors.join(' | ')}`)
  }

  /**
   * Start every client of one stage, return the first accepted reply, and settle every attempt before returning.
   * @param stageClients - the clients that race in this stage.
   * @param request - the feature request.
   * @param accept - the feature's reply validator.
   * @param timeoutSeconds - the per-attempt deadline.
   * @param operationName - the operation name used in diagnostics.
   * @param errors - receives one entry per failed attempt, in completion order.
   * @param signal - the caller's abort signal.
   * @returns the winning provider and value, or `undefined` when every attempt failed.
   */
  private async runStage<T>(
    stageClients: readonly VendorClient[],
    request: ChatRequest,
    accept: (reply: VendorReply) => T,
    timeoutSeconds: number,
    operationName: string,
    errors: string[],
    signal: AbortSignal | undefined,
  ): Promise<[string, T] | undefined> {
    const outcomes = new AttemptOutcomeQueue<T>()
    const controllers: AbortController[] = []
    const abortAttempts = () => {
      for (const controller of controllers) controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', abortAttempts, { once: true })
    const attempts = stageClients.map((client) => {
      const controller = new AbortController()
      controllers.push(controller)
      return runAttempt(client, request, accept, timeoutSeconds, controller, outcomes)
    })
    try {
      for (let settled = 0; settled < attempts.length; settled++) {
        const outcome = await outcomes.next(signal)
        if (outcome.status === 'success') {
          this.successCounts.set(outcome.providerName, (this.successCounts.get(outcome.providerName) ?? 0) + 1)
          return [outcome.providerName, outcome.value]
        }
        errors.push(`provider=${outcome.providerName} error=${outcome.message}`)
        this.diagnostics.warn(
          `[ENHANCE][WARN] ${operationName} failed for provider=${outcome.providerName}: ${outcome.message}`)
      }
      return undefined
    } finally {
      signal?.removeEventListener('abort', abortAttempts)
      abortAttempts()
      await Promise.allSettled(attempts)
    }
  }
}

/**
 * Let the feature validate one vendor reply; a failure carries a preview of nonblank assistant text.
 * @param client - the vendor client.
 * @param request - the feature request.
 * @param accept - the feature's reply validator.
 * @param signal - aborts the vendor request.
 * @returns the accepted feature value.
 */
async function attemptReply<T>(
  client: VendorClient,
  request: ChatRequest,
  accept: (reply: VendorReply) => T,
  signal: AbortSignal,
): Promise<T> {
  let reply: VendorReply | undefined
  try {
    reply = await client.complete(request, signal)
    return accept(reply)
  } catch (error) {
    let errorDetail = errorText(error)
    if (reply !== undefined && stripWhitespace(reply.text)) {
      const preview = truncateCodePoints(reply.text.replaceAll('\n', '\\n'), RESPONSE_PREVIEW_CODE_POINTS)
      errorDetail = `${errorDetail} | assistant_response=${preview}`
    }
    throw new Error(errorDetail, { cause: error })
  }
}

/**
 * Run one attempt under its deadline and report its outcome once it settles. An attempt aborted because the stage
 * ended or the caller aborted reports nothing, like a cancelled Python task.
 * @param client - the vendor client.
 * @param request - the feature request.
 * @param accept - the feature's reply validator.
 * @param timeoutSeconds - the attempt deadline; zero or less disables it.
 * @param controller - aborts this attempt.
 * @param outcomes - receives the attempt outcome.
 */
async function runAttempt<T>(
  client: VendorClient,
  request: ChatRequest,
  accept: (reply: VendorReply) => T,
  timeoutSeconds: number,
  controller: AbortController,
  outcomes: AttemptOutcomeQueue<T>,
): Promise<void> {
  let timedOut = false
  const timer = timeoutSeconds > 0
    ? setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException(`timed out after ${timeoutSeconds.toFixed(2)}s`, 'TimeoutError'))
    }, timeoutSeconds * 1000)
    : undefined
  try {
    const value = await attemptReply(client, request, accept, controller.signal)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the timer can fire while the attempt is awaited.
    if (timedOut) outcomes.push({ status: 'error', providerName: client.name, message: timeoutMessage(timeoutSeconds) })
    else if (!controller.signal.aborted) outcomes.push({ status: 'success', providerName: client.name, value })
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the timer can fire while the attempt is awaited.
    if (timedOut) outcomes.push({ status: 'error', providerName: client.name, message: timeoutMessage(timeoutSeconds) })
    else if (!controller.signal.aborted) outcomes.push({ status: 'error', providerName: client.name, message: errorText(error) })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Format the attempt deadline failure like the reference's `f"timed out after {timeout_seconds:.2f}s"`.
 * @param timeoutSeconds - the attempt deadline in seconds.
 * @returns the timeout message.
 */
function timeoutMessage(timeoutSeconds: number): string {
  return `timed out after ${timeoutSeconds.toFixed(2)}s`
}
