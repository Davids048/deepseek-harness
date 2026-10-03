/**
 * Mounts `dreamverseProjects` on a real `dreamverseProjectStore` (in a temporary root) and a real
 * `dreamverseSegmentGeneration`, with fake generation, file store, and prompt-enhancer services, optional user-action
 * plugins, and a temporary project log root, then runs projects against fake sockets.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import DreamverseProjectStore from '@dreamverse/project-store'
import DreamverseSegmentGeneration from '@dreamverse/segment-generation'
import DreamverseProjects, { type Project, type ProjectHolder, type ProjectId } from '../src/index.ts'
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

/** One running project with its fake socket, its lease holder, and the harness's generation backend. */
export interface ProjectRun {
  project: Project
  socket: FakeSocket
  holder: FakeHolder
  generation: FakeGeneration
  /** `processQueuedGenerationActions()`. */
  loop: Promise<void>
  /** Settles with the loop's rejection reason, or null when the loop resolved. */
  outcome: Promise<unknown>
}

/** A lease holder that closes its project and releases the lease when another party acquires it, as a browser connection does. */
export class FakeHolder implements ProjectHolder {
  /** How often the store revoked this holder's lease. */
  revocations = 0
  /** The project that this holder serves, once the harness started it. */
  run: ProjectRun | undefined

  async revoke(): Promise<void> {
    this.revocations += 1
    if (this.run === undefined) return
    const closing = this.run.project.closeAndWaitForGeneration()
    this.run.socket.resumeAll()
    await closing
    await this.run.outcome
    this.run.project.releaseLease()
  }
}

/** The fake services that `openProjects()` provides; omitted fakes are created with their defaults. */
export interface FakeServices {
  generation?: FakeGeneration
  assets?: FakeAssets
  enhancer?: FakePromptEnhancer
  projectRoot?: string
}

/** A mounted `dreamverseProjects` service with its fakes, log root, and project store root. */
export class ProjectsHarness {
  private readonly runs: ProjectRun[] = []
  /** Store-assigned project IDs to the names that `logEntries()` reports: `project`, `project-2`, … in start order. */
  private readonly projectNames = new Map<string, string>()

  constructor(
    readonly ctx: Context,
    readonly generation: FakeGeneration,
    readonly assets: FakeAssets,
    readonly enhancer: FakePromptEnhancer,
    readonly logRoot: string,
    readonly projectRoot: string,
  ) {}

  get service(): DreamverseProjects {
    return this.ctx.dreamverseProjects
  }

  get store(): DreamverseProjectStore {
    return this.ctx.dreamverseProjectStore
  }

  /**
   * Create a project and start serving its queued actions.
   * @param payload - the `project_init_v1` message.
   * @param socket - the browser socket fake.
   * @returns the running project.
   */
  async start(payload: Record<string, unknown>, socket = new FakeSocket()): Promise<ProjectRun> {
    const holder = new FakeHolder()
    return this.serve(await this.service.createProject({ payload, socket, holder }), socket, holder)
  }

  /**
   * Open a stored project and start serving its queued actions.
   * @param projectId - the stored project's ID.
   * @param socket - the browser socket fake.
   * @returns the running project.
   */
  async open(projectId: ProjectId, socket = new FakeSocket()): Promise<ProjectRun> {
    const holder = new FakeHolder()
    return this.serve(await this.service.openProject({ projectId, socket, holder }), socket, holder)
  }

  /** Start the generation loop of a created or opened project and track it for disposal. */
  private serve(project: Project, socket: FakeSocket, holder: FakeHolder): ProjectRun {
    const loop = project.processQueuedGenerationActions()
    const outcome = loop.then(() => null, (error: unknown) => error)
    const run = { project, socket, holder, generation: this.generation, loop, outcome }
    holder.run = run
    this.runs.push(run)
    if (!this.projectNames.has(project.projectId)) {
      this.projectNames.set(project.projectId, this.projectNames.size === 0 ? 'project' : `project-${this.projectNames.size + 1}`)
    }
    return run
  }

  /**
   * @returns the project log entries written so far, in file order, with `segment_complete` latencies normalized
   *   to `MEASURED_LATENCY` form and the project IDs of started projects replaced by their names in start order.
   */
  logEntries(): BrowserEvent[] {
    const directory = join(this.logRoot, hostname())
    const [file] = readdirSync(directory)
    const entries = readFileSync(join(directory, file!), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as BrowserEvent)
    for (const entry of entries) {
      if (entry['event'] === 'segment_complete') entry['latency_ms'] = normalizeLatency(entry['latency_ms'] as Record<string, number>)
      entry['project_id'] = this.projectNames.get(String(entry['project_id'])) ?? entry['project_id']
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

  /**
   * Close every started project and give up its lease, dispose the service, and remove the log and project roots and
   * the file store.
   */
  async dispose(): Promise<void> {
    for (const run of this.runs) {
      const closing = run.project.closeAndWaitForGeneration()
      run.socket.resumeAll()
      await within(closing, 'project closure')
      await within(run.outcome, 'generation loop')
      run.project.releaseLease()
    }
    await this.ctx.fiber.dispose()
    rmSync(this.logRoot, { recursive: true, force: true })
    rmSync(this.projectRoot, { recursive: true, force: true })
    this.assets.dispose()
  }
}

/**
 * Mount the project store, segment generation, the project service, and the given user-action plugins on fake
 * services.
 * @param plugins - user-action plugin modules to load after the service.
 * @param services - the generation backend, file store, and prompt enhancer fakes, and a project store root whose
 *   content the spec prepared, such as schema-1 projects to migrate.
 * @returns the harness; call `dispose()` after the spec.
 */
export async function openProjects(plugins: Plugin[] = [], services: FakeServices = {}): Promise<ProjectsHarness> {
  const { generation = new FakeGeneration(), assets = new FakeAssets(), enhancer = new FakePromptEnhancer() } = services
  const ctx = new Context()
  const logRoot = mkdtempSync(join(tmpdir(), 'dreamverse-project-'))
  const projectRoot = services.projectRoot ?? mkdtempSync(join(tmpdir(), 'dreamverse-project-store-'))
  ctx.provide('dreamverseGeneration', generation)
  ctx.provide('dreamverseAssetsManager', assets)
  ctx.provide('dreamversePromptEnhancer', enhancer)
  await ctx.plugin(DreamverseProjectStore, { root: projectRoot }).await()
  await ctx.plugin(DreamverseSegmentGeneration).await()
  // The service migrates schema-1 projects before it is ready.
  await ctx.plugin(DreamverseProjects, { projectLogRoot: logRoot }).await()
  for (const plugin of plugins) await ctx.plugin(plugin).await()
  return new ProjectsHarness(ctx, generation, assets, enhancer, logRoot, projectRoot)
}
