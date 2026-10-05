/**
 * The assets panel's listing over a real project log: a photo the agent uploaded from a chat attachment, three
 * generated shots and a joined video made on an agent draft that the user later accepted, and a Tool session
 * generation on `main`. The log is copied into a temporary directory and folded with the runtime's own fold.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, describe, expect, it } from 'vitest'
import VhOpLog, { type AssetId, type OpId, type ProjectId } from '../../oplog/src/index.ts'
import type { AssetMeta } from '../../assets/src/index.ts'
import { foldChain } from '../../runtime/src/fold.ts'
import { toWireState } from '../../views/src/wire.ts'
import type { WireState } from '../../ui-kit/src/client/types.ts'
import { OTHER_FOLDER_ID, assetLibrary } from '../src/client/library.ts'

/** The state directory of the local DreamVerse run that recorded the project; absent on other machines. */
const STATE = '/tmp/claude-0/-mnt-lustre-vlm-d1su-codes-dsh-dv-hub/37ea44a9-2f63-4d6d-8109-72ce27807c51/scratchpad/vh-m3-run/state'
const PROJECT = brandString<ProjectId>('cbb4b4c6-1209-4cce-a671-b74303aa691b')
const DRAFT = 'draft/e1bf3ce1-406d-4529-861f-96afaa742ac2'

const UPLOAD = 'fa7c64e2429ca4e8d9bbaf659b5b6daaa5da9a570705d7d131d14d0f00721178'
const TOOL_UPLOAD = '944d5c89496d9dc4b54cc29185a3ec6a4a05f7eb6c5664ea1eab0f9e538a3f9d'
const SHOTS = [
  'ca8803d195e97e6a938567d147859523d339d98eba76939b195fdeab955874f6',
  'ef4270c80af5034f8e13557dedf5a5fcd1af473f4a418ec33eba269da4b56ab1',
  '04a70603d301c98d036b42ffd51b146ce56463713a09d7c8cbfc8c5bfe032040',
]
const JOINED = '9846ab979209814dbc58ca997d61d7717c3bbc56c3fd84a49cfc81f4e1d8231f'
const TOOL_CLIP = 'cc9cc877af5f4a10d5f8b36431c195ce61c0bb4699d545ee12bb50454da415c6'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Copy the project's log into a temporary root, open it, and return a folder of wire states by head.
 * @returns a function that folds a head as the views route does, deciding accepted turns against `mainHead`.
 */
async function openProject(): Promise<(head: string, mainHead: string) => WireState> {
  const root = mkdtempSync(join(tmpdir(), 'vh-assets-'))
  roots.push(root)
  cpSync(join(STATE, 'projects', PROJECT), join(root, PROJECT), { recursive: true })
  const metas = new Map<string, AssetMeta>()
  for (const line of readFileSync(join(STATE, 'assets', 'index.jsonl'), 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    const meta = JSON.parse(line) as AssetMeta
    metas.set(meta.id, meta)
  }
  const context = new Context()
  contexts.push(context)
  await context.plugin(VhOpLog, { root }).await()
  const log = context.vhOpLog
  return (head, mainHead) => {
    const heads = log.heads(PROJECT)
    const headId = brandString<OpId>(heads[head] ?? head)
    const mainChain = head === mainHead ? null : new Set(log.ancestors(PROJECT, brandString<OpId>(mainHead)).map(op => op.id))
    const state = foldChain(PROJECT, log.ancestors(PROJECT, headId), mainChain)
    return toWireState(log.project(PROJECT), state, heads, (id: AssetId) => metas.get(id) ?? null) as unknown as WireState
  }
}

describe.runIf(existsSync(join(STATE, 'projects', PROJECT, 'ops.jsonl')))('assetLibrary over project cbb4b4c6', () => {
  it('lists the chat upload, the accepted draft generations, and the Tool session generation on main', async () => {
    const fold = await openProject()
    const library = assetLibrary(fold('main', 'main'), [{ id: 'ts-67acdf0e', title: 'Tool 会话 2', createdAt: '2026-10-05T08:01:02.598Z' }])
    expect(library.uploads.map(asset => asset.id).sort()).toEqual([UPLOAD, TOOL_UPLOAD].sort())
    expect(library.references.map(asset => asset.id).sort()).toEqual([UPLOAD, TOOL_UPLOAD].sort())
    expect(library.generated.map(asset => asset.id).sort()).toEqual([...SHOTS, JOINED, TOOL_CLIP].sort())
    expect(library.characters).toEqual([])
    expect(library.draft.size).toBe(0)
    expect(library.folders.map(folder => [folder.id, folder.assets.length])).toEqual([['ts-67acdf0e', 1], [OTHER_FOLDER_ID, 4]])
  })

  it('lists an open draft\'s upload and generations before acceptance and flags them as drafts', async () => {
    const fold = await openProject()
    // `main` as it stood before the user accepted the draft, and the draft at its last record before the accept record.
    const mainBefore = 'fad12c26-6b9b-4267-b4f7-0e2d4ca65d70'
    const main = fold(mainBefore, mainBefore)
    const draft = fold('c28b30dd-ad4f-4f0b-87fc-7ca1a18cb797', mainBefore)
    expect(assetLibrary(main, []).generated).toEqual([])
    const library = assetLibrary(main, [], [{ branch: DRAFT, state: draft }])
    expect(library.uploads.map(asset => asset.id)).toEqual([UPLOAD])
    expect(library.generated.map(asset => asset.id).sort()).toEqual([...SHOTS, JOINED].sort())
    expect([...library.draft]).toEqual(expect.arrayContaining([UPLOAD, ...SHOTS, JOINED]))
  })

  it('leaves out a draft whose turn was rejected', async () => {
    const fold = await openProject()
    const mainBefore = 'fad12c26-6b9b-4267-b4f7-0e2d4ca65d70'
    const draft = fold('c28b30dd-ad4f-4f0b-87fc-7ca1a18cb797', mainBefore)
    const turn = DRAFT.slice('draft/'.length)
    const turnSummary = draft.turns[turn]
    if (turnSummary === undefined) throw new Error('draft turn missing')
    const rejected: WireState = { ...draft, turns: { ...draft.turns, [turn]: { ...turnSummary, rejected: true } } }
    const library = assetLibrary(fold(mainBefore, mainBefore), [], [{ branch: DRAFT, state: rejected }])
    expect(library.uploads).toEqual([])
    expect(library.generated).toEqual([])
  })
})

describe('assetLibrary over a synthetic state', () => {
  /** A done record with one output. */
  const op = (id: string, tool: string, output: string, params: Record<string, unknown>, createdAt: string): WireState['ops'][number] => ({
    id, parents: [], turn: 't', branch: 'main', actor: 'user', surface: 'canvas', intent: '', kind: 'tool', tool: { name: tool, version: '1' },
    inputs: [], params, outputs: [output], status: 'done', deterministic: true, created_at: createdAt,
  } as WireState['ops'][number])
  /** A stored asset as the content-addressed store first recorded it. */
  const asset = (id: string, mime: string, name: string): WireState['assets'][number] => ({
    id, mime, name, sizeBytes: 10, producedBy: null, createdAt: '2026-01-01T00:00:00.000Z', width: null, height: null, durationSec: null,
  })
  const state = {
    ops: [
      op('o1', 'asset.upload', 'img', { name: 'dropped.png' }, '2026-10-05T09:00:00.000Z'),
      op('o2', 'generate.video', 'vid', { tool_session: 'ts-deleted' }, '2026-10-05T09:01:00.000Z'),
    ],
    assets: [asset('img', 'image/png', 'ref.png'), asset('vid', 'video/mp4', 'clip.mp4')],
    entities: {}, turns: {},
  } as unknown as WireState

  it('names an upload by this project\'s upload record, not the store\'s first upload of the same bytes', () => {
    expect(assetLibrary(state, []).uploads).toEqual([expect.objectContaining({ id: 'img', name: 'dropped.png', createdAt: '2026-10-05T09:00:00.000Z' })])
  })

  it('files a video of a deleted Tool session under the other-generations folder', () => {
    expect(assetLibrary(state, []).folders.map(folder => [folder.id, folder.assets.map(row => row.id)])).toEqual([[OTHER_FOLDER_ID, ['vid']]])
  })
})
