/**
 * Project card summaries: the cover, the shot count and duration, and the last edit time of one branch, the draft
 * fallback of a project without a rendered take on `main`, and the `/api/dv/projects/summary` route over the real
 * Project service.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { AssetId, ProjectId, ProjectRecord, RecordId, RecordOrigin, SessionId, TurnId } from '@dv/project'
import type { PlanId, PlanVersion } from '@dv/shot-plan'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DvApi, { ROUTES } from '../src/index.ts'
import { summarizeBranch, summarizeProject, type SummarySource } from '../src/summaries.ts'
import { startBase, type BaseFixture } from './support.ts'

/** The MIME type of every asset the branch tests name. */
const MIME: Record<string, string> = {
  'ref.png': 'image/png', 'shot1.mp4': 'video/mp4', 'shot1-last.png': 'image/png', 'shot2.mp4': 'video/mp4',
  'shot2-last.png': 'image/png', 'notes.txt': 'text/plain',
}

/**
 * @param id - an asset ID.
 * @returns its MIME type, or null for an asset the pool does not hold.
 */
const mimeOf = (id: AssetId): string | null => MIME[id] ?? null

/**
 * A finished record with defaults for every field a test does not set.
 * @param id - the record ID.
 * @param operation - the operation.
 * @param fields - the fields that matter to the test.
 * @returns the record.
 */
function record(id: string, operation: string, fields: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: brandString<RecordId>(id), parents: [], branch: 'main', kind: 'operation', component: operation.split('.')[0] ?? 'proj', operation,
    operation_version: '1', actor: 'user', surface: 'chat', turn: null, session: null, tool_call: null, intent: '', params: {}, inputs: [],
    outputs: [], based_on: null, supersedes: [], deterministic: true, status: 'done', created_at: '2026-10-05T00:00:00Z', ...fields,
  }
}

/**
 * @param ids - asset IDs.
 * @returns the IDs as `AssetId`s.
 */
const assets = (...ids: string[]): AssetId[] => ids.map(id => brandString<AssetId>(id))

/**
 * A plan version with the given shot durations.
 * @param version - the 1-based version.
 * @param durations - one entry per shot; undefined for a shot without a duration.
 * @returns the version.
 */
function planVersion(version: number, durations: Array<number | undefined>): PlanVersion {
  return {
    version, created_by: brandString<RecordId>(`plan-${String(version)}`), approved_by: null,
    shots: durations.map(duration => ({ prompt: 'shot', mode: 'ref2va' as const, ...duration === undefined ? {} : { duration_sec: duration } })),
  }
}

/**
 * A branch with an imported reference, two finished renders after a failed one, and one plan of two versions.
 * @returns the branch slices.
 */
function branch(): SummarySource {
  return {
    components: {
      proj: {
        records: [
          record('u1', 'asset.import', { outputs: assets('notes.txt', 'ref.png') }),
          record('f0', 'shot.render_t2va', { status: 'failed' }),
          record('g1', 'shot.render_ref2va', { outputs: assets('shot1-last.png', 'shot1.mp4') }),
          record('g2', 'shot.render_ref2va', { outputs: assets('shot2.mp4', 'shot2-last.png') }),
          record('t1', 'timeline.create', { created_at: '2026-10-06T00:00:00Z', finished_at: '2026-10-06T00:00:05Z' }),
        ],
        stale: {}, superseded: {}, created_by: {},
      },
      plan: { plans: { [brandString<PlanId>('p1')]: [planVersion(1, [5]), planVersion(2, [4.5, undefined, 55])] } },
    },
  }
}

describe('summarizeBranch', () => {
  it('takes the video and last-frame image of the first finished render, the latest plan shots, and the last record time', () => {
    expect(summarizeBranch(branch(), mimeOf)).toEqual({
      cover: { video: 'shot1.mp4', image: 'shot1-last.png' }, rendered: true, shots: 3, duration_sec: 59.5, edited_at: '2026-10-06T00:00:05Z',
    })
  })

  it('falls back to the first imported image, and reports no cover and no records on an empty branch', () => {
    const source = branch()
    source.components.proj.records = source.components.proj.records.filter(entry => entry.operation?.startsWith('shot.render_') !== true)
    expect(summarizeBranch(source, mimeOf)).toMatchObject({ cover: { video: null, image: 'ref.png' }, rendered: false })
    source.components.proj.records = []
    source.components.plan.plans = {}
    expect(summarizeBranch(source, mimeOf)).toEqual({ cover: null, rendered: false, shots: 0, duration_sec: 0, edited_at: null })
  })
})

describe('summarizeProject', () => {
  it('reads the first open draft only when main has no rendered take', () => {
    const projectId = brandString<ProjectId>('p1')
    const rendered = branch()
    const empty: SummarySource = { components: { proj: { records: [], stale: {}, superseded: {}, created_by: {} }, plan: { plans: {} } } }
    const reads: string[] = []
    const from = (main: SummarySource) => (name: string): SummarySource => {
      reads.push(name)
      return name === 'main' ? main : rendered
    }
    expect(summarizeProject(projectId, from(rendered), 'draft/s1', mimeOf)).toMatchObject({ project: 'p1', cover: { video: 'shot1.mp4' } })
    expect(reads).toEqual(['main'])
    expect(summarizeProject(projectId, from(empty), 'draft/s1', mimeOf)).toMatchObject({ cover: { video: 'shot1.mp4' }, shots: 3 })
    expect(reads).toEqual(['main', 'main', 'draft/s1'])
    expect(summarizeProject(projectId, from(empty), null, mimeOf)).toEqual({ project: 'p1', cover: null, shots: 0, duration_sec: 0, edited_at: null })
  })
})

/** Keeps the registered Fetch routes. */
class FakeConnection {
  readonly routes = new Map<string, ConnectionFetchRoute>()
  readonly fetch = {
    register: (route: ConnectionFetchRoute): (() => Promise<void>) => {
      this.routes.set(route.path, route)
      return () => { this.routes.delete(route.path); return Promise.resolve() }
    },
  }

  requestRejection(): undefined {
    return undefined
  }
}

/** A human action outside any chat session. */
const HUMAN: RecordOrigin = { actor: 'user', surface: 'api', session: null, turn: null, tool_call: null, intent: 'test' }

let fixture: BaseFixture | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  await fixture?.dispose()
  fixture = null
})

describe(ROUTES.projectSummaries, () => {
  it('summarizes every project or one project, reading a chat session\'s draft when main has no rendered take', async () => {
    const base = await startBase({ generation: 'none', dsh: false })
    fixture = base
    const connection = new FakeConnection()
    base.context.provide('connection', connection)
    await base.context.plugin(DvApi, { keepaliveMs: 50, stateRoot: base.root }).await()
    const imported = (await base.project.createProject('imported', HUMAN)).id
    const drafted = (await base.project.createProject('drafted', HUMAN)).id
    const blank = (await base.project.createProject('blank', HUMAN)).id
    const importImage = async (projectId: ProjectId, name: string, session: string | null): Promise<AssetId> => {
      const origin: RecordOrigin = session === null ? HUMAN : {
        actor: 'agent', surface: 'chat', session: brandString<SessionId>(session), turn: brandString<TurnId>('turn-1'), tool_call: 'call-1',
        intent: `import ${name}`,
      }
      const { record: written } = await base.project.run({
        ...origin, project: projectId, operation: 'asset.import', params: { path: base.writeFile(name, name), mime: 'image/png' }, inputs: [],
      })
      const asset = written?.outputs[0]
      if (asset === undefined) throw new Error('asset.import created no asset')
      return asset
    }
    const mainImage = await importImage(imported, 'main.png', null)
    const draftImage = await importImage(drafted, 'draft.png', 's1')

    const route = connection.routes.get(ROUTES.projectSummaries)
    if (route === undefined) throw new Error(`no route ${ROUTES.projectSummaries}`)
    const read = async (query: string): Promise<{ status: number; json: unknown }> => {
      const response = await route.fetch(new Request(`http://localhost${ROUTES.projectSummaries}${query}`))
      return { status: response.status, json: await response.json() }
    }
    const all = await read('')
    expect(all.status).toBe(200)
    const summaries = all.json as Array<{ project: string; cover: unknown; shots: number; duration_sec: number; edited_at: string | null }>
    const byProject = new Map(summaries.map(summary => [summary.project, summary]))
    expect([...byProject.keys()].sort()).toEqual([imported, drafted, blank].sort())
    expect(byProject.get(imported)).toMatchObject({ cover: { video: null, image: mainImage }, shots: 0, duration_sec: 0 })
    expect(byProject.get(drafted)).toMatchObject({ cover: { video: null, image: draftImage } })
    expect(byProject.get(blank)).toMatchObject({ cover: null, shots: 0, duration_sec: 0 })
    for (const summary of summaries) expect(Number.isNaN(Date.parse(summary.edited_at ?? ''))).toBe(false)
    // `project` narrows the list to one project and is checked like every project the routes name.
    expect(await read(`?project=${drafted}`)).toEqual({ status: 200, json: [byProject.get(drafted)] })
    expect(await read('?project=missing')).toMatchObject({ status: 404, json: { code: 'unknown_project' } })
    expect(await read('?project=a%2Fb')).toMatchObject({ status: 400, json: { code: 'invalid_params' } })
  })

  it('gives a project whose state read throws an empty entry and still lists the others', async () => {
    const base = await startBase({ generation: 'none', dsh: false })
    fixture = base
    const connection = new FakeConnection()
    base.context.provide('connection', connection)
    await base.context.plugin(DvApi, { keepaliveMs: 50, stateRoot: base.root }).await()
    const healthy = (await base.project.createProject('healthy', HUMAN)).id
    const broken = (await base.project.createProject('broken', HUMAN)).id
    const getState = base.project.getState.bind(base.project)
    vi.spyOn(base.project, 'getState').mockImplementation((projectId, branch) => {
      if (projectId === broken) throw new Error('records.jsonl is corrupt')
      return getState(projectId, branch)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const route = connection.routes.get(ROUTES.projectSummaries)
    if (route === undefined) throw new Error(`no route ${ROUTES.projectSummaries}`)
    const response = await route.fetch(new Request(`http://localhost${ROUTES.projectSummaries}`))
    expect(response.status).toBe(200)
    const summaries = await response.json() as Array<{ project: string; edited_at: string | null }>
    const empty = { project: broken, cover: null, shots: 0, duration_sec: 0, edited_at: null }
    expect(summaries.find(summary => summary.project === broken)).toEqual(empty)
    expect(summaries.find(summary => summary.project === healthy)?.edited_at).toEqual(expect.any(String))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`project ${broken} summary failed: records.jsonl is corrupt`))
    // The single-project form still answers with the error.
    const single = await route.fetch(new Request(`http://localhost${ROUTES.projectSummaries}?project=${broken}`))
    expect(single.status).toBe(500)
  })
})
