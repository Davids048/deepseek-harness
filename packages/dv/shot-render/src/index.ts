/**
 * The Shot render component of DreamVerse as the `dvShotRender` Cordis service. It owns one operation, `shot.render`:
 * one take of a shot from a prompt, the reference images of the characters, locations and styles it names, and
 * optionally the last still of the shot it continues, rendered by the DreamVerse generation backend
 * (`dreamverseGeneration`, a FastVideo Ref2AV server). The backend's model facts decide the frame size and frame count;
 * the DreamVerse conditioning rules decide which images the request carries in which order. The video and its last
 * still are stored as two outputs (`video`, `last_still`), so a later shot can start from output `#1`.
 *
 * `shot.render` is registered while `dreamverseGeneration` is mounted; `dvProject` turns it into the agent tool
 * `dv_shot_render`. The component's reducer groups the takes of each shot in the `shot` slice. While the optional
 * live stream service is mounted, the video bytes also go to browsers as the backend produces them.
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
import type {} from '@dreamverse/generation-client'
import {
  referenceImageLimit, segmentImageLabels, segmentRequestImages, validateReferenceAssets, type DreamverseGeneration,
} from '@dreamverse/segment-generation'
import type {} from '@dv/asset-pool'
import type {
  AssetId, OperationContext, OperationResult, OperationSpec, OperationToolCall, ProjectId, ProjectState, RecordId, RecordInputRef,
  RunRequest,
} from '@dv/project'
import { shotReducer } from './reducer.ts'
import { assetRecord, backendSeconds, baseMime, number, shotGeometry, text } from './render.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Shot render component: one take of a shot per `shot.render` call. */
    dvShotRender: DvShotRender
  }
}

/** `dvShotRender` plugin configuration. */
export interface Config {
  /** Estimated GPU seconds per rendered video second, for the estimate on the approval card and the question rule. */
  gpuSecondsPerVideoSecond: number
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  gpuSecondsPerVideoSecond: z.number().default(4),
})

/** The seed range of the generation backend. */
const SEED_LIMIT = 2 ** 31

/** The duration the GPU estimate assumes for a call that names none. */
const ESTIMATE_DURATION_SEC = 5

/**
 * Where a shot's bytes go while the backend is still producing them, so browsers can watch the shot render: the
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

/** The tool-only argument of `dv_shot_render` that names the take whose last still the new shot starts from. */
const CONTINUE_FROM_PARAM: ParameterSchemaSpec = {
  continue_from: { type: 'string', description: 'A dv_shot_render record whose last_still (output #1) this shot starts from.' },
}

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

/** The Shot render service: `shot.render`, its reducer, and the method it runs. */
export default class DvShotRender extends Service {
  static inject = ['dvProject', 'dvAssetPool']
  static Config = Config

  /** The generation backend while it is mounted. */
  private generation: DreamverseGeneration | null = null

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'dvShotRender')
    ctx.effect(() => ctx.dvProject.registerReducer('shot', shotReducer), 'dvShotRender reducer')
    ctx.inject(['dreamverseGeneration'], (child) => {
      child.effect(() => {
        this.generation = child.dreamverseGeneration
        const remove = ctx.dvProject.registerOperation(this.renderOperation())
        return () => {
          remove()
          this.generation = null
        }
      }, 'dvShotRender shot.render')
    })
  }

  /**
   * Render one take of a shot and import its video and last still. While the live stream service is mounted, the
   * chunks also go to it as they arrive, so browsers watch the shot before the record completes.
   * @param context - the running `shot.render` call.
   * @returns the video and last-still assets, the GPU time, and the report of the render's facts.
   * @throws Error for params outside the model's facts, a missing prompt, a reference count the model refuses, a
   *   backend failure, or a stream that ends before the backend reports completion or without a last frame.
   */
  async renderShot(context: OperationContext): Promise<OperationResult> {
    const generation = this.generation
    if (generation === null) throw new Error('shot.render needs the dreamverseGeneration service.')
    const record = context.record
    /* v8 ignore next -- shot.render is not a read, so it always runs with a record. */
    if (record === null) throw new Error('shot.render runs only with a record.')
    const facts = await generation.model()
    const geometry = shotGeometry(facts, context.params)
    const prompt = text(context.params['prompt'])
    if (prompt === '') throw new Error('shot.render needs a `prompt`.')
    const references = inputAssets(context, 'reference')
    const firstFrame = inputAssets(context, 'first_frame')[0]
    validateReferenceAssets(facts, geometry.mode, references.length)
    const continues = firstFrame !== undefined
    const pool = this.ctx.dvAssetPool
    const referenceImages = await segmentRequestImages(
      facts, geometry.mode, references.map(asset => assetRecord(pool, asset)), continues ? assetRecord(pool, firstFrame) : null,
    )
    const seed = number(context.params['seed'], randomInt(SEED_LIMIT))
    const streamed = await this.streamShot(generation, context, record.id, {
      prompt, frameWidth: geometry.width, frameHeight: geometry.height, numFrames: geometry.numFrames, referenceImages, seed,
      returnLastFrame: true,
    })
    const shortId = record.id.slice(0, 8)
    const video = context.importAsset({ path: streamed.videoPath }, {
      mime: baseMime(streamed.mime), name: `${shortId}.mp4`, durationSec: geometry.durationSec,
      width: geometry.width, height: geometry.height,
    })
    const frame = context.importAsset(streamed.lastFrame, {
      mime: 'image/png', name: `${shortId}-last.png`, width: geometry.width, height: geometry.height,
    })
    const labels = segmentImageLabels(facts, geometry.mode, references.length, continues)
    return {
      outputs: [video, frame],
      cost: { gpu_seconds: backendSeconds(streamed.timings) },
      report: {
        seed, model: facts.modelId, generation_mode: geometry.mode, aspect_ratio: geometry.aspectRatio, resolution: geometry.resolution,
        duration_sec: geometry.durationSec, frame_width: geometry.width, frame_height: geometry.height, num_frames: geometry.numFrames,
        image_labels: labels, timings: streamed.timings,
      },
    }
  }

  /**
   * Stream one backend request into a scratch file and, while it is mounted, into the live stream service.
   * @param generation - the backend client.
   * @param context - the running call.
   * @param record - the running record, which names the live stream.
   * @param request - the backend request.
   * @returns the video file, its media type, the last frame, and the backend's timings.
   * @throws Error for a backend failure, or when the stream ends before completion or without a last frame.
   */
  private async streamShot(
    generation: DreamverseGeneration, context: OperationContext, record: RecordId,
    request: Parameters<DreamverseGeneration['generateSegment']>[0],
  ): Promise<{ videoPath: string; mime: string; lastFrame: Buffer; timings: Record<string, number> }> {
    const videoPath = join(context.scratchDir, 'shot.mp4')
    const file = createWriteStream(videoPath)
    let lastFrame: Buffer | null = null
    let mime: string | null = null
    let timings: Record<string, number> = {}
    let finished = false
    let live: LiveShot = null
    try {
      for await (const output of generation.generateSegment(request)) {
        switch (output.kind) {
          case 'last_frame':
            lastFrame = output.png
            break
          case 'video_start':
            mime = output.mime
            // The shot number a plan assigned tells the page which shot is playing; a free-standing shot has none.
            live = this.liveSink()?.openSegment(context.project, record, {
              mime: output.mime, segmentIdx: number(context.params['shot'], 0),
            }) ?? null
            break
          case 'chunk':
            live?.chunk(output.bytes)
            if (!file.write(output.bytes)) await new Promise<void>(resolve => file.once('drain', resolve))
            break
          case 'done':
            timings = output.timings
            finished = true
            live?.complete()
            live = null
            break
          /* v8 ignore next 4 -- closed-union exhaustiveness guard. */
          default: {
            const unexpected: never = output
            throw new Error(`Unexpected segment output: ${JSON.stringify(unexpected)}`)
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

  /** @returns the optional live stream service, looked up per render so a service mounted later is still used. */
  private liveSink(): LiveShotSink | undefined {
    return this.ctx.get('vhStream') // names:allow (the live stream service keeps its name)
  }

  /**
   * Refuse a `shot.render` call of any caller when the served model renders from reference images and the call carries
   * no reference image. Character, location and style versions count their reference images, so a character created
   * without reference images adds nothing. The refusal comes before any record, so no failed take reaches the project. A call
   * that a plan scheduled (param `plan`) is told to update the plan with `dv_plan_update`; `plan.approve` names the shots
   * in front of it.
   * @param request - the call, with its input references.
   * @param state - the state of the working branch the call writes to.
   * @throws Error telling the model to ask the user for a reference image first.
   */
  private async precondition(request: RunRequest, state: ProjectState): Promise<void> {
    const generation = this.generation
    if (generation === null) return
    const facts = await generation.model()
    const mode = text(request.params['generation_mode'], Object.keys(facts.generationModes)[0] ?? '')
    if (facts.generationModes[mode] !== 'reference_images') return
    const images = (ref: RecordInputRef): number =>
      'asset' in ref || 'record' in ref ? 1 : this.ctx.dvProject.assetsOf(state, ref)?.length ?? 0
    const count = request.inputs.filter(input => input.role === 'reference').reduce((sum, input) => sum + images(input.ref), 0)
    if (count > 0) return
    const limit = referenceImageLimit(facts, mode)
    const planned = request.params['plan'] !== undefined
    throw new Error(`The video model renders every shot from 1 to ${limit} reference images${planned ? '' : ', and this shot has none'}. `
      + 'Nothing was rendered. Ask the user for a reference image of the subject (they can attach one in the chat; it '
      + `appears under Imported images), add it as a reference or to the character, ${planned ? 'update the plan with dv_plan_update, ' : ''}then call again.`)
  }

  /**
   * Prepare an agent call of `shot.render`: apply the reference-image rule before the question rule asks the user, and
   * turn `continue_from` into the `first_frame` input.
   * @param call - the parsed call.
   * @throws Error telling the model to ask the user for a reference image first.
   */
  private async prepareToolCall(call: OperationToolCall): Promise<void> {
    const { args, request, state } = call
    await this.precondition(request, state)
    const continueFrom = text(args['continue_from'])
    if (continueFrom !== '') request.inputs.push({ role: 'first_frame', ref: { record: brandString<RecordId>(continueFrom), output: 1 } })
  }

  /** The `shot.render` operation. */
  private renderOperation(): OperationSpec {
    return {
      name: 'shot.render',
      component: 'shot',
      version: '1',
      description: 'Render one take of a shot from a prompt and reference images. Name characters, locations and styles through the '
        + 'reference input (c1@1); pass continue_from to start from the last still of an earlier shot. Outputs: the video, then its '
        + 'last still. Every call is a new take; a changed prompt for the same shot passes based_on.',
      inputs: {
        reference: {
          type: 'image', many: true, bible: true,
          description: 'Reference images, or character, location and style versions whose reference images the shot carries, in prompt '
            + 'order (Picture 1, Picture 2, …).',
        },
        first_frame: { type: 'image', description: 'The frame the shot starts from, usually output #1 of the previous shot.' },
      },
      params: {
        prompt: {
          type: 'string', required: true,
          description: 'The complete shot prompt; refer to reference images as Picture 1, Picture 2, … in input order.',
        },
        duration_sec: { type: 'integer', description: 'Whole seconds within the model range; default the model minimum.' },
        aspect_ratio: { type: 'string', description: 'One of the model aspect ratios; default the first.' },
        resolution: { type: 'string', description: 'One of the model resolutions; default the first.' },
        generation_mode: { type: 'string', description: 'One of the model generation modes; default the first.' },
        seed: { type: 'integer', description: 'Fixed seed; omitted, a random seed is drawn and recorded.' },
        // Set when an approved plan schedules the render; the live stream shows the shot position.
        plan: { type: 'string', description: 'The plan ID (p1, p2, …) whose approval scheduled this render; set by dv_plan_approve.' },
        plan_version: { type: 'integer', description: 'The approved version of that plan; set by dv_plan_approve.' },
        shot: { type: 'integer', description: 'The shot position in that version, 1 = first; set by dv_plan_approve.' },
      },
      outputs: [{ role: 'video', type: 'video' }, { role: 'last_still', type: 'image' }],
      deterministic: false,
      resource: 'gpu',
      confirm: 'agent_ask_first',
      // The approval card and the question rule show the GPU time of the shot before it renders.
      estimate: (params) => {
        const durationSec = number(params['duration_sec'], 0)
        return { gpu_seconds: (durationSec > 0 ? durationSec : ESTIMATE_DURATION_SEC) * this.config.gpuSecondsPerVideoSecond }
      },
      summarize: record => `${planShot(record.params)} "${text(record.params['prompt']).slice(0, 60)}" `
        + `(${label(record.report?.['duration_sec'] ?? record.params['duration_sec'])}s, seed ${label(record.report?.['seed'])})`,
      toolParams: CONTINUE_FROM_PARAM,
      prepareToolCall: call => this.prepareToolCall(call),
      precondition: (request, state) => this.precondition(request, state),
      execute: context => this.renderShot(context),
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
