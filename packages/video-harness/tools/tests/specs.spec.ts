import type { AssetId, ProjectId, ProjectRecord, RunRequest, RunResult } from '@dv/project'
import { afterEach, describe, expect, it } from 'vitest'
import { assetRecord, backendSeconds, shotGeometry } from '../src/index.ts'
import { frameAt } from '../src/specs-media.ts'
import { startTools, testFacts, type ToolsFixture } from './support.ts'

const fixtures: ToolsFixture[] = []
/** A human action in the chat outside any chat session: it lands on `main` directly. */
const user = { actor: 'user' as const, surface: 'chat' as const, session: null, turn: null, tool_call: null }

async function start(options: Parameters<typeof startTools>[0] = {}): Promise<ToolsFixture> {
  const fixture = await startTools({ dsh: false, ...options })
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

/** Run one operation on `main` as the user. */
function run(
  fixture: ToolsFixture, project: ProjectId, operation: string, params: Record<string, unknown> = {}, inputs: RunRequest['inputs'] = [],
  extra: Partial<RunRequest> = {},
): Promise<RunResult> {
  return fixture.project.run({ ...user, project, operation, params, inputs, intent: operation, ...extra })
}

/** Run one operation that writes a record and return the record in its final status. */
async function record(
  fixture: ToolsFixture, project: ProjectId, operation: string, params: Record<string, unknown> = {}, inputs: RunRequest['inputs'] = [],
  extra: Partial<RunRequest> = {},
): Promise<ProjectRecord> {
  const result = await run(fixture, project, operation, params, inputs, extra)
  if (result.record === null) throw new Error(`${operation} wrote no record`)
  return result.record
}

/** The failure message of a record that ended `failed`. */
async function failure(promise: Promise<ProjectRecord>): Promise<string> {
  const failed = await promise
  expect(failed.status).toBe('failed')
  return failed.error?.message ?? ''
}

/** The reference input of character c1 at version 1. */
const c1 = { role: 'reference', ref: { character: 'c1', version: 1 } }

/** A project on `main` with one imported image registered as character c1@1. */
async function projectWithCharacter(fixture: ToolsFixture) {
  const projectId = (await fixture.project.createProject('p', { ...user, intent: 'create' })).id
  const upload = await record(fixture, projectId, 'asset.upload', { path: fixture.writeFile('face.png'), mime: 'image/png' })
  const image = upload.outputs[0] as AssetId
  await record(fixture, projectId, 'entity.character.create', { entity: 'c1', name: 'Lead', description: 'red coat', refs: [image] })
  return { projectId, image, upload }
}

/** The records of `main` that ran one operation. */
function recordsOf(fixture: ToolsFixture, projectId: ProjectId, operation: string): ProjectRecord[] {
  return fixture.project.getState(projectId).components.proj.records.filter(entry => entry.operation === operation)
}

describe('record-only and small-file tools', () => {
  it('registers every spec as an operation and describes it', async () => {
    const fixture = await start()
    const names = fixture.tools.list().map(spec => spec.name)
    expect(names).toEqual(expect.arrayContaining([
      'asset.upload', 'entity.character.create', 'entity.character.update', 'entity.style.create', 'entity.location.update', 'plan.create', 'plan.update', 'plan.approve',
      'sequence.create', 'sequence.replace', 'sequence.move', 'sequence.set_range', 'sequence.insert', 'sequence.remove', 'sequence.split', 'sequence.rename', 'sequence.delete', 'media.concat', 'media.extract_frame', 'media.probe', // names:allow
      'generate.video', 'perception.describe', // names:allow
    ]))
    // `clip.trim` serves only the timeline export: an operation and a spec, but no agent tool or canvas form.
    expect(names).not.toContain('clip.trim')
    expect(fixture.tools.get('clip.trim')?.component).toBe('deliver')
    expect(fixture.project.listOperations().map(spec => spec.name).sort()).toEqual([...names, 'clip.trim'].sort())
    expect(fixture.tools.get('generate.video')).toMatchObject({ component: 'shot', resource: 'gpu', confirm: 'agent_ask_first' }) // names:allow
    expect(fixture.tools.get('generate.video')?.estimate?.({ duration_sec: 3 })).toEqual({ gpu_seconds: 12 }) // names:allow
    expect(fixture.tools.get('plan.create')).toMatchObject({ component: 'plan', confirm: 'never' })
    expect(fixture.tools.get('plan.approve')).toMatchObject({ component: 'plan', confirm: 'agent_ask_first' })
    expect(fixture.tools.get('media.probe')?.component).toBe('inspect') // names:allow
    expect(fixture.tools.get('sequence.move')?.component).toBe('timeline') // names:allow
    expect(fixture.tools.get('entity.style.create')?.component).toBe('bible') // names:allow
    for (const spec of fixture.tools.list()) expect(spec.summary.length).toBeGreaterThan(10)
  })

  it('imports from a path or base64, versions characters and styles, and summarizes records', async () => {
    const fixture = await start()
    const { projectId, image, upload } = await projectWithCharacter(fixture)
    expect(fixture.tools.get('asset.upload')?.summarize(upload)).toBe('uploaded face.png') // names:allow
    expect(fixture.assets.get(image).producedBy).toBe(upload.id)
    const inline = await record(fixture, projectId, 'asset.upload', { base64: Buffer.from('hello').toString('base64'), mime: 'text/plain', name: 'note.txt' })
    expect(fixture.assets.read(inline.outputs[0] as AssetId).toString()).toBe('hello')
    expect(fixture.tools.get('asset.upload')?.summarize(inline)).toBe('uploaded note.txt') // names:allow
    const bare = await record(fixture, projectId, 'asset.upload', { base64: Buffer.from('x').toString('base64'), mime: 'text/plain' })
    expect(fixture.assets.get(bare.outputs[0] as AssetId).name).toBe('upload') // names:allow
    expect(await failure(record(fixture, projectId, 'asset.upload', { mime: 'text/plain' }))).toContain('needs `path` or `base64`')
    const bible = fixture.project.getState(projectId).components.bible
    expect(bible.entities['c1']).toMatchObject([{ kind: 'character', version: 1, name: 'Lead', description: 'red coat', refs: [image] }])
    const created = recordsOf(fixture, projectId, 'entity.character.create')[0] as ProjectRecord
    expect(fixture.tools.get('entity.character.create')?.summarize(created)).toBe('character Lead created')
    const updated = await record(fixture, projectId, 'entity.character.update', { entity: 'c1', description: 'blue coat' })
    expect(fixture.tools.get('entity.character.update')?.summarize(updated)).toBe('character c1 updated')
    expect(fixture.project.getState(projectId).components.bible.entities['c1']?.at(-1)).toMatchObject({ version: 2, description: 'blue coat', refs: [image] })
    // An update of an ID the project does not know fails its record.
    expect(await failure(record(fixture, projectId, 'entity.character.update', { entity: 'ghost' }))).toBe("Unknown character 'ghost'.")
    const style = await record(fixture, projectId, 'entity.style.create', { entity: 's1', name: 'noir' })
    expect(fixture.tools.get('entity.style.create')?.summarize(style)).toBe('style noir created')
    expect(fixture.tools.get('entity.style.create')?.summarize({ ...style, params: { entity: 's2' } })).toBe('style s2 created')
  })

  it('stores plans as JSON, approves them into scheduled shot renders in both continuity modes, and summarizes', async () => {
    const fixture = await start()
    const { projectId } = await projectWithCharacter(fixture)
    expect(await failure(record(fixture, projectId, 'plan.create', { shots: [] }))).toContain('at least one shot')
    await expect(run(fixture, projectId, 'plan.create', { title: 'no shots' })).rejects.toMatchObject({ code: 'invalid_params' })
    const chained = await record(fixture, projectId, 'plan.create', {
      title: 'dance', continuity: 'chained', references: ['c1@1'], shots: [{ prompt: 'Picture 1 starts dancing', duration_sec: 1 }, { prompt: 'keeps dancing', duration_sec: 1 }],
    })
    expect(chained.component).toBe('plan')
    expect(fixture.tools.get('plan.create')?.summarize(chained)).toBe('plan with 2 shots')
    expect(fixture.tools.get('plan.create')?.summarize({ ...chained, params: {} })).toBe('plan with 0 shots')
    expect(JSON.parse(fixture.assets.read(chained.outputs[0] as AssetId).toString())).toMatchObject({ title: 'dance', continuity: 'chained', shots: [{ prompt: 'Picture 1 starts dancing' }, {}] })
    const revised = await record(fixture, projectId, 'plan.update', {
      continuity: 'chained', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 1 }],
    }, [], { based_on: chained.id })
    expect(fixture.tools.get('plan.update')?.summarize(revised)).toBe('plan revised (2 shots)')
    expect(fixture.tools.get('plan.update')?.summarize({ ...revised, params: {} })).toBe('plan revised (0 shots)')
    const approve = await record(fixture, projectId, 'plan.approve', { plan: revised.id })
    expect(approve).toMatchObject({ status: 'done', kind: 'operation', component: 'plan' })
    expect(fixture.tools.get('plan.approve')?.summarize(approve)).toBe(`plan ${revised.id.slice(0, 8)} approved`)
    await fixture.project.wait(projectId)
    let state = fixture.project.getState(projectId)
    expect(state.components.plan.plans.find(plan => plan.op === revised.id))
      .toEqual({ op: revised.id, approved: true, approvedBy: approve.id })
    const shots = recordsOf(fixture, projectId, 'generate.video') // names:allow
    expect(shots).toHaveLength(2)
    expect(shots.every(shot => shot.status === 'done' && shot.actor === 'system' && shot.params['plan'] === revised.id)).toBe(true)
    expect(shots[1]?.inputs.find(input => input.role === 'first_frame')).toMatchObject({ ref: { record: shots[0]?.id, output: 1 }, resolved_asset: shots[0]?.outputs[1] })
    expect(fixture.generation.requests[1]?.referenceImages).toHaveLength(2)
    expect(state.components.timeline.sequence?.items.map(item => item.assetId)).toEqual(shots.map(shot => shot.outputs[0]))
    const assembly = recordsOf(fixture, projectId, 'sequence.create')[0] as ProjectRecord // names:allow
    expect(fixture.tools.get('sequence.create')?.summarize(assembly)).toBe('sequence of 2 clips') // names:allow
    // Independent shots carry only the references.
    const independent = await record(fixture, projectId, 'plan.create', {
      continuity: 'independent', shots: [{ prompt: 'a', duration_sec: 1, references: ['c1@1'] }, { prompt: 'b', duration_sec: 1, references: ['c1@1'] }],
    })
    await record(fixture, projectId, 'plan.approve', { plan: independent.id })
    await fixture.project.wait(projectId)
    state = fixture.project.getState(projectId)
    const later = recordsOf(fixture, projectId, 'generate.video').slice(2) // names:allow
    expect(later).toHaveLength(2)
    expect(later.every(shot => shot.inputs.every(input => input.role === 'reference'))).toBe(true)
    expect(fixture.generation.requests.at(-1)?.referenceImages).toHaveLength(1)
    // Approving a record that stored no plan document fails the approval.
    expect(await failure(record(fixture, projectId, 'plan.approve', { plan: approve.id }))).toContain('stored no plan document')
  })

  it('records timeline edits with one-line summaries', async () => {
    const fixture = await start()
    const { projectId, image } = await projectWithCharacter(fixture)
    const summarize = (edit: ProjectRecord): string => fixture.tools.get(edit.operation ?? '')?.summarize(edit) ?? ''
    const create = await record(fixture, projectId, 'sequence.create', { assets: [image, image] }) // names:allow
    expect(summarize(create)).toBe('sequence of 2 clips') // names:allow
    expect(summarize({ ...create, params: {}, inputs: [] })).toBe('sequence of 0 clips') // names:allow
    expect(summarize(await record(fixture, projectId, 'sequence.replace', { slot: 1, asset: image }))).toBe('slot 1 replaced') // names:allow
    expect(summarize(await record(fixture, projectId, 'sequence.move', { from: 2, to: 1 }))).toBe('slot 2 moved to 1') // names:allow
    expect(summarize(await record(fixture, projectId, 'sequence.set_range', { slot: 1, inSec: 0.1, outSec: 0.5 }))).toBe('slot 1 range set') // names:allow
    expect(summarize(await record(fixture, projectId, 'sequence.insert', { at: 1, asset: image }))).toBe('clip inserted at 1') // names:allow
    expect(fixture.project.getState(projectId).components.timeline.sequence?.items).toHaveLength(3)
    expect(summarize(await record(fixture, projectId, 'sequence.remove', { slot: 1 }))).toBe('slot 1 removed') // names:allow
    expect(fixture.project.getState(projectId).components.timeline.sequence?.items.map(item => item.slot)).toEqual([1, 2])
    expect(summarize(await record(fixture, projectId, 'sequence.split', { slot: 1, atSec: 1.5 }))).toBe('slot 1 split at 1.5s') // names:allow
    const second = await record(fixture, projectId, 'sequence.create', { sequence: 'v2', title: '第 2 集', assets: [] }) // names:allow
    expect(summarize(second)).toBe('v2 sequence of 0 clips') // names:allow
    await record(fixture, projectId, 'sequence.insert', { sequence: 'v2', at: 1, asset: image }) // names:allow
    const timelines = fixture.project.getState(projectId).components.timeline.sequences
    expect(timelines.map(timeline => [timeline.id, timeline.items.length])).toEqual([['v1', 3], ['v2', 1]])
  })
})

describe('media tools', () => { // names:allow
  /** A project with one rendered shot. */
  async function projectWithShot(fixture: ToolsFixture) {
    const base = await projectWithCharacter(fixture)
    const shot = await record(fixture, base.projectId, 'generate.video', { prompt: 'Picture 1 waves', duration_sec: 2 }, [c1]) // names:allow
    return { ...base, shot, clip: shot.outputs[0] as AssetId }
  }

  it('trims, joins, grabs frames, and probes through vhMedia', async () => { // names:allow
    const fixture = await start()
    const { projectId, clip } = await projectWithShot(fixture)
    const clipInput = (asset: AssetId) => ({ role: 'clip', ref: { asset } })
    const trim = await record(fixture, projectId, 'clip.trim', { startSec: 0.5, endSec: 1.5 }, [clipInput(clip)])
    expect((await fixture.media.probe(trim.outputs[0] as AssetId)).durationSec).toBeCloseTo(1, 0)
    expect(fixture.assets.get(trim.outputs[0] as AssetId).producedBy).toBe(trim.id)
    const copy = await record(fixture, projectId, 'clip.trim', { startSec: 1, reencode: false }, [clipInput(clip)])
    expect((await fixture.media.probe(copy.outputs[0] as AssetId)).durationSec).toBeCloseTo(1, 0)
    expect(await failure(record(fixture, projectId, 'clip.trim', { startSec: 0 }))).toBe('Input "clip" is required.')
    const joined = await record(fixture, projectId, 'media.concat', {}, [clipInput(clip), clipInput(trim.outputs[0] as AssetId)]) // names:allow
    expect((await fixture.media.probe(joined.outputs[0] as AssetId)).durationSec).toBeCloseTo(3, 0)
    expect(fixture.tools.get('media.concat')?.summarize(joined)).toBe('joined 2 clips') // names:allow
    expect(await failure(record(fixture, projectId, 'media.concat'))).toContain('at least one `clip` input') // names:allow
    const frame = (params: Record<string, unknown>) => record(fixture, projectId, 'media.extract_frame', params, [clipInput(clip)]) // names:allow
    const first = await frame({ at: 'first' })
    const last = await frame({})
    const mid = await frame({ at: 1 })
    const text = await frame({ at: '0.5' })
    for (const grabbed of [first, last, mid, text]) expect(fixture.assets.get(grabbed.outputs[0] as AssetId).mime).toBe('image/png')
    // The parameter schema refuses a value that is neither a string nor a number before any record.
    await expect(run(fixture, projectId, 'media.extract_frame', { at: true }, [clipInput(clip)])).rejects.toMatchObject({ code: 'invalid_params' }) // names:allow
    expect(fixture.tools.get('media.extract_frame')?.summarize(text)).toBe('frame at 0.5') // names:allow
    expect([frameAt('first'), frameAt(2), frameAt(' 1.5 '), frameAt(''), frameAt('x'), frameAt(-1), frameAt(Number.NaN), frameAt(null), frameAt(true)])
      .toEqual(['first', 2, 1.5, 'last', 'last', 'last', 'last', 'last', 'last'])
    expect(fixture.tools.get('media.extract_frame')?.summarize(first)).toBe('frame at first') // names:allow
    expect(fixture.tools.get('media.extract_frame')?.summarize(last)).toBe('frame at last') // names:allow
    const probe = await record(fixture, projectId, 'media.probe', {}, [{ role: 'media', ref: { asset: clip } }]) // names:allow
    expect(probe.report).toMatchObject({ width: 192, height: 112, hasAudio: false })
    expect(fixture.assets.get(probe.outputs[0] as AssetId).mime).toBe('application/json')
    expect(fixture.tools.get('media.probe')?.summarize(probe)).toBe(`probed ${clip.slice(0, 8)}`) // names:allow
    expect(fixture.tools.get('media.probe')?.summarize({ ...probe, inputs: [] })).toBe('probed asset') // names:allow
  })
})

describe('generate.video', () => { // names:allow
  it('derives the geometry from the model facts', () => {
    const facts = testFacts()
    expect(shotGeometry(facts, {})).toEqual({ mode: 'ref2va', aspectRatio: '16:9', resolution: '720p', width: 192, height: 112, durationSec: 1, numFrames: 25 })
    expect(shotGeometry(facts, { aspect_ratio: '9:16', duration_sec: 3 })).toMatchObject({ width: 112, height: 192, numFrames: 73 })
    expect(() => shotGeometry(facts, { generation_mode: 't2v' })).toThrow('generation_mode must be one of ref2va')
    expect(() => shotGeometry(facts, { aspect_ratio: '4:3' })).toThrow('aspect_ratio and resolution')
    expect(() => shotGeometry(facts, { resolution: '480p' })).toThrow('aspect_ratio and resolution')
    expect(() => shotGeometry(facts, { duration_sec: 9 })).toThrow('duration_sec must be a whole number from 1 to 5')
    expect(() => shotGeometry({ ...facts, generationModes: {}, aspectRatios: [], resolutions: [] }, {})).toThrow('generation_mode')
    expect(() => shotGeometry({ ...facts, aspectRatios: [] }, {})).toThrow('aspect_ratio and resolution')
    expect(() => shotGeometry({ ...facts, resolutions: [] }, {})).toThrow('aspect_ratio and resolution')
    expect(backendSeconds({})).toBe(0)
    expect(backendSeconds({ generation_ms: 15852.9, e2e_latency_ms: 16184.03 })).toBe(16.184)
    expect(backendSeconds({ generation_s: 0.25, encode_s: 0.05 })).toBe(0.25)
  })

  it('renders a shot with references and a first frame, keeps the seed, and stores both outputs', async () => {
    const fixture = await start()
    const { projectId, image } = await projectWithCharacter(fixture)
    const shot = await record(fixture, projectId, 'generate.video', { prompt: 'Picture 1 waves', duration_sec: 2, seed: 42 }, [c1]) // names:allow
    expect(shot.status).toBe('done')
    expect(shot.outputs).toHaveLength(2)
    expect(shot.inputs).toEqual([{ role: 'reference', ref: { character: 'c1', version: 1 }, resolved_asset: image }])
    const size = { width: 192, height: 112 }
    expect(fixture.assets.get(shot.outputs[0] as AssetId)).toMatchObject({ mime: 'video/mp4', durationSec: 2, producedBy: shot.id, ...size })
    expect(fixture.assets.get(shot.outputs[1] as AssetId)).toMatchObject({ mime: 'image/png', name: `${shot.id.slice(0, 8)}-last.png`, ...size })
    expect((await fixture.media.probe(shot.outputs[0] as AssetId)).durationSec).toBeCloseTo(2, 0)
    expect(shot.report).toMatchObject({ seed: 42, model: 'test-ref2va', frame_width: 192, num_frames: 49, image_labels: { referenceLabels: ['Picture 1'], firstFrameLabel: null } })
    expect(shot.cost).toMatchObject({ gpu_seconds: 0.25, reused: false })
    expect(fixture.generation.requests[0]).toMatchObject({ seed: 42, numFrames: 49, returnLastFrame: true })
    expect(fixture.generation.requests[0]?.referenceImages[0]?.equals(fixture.assets.read(image))).toBe(true)
    expect(fixture.tools.get('generate.video')?.summarize(shot)).toBe('shot "Picture 1 waves" (2s, seed 42)') // names:allow
    const { report, ...withoutReport } = shot
    expect(report).toBeDefined()
    expect(fixture.tools.get('generate.video')?.summarize({ ...withoutReport, params: {} })).toBe('shot "" (?s, seed ?)') // names:allow
    // The next shot continues from the last frame; the frame goes last in the request and gets the next label.
    const next = await record(fixture, projectId, 'generate.video', { prompt: 'keeps waving' }, [c1, { role: 'first_frame', ref: { record: shot.id, output: 1 } }]) // names:allow
    expect(fixture.generation.requests[1]?.referenceImages).toHaveLength(2)
    expect(fixture.generation.requests[1]?.referenceImages[1]?.equals(fixture.assets.read(shot.outputs[1] as AssetId))).toBe(true)
    // The conditioning helpers receive the first frame with the frame size of the shot that rendered it.
    const firstFrame = next.inputs.find(input => input.role === 'first_frame')?.resolved_asset as AssetId
    expect(assetRecord(fixture.assets, firstFrame)).toMatchObject({ mediaType: 'image', ...size })
    expect(next.report).toMatchObject({ duration_sec: 1, image_labels: { referenceLabels: ['Picture 1'], firstFrameLabel: 'Picture 2' } })
    expect(typeof next.report?.['seed']).toBe('number')
    expect(fixture.generation.requests[1]?.seed).toBe(next.report?.['seed'])
    expect(fixture.tools.get('generate.video')?.summarize(next)).toBe(`shot "keeps waving" (1s, seed ${String(next.report?.['seed'])})`) // names:allow
  })

  it('fails requests the model cannot serve and records stream failures', async () => {
    const fixture = await start()
    const { projectId, image } = await projectWithCharacter(fixture)
    const shot = (params: Record<string, unknown>, inputs: RunRequest['inputs'] = [c1]) => failure(record(fixture, projectId, 'generate.video', params, inputs)) // names:allow
    // The parameter schema requires a prompt, so the call is refused before any record.
    await expect(run(fixture, projectId, 'generate.video', {}, [c1])).rejects.toMatchObject({ code: 'invalid_params' }) // names:allow
    expect(await shot({ prompt: '' })).toContain('needs a `prompt`')
    expect(await shot({ prompt: 'x' }, [])).toContain('requires 1 to 2 reference images')
    const image3 = [c1, { role: 'reference', ref: { asset: image } }, { role: 'reference', ref: { asset: image } }]
    expect(await shot({ prompt: 'x' }, image3)).toContain('requires 1 to 2')
    expect(await shot({ prompt: 'x', duration_sec: 7 })).toContain('duration_sec')
    fixture.generation.omit = 'done'
    expect(await shot({ prompt: 'x' })).toContain('ended before the backend reported completion')
    fixture.generation.omit = 'last_frame'
    expect(await shot({ prompt: 'x' })).toContain('no last frame')
    fixture.generation.omit = null
    fixture.generation.failure = new Error('backend down')
    const down = await record(fixture, projectId, 'generate.video', { prompt: 'x' }, [c1]) // names:allow
    expect(down).toMatchObject({ status: 'failed', error: { code: 'operation_failed', message: 'backend down' } })
  })

  it('describes stored assets as DreamVerse records and drains large chunks', async () => {
    const fixture = await start()
    const { projectId, image } = await projectWithCharacter(fixture)
    expect(assetRecord(fixture.assets, image)).toMatchObject({ assetId: image, mediaType: 'image', mimeType: 'image/png', filePath: fixture.assets.path(image) })
    fixture.generation.padChunkBytes = 64 * 1024
    const shot = await record(fixture, projectId, 'generate.video', { prompt: 'big' }, [c1]) // names:allow
    expect(fixture.assets.get(shot.outputs[0] as AssetId).sizeBytes).toBeGreaterThan(64 * 1024)
    expect(assetRecord(fixture.assets, shot.outputs[0] as AssetId).mediaType).toBe('video')
  })

  it('is absent without a generation backend', async () => {
    const fixture = await start({ generation: 'none' })
    expect(fixture.tools.get('generate.video')).toBeUndefined() // names:allow
    expect(fixture.project.listOperations().map(spec => spec.name)).not.toContain('generate.video') // names:allow
  })
})

describe('perception.describe', () => { // names:allow
  it('shows an image to the default model and returns the answer as a read', async () => {
    const fixture = await start()
    const { projectId, image, upload } = await projectWithCharacter(fixture)
    const records = fixture.project.listHistory({ project: projectId }).length
    const imageInput = [{ role: 'image', ref: { asset: image } }]
    const look = await run(fixture, projectId, 'perception.describe', { question: 'What color is the coat?' }, imageInput) // names:allow
    // A read writes no record and creates no asset: the answer is in the report.
    expect(look).toMatchObject({ record: null, outputs: [] })
    expect(look.report).toMatchObject({ question: 'What color is the coat?', answer: 'A person in a blue room, centered, soft light.', model: 'test-vision' })
    expect(fixture.project.listHistory({ project: projectId })).toHaveLength(records)
    expect(fixture.attachments.saved).toHaveLength(1)
    expect(fixture.attachments.saved[0]).toMatchObject({ mediaType: 'image/png', name: 'face.png' })
    const message = fixture.llm.requests[0]?.messages[0]
    expect(message?.content).toMatchObject([{ type: 'image', attachment: { attachmentId: 'att-1' } }, { type: 'text', text: 'What color is the coat?' }])
    expect(fixture.llm.requests[0]).toMatchObject({ provider: 'test-provider', model: 'test-vision', maxTokens: 1024 })
    const summarize = fixture.tools.get('perception.describe')?.summarize // names:allow
    expect(summarize?.({ ...upload, report: look.report ?? {} })).toBe('looked: A person in a blue room, centered, soft light.')
    const defaulted = await run(fixture, projectId, 'perception.describe', {}, imageInput) // names:allow
    expect(String(defaulted.report?.['question'])).toContain('Describe this image')
    expect(fixture.llm.requests[1]).not.toHaveProperty('reasoningEffort')
    fixture.route.reasoningEffort = 'low'
    fixture.llm.reasoning = 'thinking…'
    const effort = await run(fixture, projectId, 'perception.describe', {}, imageInput) // names:allow
    expect(fixture.llm.requests[2]).toMatchObject({ reasoningEffort: 'low' })
    expect(effort.report?.['answer']).toBe('A person in a blue room, centered, soft light.')
  })

  it('explains why it cannot look', async () => {
    const fixture = await start()
    const { projectId, image, upload } = await projectWithCharacter(fixture)
    const imageInput = [{ role: 'image', ref: { asset: image } }]
    // A read that throws rejects the run with its error.
    await expect(run(fixture, projectId, 'perception.describe')).rejects.toThrow('Input "image" is required.') // names:allow
    const text = await record(fixture, projectId, 'asset.upload', { base64: Buffer.from('t').toString('base64'), mime: 'text/plain' })
    await expect(run(fixture, projectId, 'perception.describe', {}, [{ role: 'image', ref: { asset: text.outputs[0] as AssetId } }])) // names:allow
      .rejects.toThrow('needs a PNG, JPEG, WebP, or GIF image; the input is text/plain')
    // A model without image input answers with the reason, so the agent reads it and carries on.
    fixture.llm.modalities = ['text']
    const textOnly = await run(fixture, projectId, 'perception.describe', {}, imageInput) // names:allow
    expect(textOnly.outputs).toEqual([])
    expect(String(textOnly.report?.['unsupported'])).toContain('does not accept image input')
    expect(textOnly.report?.['answer']).toBeNull()
    const summarize = fixture.tools.get('perception.describe')?.summarize // names:allow
    expect(summarize?.({ ...upload, report: textOnly.report ?? {} })).toBe('looked: images unsupported')
    fixture.llm.modalities = undefined
    expect(String((await run(fixture, projectId, 'perception.describe', {}, imageInput)).report?.['unsupported'])).toContain('does not accept image input') // names:allow
    expect(fixture.attachments.saved).toHaveLength(0)
    fixture.llm.modalities = ['image']
    fixture.llm.reply = new Error('quota')
    await expect(run(fixture, projectId, 'perception.describe', {}, imageInput)).rejects.toThrow('The model call failed: quota') // names:allow
    expect(fixture.attachments.saved).toHaveLength(1)
  })

  it('reports images as unsupported when the deployment switches image input off', async () => {
    const fixture = await start({ imageInput: false })
    const { projectId, image } = await projectWithCharacter(fixture)
    const off = await run(fixture, projectId, 'perception.describe', { question: 'what?' }, [{ role: 'image', ref: { asset: image } }]) // names:allow
    expect(off.report).toMatchObject({ question: 'what?', answer: null })
    expect(String(off.report?.['unsupported'])).toContain('text-only')
    expect(fixture.llm.requests).toHaveLength(0)
  })

  it('is absent without a model, default model, and attachment service', async () => {
    const fixture = await start({ perception: false })
    expect(fixture.tools.get('perception.describe')).toBeUndefined() // names:allow
  })
})

describe('vhTools registry', () => {
  it('registers each operation once and removes it with its spec', async () => {
    const fixture = await start()
    const spec = fixture.tools.get('asset.upload') as NonNullable<ReturnType<ToolsFixture['tools']['get']>>
    // dvProject refuses a second operation of the same name.
    expect(() => fixture.tools.register({ ...spec, version: '9' })).toThrow(expect.objectContaining({ code: 'operation_exists' }))
    expect(fixture.tools.get('asset.upload')?.version).toBe('1')
    const echo = { ...spec, name: 'echo' }
    const removeEcho = fixture.tools.register(echo)
    expect(fixture.tools.get('echo')).toBe(echo)
    expect(fixture.project.listOperations().map(operation => operation.name)).toContain('echo')
    removeEcho()
    expect(fixture.tools.get('echo')).toBeUndefined()
    expect(fixture.project.listOperations().map(operation => operation.name)).not.toContain('echo')
    // Disposing the plugin removes every operation it registered.
    await fixture.toolsFiber.dispose()
    expect(fixture.project.listOperations()).toEqual([])
  })
})
