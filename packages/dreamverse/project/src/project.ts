/**
 * Own project content, admit browser actions, and dispatch each queued action's complete workflow.
 *
 * User actions choose when to generate video and record a completed sequence. `Project` provides shared
 * generation, round status, and reference-asset release. Automatic continuation queues one action after each
 * successful round until stopped; stop lets the accepted action finish.
 *
 * A `Project` object serves one browser socket and holds the project's lease in `dreamverseProjectStore`, the only
 * write right to the project. Its content is the `dreamverse` workload data (`project-data.ts`) and the files that the
 * project owns in the file store: `create()` stores a new project, `open()` rebuilds a stored one, and every settled
 * segment, recorded sequence, failed round, and closure writes the workload data again, so a later `open()` continues
 * from the last completed sequence.
 *
 * @module @dreamverse/project/project
 */

import type { Buffer } from 'node:buffer'
import { projectOwner } from '@dreamverse/assets-manager'
import { ProjectNotFoundError } from '@dreamverse/project-store'
import {
  continuesPreviousSegment,
  parseReferenceAssetIds,
  segmentImageLabels,
  validateProjectCreation,
  validateReferenceAssets,
  type CreationConfig,
  type SegmentImageLabels,
} from '@dreamverse/segment-generation'
import type {
  AssetRecord,
  DreamverseAssetsManager,
  DreamverseGeneration,
  DreamverseProjectStore,
  DreamversePromptEnhancer,
  DreamverseSegmentGeneration,
  ModelFacts,
  ProjectHolder,
  ProjectLease,
} from './dependencies.ts'
import { PROMPT_TIMEOUT_MS } from './dependencies.ts'
import { DreamverseValueError, ProjectClosedError, ProjectValidationError, errorMessage } from './errors.ts'
import { GenerationPlan, segmentRecord } from './generation-plan.ts'
import { GenerationPlanController } from './generation-plan-controller.ts'
import {
  DREAMVERSE_DATA_SCHEMA_VERSION,
  DREAMVERSE_PROJECT_KIND,
  parseProjectData,
  type DreamverseProjectData,
  type StoredSegment,
} from './project-data.ts'
import { type ActionPayload, isTruthy, payloadGet, pythonFormatG, pythonStr, textOr } from './python-values.ts'
import { VideoSegment, type SegmentSource, type SegmentStatus, type UserInstruction } from './video-segment.ts'

/** One browser socket; the implementation serializes `sendJson` and `sendBytes` through one lock. */
export interface ProjectSocket {
  sendJson(event: object): Promise<void>
  sendBytes(chunk: Buffer): Promise<void>
}

/** The browser socket of a project and the party that holds its lease. */
export interface ProjectConnectionInit {
  socket: ProjectSocket
  /** Receives `revoke()` when another party acquires the project; it must close the project and then resolve. */
  holder: ProjectHolder
}

/** The inputs of `DreamverseProjects.openProject()`. */
export interface ProjectOpenInit extends ProjectConnectionInit {
  projectId: string
}

/** The inputs of `DreamverseProjects.createProject()`; the project store assigns the new project's ID. */
export interface ProjectInit extends ProjectConnectionInit {
  /** The complete `project_init_v1` message. */
  payload: Record<string, unknown>
}

/** The project-owned copies of one queued action's reference images, in selection order. */
export interface UserActionOptions {
  referenceAssets: readonly AssetRecord[]
}

/**
 * Runs one queued action from request through completion. The project releases the action's retained reference
 * images after the handler settles.
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
  /** Stores the project's record and workload data and grants its lease. */
  store: DreamverseProjectStore
  /** Generates segments and stores their files. */
  segmentGeneration: DreamverseSegmentGeneration
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
const BROWSER_SETTING_COMMANDS: ReadonlySet<unknown> = new Set(['set_enhancement'])

/** Settings that `Project.create()` resolves from `project_init_v1`, or `Project.open()` reads from the store. */
interface ProjectCreationFields {
  projectId: string
  lease: ProjectLease
  modelFacts: ModelFacts
  videoGenerationSettings: CreationConfig
  promptSequenceId: unknown
  promptSequenceLabel: string
  promptEnhancementEnabled: boolean
  promptEnhancementModel: string
  title: string
  createdAt: string
  /** Library asset ID to its project-owned copy. */
  referenceCopies: Record<string, string>
  thumbnailAssetId: string | null
}

/** The most code points of the first prompt that a project title keeps. */
const TITLE_PROMPT_LENGTH = 60

/**
 * Name a project: its preset label, else its first prompt cut to `TITLE_PROMPT_LENGTH` code points.
 * @param presetLabel - the stripped `preset_label`.
 * @param firstPrompt - the stripped instruction, or the first curated prompt.
 * @returns the title, or `Untitled project` when both are empty.
 */
function projectTitle(presetLabel: string, firstPrompt: string): string {
  if (presetLabel) return presetLabel
  if (firstPrompt) return Array.from(firstPrompt).slice(0, TITLE_PROMPT_LENGTH).join('')
  return 'Untitled project'
}

const SEGMENT_SOURCES: readonly SegmentSource[] = ['preset', 'user', 'automatic']

/** Whether a stored `source` names a segment source. */
function isSegmentSource(value: string): value is SegmentSource {
  return (SEGMENT_SOURCES as readonly string[]).includes(value)
}

/**
 * Retain and validate the ordered reference images of one action before its asynchronous work starts; port of the
 * reference `_retain_and_validate_action_reference_assets`. A library image that the project has already copied
 * resolves to its copy, so deleting the library image never affects the project.
 * @param assets - the file store.
 * @param modelFacts - the served model's facts.
 * @param generationMode - the project's generation mode.
 * @param referenceCopies - each library asset ID that the project copied, mapped to its copy.
 * @param payload - the action payload.
 * @returns the retained assets in selection order: the project's copies, and the library images not yet copied.
 * @throws {DreamverseValueError} for a rejected selection, including `ProjectValidationError` with reason
 *   `Invalid reference asset` for an absent or deleted asset; nothing stays retained.
 */
function retainActionReferenceAssets(
  assets: DreamverseAssetsManager,
  modelFacts: ModelFacts,
  generationMode: string,
  referenceCopies: ReadonlyMap<string, string>,
  payload: ActionPayload,
): readonly AssetRecord[] {
  const assetIds = parseReferenceAssetIds(payload).map(assetId => referenceCopies.get(assetId) ?? assetId)
  validateReferenceAssets(modelFacts, generationMode, assetIds.length)
  let records: AssetRecord[]
  try {
    records = assets.retain(assetIds)
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AssetNotFoundError')) throw error
    throw new ProjectValidationError(error.message, 'Invalid reference asset')
  }
  try {
    const limit = modelFacts.maxReferenceAspectRatio
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
    assets.release(assetIds)
    throw error
  }
  return records
}

/**
 * Release one action's retained reference assets; an empty selection makes no file store call.
 * @param assets - the file store.
 * @param referenceAssets - the assets to release.
 */
function releaseReferenceAssets(assets: DreamverseAssetsManager, referenceAssets: readonly AssetRecord[]): void {
  if (referenceAssets.length > 0) assets.release(referenceAssets.map(asset => asset.assetId))
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
  readonly segmentGeneration: DreamverseSegmentGeneration
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
  /** The startup rewrite model that browser events and project log events report as `rewrite_model`. */
  readonly promptEnhancementModel: string
  /** The project name that the project list shows. */
  readonly title: string
  /** ISO-8601 UTC creation time. */
  readonly createdAt: string
  autoContinueAfterGeneration = false
  activeGenerationPlan: GenerationPlan | null = null
  generationRoundStatus: GenerationRoundStatus = 'idle'
  private readonly services: ProjectServices
  private readonly lease: ProjectLease
  /** True after `releaseLease()`; `persist()` then writes nothing. */
  private leaseReleased = false
  /** Library asset ID to its project-owned copy, so the project copies each library image once. */
  private readonly referenceCopies: Map<string, string>
  /** The stored thumbnail, the last frame of the last completed segment. */
  private thumbnailAssetId: string | null
  private readonly queuedGenerationActions = new GenerationActionQueue()
  /** Aborted by `closeAndWaitForGeneration()`; stands for cancelling the reference generation-loop task. */
  private readonly generationAbort = new AbortController()
  /** Settles after `processQueuedGenerationActions()` finishes its closure cleanup; null while it is not running. */
  private generationLoop: Promise<void> | null = null

  /** Assign the settings that `create()` resolved or `open()` read; those two are the only callers. */
  private constructor(init: ProjectConnectionInit, services: ProjectServices, fields: ProjectCreationFields) {
    this.projectId = fields.projectId
    this.lease = fields.lease
    this.socket = init.socket
    this.services = services
    this.generation = services.generation
    this.segmentGeneration = services.segmentGeneration
    this.promptEnhancer = services.promptEnhancer
    this.referenceCopies = new Map(Object.entries(fields.referenceCopies))
    this.thumbnailAssetId = fields.thumbnailAssetId
    this.modelFacts = fields.modelFacts
    this.videoGenerationSettings = fields.videoGenerationSettings
    this.promptSequenceId = fields.promptSequenceId
    this.promptSequenceLabel = fields.promptSequenceLabel
    this.promptEnhancementEnabled = fields.promptEnhancementEnabled
    this.promptEnhancementModel = fields.promptEnhancementModel
    this.title = fields.title
    this.createdAt = fields.createdAt
    this.generationPlanController = new GenerationPlanController(this)
  }

  /**
   * Validate project choices and retain complete inputs before any generation work starts, then store the project and
   * take its lease. The validation steps and their order follow the reference `Project.__init__`.
   * @param init - the `project_init_v1` message, the browser socket, and the lease holder.
   * @param services - the generation client, file store, prompt enhancer, user-action registry, project log, project
   *   store, and segment generation.
   * @returns the stored project, with its initial action queued when the message supplies prompts or an instruction.
   * @throws {ProjectValidationError} for rejected creation choices, Auto Extension choices, or reference assets.
   * @throws Error that is not a `DreamverseValueError` when the generation backend cannot report its model facts.
   */
  static async create(init: ProjectInit, services: ProjectServices): Promise<Project> {
    const { payload } = init
    const modelFacts = await services.generation.model()
    const promptSequenceId = payloadGet(payload, 'preset_id')
    const promptSequenceLabel = textOr(payload['preset_label'], '').trim()
    const promptEnhancementEnabled = isTruthy(payloadGet(payload, 'enhancement_enabled', true))
    const promptEnhancementModel = services.promptEnhancer.rewriteModel()
    const rawInstruction = textOr(payload['initial_rollout_prompt'], '').trim()
    const incoming = payloadGet(payload, 'curated_prompts', [])
    const prompts = Array.isArray(incoming)
      ? incoming.filter((prompt): prompt is string => typeof prompt === 'string' && prompt.trim() !== '')
        .map(prompt => prompt.trim())
      : []
    const videoGenerationSettings = validateProjectCreation(payload, modelFacts)
    const autoExtensionEnabled = payloadGet(payload, 'auto_extension_enabled', false)
    if (typeof autoExtensionEnabled !== 'boolean') {
      throw new ProjectValidationError('auto_extension_enabled must be a boolean.', 'Invalid Auto extension')
    }
    const hasGenerationRequest = rawInstruction !== '' || prompts.length > 0
    if (autoExtensionEnabled && !hasGenerationRequest) {
      throw new ProjectValidationError('Auto extension must be selected with a generation request.',
        'Invalid Auto extension')
    }
    if (isTruthy(payload['loop_generation_enabled'])) {
      throw new ProjectValidationError('Sequence replay is not supported.', 'Unsupported sequence replay')
    }
    let referenceAssets: readonly AssetRecord[]
    try {
      referenceAssets = retainActionReferenceAssets(services.assets, modelFacts,
        videoGenerationSettings.generation_mode, new Map(), payload)
    } catch (error) {
      if (!(error instanceof DreamverseValueError)) throw error
      throw new ProjectValidationError(error.message, 'Invalid reference assets')
    }
    if (!hasGenerationRequest) {
      releaseReferenceAssets(services.assets, referenceAssets)
      referenceAssets = []
    }
    const title = projectTitle(promptSequenceLabel, rawInstruction || (prompts[0] ?? ''))
    let project: Project
    try {
      const data: DreamverseProjectData = {
        creation_config: videoGenerationSettings, prompt_enhancement_enabled: promptEnhancementEnabled,
        prompt_sequence_id: promptSequenceId ?? null, prompt_sequence_label: promptSequenceLabel, segments: [],
        completed_sequences: [], reference_copies: {},
      }
      const record = services.store.create({
        kind: DREAMVERSE_PROJECT_KIND, title, workload: { schemaVersion: DREAMVERSE_DATA_SCHEMA_VERSION, data },
      })
      const lease = await services.store.acquire(record.projectId, init.holder)
      project = new Project(init, services, {
        projectId: record.projectId, lease, modelFacts, videoGenerationSettings, promptSequenceId, promptSequenceLabel,
        promptEnhancementEnabled, promptEnhancementModel, title, createdAt: record.createdAt, referenceCopies: {},
        thumbnailAssetId: null,
      })
    } catch (error) {
      releaseReferenceAssets(services.assets, referenceAssets)
      throw error
    }
    project.autoContinueAfterGeneration = autoExtensionEnabled
    if (hasGenerationRequest) {
      const action: ActionPayload = {
        type: 'generate_video_sequence', prompt: rawInstruction,
        prompt_id: payloadGet(payload, 'initial_prompt_id'), prompts,
      }
      project.generationRoundStatus = 'preparing'
      project.queuedGenerationActions.put({ payload: action, referenceAssets })
    }
    return project
  }

  /**
   * Take the lease of a stored project and rebuild it for a new browser socket. Segments that were pending or
   * generating when the previous socket closed become `cancelled`. The last segment of the last completed sequence
   * becomes the plan controller's last completed segment, so the project can continue that sequence. The project
   * starts idle without Auto Extension.
   * @param init - the project ID, the browser socket, and the lease holder; a socket that holds the project receives
   *   `revoke()` first and closes it.
   * @param services - the generation client, file store, prompt enhancer, user-action registry, project log, project
   *   store, and segment generation.
   * @returns the project, which holds the lease.
   * @throws {ProjectValidationError} with reason `Project not found` when the store holds no `dreamverse` project with
   *   this ID, `Model unavailable` when the project's model is not the served model, and `Invalid reference asset`
   *   when one of its reference assets is unavailable; the lease is released.
   * @throws Error when the stored workload data is invalid or the generation backend cannot report its model facts.
   */
  static async open(init: ProjectOpenInit, services: ProjectServices): Promise<Project> {
    // Check the kind before acquiring, so a request for another workload's project never revokes that workload.
    if (services.store.get(init.projectId)?.kind !== DREAMVERSE_PROJECT_KIND) {
      throw new ProjectValidationError('Project not found.', 'Project not found')
    }
    let lease: ProjectLease
    try {
      lease = await services.store.acquire(init.projectId, init.holder)
    } catch (error) {
      if (!(error instanceof ProjectNotFoundError)) throw error
      throw new ProjectValidationError('Project not found.', 'Project not found')
    }
    try {
      return await Project.restore(init, services, lease)
    } catch (error) {
      services.store.release(lease)
      throw error
    }
  }

  /**
   * Rebuild a stored project from the record that the lease's revoked holder wrote last.
   * @param init - the project ID, the browser socket, and the lease holder.
   * @param services - the project's services.
   * @param lease - the project's lease.
   * @returns the project.
   */
  private static async restore(init: ProjectOpenInit, services: ProjectServices, lease: ProjectLease): Promise<Project> {
    const record = services.store.get(init.projectId)
    if (record === undefined) throw new ProjectValidationError('Project not found.', 'Project not found')
    if (record.workload.schemaVersion !== DREAMVERSE_DATA_SCHEMA_VERSION) {
      throw new Error(`Project ${init.projectId} has DreamVerse data schema ${record.workload.schemaVersion}; `
        + `this server reads schema ${DREAMVERSE_DATA_SCHEMA_VERSION}.`)
    }
    const data = parseProjectData(record.workload.data)
    const modelFacts = await services.generation.model()
    const config = data.creation_config
    if (config.model_id !== modelFacts.modelId) {
      throw new ProjectValidationError(
        `This project was created with ${config.model_id}; this server serves ${modelFacts.modelId}.`, 'Model unavailable')
    }
    const project = new Project(init, services, {
      projectId: record.projectId, lease, modelFacts, videoGenerationSettings: config,
      promptSequenceId: data.prompt_sequence_id, promptSequenceLabel: data.prompt_sequence_label,
      promptEnhancementEnabled: data.prompt_enhancement_enabled,
      promptEnhancementModel: services.promptEnhancer.rewriteModel(), title: record.title, createdAt: record.createdAt,
      referenceCopies: data.reference_copies, thumbnailAssetId: record.thumbnailAssetId,
    })
    for (const stored of data.segments) project.videoSegmentsById.set(stored.segment_id, project.restoreSegment(stored))
    for (const sequence of data.completed_sequences) {
      if (sequence.some(segmentId => !project.videoSegmentsById.has(segmentId))) {
        throw new Error(`Project ${init.projectId} records a completed sequence with an unknown segment.`)
      }
      project.completedSequenceHistory.push(sequence)
    }
    const lastSegmentId = project.completedSequenceSegmentIds.at(-1)
    if (lastSegmentId !== undefined && project.videoSegmentsById.get(lastSegmentId)?.status === 'completed') {
      project.generationPlanController.lastCompletedSegmentId = lastSegmentId
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
        this.persist()
      } finally {
        finishLoop()
      }
    }
  }

  /**
   * Stop prompt waits and future submissions, abandon the segment in progress, wait for the generation loop to
   * finish its closure cleanup, release the reference assets of actions that closure prevents from running, and
   * store the project's final workload data. The project keeps its lease until `releaseLease()`.
   */
  async closeAndWaitForGeneration(): Promise<void> {
    this.isClosed = true
    this.autoContinueAfterGeneration = false
    this.generationAbort.abort(new ProjectClosedError())
    try {
      if (this.generationLoop !== null) await this.generationLoop
    } finally {
      this.releaseQueuedActionReferenceAssets()
      this.persist()
    }
  }

  /**
   * Register display order and model-required dependencies for complete segment inputs. `continuesPreviousSegment`
   * decides which segments continue the segment before them.
   * @param segments - the new segment records of one generation call.
   * @param options - `append` extends the latest completed sequence instead of replacing it.
   * @returns the validated plan; its segments join `videoSegmentsById`.
   * @throws {DreamverseValueError} when the round is empty, has nothing to append to, or cannot run.
   */
  registerSegmentsAndBuildGenerationPlan(segments: VideoSegment[], options: { append?: boolean } = {}): GenerationPlan {
    const append = options.append ?? false
    if (segments.length === 0) throw new DreamverseValueError('A generation round requires at least one video segment.')
    const completedIds = this.completedSequenceSegmentIds
    let previousId = append ? completedIds.at(-1) ?? null : null
    if (append && previousId === null) throw new DreamverseValueError('Generate a video before continuing it.')
    for (const [index, segment] of segments.entries()) {
      const position = { append, index, referenceCount: segment.referenceAssets.length }
      if (continuesPreviousSegment(this.modelFacts, this.videoGenerationSettings.generation_mode, position)) {
        segment.referenceSegmentId = previousId
      }
      previousId = segment.segmentId
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
    this.persist()
  }

  /**
   * Write the project's workload data to the store, and set the thumbnail to the last frame of the last segment of
   * the last completed sequence; callers store a segment's files before the data that names them. After
   * `releaseLease()` it writes nothing.
   * @throws {StaleLeaseError} when another party has taken the project.
   */
  persist(): void {
    if (this.leaseReleased) return
    this.services.store.updateWorkload(this.lease, { schemaVersion: DREAMVERSE_DATA_SCHEMA_VERSION, data: this.projectData() })
    const thumbnailAssetId = this.completedSequenceSegments.at(-1)?.lastFrameAssetId ?? null
    if (thumbnailAssetId !== this.thumbnailAssetId) {
      this.services.store.setThumbnail(this.lease, thumbnailAssetId)
      this.thumbnailAssetId = thumbnailAssetId
    }
  }

  /** Give up the project's lease after `closeAndWaitForGeneration()`; the project writes nothing more. */
  releaseLease(): void {
    this.leaseReleased = true
    this.services.store.release(this.lease)
  }

  /**
   * @param assetId - the ID of a file that the project uses, such as a segment's last frame.
   * @returns the file's record.
   * @throws Error `AssetNotFoundError` when the file is absent or deleted.
   */
  assetRecord(assetId: string): AssetRecord {
    return this.services.assets.get(assetId)
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
   * Name the images that a segment's request will carry, such as `Picture 1`, for the prompt enhancer. Registration
   * with the same round position gives the segment the predecessor that these labels assume.
   * @param position - whether the round appends, the segment's index in it (default 0), and its reference count.
   * @returns the reference image labels and, for a segment that continues a predecessor, the first-frame label.
   */
  promptImageLabels(position: { append?: boolean; index?: number; referenceCount: number }): SegmentImageLabels {
    const generationMode = this.videoGenerationSettings.generation_mode
    const continuesPrevious = continuesPreviousSegment(this.modelFacts, generationMode, {
      append: position.append ?? false, index: position.index ?? 0, referenceCount: position.referenceCount,
    })
    return segmentImageLabels(this.modelFacts, generationMode, position.referenceCount, continuesPrevious)
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
      referenceAssets = this.retainReferenceAssets(payload)
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
   * Run one action with shared status, failure reporting, and reference-asset release. The handler receives the
   * project-owned copies of the action's reference images.
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
        await this.dispatchGenerationAction(payload, await this.projectReferenceCopies(referenceAssets))
      } finally {
        // The action has finished its accepted video work before its reference assets are released.
        try {
          releaseReferenceAssets(this.services.assets, referenceAssets)
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
    this.persist()
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
   * @param referenceAssets - the project-owned copies of the action's reference images.
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
   * The new segment continues the previous output. Reference-conditioned models also retain the preceding shot's
   * ordered assets for this round.
   * @throws {DreamverseValueError} when no completed video exists or its reference assets are unavailable.
   */
  private queueAutomaticVideoContinuation(): void {
    if (this.isClosed || !this.autoContinueAfterGeneration || this.generationRoundStatus !== 'idle') return
    const latestSegment = this.completedSequenceSegments.at(-1)
    if (latestSegment === undefined) throw new DreamverseValueError('Auto extension requires a completed video.')
    let referenceAssets: readonly AssetRecord[] = []
    if (this.modelFacts.generationModes[this.videoGenerationSettings.generation_mode] === 'reference_images') {
      referenceAssets = this.retainReferenceAssets({
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
      releaseReferenceAssets(this.services.assets, action.referenceAssets)
    }
  }

  /**
   * @param payload - the action payload.
   * @returns the action's retained reference images; see `retainActionReferenceAssets`.
   */
  private retainReferenceAssets(payload: ActionPayload): readonly AssetRecord[] {
    return retainActionReferenceAssets(this.services.assets, this.modelFacts,
      this.videoGenerationSettings.generation_mode, this.referenceCopies, payload)
  }

  /**
   * Map an action's reference images to copies that this project owns. A library image is copied on its first use and
   * its copy is reused afterwards; an image that the project already owns is used as it is.
   * @param referenceAssets - the action's retained reference images, in selection order.
   * @returns the project-owned copies in the same order.
   */
  private async projectReferenceCopies(referenceAssets: readonly AssetRecord[]): Promise<AssetRecord[]> {
    const owner = projectOwner(this.projectId)
    const copies: AssetRecord[] = []
    for (const asset of referenceAssets) {
      const copyId = asset.owner === owner ? asset.assetId : this.referenceCopies.get(asset.assetId)
      if (copyId !== undefined) {
        copies.push(this.services.assets.get(copyId))
        continue
      }
      const copy = await this.services.assets.copy(asset.assetId, owner)
      this.referenceCopies.set(asset.assetId, copy.assetId)
      copies.push(copy)
    }
    return copies
  }

  /**
   * Rebuild one stored segment. A pending or generating segment becomes `cancelled`, since the socket that ran it has
   * closed.
   * @param stored - the segment record.
   * @returns the segment with its outcome.
   * @throws {ProjectValidationError} with reason `Invalid reference asset` when a reference asset is unavailable.
   * @throws Error for a stored source that names no segment source.
   */
  private restoreSegment(stored: StoredSegment): VideoSegment {
    if (!isSegmentSource(stored.source)) throw new Error(`Stored segment ${stored.segment_id} has unknown source ${stored.source}.`)
    let referenceAssets: AssetRecord[]
    try {
      referenceAssets = stored.reference_asset_ids.map(assetId => this.services.assets.get(assetId))
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AssetNotFoundError')) throw error
      throw new ProjectValidationError(error.message, 'Invalid reference asset')
    }
    const segment = new VideoSegment({
      prompt: stored.prompt, creationConfig: this.videoGenerationSettings, source: stored.source,
      instruction: stored.instruction && { requestId: stored.instruction.request_id, text: stored.instruction.text },
      enhanced: stored.enhanced, sequenceIndex: stored.sequence_index, segmentId: stored.segment_id,
      referenceSegmentId: stored.reference_segment_id, referenceAssets, createdAt: stored.created_at,
    })
    segment.mime = stored.mime
    segment.error = stored.error
    segment.videoAssetId = stored.video_asset_id
    segment.lastFrameAssetId = stored.last_frame_asset_id
    const status: SegmentStatus = stored.status === 'completed' || stored.status === 'failed' ? stored.status : 'cancelled'
    segment.status = status
    if (status === 'cancelled' && stored.status !== 'cancelled') segment.error = 'Project disconnected.'
    return segment
  }

  /** @returns the project's complete workload data. */
  private projectData(): DreamverseProjectData {
    return {
      creation_config: this.videoGenerationSettings,
      prompt_enhancement_enabled: this.promptEnhancementEnabled,
      prompt_sequence_id: this.promptSequenceId ?? null,
      prompt_sequence_label: this.promptSequenceLabel,
      segments: [...this.videoSegmentsById.values()].map(segment => ({
        segment_id: segment.segmentId,
        prompt: segment.prompt,
        source: segment.source,
        instruction: segment.instruction && { request_id: segment.instruction.requestId, text: segment.instruction.text },
        enhanced: segment.enhanced,
        sequence_index: segment.sequenceIndex,
        reference_segment_id: segment.referenceSegmentId,
        reference_asset_ids: segment.referenceAssets.map(asset => asset.assetId),
        video_asset_id: segment.videoAssetId,
        last_frame_asset_id: segment.lastFrameAssetId,
        status: segment.status,
        error: segment.error,
        mime: segment.mime,
        created_at: segment.createdAt,
      })),
      completed_sequences: this.completedSequenceHistory.map(sequence => [...sequence]),
      reference_copies: Object.fromEntries(this.referenceCopies),
    }
  }
}
