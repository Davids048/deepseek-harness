/**
 * Mounts `dreamverseProjects` with fake generation, asset, and prompt-enhancer services, optional user-action plugins,
 * and a temporary project log root, then runs projects against fake sockets.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import DreamverseProjects, { type Project } from '../src/index.ts'
import { FakeAssets, FakeGeneration, FakePromptEnhancer, FakeSocket, within, type BrowserEvent } from './fakes.ts'

/**
 * The `segment_complete` latency after `logEntries()` normalization: wall-clock figures read `measured`, and the
 * worker figure keeps the fake generation backend's `e2e_latency_ms`.
 */
export const MEASURED_LATENCY = { total: 'measured', worker_e2e: 1, main_user_step: 'measured', overhead: 'measured' }

/**
 * Check a `segment_complete` latency's keys and fixed relation, then replace its wall-clock figures.
 * @param latency - the logged `latency_ms` object.
 * @returns the latency with `total`, `main_user_step`, and `overhead` replaced by `measured`.
 */
function normalizeLatency(latency: Record<string, number>): Record<string, unknown> {
  if (Object.keys(latency).join() !== 'total,worker_e2e,main_user_step,overhead' || latency['main_user_step'] !== latency['total']) {
    throw new Error(`Unexpected segment latency: ${JSON.stringify(latency)}`)
  }
  return { total: 'measured', worker_e2e: latency['worker_e2e'], main_user_step: 'measured', overhead: 'measured' }
}

/** One running project with its fake socket and the harness's generation backend. */
export interface ProjectRun {
  project: Project
  socket: FakeSocket
  generation: FakeGeneration
  /** `processQueuedGenerationActions()`. */
  loop: Promise<void>
  /** Settles with the loop's rejection reason, or null when the loop resolved. */
  outcome: Promise<unknown>
}

/** The fake services that `openProjects()` provides; omitted fakes are created with their defaults. */
export interface FakeServices {
  generation?: FakeGeneration
  assets?: FakeAssets
  enhancer?: FakePromptEnhancer
}

/** A mounted `dreamverseProjects` service with its fakes and log root. */
export class ProjectsHarness {
  private readonly runs: ProjectRun[] = []

  constructor(
    readonly ctx: Context,
    readonly generation: FakeGeneration,
    readonly assets: FakeAssets,
    readonly enhancer: FakePromptEnhancer,
    readonly logRoot: string,
  ) {}

  get service(): DreamverseProjects {
    return this.ctx.dreamverseProjects
  }

  /**
   * Create a project and start serving its queued actions.
   * @param payload - the `project_init_v1` message.
   * @param socket - the browser socket fake.
   * @returns the running project.
   */
  async start(payload: Record<string, unknown>, socket = new FakeSocket()): Promise<ProjectRun> {
    const project = await this.service.createProject({ projectId: 'project', payload, socket })
    const loop = project.processQueuedGenerationActions()
    const outcome = loop.then(() => null, (error: unknown) => error)
    const run = { project, socket, generation: this.generation, loop, outcome }
    this.runs.push(run)
    return run
  }

  /**
   * @returns the project log entries written so far, in file order, with `segment_complete` latencies normalized
   *   to `MEASURED_LATENCY` form.
   */
  logEntries(): BrowserEvent[] {
    const directory = join(this.logRoot, hostname())
    const [file] = readdirSync(directory)
    const entries = readFileSync(join(directory, file!), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as BrowserEvent)
    for (const entry of entries) {
      if (entry['event'] === 'segment_complete') entry['latency_ms'] = normalizeLatency(entry['latency_ms'] as Record<string, number>)
    }
    return entries
  }

  /**
   * @param event - the project log event name.
   * @returns the entries of that event without their `ts` field.
   */
  logEvents(event: string): BrowserEvent[] {
    return this.logEntries().filter(entry => entry['event'] === event).map(({ ts: _ts, ...entry }) => entry)
  }

  /** Close every started project, dispose the service, and remove the log root and the asset library. */
  async dispose(): Promise<void> {
    for (const run of this.runs) {
      const closing = run.project.closeAndWaitForGeneration()
      run.socket.resumeAll()
      await within(closing, 'project closure')
      await within(run.outcome, 'generation loop')
    }
    await this.ctx.fiber.dispose()
    rmSync(this.logRoot, { recursive: true, force: true })
    this.assets.dispose()
  }
}

/**
 * Mount the project service and the given user-action plugins on fake services.
 * @param plugins - user-action plugin modules to load after the service.
 * @param services - the generation backend, asset library, and prompt enhancer fakes.
 * @returns the harness; call `dispose()` after the spec.
 */
export async function openProjects(plugins: Plugin[] = [], services: FakeServices = {}): Promise<ProjectsHarness> {
  const { generation = new FakeGeneration(), assets = new FakeAssets(), enhancer = new FakePromptEnhancer() } = services
  const ctx = new Context()
  const logRoot = mkdtempSync(join(tmpdir(), 'dreamverse-project-'))
  ctx.provide('dreamverseGeneration', generation)
  ctx.provide('dreamverseAssetsManager', assets)
  ctx.provide('dreamversePromptEnhancer', enhancer)
  await ctx.plugin(DreamverseProjects, { projectLogRoot: logRoot })
  for (const plugin of plugins) await ctx.plugin(plugin)
  return new ProjectsHarness(ctx, generation, assets, enhancer, logRoot)
}
