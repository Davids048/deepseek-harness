/**
 * `perception.describe`: the agent looks at an image asset through the harness's default model. The image goes through
 * the attachment service, as every model-visible image does. The operation is a read: it writes no record and returns
 * the answer in its report.
 *
 * @module @video-harness/tools/specs-perception
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type { OperationResult } from '@dv/project'
import type VhAssets from '@video-harness/assets'
import { text } from './specs-basic.ts'
import { requireInput } from './specs-media.ts'
import type { ToolSpec } from './types.ts'

/** The raster formats the attachment service accepts, by asset MIME type. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The default question. */
const DEFAULT_QUESTION = 'Describe this image: the subject, the framing, the lighting, and anything that looks wrong.'

/**
 * The `perception.describe` tool over the services of a context that has `llm`, `agentDefaultModel`, and
 * `attachments`. A model that takes no images does not fail the call: the report's `unsupported` says so, so the agent
 * reads why it cannot look and carries on.
 * @param ctx - a context with the three services injected.
 * @param assets - the asset store the image is read from.
 * @param maxTokens - the answer's token cap.
 * @param imageInput - whether the deployment's agent model accepts images at all.
 * @returns the spec.
 */
export function perceptionTool(ctx: Context, assets: VhAssets, maxTokens: number, imageInput = true): ToolSpec {
  return {
    name: 'perception.describe',
    component: 'inspect',
    version: '1',
    summary: 'Look at an image asset (a frame, a reference, a last frame) and answer a question about it with the default model. Extract a frame first to look at a video.',
    inputs: { image: { type: 'image', required: true, description: 'The image asset.' } },
    inputRoles: ['image'],
    params: { question: { type: 'string', description: `What to look for; default: "${DEFAULT_QUESTION}"` } },
    outputs: [{ role: 'answer', type: 'text' }],
    deterministic: false,
    resource: 'none',
    confirm: 'never',
    readOnly: true,
    summarize: record => (record.report?.['unsupported'] === undefined
      ? `looked: ${text(record.report?.['answer']).slice(0, 80)}`
      : 'looked: images unsupported'),
    async execute(context): Promise<OperationResult> {
      const image = requireInput(context, 'image')
      const meta = assets.get(image)
      if (!IMAGE_MEDIA_TYPES.has(meta.mime)) throw new Error(`perception.describe needs a PNG, JPEG, WebP, or GIF image; the input is ${meta.mime}.`)
      const route = ctx.agentDefaultModel.currentSelection()
      const question = text(context.params['question'], DEFAULT_QUESTION)
      const unsupported = imageInput ? await imageRefusal(ctx, route.provider, route.model) : 'The agent model of this deployment is configured as text-only; perception.describe cannot look at images here.'
      if (unsupported !== null) return { outputs: [], report: { question, answer: null, unsupported, model: route.model } }
      const attachment = await ctx.attachments.saveImage({
        data: assets.read(image), mediaType: meta.mime as ImageMediaType, name: meta.name,
      })
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({
        provider: route.provider, model: route.model,
        ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
        messages: [{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: question }] }], maxTokens,
      })) assembler.push(chunk)
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(`The model call failed: ${finish.failure.message}`)
      const answer = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      return { outputs: [], report: { question, answer, model: route.model } }
    },
  }
}

/**
 * Why the selected model cannot take an image, or null when its catalog entry declares image input.
 * @param ctx - a context with `llm`.
 * @param provider - the route.
 * @param model - the model on the route.
 * @returns the explanation for the record, or null.
 */
async function imageRefusal(ctx: Context, provider: string, model: string): Promise<string | null> {
  const info = await ctx.llm.resolveModelInfo(provider, model)
  if (info.inputModalities?.includes('image') === true) return null
  return `The default model "${model}" does not accept image input; switch to an image-capable model to look at images.`
}
