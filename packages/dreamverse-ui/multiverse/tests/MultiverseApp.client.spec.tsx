/** @vitest-environment jsdom */
/**
 * The multiverse page against a mocked `/multiverse/api` and `/assets`, with the DreamVerse creation studio and asset
 * library as slot occupants: creating a multiverse and reading it once a second; in player mode, playing the player's
 * world line and offering branches when a scene ends; in dev mode, drawing every world line, choosing any branch, and
 * playing the selected scene.
 */
import '../../kit/tests/support/setup.client.ts'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { assetUploadPolicy, mockReferenceImageLayout } from '../../kit/tests/support/assetFixtures.client.ts'
import { renderDreamverseSlot } from '../../kit/tests/support/renderDreamverseSlot.client.tsx'
import type { WireMultiverse, WireNode } from '../src/client/api.ts'
import { en } from '../src/client/locales.ts'
import { MultiverseApp } from '../src/client/MultiverseApp.tsx'

const t = makeTranslate(en)

/** One node as the API's JSON response carries it. */
type NodeJson = Omit<WireNode, 'node_id' | 'parent_id'> & { node_id: string; parent_id: string | null }

/** One multiverse as the API's JSON response carries it. */
type MultiverseJson = Omit<WireMultiverse, 'multiverse_id' | 'root_id' | 'nodes'> & {
  multiverse_id: string
  root_id: string
  nodes: NodeJson[]
}

/** The served H3 model's creation capabilities in the DreamVerse format, with one segment per node. */
const CAPABILITIES = {
  model_ids: ['h3-ref2va'], segment_counts: [1], asset_upload: assetUploadPolicy,
  models: {
    'h3-ref2va': {
      generation_modes: ['ref2va'], aspect_ratios: ['16:9'], resolutions: ['720p'], min_segment_duration_sec: 5,
      max_segment_duration_sec: 15, unsupported_generation_modes: {},
      reference_inputs: { media_types: ['image'], max_count: 2, conditioning: 'reference' },
    },
  },
}

/** One recorded API request; `body` holds a JSON request body and is null for other bodies. */
interface ApiCall {
  method: string
  url: string
  body: string | null
}

let calls: ApiCall[] = []
/** Responses by `<METHOD> <url>`; unlisted requests answer 404. */
let responses: Record<string, () => Response> = {}

beforeEach(() => {
  // Real time still passes for user events; `serve` moves the page's one-second read forward on demand.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  calls = []
  window.history.replaceState(null, '', '/')
  responses = {
    'GET /multiverse/api/capabilities': () => Response.json(CAPABILITIES),
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: input, body: typeof init?.body === 'string' ? init.body : null })
    return responses[`${method} ${input}`]?.() ?? Response.json({ detail: 'Not found' }, { status: 404 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A wire node with defaults for a proposed branch. */
function node(fields: Partial<NodeJson> & Pick<NodeJson, 'node_id' | 'label'>): NodeJson {
  return {
    parent_id: 'root', depth: 1, direction: `${fields.label} happens.`, status: 'proposed', prompt: null, error: null,
    has_clip: false, has_last_frame: false, ...fields,
  }
}

const ROOT = node({
  node_id: 'root', parent_id: null, depth: 0, label: 'Beginning', direction: 'A fox meets an owl.', status: 'completed',
  has_clip: true, has_last_frame: true,
})

/** A snapshot of multiverse `mv-1` with the given nodes. */
function snapshot(nodes: NodeJson[]): MultiverseJson {
  return { multiverse_id: 'mv-1', created_at: 1, root_id: 'root', segment_duration_sec: 5, nodes }
}

const MULTIVERSE_READ = 'GET /multiverse/api/multiverses/mv-1'

/** Answer the page's reads of multiverse `mv-1` with this snapshot and let the next one-second read happen. */
async function serve(multiverse: MultiverseJson): Promise<void> {
  responses[MULTIVERSE_READ] = () => Response.json(multiverse)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
}

/** Open multiverse `mv-1` in dev mode from the page URL with its first snapshot. */
async function openMultiverse(first: MultiverseJson): Promise<void> {
  responses[MULTIVERSE_READ] = () => Response.json(first)
  window.history.replaceState(null, '', '/?multiverse=mv-1&dev=1')
  render(<MultiverseApp renderSlot={renderDreamverseSlot} t={t} />)
  await screen.findByRole('list', { name: 'World lines' })
}

/** Open multiverse `mv-1` in player mode from the page URL with its first snapshot. */
async function playMultiverse(first: MultiverseJson): Promise<void> {
  responses[MULTIVERSE_READ] = () => Response.json(first)
  window.history.replaceState(null, '', '/?multiverse=mv-1')
  render(<MultiverseApp renderSlot={renderDreamverseSlot} t={t} />)
  await screen.findByTestId('player')
}

it('uploads the character references in order, creates the multiverse, and opens it', async () => {
  mockReferenceImageLayout()
  const user = userEvent.setup()
  let uploads = 0
  responses['POST /assets'] = () => {
    uploads += 1
    return Response.json({
      asset_id: `asset-${uploads}`, name: `a${uploads}.png`, media_type: 'image', mime_type: 'image/png', size_bytes: 1,
      width: 1, height: 1, duration_sec: null, content_url: `/assets/asset-${uploads}/content`,
    })
  }
  responses['POST /multiverse/api/multiverses'] = () => Response.json(snapshot([{ ...ROOT, status: 'generating', has_clip: false }]), { status: 201 })
  render(<MultiverseApp renderSlot={renderDreamverseSlot} t={t} />)

  await user.type(await screen.findByLabelText('Initial prompt'), 'A fox meets an owl.')
  await user.upload(screen.getByLabelText('Add reference images'), [
    new File(['a'], 'a1.png', { type: 'image/png' }), new File(['b'], 'a2.png', { type: 'image/png' }),
  ])
  await user.click(screen.getByRole('button', { name: 'Generate' }))

  await waitFor(() => { expect(calls.map(call => `${call.method} ${call.url}`)).toContain(MULTIVERSE_READ) })
  expect(calls.slice(0, 4).map(call => `${call.method} ${call.url}`)).toEqual([
    'GET /multiverse/api/capabilities', 'POST /assets', 'POST /assets', 'POST /multiverse/api/multiverses',
  ])
  expect(JSON.parse(calls[3]?.body ?? '')).toEqual({
    prompt: 'A fox meets an owl.', model_id: 'h3-ref2va', aspect_ratio: '16:9', resolution: '720p', segment_duration_sec: 5,
    segment_count: 1, reference_asset_ids: ['asset-1', 'asset-2'],
  })
  expect(window.location.search).toBe('?multiverse=mv-1')
})

it('keeps Generate disabled until the opening scene has a character reference', async () => {
  mockReferenceImageLayout()
  const user = userEvent.setup()
  render(<MultiverseApp renderSlot={renderDreamverseSlot} t={t} />)
  await user.type(await screen.findByLabelText('Initial prompt'), 'A fox meets an owl.')
  expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
  await user.upload(screen.getByLabelText('Add reference images'), new File(['a'], 'a1.png', { type: 'image/png' }))
  expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
})

it('draws generated and proposed nodes as a tree and plays the newest generated scene', async () => {
  await openMultiverse(snapshot([ROOT, node({ node_id: 'a', label: 'Follow the owl' }), node({ node_id: 'b', label: 'Stay hidden' })]))

  const tree = screen.getByRole('list', { name: 'World lines' })
  const root = within(tree).getByTestId('node-root')
  expect(root).toHaveAttribute('data-status', 'completed')
  expect(within(root).getByText('Generated')).toBeInTheDocument()
  expect(root.querySelector('img')).toHaveAttribute('src', '/multiverse/api/multiverses/mv-1/nodes/root/last-frame')
  for (const [id, label] of [['a', 'Follow the owl'], ['b', 'Stay hidden']] as const) {
    const branch = within(tree).getByTestId(`node-${id}`)
    expect(branch).toHaveAttribute('data-status', 'proposed')
    expect(within(branch).getByText(label)).toBeInTheDocument()
    expect(within(branch).getByText(`${label} happens.`)).toBeInTheDocument()
    expect(within(branch).getByRole('button', { name: 'Choose' })).toBeEnabled()
  }
  expect(screen.getByTestId('scene-video')).toHaveAttribute('src', '/multiverse/api/multiverses/mv-1/nodes/root/clip')
})

it('generates only the chosen branch and hides every choice while it generates', async () => {
  const user = userEvent.setup()
  responses['POST /multiverse/api/multiverses/mv-1/nodes/a/choose'] = () => Response.json({}, { status: 202 })
  await openMultiverse(snapshot([ROOT, node({ node_id: 'a', label: 'Follow the owl' }), node({ node_id: 'b', label: 'Stay hidden' })]))

  await user.click(within(screen.getByTestId('node-a')).getByRole('button', { name: 'Choose' }))
  expect(calls.filter(call => call.method === 'POST').map(call => call.url)).toEqual(['/multiverse/api/multiverses/mv-1/nodes/a/choose'])

  await serve(snapshot([ROOT, node({ node_id: 'a', label: 'Follow the owl', status: 'generating' }), node({ node_id: 'b', label: 'Stay hidden' })]))
  expect(within(screen.getByTestId('node-a')).getByText('Generating…')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Choose' })).not.toBeInTheDocument()
  expect(screen.getByTestId('node-b')).toHaveAttribute('data-status', 'proposed')
})

it('selects a newly generated branch for playback and plays an earlier scene when its card is clicked', async () => {
  const user = userEvent.setup()
  await openMultiverse(snapshot([ROOT, node({ node_id: 'a', label: 'Follow the owl', status: 'generating' }), node({ node_id: 'b', label: 'Stay hidden' })]))
  await serve(snapshot([
    ROOT,
    node({ node_id: 'a', label: 'Follow the owl', status: 'completed', has_clip: true, has_last_frame: true }),
    node({ node_id: 'b', label: 'Stay hidden' }),
    node({ node_id: 'c', parent_id: 'a', depth: 2, label: 'Into the forest' }),
    node({ node_id: 'd', parent_id: 'a', depth: 2, label: 'Up the tower' }),
  ]))
  expect(screen.getByTestId('scene-video')).toHaveAttribute('src', '/multiverse/api/multiverses/mv-1/nodes/a/clip')
  expect(screen.getByRole('heading', { name: 'Follow the owl' })).toBeInTheDocument()
  expect(within(screen.getByTestId('node-a')).getByRole('button', { name: /Follow the owl/ })).toHaveAttribute('aria-pressed', 'true')

  await user.click(within(screen.getByTestId('node-root')).getByRole('button', { name: /Beginning/ }))
  expect(screen.getByTestId('scene-video')).toHaveAttribute('src', '/multiverse/api/multiverses/mv-1/nodes/root/clip')
  expect(within(screen.getByTestId('node-c')).getByRole('button', { name: /Into the forest/ })).toBeDisabled()
})

it('shows a refused choice and offers to propose again after a failed proposal', async () => {
  const user = userEvent.setup()
  responses['POST /multiverse/api/multiverses/mv-1/nodes/a/choose'] = () =>
    Response.json({ detail: 'Wait for the current scene to finish generating.' }, { status: 400 })
  responses['POST /multiverse/api/multiverses/mv-1/nodes/root/propose'] = () => Response.json({}, { status: 202 })
  await openMultiverse(snapshot([ROOT, node({ node_id: 'a', label: 'Follow the owl' }), node({ node_id: 'b', label: 'Stay hidden' })]))
  await user.click(within(screen.getByTestId('node-a')).getByRole('button', { name: 'Choose' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Wait for the current scene to finish generating.')

  await serve(snapshot([{ ...ROOT, error: 'Branch proposal reply must hold two branches.' }]))
  expect(within(screen.getByTestId('node-root')).getByText('Branch proposal reply must hold two branches.')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Propose again' }))
  expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/multiverse/api/multiverses/mv-1/nodes/root/propose' })
})

it('stops reading the multiverse and returns to the creation studio for a new multiverse', async () => {
  const user = userEvent.setup()
  await openMultiverse(snapshot([ROOT]))
  await user.click(screen.getByRole('button', { name: 'New multiverse' }))
  const reads = calls.filter(call => `${call.method} ${call.url}` === MULTIVERSE_READ).length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(calls.filter(call => `${call.method} ${call.url}` === MULTIVERSE_READ)).toHaveLength(reads)
  expect(await screen.findByLabelText('Initial prompt')).toBeInTheDocument()
  // Dev mode stays on, so the next multiverse also opens in dev mode.
  expect(window.location.search).toBe('?dev=1')
})

it('plays the player\'s scene full screen and offers its branches only after it ends', async () => {
  await playMultiverse(snapshot([ROOT, node({ node_id: 'a', label: 'Follow the owl' }), node({ node_id: 'b', label: 'Stay hidden' })]))
  const video = screen.getByTestId('scene-video')
  expect(video).toHaveAttribute('src', '/multiverse/api/multiverses/mv-1/nodes/root/clip')
  expect(screen.getByTestId('preloaded-frame')).toHaveAttribute('src', '/multiverse/api/multiverses/mv-1/nodes/root/last-frame')
  expect(screen.queryByRole('group', { name: 'Choices' })).not.toBeInTheDocument()
  expect(screen.queryByRole('list', { name: 'World lines' })).not.toBeInTheDocument()

  fireEvent.ended(video)
  const choices = within(screen.getByRole('group', { name: 'Choices' })).getAllByRole('button')
  expect(choices.map(choice => choice.textContent)).toEqual(['Follow the owlFollow the owl happens.', 'Stay hiddenStay hidden happens.'])
})

it('holds the last frame while the chosen branch generates, then plays it on the player\'s world line only', async () => {
  const user = userEvent.setup()
  responses['POST /multiverse/api/multiverses/mv-1/nodes/a/choose'] = () => Response.json({}, { status: 202 })
  await playMultiverse(snapshot([ROOT, node({ node_id: 'a', label: 'Follow the owl' }), node({ node_id: 'b', label: 'Stay hidden' })]))
  fireEvent.ended(screen.getByTestId('scene-video'))
  await user.click(screen.getByRole('button', { name: /Follow the owl/ }))
  expect(calls.filter(call => call.method === 'POST').map(call => call.url)).toEqual(['/multiverse/api/multiverses/mv-1/nodes/a/choose'])
  expect(window.location.search).toBe('?multiverse=mv-1&node=a')

  await serve(snapshot([ROOT, node({ node_id: 'a', label: 'Follow the owl', status: 'generating' }), node({ node_id: 'b', label: 'Stay hidden' })]))
  expect(screen.getByTestId('held-frame')).toHaveAttribute('src', '/multiverse/api/multiverses/mv-1/nodes/root/last-frame')
  expect(screen.getByText('Generating the next scene…')).toBeInTheDocument()
  expect(screen.queryByTestId('scene-video')).not.toBeInTheDocument()

  await serve(snapshot([
    ROOT,
    node({ node_id: 'a', label: 'Follow the owl', status: 'completed', has_clip: true, has_last_frame: true }),
    node({ node_id: 'b', label: 'Stay hidden' }),
    node({ node_id: 'c', parent_id: 'a', depth: 2, label: 'Into the forest' }),
    node({ node_id: 'd', parent_id: 'a', depth: 2, label: 'Up the tower' }),
  ]))
  expect(screen.getByTestId('scene-video')).toHaveAttribute('src', '/multiverse/api/multiverses/mv-1/nodes/a/clip')
  expect(screen.queryByRole('group', { name: 'Choices' })).not.toBeInTheDocument()
  fireEvent.ended(screen.getByTestId('scene-video'))
  expect(within(screen.getByRole('group', { name: 'Choices' })).getAllByRole('button')).toHaveLength(2)
  expect(screen.getByRole('button', { name: /Into the forest/ })).toBeInTheDocument()
  expect(screen.queryByText('Stay hidden')).not.toBeInTheDocument()
})

it('switches to dev mode and back, keeping the player\'s scene', async () => {
  const user = userEvent.setup()
  window.history.replaceState(null, '', '/?multiverse=mv-1&node=a')
  responses[MULTIVERSE_READ] = () => Response.json(snapshot([
    ROOT, node({ node_id: 'a', label: 'Follow the owl', status: 'completed', has_clip: true, has_last_frame: true }), node({ node_id: 'b', label: 'Stay hidden' }),
  ]))
  render(<MultiverseApp renderSlot={renderDreamverseSlot} t={t} />)
  expect(await screen.findByTestId('scene-video')).toHaveAttribute('src', '/multiverse/api/multiverses/mv-1/nodes/a/clip')

  await user.click(screen.getByRole('button', { name: 'Dev mode' }))
  expect(await screen.findByRole('list', { name: 'World lines' })).toBeInTheDocument()
  expect(window.location.search).toBe('?multiverse=mv-1&node=a&dev=1')
  await user.click(screen.getByRole('button', { name: 'Player mode' }))
  expect(await screen.findByTestId('player')).toBeInTheDocument()
  expect(window.location.search).toBe('?multiverse=mv-1&node=a')
})
