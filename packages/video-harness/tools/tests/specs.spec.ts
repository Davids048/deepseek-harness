import { brandString } from '@deepseek-ai/dsh-brand'
import { MAIN_BRANCH, type AssetId, type EntityId, type OpId, type TurnId } from '@video-harness/oplog'
import type { InvokeRequest } from '@video-harness/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { assetRecord, backendSeconds, shotGeometry } from '../src/index.ts'
import { frameAt } from '../src/specs-media.ts'
import { startTools, testFacts, type ToolsFixture } from './support.ts'

const fixtures: ToolsFixture[] = []
const agent = { actor: 'agent' as const, surface: 'chat' as const }

async function start(options: Parameters<typeof startTools>[0] = {}): Promise<ToolsFixture> {
  const fixture = await startTools({ dsh: false, ...options })
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

function request(tool: string, turn: TurnId, params: Record<string, unknown> = {}, inputs: InvokeRequest['inputs'] = []): InvokeRequest {
  return { tool, inputs, params, ...agent, intent: tool, turn }
}

/** A project on `main` with one uploaded image registered as character c1@1. */
async function projectWithCharacter(fixture: ToolsFixture) {
  const projectId = fixture.project.createProject({ title: 'p' })
  const turn = fixture.project.beginTurn(projectId, { actor: 'user', surface: 'chat', intent: 'start' }).turn
  const upload = await fixture.project.invoke(projectId, request('asset.upload', turn, { path: fixture.writeFile('face.png'), mime: 'image/png' }))
  const image = upload.outputs[0] as AssetId
  await fixture.project.invoke(projectId, request('entity.character.create', turn, { entity: 'c1', name: 'Lead', description: 'red coat', refs: [image] }))
  return { projectId, turn, image, upload }
}

describe('record-only and small-file tools', () => {
  it('registers every spec with the runtime and describes it', async () => {
    const fixture = await start()
    const names = fixture.tools.list().map(spec => spec.name)
    expect(names).toEqual(expect.arrayContaining([
      'asset.upload', 'entity.character.create', 'entity.character.update', 'entity.style.create', 'entity.location.update', 'plan.create', 'plan.update', 'plan.approve',
      'sequence.create', 'sequence.replace', 'sequence.move', 'sequence.set_range', 'sequence.insert', 'sequence.remove', 'sequence.split', 'sequence.rename', 'sequence.delete', 'clip.trim', 'media.concat', 'media.extract_frame', 'media.probe',
      'command.run', 'generate.video', 'perception.describe',
    ]))
    expect(fixture.project.toolNames().sort()).toEqual([...names].sort())
    expect(fixture.tools.get('generate.video')?.cost).toBe('gpu')
    expect(fixture.tools.get('plan.create')?.confirm).toBe('never')
    expect(fixture.tools.get('plan.approve')?.confirm).toBe('always')
    for (const spec of fixture.tools.list()) expect(spec.summary.length).toBeGreaterThan(10)
  })

  it('uploads from a path or base64, versions entities per kind, and summarizes records', async () => {
    const fixture = await start()
    const { projectId, turn, image, upload } = await projectWithCharacter(fixture)
    expect(fixture.tools.get('asset.upload')?.summarize(upload)).toBe('uploaded face.png')
    const inline = await fixture.project.invoke(projectId, request('asset.upload', turn, { base64: Buffer.from('hello').toString('base64'), mime: 'text/plain', name: 'note.txt' }))
    expect(fixture.assets.read(inline.outputs[0] as AssetId).toString()).toBe('hello')
    expect(fixture.tools.get('asset.upload')?.summarize(inline)).toBe('uploaded note.txt')
    const bare = await fixture.project.invoke(projectId, request('asset.upload', turn, { base64: Buffer.from('x').toString('base64'), mime: 'text/plain' }))
    expect(fixture.assets.get(bare.outputs[0] as AssetId).name).toBe('upload')
    await expect(fixture.project.invoke(projectId, request('asset.upload', turn, { mime: 'text/plain' }))).rejects.toThrow('needs `path` or `base64`')
    const state = fixture.project.fold(projectId)
    const c1 = state.entities[brandString<EntityId>('c1')]
    expect(c1).toMatchObject([{ kind: 'character', version: 1, name: 'Lead', description: 'red coat', refs: [image] }])
    const created = state.ops.find(op => op.tool?.name === 'entity.character.create') as NonNullable<typeof state.ops[0]>
    expect(fixture.tools.get('entity.character.create')?.summarize(created)).toBe('character Lead created')
    const updated = await fixture.project.invoke(projectId, request('entity.character.update', turn, { entity: 'c1', description: 'blue coat' }))
    expect(fixture.tools.get('entity.character.update')?.summarize(updated)).toBe('character c1 updated')
    expect(fixture.project.fold(projectId).entities[brandString<EntityId>('c1')]?.at(-1)).toMatchObject({ version: 2, description: 'blue coat', refs: [image] })
    const style = await fixture.project.invoke(projectId, request('entity.style.create', turn, { entity: 's1', name: 'noir' }))
    expect(fixture.tools.get('entity.style.create')?.summarize(style)).toBe('style noir created')
    expect(fixture.tools.get('entity.style.create')?.summarize({ ...style, params: { entity: 's2' } })).toBe('style s2 created')
  })

  it('stores plans as JSON, approves them into scheduled shots in both continuity modes, and summarizes', async () => {
    const fixture = await start()
    const { projectId, turn } = await projectWithCharacter(fixture)
    await expect(fixture.project.invoke(projectId, request('plan.create', turn, { shots: [] }))).rejects.toThrow('at least one shot')
    await expect(fixture.project.invoke(projectId, request('plan.create', turn, { title: 'no shots' }))).rejects.toThrow('at least one shot')
    const chained = await fixture.project.invoke(projectId, request('plan.create', turn, {
      title: 'dance', continuity: 'chained', references: ['c1@1'], shots: [{ prompt: 'Picture 1 starts dancing', duration_sec: 1 }, { prompt: 'keeps dancing', duration_sec: 1 }],
    }))
    expect(chained.kind).toBe('plan')
    expect(fixture.tools.get('plan.create')?.summarize(chained)).toBe('plan with 2 shots')
    expect(fixture.tools.get('plan.create')?.summarize({ ...chained, params: {} })).toBe('plan with 0 shots')
    expect(JSON.parse(fixture.assets.read(chained.outputs[0] as AssetId).toString())).toMatchObject({ title: 'dance', continuity: 'chained', shots: [{ prompt: 'Picture 1 starts dancing' }, {}] })
    const revised = await fixture.project.invoke(projectId, { ...request('plan.update', turn, { continuity: 'chained', references: ['c1@1'], shots: [{ prompt: 'one', duration_sec: 1 }, { prompt: 'two', duration_sec: 1 }] }), base_op: chained.id })
    expect(fixture.tools.get('plan.update')?.summarize(revised)).toBe('plan revised (2 shots)')
    expect(fixture.tools.get('plan.update')?.summarize({ ...revised, params: {} })).toBe('plan revised (0 shots)')
    const approve = await fixture.project.invoke(projectId, request('plan.approve', turn, { plan: revised.id }))
    expect(approve.kind).toBe('approve')
    expect(fixture.tools.get('plan.approve')?.summarize(approve)).toBe(`plan ${revised.id.slice(0, 8)} approved`)
    await fixture.project.whenIdle(projectId)
    let state = fixture.project.fold(projectId)
    const shots = state.ops.filter(op => op.tool?.name === 'generate.video')
    expect(shots).toHaveLength(2)
    expect(shots.every(op => op.status === 'done')).toBe(true)
    expect(shots[1]?.inputs.find(input => input.role === 'first_frame')).toMatchObject({ ref: `${shots[0]?.id}#1`, resolved: shots[0]?.outputs[1] })
    expect(fixture.generation.requests[1]?.referenceImages).toHaveLength(2)
    expect(state.sequence?.items.map(item => item.assetId)).toEqual(shots.map(op => op.outputs[0]))
    const sequence = state.ops.find(op => op.tool?.name === 'sequence.create') as NonNullable<typeof state.ops[0]>
    expect(fixture.tools.get('sequence.create')?.summarize(sequence)).toBe('sequence of 2 clips')
    // Independent shots carry only the references.
    const independent = await fixture.project.invoke(projectId, request('plan.create', turn, { continuity: 'independent', shots: [{ prompt: 'a', duration_sec: 1, references: ['c1@1'] }, { prompt: 'b', duration_sec: 1, references: ['c1@1'] }] }))
    await fixture.project.invoke(projectId, request('plan.approve', turn, { plan: independent.id }))
    await fixture.project.whenIdle(projectId)
    state = fixture.project.fold(projectId)
    const later = state.ops.filter(op => op.tool?.name === 'generate.video').slice(2)
    expect(later).toHaveLength(2)
    expect(later.every(op => op.inputs.every(input => input.role === 'reference'))).toBe(true)
    expect(fixture.generation.requests.at(-1)?.referenceImages).toHaveLength(1)
  })

  it('records sequence edits with one-line summaries', async () => {
    const fixture = await start()
    const { projectId, turn, image } = await projectWithCharacter(fixture)
    const create = await fixture.project.invoke(projectId, request('sequence.create', turn, { assets: [image, image] }))
    expect(fixture.tools.get('sequence.create')?.summarize(create)).toBe('sequence of 2 clips')
    expect(fixture.tools.get('sequence.create')?.summarize({ ...create, params: {}, inputs: [] })).toBe('sequence of 0 clips')
    const replace = await fixture.project.invoke(projectId, request('sequence.replace', turn, { slot: 1, asset: image }))
    expect(fixture.tools.get('sequence.replace')?.summarize(replace)).toBe('slot 1 replaced')
    const move = await fixture.project.invoke(projectId, request('sequence.move', turn, { from: 2, to: 1 }))
    expect(fixture.tools.get('sequence.move')?.summarize(move)).toBe('slot 2 moved to 1')
    const range = await fixture.project.invoke(projectId, request('sequence.set_range', turn, { slot: 1, inSec: 0.1, outSec: 0.5 }))
    expect(fixture.tools.get('sequence.set_range')?.summarize(range)).toBe('slot 1 range set')
    const insert = await fixture.project.invoke(projectId, request('sequence.insert', turn, { at: 1, asset: image }))
    expect(fixture.tools.get('sequence.insert')?.summarize(insert)).toBe('clip inserted at 1')
    expect(fixture.project.fold(projectId).sequence?.items).toHaveLength(3)
    const removed = await fixture.project.invoke(projectId, request('sequence.remove', turn, { slot: 1 }))
    expect(fixture.tools.get('sequence.remove')?.summarize(removed)).toBe('slot 1 removed')
    expect(fixture.project.fold(projectId).sequence?.items.map(item => item.slot)).toEqual([1, 2])
    const split = await fixture.project.invoke(projectId, request('sequence.split', turn, { slot: 1, atSec: 1.5 }))
    expect(fixture.tools.get('sequence.split')?.summarize(split)).toBe('slot 1 split at 1.5s')
    const video = await fixture.project.invoke(projectId, request('sequence.create', turn, { sequence: 'v2', title: '第 2 集', assets: [] }))
    expect(fixture.tools.get('sequence.create')?.summarize(video)).toBe('v2 sequence of 0 clips')
    await fixture.project.invoke(projectId, request('sequence.insert', turn, { sequence: 'v2', at: 1, asset: image }))
    const state = fixture.project.fold(projectId)
    expect(state.sequences.map(sequence => [sequence.id, sequence.items.length])).toEqual([['v1', 3], ['v2', 1]])
  })
})

describe('media tools', () => {
  /** A project with one generated shot. */
  async function projectWithShot(fixture: ToolsFixture) {
    const base = await projectWithCharacter(fixture)
    const shot = await fixture.project.invoke(base.projectId, request('generate.video', base.turn, { prompt: 'Picture 1 waves', duration_sec: 2 }, [{ role: 'reference', ref: 'c1@1' }]))
    return { ...base, shot, clip: shot.outputs[0] as AssetId }
  }

  it('trims, joins, extracts frames, and probes through vhMedia', async () => {
    const fixture = await start()
    const { projectId, turn, clip } = await projectWithShot(fixture)
    const trim = await fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0.5, endSec: 1.5 }, [{ role: 'clip', ref: clip }]))
    expect((await fixture.media.probe(trim.outputs[0] as AssetId)).durationSec).toBeCloseTo(1, 0)
    expect(fixture.tools.get('clip.trim')?.summarize(trim)).toBe('trimmed from 0.5s to 1.5s')
    const copy = await fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 1, reencode: false }, [{ role: 'clip', ref: clip }]))
    expect(fixture.tools.get('clip.trim')?.summarize(copy)).toBe('trimmed from 1s')
    await expect(fixture.project.invoke(projectId, request('clip.trim', turn, { startSec: 0 }))).rejects.toThrow('Input "clip" is required.')
    const joined = await fixture.project.invoke(projectId, request('media.concat', turn, {}, [{ role: 'clip', ref: clip }, { role: 'clip', ref: trim.outputs[0] as AssetId }]))
    expect((await fixture.media.probe(joined.outputs[0] as AssetId)).durationSec).toBeCloseTo(3, 0)
    expect(fixture.tools.get('media.concat')?.summarize(joined)).toBe('joined 2 clips')
    await expect(fixture.project.invoke(projectId, request('media.concat', turn))).rejects.toThrow('at least one `clip` input')
    const first = await fixture.project.invoke(projectId, request('media.extract_frame', turn, { at: 'first' }, [{ role: 'clip', ref: clip }]))
    const last = await fixture.project.invoke(projectId, request('media.extract_frame', turn, {}, [{ role: 'clip', ref: clip }]))
    const mid = await fixture.project.invoke(projectId, request('media.extract_frame', turn, { at: 1 }, [{ role: 'clip', ref: clip }]))
    const odd = await fixture.project.invoke(projectId, request('media.extract_frame', turn, { at: true }, [{ role: 'clip', ref: clip }]))
    const text = await fixture.project.invoke(projectId, request('media.extract_frame', turn, { at: '0.5' }, [{ role: 'clip', ref: clip }]))
    for (const op of [first, last, mid, odd, text]) expect(fixture.assets.get(op.outputs[0] as AssetId).mime).toBe('image/png')
    expect(fixture.tools.get('media.extract_frame')?.summarize(text)).toBe('frame at 0.5')
    expect([frameAt('first'), frameAt(2), frameAt(' 1.5 '), frameAt(''), frameAt('x'), frameAt(-1), frameAt(Number.NaN), frameAt(null)]).toEqual(['first', 2, 1.5, 'last', 'last', 'last', 'last', 'last'])
    expect(fixture.tools.get('media.extract_frame')?.summarize(first)).toBe('frame at first')
    expect(fixture.tools.get('media.extract_frame')?.summarize(last)).toBe('frame at last')
    const probe = await fixture.project.invoke(projectId, request('media.probe', turn, {}, [{ role: 'media', ref: clip }]))
    expect(probe.report).toMatchObject({ width: 192, height: 112, hasAudio: false })
    expect(fixture.assets.get(probe.outputs[0] as AssetId).mime).toBe('application/json')
    expect(fixture.tools.get('media.probe')?.summarize(probe)).toBe(`probed ${clip.slice(0, 8)}`)
    expect(fixture.tools.get('media.probe')?.summarize({ ...probe, inputs: [] })).toBe('probed asset')
  })

  it('runs declared commands and records their output', async () => {
    const fixture = await start()
    const { projectId, turn, clip } = await projectWithShot(fixture)
    const command = await fixture.project.invoke(projectId, request('command.run', turn, {
      argv: ['ffmpeg', '-y', '-loglevel', 'error', '-i', '{{in:0}}', '-frames:v', '1', '{{out:still.png}}'], outputs: [{ name: 'still.png', mime: 'image/png' }],
    }, [{ role: 'in', ref: clip }]))
    expect(command.deterministic).toBe(false)
    expect(fixture.assets.get(command.outputs[0] as AssetId).mime).toBe('image/png')
    expect(command.report).toMatchObject({ stdout: '', stderr: '' })
    expect(fixture.tools.get('command.run')?.summarize(command)).toContain('ran ffmpeg -y')
    expect(fixture.tools.get('command.run')?.summarize({ ...command, params: {} })).toBe('ran command')
    const noOutputs = await fixture.project.invoke(projectId, request('command.run', turn, { argv: ['ffmpeg', '-version'] }))
    expect(noOutputs.outputs).toEqual([])
    expect(String(noOutputs.report?.['stdout'])).toContain('ffmpeg version')
    await expect(fixture.project.invoke(projectId, request('command.run', turn, { argv: [] }))).rejects.toThrow('non-empty `argv`')
    await expect(fixture.project.invoke(projectId, request('command.run', turn, { argv: ['ffmpeg', '-i', '/nonexistent.mp4', '{{out:x.mp4}}'], outputs: [{ name: 'x.mp4', mime: 'video/mp4' }] }))).rejects.toThrow()
  })
})

describe('generate.video', () => {
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

  it('generates a shot with references and a first frame, keeps the seed, and stores both outputs', async () => {
    const fixture = await start()
    const { projectId, turn, image } = await projectWithCharacter(fixture)
    const shot = await fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'Picture 1 waves', duration_sec: 2, seed: 42 }, [{ role: 'reference', ref: 'c1@1' }]))
    expect(shot.status).toBe('done')
    expect(shot.outputs).toHaveLength(2)
    expect(fixture.assets.get(shot.outputs[0] as AssetId)).toMatchObject({ mime: 'video/mp4', width: 192, height: 112, durationSec: 2, producedBy: shot.id })
    expect(fixture.assets.get(shot.outputs[1] as AssetId)).toMatchObject({ mime: 'image/png', name: `${shot.id.slice(0, 8)}-last.png` })
    expect((await fixture.media.probe(shot.outputs[0] as AssetId)).durationSec).toBeCloseTo(2, 0)
    expect(shot.report).toMatchObject({ seed: 42, model: 'test-ref2va', frame_width: 192, num_frames: 49, image_labels: { referenceLabels: ['Picture 1'], firstFrameLabel: null } })
    expect(shot.cost).toMatchObject({ gpu_s: 0.25 })
    expect(fixture.generation.requests[0]).toMatchObject({ seed: 42, numFrames: 49, returnLastFrame: true })
    expect(fixture.generation.requests[0]?.referenceImages[0]?.equals(fixture.assets.read(image))).toBe(true)
    expect(fixture.tools.get('generate.video')?.summarize(shot)).toBe('shot "Picture 1 waves" (2s, seed 42)')
    const { report, ...withoutReport } = shot
    expect(report).toBeDefined()
    expect(fixture.tools.get('generate.video')?.summarize({ ...withoutReport, params: {} })).toBe('shot "" (?s, seed ?)')
    // The next shot continues from the last frame; the frame goes last in the request and gets the next label.
    const next = await fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'keeps waving' }, [{ role: 'reference', ref: 'c1@1' }, { role: 'first_frame', ref: shot.outputs[1] as AssetId }]))
    expect(fixture.generation.requests[1]?.referenceImages).toHaveLength(2)
    expect(fixture.generation.requests[1]?.referenceImages[1]?.equals(fixture.assets.read(shot.outputs[1] as AssetId))).toBe(true)
    expect(next.report).toMatchObject({ duration_sec: 1, image_labels: { referenceLabels: ['Picture 1'], firstFrameLabel: 'Picture 2' } })
    expect(typeof next.report?.['seed']).toBe('number')
    expect(fixture.generation.requests[1]?.seed).toBe(next.report?.['seed'])
    expect(fixture.tools.get('generate.video')?.summarize(next)).toBe(`shot "keeps waving" (1s, seed ${String(next.report?.['seed'])})`)
  })

  it('refuses requests the model cannot serve and records stream failures', async () => {
    const fixture = await start()
    const { projectId, turn, image } = await projectWithCharacter(fixture)
    const reference = [{ role: 'reference', ref: 'c1@1' as const }]
    await expect(fixture.project.invoke(projectId, request('generate.video', turn, {}, reference))).rejects.toThrow('needs a `prompt`')
    await expect(fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'x' }))).rejects.toThrow('requires 1 to 2 reference images')
    await expect(fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'x' }, [...reference, { role: 'reference', ref: image }, { role: 'reference', ref: image }]))).rejects.toThrow('requires 1 to 2')
    await expect(fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'x', duration_sec: 7 }, reference))).rejects.toThrow('duration_sec')
    fixture.generation.omit = 'done'
    await expect(fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'x' }, reference))).rejects.toThrow('ended before the backend reported completion')
    fixture.generation.omit = 'last_frame'
    await expect(fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'x' }, reference))).rejects.toThrow('no last frame')
    fixture.generation.omit = null
    fixture.generation.failure = new Error('backend down')
    await expect(fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'x' }, reference))).rejects.toThrow('backend down')
    const failed = fixture.project.fold(projectId).ops.filter(op => op.status === 'failed')
    expect(failed.length).toBeGreaterThanOrEqual(6)
    expect(failed.at(-1)?.error).toBe('backend down')
  })

  it('describes stored assets as DreamVerse records and drains large chunks', async () => {
    const fixture = await start()
    const { projectId, turn, image } = await projectWithCharacter(fixture)
    expect(assetRecord(fixture.assets, image)).toMatchObject({ assetId: image, mediaType: 'image', mimeType: 'image/png', filePath: fixture.assets.path(image) })
    fixture.generation.padChunkBytes = 64 * 1024
    const shot = await fixture.project.invoke(projectId, request('generate.video', turn, { prompt: 'big' }, [{ role: 'reference', ref: 'c1@1' }]))
    expect(fixture.assets.get(shot.outputs[0] as AssetId).sizeBytes).toBeGreaterThan(64 * 1024)
    expect(assetRecord(fixture.assets, shot.outputs[0] as AssetId).mediaType).toBe('video')
  })

  it('is absent without a generation backend', async () => {
    const fixture = await start({ generation: 'none' })
    expect(fixture.tools.get('generate.video')).toBeUndefined()
    expect(fixture.project.toolNames()).not.toContain('generate.video')
  })
})

describe('perception.describe', () => {
  it('shows an image to the default model and stores the answer', async () => {
    const fixture = await start()
    const { projectId, turn, image } = await projectWithCharacter(fixture)
    const look = await fixture.project.invoke(projectId, request('perception.describe', turn, { question: 'What color is the coat?' }, [{ role: 'image', ref: image }]))
    expect(look.report).toMatchObject({ question: 'What color is the coat?', answer: 'A person in a blue room, centered, soft light.', model: 'test-vision' })
    expect(fixture.assets.read(look.outputs[0] as AssetId).toString()).toContain('blue room')
    expect(fixture.attachments.saved).toHaveLength(1)
    expect(fixture.attachments.saved[0]).toMatchObject({ mediaType: 'image/png', name: 'face.png' })
    const message = fixture.llm.requests[0]?.messages[0]
    expect(message?.content).toMatchObject([{ type: 'image', attachment: { attachmentId: 'att-1' } }, { type: 'text', text: 'What color is the coat?' }])
    expect(fixture.llm.requests[0]).toMatchObject({ provider: 'test-provider', model: 'test-vision', maxTokens: 1024 })
    expect(fixture.tools.get('perception.describe')?.summarize(look)).toBe('looked: A person in a blue room, centered, soft light.')
    const defaulted = await fixture.project.invoke(projectId, request('perception.describe', turn, {}, [{ role: 'image', ref: image }]))
    expect(String(defaulted.report?.['question'])).toContain('Describe this image')
    expect(fixture.llm.requests[1]).not.toHaveProperty('reasoningEffort')
    fixture.route.reasoningEffort = 'low'
    fixture.llm.reasoning = 'thinking…'
    const effort = await fixture.project.invoke(projectId, request('perception.describe', turn, {}, [{ role: 'image', ref: image }]))
    expect(fixture.llm.requests[2]).toMatchObject({ reasoningEffort: 'low' })
    expect(effort.report?.['answer']).toBe('A person in a blue room, centered, soft light.')
  })

  it('explains why it cannot look', async () => {
    const fixture = await start()
    const { projectId, turn, image } = await projectWithCharacter(fixture)
    await expect(fixture.project.invoke(projectId, request('perception.describe', turn))).rejects.toThrow('Input "image" is required.')
    const text = await fixture.project.invoke(projectId, request('asset.upload', turn, { base64: Buffer.from('t').toString('base64'), mime: 'text/plain' }))
    await expect(fixture.project.invoke(projectId, request('perception.describe', turn, {}, [{ role: 'image', ref: text.outputs[0] as AssetId }]))).rejects.toThrow('needs a PNG, JPEG, WebP, or GIF image; the input is text/plain')
    // A model without image input ends the record done with the reason, so the agent reads it and carries on.
    fixture.llm.modalities = ['text']
    const textOnly = await fixture.project.invoke(projectId, request('perception.describe', turn, {}, [{ role: 'image', ref: image }]))
    expect(textOnly.status).toBe('done')
    expect(String(textOnly.report?.['unsupported'])).toContain('does not accept image input')
    expect(textOnly.report?.['answer']).toBeNull()
    expect(fixture.assets.read(textOnly.outputs[0] as AssetId).toString()).toContain('does not accept image input')
    expect(fixture.tools.get('perception.describe')?.summarize(textOnly)).toBe('looked: images unsupported')
    fixture.llm.modalities = undefined
    expect(String((await fixture.project.invoke(projectId, request('perception.describe', turn, {}, [{ role: 'image', ref: image }]))).report?.['unsupported'])).toContain('does not accept image input')
    expect(fixture.attachments.saved).toHaveLength(0)
    fixture.llm.modalities = ['image']
    fixture.llm.reply = new Error('quota')
    await expect(fixture.project.invoke(projectId, request('perception.describe', turn, {}, [{ role: 'image', ref: image }]))).rejects.toThrow('The model call failed: quota')
    expect(fixture.attachments.saved).toHaveLength(1)
  })

  it('reports images as unsupported when the deployment switches image input off', async () => {
    const fixture = await start({ imageInput: false })
    const { projectId, turn, image } = await projectWithCharacter(fixture)
    const off = await fixture.project.invoke(projectId, request('perception.describe', turn, { question: 'what?' }, [{ role: 'image', ref: image }]))
    expect(off.status).toBe('done')
    expect(off.report).toMatchObject({ question: 'what?', answer: null })
    expect(String(off.report?.['unsupported'])).toContain('text-only')
    expect(fixture.llm.requests).toHaveLength(0)
  })

  it('is absent without a model, default model, and attachment service', async () => {
    const fixture = await start({ perception: false })
    expect(fixture.tools.get('perception.describe')).toBeUndefined()
  })
})

describe('vhTools registry', () => {
  it('replaces, removes, and keeps the runtime in step', async () => {
    const fixture = await start()
    const spec = { ...(fixture.tools.get('asset.upload') as NonNullable<ReturnType<ToolsFixture['tools']['get']>>), version: '9' }
    const remove = fixture.tools.register(spec)
    expect(fixture.tools.get('asset.upload')?.version).toBe('9')
    expect(fixture.project.tool('asset.upload')?.version).toBe('9')
    remove()
    expect(fixture.tools.get('asset.upload')).toBeUndefined()
    expect(fixture.project.tool('asset.upload')).toBeUndefined()
    const echo = { ...spec, name: 'echo', version: '1' }
    const removeEcho = fixture.tools.register(echo)
    fixture.tools.register({ ...echo, version: '2' })
    removeEcho()
    expect(fixture.tools.get('echo')?.version).toBe('2')
    const projectId = fixture.project.createProject({ title: 'p' })
    expect(fixture.log.heads(projectId)[MAIN_BRANCH]).toBeDefined()
    expect(brandString<OpId>('x')).toBe('x')
  })
})
