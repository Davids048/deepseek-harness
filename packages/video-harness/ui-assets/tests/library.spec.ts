/** The assets panel's listing over synthetic branch states: names, sections, and the assets of an open draft. */
import { describe, expect, it } from 'vitest'
import type { WireState } from '../../ui-kit/src/client/types.ts'
import { assetLibrary } from '../src/client/library.ts'

describe('assetLibrary over a synthetic state', () => {
  /** A done record with one output. */
  const op = (id: string, tool: string, output: string, params: Record<string, unknown>, createdAt: string): WireState['ops'][number] => ({
    id, parents: [], turn: null, session: null, branch: 'main', actor: 'user', surface: 'canvas', intent: '', kind: 'operation',
    tool: { name: tool, version: '1' }, inputs: [], params, outputs: [output], status: 'done', deterministic: true, created_at: createdAt,
  } as WireState['ops'][number])
  /** A stored asset as the content-addressed store first recorded it. */
  const asset = (id: string, mime: string, name: string): WireState['assets'][number] => ({
    id, mime, name, sizeBytes: 10, producedBy: null, createdAt: '2026-01-01T00:00:00.000Z', width: null, height: null, durationSec: null,
  })
  const state = {
    ops: [
      op('o1', 'asset.upload', 'img', { name: 'dropped.png' }, '2026-10-05T09:00:00.000Z'),
      op('o2', 'generate.video', 'vid', {}, '2026-10-05T09:01:00.000Z'),
    ],
    assets: [asset('img', 'image/png', 'ref.png'), asset('vid', 'video/mp4', 'clip.mp4')],
    entities: {},
  } as unknown as WireState

  it('names an upload by this project\'s upload record, not the store\'s first upload of the same bytes', () => {
    expect(assetLibrary(state).uploads)
      .toEqual([expect.objectContaining({ id: 'img', name: 'dropped.png', createdAt: '2026-10-05T09:00:00.000Z' })])
  })

  it('lists a generated video under the generated section', () => {
    expect(assetLibrary(state).generated.map(row => row.id)).toEqual(['vid'])
  })

  it('lists the assets only an open draft has and flags them as drafts', () => {
    const draft = {
      ...state,
      ops: [...state.ops, op('o3', 'generate.video', 'draft-vid', {}, '2026-10-05T09:02:00.000Z')],
      assets: [...state.assets, asset('draft-vid', 'video/mp4', 'draft.mp4')],
    } as WireState
    const library = assetLibrary(state, [{ branch: 'draft/s1', state: draft }])
    expect(library.generated.map(row => row.id).sort()).toEqual(['draft-vid', 'vid'])
    expect([...library.draft]).toEqual(['draft-vid'])
  })
})
