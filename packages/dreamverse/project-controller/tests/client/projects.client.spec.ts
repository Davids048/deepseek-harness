/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteProject, fetchSegmentVideo, getProject, listProjects } from '../../src/client/projects.ts'

const summary = {
  project_id: 'p-1', title: 'River story', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z',
  thumbnail_url: '/projects/p-1/segments/s-2/frame', round_count: 1,
}
const detail = {
  project_id: 'p-1', title: 'River story', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z',
  open: false,
  creation_config: { model_id: 'fast-h3', generation_mode: 'ref2va', aspect_ratio: '16:9', resolution: '720p', segment_count: 2, segment_duration_sec: 5 },
  rounds: [{
    round_index: 0, instruction: null,
    segments: [{ segment_id: 's-1', prompt: 'A river', mime: 'video/mp4', video_url: '/projects/p-1/segments/s-1/video', frame_url: '/projects/p-1/segments/s-1/frame' }],
  }],
}

/** Serve one fixed response to every request and record the requests. */
function serve(response: Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('harness project client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the project list and one project with its rounds', async () => {
    serve(new Response(JSON.stringify({ projects: [summary, { ...summary, project_id: 'p-2', thumbnail_url: null }] })))
    expect(await listProjects()).toEqual([summary, { ...summary, project_id: 'p-2', thumbnail_url: null }])
    const fetchMock = serve(new Response(JSON.stringify(detail)))
    expect(await getProject('p/1')).toEqual(detail)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/projects/p%2F1')
  })

  it('rejects a response whose project fields are missing or mistyped', async () => {
    serve(new Response(JSON.stringify({ projects: [{ ...summary, round_count: '1' }] })))
    await expect(listProjects()).rejects.toThrow('The project list response contains an invalid project.')
    serve(new Response(JSON.stringify({ ...detail, rounds: [{ ...detail.rounds[0], segments: [{ segment_id: 's-1' }] }] })))
    await expect(getProject('p-1')).rejects.toThrow('The project response is invalid.')
  })

  it('reports the harness detail when a request is refused', async () => {
    const fetchMock = serve(new Response(JSON.stringify({ detail: 'This project is open. Close it before deleting.' }), { status: 409 }))
    await expect(deleteProject('p-1')).rejects.toThrow('This project is open. Close it before deleting.')
    expect(fetchMock.mock.calls[0]).toEqual(['/projects/p-1', { method: 'DELETE' }])
    serve(new Response('not json', { status: 404 }))
    await expect(fetchSegmentVideo('/projects/p-1/segments/s-9/video')).rejects.toThrow('Project request failed (404).')
  })

  it('downloads one segment video as bytes', async () => {
    serve(new Response(new Uint8Array([1, 2, 3])))
    expect([...new Uint8Array(await fetchSegmentVideo('/projects/p-1/segments/s-1/video'))]).toEqual([1, 2, 3])
  })
})
