/**
 * The video harness media store as the `vhAssets` Cordis service: every image, video, audio, and text artifact that
 * the harness produces or receives, addressed by the SHA-256 of its bytes and never modified after it is written.
 *
 * Layout under the configured root:
 *
 * ```
 * <root>/objects/<sha256>     the bytes, written once
 * <root>/index.jsonl          one JSON line per stored asset, appended on `put`, replayed at start
 * ```
 *
 * Two identical files become one asset. Each record remembers which operation produced the bytes (`producedBy`), so
 * the operation log can trace every file back to the tool call that made it. While the DSH web server is available,
 * the service serves `GET /vh/assets/<id>/content`.
 *
 * @module @video-harness/assets
 */
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The content-addressed media store of the video harness. */
    vhAssets: VhAssets
  }
}

/** The SHA-256 hex digest of an asset's bytes, which is also its file name under `objects/`. */
export type AssetId = Branded<'VhAssetId'>

/** The ID of the record that produced an asset: a `@dv/project` `RecordId`, which `dvProject` rebrands when it stores the asset. */
export type OpId = Branded<'VhOpId'>

/** What the store knows about one asset. */
export interface AssetMeta {
  readonly id: AssetId
  readonly mime: string
  /** A display name, such as the uploaded file name or `shot-2.mp4`. */
  readonly name: string
  readonly sizeBytes: number
  /** The operation that produced the bytes, or null for an upload that no operation recorded. */
  readonly producedBy: OpId | null
  /** ISO-8601 UTC of the first `put`. */
  readonly createdAt: string
  /** Pixel width when the caller knew it, else null; the store never decodes media. */
  readonly width: number | null
  readonly height: number | null
  readonly durationSec: number | null
}

/** The caller-supplied part of an asset record. */
export interface PutOptions {
  mime: string
  name?: string
  producedBy?: OpId | null
  width?: number | null
  height?: number | null
  durationSec?: number | null
}

/** Thrown by `get` and `path` for an ID the store does not hold. */
export class AssetNotFoundError extends Error {
  /** @param id - the requested asset. */
  constructor(id: string) {
    super(`Asset '${id}' not found.`)
    this.name = 'AssetNotFoundError'
  }
}

/** `vhAssets` plugin configuration. */
export interface Config {
  /** The directory holding `objects/` and `index.jsonl`; created when missing. */
  root: string
}

/** Loader validation; `root` is required. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})

const INDEX_FILE = 'index.jsonl'
const OBJECTS_DIR = 'objects'
const CONTENT_ROUTE = /^\/vh\/assets\/([0-9a-f]{64})\/content$/

/**
 * Hash bytes the way the store names them.
 * @param bytes - the complete content.
 * @returns the lowercase SHA-256 hex digest.
 */
export function assetIdOf(bytes: Uint8Array): AssetId {
  return brandString<AssetId>(createHash('sha256').update(bytes).digest('hex'))
}

/** Content-addressed store of immutable media, replayed from `index.jsonl` at start. */
export default class VhAssets extends Service {
  static Config = Config

  private readonly root: string
  private readonly records = new Map<AssetId, AssetMeta>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'vhAssets')
    this.root = config.root
    mkdirSync(join(this.root, OBJECTS_DIR), { recursive: true })
    this.replayIndex()
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: '/vh/assets',
        handler: (request, response) => { this.serveContent(request, response) },
      }), 'video-harness /vh/assets route')
    })
  }

  /**
   * Store bytes, or a file's bytes, once; a second `put` of identical content returns the existing ID and keeps the
   * first record.
   * @param source - the bytes, or the path of a file to copy in.
   * @param options - MIME type, display name, producing operation, and dimensions when known.
   * @returns the asset ID.
   */
  put(source: Uint8Array | { path: string }, options: PutOptions): AssetId {
    const bytes = source instanceof Uint8Array ? source : readFileSync(source.path)
    const id = assetIdOf(bytes)
    if (this.records.has(id)) return id
    const objectPath = join(this.root, OBJECTS_DIR, id)
    // Write beside the final name and rename, so a crash never leaves a half-written object under its hash.
    const partial = `${objectPath}.partial`
    writeFileSync(partial, bytes)
    renameSync(partial, objectPath)
    const meta: AssetMeta = {
      id,
      mime: options.mime,
      name: options.name ?? id,
      sizeBytes: bytes.byteLength,
      producedBy: options.producedBy ?? null,
      createdAt: new Date().toISOString(),
      width: options.width ?? null,
      height: options.height ?? null,
      durationSec: options.durationSec ?? null,
    }
    appendFileSync(join(this.root, INDEX_FILE), `${JSON.stringify(meta)}\n`)
    this.records.set(id, meta)
    return id
  }

  /**
   * @param id - an asset ID.
   * @returns whether the store holds it.
   */
  has(id: AssetId): boolean {
    return this.records.has(id)
  }

  /**
   * @param id - an asset ID.
   * @returns the record.
   * @throws AssetNotFoundError for an unknown ID.
   */
  get(id: AssetId): AssetMeta {
    const meta = this.records.get(id)
    if (meta === undefined) throw new AssetNotFoundError(id)
    return meta
  }

  /**
   * @param id - an asset ID.
   * @returns the absolute path of the stored bytes.
   * @throws AssetNotFoundError for an unknown ID.
   */
  path(id: AssetId): string {
    this.get(id)
    return join(this.root, OBJECTS_DIR, id)
  }

  /**
   * @param id - an asset ID.
   * @returns the stored bytes.
   */
  read(id: AssetId): Buffer {
    return readFileSync(this.path(id))
  }

  /** @returns every record, oldest first. */
  list(): AssetMeta[] {
    return [...this.records.values()]
  }

  /** Rebuild the in-memory index from `index.jsonl`; a line whose object file is missing is skipped. */
  private replayIndex(): void {
    const indexPath = join(this.root, INDEX_FILE)
    if (!existsSync(indexPath)) return
    for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const meta = JSON.parse(line) as AssetMeta
      if (existsSync(join(this.root, OBJECTS_DIR, meta.id))) this.records.set(meta.id, meta)
    }
  }

  /**
   * Answer `GET /vh/assets/<id>/content` with the whole file and its MIME type; other paths under the prefix are 404.
   */
  private serveContent(request: IncomingMessage, response: ServerResponse): void {
    /* v8 ignore next -- Node sets `url` on every request it parses. */
    const url = new URL(request.url ?? '/', 'http://localhost')
    const match = CONTENT_ROUTE.exec(url.pathname)
    const id = match === null ? null : brandString<AssetId>(String(match[1]))
    if (request.method !== 'GET' || id === null || !this.records.has(id)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    const meta = this.get(id)
    const filePath = this.path(id)
    response.writeHead(200, {
      'content-type': meta.mime,
      'content-length': String(statSync(filePath).size),
      'cache-control': 'public, max-age=31536000, immutable',
    })
    createReadStream(filePath).pipe(response)
  }
}
