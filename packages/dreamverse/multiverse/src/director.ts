/**
 * `dreamverseMultiverseDirector`: grows multiverse trees. It creates a multiverse, copies its character references into
 * the multiverse's project, generates its root, proposes two branches under every generated node through the harness
 * LLM service, and generates the branch the user chooses.
 *
 * A node's generation follows the shared generation rules of `@dreamverse/segment-generation`: the prompt enhancer
 * writes the complete prompt with the image labels those rules give, and `dreamverseSegmentGeneration` generates the
 * segment and stores its video and last frame as files of the multiverse's project. A branch is the next segment after
 * its parent: it starts from the parent's last frame when the rules continue segments for the served model.
 *
 * The director is the only writer of multiverse projects. It holds a project's lease only while it works on that
 * multiverse (copying references, generating a node, proposing branches) and releases it when no work remains;
 * another party that takes the lease aborts that work.
 *
 * Every prompt enhancement and branch proposal writes its complete request and what the model returned to the
 * multiverse log under `logRoot` (see `./event-log.ts`); a failed log write only warns.
 *
 * @module @dreamverse/multiverse/director
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
import { AssetNotFoundError, projectOwner, type AssetId, type AssetRecord } from '@dreamverse/assets-manager'
import type DreamverseAssetsManager from '@dreamverse/assets-manager'
import { DreamverseValueError } from '@dreamverse/generation-client'
import type DreamverseGeneration from '@dreamverse/generation-client'
import { ProjectNotFoundError, type ProjectId, type ProjectLease } from '@dreamverse/project-store'
import type DreamverseProjectStore from '@dreamverse/project-store'
import type DreamversePromptEnhancer from '@dreamverse/prompt-enhancer'
import type { PromptResult } from '@dreamverse/prompt-enhancer'
import {
  continuesPreviousSegment,
  parseReferenceAssetIds,
  segmentImageLabels,
  validateProjectCreation,
  validateReferenceAssets,
  type CreationConfig,
  type SegmentImageLabels,
} from '@dreamverse/segment-generation'
import type DreamverseSegmentGeneration from '@dreamverse/segment-generation'
import { proposalRequest, readProposals, requestProposals } from './branch-proposals.ts'
import { MultiverseRequestError } from './errors.ts'
import { MultiverseEventLog, type MultiverseLogEvent } from './event-log.ts'
import type { BranchDraft, Multiverse, MultiverseNode, MultiverseTree, NodeId } from './tree.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Creates multiverses, generates chosen nodes, and proposes branches. */
    dreamverseMultiverseDirector: MultiverseDirector
  }
}

/** The tree label of every multiverse's root node. */
const ROOT_LABEL = 'Beginning'

/** The director's work on one multiverse and the project lease that the pieces of work share. */
interface MultiverseWork {
  /** Pieces of work that have started and not finished. */
  count: number
  /** The lease being acquired for this work. */
  readonly lease: Promise<ProjectLease>
  /** The lease once granted; releasing it ends the work's hold on the project. */
  granted: ProjectLease | null
  /** Aborted when another party takes the project's lease. */
  readonly abort: AbortController
  /** Resolves when the last piece of work ends. */
  readonly idle: Promise<void>
  readonly settleIdle: () => void
}

/**
 * The failure message that a node records.
 * @param error - the caught value.
 * @returns the error message, or the string form of a non-Error value.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Director configuration. */
export interface Config {
  /** Directory under which the director writes the multiverse log, `<hostname>/<yymmdd_HHMMSS_ffffff>.jsonl`. */
  logRoot: string
  /** Output cap, in tokens, of one branch-proposal call. */
  proposalMaxTokens: number
}

/** Creates multiverses and runs their generations and branch proposals in the background. */
export class MultiverseDirector extends Service {
  static inject = [
    'dreamverseMultiverseTree', 'dreamverseProjectStore', 'dreamverseSegmentGeneration', 'dreamverseGeneration',
    'dreamversePromptEnhancer', 'dreamverseAssetsManager', 'llm', 'agentDefaultModel',
  ]

  static Config: z<Config> = z.object({
    logRoot: z.string().required(),
    proposalMaxTokens: z.natural().min(1).required(),
  })

  /** Aborted when the plugin unloads; stops prompt, generation, and proposal requests. */
  private readonly abort = new AbortController()
  /** The current work and lease of each multiverse that the director is writing. */
  private readonly work = new Map<ProjectId, MultiverseWork>()
  /** The multiverse log file that this director start writes. */
  private readonly eventLog: MultiverseEventLog
  /** Output cap, in tokens, of one branch-proposal call. */
  private readonly proposalMaxTokens: number

  /**
   * @param ctx - owning plugin context.
   * @param config - the multiverse log root and the branch-proposal output cap.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'dreamverseMultiverseDirector')
    this.eventLog = new MultiverseEventLog(config.logRoot)
    this.proposalMaxTokens = config.proposalMaxTokens
    ctx.effect(() => () => { this.abort.abort() }, 'multiverse director')
  }

  private get tree(): MultiverseTree {
    return this.ctx.dreamverseMultiverseTree
  }

  private get store(): DreamverseProjectStore {
    return this.ctx.dreamverseProjectStore
  }

  private get segments(): DreamverseSegmentGeneration {
    return this.ctx.dreamverseSegmentGeneration
  }

  private get generation(): DreamverseGeneration {
    return this.ctx.dreamverseGeneration
  }

  private get assets(): DreamverseAssetsManager {
    return this.ctx.dreamverseAssetsManager
  }

  private get promptEnhancer(): DreamversePromptEnhancer {
    return this.ctx.dreamversePromptEnhancer
  }

  /**
   * Create a multiverse project from a creation request, copy the chosen library images into it, and start generating
   * its root.
   * @param request - the request body: `prompt`, `reference_asset_ids` (library images), `segment_duration_sec`, and
   *   the optional `enhancement_enabled` (default true); other creation fields follow the shared creation rules.
   * @returns the new multiverse, whose root is generating.
   * @throws {MultiverseRequestError} for a missing prompt, rejected creation choices, or unusable references.
   */
  async create(request: Record<string, unknown>): Promise<Multiverse> {
    const prompt = typeof request['prompt'] === 'string' ? request['prompt'].trim() : ''
    if (!prompt) throw new MultiverseRequestError('A multiverse needs a prompt.')
    const enhancementEnabled = request['enhancement_enabled'] ?? true
    if (typeof enhancementEnabled !== 'boolean') throw new MultiverseRequestError('enhancement_enabled must be a boolean.')
    const modelFacts = await this.generation.model()
    let assetIds: AssetId[]
    let creationConfig: CreationConfig
    try {
      creationConfig = validateProjectCreation({ ...request, segment_count: 1 }, modelFacts)
      assetIds = parseReferenceAssetIds(request)
      validateReferenceAssets(modelFacts, creationConfig.generation_mode, assetIds.length)
    } catch (error) {
      if (error instanceof DreamverseValueError) throw new MultiverseRequestError(error.message)
      throw error
    }
    const libraryImages = assetIds.map(assetId => this.libraryImage(assetId))
    const multiverse = this.tree.create({ creationConfig, enhancementEnabled, rootLabel: ROOT_LABEL, rootDirection: prompt })
    const { multiverseId } = multiverse
    try {
      await this.withLease(multiverseId, async (lease) => {
        const copies: AssetId[] = []
        for (const image of libraryImages) copies.push((await this.assets.copy(image.assetId, projectOwner(multiverseId))).assetId)
        this.tree.setReferences(multiverseId, copies)
        this.tree.save(lease, multiverseId)
      })
    } catch (error) {
      // A multiverse without its references cannot generate; remove the project and the copies made so far.
      this.tree.drop(multiverseId)
      this.store.delete(multiverseId)
      throw error
    }
    this.startGeneration(multiverseId, multiverse.rootId)
    return multiverse
  }

  /**
   * Generate a proposed branch, or a failed node again. Only one node of a multiverse generates at a time. A proposed
   * node's parent is always generated, because the director proposes branches only under generated nodes.
   * @param multiverseId - the multiverse.
   * @param nodeId - the chosen node.
   * @throws {MultiverseRequestError} while another node generates, or when the node is generating or generated.
   */
  choose(multiverseId: ProjectId, nodeId: NodeId): void {
    const node = this.tree.node(multiverseId, nodeId)
    if ([...this.tree.get(multiverseId).nodes.values()].some(other => other.status === 'generating')) {
      throw new MultiverseRequestError('Wait for the current scene to finish generating.')
    }
    if (node.status !== 'proposed' && node.status !== 'failed') {
      throw new MultiverseRequestError(`This scene is already ${node.status}.`)
    }
    this.startGeneration(multiverseId, nodeId)
  }

  /**
   * Propose branches again under a generated node whose earlier proposal failed.
   * @param multiverseId - the multiverse.
   * @param nodeId - the generated node.
   * @throws {MultiverseRequestError} when the node is not generated or already has branches.
   */
  propose(multiverseId: ProjectId, nodeId: NodeId): void {
    const node = this.tree.node(multiverseId, nodeId)
    if (node.status !== 'completed') throw new MultiverseRequestError('Only a generated scene can branch.')
    if (this.tree.children(multiverseId, nodeId).length > 0) {
      throw new MultiverseRequestError('This scene already has branches.')
    }
    void this.withLease(multiverseId, async (lease, signal) => { await this.proposeUnder(lease, multiverseId, nodeId, signal) })
      .catch((error: unknown) => { this.workFailed(multiverseId, error) })
  }

  /**
   * Read a library image that a creation request names.
   * @param assetId - the asset ID from the request.
   * @returns the library file.
   * @throws {MultiverseRequestError} when the file is absent or belongs to a project.
   */
  private libraryImage(assetId: AssetId): AssetRecord {
    let asset: AssetRecord
    try {
      asset = this.assets.get(assetId)
    } catch (error) {
      if (error instanceof AssetNotFoundError) throw new MultiverseRequestError(error.message)
      throw error
    }
    if (asset.owner !== 'library') {
      throw new MultiverseRequestError(`Asset '${assetId}' is unavailable. Select an asset from the library.`)
    }
    return asset
  }

  /** Mark a node generating now, then generate it and propose its branches in the background. */
  private startGeneration(multiverseId: ProjectId, nodeId: NodeId): void {
    this.tree.markGenerating(multiverseId, nodeId)
    void this.withLease(multiverseId, async (lease, signal) => {
      this.tree.save(lease, multiverseId)
      if (await this.generateNode(lease, multiverseId, nodeId, signal)) await this.proposeUnder(lease, multiverseId, nodeId, signal)
    }).catch((error: unknown) => { this.workFailed(multiverseId, error) })
  }

  /**
   * Handle background work that ended before it could record its own outcome: a deleted project leaves the tree,
   * and an abort leaves the nodes as they are; anything else is logged.
   * @param multiverseId - the multiverse.
   * @param error - the failure.
   */
  private workFailed(multiverseId: ProjectId, error: unknown): void {
    if (error instanceof ProjectNotFoundError) {
      this.tree.drop(multiverseId)
      return
    }
    if (this.abort.signal.aborted) return
    this.ctx.logger('multiverse').warn(`Multiverse ${multiverseId} work failed: ${errorMessage(error)}`)
  }

  /**
   * Append one event to the multiverse log. A failed write only warns, so logging never fails the work that logs.
   * @param event - the event name.
   * @param multiverseId - the multiverse.
   * @param payload - the event fields.
   */
  private logEvent(event: MultiverseLogEvent, multiverseId: ProjectId, payload: Record<string, unknown>): void {
    try {
      this.eventLog.write(event, multiverseId, payload)
    } catch (error) {
      this.ctx.logger('multiverse').warn(`Failed to write multiverse log (${event}): ${errorMessage(error)}`)
    }
  }

  /**
   * Run one piece of work on a multiverse while holding its project's lease. Pieces of work on the same multiverse
   * share one lease, acquired when the first piece starts and released when the last piece ends. Another party that
   * takes the lease aborts the work through the signal that `run` receives.
   * @param multiverseId - the multiverse.
   * @param run - the work; it receives the lease and the abort signal.
   * @returns the work's result.
   * @throws {ProjectNotFoundError} when the multiverse's project is gone.
   */
  private async withLease<T>(multiverseId: ProjectId, run: (lease: ProjectLease, signal: AbortSignal) => Promise<T>): Promise<T> {
    const work = this.work.get(multiverseId) ?? this.startWork(multiverseId)
    work.count += 1
    try {
      const lease = await work.lease
      work.granted = lease
      return await run(lease, AbortSignal.any([this.abort.signal, work.abort.signal]))
    } finally {
      work.count -= 1
      if (work.count === 0) this.finishWork(multiverseId, work)
    }
  }

  /**
   * Begin the director's hold on a multiverse's project: acquire its lease with a holder whose revocation aborts the
   * work and waits for it to end.
   * @param multiverseId - the multiverse.
   * @returns the new work record.
   */
  private startWork(multiverseId: ProjectId): MultiverseWork {
    const abort = new AbortController()
    let settleIdle = (): void => {}
    const idle = new Promise<void>((resolve) => { settleIdle = resolve })
    const lease = this.store.acquire(multiverseId, {
      revoke: async () => {
        abort.abort(new Error('Another party took the multiverse project.'))
        await idle
      },
    })
    const work: MultiverseWork = { count: 0, lease, granted: null, abort, idle, settleIdle }
    this.work.set(multiverseId, work)
    return work
  }

  /**
   * End the director's hold on a multiverse's project after its last piece of work.
   * @param multiverseId - the multiverse.
   * @param work - the work record whose pieces have all ended.
   */
  private finishWork(multiverseId: ProjectId, work: MultiverseWork): void {
    if (this.work.get(multiverseId) === work) this.work.delete(multiverseId)
    if (work.granted !== null) this.store.release(work.granted)
    work.settleIdle()
  }

  /**
   * Write the node's prompt, generate its video as the segment after its parent, and store the result. A failure marks
   * the node failed; an abort leaves it as it is.
   * @param lease - the multiverse project's lease.
   * @param multiverseId - the multiverse.
   * @param nodeId - a generating node.
   * @param signal - aborts the prompt and generation requests.
   * @returns whether the node completed.
   */
  private async generateNode(lease: ProjectLease, multiverseId: ProjectId, nodeId: NodeId, signal: AbortSignal): Promise<boolean> {
    try {
      const multiverse = this.tree.get(multiverseId)
      const node = this.tree.node(multiverseId, nodeId)
      const parent = node.parentId === null ? null : this.tree.node(multiverseId, node.parentId)
      const modelFacts = await this.generation.model()
      const config = multiverse.creationConfig
      const referenceAssets = multiverse.referenceAssetIds.map(assetId => this.assets.get(assetId))
      const referenceCount = referenceAssets.length
      const continuesParent = parent !== null
        && continuesPreviousSegment(modelFacts, config.generation_mode, { append: true, index: 0, referenceCount })
      const labels = segmentImageLabels(modelFacts, config.generation_mode, referenceCount, continuesParent)
      const prompt = multiverse.enhancementEnabled
        ? await this.enhancePrompt(multiverse, node, parent, labels, signal)
        : node.direction
      this.tree.setPrompt(multiverseId, nodeId, prompt)
      const previousLastFrame = continuesParent && parent.lastFrameAssetId !== null ? this.assets.get(parent.lastFrameAssetId) : null
      const generated = await this.segments.generate({
        prompt,
        frameWidth: config.frame_width,
        frameHeight: config.frame_height,
        numFrames: config.num_frames,
        generationMode: config.generation_mode,
        referenceAssets,
        previousLastFrame,
        owner: projectOwner(multiverseId),
        name: nodeId,
        signal,
      })
      this.tree.markCompleted(multiverseId, nodeId, generated.video.assetId, generated.lastFrame.assetId)
      this.tree.save(lease, multiverseId)
      return true
    } catch (error) {
      if (signal.aborted) return false
      this.tree.markFailed(multiverseId, nodeId, errorMessage(error))
      this.tree.save(lease, multiverseId)
      return false
    }
  }

  /**
   * Expand the root's prompt, or continue the story along the path to a branch, with the prompt enhancer. The
   * multiverse log records the operation with every input the enhancer receives, then the enhancer's result or failure.
   * @param multiverse - the node's multiverse.
   * @param node - the node to generate.
   * @param parent - the node's parent, or null for the root.
   * @param labels - the image labels that the node's request uses.
   * @param signal - aborts the provider requests.
   * @returns the complete prompt.
   * @throws Error when the provider falls back or returns nothing.
   */
  private async enhancePrompt(
    multiverse: Multiverse,
    node: MultiverseNode,
    parent: MultiverseNode | null,
    labels: SegmentImageLabels,
    signal: AbortSignal,
  ): Promise<string> {
    const { multiverseId } = multiverse
    const config = multiverse.creationConfig
    const options = {
      generationMode: config.generation_mode,
      segmentDurationSec: config.segment_duration_sec,
      referenceLabels: labels.referenceLabels,
      signal,
    }
    const inputs = {
      direction: node.direction, generation_mode: options.generationMode,
      segment_duration_sec: options.segmentDurationSec, reference_labels: options.referenceLabels,
      rewrite_model: this.promptEnhancer.rewriteModel(),
    }
    let pending: Promise<PromptResult>
    if (parent === null) {
      this.logEvent('prompt_enhance_request', multiverseId, { node_id: node.nodeId, operation: 'expand_clip', ...inputs })
      pending = this.promptEnhancer.expandClip(node.direction, options)
    } else {
      const history = this.tree.pathToRoot(multiverseId, parent.nodeId).map(scene => scene.prompt ?? scene.direction)
      const request = { ...options, lockedSegments: history, nextSegmentIdx: history.length + 1, firstFrameLabel: labels.firstFrameLabel }
      this.logEvent('prompt_enhance_request', multiverseId, {
        node_id: node.nodeId, operation: 'continue_video', ...inputs, locked_segments: request.lockedSegments,
        next_segment_idx: request.nextSegmentIdx, first_frame_label: request.firstFrameLabel,
      })
      pending = this.promptEnhancer.continueVideo(node.direction, request)
    }
    let result: PromptResult
    try {
      result = await pending
    } catch (error) {
      this.logEvent('prompt_enhance_response', multiverseId, {
        node_id: node.nodeId, prompt: null, provider: null, model: null, latency_ms: null, fallback_used: null, error: errorMessage(error),
      })
      throw error
    }
    this.logEvent('prompt_enhance_response', multiverseId, {
      node_id: node.nodeId, prompt: result.prompt, provider: result.provider, model: result.model, latency_ms: result.latencyMs,
      fallback_used: result.fallbackUsed, error: result.error,
    })
    const prompt = result.prompt.trim()
    if (result.fallbackUsed || !prompt) throw new Error(`Prompt enhancement failed: ${result.error ?? 'empty prompt'}`)
    return prompt
  }

  /**
   * Propose two branches under a generated node with the harness's default model, add them to the tree, and save the
   * tree. A failure is recorded on the node so the user can retry.
   * @param lease - the multiverse project's lease.
   * @param multiverseId - the multiverse.
   * @param nodeId - the generated node.
   * @param signal - aborts the model request.
   */
  private async proposeUnder(lease: ProjectLease, multiverseId: ProjectId, nodeId: NodeId, signal: AbortSignal): Promise<void> {
    try {
      const drafts = await this.requestBranches(multiverseId, nodeId, signal)
      this.tree.setError(multiverseId, nodeId, null)
      for (const draft of drafts) this.tree.addProposal(multiverseId, nodeId, draft)
    } catch (error) {
      if (signal.aborted) return
      this.tree.setError(multiverseId, nodeId, errorMessage(error))
    }
    this.tree.save(lease, multiverseId)
  }

  /**
   * Ask the harness's default model for two branches after the story up to a node. The multiverse log records the
   * complete request before it is sent, then the model's output and finish reason with the branches or the failure.
   * @param multiverseId - the multiverse.
   * @param nodeId - the generated node.
   * @param signal - aborts the model request.
   * @returns two drafts with distinct labels.
   * @throws Error when the call fails or the reply is not two valid branches.
   */
  private async requestBranches(multiverseId: ProjectId, nodeId: NodeId, signal: AbortSignal): Promise<[BranchDraft, BranchDraft]> {
    const scenes = this.tree.pathToRoot(multiverseId, nodeId).map(scene => ({ label: scene.label, direction: scene.direction }))
    const request = proposalRequest(this.ctx.agentDefaultModel.currentSelection(), scenes, this.proposalMaxTokens)
    this.logEvent('branch_proposal_request', multiverseId, {
      node_id: nodeId, provider: request.provider, model: request.model, reasoning_effort: request.reasoningEffort ?? null,
      system: request.system, messages: request.messages, max_tokens: request.maxTokens,
    })
    const reply = await requestProposals(this.ctx.llm, request, signal)
    const responseFields = { node_id: nodeId, output: reply.output, reasoning: reply.reasoning, finish_reason: reply.finish }
    let drafts: [BranchDraft, BranchDraft]
    try {
      drafts = readProposals(reply)
    } catch (error) {
      this.logEvent('branch_proposal_response', multiverseId, { ...responseFields, branches: null, error: errorMessage(error) })
      throw error
    }
    this.logEvent('branch_proposal_response', multiverseId, { ...responseFields, branches: drafts, error: null })
    return drafts
  }
}

export default MultiverseDirector
