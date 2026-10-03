/** Verify acceptance, staged deadlines, and cancellation independently of prompt features. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VendorClient, type ChatRequest, type VendorReply } from '../src/llm/client.ts'
import { ProviderRace } from '../src/llm/race.ts'
import { FakeVendor, recordingDiagnostics, testRace, textReply } from './support.ts'

const REQUEST: ChatRequest = {
  systemPrompt: 'system', userContent: 'user', model: 'model', defaultModel: 'model', temperature: 0.4,
  maxCompletionTokens: 512,
}

/** A promise with its resolver, for ordering attempts without timing assumptions. */
function gate(): { promise: Promise<void>; open: () => void; opened: () => boolean } {
  let open = () => {}
  let isOpen = false
  const promise = new Promise<void>((resolve) => {
    open = () => {
      isOpen = true
      resolve()
    }
  })
  return { promise, open, opened: () => isOpen }
}

/**
 * Wait until an attempt is aborted, then reject with the abort reason like an aborted `fetch`.
 * @param signal - the attempt signal.
 * @returns a promise that rejects on abort.
 */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- like fetch, reject with the exact abort reason.
    signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

/** Settle pending microtasks and timers queued so far. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ProviderRace', () => {
  it.each(['cerebras', 'groq'])('lets %s win and aborts the pending vendor without counting it', async (winner) => {
    const started = { cerebras: gate(), groq: gate() }
    const loserAborted = gate()
    const vendors = (['cerebras', 'groq'] as const).map(name => new FakeVendor(name, async (_request, signal) => {
      started[name].open()
      await Promise.all([started.cerebras.promise, started.groq.promise])
      if (name === winner) return textReply('accepted')
      try {
        return await untilAborted(signal)
      } finally {
        loserAborted.open()
      }
    }))
    const race = testRace([vendors])
    const result = await race.firstAccepted(REQUEST, reply => reply.text, { operationName: 'test' })
    expect(loserAborted.opened()).toBe(true)
    expect(result).toEqual([winner, 'accepted'])
    expect(race.getProviderSuccessCounts()).toEqual({ cerebras: Number(winner === 'cerebras'), groq: Number(winner === 'groq') })
  })

  it.each(['exception', 'invalid_response', 'timeout'])('advances to the next stage after a first-stage %s', async (failure) => {
    const firstFinished = gate()
    const calls: string[] = []
    const cerebras = new FakeVendor('cerebras', async (_request, signal) => {
      calls.push('cerebras')
      try {
        if (failure === 'exception') throw new Error('provider overloaded')
        if (failure === 'timeout') return await untilAborted(signal)
        return textReply('invalid')
      } finally {
        firstFinished.open()
      }
    })
    const groq = new FakeVendor('groq', () => {
      calls.push('groq')
      expect(firstFinished.opened()).toBe(true)
      return Promise.resolve(textReply('accepted'))
    })
    const diagnostics = recordingDiagnostics()
    const race = testRace([[cerebras], [groq]], diagnostics)
    const accept = (reply: VendorReply) => {
      if (reply.text !== 'accepted') throw new Error('Invalid prompt')
      return reply.text
    }
    expect(await race.firstAccepted(REQUEST, accept, { operationName: 'test' })).toEqual(['groq', 'accepted'])
    expect(calls).toEqual(['cerebras', 'groq'])
    expect(race.getProviderSuccessCounts()).toEqual({ cerebras: 0, groq: 1 })
    const expectedError = {
      exception: 'provider overloaded',
      invalid_response: 'Invalid prompt | assistant_response=invalid',
      timeout: 'timed out after 0.02s',
    }[failure]
    expect(diagnostics.lines).toEqual([
      `[ENHANCE][WARN] test failed for provider=cerebras: ${expectedError}`,
      '[ENHANCE][INFO] test entering fallback stage with providers=groq',
    ])
  })

  it('aggregates every rejected response without counting a success', async () => {
    const vendors = ['cerebras', 'groq'].map(name => new FakeVendor(name, () =>
      Promise.resolve(textReply(`invalid ${name} response\nsecond line`))))
    const race = testRace([vendors])
    const failure = race.firstAccepted(REQUEST, () => {
      throw new Error('Missing prompt')
    }, { operationName: 'test' })
    await expect(failure).rejects.toThrow(new RegExp(
      '^test failed for all providers\\. provider=cerebras error=Missing prompt '
      + '\\| assistant_response=invalid cerebras response\\\\nsecond line \\| provider=groq error=Missing prompt'))
    expect(race.getProviderSuccessCounts()).toEqual({ cerebras: 0, groq: 0 })
  })

  it('truncates a long rejected reply to 240 code points', async () => {
    const text = '🌙'.repeat(300)
    const race = testRace([[new FakeVendor('cerebras', () => Promise.resolve(textReply(text)))]])
    const failure = race.firstAccepted(REQUEST, () => {
      throw new Error('bad')
    }, { operationName: 'op' })
    await expect(failure).rejects.toThrow(`op failed for all providers. provider=cerebras error=bad | assistant_response=${'🌙'.repeat(240)}...`)
  })

  it('aborts every attempt when the caller aborts', async () => {
    const started = { cerebras: gate(), groq: gate() }
    const aborted = { cerebras: gate(), groq: gate() }
    const vendors = (['cerebras', 'groq'] as const).map(name => new FakeVendor(name, async (_request, signal) => {
      started[name].open()
      try {
        return await untilAborted(signal)
      } finally {
        aborted[name].open()
      }
    }))
    const race = testRace([vendors])
    const controller = new AbortController()
    const pending = race.firstAccepted(REQUEST, reply => reply.text, { operationName: 'test', signal: controller.signal })
    await Promise.all([started.cerebras.promise, started.groq.promise])
    const reason = new Error('project closed')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(aborted.cerebras.opened() && aborted.groq.opened()).toBe(true)
    expect(race.getProviderSuccessCounts()).toEqual({ cerebras: 0, groq: 0 })
  })

  it('aborts a losing HTTP request after another vendor wins', async () => {
    const slowAborted = gate()
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (url.includes('fast')) {
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'accepted' } }] })))
      }
      init.signal?.addEventListener('abort', () => { slowAborted.open() })
      return untilAborted(init.signal ?? undefined)
    }))
    const diagnostics = recordingDiagnostics()
    const slow = new VendorClient('cerebras', 'm', { url: 'https://slow.test', apiKey: 'k' }, diagnostics)
    const fast = new VendorClient('groq', 'm', { url: 'https://fast.test', apiKey: 'k' }, diagnostics)
    const race = testRace([[slow, fast]], diagnostics)
    expect(await race.firstAccepted(REQUEST, reply => reply.text, { operationName: 'test' })).toEqual(['groq', 'accepted'])
    expect(slowAborted.opened()).toBe(true)
    expect(race.getProviderSuccessCounts()).toEqual({ cerebras: 0, groq: 1 })
  })

  it.each([
    ['cerebras', false, false],
    ['groq', false, false],
    ['cerebras', true, false],
    ['cerebras', false, true],
    ['cerebras', true, true],
  ])('settles the loser before delivering the reply (winner=%s, abort during cleanup=%s, cleanup failure=%s)',
    async (winner, abortDuringCleanup, cleanupFailure) => {
      const started = { cerebras: gate(), groq: gate() }
      const cleanupStarted = gate()
      const allowCleanup = gate()
      const cleanupFinished = gate()
      const vendors = (['cerebras', 'groq'] as const).map(name => new FakeVendor(name, async (_request, signal) => {
        started[name].open()
        try {
          await Promise.all([started.cerebras.promise, started.groq.promise])
          if (name === winner) return textReply('accepted')
          return await untilAborted(signal)
        } finally {
          if (name !== winner) {
            cleanupStarted.open()
            await allowCleanup.promise
            cleanupFinished.open()
            if (cleanupFailure) throw new Error('Controlled losing provider cleanup failure')
          }
        }
      }))
      const race = testRace([vendors])
      const controller = new AbortController()
      let settled = false
      const pending = race.firstAccepted(REQUEST, reply => reply.text, { operationName: 'test', signal: controller.signal })
      void pending.then(() => { settled = true }, () => { settled = true })
      await cleanupStarted.promise
      await flush()
      expect(settled).toBe(false)
      expect(race.getProviderSuccessCounts()).toEqual({ cerebras: Number(winner === 'cerebras'), groq: Number(winner === 'groq') })
      if (abortDuringCleanup) {
        controller.abort(new Error('cancelled during cleanup'))
        await flush()
        expect(settled).toBe(false)
        expect(cleanupFinished.opened()).toBe(false)
      }
      allowCleanup.open()
      if (abortDuringCleanup) await expect(pending).rejects.toThrow('cancelled during cleanup')
      else expect(await pending).toEqual([winner, 'accepted'])
      expect(cleanupFinished.opened()).toBe(true)
      expect(race.getProviderSuccessCounts()).toEqual({ cerebras: Number(winner === 'cerebras'), groq: Number(winner === 'groq') })
    })

  it('waits for every provider cleanup after the caller aborts', async () => {
    const names = ['cerebras', 'groq'] as const
    const started = { cerebras: gate(), groq: gate() }
    const allowCleanup = { cerebras: gate(), groq: gate() }
    const cleanupFinished = { cerebras: gate(), groq: gate() }
    const vendors = names.map(name => new FakeVendor(name, async (_request, signal) => {
      started[name].open()
      try {
        return await untilAborted(signal)
      } finally {
        await allowCleanup[name].promise
        cleanupFinished[name].open()
      }
    }))
    const race = testRace([vendors])
    const controller = new AbortController()
    let settled = false
    const pending = race.firstAccepted(REQUEST, reply => reply.text, { operationName: 'test', signal: controller.signal })
    void pending.then(() => { settled = true }, () => { settled = true })
    await Promise.all([started.cerebras.promise, started.groq.promise])
    controller.abort(new Error('closed'))
    await flush()
    expect(settled).toBe(false)
    allowCleanup.cerebras.open()
    await cleanupFinished.cerebras.promise
    await flush()
    expect(settled).toBe(false)
    allowCleanup.groq.open()
    await expect(pending).rejects.toThrow('closed')
    expect(cleanupFinished.groq.opened()).toBe(true)
    expect(race.getProviderSuccessCounts()).toEqual({ cerebras: 0, groq: 0 })
  })

  it('uses the initial stage deadline only when a fallback stage exists', async () => {
    const slow = () => new FakeVendor('cerebras', (_request, signal) => untilAborted(signal))
    const single = new ProviderRace([[slow()]], { initialStageTimeoutMs: 20, httpTimeoutMs: 30, timeoutMs: 10 },
      recordingDiagnostics())
    await expect(single.firstAccepted(REQUEST, reply => reply.text, { operationName: 'op' }))
      .rejects.toThrow('op failed for all providers. provider=cerebras error=timed out after 0.03s')
    const staged = new ProviderRace([[slow()], [slow()]], { initialStageTimeoutMs: 0, httpTimeoutMs: 10, timeoutMs: 20 },
      recordingDiagnostics())
    await expect(staged.firstAccepted(REQUEST, reply => reply.text, { operationName: 'op' }))
      .rejects.toThrow('op failed for all providers. provider=cerebras error=timed out after 1.50s | '
        + 'provider=cerebras error=timed out after 0.02s')
  })

  it('arranges configured vendors into one stage with the reference stage deadlines and the given operation deadline', () => {
    const cerebras = new FakeVendor('cerebras', () => Promise.resolve(textReply('')))
    const groq = new FakeVendor('groq', () => Promise.resolve(textReply('')))
    const race = ProviderRace.fromConfig([groq, cerebras], 45000, recordingDiagnostics())
    expect(race.stages).toEqual([[cerebras, groq]])
    expect(race.providerLabel).toBe('cerebras')
    expect(race.timeouts).toEqual({ initialStageTimeoutMs: 1500, httpTimeoutMs: 3000, timeoutMs: 45000 })
    expect(race.getProviderSuccessCounts()).toEqual({ cerebras: 0, groq: 0 })
  })
})
