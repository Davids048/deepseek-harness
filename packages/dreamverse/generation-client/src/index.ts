/**
 * `dreamverseGeneration`: the harness client for the generation backend's streaming_v2 API, which `fastvideo serve`
 * serves with a `streaming_v2:` config block. HTTP calls use `fetch`; each segment request is one
 * `POST /v1/streamv2/generate` whose response is a server-sent event stream.
 *
 * @module @dreamverse/generation-client
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { generateSegment } from './generation-stream.ts'
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
  /** HTTP base URL of the generation backend, such as `http://127.0.0.1:8029`. */
  baseUrl: string
}

/** `GET /v1/streamv2/capabilities` response fields: the served model's facts. */
interface CapabilitiesBody {
  model_id: string
  name: string
  min_segment_duration_sec: number
  max_segment_duration_sec: number
  max_reference_images: number
  max_reference_aspect_ratio: number | null
  frame_sizes: Record<string, Record<string, [number, number]>>
  num_frames_by_duration_sec: Record<string, number>
}

/**
 * The generation modes of the H3 Ref2VA model that the streaming_v2 backend serves: ordered reference images. The
 * capabilities response does not carry them.
 */
const SERVED_GENERATION_MODES: Record<string, string> = { ref2va: 'reference_images' }

/** Reads the backend's model facts and readiness and streams segments. */
export class DreamverseGeneration extends Service {
  static Config: z<Config> = z.object({
    baseUrl: z.string().required(),
  })

  private readonly baseUrl: URL
  /** The first successful capabilities result; the served model stays fixed for the backend's lifetime. */
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
   * Read the served model's facts; the first successful response is reused afterwards. The capabilities supply the
   * model-specific values. The client adds the Ref2VA generation mode, `Picture 1` to `Picture N` labels for the
   * `max_reference_images` request images, and `usesPreviousFrame: true`, because every continued segment starts from
   * its predecessor's last frame.
   * @returns the model facts.
   * @throws Error naming the route for a status other than 200, or the `fetch` error when the backend is unreachable.
   */
  async model(): Promise<ModelFacts> {
    if (this.modelFacts !== null) return this.modelFacts
    const route = '/v1/streamv2/capabilities'
    const body = await readBody<CapabilitiesBody>(await fetch(new URL(route, this.baseUrl)), `GET ${route}`)
    this.modelFacts = {
      modelId: body.model_id,
      name: body.name,
      generationModes: { ...SERVED_GENERATION_MODES },
      unsupportedGenerationModes: {},
      aspectRatios: Object.keys(body.frame_sizes),
      resolutions: [...new Set(Object.values(body.frame_sizes).flatMap(sizes => Object.keys(sizes)))],
      minSegmentDurationSec: body.min_segment_duration_sec,
      maxSegmentDurationSec: body.max_segment_duration_sec,
      maxReferenceImages: body.max_reference_images,
      maxReferenceAspectRatio: body.max_reference_aspect_ratio,
      usesPreviousFrame: true,
      frameSizes: body.frame_sizes,
      numFramesByDurationSec: body.num_frames_by_duration_sec,
      referenceLabels: Array.from({ length: body.max_reference_images }, (_value, index) => `Picture ${index + 1}`),
    }
    return this.modelFacts
  }

  /**
   * Read whether the backend serves requests.
   * @returns ready when `GET /v1/streamv2/health` answers 200.
   * @throws Error naming the route for any other status, or the `fetch` error when the backend is unreachable.
   */
  async ready(): Promise<GenerationReadiness> {
    const route = '/v1/streamv2/health'
    await readBody<object>(await fetch(new URL(route, this.baseUrl)), `GET ${route}`)
    return { ready: true, detail: null }
  }

  /**
   * Stream one segment with its own HTTP request. The iteration ends after `done` and rejects with
   * `GenerationSegmentError` after HTTP 400 or an `error` event. Leaving the iteration or aborting `request.signal`
   * cancels the request; an abort rejects with `signal.reason`.
   * @param request - the segment inputs and an optional abort signal.
   * @returns the backend outputs in arrival order.
   */
  generateSegment(request: SegmentRequest): AsyncIterable<SegmentOutput> {
    return generateSegment(new URL('/v1/streamv2/generate', this.baseUrl), request)
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
