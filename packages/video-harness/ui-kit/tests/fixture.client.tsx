/**
 * A folded state the view tests share: one character, one approved plan whose shots were generated and sequenced, a
 * running retake on the open draft of chat session `s5`, a failed trim, and an exploration branch. Also a scripted `fetch` that answers the
 * `/api/vh` routes from such a state and records every write.
 */
import type { InvokeBody } from '../src/client/api.ts'
import type { WireAsset, WireOp, WireProject, WireState, WireToolSpec } from '../src/client/types.ts'

/**
 * A record with defaults for everything a test does not set.
 * @param partial - the fields that matter to the test.
 * @returns the record.
 */
export function op(partial: Partial<WireOp> & { id: string }): WireOp {
  return {
    parents: [], turn: 't1', session: null, branch: 'main', actor: 'user', surface: 'chat', intent: '', kind: 'operation',
    inputs: [], params: {}, outputs: [], status: 'done', deterministic: true, created_at: '2026-10-05T00:00:00Z',
    ...partial,
  }
}

/**
 * An asset record.
 * @param id - the asset ID, which doubles as its name.
 * @param mime - the MIME type.
 * @param producedBy - the producing record.
 * @param durationSec - the duration for videos.
 * @returns the asset.
 */
export function asset(id: string, mime: string, producedBy: string | null, durationSec: number | null = null): WireAsset {
  return { id, mime, name: id, sizeBytes: 3, producedBy, createdAt: `2026-10-05T00:00:0${String(id.length % 10)}Z`, width: null, height: null, durationSec }
}

/** The project of the fixture. */
export const PROJECT: WireProject = { projectId: 'p1', title: 'Demo', createdAt: '2026-10-05T00:00:00Z', heads: { main: 's1' } }

/**
 * The shared state.
 * @returns a fresh copy.
 */
export function fixtureState(): WireState {
  const hero = { role: 'reference', ref: 'hero@1', resolved: 'ref.png' }
  return {
    project: { projectId: 'p1', title: 'Demo', createdAt: '2026-10-05T00:00:00Z' },
    head: 'main',
    heads: { main: 's1', 'explore/style-b': 'e1', 'draft/s5': 'g3' },
    branches: [
      { name: 'main', head: 's1', base: null, forked_at: null, session: null, counts: null },
      { name: 'draft/s5', head: 'g3', base: 'main', forked_at: 'x1', session: 's5', counts: { agent_changes: 1, human_edits: 0 } },
      { name: 'explore/style-b', head: 'e1', base: null, forked_at: null, session: null, counts: null },
    ],
    ops: [
      op({ id: 'i1', kind: 'request', intent: 'make a hero film' }),
      op({ id: 'u1', tool: { name: 'asset.upload', version: '1' }, params: { name: 'ref.png' }, outputs: ['ref.png'] }),
      op({ id: 'e1', tool: { name: 'entity.character.create', version: '1' }, params: { entity: 'hero', name: 'Hero', refs: ['ref.png'] } }),
      op({ id: 'p1', turn: 't2', actor: 'agent', tool: { name: 'plan.create', version: '1' }, params: { shots: [{ prompt: 'hero walks' }, { prompt: 'hero turns' }] } }),
      op({ id: 'a1', turn: 't3', tool: { name: 'plan.approve', version: '1' }, params: { plan: 'p1' } }),
      op({ id: 'g1', turn: 't3', actor: 'agent', tool: { name: 'generate.video', version: '1' }, deterministic: false, inputs: [hero], params: { prompt: 'hero walks through the rain at night in the city' }, outputs: ['shot1.mp4', 'shot1-last.png'] }),
      op({ id: 'g2', turn: 't3', actor: 'agent', tool: { name: 'generate.video', version: '1' }, deterministic: false, inputs: [hero, { role: 'first_frame', ref: 'g1#1', resolved: 'shot1-last.png' }], params: { prompt: 'hero turns' }, outputs: ['shot2.mp4', 'shot2-last.png'] }),
      op({ id: 's1', turn: 't3', actor: 'agent', tool: { name: 'sequence.create', version: '1' }, params: { assets: ['shot1.mp4', 'shot2.mp4'] } }),
      op({ id: 'c1', turn: 't4', surface: 'timeline', tool: { name: 'media.concat', version: '1' }, inputs: [{ role: 'clip', ref: 'shot2.mp4', resolved: 'shot2.mp4' }], outputs: ['cut.mp4'], status: 'failed', error: 'ffmpeg exit 1' }),
      op({ id: 'x1', turn: 't4', tool: { name: 'media.probe', version: '1' }, inputs: [{ role: 'media', ref: 'c1#0', resolved: 'cut.mp4' }], outputs: ['notes.txt'] }),
      op({ id: 'g3', turn: 't5', session: 's5', branch: 'draft/s5', actor: 'agent', tool: { name: 'generate.video', version: '1' }, deterministic: false, base_op: 'g1', inputs: [hero], params: { prompt: 'hero walks, wider' }, status: 'running' }),
    ],
    assets: [
      asset('ref.png', 'image/png', 'u1'),
      asset('shot1.mp4', 'video/mp4', 'g1', 4),
      asset('shot1-last.png', 'image/png', 'g1'),
      asset('shot2.mp4', 'video/mp4', 'g2', 6),
      asset('shot2-last.png', 'image/png', 'g2'),
      asset('cut.mp4', 'video/mp4', 'c1', 3),
      asset('notes.txt', 'text/plain', 'x1'),
    ],
    entities: { hero: [{ kind: 'character', version: 1, name: 'Hero', description: 'A tired detective.', refs: ['ref.png'], updatedBy: 'e1' }] },
    sequence: { items: [{ slot: 1, assetId: 'shot1.mp4', inSec: null, outSec: null }, { slot: 2, assetId: 'shot2.mp4', inSec: 1, outSec: 4 }] },
    stale: { g2: { because: 'g1 superseded' } },
    superseded: { c1: 'c2' },
    takes: { g1: ['g1', 'g3'] },
    plans: [{ op: 'p1', approved: true, approvedBy: 'a1' }],
    producers: { 'ref.png': 'u1', 'shot1.mp4': 'g1', 'shot1-last.png': 'g1', 'shot2.mp4': 'g2', 'shot2-last.png': 'g2', 'cut.mp4': 'c1', 'notes.txt': 'x1' },
  }
}

/** The tool declarations the fixture's records use. */
export const TOOLS: WireToolSpec[] = [
  {
    name: 'generate.video', version: '1', summary: 'One shot.', inputs: { reference: { type: 'image', description: 'refs', many: true, entity: true } },
    params: { prompt: { type: 'string', required: true, description: 'What happens.' }, seed: { type: 'integer', description: 'Seed.' }, aspect: { type: 'string', enum: ['16:9', '9:16'] }, loop: { type: 'boolean' }, extra: { type: 'object' } },
    outputs: [{ role: 'video', type: 'video' }, { role: 'last_frame', type: 'image' }], deterministic: false, cost: 'gpu', confirm: 'agent_ask_first',
  },
  { name: 'plan.create', version: '1', summary: 'A plan.', inputs: {}, params: { shots: { type: 'array', items: { type: 'object' } } }, outputs: [], deterministic: true, cost: 'free', confirm: 'never' },
  { name: 'sequence.create', version: '1', summary: 'Start the timeline.', inputs: {}, params: {}, outputs: [], deterministic: true, cost: 'free', confirm: 'never' },
]

/** Every POST the scripted fetch received, by path. */
export interface Recorded {
  path: string
  body: unknown
}

/** What the scripted fetch answers with. */
export interface ScriptedRoutes {
  projects?: WireProject[]
  state?: WireState | ((head: string) => WireState)
  tools?: WireToolSpec[]
  /** Answer a POST; return `{status, body}` or throw. Default echoes a done record. */
  post?: (path: string, body: unknown) => { status: number; body: unknown }
}

/**
 * A `fetch` that answers the views routes from fixed data and records writes.
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
      if (url.pathname === '/api/vh/invoke') {
        const invoke = body as InvokeBody
        return Promise.resolve(json(op({ id: `new-${String(writes.length)}`, tool: { name: invoke.tool, version: '1' }, params: invoke.params ?? {}, outputs: ['new.mp4'] })))
      }
      return Promise.resolve(json({ heads: { main: 'x' }, record: op({ id: 'b1' }) }))
    }
    switch (url.pathname) {
      case '/api/vh/projects': return Promise.resolve(json(routes.projects ?? [PROJECT]))
      case '/api/vh/state': {
        const state = routes.state ?? fixtureState
        return Promise.resolve(json(typeof state === 'function' ? state(url.searchParams.get('head') ?? 'main') : state))
      }
      case '/api/vh/tools': return Promise.resolve(json(routes.tools ?? TOOLS))
      default: return Promise.resolve(json({ error: `no route ${url.pathname}` }, 404))
    }
  }
  return { fetch: fetchImpl, writes }
}
