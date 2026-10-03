/**
 * Ask a model, through the harness LLM service, for two different ways the story can continue after a scene.
 *
 * @module @dreamverse/multiverse/branch-proposals
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { BranchDraft } from './tree.ts'

/** The model route that proposals use: the harness's default model selection. */
export type ProposalRoute = Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'>

/** One scene of the story so far, oldest first. */
export interface StoryScene {
  label: string
  direction: string
}

/** The proposal instructions; the model sees only story concepts. */
export const PROPOSAL_SYSTEM_PROMPT = [
  'You plan a branching short-film story. Each scene is one continuous shot of a few seconds.',
  'Given the premise and the scenes so far, propose exactly two different ways the story continues in the next scene.',
  'The two options must lead the story in clearly different directions, keep the same characters and setting, and',
  'follow on directly from the end of the last scene.',
  'Respond with JSON only, no other text, in this form:',
  '{"branches": [{"label": "...", "direction": "..."}, {"label": "...", "direction": "..."}]}',
  'label: two to six words naming the choice. direction: one or two sentences describing what happens in the scene.',
].join('\n')

/**
 * Write the user message that describes the story so far.
 * @param scenes - the scenes from the first to the latest.
 * @returns the message text.
 */
export function proposalMessage(scenes: readonly StoryScene[]): string {
  const [premise, ...later] = scenes
  const lines = [`Premise: ${premise?.direction ?? ''}`, '', 'Scenes so far:']
  scenes.forEach((scene, index) => { lines.push(`${index + 1}. ${scene.label}: ${scene.direction}`) })
  if (later.length === 0) lines.push('(only the opening scene so far)')
  return lines.join('\n')
}

/** The complete model request of one proposal call, without its abort signal. */
export type ProposalRequest = Omit<GenerateOptions, 'signal'>

/** What the model returned for one proposal call. */
export interface ProposalReply {
  /** The text blocks joined in stream order; {@link readProposals} validates this text. */
  output: string
  /** The reasoning blocks joined in stream order; empty when the model returned none. */
  reasoning: string
  /** The call's terminal finish reason. */
  finish: FinishReason
}

/**
 * Build the request that asks for two branches after the latest scene.
 * @param route - the provider and model to call.
 * @param scenes - the story so far, oldest first; the first scene's direction is the premise.
 * @param maxTokens - the output cap of the call, in tokens.
 * @returns the complete request without its abort signal.
 */
export function proposalRequest(route: ProposalRoute, scenes: readonly StoryScene[], maxTokens: number): ProposalRequest {
  return {
    ...route,
    system: PROPOSAL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: proposalMessage(scenes) }] }],
    maxTokens,
  }
}

/**
 * Send one proposal request and collect the model's reply.
 * @param llm - the harness LLM service.
 * @param request - the request from {@link proposalRequest}.
 * @param signal - aborts the model call.
 * @returns the reply; a failed or aborted call ends with an `error` or `aborted` finish reason.
 */
export async function requestProposals(llm: Pick<LlmRuntime, 'stream'>, request: ProposalRequest, signal: AbortSignal): Promise<ProposalReply> {
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({ ...request, signal })) assembler.push(chunk)
  const blocks = assembler.blocks()
  return {
    output: blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    reasoning: blocks.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join(''),
    finish: assembler.finish,
  }
}

/**
 * Read two branches from a proposal reply.
 * @param reply - the reply from {@link requestProposals}.
 * @returns two drafts with distinct labels.
 * @throws Error when the call failed or the output is not two valid branches.
 */
export function readProposals(reply: ProposalReply): [BranchDraft, BranchDraft] {
  throwOnFailure(reply.finish)
  return parseProposals(reply.output)
}

/**
 * Turn a failed or aborted model call into an error.
 * @param finish - the call's terminal finish reason.
 * @throws Error carrying the failure message for `error` and `aborted`.
 */
function throwOnFailure(finish: FinishReason): void {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      throw new Error(`Branch proposal failed: ${finish.failure.message}`)
    default:
      // `stop`, `max-tokens`, `tool-calls`, and later kinds leave the reply to JSON validation.
      return
  }
}

/**
 * Validate the model's JSON reply.
 * @param text - the model's text; surrounding prose or code fences are ignored.
 * @returns two drafts with trimmed, nonempty, distinct labels and nonempty directions.
 * @throws Error when the reply holds no JSON object or not exactly two valid branches.
 */
export function parseProposals(text: string): [BranchDraft, BranchDraft] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end < start) throw new Error('Branch proposal reply contains no JSON object.')
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    throw new Error(`Branch proposal reply is not valid JSON: ${(error as Error).message}`)
  }
  const branches = isRecord(parsed) ? parsed['branches'] : undefined
  if (!Array.isArray(branches) || branches.length !== 2) throw new Error('Branch proposal reply must hold two branches.')
  const drafts = branches.map((branch: unknown): BranchDraft => {
    const label = isRecord(branch) ? branch['label'] : undefined
    const direction = isRecord(branch) ? branch['direction'] : undefined
    if (typeof label !== 'string' || !label.trim() || typeof direction !== 'string' || !direction.trim()) {
      throw new Error('Each proposed branch needs a nonempty label and direction.')
    }
    return { label: label.trim(), direction: direction.trim() }
  })
  const [first, second] = drafts as [BranchDraft, BranchDraft]
  if (first.label === second.label) throw new Error('The two proposed branches need different labels.')
  return [first, second]
}

/** Whether a parsed JSON value is an object with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
