/**
 * Own project content, admit browser actions, and dispatch each queued action's complete workflow.
 *
 * User actions choose when to generate video and record a completed sequence. `Project` provides shared
 * generation, round status, and reference-asset release. Automatic continuation queues one action after each
 * successful round until stopped; stop lets the accepted action finish.
 *
 * @module @dreamverse/project/project
 */

import type { Buffer } from 'node:buffer'
import type {
  AssetRecord,
  DreamverseAssetsManager,
  DreamverseGeneration,
  DreamversePromptEnhancer,
  ModelFacts,
} from './dependencies.ts'
import { PROMPT_TIMEOUT_MS } from './dependencies.ts'
import { DreamverseValueError, ProjectClosedError, ProjectValidationError, errorMessage } from './errors.ts'
import { GenerationPlan, segmentRecord } from './generation-plan.ts'
import { GenerationPlanController } from './generation-plan-controller.ts'
import {
  parseReferenceAssetIds,
  validateProjectCreation,
  validateReferenceAssets,
  type CreationConfig,
} from './project-creation.ts'
import { type ActionPayload, isTruthy, payloadGet, pythonFormatG, pythonStr, textOr } from './python-values.ts'
import { VideoSegment, type SegmentSource, type UserInstruction } from './video-segment.ts'

/** One browser socket; the implementation serializes `sendJson` and `sendBytes` through one lock. */
export interface ProjectSocket {
  sendJson(event: object): Promise<void>
  sendBytes(chunk: Buffer): Promise<void>
}

/** The inputs of `DreamverseProjects.createProject()`. */
export interface ProjectInit {
  projectId: string
  /** The complete `project_init_v1` message. */
  payload: Record<string, unknown>
  socket: ProjectSocket
}

/** Reference assets retained for one queued action, in selection order. */
export interface UserActionOptions {
  referenceAssets: readonly AssetRecord[]
}

/**
 * Runs one queued action from request through completion. The project releases the action's reference assets after
 * the handler settles.
 */
export type UserActionHandler = (
  project: Project,
  payload: ActionPayload,
  options: UserActionOptions,
) => Promise<void>

/** One user-action plugin's handler and the action types it serves. */
export interface UserActionRegistration {
  actionTypes: string[]
  handler: UserActionHandler
}

/** Services and service-owned functions that a project calls. */
export interface ProjectServices {
  generation: DreamverseGeneration
  assets: DreamverseAssetsManager
  promptEnhancer: DreamversePromptEnhancer
  /** Finds the handler registered for an action type when the project dispatches it. */
  resolveUserAction(actionType: string): UserActionHandler | undefined
  /** Writes one project log entry; a write failure only warns. */
  logProjectEvent(projectId: string, event: string, payload?: Record<string, unknown>): Promise<void>
}

/** Admission state reported to the browser: generation-changing commands wait until `idle` or `failed`. */
export type GenerationRoundStatus = 'preparing' | 'generating' | 'idle' | 'failed'

/** An admitted action with the reference assets it retains until execution or project closure. */
interface QueuedGenerationAction {
  payload: ActionPayload
  referenceAssets: readonly AssetRecord[]
}

/** Browser commands that queue a generation action. */
const BROWSER_GENERATION_COMMANDS: ReadonlySet<unknown> = new Set(['append_prompt', 'rewrite_seed_prompts', 'simple_generate'])

/** Browser settings commands admitted under the same round rules as generation commands. */
const BROWSER_SETTING_COMMANDS: ReadonlySet<unknown> = new Set(['set_enhancement', 'set_rewrite_model', 'set_rewrite_temperature'])

/** Settings that `Project.create()` resolves from `project_init_v1` before constructing the project. */
interface ProjectCreationFields {
  modelFacts: ModelFacts
  videoGenerationSettings: CreationConfig
  promptSequenceId: unknown
  promptSequenceLabel: string
  promptEnhancementEnabled: boolean
  promptEnhancementModel: string
  sequencePromptTemperature: number
  sequenceRewriteSystemPromptOverride: string
  sequenceCreationSystemPromptOverride: string
}

/** FIFO of admitted actions with one consumer, the project's generation loop. */
class GenerationActionQueue {
  private readonly actions: QueuedGenerationAction[] = []
  private wake: (() => void) | null = null

  put(action: QueuedGenerationAction): void {
    this.actions.push(action)
    this.wake?.()
  }

  /**
   * Wait for the next action. An aborted signal returns null and leaves queued actions for closure to release,
   * as cancelling the reference loop's `Queue.get()` does.
   * @param signal - the project's generation signal.
   * @returns the next action, or null after the signal aborts.
   */
  async get(signal: AbortSignal): Promise<QueuedGenerationAction | null> {
    while (this.actions.length === 0 && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal.removeEventListener('abort', wake)
          this.wake = null
          resolve()
        }
        this.wake = wake
        signal.addEventListener('abort', wake)
      })
    }
    return signal.aborted ? null : this.actions.shift() ?? null
  }

  /** @returns the oldest queued action without waiting, or undefined when the queue is empty. */
  takeNext(): QueuedGenerationAction | undefined {
    return this.actions.shift()
  }
}

/** Segment records, completed sequences, and action admission for one browser project. */
export class Project {
  readonly projectId: string
  readonly socket: ProjectSocket
  readonly generation: DreamverseGeneration
  readonly promptEnhancer: DreamversePromptEnhancer
  readonly modelFacts: ModelFacts
  /** `ProjectCreationConfig.as_dict()` of the validated creation choices. */
  readonly videoGenerationSettings: CreationConfig
  readonly promptEnhancementTimeoutMs = PROMPT_TIMEOUT_MS
  readonly videoSegmentsById = new Map<string, VideoSegment>()
  readonly completedSequenceHistory: (readonly string[])[] = []
  readonly generationPlanController: GenerationPlanController
  isClosed = false
  promptSequenceId: unknown
  promptSequenceLabel: string
  promptEnhancementEnabled: boolean
  promptEnhancementModel: string
  sequencePromptTemperature: number
  sequenceRewriteSystemPromptOverride: string
  sequenceCreationSystemPromptOverride: string
  autoContinueAfterGeneration = false
  activeGenerationPlan: GenerationPlan | null = null
  generationRoundStatus: GenerationRoundStatus = 'idle'
  private readonly services: ProjectServices
  private readonly queuedGenerationActions = new GenerationActionQueue()
  /** Aborted by `closeAndWaitForGeneration()`; stands for cancelling the reference generation-loop task. */
  private readonly generationAbort = new AbortController()
  /** Settles after `processQueuedGenerationActions()` finishes its closure cleanup; null while it is not running. */
  private generationLoop: Promise<void> | null = null

  /** Assign the settings that `create()` resolved; `create()` is the only caller. */
  private constructor(init: ProjectInit, services: ProjectServices, fields: ProjectCreationFields) {
    this.projectId = init.projectId
    this.socket = init.socket
    this.services = services
    this.generation = services.generation
    this.promptEnhancer = services.promptEnhancer
    this.modelFacts = fields.modelFacts
    this.videoGenerationSettings = fields.videoGenerationSettings
    this.promptSequenceId = fields.promptSequenceId
    this.promptSequenceLabel = fields.promptSequenceLabel
    this.promptEnhancementEnabled = fields.promptEnhancementEnabled
    this.promptEnhancementModel = fields.promptEnhancementModel
    this.sequencePromptTemperature = fields.sequencePromptTemperature
    this.sequenceRewriteSystemPromptOverride = fields.sequenceRewriteSystemPromptOverride
    this.sequenceCreationSystemPromptOverride = fields.sequenceCreationSystemPromptOverride
    this.generationPlanController = new GenerationPlanController(this)
  }

  /**
   * Validate project choices and retain complete inputs before any generation work starts. The steps and their
   * order follow the reference `Project.__init__`.
   * @param init - the project ID, the `project_init_v1` message, and the browser socket.
   * @param services - the generation client, asset library, prompt enhancer, user-action registry, and project log.
   * @returns the project, with its initial action queued when the message supplies prompts or an instruction.
   * @throws {ProjectValidationError} for rejected creation choices, Auto Extension choices, or reference assets.
   * @throws Error that is not a `DreamverseValueError` when the generation backend cannot report its model facts.
   */
  static async create(init: ProjectInit, services: ProjectServices): Promise<Project> {
    const { payload } = init
    const modelFacts = await services.generation.model()
    const promptSequenceId = payloadGet(payload, 'preset_id')
    const promptSequenceLabel = textOr(payload['preset_label'], '').trim()
    const promptEnhancementEnabled = isTruthy(payloadGet(payload, 'enhancement_enabled', true))
    const promptEnhancementModel = services.promptEnhancer.resolveRewriteModel(payloadGet(payload, 'rewrite_model'))
    const sequencePromptTemperature = services.promptEnhancer.resolveRewriteTemperature(
      payloadGet(payload, 'rewrite_temperature'))
    const sequenceRewriteSystemPromptOverride = textOr(payload['rewrite_window_system_prompt'], '').trim()
    const sequenceCreationSystemPromptOverride = textOr(payload['rewrite_user_system_prompt'], '').trim()
    const rawInstruction = textOr(payload['initial_rollout_prompt'], '').trim()
    const incoming = payloadGet(payload, 'curated_prompts', [])
    const prompts = Array.isArray(incoming)
      ? incoming.filter((prompt): prompt is string => typeof prompt === 'string' && prompt.trim() !== '')
        .map(prompt => prompt.trim())
      : []
    const videoGenerationSettings = validateProjectCreation(payload, modelFacts)
    const project = new Project(init, services, {
      modelFacts, videoGenerationSettings, promptSequenceId, promptSequenceLabel, promptEnhancementEnabled,
      promptEnhancementModel, sequencePromptTemperature, sequenceRewriteSystemPromptOverride,
      sequenceCreationSystemPromptOverride,
    })
    const autoExtensionEnabled = payloadGet(payload, 'auto_extension_enabled', false)
    if (typeof autoExtensionEnabled !== 'boolean') {
      throw new ProjectValidationError('auto_extension_enabled must be a boolean.', 'Invalid Auto extension')
    }
    if (autoExtensionEnabled && !(rawInstruction || prompts.length > 0)) {
      throw new ProjectValidationError('Auto extension must be selected with a generation request.',
        'Invalid Auto extension')
    }
    project.autoContinueAfterGeneration = autoExtensionEnabled
    if (isTruthy(payload['loop_generation_enabled'])) {
      throw new ProjectValidationError('Sequence replay is not supported.', 'Unsupported sequence replay')
    }
    const action: ActionPayload = {
      type: 'generate_video_sequence', prompt: rawInstruction,
      prompt_id: payloadGet(payload, 'initial_prompt_id'), prompts,
    }
    let referenceAssets: readonly AssetRecord[]
    try {
      referenceAssets = project.retainAndValidateActionReferenceAssets(payload)
    } catch (error) {
      if (!(error instanceof DreamverseValueError)) throw error
      throw new ProjectValidationError(error.message, 'Invalid reference assets')
    }
    if (rawInstruction || prompts.length > 0) {
      project.generationRoundStatus = 'preparing'
      project.queuedGenerationActions.put({ payload: action, referenceAssets })
    } else {
      project.releaseReferenceAssets(referenceAssets)
    }
    return project
  }

  /** The display order of the latest completed sequence, or an empty list before the first success. */
  get completedSequenceSegmentIds(): readonly string[] {
    return this.completedSequenceHistory.at(-1) ?? []
  }

  get completedSequenceSegments(): VideoSegment[] {
    return this.completedSequenceSegmentIds.map(segmentId => segmentRecord(this.videoSegmentsById, segmentId))
  }

  get completedSequencePrompts(): string[] {
    return this.completedSequenceSegments.map(segment => segment.prompt)
  }

  /** Aborts when the project closes; generation requests and prompt waits observe it. */
  get generationSignal(): AbortSignal {
    return this.generationAbort.signal
  }

  /**
   * Admit an action at receipt so requests during preparation or generation cannot run later. The reference checks
   * run in order: closure, stop, allowlist, Auto Extension, and the round status. A generation command retains its
   * reference assets and joins the queue before this call first yields.
   * @param payload - one browser message other than `project_init_v1` and `leave`.
   * @returns a promise that settles once this command is admitted, applied, or rejected with a browser error event.
   */
  async processBrowserCommand(payload: ActionPayload): Promise<void> {
    if (this.isClosed) return
    const command = payloadGet(payload, 'type')
    if (command === 'stop_auto_extension') {
      this.autoContinueAfterGeneration = false
      await this.sendGenerationRoundStatus()
      return
    }
    if (!BROWSER_GENERATION_COMMANDS.has(command) && !BROWSER_SETTING_COMMANDS.has(command)) {
      await this.sendBrowserEvent({ type: 'error', message: `Unsupported project action: ${pythonStr(command)}.` })
      return
    }
    const promptId = payloadGet(payload, 'prompt_id')
    if (this.autoContinueAfterGeneration) {
      await this.sendBrowserEvent({ type: 'error', prompt_id: promptId,
        message: 'Stop Auto extension and wait for this round before changing the video.' })
      return
    }
    if (this.generationRoundStatus === 'preparing' || this.generationRoundStatus === 'generating') {
      await this.sendBrowserEvent({ type: 'error', prompt_id: promptId,
        message: 'Wait for this generation round to finish before changing the video.' })
      return
    }
    if (command === 'set_enhancement') {
      this.promptEnhancementEnabled = isTruthy(payloadGet(payload, 'enabled', this.promptEnhancementEnabled))
    } else if (command === 'set_rewrite_model') {
      this.promptEnhancementModel = this.promptEnhancer.resolveRewriteModel(payloadGet(payload, 'rewrite_model'))
    } else if (command === 'set_rewrite_temperature') {
      this.sequencePromptTemperature = this.promptEnhancer.resolveRewriteTemperature(
        payloadGet(payload, 'rewrite_temperature'))
    } else {
      await this.admitGenerationCommand(structuredClone(payload))
    }
  }

  /**
   * Serve admitted rounds until the project closes. Closure through `closeAndWaitForGeneration()` resolves; a
   * failure that is not `DreamverseValueError`-kind rejects after the browser receives the failed round status, as
   * in the reference.
   */
  async processQueuedGenerationActions(): Promise<void> {
    let finishLoop!: () => void
    this.generationLoop = new Promise((resolve) => { finishLoop = resolve })
    try {
      if (this.generationRoundStatus === 'idle') await this.sendGenerationRoundStatus()
      while (!this.isClosed) {
        const action = await this.queuedGenerationActions.get(this.generationSignal)
        if (action === null) break
        await this.executeQueuedGenerationAction(action)
      }
    } catch (error) {
      if (!(error instanceof ProjectClosedError)) throw error
    } finally {
      this.isClosed = true
      this.autoContinueAfterGeneration = false
      this.activeGenerationPlan = null
      for (const segment of this.videoSegmentsById.values()) {
        if (segment.status === 'pending' || segment.status === 'generating') {
          segment.status = 'cancelled'
          segment.error = 'Project disconnected.'
        }
      }
      this.generationLoop = null
      try {
        this.releaseQueuedActionReferenceAssets()
      } finally {
        finishLoop()
      }
    }
  }

  /**
   * Stop prompt waits and future submissions, abandon the segment in progress, wait for the generation loop to
   * finish its closure cleanup, and release the reference assets of actions that closure prevents from running.
   */
  async closeAndWaitForGeneration(): Promise<void> {
    this.isClosed = true
    this.autoContinueAfterGeneration = false
    this.generationAbort.abort()
    try {
      if (this.generationLoop !== null) await this.generationLoop
    } finally {
      this.releaseQueuedActionReferenceAssets()
    }
  }

  /**
   * Register display order and model-required dependencies for complete segment inputs.
   * @param segments - the new segment records of one generation call.
   * @param options - `append` extends the latest completed sequence instead of replacing it.
   * @returns the validated plan; its segments join `videoSegmentsById`.
   * @throws {DreamverseValueError} when the round is empty, has nothing to append to, or cannot run.
   */
  registerSegmentsAndBuildGenerationPlan(segments: VideoSegment[], options: { append?: boolean } = {}): GenerationPlan {
    const append = options.append ?? false
    if (segments.length === 0) throw new DreamverseValueError('A generation round requires at least one video segment.')
    const completedIds = this.completedSequenceSegmentIds
    let predecessor = append ? completedIds.at(-1) ?? null : null
    if (append && predecessor === null) throw new DreamverseValueError('Generate a video before continuing it.')
    // A supplied first frame starts the appended shot from that image. Text-only continuation reuses the previous
    // shot; later shots can still form a chain.
    if (append && (segments[0]?.referenceAssets.length ?? 0) > 0) predecessor = null
    if (this.modelFacts.usesPreviousFrame) {
      for (const segment of segments) {
        segment.referenceSegmentId = predecessor
        predecessor = segment.segmentId
      }
    }
    const segmentIds = segments.map(segment => segment.segmentId)
    const plan = new GenerationPlan(segmentIds, [...(append ? completedIds : []), ...segmentIds], append)
    plan.validate(new Map([...this.videoSegmentsById, ...segments.map(segment => [segment.segmentId, segment] as const)]))
    for (const segment of segments) this.videoSegmentsById.set(segment.segmentId, segment)
    return plan
  }

  /**
   * Publish generation status and stream the segments selected by an action.
   * @param plan - the registered plan.
   */
  async executeGenerationPlan(plan: GenerationPlan): Promise<void> {
    this.activeGenerationPlan = plan
    this.generationRoundStatus = 'generating'
    await this.sendGenerationRoundStatus()
    await this.generationPlanController.execute(plan)
  }

  /**
   * Retain the display sequence that an action has finished generating.
   * @param sequenceIds - the plan's `sequenceIds`.
   */
  recordCompletedSequence(sequenceIds: readonly string[]): void {
    this.completedSequenceHistory.push(sequenceIds)
  }

  /**
   * Build a complete model input with the project's creation config and attach its origin.
   * @param prompt - the final prompt text.
   * @param options - origin, reference assets, and the optional instruction, enhancement flag, and sequence index.
   * @returns a pending segment that is not yet registered.
   */
  buildVideoSegment(prompt: string, options: {
    source: SegmentSource
    referenceAssets: readonly AssetRecord[]
    instruction?: UserInstruction | null
    enhanced?: boolean
    sequenceIndex?: number | null
  }): VideoSegment {
    return new VideoSegment({ prompt, creationConfig: this.videoGenerationSettings, ...options })
  }

  /**
   * Send one JSON event on the project socket.
   * @param event - the browser event with reference snake_case keys.
   */
  async sendBrowserEvent(event: Record<string, unknown>): Promise<void> {
    await this.socket.sendJson(event)
  }

  /**
   * Record one project log event; a write failure only warns.
   * @param event - the event name.
   * @param payload - the event fields.
   */
  async logProjectEvent(event: string, payload?: Record<string, unknown>): Promise<void> {
    await this.services.logProjectEvent(this.projectId, event, payload)
  }

  /**
   * Build the prompt enhancer's ordered image labels, such as `Picture 1`.
   * @param count - the number of reference assets.
   * @returns the served model's first `count` labels; models without numbered references return none.
   */
  buildPromptImageLabels(count: number): string[] {
    return this.modelFacts.referenceLabels.slice(0, count)
  }

  /**
   * Await one prompt-enhancer operation until the project closes. Callers pass `generationSignal` to the prompt
   * enhancer so closure also stops its provider requests; the operation's late result or failure is discarded.
   * @param start - starts the operation; it is not started when the project has already closed.
   * @returns the operation's result.
   * @throws {ProjectClosedError} when the project closes first.
   */
  async awaitPromptWork<T>(start: () => Promise<T>): Promise<T> {
    const signal = this.generationSignal
    if (signal.aborted) throw new ProjectClosedError()
    let onAbort!: () => void
    const closed = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new ProjectClosedError()) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([start(), closed])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Retain and validate the ordered reference images of one action before its asynchronous work starts; port of the
   * reference `_retain_and_validate_action_reference_assets`.
   * @param payload - the action payload.
   * @returns the retained assets in selection order.
   * @throws {DreamverseValueError} for a rejected selection, including `ProjectValidationError` with reason
   *   `Invalid reference asset` for an absent or deleted asset; nothing stays retained.
   */
  retainAndValidateActionReferenceAssets(payload: ActionPayload): readonly AssetRecord[] {
    const assetIds = parseReferenceAssetIds(payload)
    validateReferenceAssets(this.modelFacts, this.videoGenerationSettings.generation_mode, assetIds.length)
    let records: AssetRecord[]
    try {
      records = this.services.assets.retain(assetIds)
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AssetNotFoundError')) throw error
      throw new ProjectValidationError(error.message, 'Invalid reference asset')
    }
    try {
      const limit = this.modelFacts.maxReferenceAspectRatio
      for (const record of records) {
        if (record.mediaType !== 'image') throw new DreamverseValueError('This generation workflow accepts reference images only.')
        // Library images always carry their pixel size.
        const [width, height] = [record.width ?? 0, record.height ?? 0]
        if (limit !== null && Math.max(width, height) / Math.min(width, height) > limit) {
          const bound = pythonFormatG(limit)
          throw new DreamverseValueError(`Reference image aspect ratio must be between 1:${bound} and ${bound}:1.`)
        }
      }
    } catch (error) {
      this.services.assets.release(assetIds)
      throw error
    }
    return records
  }

  /**
   * Validate the Auto Extension choice, retain the command's reference assets, and queue it.
   * @param payload - a private copy of the browser command.
   */
  private async admitGenerationCommand(payload: ActionPayload): Promise<void> {
    const promptId = payloadGet(payload, 'prompt_id')
    const autoExtensionEnabled = payloadGet(payload, 'auto_extension_enabled', false)
    if (typeof autoExtensionEnabled !== 'boolean') {
      await this.sendBrowserEvent({ type: 'error', prompt_id: promptId, message: 'auto_extension_enabled must be a boolean.' })
      return
    }
    let referenceAssets: readonly AssetRecord[]
    try {
      referenceAssets = this.retainAndValidateActionReferenceAssets(payload)
    } catch (error) {
      if (!(error instanceof DreamverseValueError)) throw error
      await this.sendBrowserEvent({ type: 'error', prompt_id: promptId, message: error.message })
      return
    }
    this.autoContinueAfterGeneration = autoExtensionEnabled
    this.generationRoundStatus = 'preparing'
    this.queuedGenerationActions.put({ payload, referenceAssets })
  }

  /**
   * Run one action with shared status, failure reporting, and reference-asset release.
   * @param action - the queued action and its retained reference assets.
   */
  private async executeQueuedGenerationAction(action: QueuedGenerationAction): Promise<void> {
    const { payload, referenceAssets } = action
    const completedSequenceCount = this.completedSequenceHistory.length
    const promptSequenceId = this.promptSequenceId
    const promptSequenceLabel = this.promptSequenceLabel
    this.activeGenerationPlan = null
    try {
      try {
        await this.sendGenerationRoundStatus()
        await this.logProjectEvent('generation_round_start', {
          action: payload['type'], reference_asset_ids: referenceAssets.map(asset => asset.assetId),
        })
        await this.dispatchGenerationAction(payload, referenceAssets)
      } finally {
        // The action has finished its accepted video work before its reference assets are released.
        try {
          this.releaseReferenceAssets(referenceAssets)
        } catch (error) {
          // A failed release prevents acceptance of this round's content.
          this.completedSequenceHistory.splice(completedSequenceCount)
          this.promptSequenceId = promptSequenceId
          this.promptSequenceLabel = promptSequenceLabel
          throw error
        }
      }
    } catch (error) {
      if (error instanceof ProjectClosedError) throw error
      await this.failGenerationRound(payload, error)
      return
    }
    this.activeGenerationPlan = null
    this.generationRoundStatus = 'idle'
    try {
      this.queueAutomaticVideoContinuation()
    } catch (error) {
      if (!(error instanceof DreamverseValueError)) throw error
      this.autoContinueAfterGeneration = false
      this.generationRoundStatus = 'failed'
      await this.logProjectEvent('auto_extension_failed', { error: error.message })
      await this.sendBrowserEvent({ type: 'error', message: error.message })
    }
    await this.sendGenerationRoundStatus()
  }

  /**
   * Settle a failed round: stop Auto Extension, mark unfinished segments failed, and report the failure.
   * @param payload - the failed action.
   * @param error - the failure; a `DreamverseValueError` reaches the browser and keeps the project open, any other
   *   failure is rethrown after the failed round status.
   */
  private async failGenerationRound(payload: ActionPayload, error: unknown): Promise<void> {
    const message = errorMessage(error)
    this.autoContinueAfterGeneration = false
    for (const segment of this.videoSegmentsById.values()) {
      if (segment.status === 'pending' || segment.status === 'generating') {
        segment.status = 'failed'
        segment.error = message
      }
    }
    this.activeGenerationPlan = null
    this.generationRoundStatus = 'failed'
    await this.logProjectEvent('generation_round_failed', { action: payloadGet(payload, 'type'), error: message })
    if (error instanceof DreamverseValueError) {
      await this.sendBrowserEvent({ type: 'error', message, prompt_id: payloadGet(payload, 'prompt_id') })
    }
    await this.sendGenerationRoundStatus()
    if (!(error instanceof DreamverseValueError)) throw error
  }

  /**
   * Select the registered handler that owns the queued action from request through completion.
   * @param payload - the queued action.
   * @param referenceAssets - the action's retained reference assets.
   * @throws {DreamverseValueError} when no user-action plugin serves the action type.
   */
  private async dispatchGenerationAction(payload: ActionPayload, referenceAssets: readonly AssetRecord[]): Promise<void> {
    const actionType = payload['type']
    const handler = typeof actionType === 'string' ? this.services.resolveUserAction(actionType) : undefined
    if (handler === undefined) throw new DreamverseValueError(`Unsupported project action: ${pythonStr(actionType)}`)
    await handler(this, payload, { referenceAssets })
  }

  /**
   * Claim the next Auto Extension round after a successful round, using the accepted video and reference images.
   *
   * First-frame models continue their previous output. Reference-conditioned models retain the preceding shot's
   * ordered assets for this round.
   * @throws {DreamverseValueError} when no completed video exists or its reference assets are unavailable.
   */
  private queueAutomaticVideoContinuation(): void {
    if (this.isClosed || !this.autoContinueAfterGeneration || this.generationRoundStatus !== 'idle') return
    const latestSegment = this.completedSequenceSegments.at(-1)
    if (latestSegment === undefined) throw new DreamverseValueError('Auto extension requires a completed video.')
    let referenceAssets: readonly AssetRecord[] = []
    if (this.modelFacts.generationModes[this.videoGenerationSettings.generation_mode] === 'reference_images') {
      referenceAssets = this.retainAndValidateActionReferenceAssets({
        reference_asset_ids: latestSegment.referenceAssets.map(asset => asset.assetId),
      })
    }
    this.generationRoundStatus = 'preparing'
    this.queuedGenerationActions.put({ payload: { type: 'auto_extend' }, referenceAssets })
  }

  private async sendGenerationRoundStatus(): Promise<void> {
    await this.sendBrowserEvent({
      type: 'generation_round_status', status: this.generationRoundStatus,
      auto_extension_enabled: this.autoContinueAfterGeneration,
    })
  }

  /** Release the reference assets of actions that project closure prevents from running. */
  private releaseQueuedActionReferenceAssets(): void {
    for (let action = this.queuedGenerationActions.takeNext(); action !== undefined;
      action = this.queuedGenerationActions.takeNext()) {
      this.releaseReferenceAssets(action.referenceAssets)
    }
  }

  /**
   * Release one action's retained reference assets; an empty selection makes no asset library call.
   * @param referenceAssets - the assets to release.
   */
  private releaseReferenceAssets(referenceAssets: readonly AssetRecord[]): void {
    if (referenceAssets.length > 0) this.services.assets.release(referenceAssets.map(asset => asset.assetId))
  }
}
