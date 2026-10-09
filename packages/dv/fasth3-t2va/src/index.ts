/**
 * Service Provider of the `t2va` render mode seam: registers a renderer into `ctx.dvT2va` for the FastH3 8-Step V2
 * text-to-video model (`FastVideo/FastVideo-FastH3-8-Step-V2`) behind a FastVideo streaming_v2 server. The streaming_v2
 * client of `@dreamverse/generation-client` sends each render as one `POST /v1/streamv2/generate` without reference
 * images and returns the server's event stream. While the DSH skill registry is mounted, the provider registers the
 * `fasth3-t2va-prompting` skill: the model's limits and prompt rules.
 *
 * @module @dv/fasth3-t2va
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'
import { DreamverseGeneration } from '@dreamverse/generation-client'
import type { T2vaRenderer, RenderModelFacts, RenderStreamEvent, T2vaRequest } from '@dv/render-modes'

/** `dvT2va` provider configuration. */
export interface Config {
  /** The backend name the renderer is registered under; the render tool's `backend` param names it. */
  backend: string
  /** HTTP base URL of the FastVideo streaming_v2 server that serves the text-to-video model. */
  baseUrl: string
  /** GPU seconds per rendered video second on this server, reported in the model facts for the GPU estimate. */
  gpuSecondsPerVideoSecond: number
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  backend: z.string().default('fasth3'),
  baseUrl: z.string().required(),
  gpuSecondsPerVideoSecond: z.number().default(1.5),
})

/** The prompt skill of the served model. */
const PROMPT_SKILL = {
  name: 'fasth3-t2va-prompting',
  description: 'Model limits and prompt rules for dv_shot_render_t2va (render mode t2va): the three prompt fields, shot changes, '
    + 'camera motion, speakers and dialogue, sound and music.',
  content: readFileSync(new URL('../skills/fasth3-t2va-prompting.md', import.meta.url), 'utf8'),
  source: 'runtime',
}

/** Renders `t2va` shots with the FastH3 8-Step V2 text-to-video model served by FastVideo streaming_v2. */
export class FastH3T2vaRenderer implements T2vaRenderer {
  /** The streaming_v2 client; it lives in a scope of its own, so it is not a `dreamverseGeneration` service of the host. */
  private readonly client: DreamverseGeneration

  constructor(ctx: Context, private readonly config: Config) {
    this.client = new DreamverseGeneration(ctx.isolate('dreamverseGeneration'), { baseUrl: config.baseUrl })
  }

  /**
   * Read the facts of the served model; a text-to-video model takes no reference images.
   * @returns the model facts.
   * @throws Error when the server cannot be reached or answers with a status other than 200.
   */
  async model(): Promise<RenderModelFacts> {
    const facts = await this.client.model()
    return {
      modelId: facts.modelId, name: facts.name, aspectRatios: facts.aspectRatios, resolutions: facts.resolutions,
      frameSizes: facts.frameSizes, minDurationSec: facts.minSegmentDurationSec, maxDurationSec: facts.maxSegmentDurationSec,
      numFramesByDurationSec: facts.numFramesByDurationSec, maxReferenceImages: 0, imageLabels: [],
      gpuSecondsPerVideoSecond: this.config.gpuSecondsPerVideoSecond,
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
   * Render one shot from its prompt, with the server's last frame requested.
   * @param request - the prompt, frame size, frame count, and seed.
   * @param signal - cancels the HTTP request.
   * @returns the server's event stream.
   */
  render(request: T2vaRequest, signal?: AbortSignal): AsyncIterable<RenderStreamEvent> {
    return this.client.generateSegment({
      prompt: request.prompt,
      referenceImages: [],
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
export const name = 'dv-fasth3-t2va'

/** Required services: the `t2va` render mode registry. */
export const inject = ['dvT2va']

/**
 * Register the renderer into `ctx.dvT2va` under `config.backend`, and its prompt skill while the DSH skill registry is
 * mounted.
 * @param ctx - the plugin context.
 * @param config - the validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const renderer = new FastH3T2vaRenderer(ctx, config)
  ctx.effect(() => ctx.dvT2va.register(config.backend, renderer), `dvT2va ${config.backend}`)
  ctx.inject(['skills'], (child) => {
    child.effect(() => child.skills.register(PROMPT_SKILL), `dvT2va ${PROMPT_SKILL.name}`)
  })
}
