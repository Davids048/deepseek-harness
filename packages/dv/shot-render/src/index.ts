/**
 * The Shot render component of DreamVerse as the `dvShotRender` Cordis service: the Consumer of the render mode seams
 * of `@dv/render-modes`. It owns one operation per render mode, each registered only while its render mode service is
 * mounted, so the agent sees only the tools it can use:
 *
 * - `shot.render_ref2va` (tool `dv_shot_render_ref2va`, service `dvRef2va`): one take of a shot from a prompt and 1 to N
 *   reference images (the images of the characters, locations and styles it names), and optionally a first frame, usually
 *   the last still of the shot it continues;
 * - `shot.render_t2va` (tool `dv_shot_render_t2va`, service `dvT2va`): one take of a shot from a prompt only.
 *
 * The provider's model facts decide the frame size and frame count. Every render stores the video and its last still as
 * two outputs (`video`, `last_still`), so a later shot can start from output `#1`. The component's reducer groups the
 * takes of each shot in the `shot` slice for every render mode. While the optional live stream service is mounted, the
 * video bytes also go to browsers as the provider produces them.
 *
 * @module @dv/shot-render
 */
import { randomInt } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@dv/asset-pool'
import type {
  AssetId, OperationContext, OperationInput, OperationResult, OperationSpec, OperationToolCall, ProjectId, ProjectRecord, ProjectState,
  RecordId, RecordInputRef, RunRequest,
} from '@dv/project'
import type { RenderModelFacts, RenderStreamEvent, Ref2vaRenderer, T2vaRenderer } from '@dv/render-modes'
import { shotReducer } from './reducer.ts'
import { backendSeconds, baseMime, imageLabels, number, shotGeometry, text, type ShotGeometry } from './render.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Shot render component: one take of a shot per render operation call. */
    dvShotRender: DvShotRender
  }
}

/** `dvShotRender` plugin configuration: none; each render mode provider reports its GPU rate in its model facts. */
export type Config = Record<string, unknown>

/** Loader validation. */
export const Config: z<Config> = z.object({})

/** The seed range of the render backends. */
const SEED_LIMIT = 2 ** 31

/** The duration the GPU estimate assumes for a call that names none. */
const ESTIMATE_DURATION_SEC = 5

/** The render modes of Shot render, each with its operation and its service. */
type RenderMode = 'ref2va' | 't2va'

/**
 * Where a shot's bytes go while the provider is still producing them, so browsers can watch the shot render: the
 * structural type of the optional live stream service's `openSegment`.
 */
interface LiveShotSink {
  openSegment(projectId: ProjectId, record: RecordId, init: { mime: string; segmentIdx: number }): {
    chunk(bytes: Uint8Array): void
    complete(): void
    fail(error: Error): void
  }
}

/** The live stream of one shot, or null while no sink is mounted. */
type LiveShot = ReturnType<LiveShotSink['openSegment']> | null

/** The tool-only argument of `dv_shot_render_ref2va` that names the take whose last still the new shot starts from. */
const CONTINUE_FROM_PARAM: ParameterSchemaSpec = {
  continue_from: { type: 'string', description: 'A render record whose last_still (output #1) this shot starts from.' },
}

/** The params every render operation shares: the prompt, the shot's geometry and seed, and the plan that scheduled it. */
const RENDER_PARAMS = (prompt: string): OperationSpec['params'] => ({
  prompt: { type: 'string', required: true, description: prompt },
  duration_sec: { type: 'integer', description: 'Whole seconds within the model range; default the model minimum.' },
  aspect_ratio: { type: 'string', description: 'One of the model aspect ratios; default the first.' },
  resolution: { type: 'string', description: 'One of the model resolutions; default the first.' },
  seed: { type: 'integer', description: 'Fixed seed; omitted, a random seed is drawn and recorded.' },
  // Set when an approved plan schedules the render; the live stream shows the shot position.
  plan: { type: 'string', description: 'The plan ID (p1, p2, …) whose approval scheduled this render; set by dv_plan_approve.' },
  plan_version: { type: 'integer', description: 'The approved version of that plan; set by dv_plan_approve.' },
  shot: { type: 'integer', description: 'The shot position in that version, 1 = first; set by dv_plan_approve.' },
})

/** The inputs of `shot.render_ref2va`. */
const REF2VA_INPUTS: Record<string, OperationInput> = {
  reference: {
    type: 'image', many: true, bible: true,
    description: 'Reference images, or character, location and style versions whose reference images the shot carries, in prompt '
      + 'order. At least one reference image.',
  },
  first_frame: { type: 'image', description: 'The frame the shot starts from, usually output #1 of the previous shot.' },
}

/** The sentence every render description ends with. */
const TAKE_RULE = 'Outputs: the video, then its last still. Every call is a new take; a changed prompt for the same shot passes based_on.'

/**
 * The resolved assets of an input role, in input order.
 * @param context - the running call.
 * @param role - the role.
 * @returns the assets.
 */
function inputAssets(context: Pick<OperationContext, 'inputs'>, role: string): AssetId[] {
  return context.inputs.filter(input => input.role === role)
    .map(input => input.resolved_asset)
    .filter((asset): asset is AssetId => asset !== null)
}

/** The Shot render service: one render operation per mounted render mode, the `shot` reducer, and the method they run. */
export default class DvShotRender extends Service {
  static inject = ['dvProject', 'dvAssetPool']
  static Config = Config

  /** The `ref2va` render mode while it is mounted. */
  private ref2va: Ref2vaRenderer | null = null
  /** The `t2va` render mode while it is mounted. */
  private t2va: T2vaRenderer | null = null
  /**
   * The latest model facts each mounted render mode reported. The GPU estimate (`estimate`, `confirmSummary`) is
   * synchronous, so it reads the provider's GPU rate from here; every facts read refreshes the entry.
   */
  private readonly facts: Partial<Record<RenderMode, RenderModelFacts>> = {}

  constructor(ctx: Context) {
    super(ctx, 'dvShotRender')
    ctx.effect(() => ctx.dvProject.registerReducer('shot', shotReducer), 'dvShotRender reducer')
    ctx.inject(['dvRef2va'], (child) => {
      child.effect(() => {
        this.ref2va = child.dvRef2va
        this.prefetchFacts('ref2va')
        const remove = ctx.dvProject.registerOperation(this.ref2vaOperation())
        return () => {
          remove()
          this.ref2va = null
          delete this.facts.ref2va
        }
      }, 'dvShotRender shot.render_ref2va')
    })
    ctx.inject(['dvT2va'], (child) => {
      child.effect(() => {
        this.t2va = child.dvT2va
        this.prefetchFacts('t2va')
        const remove = ctx.dvProject.registerOperation(this.t2vaOperation())
        return () => {
          remove()
          this.t2va = null
          delete this.facts.t2va
        }
      }, 'dvShotRender shot.render_t2va')
    })
  }

  /**
   * Render one take of a shot with the render mode of the running operation, and import its video and last still.
   * While the live stream service is mounted, the chunks also go to it as they arrive, so browsers watch the shot before
   * the record completes.
   * @param context - the running `shot.render_ref2va` or `shot.render_t2va` call.
   * @returns the video and last-still assets, the GPU time, and the report of the render's facts.
   * @throws Error for params outside the model's facts, a missing prompt, a reference count the model refuses, a
   *   provider failure, or a stream that ends before the provider reports completion or without a last frame.
   */
  async renderShot(context: OperationContext): Promise<OperationResult> {
    const record = context.record
    /* v8 ignore next -- a render is not a read, so it always runs with a record. */
    if (record === null) throw new Error('A render runs only with a record.')
    const operation = record.operation ?? ''
    const prompt = text(context.params['prompt'])
    if (operation === 'shot.render_t2va') {
      const renderer = this.t2va
      if (renderer === null) throw new Error('shot.render_t2va needs the dvT2va service.')
      const facts = await this.modelFacts('t2va', renderer)
      const geometry = shotGeometry(facts, context.params)
      if (prompt === '') throw new Error('shot.render_t2va needs a `prompt`.')
      const seed = number(context.params['seed'], randomInt(SEED_LIMIT))
      const stream = renderer.render({
        prompt, frameWidth: geometry.width, frameHeight: geometry.height, numFrames: geometry.numFrames, seed,
      }, context.signal)
      return await this.storeShot(context, record, facts, geometry, seed, stream, {})
    }
    const renderer = this.ref2va
    if (renderer === null) throw new Error('shot.render_ref2va needs the dvRef2va service.')
    const facts = await this.modelFacts('ref2va', renderer)
    const geometry = shotGeometry(facts, context.params)
    if (prompt === '') throw new Error('shot.render_ref2va needs a `prompt`.')
    const references = inputAssets(context, 'reference')
    const firstFrame = inputAssets(context, 'first_frame')[0] ?? null
    if (references.length < 1 || references.length > facts.maxReferenceImages) {
      throw new Error(`shot.render_ref2va requires 1 to ${facts.maxReferenceImages} reference images; this shot has ${references.length}.`)
    }
    const pool = this.ctx.dvAssetPool
    const seed = number(context.params['seed'], randomInt(SEED_LIMIT))
    const stream = renderer.render({
      prompt, references: references.map(asset => pool.read(asset)), firstFrame: firstFrame === null ? null : pool.read(firstFrame),
      frameWidth: geometry.width, frameHeight: geometry.height, numFrames: geometry.numFrames, seed,
    }, context.signal)
    return await this.storeShot(context, record, facts, geometry, seed, stream, {
      image_labels: imageLabels(facts, references.length, firstFrame !== null),
    })
  }

  /**
   * Store one render stream as the video and last-still outputs of a record, and build its report.
   * @param context - the running call.
   * @param record - the running record.
   * @param facts - the served model.
   * @param geometry - the shot's frame size and frame count.
   * @param seed - the seed the request carried.
   * @param stream - the provider's render stream.
   * @param extra - report fields of the render mode.
   * @returns the outputs, the GPU time, and the report.
   */
  private async storeShot(
    context: OperationContext, record: ProjectRecord, facts: RenderModelFacts, geometry: ShotGeometry, seed: number,
    stream: AsyncIterable<RenderStreamEvent>, extra: Record<string, unknown>,
  ): Promise<OperationResult> {
    const streamed = await this.streamShot(context, record.id, stream)
    const shortId = record.id.slice(0, 8)
    const video = context.importAsset({ path: streamed.videoPath }, {
      mime: baseMime(streamed.mime), name: `${shortId}.mp4`, durationSec: geometry.durationSec,
      width: geometry.width, height: geometry.height,
    })
    const frame = context.importAsset(streamed.lastFrame, {
      mime: 'image/png', name: `${shortId}-last.png`, width: geometry.width, height: geometry.height,
    })
    return {
      outputs: [video, frame],
      cost: { gpu_seconds: backendSeconds(streamed.timings) },
      report: {
        seed, model: facts.modelId, aspect_ratio: geometry.aspectRatio, resolution: geometry.resolution,
        duration_sec: geometry.durationSec, frame_width: geometry.width, frame_height: geometry.height, num_frames: geometry.numFrames,
        ...extra, timings: streamed.timings,
      },
    }
  }

  /**
   * Write one render stream into a scratch file and, while it is mounted, into the live stream service.
   * @param context - the running call.
   * @param record - the running record, which names the live stream.
   * @param stream - the provider's render stream.
   * @returns the video file, its media type, the last frame, and the backend's timings.
   * @throws Error for a provider failure, or when the stream ends before completion or without a last frame.
   */
  private async streamShot(
    context: OperationContext, record: RecordId, stream: AsyncIterable<RenderStreamEvent>,
  ): Promise<{ videoPath: string; mime: string; lastFrame: Buffer; timings: Record<string, number> }> {
    const videoPath = join(context.scratchDir, 'shot.mp4')
    const file = createWriteStream(videoPath)
    let lastFrame: Buffer | null = null
    let mime: string | null = null
    let timings: Record<string, number> = {}
    let finished = false
    let live: LiveShot = null
    try {
      for await (const event of stream) {
        switch (event.kind) {
          case 'last_frame':
            lastFrame = event.png
            break
          case 'video_start':
            mime = event.mime
            // The shot number a plan assigned tells the page which shot is playing; a free-standing shot has none.
            live = this.liveSink()?.openSegment(context.project, record, {
              mime: event.mime, segmentIdx: number(context.params['shot'], 0),
            }) ?? null
            break
          case 'chunk':
            live?.chunk(event.bytes)
            if (!file.write(event.bytes)) await new Promise<void>(resolve => file.once('drain', resolve))
            break
          case 'done':
            timings = event.timings
            finished = true
            live?.complete()
            live = null
            break
          /* v8 ignore next 4 -- closed-union exhaustiveness guard. */
          default: {
            const unexpected: never = event
            throw new Error(`Unexpected render stream event: ${JSON.stringify(unexpected)}`)
          }
        }
      }
    } catch (error) {
      live?.fail(error instanceof Error ? error : new Error(String(error)))
      live = null
      throw error
    } finally {
      await new Promise<void>(resolve => file.end(resolve))
    }
    if (live !== null) live.fail(new Error('The render stream ended before the backend reported completion.'))
    if (!finished || mime === null) throw new Error('The render stream ended before the backend reported completion.')
    if (lastFrame === null) throw new Error('The backend returned no last frame.')
    return { videoPath, mime, lastFrame, timings }
  }

  /**
   * Read a render mode's model facts and keep them for the GPU estimate.
   * @param mode - the render mode.
   * @param renderer - its service.
   * @returns the facts.
   * @throws Error when the provider cannot read them.
   */
  private async modelFacts(mode: RenderMode, renderer: Ref2vaRenderer | T2vaRenderer): Promise<RenderModelFacts> {
    const facts = await renderer.model()
    if (mode === 'ref2va' ? this.ref2va === renderer : this.t2va === renderer) this.facts[mode] = facts
    return facts
  }

  /**
   * Read a newly mounted render mode's model facts in the background, so the GPU estimate knows the provider's rate
   * before the first call; a failed read is logged and retried by the next call.
   * @param mode - the render mode.
   */
  private prefetchFacts(mode: RenderMode): void {
    const renderer = mode === 'ref2va' ? this.ref2va : this.t2va
    if (renderer === null) return
    this.modelFacts(mode, renderer).catch((error: unknown) => {
      this.ctx.logger.warn(`dvShotRender: the ${mode} render mode reported no model facts yet: ${String(error)}`)
    })
  }

  /** @returns the optional live stream service, looked up per render so a service mounted later is still used. */
  private liveSink(): LiveShotSink | undefined {
    return this.ctx.get('vhStream') // names:allow (the live stream service keeps its name)
  }

  /**
   * Refuse a `shot.render_ref2va` call of any caller that carries no reference image. Character, location and style
   * versions count their reference images, so a character created without reference images adds nothing. The refusal
   * comes before any record, so no failed take reaches the project. A call that a plan scheduled (param `plan`) is told
   * to update the plan with `dv_plan_update`; `plan.approve` names the shots in front of it.
   * @param request - the call, with its input references.
   * @param state - the state of the current branch the call writes to.
   * @throws Error telling the model to ask the user for a reference image first.
   */
  private async precondition(request: RunRequest, state: ProjectState): Promise<void> {
    const renderer = this.ref2va
    if (renderer === null) return
    const images = (ref: RecordInputRef): number =>
      'asset' in ref || 'record' in ref ? 1 : this.ctx.dvProject.assetsOf(state, ref)?.length ?? 0
    const count = request.inputs.filter(input => input.role === 'reference').reduce((sum, input) => sum + images(input.ref), 0)
    if (count > 0) return
    const limit = (await this.modelFacts('ref2va', renderer)).maxReferenceImages
    const planned = request.params['plan'] !== undefined
    const fromText = this.t2va === null ? '' : ' A shot that needs no reference image can be rendered from text with dv_shot_render_t2va.'
    throw new Error(`dv_shot_render_ref2va renders a shot from 1 to ${limit} reference images${planned ? '' : ', and this shot has none'}. `
      + 'Nothing was rendered. Ask the user for a reference image of the subject (they can attach one in the chat; it '
      + `appears under Imported images), add it as a reference or to the character, ${planned ? 'update the plan with dv_plan_update, ' : ''}`
      + `then call again.${fromText}`)
  }

  /**
   * Prepare an agent call of `shot.render_ref2va`: apply the reference-image rule before Project asks for the user's
   * agreement, and turn `continue_from` into the `first_frame` input.
   * @param call - the parsed call.
   * @throws Error telling the model to ask the user for a reference image first.
   */
  private async prepareRef2vaCall(call: OperationToolCall): Promise<void> {
    const { args, request, state } = call
    // The model facts carry the provider's GPU rate, which the agreement text reads after this call.
    if (this.ref2va !== null) await this.modelFacts('ref2va', this.ref2va)
    await this.precondition(request, state)
    const continueFrom = text(args['continue_from'])
    if (continueFrom !== '') request.inputs.push({ role: 'first_frame', ref: { record: brandString<RecordId>(continueFrom), output: 1 } })
  }

  /** Read the `t2va` model facts before an agent call, so the agreement text knows the provider's GPU rate. */
  private async prefetchT2vaFacts(): Promise<void> {
    if (this.t2va !== null) await this.modelFacts('t2va', this.t2va)
  }

  /**
   * The GPU estimate of one render: its duration times the provider's `gpuSecondsPerVideoSecond`.
   * @param mode - the render mode.
   * @param params - the call's params.
   * @returns the estimate from `duration_sec`, or from 5 seconds when the call names none; 0 while the provider has
   *   reported no model facts (its backend was never reached, so the render cannot run either).
   */
  private estimate(mode: RenderMode, params: Record<string, unknown>): { gpu_seconds: number } {
    const durationSec = number(params['duration_sec'], 0)
    const rate = this.facts[mode]?.gpuSecondsPerVideoSecond ?? 0
    return { gpu_seconds: (durationSec > 0 ? durationSec : ESTIMATE_DURATION_SEC) * rate }
  }

  /**
   * The members both render operations share: GPU use, the agreement rule, the estimate, and the summary.
   * @param mode - the render mode.
   * @returns the shared spec members.
   */
  private renderMembers(mode: RenderMode): Pick<OperationSpec, 'component' | 'version' | 'outputs' | 'deterministic' | 'resource'
    | 'confirm' | 'confirmSummary' | 'estimate' | 'summarize' | 'execute'> {
    const source = mode === 'ref2va' ? 'from references' : 'from text'
    return {
      component: 'shot',
      version: '1',
      outputs: [{ role: 'video', type: 'video' }, { role: 'last_still', type: 'image' }],
      deterministic: false,
      resource: 'gpu',
      // A shot the user did not ask for needs the user's agreement once the turn's GPU time passes the budget.
      confirm: 'over_gpu_budget',
      confirmSummary: (call) => {
        const params = call.request.params
        const durationSec = number(params['duration_sec'], 0)
        return {
          text: `Render ${planShot(params)} ${source}${durationSec > 0 ? `, ${durationSec} s` : ''}: "${text(params['prompt']).slice(0, 80)}"`,
          gpu_seconds: this.estimate(mode, params).gpu_seconds,
        }
      },
      estimate: params => this.estimate(mode, params),
      summarize: record => `${planShot(record.params)} "${text(record.params['prompt']).slice(0, 60)}" `
        + `(${label(record.report?.['duration_sec'] ?? record.params['duration_sec'])}s, seed ${label(record.report?.['seed'])})`,
      execute: context => this.renderShot(context),
    }
  }

  /** The `shot.render_ref2va` operation. */
  private ref2vaOperation(): OperationSpec {
    return {
      name: 'shot.render_ref2va',
      description: 'Render one take of a shot from a prompt and reference images (render mode ref2va). Needs at least one reference '
        + 'image: an imported image, or a character, location or style version with reference images (c1@1), through the reference '
        + 'input. Pass continue_from to start from the last still of an earlier shot. ' + TAKE_RULE,
      inputs: REF2VA_INPUTS,
      params: RENDER_PARAMS('The complete shot prompt, written with the prompt skill of this render mode; it names the images by '
        + 'position: the reference images in input order, then the first frame.'),
      toolParams: CONTINUE_FROM_PARAM,
      prepareToolCall: call => this.prepareRef2vaCall(call),
      precondition: (request, state) => this.precondition(request, state),
      ...this.renderMembers('ref2va'),
    }
  }

  /** The `shot.render_t2va` operation. */
  private t2vaOperation(): OperationSpec {
    return {
      name: 'shot.render_t2va',
      description: 'Render one take of a shot from a prompt only (render mode t2va): no reference images and no first frame, so the '
        + 'prompt describes every subject, place and style in words. ' + TAKE_RULE,
      inputs: {},
      params: RENDER_PARAMS('The complete shot prompt, written with the prompt skill of this render mode.'),
      // An agent call reads the model facts first, so the agreement text knows the provider's GPU rate.
      prepareToolCall: async () => { await this.prefetchT2vaFacts() },
      ...this.renderMembers('t2va'),
    }
  }
}

/** How a summary names the shot: `shot 7 of plan p1 v2` for a render an approved plan scheduled, else `shot`. */
function planShot(params: Record<string, unknown>): string {
  if (typeof params['plan'] !== 'string') return 'shot'
  return `shot ${label(params['shot'])} of plan ${params['plan']} v${label(params['plan_version'])}`
}

/** A number or string field as display text, or `?` for anything else. */
function label(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '?'
}
