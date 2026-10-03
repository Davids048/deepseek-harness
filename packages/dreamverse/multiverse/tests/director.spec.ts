/**
 * `dreamverseMultiverseDirector`, mounted with the tree over the real project store and segment generation service and
 * fake generation, file, prompt-enhancer, LLM, and default-model services: it copies the references into the
 * multiverse's project, generates the root, proposes two branches through the harness LLM, and generates only the branch
 * the user chooses, continuing from the parent's last frame. The tree persists in the project and survives a restart.
 * The multiverse log records every prompt enhancement and branch proposal request with what the model returned.
 */
import { rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { LoggerLevel } from '@deepseek-ai/cordis'
import { projectOwner } from '@dreamverse/assets-manager'
import { ProjectInUseError } from '@dreamverse/project-store'
import { segmentImageLabels } from '@dreamverse/segment-generation'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROPOSAL_SYSTEM_PROMPT, proposalMessage } from '../src/branch-proposals.ts'
import { MultiverseNotFoundError, MultiverseRequestError } from '../src/errors.ts'
import { INTERRUPTED_ERROR, MULTIVERSE_KIND, MULTIVERSE_WORKLOAD_SCHEMA_VERSION, type Multiverse, type NodeId } from '../src/tree.ts'
import {
  DEFAULT_ROUTE, Deferred, branchReply, clipBytes, disposeMultiverse, imageBytes, lastFrameBytes, readMultiverseLog, ref2vaFacts,
  startMultiverse, waitForTree, type MultiverseFixture,
} from './support.ts'

const fixtures: MultiverseFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await disposeMultiverse(fixture)
})

/** Mount a fresh tree and director, or a restart over an earlier fixture's data, and dispose them after the spec. */
async function start(previous?: MultiverseFixture): Promise<MultiverseFixture> {
  const fixture = await startMultiverse(previous)
  fixtures.push(fixture)
  return fixture
}

/** Unmount a fixture's services but keep its stored data, as a stopped harness does. */
async function stop(fixture: MultiverseFixture): Promise<void> {
  fixtures.splice(fixtures.indexOf(fixture), 1)
  await fixture.root.fiber.dispose()
}

const CREATE_REQUEST = { prompt: 'A fox and an owl meet at dusk.', reference_asset_ids: ['ref-1', 'ref-2'], segment_duration_sec: 5 }
/** The root scene as branch proposals describe it. */
const ROOT_SCENE = { label: 'Beginning', direction: CREATE_REQUEST.prompt }

/** The node children of a parent, in creation order. */
function childLabels(fixture: MultiverseFixture, multiverse: Multiverse, nodeId: NodeId): string[] {
  return fixture.tree.children(multiverse.multiverseId, nodeId).map(node => `${node.label} (${node.status})`)
}

/** Create a multiverse, finish its root, and wait for the two proposals under the root. */
async function createWithRoot(fixture: MultiverseFixture, request: Record<string, unknown> = CREATE_REQUEST) {
  const multiverse = await fixture.director.create(request)
  const rootCall = await fixture.generation.nextCall()
  rootCall.reply.resolve()
  await waitForTree(fixture.tree, () => fixture.tree.children(multiverse.multiverseId, multiverse.rootId).length === 2, 'root proposals')
  return { multiverse, rootCall }
}

describe('dreamverseMultiverseDirector', () => {
  it('copies the references into the project, generates the root, stores its files, and proposes two branches', async () => {
    const fixture = await start()
    const multiverse = await fixture.director.create(CREATE_REQUEST)
    const root = fixture.tree.node(multiverse.multiverseId, multiverse.rootId)
    expect(root).toMatchObject({ label: 'Beginning', direction: CREATE_REQUEST.prompt, status: 'generating', depth: 0 })
    const copies = multiverse.referenceAssetIds.map(assetId => fixture.assets.get(assetId))
    expect(copies.map(copy => [copy.owner, fixture.assets.read(copy.assetId).toString()])).toEqual([
      [projectOwner(multiverse.multiverseId), 'image ref-1'], [projectOwner(multiverse.multiverseId), 'image ref-2'],
    ])
    expect(fixture.store.get(multiverse.multiverseId)).toMatchObject({ kind: MULTIVERSE_KIND, title: CREATE_REQUEST.prompt })

    const rootCall = await fixture.generation.nextCall()
    expect(fixture.promptEnhancer.expandClip).toHaveBeenCalledWith(CREATE_REQUEST.prompt, expect.objectContaining({
      generationMode: 'ref2va', segmentDurationSec: 5, referenceLabels: ['Picture 1', 'Picture 2'],
    }))
    expect(rootCall.request).toMatchObject({
      prompt: `Expanded: ${CREATE_REQUEST.prompt}`, frameWidth: 1344, frameHeight: 768, numFrames: 124, returnLastFrame: true,
      referenceImages: [imageBytes('ref-1'), imageBytes('ref-2')],
    })
    expect(fixture.llm.requests).toHaveLength(0)

    rootCall.reply.resolve()
    await waitForTree(fixture.tree, () => fixture.tree.children(multiverse.multiverseId, multiverse.rootId).length === 2, 'root proposals')
    expect(root).toMatchObject({ status: 'completed', prompt: `Expanded: ${CREATE_REQUEST.prompt}`, error: null })
    expect(fixture.assets.read(root.videoAssetId ?? '')).toEqual(clipBytes(1))
    expect(fixture.assets.read(root.lastFrameAssetId ?? '')).toEqual(lastFrameBytes(1))
    expect(fixture.assets.get(root.videoAssetId ?? '').owner).toBe(projectOwner(multiverse.multiverseId))
    expect(childLabels(fixture, multiverse, multiverse.rootId)).toEqual(['Option 1 A (proposed)', 'Option 1 B (proposed)'])
    expect(fixture.generation.calls).toHaveLength(1)

    const [request] = fixture.llm.requests
    expect(request).toMatchObject({ ...DEFAULT_ROUTE, maxTokens: 640 })
    expect(request?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: proposalMessage([ROOT_SCENE]) }] }])
  })

  it('generates only the chosen branch from the parent last frame, keeps the sibling proposed, and branches again', async () => {
    const fixture = await start()
    const { multiverse } = await createWithRoot(fixture)
    const [chosen, sibling] = fixture.tree.children(multiverse.multiverseId, multiverse.rootId)

    fixture.director.choose(multiverse.multiverseId, chosen!.nodeId)
    const branchCall = await fixture.generation.nextCall()
    const labels = segmentImageLabels(ref2vaFacts(), 'ref2va', 2, true)
    expect(fixture.promptEnhancer.continueVideo).toHaveBeenCalledWith('Option 1 A happens.', expect.objectContaining({
      lockedSegments: [`Expanded: ${CREATE_REQUEST.prompt}`], nextSegmentIdx: 2,
      referenceLabels: labels.referenceLabels, firstFrameLabel: labels.firstFrameLabel,
    }))
    expect(branchCall.request.prompt).toBe('Continued: Option 1 A happens.')
    expect(branchCall.request.referenceImages).toEqual([imageBytes('ref-1'), imageBytes('ref-2'), lastFrameBytes(1)])

    branchCall.reply.resolve()
    await waitForTree(fixture.tree, () => fixture.tree.children(multiverse.multiverseId, chosen!.nodeId).length === 2, 'branch proposals')
    expect(chosen).toMatchObject({ status: 'completed', depth: 1 })
    expect(fixture.assets.read(chosen!.videoAssetId ?? '')).toEqual(clipBytes(2))
    expect(sibling).toMatchObject({ status: 'proposed', videoAssetId: null, lastFrameAssetId: null })
    expect(childLabels(fixture, multiverse, chosen!.nodeId)).toEqual(['Option 2 A (proposed)', 'Option 2 B (proposed)'])
    expect(fixture.llm.requests[1]?.messages[0]?.content).toEqual([{
      type: 'text', text: proposalMessage([ROOT_SCENE, { label: 'Option 1 A', direction: 'Option 1 A happens.' }]),
    }])
    expect(fixture.generation.calls).toHaveLength(2)
  })

  it('refuses a second choice while a scene generates, then generates the sibling from the same parent', async () => {
    const fixture = await start()
    const { multiverse } = await createWithRoot(fixture)
    const [chosen, sibling] = fixture.tree.children(multiverse.multiverseId, multiverse.rootId)
    fixture.director.choose(multiverse.multiverseId, chosen!.nodeId)
    expect(() => { fixture.director.choose(multiverse.multiverseId, sibling!.nodeId) })
      .toThrow(new MultiverseRequestError('Wait for the current scene to finish generating.'))

    const branchCall = await fixture.generation.nextCall()
    branchCall.reply.resolve()
    await waitForTree(fixture.tree, () => fixture.tree.children(multiverse.multiverseId, chosen!.nodeId).length === 2, 'branch proposals')
    expect(() => { fixture.director.choose(multiverse.multiverseId, chosen!.nodeId) })
      .toThrow(new MultiverseRequestError('This scene is already completed.'))
    fixture.director.choose(multiverse.multiverseId, sibling!.nodeId)
    const siblingCall = await fixture.generation.nextCall()
    siblingCall.reply.resolve()
    await waitForTree(fixture.tree, () => fixture.tree.children(multiverse.multiverseId, sibling!.nodeId).length === 2, 'sibling proposals')
    expect(siblingCall.request.referenceImages).toEqual(expect.arrayContaining([lastFrameBytes(1)]))
    expect(siblingCall.request.referenceImages).not.toEqual(expect.arrayContaining([lastFrameBytes(2)]))
    expect(fixture.tree.children(multiverse.multiverseId, chosen!.nodeId).map(node => node.status)).toEqual(['proposed', 'proposed'])
  })

  it('marks a failed generation without files and generates the node again when it is chosen', async () => {
    const fixture = await start()
    const multiverse = await fixture.director.create(CREATE_REQUEST)
    const failedCall = await fixture.generation.nextCall()
    failedCall.reply.reject(new Error('GPU worker crashed'))
    const root = fixture.tree.node(multiverse.multiverseId, multiverse.rootId)
    await waitForTree(fixture.tree, () => root.status === 'failed', 'root failure')
    expect(root).toMatchObject({ error: 'GPU worker crashed', videoAssetId: null, lastFrameAssetId: null })
    expect(fixture.assets.list(projectOwner(multiverse.multiverseId))).toHaveLength(2)
    expect(fixture.llm.requests).toHaveLength(0)

    fixture.director.choose(multiverse.multiverseId, multiverse.rootId)
    expect(root).toMatchObject({ status: 'generating', error: null })
    const retryCall = await fixture.generation.nextCall()
    retryCall.reply.resolve()
    await waitForTree(fixture.tree, () => fixture.tree.children(multiverse.multiverseId, multiverse.rootId).length === 2, 'root proposals')
    expect(fixture.assets.read(root.videoAssetId ?? '')).toEqual(clipBytes(2))
  })

  it('records a failed proposal on the generated node and proposes again on request', async () => {
    const fixture = await start()
    fixture.llm.replies.push('{"branches": [{"label": "Only one", "direction": "Just this."}]}')
    const multiverse = await fixture.director.create(CREATE_REQUEST)
    const root = fixture.tree.node(multiverse.multiverseId, multiverse.rootId)
    ;(await fixture.generation.nextCall()).reply.resolve()
    await waitForTree(fixture.tree, () => root.error !== null, 'proposal failure')
    expect(root).toMatchObject({ status: 'completed', error: 'Branch proposal reply must hold two branches.' })
    expect(fixture.tree.children(multiverse.multiverseId, multiverse.rootId)).toEqual([])

    fixture.director.propose(multiverse.multiverseId, multiverse.rootId)
    await waitForTree(fixture.tree, () => fixture.tree.children(multiverse.multiverseId, multiverse.rootId).length === 2, 'root proposals')
    expect(root.error).toBeNull()
    expect(() => { fixture.director.propose(multiverse.multiverseId, multiverse.rootId) })
      .toThrow(new MultiverseRequestError('This scene already has branches.'))
  })

  it('sends the direction unchanged when prompt enhancement is off', async () => {
    const fixture = await start()
    await createWithRoot(fixture, { ...CREATE_REQUEST, enhancement_enabled: false })
    expect(fixture.generation.calls[0]?.request.prompt).toBe(CREATE_REQUEST.prompt)
    expect(fixture.promptEnhancer.expandClip).not.toHaveBeenCalled()
  })

  it('rejects a creation request without a prompt, with unsupported choices, or with unusable references', async () => {
    const fixture = await start()
    await expect(fixture.director.create({ ...CREATE_REQUEST, prompt: ' ' })).rejects.toThrow(new MultiverseRequestError('A multiverse needs a prompt.'))
    await expect(fixture.director.create({ ...CREATE_REQUEST, segment_duration_sec: 30 })).rejects.toThrow(MultiverseRequestError)
    await expect(fixture.director.create({ ...CREATE_REQUEST, reference_asset_ids: [] })).rejects.toThrow(
      new MultiverseRequestError('ref2va requires 1 to 8 reference images.'))
    await expect(fixture.director.create({ ...CREATE_REQUEST, reference_asset_ids: ['missing'] })).rejects.toThrow(MultiverseRequestError)
    const projectFile = await fixture.assets.copy('ref-1', projectOwner('other-project'))
    await expect(fixture.director.create({ ...CREATE_REQUEST, reference_asset_ids: [projectFile.assetId] })).rejects.toThrow(
      new MultiverseRequestError(`Asset '${projectFile.assetId}' is unavailable. Select an asset from the library.`))
    expect(fixture.tree.list()).toEqual([])
    expect(fixture.store.list()).toEqual([])
    expect(fixture.generation.calls).toEqual([])
  })

  it('holds the project lease only while it works on a node', async () => {
    const fixture = await start()
    const multiverse = await fixture.director.create(CREATE_REQUEST)
    const rootCall = await fixture.generation.nextCall()
    expect(fixture.store.isHeld(multiverse.multiverseId)).toBe(true)
    expect(() => { fixture.store.delete(multiverse.multiverseId) }).toThrow(ProjectInUseError)
    rootCall.reply.resolve()
    await waitForTree(fixture.tree, () => fixture.tree.children(multiverse.multiverseId, multiverse.rootId).length === 2, 'root proposals')
    await vi.waitUntil(() => !fixture.store.isHeld(multiverse.multiverseId))

    const [chosen] = fixture.tree.children(multiverse.multiverseId, multiverse.rootId)
    fixture.director.choose(multiverse.multiverseId, chosen!.nodeId)
    const branchCall = await fixture.generation.nextCall()
    expect(fixture.store.isHeld(multiverse.multiverseId)).toBe(true)
    branchCall.reply.resolve()
    await waitForTree(fixture.tree, () => fixture.tree.children(multiverse.multiverseId, chosen!.nodeId).length === 2, 'branch proposals')
    await vi.waitUntil(() => !fixture.store.isHeld(multiverse.multiverseId))
  })

  it('reloads the tree and its files from the project after a restart', async () => {
    const first = await start()
    const { multiverse } = await createWithRoot(first)
    const [chosen] = first.tree.children(multiverse.multiverseId, multiverse.rootId)
    first.director.choose(multiverse.multiverseId, chosen!.nodeId)
    ;(await first.generation.nextCall()).reply.resolve()
    await waitForTree(first.tree, () => first.tree.children(multiverse.multiverseId, chosen!.nodeId).length === 2, 'branch proposals')
    await vi.waitUntil(() => !first.store.isHeld(multiverse.multiverseId))
    await stop(first)

    const second = await start(first)
    const reloaded = second.tree.get(multiverse.multiverseId)
    expect([...reloaded.nodes.values()].map(node => `${node.label} (${node.status})`)).toEqual([
      'Beginning (completed)', 'Option 1 A (completed)', 'Option 1 B (proposed)', 'Option 2 A (proposed)', 'Option 2 B (proposed)',
    ])
    expect(reloaded).toMatchObject({
      createdAt: multiverse.createdAt, creationConfig: multiverse.creationConfig, referenceAssetIds: multiverse.referenceAssetIds,
    })
    const root = second.tree.node(multiverse.multiverseId, multiverse.rootId)
    expect(second.assets.read(root.videoAssetId ?? '')).toEqual(clipBytes(1))
    expect(second.store.get(multiverse.multiverseId)?.thumbnailAssetId).toBe(root.lastFrameAssetId)

    const [, , , branchA] = reloaded.nodes.values()
    second.director.choose(multiverse.multiverseId, branchA!.nodeId)
    const call = await second.generation.nextCall()
    expect(call.request.referenceImages).toEqual([imageBytes('ref-1'), imageBytes('ref-2'), lastFrameBytes(2)])
  })

  it('marks the nodes that a stop interrupted, saves them, and offers a retry for each', async () => {
    const first = await start()
    const { multiverse } = await createWithRoot(first)
    const { multiverseId, rootId } = multiverse
    const [proposing, generating] = first.tree.children(multiverseId, rootId)
    // Option 1 A finishes and its branch proposal waits; Option 1 B generates. The stop cuts off both.
    first.llm.replies.push(new Deferred<string>().promise)
    first.director.choose(multiverseId, proposing!.nodeId)
    ;(await first.generation.nextCall()).reply.resolve()
    await vi.waitUntil(() => first.llm.requests.length === 2)
    first.director.choose(multiverseId, generating!.nodeId)
    await first.generation.nextCall()
    await stop(first)

    const second = await start(first)
    expect(second.tree.node(multiverseId, rootId)).toMatchObject({ status: 'completed', error: null })
    expect(second.tree.node(multiverseId, proposing!.nodeId)).toMatchObject({ status: 'completed', error: INTERRUPTED_ERROR })
    expect(second.tree.node(multiverseId, generating!.nodeId)).toMatchObject({ status: 'failed', error: INTERRUPTED_ERROR })
    expect(second.store.get(multiverseId)?.workload).toMatchObject({
      schemaVersion: MULTIVERSE_WORKLOAD_SCHEMA_VERSION,
      data: { nodes: [
        { node_id: rootId, status: 'completed', error: null },
        { node_id: proposing!.nodeId, status: 'completed', error: INTERRUPTED_ERROR },
        { node_id: generating!.nodeId, status: 'failed', error: INTERRUPTED_ERROR },
      ] },
    })
    expect(second.store.isHeld(multiverseId)).toBe(false)

    second.director.propose(multiverseId, proposing!.nodeId)
    await waitForTree(second.tree, () => second.tree.children(multiverseId, proposing!.nodeId).length === 2, 'proposals again')
    expect(second.tree.node(multiverseId, proposing!.nodeId).error).toBeNull()
    second.director.choose(multiverseId, generating!.nodeId)
    const retryCall = await second.generation.nextCall()
    expect(retryCall.request.referenceImages).toEqual([imageBytes('ref-1'), imageBytes('ref-2'), lastFrameBytes(1)])
    retryCall.reply.resolve()
    await waitForTree(second.tree, () => second.tree.children(multiverseId, generating!.nodeId).length === 2, 'retry proposals')
    expect(second.tree.node(multiverseId, generating!.nodeId)).toMatchObject({ status: 'completed', error: null })
  })

  it('aborts its work without writing when another party takes the project lease', async () => {
    const fixture = await start()
    const multiverse = await fixture.director.create(CREATE_REQUEST)
    const rootCall = await fixture.generation.nextCall()
    const lease = await fixture.store.acquire(multiverse.multiverseId, { revoke: () => Promise.resolve() })
    expect(rootCall.request.signal?.aborted).toBe(true)
    expect(fixture.store.get(multiverse.multiverseId)?.workload).toMatchObject({ data: { nodes: [{ status: 'generating', video_asset_id: null }] } })
    expect(fixture.assets.list(projectOwner(multiverse.multiverseId))).toHaveLength(2)
    fixture.store.release(lease)
    expect(fixture.store.isHeld(multiverse.multiverseId)).toBe(false)
  })

  it('leaves the tree when the project store deletes the multiverse, together with its files', async () => {
    const fixture = await start()
    const { multiverse } = await createWithRoot(fixture)
    await vi.waitUntil(() => !fixture.store.isHeld(multiverse.multiverseId))
    expect(fixture.assets.list(projectOwner(multiverse.multiverseId))).toHaveLength(4)

    fixture.store.delete(multiverse.multiverseId)
    expect(fixture.assets.deletedOwners).toEqual([projectOwner(multiverse.multiverseId)])
    expect(fixture.assets.list(projectOwner(multiverse.multiverseId))).toEqual([])
    expect(() => fixture.tree.get(multiverse.multiverseId)).toThrow(MultiverseNotFoundError)
    expect(fixture.tree.list()).toEqual([])
  })
})

describe('multiverse log', () => {
  /** An ISO-8601 UTC time stamp. */
  const TIMESTAMP = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) as string

  /** The log entries of one event, without their time stamps. */
  function logged(fixture: MultiverseFixture, event: string): Array<Record<string, unknown>> {
    return readMultiverseLog(fixture).entries.filter(entry => entry['event'] === event).map(({ ts: _ts, ...entry }) => entry)
  }

  it('records every prompt enhancement and branch proposal request with what the model returned', async () => {
    const fixture = await start()
    const { multiverse } = await createWithRoot(fixture)
    const root = { hostname: hostname(), multiverse_id: multiverse.multiverseId, node_id: multiverse.rootId }
    const { fileName, entries } = readMultiverseLog(fixture)
    expect(fileName).toMatch(/^\d{6}_\d{6}_\d{6}\.jsonl$/)
    expect(entries).toEqual([
      {
        ts: TIMESTAMP, event: 'prompt_enhance_request', ...root, operation: 'expand_clip', direction: CREATE_REQUEST.prompt,
        generation_mode: 'ref2va', segment_duration_sec: 5, reference_labels: ['Picture 1', 'Picture 2'],
        rewrite_model: 'model-a',
      },
      {
        ts: TIMESTAMP, event: 'prompt_enhance_response', ...root, prompt: `Expanded: ${CREATE_REQUEST.prompt}`, provider: 'test',
        model: 'model-a', latency_ms: 1, fallback_used: false, error: null,
      },
      {
        ts: TIMESTAMP, event: 'branch_proposal_request', ...root, provider: 'test-provider', model: 'test-model', reasoning_effort: 'low',
        system: PROPOSAL_SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: proposalMessage([ROOT_SCENE]) }] }],
        max_tokens: 640,
      },
      {
        ts: TIMESTAMP, event: 'branch_proposal_response', ...root, output: branchReply('Option 1'), reasoning: '',
        finish_reason: { kind: 'stop' }, error: null,
        branches: [{ label: 'Option 1 A', direction: 'Option 1 A happens.' }, { label: 'Option 1 B', direction: 'Option 1 B happens.' }],
      },
    ])

    const [chosen] = fixture.tree.children(multiverse.multiverseId, multiverse.rootId)
    fixture.director.choose(multiverse.multiverseId, chosen!.nodeId)
    await fixture.generation.nextCall()
    const labels = segmentImageLabels(ref2vaFacts(), 'ref2va', 2, true)
    expect(logged(fixture, 'prompt_enhance_request')[1]).toEqual({
      event: 'prompt_enhance_request', ...root, node_id: chosen!.nodeId, operation: 'continue_video', direction: 'Option 1 A happens.',
      generation_mode: 'ref2va', segment_duration_sec: 5, reference_labels: labels.referenceLabels,
      rewrite_model: 'model-a', locked_segments: [`Expanded: ${CREATE_REQUEST.prompt}`], next_segment_idx: 2,
      first_frame_label: labels.firstFrameLabel,
    })
  })

  it('records a failed proposal request with the raw output and the failure', async () => {
    const fixture = await start()
    const oneBranch = '{"branches": [{"label": "Only one", "direction": "Just this."}]}'
    fixture.llm.replies.push(oneBranch, new Error('rate limited'))
    const multiverse = await fixture.director.create(CREATE_REQUEST)
    const root = fixture.tree.node(multiverse.multiverseId, multiverse.rootId)
    ;(await fixture.generation.nextCall()).reply.resolve()
    await waitForTree(fixture.tree, () => root.error !== null, 'proposal failure')
    fixture.director.propose(multiverse.multiverseId, multiverse.rootId)
    await waitForTree(fixture.tree, () => root.error === 'Branch proposal failed: rate limited', 'failed proposal call')

    const ids = { hostname: hostname(), multiverse_id: multiverse.multiverseId, node_id: multiverse.rootId }
    expect(logged(fixture, 'branch_proposal_request')).toHaveLength(2)
    expect(logged(fixture, 'branch_proposal_response')).toEqual([
      {
        event: 'branch_proposal_response', ...ids, output: oneBranch, reasoning: '', finish_reason: { kind: 'stop' }, branches: null,
        error: 'Branch proposal reply must hold two branches.',
      },
      {
        event: 'branch_proposal_response', ...ids, output: '', reasoning: '', branches: null, error: 'Branch proposal failed: rate limited',
        finish_reason: { kind: 'error', failure: { message: 'rate limited', code: 'TEST' } },
      },
    ])
  })

  it('only warns when a log write fails, and still generates the node and proposes its branches', async () => {
    const fixture = await start()
    const warnings: string[] = []
    fixture.root.logger.exporter({
      levels: { default: LoggerLevel.WARN },
      export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])) },
    })
    rmSync(join(fixture.logRoot, hostname()), { recursive: true })
    const { multiverse } = await createWithRoot(fixture)
    expect(fixture.tree.node(multiverse.multiverseId, multiverse.rootId)).toMatchObject({ status: 'completed', error: null })
    expect(childLabels(fixture, multiverse, multiverse.rootId)).toEqual(['Option 1 A (proposed)', 'Option 1 B (proposed)'])
    expect(warnings.map(warning => warning.replace(/: ENOENT.*$/s, ''))).toEqual([
      'Failed to write multiverse log (prompt_enhance_request)',
      'Failed to write multiverse log (prompt_enhance_response)',
      'Failed to write multiverse log (branch_proposal_request)',
      'Failed to write multiverse log (branch_proposal_response)',
    ])
  })
})
