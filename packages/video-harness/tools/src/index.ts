/**
 * The structured tools of the video harness as the `vhTools` Cordis service: the registry of {@link ToolSpec}s, each
 * registered with `dvProject` as an operation so views and the agent run it, and exposed to the DSH agent as a
 * `vh_<name>` tool when the `tools` registry is mounted, beside the `dv_proj_*` registry tools. The service also
 * registers the stage 2 bridge reducers (`timeline`, `bible`, `plan`, `shot`). `generate.video` is mounted when
 * `dreamverseGeneration` is, and `perception.describe` when `llm`, `agentDefaultModel`, and `attachments` are.
 *
 * @module @video-harness/tools
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@dreamverse/generation-client'
import type { AssetId, ProjectId } from '@dv/project'
import type {} from '@video-harness/assets'
import type {} from '@video-harness/media'
import { assetUrl, DshTools, estimateGpuSeconds, type ConfirmPolicy, type SessionState } from './dsh.ts'
import { bridgeReducers } from './reducers.ts'
import { assetUpload, entityTools, planApprove, planCreate, planUpdate, sequenceTools } from './specs-basic.ts'
import { generateVideoTool } from './specs-generate.ts'
import { mediaTools } from './specs-media.ts'
import { perceptionTool } from './specs-perception.ts'
import type { ToolSpec } from './types.ts'

export * from './types.ts'
export {
  assetUrl, dshToolName, estimateGpuSeconds, parseInputs, renderValue, sessionKey, type BridgeOptions, type ConfirmPolicy,
  type ConfirmRequest, type SessionState, type ToolCallValue,
} from './dsh.ts'
export { assetUpload, entityTools, planApprove, planCreate, planUpdate, sequenceTools } from './specs-basic.ts'
export { assetRecord, backendSeconds, generateVideoTool, shotGeometry } from './specs-generate.ts'
export { inputAssets, mediaTools, requireInput } from './specs-media.ts'
export { perceptionTool } from './specs-perception.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The structured tools: the specs, their runtime registration, and their DSH tools. */
    vhTools: VhTools
  }
}

/** `vhTools` plugin configuration. */
export interface Config {
  /** The output token cap of one `perception.describe` answer. */
  perceptionMaxTokens: number
  /** Whether the agent model accepts images; false makes `perception.describe` report that instead of calling the model. */
  imageInput: boolean
  /** Directory of one JSON file per session with its project binding, so a restart continues the session. */
  sessionStateRoot: string
  /** Base of asset URLs in results and chat cards, such as a tunnel origin; empty keeps them relative. */
  publicBaseUrl: string
  /** Estimated GPU seconds a turn may spend on `generate.video` calls before the user must agree. */
  confirmGpuSecondsThreshold: number
  /** Estimated GPU seconds per generated video second. */
  gpuSecondsPerVideoSecond: number
}

/** Loader validation. */
export const Config: z<Config> = z.object({
  perceptionMaxTokens: z.number().default(1024),
  imageInput: z.boolean().default(true),
  sessionStateRoot: z.string().required(),
  publicBaseUrl: z.string().default(''),
  confirmGpuSecondsThreshold: z.number().default(60),
  gpuSecondsPerVideoSecond: z.number().default(4),
})

/**
 * The record-only and small-file tools: import, characters, locations and styles, plans, timeline edits.
 * @param project - the Project service `plan.approve` schedules its shot renders through.
 * @param assets - the asset store that holds plan documents.
 * @returns the specs.
 */
export function basicTools(project: Parameters<typeof planApprove>[0], assets: Parameters<typeof planApprove>[1]): ToolSpec[] {
  return [
    assetUpload, ...entityTools('character'), ...entityTools('style'), ...entityTools('location'), planCreate, planUpdate,
    planApprove(project, assets), ...sequenceTools,
  ]
}

/** The operations that serve only the timeline export: registered with `dvProject`, with no agent tool and no canvas form. */
const EXPORT_ONLY: ReadonlySet<string> = new Set(['clip.trim'])

/** The spec registry and its two consumers: the Project service and the DSH tool registry. */
export default class VhTools extends Service {
  static inject = ['dvProject', 'vhAssets', 'vhMedia'] // names:allow (the asset store service until stage 3)
  static Config = Config

  private readonly specs = new Map<string, ToolSpec>()
  private dsh: DshTools | null = null
  private policy: ConfirmPolicy | null = null

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'vhTools')
    for (const [key, reducer] of Object.entries(bridgeReducers)) {
      ctx.effect(() => ctx.dvProject.registerReducer(key as keyof typeof bridgeReducers, reducer as never), `bridge reducer ${key}`)
    }
    for (const spec of [...basicTools(ctx.dvProject, ctx.vhAssets), ...mediaTools(ctx.vhMedia)]) {
      ctx.effect(() => this.register(spec), `vhTools.${spec.name}`)
    }
    ctx.inject(['dreamverseGeneration'], (child) => {
      const spec = generateVideoTool(child.dreamverseGeneration, ctx.vhAssets) // names:allow
      // The approval card shows the GPU time of the shot before it renders.
      const estimate = (params: Record<string, unknown>): { gpu_seconds: number } => ({
        gpu_seconds: estimateGpuSeconds(spec, params, config.gpuSecondsPerVideoSecond, 5),
      })
      child.effect(() => this.register({ ...spec, estimate }), 'vhTools.generate.video')
    })
    ctx.inject(['llm', 'agentDefaultModel', 'attachments'], (child) => {
      const tool = perceptionTool(child, ctx.vhAssets, config.perceptionMaxTokens, config.imageInput) // names:allow
      child.effect(() => this.register(tool), 'vhTools.perception.describe')
    })
    ctx.inject(['tools'], (child) => {
      child.effect(() => {
        const dsh = new DshTools(child, ctx.dvProject, ctx.vhAssets, {
          sessionStateRoot: config.sessionStateRoot,
          publicBaseUrl: config.publicBaseUrl,
          confirmGpuSecondsThreshold: config.confirmGpuSecondsThreshold,
          gpuSecondsPerVideoSecond: config.gpuSecondsPerVideoSecond,
        })
        dsh.setConfirmPolicy(this.policy)
        this.dsh = dsh
        for (const spec of this.list()) dsh.add(spec)
        dsh.addManagement()
        return () => {
          dsh.dispose()
          this.dsh = null
        }
      }, 'vhTools.dsh')
    })
  }

  /**
   * Register a structured tool as a `dvProject` operation and, when the DSH registry is mounted and the operation is
   * not export-only, as a DSH tool.
   * @param spec - the tool.
   * @returns a function that removes both registrations. Throws `operation_exists` for a registered name.
   */
  register(spec: ToolSpec): () => void {
    const removeOperation = this.ctx.dvProject.registerOperation(spec)
    this.specs.set(spec.name, spec)
    if (!EXPORT_ONLY.has(spec.name)) this.dsh?.add(spec)
    return () => {
      removeOperation()
      if (this.specs.get(spec.name) !== spec) return
      this.specs.delete(spec.name)
      this.dsh?.remove(spec.name)
    }
  }

  /**
   * @param name - a spec name such as `generate.video` or `clip.trim`.
   * @returns the registered spec, export-only operations included, or undefined.
   */
  get(name: string): ToolSpec | undefined {
    return this.specs.get(name)
  }

  /** @returns every registered spec that has an agent tool and a canvas form, in registration order. */
  list(): ToolSpec[] {
    return [...this.specs.values()].filter(spec => !EXPORT_ONLY.has(spec.name))
  }

  /**
   * Install the interactive confirmation channel the DSH bridge asks through; null leaves the argument protocol.
   * @param policy - the channel.
   */
  setConfirmPolicy(policy: ConfirmPolicy | null): void {
    this.policy = policy
    this.dsh?.setConfirmPolicy(policy)
  }

  /**
   * The bridge state of an agent session, or undefined while no DSH tool registry is mounted.
   * @param sessionId - the agent's session ID.
   * @returns the state, created empty on first use.
   */
  sessionState(sessionId: string): SessionState | undefined {
    return this.dsh?.stateOf(sessionId)
  }

  /**
   * Tell the bridge which agent turn a session is in and the human's words that started it, so the turn's records
   * carry the turn and its first record writes the turn's request record.
   * @param sessionId - the agent's session ID.
   * @param turn - the agent loop's turn number.
   * @param requestText - the human's words; empty while they are not known.
   */
  noteTurn(sessionId: string, turn: number, requestText: string): void {
    this.dsh?.noteTurn(sessionId, turn, requestText)
  }

  /**
   * Import the images a user attached in a chat as assets of the session's project.
   * @param sessionId - the agent's session ID.
   * @param refs - the image attachments of the user message.
   * @returns the imported asset IDs; none without a bound project, an attachment service, or a bridge.
   */
  recordChatImages(sessionId: string, refs: readonly ImageAttachmentRef[]): Promise<AssetId[]> {
    return this.dsh?.recordChatImages(sessionId, refs) ?? Promise.resolve([])
  }

  /**
   * The project an agent session works on, so a view opened beside that chat shows the same project.
   * @param sessionId - the agent's session ID.
   * @returns the project ID, or null while the session has none or no bridge is mounted.
   */
  sessionProject(sessionId: string): ProjectId | null {
    return this.dsh?.sessionProject(sessionId) ?? null
  }

  /**
   * Bind an agent session to a project, so its tools and the views beside its chat work on that project.
   * @param sessionId - the agent's session ID.
   * @param projectId - the project.
   * @returns whether a DSH tool registry was mounted to hold the binding.
   */
  bindSession(sessionId: string, projectId: ProjectId): boolean {
    if (this.dsh === null) return false
    this.dsh.bindSession(sessionId, projectId)
    return true
  }

  /**
   * @param id - an asset.
   * @returns its URL under the configured public base.
   */
  assetUrl(id: AssetId): string {
    return this.dsh?.url(id) ?? assetUrl(id, this.config.publicBaseUrl)
  }
}
