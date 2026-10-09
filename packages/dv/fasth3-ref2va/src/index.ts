/**
 * Service Provider of the `ref2va` render mode seam: registers a renderer into `ctx.dvRef2va` for a FastH3 Ref2VA model
 * behind a FastVideo streaming_v2 server. The streaming_v2 client of `@dreamverse/generation-client` sends each render as
 * one `POST /v1/streamv2/generate` with the reference images first and the first frame after them, and returns the
 * server's event stream. While the DSH skill registry is mounted, the provider registers the `fasth3-ref2va-prompting`
 * skill: the model's limits and prompt rules.
 *
 * @module @dv/fasth3-ref2va
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'
import { DreamverseGeneration } from '@dreamverse/generation-client'
import type { Ref2vaRenderer, RenderModelFacts, RenderStreamEvent, Ref2vaRequest } from '@dv/render-modes'

/** `dvRef2va` provider configuration. */
export interface Config {
  /** The backend name the renderer is registered under; the render tool's `backend` param names it. */
  backend: string
  /** HTTP base URL of the FastVideo streaming_v2 server, such as `http://127.0.0.1:8029`. */
  baseUrl: string
  /** GPU seconds per rendered video second on this server, reported in the model facts for the GPU estimate. */
  gpuSecondsPerVideoSecond: number
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  backend: z.string().default('fasth3'),
  baseUrl: z.string().required(),
  gpuSecondsPerVideoSecond: z.number().default(4),
})

/** The prompt skill of the served model. */
const PROMPT_SKILL = {
  name: 'fasth3-ref2va-prompting',
  description: 'Model limits and prompt rules for dv_shot_render_ref2va (render mode ref2va): reference images, how the prompt '
    + 'names them, and how a shot continues the previous one.',
  content: readFileSync(new URL('../skills/fasth3-ref2va-prompting.md', import.meta.url), 'utf8'),
  source: 'runtime',
}

/** Renders `ref2va` shots with a FastH3 Ref2VA model served by FastVideo streaming_v2. */
export class FastH3Ref2vaRenderer implements Ref2vaRenderer {
  /** The streaming_v2 client; it lives in a scope of its own, so it is not a `dreamverseGeneration` service of the host. */
  private readonly client: DreamverseGeneration

  constructor(ctx: Context, private readonly config: Config) {
    this.client = new DreamverseGeneration(ctx.isolate('dreamverseGeneration'), { baseUrl: config.baseUrl })
  }

  /**
   * Read the facts of the served model. The server counts the first frame among its request images, so one image is
   * kept for it: the model takes one reference image fewer than the server's `max_reference_images`.
   * @returns the model facts.
   * @throws Error when the server cannot be reached or answers with a status other than 200.
   */
  async model(): Promise<RenderModelFacts> {
    const facts = await this.client.model()
    return {
      modelId: facts.modelId, name: facts.name, aspectRatios: facts.aspectRatios, resolutions: facts.resolutions,
      frameSizes: facts.frameSizes, minDurationSec: facts.minSegmentDurationSec, maxDurationSec: facts.maxSegmentDurationSec,
      numFramesByDurationSec: facts.numFramesByDurationSec, maxReferenceImages: facts.maxReferenceImages - 1,
      imageLabels: facts.referenceLabels, gpuSecondsPerVideoSecond: this.config.gpuSecondsPerVideoSecond,
    }
  }

  /**
   * Read whether the server serves renders.
   * @returns ready when `GET /v1/streamv2/health` answers 200.
   * @throws Error when the server cannot be reached or answers with another status.
   */
  async ready(): Promise<{ ready: boolean; detail: string | null }> {
    return await this.client.ready()
  }

  /**
   * Render one shot: the reference images in order, then the first frame, with the server's last frame requested.
   * @param request - the prompt, images, frame size, frame count, and seed.
   * @param signal - cancels the HTTP request.
   * @returns the server's event stream.
   */
  render(request: Ref2vaRequest, signal?: AbortSignal): AsyncIterable<RenderStreamEvent> {
    return this.client.generateSegment({
      prompt: request.prompt,
      referenceImages: request.firstFrame === null ? request.references : [...request.references, request.firstFrame],
      frameWidth: request.frameWidth,
      frameHeight: request.frameHeight,
      numFrames: request.numFrames,
      seed: request.seed,
      returnLastFrame: true,
      ...signal === undefined ? {} : { signal },
    })
  }
}

/** Plugin name. */
export const name = 'dv-fasth3-ref2va'

/** Required services: the `ref2va` render mode registry. */
export const inject = ['dvRef2va']

/**
 * Register the renderer into `ctx.dvRef2va` under `config.backend`, and its prompt skill while the DSH skill registry is
 * mounted.
 * @param ctx - the plugin context.
 * @param config - the validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const renderer = new FastH3Ref2vaRenderer(ctx, config)
  ctx.effect(() => ctx.dvRef2va.register(config.backend, renderer), `dvRef2va ${config.backend}`)
  ctx.inject(['skills'], (child) => {
    child.effect(() => child.skills.register(PROMPT_SKILL), `dvRef2va ${PROMPT_SKILL.name}`)
  })
}
