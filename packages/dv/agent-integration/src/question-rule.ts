/**
 * The DSH question rule, as the `ToolCallCheck` that the agent integration registers with `dvProject`:
 * the operations that need the user's agreement before the agent calls them get a tool-only argument
 * (`user_approved` for `plan.approve`, `user_requested` for `shot.render`), and a call without that argument asks the
 * user through the agent's question channel, or tells the model to ask in the conversation. The user's agreement is
 * kept in the record's params. The rule only asks: the runner alone enforces the composer's approval card.
 *
 * @module @dv/agent-integration/question-rule
 */
import type { ParameterSchemaSpec, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type DvProject from '@dv/project'
import { toolNameOf } from '@dv/project'
import type {
  OperationSpec, OperationToolCall, ProjectState, RunRequest, ToolCallCheck, TurnId,
} from '@dv/project'
import type { PlanVersion } from '@dv/shot-plan'

/** A question the rule asks when a call needs the user's agreement and no `user_approved` argument carried it. */
export interface ConfirmRequest {
  spec: OperationSpec
  /** The call's reason and params, for the question text. */
  summary: string
  /** The GPU seconds the call and the turn so far are estimated to cost. */
  gpuSeconds: number
  exec: ToolRunContext
  /** The call's params and inputs, for the question that shows the prompt and the references. */
  params?: Record<string, unknown>
  inputs?: RunRequest['inputs']
}

/**
 * Asks the user and answers whether the call may run; null when no interactive channel applies, so the rule falls back
 * to the `user_approved` argument protocol.
 */
export type ConfirmPolicy = (request: ConfirmRequest) => Promise<boolean | null>

/** The operation of the Shot plan component that approves a plan and schedules its shot renders. */
const PLAN_APPROVE = 'plan.approve'

/** The operation of the Shot render component that renders one take; its GPU estimate counts against the turn's budget. */
const SHOT_RENDER = 'shot.render'

/**
 * The question rule of each operation that needs the user's agreement: `always` needs the `user_approved` argument or
 * a yes from the question channel; `cost` needs it only past the turn's GPU budget when the user did not ask for this
 * exact change.
 */
const QUESTION_RULES: Readonly<Record<string, 'cost' | 'always'>> = { [PLAN_APPROVE]: 'always', [SHOT_RENDER]: 'cost' }

/** The shot duration the plan estimate assumes for a shot that names none. */
const PLAN_SHOT_SECONDS = 5

/** What the rule reads: the Project service, the Shot plan reader when mounted, the budget, and the question channel. */
export interface QuestionRuleOptions {
  project: DvProject
  /**
   * The plan version a `plan.approve` call names and the shot positions it would render, or null when the Shot plan
   * component is not mounted or the call names no known plan version.
   */
  planOf(state: ProjectState, plan: unknown, version: unknown): { version: PlanVersion; render: number[] } | null
  /** Estimated GPU seconds a turn may spend on `cost` operations before the user must agree. */
  confirmGpuSecondsThreshold: number
  ask: ConfirmPolicy
}

/**
 * The tool-only arguments the rule adds to an operation's tool.
 * @param name - the operation name.
 * @returns `user_approved` for an `always` rule, `user_requested` for a `cost` rule, else nothing.
 */
function questionParams(name: string): ParameterSchemaSpec {
  const rule = QUESTION_RULES[name]
  if (rule === 'always') {
    return { user_approved: { type: 'boolean', description: 'Set true only after the user agreed to this exact call in the conversation; ask the user first.' } }
  }
  if (rule === 'cost') {
    return {
      user_requested: {
        type: 'boolean', description: 'Set true when the user asked for this exact single change, which needs no further confirmation; '
          + 'otherwise ask the user first when the turn\'s GPU cost exceeds the budget.',
      },
    }
  }
  return {}
}

/**
 * Build the question rule as a tool call check.
 * @param options - the services and the question channel.
 * @returns the check to register with `dvProject.registerToolCallCheck`.
 */
export function questionRule(options: QuestionRuleOptions): ToolCallCheck {
  return {
    params: spec => questionParams(spec.name),
    check: async (spec, call) => {
      await confirm(options, spec, call)
      if (call.args['user_approved'] === true) call.request.params['user_approved'] = true
      if (call.args['user_requested'] === true) call.request.params['user_requested'] = true
    },
  }
}

/** GPU seconds the current turn already spent on the working branch, from the finished records' cost. */
function spentGpuSeconds(state: ProjectState, turn: TurnId | null): number {
  if (turn === null) return 0
  return state.components.proj.records.filter(record => record.turn === turn)
    .reduce((sum, record) => sum + (record.cost?.gpu_seconds ?? 0), 0)
}

/**
 * Apply the rule of the operation (see `QUESTION_RULES`): `always` needs the user's agreement; `cost` needs it only
 * past the turn's GPU budget and when the user did not ask for this exact change. Agreement comes from the
 * `user_approved` or `user_requested` argument, else from the question channel.
 * @throws Error telling the model to ask the user first, or that the user declined.
 */
async function confirm(options: QuestionRuleOptions, spec: OperationSpec, call: OperationToolCall): Promise<void> {
  const { args, state, exec } = call
  const { params, inputs, turn } = call.request
  const rule = QUESTION_RULES[spec.name]
  if (rule === undefined) return
  if (rule === 'always' && args['user_approved'] === true) return
  if (rule === 'cost' && args['user_requested'] === true) return
  const threshold = options.confirmGpuSecondsThreshold
  // A plan approval stands for the shots it renders: the question shows those shots and their cost.
  const plan = spec.name === PLAN_APPROVE ? planShots(options, state, params['plan'], params['version']) : null
  const estimate = (plan === null ? spec.estimate?.(params).gpu_seconds ?? 0 : plan.estimate) + spentGpuSeconds(state, turn)
  if (rule === 'cost' && estimate <= threshold) return
  const summary = `${toolNameOf(spec)}: ${String(args['reason'])}`
  const answer = await options.ask({
    spec, summary, gpuSeconds: estimate, exec, params: plan?.params ?? params, inputs: plan?.inputs ?? inputs,
  })
  if (answer === true) return
  if (answer === false) throw new Error(`The user declined ${toolNameOf(spec)}. Do not retry it unchanged.`)
  const why = rule === 'always'
    ? 'needs the explicit agreement of the user'
    : `would bring this turn to about ${Math.round(estimate)} GPU seconds, above the ${threshold} s budget`
  const flag = rule === 'always' ? 'user_approved: true' : 'user_requested: true'
  throw new Error(`${toolNameOf(spec)} ${why}. Describe what it will do and cost, wait for the user's answer in the conversation, then call again with ${flag}.`)
}

/**
 * What approving a plan version will render, for the approval question: one line per new or changed shot as the
 * prompt, numbered by its shot position, their total duration and references, and their `shot.render` GPU estimate.
 * Shots that keep their takes are left out.
 * @param options - the services.
 * @param state - the state of the session's working branch, which the plan's references are read against.
 * @param plan - the `plan` param of the `plan.approve` call.
 * @param version - the `version` param of the call; the latest version when absent.
 * @returns the question details, or null when the params name no known plan version.
 */
function planShots(
  options: QuestionRuleOptions, state: ProjectState, plan: unknown, version: unknown,
): { params: Record<string, unknown>; inputs: RunRequest['inputs']; estimate: number } | null {
  const found = options.planOf(state, plan, version)
  if (found === null) return null
  const document = found.version
  const shots = found.render.flatMap((position) => {
    const shot = document.shots[position - 1]
    return shot === undefined ? [] : [{ position, shot }]
  })
  const seconds = shots.map(entry => entry.shot.duration_sec ?? PLAN_SHOT_SECONDS)
  const prompt = shots.map((entry, index) => `${entry.position}. ${entry.shot.prompt} (${seconds[index]} s)`).join('\n')
  const references = [...new Set(shots.flatMap(entry => entry.shot.references ?? document.references ?? []))]
  const total = seconds.reduce((sum, value) => sum + value, 0)
  return {
    params: { prompt, duration_sec: total, plan, version: document.version },
    inputs: references.flatMap((ref) => {
      try {
        return options.project.parseInputs(SHOT_RENDER, { reference: ref }, state)
      } catch (error: unknown) {
        // An unknown character leaves the question without it; the approval's precondition refuses the call.
        void error
        return []
      }
    }),
    estimate: options.project.listOperations().find(candidate => candidate.name === SHOT_RENDER)
      ?.estimate?.({ duration_sec: total }).gpu_seconds ?? 0,
  }
}
