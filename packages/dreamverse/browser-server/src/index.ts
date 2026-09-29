/**
 * `@dreamverse/browser-server`: the HTTP and WebSocket surface that the DreamVerse browser UI talks to. It serves
 * `/ws` projects and every browser HTTP route: health and readiness, creation capabilities, assets, prompt
 * configuration, and, with developer tools, curated presets. Unloading the plugin closes the listener and every
 * project socket.
 *
 * @module @dreamverse/browser-server
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@dreamverse/assets-manager'
import type {} from '@dreamverse/generation-client'
import type {} from '@dreamverse/project'
import type {} from '@dreamverse/prompt-enhancer'
import { DreamverseBrowserServer } from './browser-server.ts'

export type * from './dependencies.ts'

export const name = 'dreamverse-browser-server'

export const inject = ['dreamverseGeneration', 'dreamverseAssetsManager', 'dreamverseProjects', 'dreamversePromptEnhancer']

/** Browser listener address and the reference application settings that select and configure routes. */
export interface Config {
  /** Listen address, such as `127.0.0.1`. */
  host: string
  /** Listen port; the DreamVerse UI reaches it through `BACKEND_PORT`. */
  port: number
  /** Serve `GET /curated-presets` and `POST /curated-presets/append`, like the reference `devtools_enabled`. */
  devtoolsEnabled: boolean
  /** The curated preset catalog that appends write. */
  curatedPresetsFilePath: string
  /**
   * The catalog whose presets the `curatedPresetsFilePath` catalog replaces by ID. Schemastery reads `null` as an
   * absent value, and both mean that no fallback catalog exists.
   */
  curatedPresetsFallbackFilePath?: string | null
}

export const Config: z<Config> = z.object({
  host: z.string().required(),
  port: z.natural().max(65535).required(),
  devtoolsEnabled: z.boolean().default(false),
  curatedPresetsFilePath: z.string().required(),
  curatedPresetsFallbackFilePath: z.union([z.string(), z.const(null)]),
})

/**
 * Listen for browser requests until the plugin unloads.
 * @param ctx - plugin context with the injected DreamVerse services.
 * @param config - validated listener address and route settings.
 * @returns a promise that settles once the listener accepts connections.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const server = new DreamverseBrowserServer({
    generation: ctx.dreamverseGeneration,
    assets: ctx.dreamverseAssetsManager,
    projects: ctx.dreamverseProjects,
    promptEnhancer: ctx.dreamversePromptEnhancer,
    logger: ctx.logger('dreamverse'),
  }, {
    devtoolsEnabled: config.devtoolsEnabled,
    curatedPresets: { filePath: config.curatedPresetsFilePath, fallbackFilePath: config.curatedPresetsFallbackFilePath ?? null },
  })
  let listening!: Promise<void>
  ctx.effect(() => {
    listening = server.listen(config.host, config.port)
    return () => server.close()
  }, 'dreamverse browser listener')
  await listening
}
