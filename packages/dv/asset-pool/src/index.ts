/**
 * The Asset pool component of DreamVerse as the `dvAssetPool` Cordis service: every image, video, audio and text file
 * of a project, addressed by the SHA-256 of its bytes and never changed after it is written.
 *
 * Layout under the configured root:
 *
 * ```
 * <root>/objects/<sha256>     the bytes, written once
 * <root>/index.jsonl          one `Asset` line per asset, appended on import, replayed at start
 * ```
 *
 * Two identical files become one asset. The service registers itself as Project's asset store, and four operations:
 * - `asset.import`: a file on this machine, or base64 bytes, becomes an asset; with `place`, it also goes on the canvas;
 *   an image or video gets its pixel size and duration from `dvFfmpeg` the first time a record imports it;
 * - `asset.grab_still`: one frame of a video becomes a PNG still, through `dvFfmpeg`;
 * - `asset.place` and `asset.unplace`: assets go on the canvas or come off it, and stay in the pool either way.
 *
 * `dvProject` turns each operation into its agent tool (`dv_asset_import`, `dv_asset_grab_still`, `dv_asset_place`,
 * `dv_asset_unplace`). The `asset` reducer keeps the canvas placements of the state; the `proj` slice's `created_by` names
 * the record that created each asset. While the DSH web server is mounted, the service serves `GET /dv/assets/<AssetId>`.
 *
 * @module @dv/asset-pool
 */
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { FfmpegError } from '@dv/ffmpeg'
import type {} from '@dv/ffmpeg'
import { ProjectError, type AssetId, type OperationContext, type OperationResult, type OperationSpec, type RecordId } from '@dv/project'
import { assetReducer } from './reducer.ts'
import type { Asset, StillAt } from './types.ts'

export type { Asset, AssetState } from './types.ts'
/** The SHA-256 hex digest of an asset's bytes; defined by `@dv/project`. */
export type { AssetId } from '@dv/project'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Asset pool component: the content-addressed asset store and its operations. */
    dvAssetPool: DvAssetPool
  }
}

/** `dvAssetPool` plugin configuration. */
export interface Config {
  /** The directory holding `objects/` and `index.jsonl`; created when missing. */
  root: string
  /** Base of the asset URLs that the agent and chat cards show, such as a tunnel origin; empty keeps them relative. */
  publicBaseUrl: string
}

/** Loader validation; `root` is required. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  publicBaseUrl: z.string().default(''),
})

const INDEX_FILE = 'index.jsonl'
const OBJECTS_DIR = 'objects'
const ROUTE_PREFIX = '/dv/assets'
const FILE_ROUTE = /^\/dv\/assets\/([0-9a-f]{64})$/
/** The file name of a grabbed still inside the operation's scratch directory. */
const STILL_FILE = 'still.png'

/** What `importAsset` takes besides the bytes: the media type, the display name, and what the importer knows. */
type ImportMeta = Parameters<OperationContext['importAsset']>[1]

/**
 * The still position a caller asked for: `first`, `last`, a number of seconds, or a numeric string; anything else
 * means the last frame.
 * @param value - the raw `at` param.
 * @returns the position.
 */
function stillAt(value: unknown): StillAt {
  if (value === 'first' || value === 'last') return value
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string') {
    const seconds = Number(value.trim())
    if (value.trim().length > 0 && Number.isFinite(seconds) && seconds >= 0) return seconds
  }
  return 'last'
}

/**
 * The ffmpeg command lines that read a video's last frame, in the order to try them: an input seek just before the
 * video stream's end, then a full decode where every frame overwrites the output so the last one survives. The seek
 * uses the video stream's duration because rendered takes carry an audio track that runs past the last video frame,
 * and a seek relative to the container duration lands after it and writes nothing.
 * @param videoDurationSec - the video stream's duration, or null when ffprobe reported none.
 * @returns the argument lists, each with `{{in:0}}` and `{{out:still.png}}` placeholders.
 */
function lastFrameAttempts(videoDurationSec: number | null): string[][] {
  const out = `{{out:${STILL_FILE}}}`
  const attempts: string[][] = []
  if (videoDurationSec !== null && Number.isFinite(videoDurationSec) && videoDurationSec > 0) {
    attempts.push(['ffmpeg', '-y', '-loglevel', 'error', '-ss', String(Math.max(0, videoDurationSec - 0.1)), '-i', '{{in:0}}', '-update', '1', out])
  }
  attempts.push(['ffmpeg', '-y', '-loglevel', 'error', '-i', '{{in:0}}', '-an', '-update', '1', out])
  return attempts
}

/**
 * A params field as text, or the fallback when it is absent or not a string.
 * @param value - the field.
 * @param fallback - the text for anything else.
 * @returns the text.
 */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** The content-addressed asset store, its route, its operations, and the canvas placements. */
export default class DvAssetPool extends Service {
  static inject = ['dvProject', 'dvFfmpeg']
  static Config = Config

  private readonly assets = new Map<AssetId, Asset>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'dvAssetPool')
    mkdirSync(join(config.root, OBJECTS_DIR), { recursive: true })
    this.replayIndex()
    // Project checks input assets, imports operation outputs, and describes outputs to the agent through the pool.
    ctx.effect(() => ctx.dvProject.registerAssetStore({
      has: asset => this.has(asset),
      get: asset => this.get(asset),
      read: asset => this.read(asset),
      url: asset => this.url(asset),
      importAsset: (source, meta, createdBy) => this.importAsset(source, meta, createdBy),
    }), 'dvAssetPool asset store')
    ctx.effect(() => ctx.dvProject.registerReducer('asset', assetReducer), 'dvAssetPool reducer')
    for (const spec of [this.importOperation(), this.grabStillOperation(), this.placementOperation('asset.place'), this.placementOperation('asset.unplace')]) {
      ctx.effect(() => ctx.dvProject.registerOperation(spec), `dvAssetPool ${spec.name}`)
    }
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (request, response) => { this.serveFile(request, response) },
      }), 'dvAssetPool /dv/assets route')
    })
  }

  /**
   * Store bytes, or a file's bytes, once; importing identical content again returns the existing ID and keeps the
   * first asset's name and creator.
   * @param source - the bytes, or the path of a file to copy in.
   * @param meta - the media type, the display name, and the duration and pixel size when known.
   * @param createdBy - the record that created the asset; null outside any record.
   * @returns the asset ID.
   */
  importAsset(source: Uint8Array | { path: string }, meta: ImportMeta, createdBy: RecordId | null): AssetId {
    const bytes = source instanceof Uint8Array ? source : readFileSync(source.path)
    const id = brandString<AssetId>(createHash('sha256').update(bytes).digest('hex'))
    if (this.assets.has(id)) return id
    const objectPath = join(this.config.root, OBJECTS_DIR, id)
    // Write beside the final name and rename, so a crash never leaves a half-written object under its hash.
    const partial = `${objectPath}.partial`
    writeFileSync(partial, bytes)
    renameSync(partial, objectPath)
    const asset: Asset = {
      id,
      mime: meta.mime,
      name: meta.name,
      size_bytes: bytes.byteLength,
      created_by: createdBy,
      created_at: new Date().toISOString(),
      width: meta.width ?? null,
      height: meta.height ?? null,
      duration_sec: meta.durationSec ?? null,
    }
    appendFileSync(join(this.config.root, INDEX_FILE), `${JSON.stringify(asset)}\n`)
    this.assets.set(id, asset)
    return id
  }

  /**
   * Fill the media facts an asset entry does not know yet: append the updated entry to `index.jsonl` (the last line of
   * an ID wins at replay) and keep it in memory. Facts the entry already holds stay as they are.
   * @param id - an asset the pool holds.
   * @param media - the pixel size and the duration, each null when unknown.
   * @returns the entry after the change. Throws `unknown_asset`.
   */
  describe(id: AssetId, media: { width: number | null; height: number | null; durationSec: number | null }): Asset {
    const current = this.get(id)
    const next: Asset = {
      ...current,
      width: current.width ?? media.width,
      height: current.height ?? media.height,
      duration_sec: current.duration_sec ?? media.durationSec,
    }
    if (next.width === current.width && next.height === current.height && next.duration_sec === current.duration_sec) return current
    appendFileSync(join(this.config.root, INDEX_FILE), `${JSON.stringify(next)}\n`)
    this.assets.set(id, next)
    return next
  }

  /**
   * @param asset - an asset ID.
   * @returns whether the pool holds it.
   */
  has(asset: AssetId): boolean {
    return this.assets.has(asset)
  }

  /**
   * @param asset - an asset ID.
   * @returns the asset.
   * @throws ProjectError `unknown_asset` for an asset the pool does not hold.
   */
  get(asset: AssetId): Asset {
    const found = this.assets.get(asset)
    if (found === undefined) throw new ProjectError('unknown_asset', `Asset '${asset}' is not in the asset pool.`)
    return found
  }

  /**
   * @param asset - an asset ID.
   * @returns the absolute path of the stored bytes.
   * @throws ProjectError `unknown_asset` for an asset the pool does not hold.
   */
  path(asset: AssetId): string {
    this.get(asset)
    return join(this.config.root, OBJECTS_DIR, asset)
  }

  /**
   * @param asset - an asset ID.
   * @returns the stored bytes.
   * @throws ProjectError `unknown_asset` for an asset the pool does not hold.
   */
  read(asset: AssetId): Buffer {
    return readFileSync(this.path(asset))
  }

  /**
   * @param asset - an asset ID.
   * @returns the URL of its bytes under the configured public base.
   */
  url(asset: AssetId): string {
    return `${this.config.publicBaseUrl.replace(/\/+$/, '')}${ROUTE_PREFIX}/${asset}`
  }

  /** @returns every asset, oldest first. */
  list(): Asset[] {
    return [...this.assets.values()]
  }

  /**
   * Write one frame of a video as a PNG file into a directory; the caller imports it.
   * @param video - a video asset.
   * @param at - the first frame, the last frame, or a time in seconds.
   * @param dir - an existing directory, such as an operation's `scratchDir`.
   * @returns the absolute path of the PNG.
   * @throws FfmpegError when ffmpeg cannot read the video or writes no frame.
   */
  async grabStill(video: AssetId, at: StillAt, dir: string): Promise<string> {
    const input = this.path(video)
    const ffmpeg = this.ctx.dvFfmpeg
    if (at !== 'last') {
      const seek = at === 'first' ? [] : ['-ss', String(at)]
      const argv = ['ffmpeg', '-y', '-loglevel', 'error', ...seek, '-i', '{{in:0}}', '-frames:v', '1', `{{out:${STILL_FILE}}}`]
      return (await ffmpeg.run({ argv, inputs: [input], outputs: [STILL_FILE], dir })).outputs[0] as string
    }
    // A fragmented MP4 from a streaming backend has no reliable duration in its header, so each attempt is tried in
    // turn until one writes a frame.
    const probed = await ffmpeg.probe(input)
    let failure = new FfmpegError('No attempt to read the last frame ran.', '')
    for (const argv of lastFrameAttempts(probed.videoDurationSec ?? probed.durationSec)) {
      try {
        return (await ffmpeg.run({ argv, inputs: [input], outputs: [STILL_FILE], dir })).outputs[0] as string
      } catch (error: unknown) {
        if (!(error instanceof FfmpegError)) throw error
        failure = error
      }
    }
    throw failure
  }

  /** The `asset.import` operation. */
  private importOperation(): OperationSpec {
    return {
      name: 'asset.import',
      component: 'asset',
      version: '1',
      description: 'Bring a file into the asset pool: a path on this machine, or base64 bytes. Returns the asset ID to reference later.',
      inputs: {},
      params: {
        path: { type: 'string', description: 'Absolute path of the file to import.' },
        base64: { type: 'string', description: 'The file bytes as base64, when there is no path.' },
        mime: { type: 'string', required: true, description: 'Media type, such as image/png or video/mp4.' },
        name: { type: 'string', description: 'Display name; defaults to the file name.' },
        place: { type: 'boolean', description: 'Also put the asset on the canvas.' },
      },
      outputs: [{ role: 'asset', type: 'any' }],
      deterministic: true,
      resource: 'none',
      confirm: 'never',
      summarize: record => `imported ${text(record.params['name'], basename(text(record.params['path'], 'bytes')))}`,
      execute: async (context): Promise<OperationResult> => {
        const path = text(context.params['path'])
        const base64 = text(context.params['base64'])
        if (path === '' && base64 === '') throw new Error('asset.import needs `path` or `base64`.')
        const asset = context.importAsset(path === '' ? Buffer.from(base64, 'base64') : { path }, {
          mime: text(context.params['mime']),
          name: text(context.params['name'], path === '' ? 'imported' : basename(path)),
        })
        // The import route and chat images store the bytes before this record runs, so the probe runs here for them too.
        await this.probeMedia(asset)
        return { outputs: [asset] }
      },
    }
  }

  /**
   * The `asset.place` or `asset.unplace` operation: put assets on the canvas (an asset the project imported anywhere in
   * its history, or one a record of the current state made), or take assets off it. A call that changes nothing (every
   * asset already placed, or none of them placed) is refused before any record.
   * @param name - which of the two operations.
   * @returns the operation spec.
   */
  private placementOperation(name: 'asset.place' | 'asset.unplace'): OperationSpec {
    const place = name === 'asset.place'
    return {
      name,
      component: 'asset',
      version: '1',
      description: place
        ? 'Put assets of the project on the canvas, where the user sees each one as a node. An asset the project imported '
          + 'anywhere in its history can go on the canvas, and an asset a step of the current state made.'
        : 'Take assets off the canvas. The assets stay in the asset pool.',
      inputs: { asset: { type: 'any', required: true, many: true, description: place ? 'The assets to put on the canvas.' : 'The assets to take off the canvas.' } },
      params: {},
      outputs: [],
      deterministic: false,
      resource: 'none',
      confirm: 'never',
      summarize: record => `${place ? 'placed' : 'took off'} ${String(record.inputs.length)} asset(s) ${place ? 'on' : 'from'} the canvas`,
      precondition: (request, state): Promise<void> => {
        const assets = request.inputs.flatMap(input => input.role === 'asset' && 'asset' in input.ref ? [input.ref.asset] : [])
        const placed = new Set(state.components.asset.placed)
        if (place) {
          // Imported assets count from the whole history; generated assets only from the current state.
          const imported = new Set(this.ctx.dvProject.listRecords(request.project)
            .flatMap(record => record.operation === 'asset.import' && record.status === 'done' ? record.outputs : []))
          const missing = assets.filter(asset => !imported.has(asset) && !(asset in state.components.proj.created_by))
          if (missing.length > 0) {
            throw new ProjectError('invalid_inputs', `Asset ${missing.join(', ')} is neither an import of this project nor made by a step of its current state.`)
          }
          if (assets.every(asset => placed.has(asset))) throw new ProjectError('invalid_params', 'Every asset is already on the canvas.')
        } else if (!assets.some(asset => placed.has(asset))) {
          throw new ProjectError('invalid_params', 'None of the assets is on the canvas.')
        }
        return Promise.resolve()
      },
      execute: (): Promise<OperationResult> => Promise.resolve({ outputs: [] }),
    }
  }

  /**
   * Read the pixel size and duration of an image or video that the pool does not know yet, and store them with
   * {@link DvAssetPool.describe}. ffprobe reads the header; a video whose header has no duration (a WebM file that a
   * browser recorded) is decoded to measure it. A failure leaves the facts unknown and does not fail the import.
   * @param id - an asset the pool holds.
   */
  private async probeMedia(id: AssetId): Promise<void> {
    const asset = this.get(id)
    const video = asset.mime.startsWith('video/')
    if (!video && !asset.mime.startsWith('image/')) return
    if (asset.width !== null && asset.height !== null && (!video || asset.duration_sec !== null)) return
    try {
      const probed = await this.ctx.dvFfmpeg.probe(this.path(id))
      const durationSec = video ? probed.videoDurationSec ?? probed.durationSec ?? await this.decodedDuration(id) : null
      this.describe(id, { width: probed.width, height: probed.height, durationSec })
    } catch (error) {
      this.ctx.logger('dvAssetPool').warn('could not read the media facts of asset %s: %s', id, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Decode a video's first video stream and read the last progress time ffmpeg reports.
   * @param id - a video asset.
   * @returns the duration in seconds, or null when ffmpeg reports none.
   */
  private async decodedDuration(id: AssetId): Promise<number | null> {
    const result = await this.ctx.dvFfmpeg.run({
      argv: ['ffmpeg', '-v', 'error', '-i', '{{in:0}}', '-map', '0:v:0', '-f', 'null', '-progress', 'pipe:1', '-'],
      inputs: [this.path(id)], outputs: [], dir: tmpdir(),
    })
    const times = [...result.stdout.matchAll(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)$/gm)]
    const last = times.at(-1)
    if (last === undefined) return null
    const seconds = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null
  }

  /** The `asset.grab_still` operation. */
  private grabStillOperation(): OperationSpec {
    return {
      name: 'asset.grab_still',
      component: 'asset',
      version: '1',
      description: 'Grab one frame of a video as a PNG still, to look at it or to use it as a reference.',
      inputs: { video: { type: 'video', required: true, description: 'The video.' } },
      params: {
        at: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description: "'first', 'last', or a time in seconds (a number, or a numeric string such as '6.3'); default last.",
        },
      },
      outputs: [{ role: 'still', type: 'image' }],
      deterministic: true,
      resource: 'cpu',
      confirm: 'never',
      summarize: record => `still at ${String(stillAt(record.params['at']))}`,
      execute: async (context): Promise<OperationResult> => {
        const video = context.inputs.find(input => input.role === 'video')?.resolved_asset
        if (video === undefined || video === null) throw new Error('Input "video" is required.')
        const still = await this.grabStill(video, stillAt(context.params['at']), context.scratchDir)
        return { outputs: [context.importAsset({ path: still }, { mime: 'image/png', name: STILL_FILE })] }
      },
    }
  }

  /** Rebuild the in-memory index from `index.jsonl`; a line whose object file is missing is skipped. */
  private replayIndex(): void {
    const indexPath = join(this.config.root, INDEX_FILE)
    if (!existsSync(indexPath)) return
    for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const asset = JSON.parse(line) as Asset
      if (existsSync(join(this.config.root, OBJECTS_DIR, asset.id))) this.assets.set(asset.id, asset)
    }
  }

  /** Answer `GET /dv/assets/<AssetId>` with the whole file and its media type; other paths under the prefix are 404. */
  private serveFile(request: IncomingMessage, response: ServerResponse): void {
    /* v8 ignore next -- Node sets `url` on every request it parses. */
    const url = new URL(request.url ?? '/', 'http://localhost')
    const match = FILE_ROUTE.exec(url.pathname)
    const asset = match === null ? null : this.assets.get(brandString<AssetId>(String(match[1])))
    if (request.method !== 'GET' || asset === null || asset === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    const filePath = this.path(asset.id)
    response.writeHead(200, {
      'content-type': asset.mime,
      'content-length': String(statSync(filePath).size),
      'cache-control': 'public, max-age=31536000, immutable',
    })
    createReadStream(filePath).pipe(response)
  }
}
