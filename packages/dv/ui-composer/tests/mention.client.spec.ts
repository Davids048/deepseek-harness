// @vitest-environment jsdom
/** The `@` source's chip serialization when a message is sent: an asset chip places the asset on the canvas. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishCurrentProject } from '@dv/ui-kit/current-project.ts'
import { projectMentionSource, referenceText } from '../src/client/mention.ts'

afterEach(() => { vi.unstubAllGlobals(); publishCurrentProject(null) })

describe('projectMentionSource codec', () => {
  it('places a referenced asset on the open project\'s canvas and sends the chip text unchanged', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      calls.push({ url: input, body: JSON.parse(String(init?.body)) })
      return Promise.resolve(new Response('{}'))
    })
    publishCurrentProject('p1')
    const { codec } = projectMentionSource()
    if (codec === undefined) throw new Error('the source has no codec')
    const asset = referenceText('hero.png', 'dv:asset/a%2B1')
    const character = referenceText('Hero', 'dv:character/hero')
    expect(await codec.serialize(asset, new AbortController().signal)).toBe(asset)
    expect(await codec.serialize(character, new AbortController().signal)).toBe(character)
    expect(calls).toEqual([{ url: '/api/dv/layout', body: { project: 'p1', placed: ['a+1'] } }])
  })
})
