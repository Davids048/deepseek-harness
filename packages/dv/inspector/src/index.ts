/**
 * The Inspector component of DreamVerse as the `dvInspector` Cordis service: read-only analysis of assets. It owns two
 * operations, both reads that write no record:
 * - `inspect.image`: the harness's default model answers a question about an image asset. The image reaches the model
 *   through the attachment service, as every model-visible image does. Registered while `llm`, `agentDefaultModel` and
 *   `attachments` are mounted.
 * - `inspect.asset`: ffprobe reads an asset's duration, frame size, codec and audio presence through `dvFfmpeg`.
 *
 * `dvProject` turns each operation into its agent tool (`dv_inspect_image`, `dv_inspect_asset`). The component reads
 * assets from the asset pool and has no reducer: its operations change no project state.
 *
 * @module @dv/inspector
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {} from '@dv/asset-pool'
import type {} from '@dv/ffmpeg'
import type { AssetId, OperationContext, OperationResult, OperationSpec } from '@dv/project'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Inspector component: read-only analysis of images and other assets. */
    dvInspector: DvInspector
  }
}

/** `dvInspector` plugin configuration. */
export interface Config {
  /** The output token cap of one `inspect.image` answer. */
  maxTokens: number
  /** Whether the agent model accepts images; false makes `inspect.image` report that instead of calling the model. */
  imageInput: boolean
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  maxTokens: z.number().default(1024),
  imageInput: z.boolean().default(true),
})

/** The raster formats the attachment service accepts, by asset media type. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The question `inspect.image` asks when the call names none. */
const DEFAULT_QUESTION = 'Describe this image: the subject, the framing, the lighting, and anything that looks wrong.'

/** What `inspect.image` reports. */
type ImageReport = { question: string; answer: string | null; model: string; unsupported?: string }

/** What `inspect.asset` reports, in the snake_case of tool results. */
type AssetReport = {
  duration_sec: number | null
  video_duration_sec: number | null
  width: number | null
  height: number | null
  has_audio: boolean
  codec: string | null
}

/**
 * The single resolved asset of an input role.
 * @param context - the running call.
 * @param role - the role.
 * @returns the asset.
 * @throws Error when the role has no asset.
 */
function inputAsset(context: Pick<OperationContext, 'inputs'>, role: string): AssetId {
  const asset = context.inputs.find(input => input.role === role)?.resolved_asset
  if (asset === undefined || asset === null) throw new Error(`Input "${role}" is required.`)
  return asset
}

/** The Inspector service: the two read operations and the methods they run. */
export default class DvInspector extends Service {
  static inject = ['dvProject', 'dvAssetPool', 'dvFfmpeg']
  static Config = Config

  /** The context that holds the model services while they are mounted. */
  private modelCtx: Context | null = null

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'dvInspector')
    ctx.effect(() => ctx.dvProject.registerOperation(this.assetOperation()), 'dvInspector inspect.asset')
    ctx.inject(['llm', 'agentDefaultModel', 'attachments'], (child) => {
      child.effect(() => {
        this.modelCtx = child
        const remove = ctx.dvProject.registerOperation(this.imageOperation())
        return () => {
          remove()
          this.modelCtx = null
        }
      }, 'dvInspector inspect.image')
    })
  }

  /**
   * Ask the default model a question about an image asset. A model that takes no images does not fail the call: the
   * report's `unsupported` says why, so the agent reads the reason and carries on.
   * @param asset - a PNG, JPEG, WebP or GIF asset.
   * @param question - what to look for.
   * @returns the question, the answer (null when unsupported), and the model.
   * @throws Error for another media type, while the model services are not mounted, or when the model call fails.
   */
  async inspectImage(asset: AssetId, question: string): Promise<ImageReport> {
    const ctx = this.modelCtx
    if (ctx === null) throw new Error('inspect.image needs the llm, agentDefaultModel and attachments services.')
    const assets = this.ctx.dvAssetPool
    const meta = assets.get(asset)
    if (!IMAGE_MEDIA_TYPES.has(meta.mime)) throw new Error(`inspect.image needs a PNG, JPEG, WebP, or GIF image; the input is ${meta.mime}.`)
    const route = ctx.agentDefaultModel.currentSelection()
    const unsupported = this.config.imageInput
      ? await imageRefusal(ctx, route.provider, route.model)
      : 'The agent model of this deployment is configured as text-only; inspect.image cannot look at images here.'
    if (unsupported !== null) return { question, answer: null, unsupported, model: route.model }
    const attachment = await ctx.attachments.saveImage({
      data: assets.read(asset), mediaType: meta.mime as ImageMediaType, name: meta.name,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: route.provider, model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
      messages: [{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: question }] }], maxTokens: this.config.maxTokens,
    })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(`The model call failed: ${finish.failure.message}`)
    const answer = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    return { question, answer, model: route.model }
  }

  /**
   * Read an asset's metadata with ffprobe.
   * @param asset - an audio, video or image asset.
   * @returns the duration, the video stream's duration, the frame size, audio presence and video codec; null where
   *   ffprobe reports nothing.
   * @throws FfmpegError when ffprobe cannot read the file.
   */
  async inspectAsset(asset: AssetId): Promise<AssetReport> {
    const probe = await this.ctx.dvFfmpeg.probe(this.ctx.dvAssetPool.path(asset))
    return {
      duration_sec: probe.durationSec, video_duration_sec: probe.videoDurationSec, width: probe.width, height: probe.height,
      has_audio: probe.hasAudio, codec: probe.codec,
    }
  }

  /** The `inspect.image` operation. */
  private imageOperation(): OperationSpec {
    return {
      name: 'inspect.image',
      component: 'inspect',
      version: '1',
      description: 'Look at an image asset (a still, a reference, the last frame of a shot) and answer a question about it with the '
        + 'default model. To look at a video, grab a still of it with dv_asset_grab_still first.',
      inputs: { image: { type: 'image', required: true, description: 'The image asset.' } },
      params: { question: { type: 'string', description: `What to look for; default: "${DEFAULT_QUESTION}"` } },
      outputs: [],
      deterministic: false,
      resource: 'none',
      confirm: 'never',
      readOnly: true,
      summarize: record => (record.report?.['unsupported'] === undefined
        ? `inspected: ${String(record.report?.['answer'] ?? '').slice(0, 80)}`
        : 'inspected: images unsupported'),
      execute: async (context): Promise<OperationResult> => {
        const question = typeof context.params['question'] === 'string' ? context.params['question'] : DEFAULT_QUESTION
        return { outputs: [], report: await this.inspectImage(inputAsset(context, 'image'), question) }
      },
    }
  }

  /** The `inspect.asset` operation. */
  private assetOperation(): OperationSpec {
    return {
      name: 'inspect.asset',
      component: 'inspect',
      version: '1',
      description: 'Read the duration, frame size, codec, and audio presence of a video, audio, or image asset.',
      inputs: { asset: { type: 'any', required: true, description: 'The asset.' } },
      params: {},
      outputs: [],
      deterministic: true,
      resource: 'cpu',
      confirm: 'never',
      readOnly: true,
      summarize: record => `inspected ${record.inputs[0]?.resolved_asset?.slice(0, 8) ?? 'asset'}`,
      execute: async (context): Promise<OperationResult> => ({ outputs: [], report: await this.inspectAsset(inputAsset(context, 'asset')) }),
    }
  }
}

/**
 * Why the selected model cannot take an image, or null when its catalog entry declares image input.
 * @param ctx - a context with `llm`.
 * @param provider - the route's provider.
 * @param model - the model on the route.
 * @returns the explanation for the report, or null.
 */
async function imageRefusal(ctx: Context, provider: string, model: string): Promise<string | null> {
  const info = await ctx.llm.resolveModelInfo(provider, model)
  if (info.inputModalities?.includes('image') === true) return null
  return `The default model "${model}" does not accept image input; switch to an image-capable model to look at images.`
}
