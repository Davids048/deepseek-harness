/**
 * A project state the view tests share: one character, one approved plan whose shots were rendered and put on a
 * timeline, a failed export, and a running retake as the last record. Also a scripted `fetch` that answers the
 * `/api/dv` routes from such a state and records every write.
 */
import type { OperationRequest, ProjectAsset, ProjectRecord, WireOperation, WireProject, WireState } from '../src/client/types.ts'

/**
 * A record with defaults for everything a test does not set.
 * @param partial - the fields that matter to the test.
 * @returns the record.
 */
export function record(partial: Partial<ProjectRecord> & { id: string }): ProjectRecord {
  const operation = partial.operation ?? null
  return {
    parents: [], turn: 't1', session: null, kind: 'operation', component: operation?.split('.')[0] ?? 'proj',
    operation, operation_version: operation === null ? null : '1', actor: 'user', surface: 'chat', tool_call: null, intent: '',
    inputs: [], params: {}, outputs: [], based_on: null, supersedes: [], status: 'done', deterministic: true,
    created_at: '2026-10-05T00:00:00Z',
    ...partial,
  }
}

/**
 * An asset.
 * @param id - the asset ID, which doubles as its name.
 * @param mime - the MIME type.
 * @param createdBy - the record that created it.
 * @param durationSec - the duration for videos.
 * @param madeBy - the operation of the project record that output it.
 * @returns the asset.
 */
export function asset(
  id: string, mime: string, createdBy: string | null, durationSec: number | null = null, madeBy: string | null = null,
): ProjectAsset {
  return {
    id, mime, name: id, size_bytes: 3, created_by: createdBy, created_at: `2026-10-05T00:00:0${String(id.length % 10)}Z`,
    width: null, height: null, duration_sec: durationSec, made_by: madeBy,
  }
}

/** The project of the fixture. */
export const PROJECT: WireProject = { id: 'p1', title: 'Demo', created_at: '2026-10-05T00:00:00Z' }

/**
 * The shared state.
 * @returns a fresh copy.
 */
export function fixtureState(): WireState {
  const hero = { role: 'reference', ref: { character: 'hero', version: 1 }, resolved_asset: 'ref.png' }
  const records = [
    record({ id: 'u1', operation: 'asset.import', params: { name: 'ref.png' }, outputs: ['ref.png'] }),
    record({ id: 'e1', operation: 'bible.character_create', params: { character: 'hero', name: 'Hero' } }),
    record({
      id: 'p1', turn: 't2', actor: 'agent', operation: 'plan.create', params: { shots: [{ prompt: 'hero walks', mode: 'ref2va' }, { prompt: 'hero turns', mode: 'ref2va' }] },
      report: { plan: 'p1', version: 1 },
    }),
    record({ id: 'a1', turn: 't3', operation: 'plan.approve', params: { plan: 'p1' } }),
    record({
      id: 'g1', turn: 't3', actor: 'agent', operation: 'shot.render_ref2va', deterministic: false, inputs: [hero],
      params: { prompt: 'hero walks through the rain at night in the city' }, outputs: ['shot1.mp4', 'shot1-last.png'],
    }),
    record({
      id: 'g2', turn: 't3', actor: 'agent', operation: 'shot.render_ref2va', deterministic: false,
      inputs: [hero, { role: 'first_frame', ref: { record: 'g1', output: 1 }, resolved_asset: 'shot1-last.png' }],
      params: { prompt: 'hero turns' }, outputs: ['shot2.mp4', 'shot2-last.png'],
    }),
    record({ id: 's1', turn: 't3', actor: 'agent', operation: 'timeline.create', params: { assets: ['shot1.mp4', 'shot2.mp4'] } }),
    record({
      id: 'c1', turn: 't4', surface: 'timeline', operation: 'deliver.timeline_export', params: { timeline: 't1' },
      inputs: [{ role: 'clip', ref: { asset: 'shot2.mp4' }, resolved_asset: 'shot2.mp4' }], outputs: ['export.mp4'], status: 'failed',
      error: { code: 'operation_failed', message: 'ffmpeg exit 1' },
    }),
    record({
      id: 'x1', turn: 't4', operation: 'asset.grab_still', inputs: [{ role: 'video', ref: { record: 'c1', output: 0 }, resolved_asset: 'export.mp4' }],
      outputs: ['export-last.png'],
    }),
    record({
      id: 'g3', turn: 't5', session: 's5', actor: 'agent', operation: 'shot.render_ref2va', deterministic: false, based_on: 'g1',
      inputs: [hero], params: { prompt: 'hero walks, wider' }, status: 'running',
    }),
  ]
  return {
    project: { id: 'p1', title: 'Demo', created_at: '2026-10-05T00:00:00Z' },
    head: 'g3',
    tip: 'g3',
    components: {
      proj: {
        records,
        stale: { g2: 'g1' },
        superseded: { c1: 'c2' },
        created_by: {
          'ref.png': 'u1', 'shot1.mp4': 'g1', 'shot1-last.png': 'g1', 'shot2.mp4': 'g2', 'shot2-last.png': 'g2', 'export.mp4': 'c1',
          'export-last.png': 'x1',
        },
      },
      bible: {
        characters: { hero: [{ id: 'hero', version: 1, name: 'Hero', description: 'A tired detective.', references: ['ref.png'], created_by: 'e1' }] },
        locations: {},
        styles: {},
      },
      plan: { plans: { p1: [{ version: 1, shots: [{ prompt: 'hero walks', mode: 'ref2va' }, { prompt: 'hero turns', mode: 'ref2va', continue_previous: true }], created_by: 'p1', approved_by: 'a1' }] } },
      shot: { takes: { g1: ['g1', 'g3'] }, roots: { g3: 'g1' } },
      asset: { placed: [] },
      timeline: {
        timelines: [{
          id: 't1', name: '', clips: [
            { id: 'cl1', asset: 'shot1.mp4', source: null, in_sec: null, out_sec: null },
            { id: 'cl2', asset: 'shot2.mp4', source: null, in_sec: 1, out_sec: 4 },
          ],
        }],
      },
    },
    assets: [
      asset('ref.png', 'image/png', 'u1', null, 'asset.import'),
      asset('shot1.mp4', 'video/mp4', 'g1', 4, 'shot.render_ref2va'),
      asset('shot1-last.png', 'image/png', 'g1', null, 'shot.render_ref2va'),
      asset('shot2.mp4', 'video/mp4', 'g2', 6, 'shot.render_ref2va'),
      asset('shot2-last.png', 'image/png', 'g2', null, 'shot.render_ref2va'),
      asset('export.mp4', 'video/mp4', 'c1', 3, 'deliver.timeline_export'),
      asset('export-last.png', 'image/png', 'x1', null, 'asset.grab_still'),
    ],
  }
}

/** The operation declarations the fixture's records use. */
export const OPERATIONS: WireOperation[] = [
  {
    name: 'shot.render_ref2va', version: '1', description: 'One shot.', inputs: { reference: { type: 'image', description: 'reference images', many: true, bible: true } },
    params: {
      prompt: { type: 'string', required: true, description: 'What happens.' }, seed: { type: 'integer', description: 'Seed.' },
      aspect: { type: 'string', enum: ['16:9', '9:16'] }, loop: { type: 'boolean' }, extra: { type: 'object' },
    },
    outputs: [{ role: 'video', type: 'video' }, { role: 'last_still', type: 'image' }], deterministic: false, resource: 'gpu', confirm: 'over_gpu_budget',
  },
  {
    name: 'plan.create', version: '1', description: 'A plan.', inputs: {}, params: { shots: { type: 'array', items: { type: 'object' } } }, outputs: [],
    deterministic: true, resource: 'none', confirm: 'never',
  },
  {
    name: 'timeline.create', version: '1', description: 'Create a timeline.', inputs: {}, params: {}, outputs: [], deterministic: true, resource: 'none',
    confirm: 'never',
  },
]

/** Every POST the scripted fetch received, by path. */
export interface Recorded {
  path: string
  body: unknown
}

/** What the scripted fetch answers with. */
export interface ScriptedRoutes {
  projects?: WireProject[]
  state?: WireState | (() => WireState)
  operations?: WireOperation[]
  /** Answer a POST; return `{status, body}` or throw. Default echoes a done record. */
  post?: (path: string, body: unknown) => { status: number; body: unknown }
}

/**
 * A `fetch` that answers the `/api/dv` routes from fixed data and records writes.
 * @param routes - the answers.
 * @returns the fetch and the recorded writes.
 */
export function scriptedFetch(routes: ScriptedRoutes = {}): { fetch: typeof fetch; writes: Recorded[] } {
  const writes: Recorded[] = []
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://host')
    if (init?.method === 'POST') {
      const body: unknown = JSON.parse(typeof init.body === 'string' ? init.body : '')
      writes.push({ path: url.pathname, body })
      if (routes.post !== undefined) {
        const answer = routes.post(url.pathname, body)
        return Promise.resolve(json(answer.body, answer.status))
      }
      if (url.pathname === '/api/dv/operation') {
        const request = body as OperationRequest
        return Promise.resolve(json(record({ id: `new-${String(writes.length)}`, operation: request.operation, params: request.params ?? {}, outputs: ['new.mp4'] })))
      }
      // Undo and redo move the current position and answer the line.
      if (url.pathname === '/api/dv/undo' || url.pathname === '/api/dv/redo') return Promise.resolve(json({ tip: 'g3', at: 'g3' }))
      return Promise.resolve(json({ record: record({ id: 'b1' }) }))
    }
    switch (url.pathname) {
      case '/api/dv/projects': return Promise.resolve(json(routes.projects ?? [PROJECT]))
      case '/api/dv/state': {
        const state = routes.state ?? fixtureState
        return Promise.resolve(json(typeof state === 'function' ? state() : state))
      }
      case '/api/dv/operations': return Promise.resolve(json(routes.operations ?? OPERATIONS))
      default: return Promise.resolve(json({ error: `no route ${url.pathname}` }, 404))
    }
  }
  return { fetch: fetchImpl, writes }
}
