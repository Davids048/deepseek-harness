/** @vitest-environment jsdom */
/**
 * Ports FastVideo DreamVerse src/app/page.integration.test.tsx: the skipped legacy page WebSocket suite (streaming
 * workspace, rewrites, archives), kept skipped as in FastVideo.
 */
import '../support/setup.client.ts'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type Client, Server } from 'mock-socket'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { ArchivedAvSegment, AvPipeline, createAvPipeline as createRealAvPipeline } from '../../src/client/media/avPipeline.ts'

/** A received media chunk as Page passes it to `enqueueChunk`. */
type MediaChunk = ArrayBuffer | ArrayBufferView<ArrayBuffer>

/** Fields that these cases read from a parsed message that Page sent on a project WebSocket. */
interface OutboundMessage {
  type: string
  preset_id?: string
  preset_label?: string
  curated_prompts?: string[]
  enhancement_enabled?: boolean
  auto_extension_enabled?: boolean
  loop_generation_enabled?: boolean
  initial_rollout_prompt?: string
  rewrite_instruction?: string
  prompt_window_prompts?: string[]
}

const avPipelineMockState = vi.hoisted(() => ({
  useNativePlaybackFallback: false,
}))

const projectsMockState = vi.hoisted(() => ({
  listProjects: vi.fn(async () => []),
  reset() {
    this.listProjects.mockClear()
  },
}))

vi.mock('@dreamverse/project-controller/client/storyPresetsData.ts', () => ({
  default: [
    {
      id: 'test_preset',
      label: 'Test Preset',
      segment_prompts: ['segment one', 'segment two'],
    },
  ],
}))

vi.mock('../../src/client/media/avPipeline.ts', () => ({
  DEFAULT_AV_MIME: 'video/mp4',
  createAvPipeline: vi.fn(({ onPlaybackStarted = () => {} }: Parameters<typeof createRealAvPipeline>[0]) => {
    let archivedChunks: ArrayBuffer[] = []
    let archivedSegments: ArchivedAvSegment[] = []
    let activeSegmentKey = ''

    function cloneChunk(chunk: MediaChunk) {
      if (chunk instanceof ArrayBuffer) {
        return chunk.slice(0)
      }
      if (ArrayBuffer.isView(chunk)) {
        return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
      }
      return chunk
    }

    return {
      reset: vi.fn(() => {
        archivedChunks = []
        archivedSegments = []
        activeSegmentKey = ''
      }),
      enqueueChunk: vi.fn((chunk: MediaChunk) => {
        const clonedChunk = cloneChunk(chunk)
        archivedChunks = [...archivedChunks, clonedChunk]
        if (!activeSegmentKey) {
          const key = `implicit-${archivedSegments.length + 1}`
          activeSegmentKey = key
          archivedSegments = [
            ...archivedSegments,
            {
              key,
              segmentIdx: null,
              streamId: key,
              mime: 'video/mp4',
              completed: false,
              chunks: [],
            },
          ]
        }
        const target = archivedSegments.find(segment => segment.key === activeSegmentKey)
        if (target) {
          target.chunks.push(clonedChunk)
        }
      }),
      ensurePipeline: vi.fn(async () => {}),
      stopPlayback: vi.fn(),
      maybeStartPlayback: vi.fn(() => {
        onPlaybackStarted()
      }),
      tryEndStream: vi.fn(() => {}),
      setStreamCompleted: vi.fn(() => {}),
      noteSegmentInit: vi.fn(({
        segmentIdx = null, streamId = '', mime = 'video/mp4',
      }: Parameters<AvPipeline['noteSegmentInit']>[0] = {}) => {
        const normalizedStreamId = streamId || `stream-${archivedSegments.length + 1}`
        const key = `${segmentIdx !== null ? segmentIdx : 'na'}:${normalizedStreamId}`
        const existing = archivedSegments.find(segment => segment.key === key)
        if (existing) {
          existing.completed = false
          existing.mime = mime || existing.mime
        } else {
          archivedSegments = [
            ...archivedSegments,
            {
              key,
              segmentIdx,
              streamId: normalizedStreamId,
              mime: mime || 'video/mp4',
              completed: false,
              chunks: [],
            },
          ]
        }
        activeSegmentKey = key
      }),
      noteSegmentComplete: vi.fn(({ segmentIdx = null, streamId = '' }: Parameters<AvPipeline['noteSegmentComplete']>[0] = {}) => {
        let target: ArchivedAvSegment | null = null
        if (streamId) {
          target = archivedSegments.find(
            segment => segment.streamId === streamId && (segmentIdx === null || segment.segmentIdx === segmentIdx),
          ) || null
        }
        if (!target && activeSegmentKey) {
          target = archivedSegments.find(segment => segment.key === activeSegmentKey) || null
        }
        if (target) {
          target.completed = true
          if (target.key === activeSegmentKey) {
            activeSegmentKey = ''
          }
        }
      }),
      hasArchivedChunks: vi.fn(() => {
        return archivedChunks.length > 0
      }),
      buildArchivedStreamChunks: vi.fn(() => archivedChunks.map((chunk) => {
        if (chunk instanceof ArrayBuffer) {
          return chunk.slice(0)
        }
        return chunk
      })),
      buildArchivedSegmentSnapshots: vi.fn(({ includeInProgress = true } = {}) => archivedSegments
        .filter(segment => segment.chunks.length > 0 && (includeInProgress || segment.completed))
        .map(segment => ({
          ...segment,
          chunks: segment.chunks.map(chunk => cloneChunk(chunk)),
        }))),
      buildArchivedStreamBlob: vi.fn(() => {
        return new Blob(archivedChunks, { type: 'video/mp4' })
      }),
      takeArchivedStreamChunks: vi.fn(() => {
        const chunks = archivedChunks.map((chunk) => {
          if (chunk instanceof ArrayBuffer) {
            return chunk.slice(0)
          }
          return chunk
        })
        archivedChunks = []
        archivedSegments = []
        activeSegmentKey = ''
        return chunks
      }),
      takeArchivedSegmentSnapshots: vi.fn(({ includeInProgress = true } = {}) => {
        const snapshots = archivedSegments
          .filter(segment => segment.chunks.length > 0 && (includeInProgress || segment.completed))
          .map(segment => ({
            ...segment,
            chunks: segment.chunks.map(chunk => cloneChunk(chunk)),
          }))
        if (includeInProgress) {
          archivedSegments = []
          activeSegmentKey = ''
        } else {
          archivedSegments = archivedSegments.filter(segment => !segment.completed)
          if (activeSegmentKey && !archivedSegments.some(segment => segment.key === activeSegmentKey)) {
            activeSegmentKey = ''
          }
        }
        return snapshots
      }),
      usesNativePlaybackFallback() {
        return avPipelineMockState.useNativePlaybackFallback
      },
    }
  }),
}))

vi.mock('@dreamverse/project-controller/client/projects.ts', async importOriginal => ({
  ProjectRequestError: (await importOriginal<typeof import('@dreamverse/project-controller/client/projects.ts')>()).ProjectRequestError,
  listProjects: projectsMockState.listProjects,
  getProject: vi.fn(),
  deleteProject: vi.fn(),
  fetchSegmentVideo: vi.fn(),
}))

import { DreamverseApp } from '../../src/client/app/DreamverseApp.tsx'
import { englishKitT, renderDreamverseSlot } from '../support/renderDreamverseSlot.client.tsx'
import { createAvPipeline } from '../../src/client/media/avPipeline.ts'

function getWsUrl() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${window.location.host}/ws`
}

/** Return the server side of a project WebSocket, failing the case when Page has not connected it. */
function connectedSocket(socket: Client | undefined): Client {
  if (!socket) throw new Error('Page has not connected a project WebSocket')
  return socket
}

describe.skip('App websocket integration', () => {
  let server: Server
  let fetchMock: Mock<(input: RequestInfo | URL) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>>

  beforeEach(() => {
    avPipelineMockState.useNativePlaybackFallback = false
    projectsMockState.reset()
    window.history.pushState({}, '', '/')
    server = new Server(getWsUrl())
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url.endsWith('/healthz')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ok',
            service: 'ltx2-streaming-backend',
          }),
        }
      }
      if (url.endsWith('/readyz')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ready',
            service: 'ltx2-streaming-backend',
            ready_gpu_workers: 1,
            total_gpus: 1,
            available_gpus: 1,
            warmup_successful_gpus: 1,
            warmup_failed_gpus: 0,
            queue_size: 0,
          }),
        }
      }
      if (url.endsWith('/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_gpus: 1,
            available_gpus: 1,
            queue_size: 0,
            warmup_enabled: true,
            warmup_successful_gpus: 1,
            warmup_failed_gpus: 0,
          }),
        }
      }
      throw new Error(`Unhandled fetch request in test: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    server.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the streaming chat workspace and hides advanced panels', async () => {
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    expect(await screen.findByRole('heading', { name: 'Realtime streaming video workspace' }))
      .toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse history sidebar' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Main chat' })).toBeInTheDocument()
    expect(screen.getByLabelText('Story preset')).toBeInTheDocument()
    expect(screen.getByLabelText('Continuation prompt')).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Guide next segment' })).not.toBeInTheDocument()
    expect(screen.getByText('Video replies')).toBeInTheDocument()
    expect(screen.queryByText('Session setup')).not.toBeInTheDocument()

    expect(screen.queryByText('Live Prompt Input')).not.toBeInTheDocument()
    expect(screen.queryByText('Prompt Window')).not.toBeInTheDocument()
    expect(screen.queryByText('Editable Prompt Segments')).not.toBeInTheDocument()
    expect(screen.queryByText('Depth Mode: System Prompt Editor')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Prompt count')).not.toBeInTheDocument()
  })

  it('collapses and re-expands the history sidebar', async () => {
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Collapse history sidebar' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Expand history sidebar' })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'History' })).not.toBeInTheDocument()
      expect(screen.getByText('Clips')).toBeInTheDocument()
      expect(screen.getByText('Prompts')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Expand history sidebar' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Collapse history sidebar' })).toBeInTheDocument()
    })
  })

  it('keeps the active prompt window collapsed by default and expands it on toggle', async () => {
    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    expect(await screen.findByRole('button', { name: 'Show prompts' })).toBeInTheDocument()
    expect(
      screen.getByText(
        '2 prompts in the active window. Expand when you want to inspect the full rollout context.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Window 1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show prompts' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Hide prompts' })).toBeInTheDocument()
      expect(screen.getByText('Window 1')).toBeInTheDocument()
      expect(screen.getByText('Window 2')).toBeInTheDocument()
    })
  })

  it('sends project_init_v1 payload when Generate is clicked', async () => {
    const outbound: OutboundMessage[] = []
    server.on('connection', (socket) => {
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    const generateButton = await screen.findByRole('button', { name: 'Generate' })
    await waitFor(() => expect(generateButton).toBeEnabled())
    await user.click(generateButton)

    await waitFor(() => {
      expect(outbound.some(message => message.type === 'project_init_v1')).toBe(true)
    })

    const initMessage = outbound.find(message => message.type === 'project_init_v1')
    expect(initMessage?.preset_id).toBe('test_preset')
    expect(initMessage?.curated_prompts).toEqual(['segment one', 'segment two'])
    expect(initMessage?.enhancement_enabled).toBe(true)
    expect(initMessage?.auto_extension_enabled).toBe(false)
    expect(initMessage?.loop_generation_enabled).toBe(false)
    expect(initMessage?.initial_rollout_prompt).toBe('')
  })

  it('starts a streaming session from a custom initial prompt without using curated prompts', async () => {
    const outbound: OutboundMessage[] = []
    server.on('connection', (socket) => {
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(
      continuationInput,
      'A lone astronaut walks through a flooded moonbase corridor lit by failing red alarms',
    )

    const generateButton = await screen.findByRole('button', { name: 'Generate' })
    await waitFor(() => expect(generateButton).toBeEnabled())
    await user.click(generateButton)

    await waitFor(() => {
      expect(outbound.some(message => message.type === 'project_init_v1')).toBe(true)
    })

    const initMessage = outbound.find(message => message.type === 'project_init_v1')
    expect(initMessage?.preset_id).toBe('custom_editable')
    expect(initMessage?.preset_label).toBe('Custom rollout')
    expect(initMessage?.curated_prompts).toEqual([])
    expect(initMessage?.initial_rollout_prompt)
      .toBe(
        'A lone astronaut walks through a flooded moonbase corridor lit by failing red alarms',
      )
  })

  it('shows a specific notice when a second websocket from the same IP is rejected', async () => {
    const outbound: OutboundMessage[] = []
    const sockets: Client[] = []
    server.on('connection', (socket) => {
      sockets.push(socket)
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })

      if (sockets.length === 2) {
        socket.send(JSON.stringify({
          type: 'error',
          error_code: 'ip_session_limit',
          message: 'Only one active websocket session is allowed per IP. Close the other session and retry.',
        }))
        socket.close()
      }
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    const [firstGenerateButton, secondGenerateButton] = await screen.findAllByRole('button', { name: 'Generate' })
    if (!firstGenerateButton || !secondGenerateButton) throw new Error('Expected a Generate button on each page')
    await user.click(firstGenerateButton)

    await waitFor(() => {
      expect(sockets).toHaveLength(1)
      expect(outbound.filter(message => message.type === 'project_init_v1')).toHaveLength(1)
    })

    await user.click(secondGenerateButton)

    await waitFor(() => {
      expect(sockets).toHaveLength(2)
      expect(outbound.filter(message => message.type === 'project_init_v1')).toHaveLength(2)
    })

    await waitFor(() => {
      expect(screen.getByText(
        'Only one active websocket session is allowed per IP. Close the other session and click Run to retry.',
      )).toBeInTheDocument()
    })
  })

  it('shows a clear notice when the backend is not reachable before session start', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url.endsWith('/healthz')) {
        throw new Error('network down')
      }
      throw new Error(`Unhandled fetch request in test: ${url}`)
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(continuationInput, 'A neon city skyline in the rain')
    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    expect(await screen.findByText(
      'Dreamverse backend is not reachable. From the checkout root, run PYTHONPATH="$(pwd)/apps/dreamverse:$(pwd)${PYTHONPATH:+:$PYTHONPATH}" python -m dreamverse.server_entry --preset fast-ltx23 and wait for /readyz to return 200 before retrying.',
    )).toBeInTheDocument()
    expect(screen.getByLabelText('Continuation prompt')).toHaveValue('A neon city skyline in the rain')
  })

  it('shows a readiness notice when GPU workers are not ready yet', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url.endsWith('/healthz')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok' }),
        }
      }
      if (url.endsWith('/readyz')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ detail: 'No ready GPU worker processes.' }),
        }
      }
      if (url.endsWith('/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_gpus: 1,
            available_gpus: 0,
            queue_size: 0,
            warmup_enabled: true,
            warmup_successful_gpus: 0,
            warmup_failed_gpus: 0,
          }),
        }
      }
      throw new Error(`Unhandled fetch request in test: ${url}`)
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(continuationInput, 'A cathedral drifting through clouds')
    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    expect(await screen.findByText(
      'Dreamverse backend is running, but GPU workers are not ready yet. Wait for startup warmup to finish and retry.',
    )).toBeInTheDocument()
    expect(screen.getByLabelText('Continuation prompt')).toHaveValue('A cathedral drifting through clouds')
  })

  it('submits rewrite requests from the chat composer', async () => {
    const outbound: OutboundMessage[] = []
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'gpu_assigned',
      gpu_id: 0,
    }))

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await waitFor(() => expect(continuationInput).toBeEnabled())
    await user.type(
      continuationInput,
      'Make the mood more ominous and push closer to the subject',
    )

    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))

    await waitFor(() => {
      expect(outbound.some(message => message.type === 'rewrite_seed_prompts')).toBe(true)
    })

    const rewriteMessage = outbound.find(message => message.type === 'rewrite_seed_prompts')
    expect(rewriteMessage?.rewrite_instruction)
      .toBe('Make the mood more ominous and push closer to the subject')
    expect(Array.isArray(rewriteMessage?.prompt_window_prompts)).toBe(true)
  })

  it('sends rewrite requests from the continuation composer', async () => {
    const outbound: OutboundMessage[] = []
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'gpu_assigned',
      gpu_id: 0,
    }))

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await waitFor(() => expect(continuationInput).toBeEnabled())
    await user.type(continuationInput, 'A dramatic reveal')

    const rewriteButton = screen.getByRole('button', { name: 'Rewrite rollout' })
    await waitFor(() => expect(rewriteButton).toBeEnabled())
    await user.click(rewriteButton)

    await waitFor(() => {
      expect(outbound.some(message => message.type === 'rewrite_seed_prompts')).toBe(true)
    })

    const rewriteMessage = outbound.find(message => message.type === 'rewrite_seed_prompts')
    expect(rewriteMessage?.rewrite_instruction).toBe('A dramatic reveal')
    expect(Array.isArray(rewriteMessage?.prompt_window_prompts)).toBe(true)
  })

  it('uses the selected archived version as the next rewrite source', async () => {
    const outbound: OutboundMessage[] = []
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'gpu_assigned',
      gpu_id: 0,
    }))

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'segment one',
      source: 'curated',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([1, 2, 3]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'segment two',
      source: 'curated',
      seed_prompt_index: 1,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([4, 5, 6]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 2 }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'ltx2_stream_complete' }))

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(continuationInput, 'Turn it into a desert')
    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))

    await waitFor(() => {
      expect(outbound.filter(message => message.type === 'rewrite_seed_prompts')).toHaveLength(1)
    })

    connectedSocket(clientSocket).send(JSON.stringify({ type: 'rewrite_seed_prompts_started' }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'seed_prompts_updated',
      reason: 'rewrite',
      prompts: [
        'desert one',
        'desert two',
      ],
    }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'rewrite_seed_prompts_complete' }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'seed_prompts_reset_applied' }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_stream_start',
      total_segments: 2,
      loop_generation_enabled: false,
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'desert one',
      source: 'rewrite',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([7, 8, 9]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'desert two',
      source: 'rewrite',
      seed_prompt_index: 1,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([10, 11, 12]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 2 }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'ltx2_stream_complete' }))

    await screen.findByText('Turn it into a desert')

    await user.click(screen.getByText('Original'))

    const freshContinuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(freshContinuationInput, 'Add snowfall')
    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))

    await waitFor(() => {
      expect(outbound.filter(message => message.type === 'rewrite_seed_prompts')).toHaveLength(2)
    })

    const secondRewrite = outbound
      .filter(message => message.type === 'rewrite_seed_prompts')
      .at(-1)
    expect(secondRewrite?.prompt_window_prompts?.slice(0, 2)).toEqual([
      'segment one',
      'segment two',
    ])
  })

  it('highlights the selected edit history item and rewrites from that selected version', async () => {
    const outbound: OutboundMessage[] = []
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'gpu_assigned',
      gpu_id: 0,
    }))

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'segment one',
      source: 'curated',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([1, 2, 3]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'segment two',
      source: 'curated',
      seed_prompt_index: 1,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([4, 5, 6]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 2 }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'ltx2_stream_complete' }))

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(continuationInput, 'Turn it into a desert')
    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))

    await waitFor(() => {
      expect(outbound.filter(message => message.type === 'rewrite_seed_prompts')).toHaveLength(1)
    })

    connectedSocket(clientSocket).send(JSON.stringify({ type: 'rewrite_seed_prompts_started' }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'seed_prompts_updated',
      reason: 'rewrite',
      prompts: [
        'desert one',
        'desert two',
      ],
    }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'rewrite_seed_prompts_complete' }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'seed_prompts_reset_applied' }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_stream_start',
      total_segments: 2,
      loop_generation_enabled: false,
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'desert one',
      source: 'rewrite',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([7, 8, 9]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'desert two',
      source: 'rewrite',
      seed_prompt_index: 1,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([10, 11, 12]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 2 }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'ltx2_stream_complete' }))

    await screen.findByText('Turn it into a desert')

    const secondContinuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(secondContinuationInput, 'Add snowfall')
    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))

    await waitFor(() => {
      expect(outbound.filter(message => message.type === 'rewrite_seed_prompts')).toHaveLength(2)
    })

    connectedSocket(clientSocket).send(JSON.stringify({ type: 'rewrite_seed_prompts_started' }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'seed_prompts_updated',
      reason: 'rewrite',
      prompts: [
        'snow one',
        'snow two',
      ],
    }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'rewrite_seed_prompts_complete' }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'seed_prompts_reset_applied' }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_stream_start',
      total_segments: 2,
      loop_generation_enabled: false,
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'snow one',
      source: 'rewrite',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([13, 14, 15]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'snow two',
      source: 'rewrite',
      seed_prompt_index: 1,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([16, 17, 18]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 2 }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'ltx2_stream_complete' }))

    const currentHistoryRow = await screen.findByText('Add snowfall')
    await waitFor(() => {
      expect(currentHistoryRow.closest('[data-selected]')).toHaveAttribute('data-selected', 'true')
    })

    const olderHistoryRow = screen.getByText('Turn it into a desert')
    await user.click(olderHistoryRow)

    await waitFor(() => {
      expect(olderHistoryRow.closest('[data-selected]')).toHaveAttribute('data-selected', 'true')
      expect(currentHistoryRow.closest('[data-selected]')).toHaveAttribute('data-selected', 'false')
    })

    const thirdContinuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(thirdContinuationInput, 'Make it rainy')
    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))

    await waitFor(() => {
      expect(outbound.filter(message => message.type === 'rewrite_seed_prompts')).toHaveLength(3)
    })

    const thirdRewrite = outbound
      .filter(message => message.type === 'rewrite_seed_prompts')
      .at(-1)
    expect(thirdRewrite?.prompt_window_prompts?.slice(0, 2)).toEqual([
      'desert one',
      'desert two',
    ])
  })

  it('submits the rewrite-only continuation composer with Enter', async () => {
    const outbound: OutboundMessage[] = []
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'gpu_assigned',
      gpu_id: 0,
    }))

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await waitFor(() => expect(continuationInput).toBeEnabled())
    await user.type(continuationInput, 'A dramatic reveal{Enter}')

    await waitFor(() => {
      expect(outbound.some(message => message.type === 'rewrite_seed_prompts')).toBe(true)
    })

    const rewriteMessage = outbound.find(message => message.type === 'rewrite_seed_prompts')
    expect(rewriteMessage?.rewrite_instruction).toBe('A dramatic reveal')
    expect(continuationInput).toHaveValue('')
  })

  it('submits rewrite requests with Enter from the composer', async () => {
    const outbound: OutboundMessage[] = []
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'gpu_assigned',
      gpu_id: 0,
    }))

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await waitFor(() => expect(continuationInput).toBeEnabled())
    await user.type(
      continuationInput,
      'Make the mood more ominous and push closer to the subject{Enter}',
    )

    await waitFor(() => {
      expect(outbound.some(message => message.type === 'rewrite_seed_prompts')).toBe(true)
    })

    const rewriteMessage = outbound.find(message => message.type === 'rewrite_seed_prompts')
    expect(rewriteMessage?.rewrite_instruction)
      .toBe('Make the mood more ominous and push closer to the subject')
    expect(continuationInput).toHaveValue('')
  })

  it('keeps the completed 30s rollout in the main player and adds one video-reply card', async () => {
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
    })

    const user = userEvent.setup()
    const { container } = render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'segment one',
      source: 'curated',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([1, 2, 3]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'segment two',
      source: 'curated',
      seed_prompt_index: 1,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([4, 5, 6]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 2 }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'ltx2_stream_complete' }))

    await waitFor(() => {
      expect(container.querySelectorAll('.gallery-card')).toHaveLength(1)
    })
    expect(container.querySelector('.stage-copy h2')?.textContent).toBe('Test Preset')
    expect(screen.getByRole('button', { name: /Test Preset/i })).toBeInTheDocument()
    expect(container.querySelector('.gallery-card.is-active')).toBeNull()
  })

  it('keeps prior clips available while a rewrite-driven restart is underway', async () => {
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
    })

    const user = userEvent.setup()
    const { container } = render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'gpu_assigned',
      gpu_id: 0,
    }))

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'segment one',
      source: 'curated',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([1, 2, 3]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'segment two',
      source: 'curated',
      seed_prompt_index: 1,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([4, 5, 6]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 2 }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'ltx2_stream_complete' }))

    await waitFor(() => {
      expect(container.querySelectorAll('.gallery-card')).toHaveLength(1)
    })

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(continuationInput, 'The camera cuts to a rooftop chase')
    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'rewrite_seed_prompts_started',
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'seed_prompts_updated',
      reason: 'rewrite',
      prompts: [
        'The camera cuts to a rooftop chase',
        'A wider aerial view of the rooftop pursuit',
      ],
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'rewrite_seed_prompts_complete',
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'seed_prompts_reset_applied',
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_stream_start',
      total_segments: 2,
      loop_generation_enabled: false,
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'The camera cuts to a rooftop chase',
      source: 'rewrite',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([4, 5, 6]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))

    await waitFor(() => {
      expect(container.querySelectorAll('.gallery-card')).toHaveLength(1)
    })
    expect(container.textContent).toContain('The camera cuts to a rooftop chase')
    expect(container.querySelector('.stage-copy h2')?.textContent).toBe('Cuts 2')

    const galleryLabelsBeforeSelection = Array.from<Element>(
      container.querySelectorAll('.gallery-card .gallery-card-label'),
    ).map((node: Element) => node.textContent || '')
    expect(galleryLabelsBeforeSelection).toEqual(['Test Preset'])

    await user.click(screen.getByRole('button', { name: /Test Preset/i }))

    await waitFor(() => {
      expect(container.querySelector('.stage-copy h2')?.textContent).toBe('Test Preset')
    })

    const galleryLabelsAfterSelection = Array.from<Element>(
      container.querySelectorAll('.gallery-card .gallery-card-label'),
    ).map((node: Element) => node.textContent || '')
    expect(galleryLabelsAfterSelection).toEqual(['Test Preset'])
  })

  it('recreates the live media pipeline when a rewrite restarts mid-generation', async () => {
    const outbound: OutboundMessage[] = []
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
      socket.on('message', (rawMessage) => {
        outbound.push(JSON.parse(rawMessage as string) as OutboundMessage)
      })
    })

    const user = userEvent.setup()
    render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'gpu_assigned',
      gpu_id: 0,
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_stream_start',
      total_segments: 2,
      loop_generation_enabled: false,
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'segment one',
      source: 'curated',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([1, 2, 3]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'segment two',
      source: 'curated',
      seed_prompt_index: 1,
    }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Rewrite rollout' })).toBeEnabled()
    })

    const continuationInput = await screen.findByLabelText('Continuation prompt')
    await user.type(continuationInput, 'Restart from a stormy street chase')
    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))

    await waitFor(() => {
      expect(outbound.some(message => message.type === 'rewrite_seed_prompts')).toBe(true)
    })

    const livePipeline: unknown = vi.mocked(createAvPipeline).mock.results[0]?.value
    expect(livePipeline).toBeTruthy()
    const resetLivePipeline = typeof livePipeline === 'object' && livePipeline !== null && 'reset' in livePipeline
      ? livePipeline.reset
      : undefined
    if (!vi.isMockFunction(resetLivePipeline)) throw new Error('Expected the mocked live pipeline to record reset calls')
    const resetsBeforeRestart = resetLivePipeline.mock.calls.length

    connectedSocket(clientSocket).send(JSON.stringify({ type: 'rewrite_seed_prompts_started' }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'seed_prompts_updated',
      reason: 'rewrite',
      prompts: [
        'Restart from a stormy street chase',
        'The chase cuts through a wet neon alley',
      ],
    }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'rewrite_seed_prompts_complete' }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'seed_prompts_reset_applied',
      reason: 'rewrite_during_generation',
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_stream_start',
      total_segments: 2,
      loop_generation_enabled: false,
    }))

    await waitFor(() => {
      expect(resetLivePipeline.mock.calls.length).toBeGreaterThan(resetsBeforeRestart)
    })
  })

  it('switches the stage to the archived final clip when segment cap is reached', async () => {
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
    })

    const user = userEvent.setup()
    const { container } = render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 1,
      prompt: 'segment one',
      source: 'curated',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([1, 2, 3]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    expect(screen.queryByText(/Reached max number of segments supported/i)).not.toBeInTheDocument()
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'generation_cap_reached',
      cap_segments: 1,
      generated_segments: 1,
      message: 'Reached max number of segments supported (1). Click Restart to continue.',
    }))

    await waitFor(() => {
      expect(container.querySelectorAll('.gallery-card')).toHaveLength(1)
    })

    expect(container.querySelector('.stage-copy h2')?.textContent).toBe('Test Preset')
    expect(container.querySelector('.gallery-card.is-active')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Reached max number of segments supported/i)).not.toBeInTheDocument()
  })

  it('replays completed 30s video replies from the archived blob when available', async () => {
    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
    })

    const user = userEvent.setup()
    const { container } = render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'segment one',
      source: 'curated',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([1, 2, 3]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'segment two',
      source: 'curated',
      seed_prompt_index: 1,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([4, 5, 6]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 2 }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'ltx2_stream_complete' }))

    await waitFor(() => {
      expect(container.querySelectorAll('.gallery-card')).toHaveLength(1)
    })

    await user.click(screen.getByRole('button', { name: /Test Preset/i }))

    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:mock-url')
    })
  })

  it('keeps the archived rollout selected while the next rollout starts on Apple fallback', async () => {
    avPipelineMockState.useNativePlaybackFallback = true

    let clientSocket: Client | undefined
    server.on('connection', (socket) => {
      clientSocket = socket
    })

    const user = userEvent.setup()
    const { container } = render(<DreamverseApp renderSlot={renderDreamverseSlot} t={englishKitT} />)

    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(clientSocket).toBeTruthy()
    })

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'gpu_assigned',
      gpu_id: 0,
    }))

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 1,
      total_segments: 2,
      prompt: 'segment one',
      source: 'curated',
      seed_prompt_index: 0,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([1, 2, 3]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 1 }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_segment_start',
      segment_idx: 2,
      total_segments: 2,
      prompt: 'segment two',
      source: 'curated',
      seed_prompt_index: 1,
    }))
    connectedSocket(clientSocket).send(new Uint8Array([4, 5, 6]).buffer)
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'media_segment_complete', segment_idx: 2 }))
    connectedSocket(clientSocket).send(JSON.stringify({ type: 'ltx2_stream_complete' }))

    await waitFor(() => {
      expect(container.querySelector('.gallery-card.is-active')).not.toBeNull()
    })
    expect(container.querySelector('.stage-copy h2')?.textContent).toBe('Test Preset')

    const promptInput = await screen.findByLabelText('Continuation prompt')
    await user.type(promptInput, 'The hero escapes into the rain')
    await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))

    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'rewrite_seed_prompts_started',
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'ltx2_stream_start',
      total_segments: 2,
      loop_generation_enabled: false,
    }))
    connectedSocket(clientSocket).send(JSON.stringify({
      type: 'media_init',
      mime: 'video/mp4',
      stream_id: 'rewrite_stream',
    }))

    await waitFor(() => {
      expect(container.querySelector('.gallery-card.is-active')).not.toBeNull()
    })
    expect(container.querySelector('.stage-copy h2')?.textContent).toBe('Test Preset')
  })

})
