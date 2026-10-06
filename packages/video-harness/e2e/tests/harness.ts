/**
 * Boot the shipped `video-harness` profile for a browser test: a fake streaming_v2 backend and a scripted model server
 * started in this process, an isolated harness home with the profile manifest, and `dsh web` on a free port. The
 * returned handle carries the token URL, a cookie-aware JSON client for `/api/vh/*`, and the teardown.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { renderClip } from '../../tools/tests/support.ts'

/** The repository root, four levels above this file. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** The ffmpeg binary the fake backend renders clips with. */
export const FFMPEG = process.env['VH_FFMPEG'] ?? '/mnt/lustre/vlm-d1su/opt/ffmpeg-native/bin/ffmpeg'

/** Playwright as apps/web installs it; this package declares no dependency of its own. */
export const playwright = createRequire(join(REPO_ROOT, 'apps/web/package.json'))('playwright') as typeof import('playwright')

/** The capabilities the fake backend reports: tiny frames so a clip renders in well under a second. */
const CAPABILITIES_BODY = {
  model_id: 'fake-ref2va', name: 'Fake Ref2AV', min_segment_duration_sec: 1, max_segment_duration_sec: 2,
  max_reference_images: 3, max_reference_aspect_ratio: 4.0,
  frame_sizes: { '16:9': { '720p': [192, 112] } }, num_frames_by_duration_sec: { 1: 25, 2: 49 },
}

/** A running fake backend. */
export interface FakeBackend {
  url: string
  requests: Record<string, unknown>[]
  close(): Promise<void>
}

/**
 * Render one solid-color VP9-in-MP4 clip that the open-source Chromium build can decode (it has no H.264 decoder), in
 * its own directory so parallel requests do not overwrite each other. The color follows the prompt, so clips of
 * different prompts are different assets.
 * @param dir - the backend scratch directory.
 * @param width - frame width.
 * @param height - frame height.
 * @param numFrames - frames at 24 fps.
 * @param prompt - the request prompt.
 * @returns the clip bytes and its last frame as PNG.
 */
async function renderPlayableClip(
  dir: string,
  width: number,
  height: number,
  numFrames: number,
  prompt: string,
): Promise<{ video: Buffer; lastFrame: Buffer }> {
  const work = mkdtempSync(join(dir, 'clip-'))
  const color = createHash('sha1').update(prompt).digest('hex').slice(0, 6)
  const video = join(work, 'clip.mp4')
  const frame = join(work, 'last.png')
  const ffmpeg = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`ffmpeg exited with ${String(code)}`)) })
  })
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=0x${color}:s=${String(width)}x${String(height)}:d=${(numFrames / 24).toFixed(3)}:r=24`, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video])
  await ffmpeg(['-sseof', '-0.05', '-i', video, '-frames:v', '1', frame])
  const rendered = { video: readFileSync(video), lastFrame: readFileSync(frame) }
  rmSync(work, { recursive: true, force: true })
  return rendered
}

/**
 * Start a fake streaming_v2 backend: capabilities and health answer statically, and every generate request streams
 * one solid-color clip rendered with ffmpeg.
 * @param dir - a scratch directory for the rendered files.
 * @returns the backend handle.
 */
export async function startFakeBackend(
  dir: string,
  options: { playable?: boolean } = {},
): Promise<FakeBackend> {
  // ffmpeg writes the rendered clip into `dir` and does not create it.
  mkdirSync(dir, { recursive: true })
  const requests: Record<string, unknown>[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? ''
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify(path.endsWith('/health') ? { status: 'ready' } : CAPABILITIES_BODY))
      return
    }
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => { parts.push(part) })
    request.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>
        requests.push(body)
        const rendered = options.playable === true
          ? await renderPlayableClip(dir, Number(body['width']), Number(body['height']), Number(body['num_frames']), String(body['prompt'] ?? ''))
          : await renderClip(dir, Number(body['width']), Number(body['height']), Number(body['num_frames']))
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
        const events: Array<[string, object]> = [
          ['last_frame', { data: rendered.lastFrame.toString('base64') }],
          ['video_start', { mime: options.playable === true ? 'video/mp4; codecs="vp09.00.10.08"' : 'video/mp4; codecs="avc1.64001f"' }],
          ['video_chunk', { data: rendered.video.toString('base64') }],
          ['done', { timings: { total_s: 0.4 } }],
        ]
        for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        response.end()
      })()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }
}

/** A cookie-aware JSON client bound to the booted harness. */
export interface HarnessApi {
  /** `GET` a JSON route, failing on any non-2xx status. */
  get(path: string): Promise<unknown>
  /** `POST` a JSON body, failing on any non-2xx status. */
  post(path: string, body: unknown): Promise<unknown>
}

/** The booted profile. */
export interface BootedHarness {
  /** `http://127.0.0.1:<port>/?token=…`, the URL that establishes the browser session. */
  tokenUrl: string
  /** The origin without the token. */
  origin: string
  backend: FakeBackend
  model: MockLlmServer
  api: HarnessApi
  /** Everything the process printed, for failure reports. */
  output: string[]
  close(): Promise<void>
}

/**
 * Wait until the child prints its `dsh web:` line or exits.
 * @param child - the spawned `dsh`.
 * @param output - the sink every line goes to.
 * @returns the printed token URL.
 */
function awaitTokenUrl(child: ChildProcess, output: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`dsh web did not print its URL within 120 s:\n${output.join('')}`)) }, 120_000)
    const scan = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      output.push(text)
      const match = /dsh web: (http:\/\/\S+)/.exec(text)
      if (match !== null) { clearTimeout(timer); resolve(match[1] ?? '') }
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dsh web exited with ${String(code)} before printing its URL:\n${output.join('')}`)) })
  })
}

/**
 * Exchange the token URL for the session cookie the `/api` routes require.
 * @param tokenUrl - the printed token URL.
 * @returns the `cookie` header value.
 */
async function sessionCookie(tokenUrl: string): Promise<string> {
  const response = await fetch(tokenUrl, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie().map(line => line.split(';')[0] ?? '')
  if (cookies.length === 0) throw new Error(`token URL set no cookie (status ${String(response.status)})`)
  return cookies.join('; ')
}

/**
 * Boot the profile with fake services.
 * @param options - `modelBaseUrl` points the agent's OpenAI-compatible route (with `/v1`) at a test model, such as
 *   `startScriptedModel` from `scripted-model.ts`; by default the route points at the Messages mock.
 *   `playableClips` makes the fake backend render VP9 clips with a per-prompt color, which Chromium can play.
 * @returns the booted harness; call `close` in teardown even on failure.
 */
export async function bootHarness(
  options: { modelBaseUrl?: string; playableClips?: boolean } = {},
): Promise<BootedHarness> {
  const scratch = mkdtempSync(join(tmpdir(), 'vh-e2e-'))
  const backend = await startFakeBackend(join(scratch, 'backend'), { playable: options.playableClips === true })
  const model = await startMockLlmServer({ port: 0, sequence: ['tool_call_success'], repeatLast: true, toolName: 'dv_proj_state', toolArguments: '{}' })
  // The isolated harness home mirrors scripts/video-harness/setup-profile.sh: a manifest naming the three bundles,
  // an empty profile patch, and a link to this checkout's bundle package.
  const home = join(scratch, 'dsh-home')
  const profileDir = join(home, 'profiles', 'video-harness')
  mkdirSync(join(profileDir, 'node_modules', '@video-harness'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-video-harness', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@video-harness/bundle'] } },
  }))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  symlinkSync(join(REPO_ROOT, 'packages/bundle/video-harness'), join(profileDir, 'node_modules', '@video-harness', 'bundle'))
  const port = await freePort()
  const output: string[] = []
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'video-harness', '--port', String(port), '--no-open'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env['PATH'] ?? ''}`,
      DSH_HOME: home,
      VH_STATE_ROOT: join(scratch, 'state'),
      VH_BACKEND_URL: backend.url,
      VH_FFMPEG: FFMPEG,
      VH_PUBLIC_URL: '',
      VH_DEEPSEEK_BASE_URL: options.modelBaseUrl ?? `${model.baseURL}/v1`,
      VH_DEEPSEEK_API_KEY: 'none',
      GROQ_API_KEY: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let tokenUrl: string
  try {
    tokenUrl = await awaitTokenUrl(child, output)
  } catch (error) {
    child.kill('SIGKILL')
    await backend.close()
    await model.close()
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
  const origin = new URL(tokenUrl).origin
  const cookie = await sessionCookie(tokenUrl)
  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const response = await fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, cookie, 'content-type': 'application/json' } })
    const text = await response.text()
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${String(response.status)}: ${text}`)
    return text.length === 0 ? null : JSON.parse(text)
  }
  return {
    tokenUrl,
    origin,
    backend,
    model,
    output,
    api: {
      get: path => call(path, { method: 'GET' }),
      post: (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) }),
    },
    close: async () => {
      child.kill('SIGTERM')
      const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
      const forced = new Promise<void>((resolve) => { setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000) })
      await Promise.race([exited, forced])
      await backend.close()
      await model.close()
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}

/**
 * An OS-assigned free port, released before use: `dsh web` needs a concrete `--port`.
 * @returns the port number.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') { probe.close(() => { reject(new Error('port probe returned no address')) }); return }
      probe.close(() => { resolve(address.port) })
    })
  })
}

/**
 * Poll a predicate until it holds.
 * @param check - the probe; a truthy result ends the wait.
 * @param label - names the condition in the timeout error.
 * @param timeoutMs - the budget.
 * @returns the first truthy result.
 */
export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
