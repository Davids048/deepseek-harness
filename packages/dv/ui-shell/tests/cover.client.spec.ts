// @vitest-environment jsdom
/** Project card summaries: one `/api/dv/projects/summary` read for every card, and the card duration text. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { clockText } from '@dv/ui-canvas/src/client/NodeCard.tsx'
import { useProjectSummaries } from '../src/client/cover.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** Two project summaries as the route answers them. */
const SUMMARIES = [
  { project: 'p1', cover: { video: 'shot1.mp4', image: 'shot1-last.png' }, shots: 2, duration_sec: 59.5, edited_at: '2026-10-05T00:00:00Z' },
  { project: 'p2', cover: null, shots: 0, duration_sec: 0, edited_at: null },
]

describe('useProjectSummaries', () => {
  it('reads every summary in one request, and reads again only when the refresh value changes', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(SUMMARIES))))
    vi.stubGlobal('fetch', fetchSpy)
    const { result, rerender } = renderHook(({ refresh }) => useProjectSummaries(null, refresh), { initialProps: { refresh: 'p1 p2' } })
    await waitFor(() => { expect(result.current?.get('p1')?.cover).toEqual({ video: 'shot1.mp4', image: 'shot1-last.png' }) })
    expect(result.current?.get('p2')).toEqual(SUMMARIES[1])
    rerender({ refresh: 'p1 p2' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    rerender({ refresh: 'p1 p2 p3' })
    await waitFor(() => { expect(fetchSpy).toHaveBeenCalledTimes(2) })
    expect(fetchSpy.mock.calls.map(call => call[0])).toEqual(['/api/dv/projects/summary', '/api/dv/projects/summary'])
  })

  it('asks for one project\'s summary when it names the project', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(SUMMARIES.slice(0, 1)))))
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() => useProjectSummaries('p1', null))
    await waitFor(() => { expect(result.current?.get('p1')?.shots).toBe(2) })
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/dv/projects/summary?project=p1')
  })
})

describe('card duration', () => {
  it('rounds the total seconds before splitting minutes and seconds', () => {
    expect(clockText(59.5)).toBe('1:00')
    expect(clockText(59.4)).toBe('0:59')
    expect(clockText(125)).toBe('2:05')
  })
})
