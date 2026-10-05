import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import VhAssets, { AssetNotFoundError, assetIdOf, type AssetId, type OpId } from '../src/index.ts'

/** A stand-in for the DSH web server that keeps the registered prefix routes and serves them on a local port. */
class FakeWebServer {
  readonly routes = new Map<string, WebRoute>()
  server: Server | null = null

  register(route: WebRoute): () => void {
    this.routes.set(route.path, route)
    return () => { this.routes.delete(route.path) }
  }

  async listen(): Promise<string> {
    this.server = createServer((request, response) => {
      const route = [...this.routes.values()].find(candidate => (request.url ?? '').startsWith(candidate.path))
      if (route === undefined) response.writeHead(404).end()
      else void route.handler(request, response)
    })
    await new Promise<void>((resolve) => { this.server?.listen(0, '127.0.0.1', resolve) })
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => { this.server?.close(() => { resolve() }) })
  }
}

const roots: string[] = []
const contexts: Context[] = []

interface Fixture { assets: VhAssets; root: string; web: FakeWebServer | null; context: Context }

async function start(options: { withWeb?: boolean; root?: string } = {}): Promise<Fixture> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'vh-assets-'))
  if (options.root === undefined) roots.push(root)
  const context = new Context()
  contexts.push(context)
  const web = options.withWeb === true ? new FakeWebServer() : null
  if (web !== null) context.provide('webServer', web)
  await context.plugin(VhAssets, { root }).await()
  return { assets: context.vhAssets, root, web, context }
}

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('vhAssets', () => {
  it('stores bytes under their hash and dedupes identical content', async () => {
    const { assets } = await start()
    const bytes = Buffer.from('hello')
    const first = assets.put(bytes, { mime: 'text/plain', name: 'a.txt' })
    const second = assets.put(Buffer.from('hello'), { mime: 'text/plain', name: 'b.txt' })
    expect(first).toBe(assetIdOf(bytes))
    expect(second).toBe(first)
    expect(assets.get(first).name).toBe('a.txt')
    expect(assets.has(first)).toBe(true)
    expect(assets.read(first).toString()).toBe('hello')
    expect(assets.list()).toHaveLength(1)
  })

  it('copies a file in and records who produced it', async () => {
    const { assets, root } = await start()
    const path = join(root, 'frame.png')
    writeFileSync(path, 'png bytes')
    const producedBy = brandString<OpId>('op-1')
    const id = assets.put({ path }, { mime: 'image/png', producedBy, width: 16, height: 9, durationSec: null })
    const meta = assets.get(id)
    expect(meta).toMatchObject({ mime: 'image/png', producedBy, width: 16, height: 9, sizeBytes: 9, durationSec: null })
    expect(meta.name).toBe(id)
    expect(assets.path(id).endsWith(id)).toBe(true)
  })

  it('throws for unknown ids', async () => {
    const { assets } = await start()
    const missing = brandString<AssetId>('0'.repeat(64))
    expect(() => assets.get(missing)).toThrow(AssetNotFoundError)
    expect(() => assets.path(missing)).toThrow(AssetNotFoundError)
    expect(assets.has(missing)).toBe(false)
  })

  it('replays the index after a restart and skips records whose object is gone', async () => {
    const first = await start()
    const kept = first.assets.put(Buffer.from('kept'), { mime: 'text/plain' })
    const lost = first.assets.put(Buffer.from('lost'), { mime: 'text/plain' })
    await first.context.fiber.dispose()
    rmSync(join(first.root, 'objects', lost))
    const second = await start({ root: first.root })
    expect(second.assets.has(kept)).toBe(true)
    expect(second.assets.has(lost)).toBe(false)
    expect(second.assets.list().map(meta => meta.id)).toEqual([kept])
  })

  it('serves content on /vh/assets/<id>/content when a web server exists', async () => {
    const { assets, web, context } = await start({ withWeb: true })
    const id = assets.put(Buffer.from('<svg/>'), { mime: 'image/svg+xml' })
    const base = await (web as FakeWebServer).listen()
    try {
      const ok = await fetch(`${base}/vh/assets/${id}/content`)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toBe('image/svg+xml')
      expect(await ok.text()).toBe('<svg/>')
      const missing = await fetch(`${base}/vh/assets/${'0'.repeat(64)}/content`)
      expect(missing.status).toBe(404)
      const badPath = await fetch(`${base}/vh/assets/list`)
      expect(badPath.status).toBe(404)
      const post = await fetch(`${base}/vh/assets/${id}/content`, { method: 'POST' })
      expect(post.status).toBe(404)
    } finally {
      await (web as FakeWebServer).close()
    }
    await context.fiber.dispose()
    expect((web as FakeWebServer).routes.size).toBe(0)
  })
})
