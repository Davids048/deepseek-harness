/**
 * Shared test inputs: isolated template files, request defaults, and in-memory vendor clients.
 *
 * @module
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { VendorClient, type ChatRequest, type PromptDiagnostics, type VendorReply } from '../src/llm/client.ts'
import { ProviderRace } from '../src/llm/race.ts'
import { PromptSettings } from '../src/settings.ts'
import { PromptTemplates, type PromptTemplateOptions } from '../src/templates/loader.ts'
import type { JsonObject } from '../src/utils/python-text.ts'

/** Diagnostics sink that records every line. */
export function recordingDiagnostics(): PromptDiagnostics & { lines: string[] } {
  const lines: string[] = []
  return { lines, info: line => lines.push(line), warn: line => lines.push(line) }
}

/** An endpoint that no test contacts. */
export const UNUSED_ENDPOINT = { url: 'http://127.0.0.1:9/unused', apiKey: 'unused' }

/** A vendor whose `complete` delegates to a test function and records each request. */
export class FakeVendor extends VendorClient {
  readonly requests: ChatRequest[] = []

  constructor(
    name: string,
    private readonly respond: (request: ChatRequest, signal: AbortSignal | undefined) => Promise<VendorReply>,
  ) {
    super(name, 'vendor-model', UNUSED_ENDPOINT, recordingDiagnostics())
  }

  override async complete(request: ChatRequest, signal?: AbortSignal): Promise<VendorReply> {
    this.requests.push(request)
    return await this.respond(request, signal)
  }
}

/** A reply as a vendor SDK would return it for assistant text. */
export function textReply(text: string, rawResponse?: JsonObject): VendorReply {
  return { text, rawResponse: rawResponse ?? { choices: [{ message: { content: text } }] } }
}

/** A single-stage race with test deadlines, like the reference test fixtures. */
export function testRace(stages: VendorClient[][], diagnostics: PromptDiagnostics = recordingDiagnostics()): ProviderRace {
  return new ProviderRace(stages, { initialStageTimeoutMs: 20, httpTimeoutMs: 1000, defaultTimeoutMs: 1000 }, diagnostics)
}

/** Request defaults used by the reference feature and enhancer tests. */
export function testSettings(): PromptSettings {
  const settings = new PromptSettings(undefined)
  settings.rewriteDefaultModel = 'gpt-test'
  settings.temperature = 0.4
  settings.rewriteDefaultTemperature = 0.4
  settings.maxCompletionTokens = 512
  return settings
}

/** A temporary directory removed by `cleanup`. */
export interface TemporaryDirectory {
  readonly directory: string
  cleanup(): void
}

/**
 * Create a temporary directory for one test.
 * @returns the directory and its cleanup.
 */
export function temporaryDirectory(): TemporaryDirectory {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamverse-prompt-'))
  return { directory, cleanup: () => { fs.rmSync(directory, { recursive: true, force: true }) } }
}

/**
 * The text body of a request that a provider client sent; the clients always send JSON text.
 * @param init - the captured request's fetch options.
 * @returns the body text.
 */
export function requestBodyText(init: RequestInit): string {
  if (typeof init.body !== 'string') throw new TypeError('Expected a text request body.')
  return init.body
}

/**
 * Write one file per configured template and return path overrides for them, like the reference
 * `prompt_template_paths` fixture.
 * @param directory - the test directory.
 * @returns template options whose four overridable paths point into `directory`.
 */
export function templatePathOptions(directory: string): PromptTemplateOptions {
  const files = {
    enhanceSystemPromptPath: ['enhance.md', 'continuation template'],
    autoSystemPromptPath: ['auto.md', 'clip and auto template'],
    rewriteAllSystemPromptPath: ['rewrite_all.md', 'rewrite template'],
    rewriteUserSystemPromptPath: ['rewrite_user.md', 'initial rollout template'],
  } as const
  const overrides: Record<string, string> = {}
  for (const [field, [filename, content]] of Object.entries(files)) {
    const filePath = path.join(directory, filename)
    fs.writeFileSync(filePath, `${content}\n`, 'utf8')
    overrides[field] = filePath
  }
  return overrides
}

/**
 * Load templates from the test directory and replace the Ref2VA text, like the reference `prompt_templates` fixture.
 * @param directory - the test directory.
 * @returns the loaded templates.
 */
export function testTemplates(directory: string): PromptTemplates {
  const templates = new PromptTemplates(templatePathOptions(directory))
  templates.ref2vaSystemPrompt = 'reference shot template'
  return templates
}

/**
 * Snapshot every file in a directory by name.
 * @param directory - the directory to read.
 * @returns file contents keyed by name.
 */
export function snapshotFiles(directory: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const name of fs.readdirSync(directory)) {
    const filePath = path.join(directory, name)
    if (fs.statSync(filePath).isFile()) snapshot[name] = fs.readFileSync(filePath, 'latin1')
  }
  return snapshot
}
