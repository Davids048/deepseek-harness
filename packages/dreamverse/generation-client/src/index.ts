/**
 * `dreamverseGeneration`: the harness client for the DreamVerse generation backend API. HTTP calls use `fetch`; each
 * segment request uses one WebSocket to `/v1/generation`.
 *
 * @module @dreamverse/generation-client
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { generateSegment } from './generation-socket.ts'
import type { GenerationReadiness, ModelFacts, SegmentOutput, SegmentRequest } from './types.ts'

export * from './errors.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client for the DreamVerse generation backend API. */
    dreamverseGeneration: DreamverseGeneration
  }
}

/** Generation backend location. */
export interface Config {
  /** HTTP base URL of the generation backend, such as `http://127.0.0.1:8010`. */
  baseUrl: string
}

/** `GET /v1/model` response fields. */
interface ModelFactsBody {
  model_id: string
  name: string
  generation_modes: Record<string, string>
  unsupported_generation_modes: Record<string, string>
  aspect_ratios: string[]
  resolutions: string[]
  min_segment_duration_sec: number
  max_segment_duration_sec: number
  max_reference_images: number
  max_reference_aspect_ratio: number | null
  uses_previous_frame: boolean
  frame_sizes: Record<string, Record<string, [number, number]>>
  num_frames_by_duration_sec: Record<string, number>
  reference_labels: string[]
}

/** Reads the backend's model facts and readiness and streams segments. */
export class DreamverseGeneration extends Service {
  static Config: z<Config> = z.object({
    baseUrl: z.string().required(),
  })

  private readonly baseUrl: URL
  /** The first successful `GET /v1/model` result; the served model stays fixed for the backend's lifetime. */
  private modelFacts: ModelFacts | null = null

  /**
   * @param ctx - owning plugin context.
   * @param config - validated generation backend location.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'dreamverseGeneration')
    this.baseUrl = new URL(config.baseUrl)
  }

  /**
   * Read the served model's facts; the first successful response is reused afterwards.
   * @returns the model facts.
   * @throws Error naming the route for a status other than 200, or the `fetch` error when the backend is unreachable.
   */
  async model(): Promise<ModelFacts> {
    if (this.modelFacts !== null) return this.modelFacts
    const body = await readBody<ModelFactsBody>(await fetch(new URL('/v1/model', this.baseUrl)), 'GET /v1/model')
    this.modelFacts = {
      modelId: body.model_id,
      name: body.name,
      generationModes: body.generation_modes,
      unsupportedGenerationModes: body.unsupported_generation_modes,
      aspectRatios: body.aspect_ratios,
      resolutions: body.resolutions,
      minSegmentDurationSec: body.min_segment_duration_sec,
      maxSegmentDurationSec: body.max_segment_duration_sec,
      maxReferenceImages: body.max_reference_images,
      maxReferenceAspectRatio: body.max_reference_aspect_ratio,
      usesPreviousFrame: body.uses_previous_frame,
      frameSizes: body.frame_sizes,
      numFramesByDurationSec: body.num_frames_by_duration_sec,
      referenceLabels: body.reference_labels,
    }
    return this.modelFacts
  }

  /**
   * Read whether the backend's worker is initialized.
   * @returns ready on 200; not ready with the backend's `detail` on 503.
   * @throws Error naming the route for any other status, or the `fetch` error when the backend is unreachable.
   */
  async ready(): Promise<GenerationReadiness> {
    const response = await fetch(new URL('/readyz', this.baseUrl))
    if (response.status === 503) {
      const body = await response.json() as { detail: string }
      return { ready: false, detail: body.detail }
    }
    await readBody<object>(response, 'GET /readyz')
    return { ready: true, detail: null }
  }

  /**
   * Stream one segment over its own WebSocket. The iteration ends after `segment_finished` or `segment_ended` and
   * rejects with `GenerationSegmentError` after `segment_error`. Leaving the iteration or aborting `request.signal`
   * closes the socket; an abort rejects with `signal.reason`.
   * @param request - the segment inputs and an optional abort signal.
   * @returns the backend outputs in arrival order.
   */
  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput> {
    const url = new URL('/v1/generation', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return generateSegment(url, request)
  }
}

/**
 * Parse a successful JSON response.
 * @param response - the backend response.
 * @param route - method and path for the failure message.
 * @returns the parsed body.
 * @throws Error naming the route, status, and body for any status other than 200.
 */
async function readBody<T>(response: Response, route: string): Promise<T> {
  if (response.status !== 200) {
    throw new Error(`DreamVerse generation backend ${route} returned HTTP ${response.status}: ${await response.text()}`)
  }
  return await response.json() as T
}

export default DreamverseGeneration
