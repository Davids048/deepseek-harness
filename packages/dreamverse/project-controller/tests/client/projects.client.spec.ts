/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteProject, fetchSegmentVideo, getProject, listProjects } from '../../src/client/projects.ts'

const summary = {
  project_id: 'p-1', title: 'River story', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z',
  thumbnail_url: '/assets/f-4/content',
}
const creationConfig = {
  model_id: 'fast-h3', generation_mode: 'ref2va', aspect_ratio: '16:9', resolution: '720p', segment_count: 2, segment_duration_sec: 5,
}

/**
 * A stored segment of the DreamVerse workload data.
 * @param segmentId - the segment ID.
 * @param fields - fields that replace the completed defaults.
 * @returns the segment.
 */
function storedSegment(segmentId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    segment_id: segmentId, prompt: `Prompt ${segmentId}`, source: 'preset', instruction: null, enhanced: false,
    sequence_index: null, reference_segment_id: null, reference_asset_ids: [], status: 'completed', error: null,
    mime: 'video/mp4', created_at: '2026-10-01T10:00:00Z', video_asset_id: null, last_frame_asset_id: null, ...fields,
  }
}

/** `GET /projects/p-1` of the project store: two completed rounds, the second continuing the first, and a failed segment. */
const storedProject = {
  ...summary, kind: 'dreamverse', held: false,
  workload: { schema_version: 1, data: {
    creation_config: { ...creationConfig, frame_width: 1344, frame_height: 768, num_frames: 124 },
    prompt_enhancement_enabled: false, prompt_sequence_id: null, prompt_sequence_label: '',
    segments: [
      storedSegment('s-1', { instruction: { request_id: 'r-1', text: 'A river' }, video_asset_id: 'f-1' }),
      storedSegment('s-2', { instruction: { request_id: 'r-2', text: 'It falls' }, video_asset_id: 'f-3', last_frame_asset_id: 'f-4' }),
      storedSegment('s-3', { status: 'failed', mime: null }),
    ],
    completed_sequences: [['s-1'], ['s-1', 's-2', 's-3']],
    reference_copies: {},
  } },
  assets: ['f-1', 'f-3', 'f-4'].map(assetId => ({ asset_id: assetId, content_url: `/assets/${assetId}/content` })),
}

/** Serve one fixed response to every request and record the requests. */
function serve(response: Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('stored project client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the DreamVerse projects', async () => {
    const fetchMock = serve(new Response(JSON.stringify({ projects: [
      { ...summary, kind: 'dreamverse' }, { ...summary, kind: 'dreamverse', project_id: 'p-2', thumbnail_url: null },
    ] })))
    expect(await listProjects()).toEqual([summary, { ...summary, project_id: 'p-2', thumbnail_url: null }])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/projects?kind=dreamverse')
  })

  it('rebuilds a project\'s completed rounds from its workload data and its files', async () => {
    const fetchMock = serve(new Response(JSON.stringify(storedProject)))
    const first = { segment_id: 's-1', prompt: 'Prompt s-1', mime: 'video/mp4', video_url: '/assets/f-1/content', frame_url: null }
    expect(await getProject('p/1')).toEqual({
      project_id: 'p-1', title: 'River story', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z',
      open: false, creation_config: creationConfig,
      rounds: [
        { round_index: 0, instruction: 'A river', segments: [first] },
        { round_index: 1, instruction: 'It falls', segments: [first, {
          segment_id: 's-2', prompt: 'Prompt s-2', mime: 'video/mp4', video_url: '/assets/f-3/content',
          frame_url: '/assets/f-4/content',
        }] },
      ],
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/projects/p%2F1')
  })

  it('rejects a response whose project fields are missing or mistyped, or that is not a DreamVerse project', async () => {
    serve(new Response(JSON.stringify({ projects: [{ ...summary, title: 1 }] })))
    await expect(listProjects()).rejects.toThrow('The project list response contains an invalid project.')
    const { data } = storedProject.workload
    for (const project of [
      { ...storedProject, kind: 'multiverse' },
      { ...storedProject, workload: { schema_version: 2, data } },
      { ...storedProject, workload: { schema_version: 1, data: { ...data, segments: [{ segment_id: 's-1' }] } } },
      { ...storedProject, workload: { schema_version: 1, data: { ...data, completed_sequences: [['s-9']] } } },
    ]) {
      serve(new Response(JSON.stringify(project)))
      await expect(getProject('p-1')).rejects.toThrow('The project response is invalid.')
    }
  })

  it('reports the store\'s detail when a request is refused', async () => {
    const fetchMock = serve(new Response(JSON.stringify({ detail: 'This project is open. Close it before deleting.' }), { status: 409 }))
    await expect(deleteProject('p-1')).rejects.toThrow('This project is open. Close it before deleting.')
    expect(fetchMock.mock.calls[0]).toEqual(['/projects/p-1', { method: 'DELETE' }])
    serve(new Response('not json', { status: 404 }))
    await expect(fetchSegmentVideo('/assets/f-9/content')).rejects.toThrow('Project request failed (404).')
  })

  it('downloads one segment video as bytes', async () => {
    serve(new Response(new Uint8Array([1, 2, 3])))
    expect([...new Uint8Array(await fetchSegmentVideo('/assets/f-1/content'))]).toEqual([1, 2, 3])
  })
})
