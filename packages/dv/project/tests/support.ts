/**
 * Shared fixtures of the `@dv/project` unit tests: a temporary store root, record origins, an in-memory asset store,
 * and a module set wired the same way as the `dvProject` service, without a Cordis context.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { onTestFinished } from 'vitest'
import { Drafts } from '../src/drafts.ts'
import { History } from '../src/history.ts'
import { RecordStore } from '../src/record-store.ts'
import { projReducer, ReducerRegistry } from '../src/reducers.ts'
import { Runner, type RunnerAssets } from '../src/runner.ts'
import { Scheduler } from '../src/scheduler.ts'
import { MAIN_BRANCH } from '../src/shared.ts'
import { Subscriptions } from '../src/subscriptions.ts'
import type { AssetId, ProjectEvent, ProjectId, RecordOrigin, SessionId, TurnId } from '../src/types.ts'

/**
 * A temporary directory that is removed when the current test finishes.
 * @returns the directory path.
 */
export function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dv-project-test-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** The session most tests use. */
export const SESSION = brandString<SessionId>('session-a')
/** A second session, for tests with two chat sessions. */
export const OTHER_SESSION = brandString<SessionId>('session-b')

/**
 * A human edit from the canvas in {@link SESSION}.
 * @param overrides - fields to change.
 * @returns the origin.
 */
export function userOrigin(overrides: Partial<RecordOrigin> = {}): RecordOrigin {
  return { actor: 'user', surface: 'canvas', session: SESSION, turn: null, tool_call: null, intent: 'edit on the canvas', ...overrides }
}

/**
 * An agent tool call in {@link SESSION}.
 * @param turn - the turn ID text.
 * @param overrides - fields to change.
 * @returns the origin.
 */
export function agentOrigin(turn = 'turn-1', overrides: Partial<RecordOrigin> = {}): RecordOrigin {
  return {
    actor: 'agent', surface: 'chat', session: SESSION, turn: brandString<TurnId>(turn), tool_call: `call-${turn}`,
    intent: 'agent step', ...overrides,
  }
}

/** An in-memory asset store; IDs are the sha256 of the bytes, or of the path text for a path source. */
export class FakeAssets implements RunnerAssets {
  /** Asset ID → the record that created it. */
  readonly created = new Map<AssetId, string | null>()

  /**
   * Add an asset as if it had been imported earlier.
   * @param text - the asset's content.
   * @returns the asset ID.
   */
  add(text: string): AssetId {
    return this.importAsset(Buffer.from(text), { mime: 'text/plain', name: 'fixture.txt' }, null)
  }

  has(asset: AssetId): boolean {
    return this.created.has(asset)
  }

  importAsset(source: Uint8Array | { path: string }, meta: { mime: string; name: string }, createdBy: string | null): AssetId {
    void meta
    const bytes = 'path' in source ? Buffer.from(source.path) : source
    const id = brandString<AssetId>(createHash('sha256').update(bytes).digest('hex'))
    this.created.set(id, createdBy)
    return id
  }
}

/** Every module of the service, wired as `DvProject` wires them, plus the events the store emitted. */
export interface ProjectModules {
  root: string
  store: RecordStore
  subscriptions: Subscriptions
  reducers: ReducerRegistry
  drafts: Drafts
  history: History
  scheduler: Scheduler
  runner: Runner
  assets: FakeAssets
  events: Array<{ project: ProjectId; event: ProjectEvent }>
}

/**
 * Build the module set on a temporary root, load it, and register the `proj` reducer.
 * @param limits - the scheduler limits; defaults to one `gpu` and four `cpu`.
 * @returns the modules.
 */
export function startModules(limits = { cpu: 4, gpu: 1 }): ProjectModules {
  const root = tempRoot()
  const events: ProjectModules['events'] = []
  const subscriptions = new Subscriptions()
  // Scheduler and store refer to each other through callbacks, read at call time.
  const holder: { scheduler: Scheduler | null; runner: Runner | null } = { scheduler: null, runner: null }
  const store = new RecordStore(root, (project, event) => {
    events.push({ project, event })
    subscriptions.emit(project, event)
    if (event.kind === 'update' && ['done', 'failed', 'cancelled'].includes(event.record.status)) holder.scheduler?.recordFinished(project)
  })
  const reducers = new ReducerRegistry(store)
  const drafts = new Drafts(store, reducers)
  const history = new History(store)
  const assets = new FakeAssets()
  const scheduler = new Scheduler(store, (project, record) => {
    if (holder.runner === null) throw new Error('runner not built')
    return holder.runner.execute(project, record)
  }, limits)
  const runner = new Runner({ store, drafts, reducers, scheduler, assets })
  holder.scheduler = scheduler
  holder.runner = runner
  store.load()
  reducers.register('proj', projReducer)
  onTestFinished(() => { scheduler.dispose() })
  return { root, store, subscriptions, reducers, drafts, history, scheduler, runner, assets, events }
}

/**
 * The lines of a project's `records.jsonl`, parsed.
 * @param root - the store root.
 * @param project - the project.
 * @returns one object per line.
 */
export function readLines(root: string, project: ProjectId): Array<Record<string, unknown>> {
  return readFileSync(join(root, project, 'records.jsonl'), 'utf8').split('\n').filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Create a project the way `DvProject.createProject` does: `project.json`, then a `proj.create` record on `main`.
 * @param modules - the module set.
 * @param title - the project title.
 * @returns the project ID.
 */
export async function createTestProject(modules: ProjectModules, title = 'Test project'): Promise<ProjectId> {
  const id = brandString<ProjectId>(`project-${String(modules.store.listProjects().length + 1)}`)
  modules.store.createProject({ id, title, created_at: new Date().toISOString() })
  await modules.store.lock(id, () => modules.store.append(id, {
    parents: [], branch: MAIN_BRANCH, kind: 'operation', component: 'proj', operation: 'proj.create', operation_version: '1',
    ...userOrigin({ session: null, intent: `create project ${title}` }), params: { title }, inputs: [], outputs: [], based_on: null,
    supersedes: [], deterministic: true, status: 'done',
  }))
  return id
}
