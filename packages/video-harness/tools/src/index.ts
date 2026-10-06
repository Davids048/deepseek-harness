/**
 * The structured tools of the video harness as the `vhTools` Cordis service: the registry of {@link ToolSpec}s, each
 * registered into the project runtime so views and the agent invoke it, and exposed to the DSH agent as a `vh_<name>`
 * tool when the `tools` registry is mounted. `generate.video` is mounted when `dreamverseGeneration` is, and
 * `perception.describe` when `llm`, `agentDefaultModel`, and `attachments` are.
 *
 * @module @video-harness/tools
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@dreamverse/generation-client'
import type { AssetId, ProjectId } from '@video-harness/oplog'
import type {} from '@video-harness/assets'
import type {} from '@video-harness/media'
import type {} from '@video-harness/oplog'
import type {} from '@video-harness/runtime'
import { assetUrl, DshTools, type ConfirmGate, type ConfirmPolicy, type SessionState, type TurnSettlement } from './dsh.ts'
import { assetUpload, entityTools, planApprove, planCreate, planUpdate, sequenceTools } from './specs-basic.ts'
import { generateVideoTool } from './specs-generate.ts'
import { mediaTools } from './specs-media.ts'
import { perceptionTool } from './specs-perception.ts'
import type { ToolSpec } from './types.ts'

export * from './types.ts'
export { assetUrl, dshToolName, estimateGpuSeconds, parseInputs, renderValue, sessionKey, type BridgeOptions, type ConfirmGate, type ConfirmPolicy, type ConfirmRequest, type SessionState, type ToolCallValue, type TurnSettlement } from './dsh.ts'
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
  /** Directory of one JSON file per session with its project binding and open turn, so a restart continues the session. */
  sessionStateRoot: string
  /** Base of asset URLs in results and chat cards, such as a tunnel origin; empty keeps them relative. */
  publicBaseUrl: string
  /** Estimated GPU seconds a turn may spend on `confirm: cost` tools before the user must agree. */
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
 * The record-only and small-file tools: upload, entities, plans, sequence edits.
 * @returns the specs.
 */
export function basicTools(): ToolSpec[] {
  return [assetUpload, ...entityTools('character'), ...entityTools('style'), ...entityTools('location'), planCreate, planUpdate, planApprove, ...sequenceTools]
}

/** The spec registry and its two consumers: the project runtime and the DSH tool registry. */
export default class VhTools extends Service {
  static inject = ['vhProject', 'vhOpLog', 'vhAssets', 'vhMedia']
  static Config = Config

  private readonly specs = new Map<string, ToolSpec>()
  private dsh: DshTools | null = null
  private policy: ConfirmPolicy | null = null
  private gate: ConfirmGate | null = null

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'vhTools')
    for (const spec of [...basicTools(), ...mediaTools(ctx.vhMedia)]) {
      // `clip.trim` serves only the timeline export, so it is registered with the runtime alone: no agent tool, no canvas form.
      const register = spec.name === 'clip.trim' ? () => ctx.vhProject.registerTool(spec) : () => this.register(spec)
      ctx.effect(register, `vhTools.${spec.name}`)
    }
    ctx.inject(['dreamverseGeneration'], (child) => {
      child.effect(() => this.register(generateVideoTool(child.dreamverseGeneration)), 'vhTools.generate.video')
    })
    ctx.inject(['llm', 'agentDefaultModel', 'attachments'], (child) => {
      child.effect(() => this.register(perceptionTool(child, config.perceptionMaxTokens, config.imageInput)), 'vhTools.perception.describe')
    })
    ctx.inject(['tools'], (child) => {
      child.effect(() => {
        const dsh = new DshTools(child, ctx.vhProject, ctx.vhOpLog, ctx.vhAssets, {
          sessionStateRoot: config.sessionStateRoot,
          publicBaseUrl: config.publicBaseUrl,
          confirmGpuSecondsThreshold: config.confirmGpuSecondsThreshold,
          gpuSecondsPerVideoSecond: config.gpuSecondsPerVideoSecond,
        })
        dsh.setConfirmPolicy(this.policy)
        dsh.setConfirmGate(this.gate)
        this.dsh = dsh
        for (const spec of this.specs.values()) dsh.add(spec)
        dsh.addManagement()
        return () => {
          dsh.dispose()
          this.dsh = null
        }
      }, 'vhTools.dsh')
    })
  }

  /**
   * Register a structured tool with the runtime and, when the DSH registry is mounted, as a DSH tool. A later spec of
   * the same name replaces the earlier one.
   * @param spec - the tool.
   * @returns a function that removes both registrations.
   */
  register(spec: ToolSpec): () => void {
    this.specs.set(spec.name, spec)
    const removeFromRuntime = this.ctx.vhProject.registerTool(spec)
    this.dsh?.add(spec)
    return () => {
      removeFromRuntime()
      if (this.specs.get(spec.name) !== spec) return
      this.specs.delete(spec.name)
      this.dsh?.remove(spec.name)
    }
  }

  /**
   * @param name - a spec name such as `generate.video`.
   * @returns the registered spec, or undefined.
   */
  get(name: string): ToolSpec | undefined {
    return this.specs.get(name)
  }

  /** @returns every registered spec, in registration order. */
  list(): ToolSpec[] {
    return [...this.specs.values()]
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
   * Install or remove the gate that makes selected calls always ask the confirmation policy.
   * @param gate - true for calls that must ask; null restores the plain confirmation table.
   */
  setConfirmGate(gate: ConfirmGate | null): void {
    this.gate = gate
    this.dsh?.setConfirmGate(gate)
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
   * Tell the bridge which agent-loop turn a session entered.
   * @param sessionId - the agent's session ID.
   * @param turn - the turn number.
   */
  noteTurn(sessionId: string, turn: number): void {
    this.dsh?.noteTurn(sessionId, turn)
  }

  /**
   * Settle a session's open draft when its agent-loop turn ends.
   * @param sessionId - the agent's session ID.
   * @param outcome - how the turn ended.
   * @returns what happened to the draft; `none` when there was none or no bridge.
   */
  settleTurn(sessionId: string, outcome: 'completed' | 'interrupted' | 'aborted'): TurnSettlement {
    return this.dsh?.settleTurn(sessionId, outcome) ?? 'none'
  }

  /**
   * Record the images a user attached in a chat as assets of the session's project.
   * @param sessionId - the agent's session ID.
   * @param refs - the image attachments of the user message.
   * @returns the recorded asset IDs; none without a bound project, an attachment service, or a bridge.
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
