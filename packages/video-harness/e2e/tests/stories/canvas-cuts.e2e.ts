// User stories of the canvas (画布) and the cuts editor (剪辑), walked in Chromium against the shipped profile with a
// fake video backend that renders playable VP9 clips and a scripted agent model. Projects are seeded through the views
// API, so each story starts from plans, clips, drafts, and several episodes without waiting for an agent. Every story
// asserts what the creator must see after the action; a story whose expected behavior is not built yet fails.
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bootHarness, playwright, waitFor, type BootedHarness } from '../harness.ts'
import { startScriptedModel, type ScriptedModel } from '../scripted-model.ts'

/** A 2×2 PNG with other bytes than {@link PNG_BASE64}, so its import is a new asset. */
const OTHER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEIGBkZGBgYAAAhGQIBk6M1bQAAAABJRU5ErkJggg=='

/** A 1×1 opaque PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

interface OpWire { id: string; tool?: { name: string }; status: string; outputs: string[]; branch: string }
interface ItemWire { slot: number; assetId: string; inSec: number | null; outSec: number | null }
interface AssetWire { id: string; mime: string; name: string; durationSec?: number }
interface StateWire {
  ops: OpWire[]
  assets: AssetWire[]
  sequence: { items: ItemWire[] } | null
  sequences: Array<{ id: string; title: string; items: ItemWire[] }>
  heads: Record<string, string>
}

/** A seeded project: its ID, the rendered clip assets in shot order, and the shot records. */
interface Seeded { id: string; clips: string[]; shots: string[] }

let harness: BootedHarness
let model: ScriptedModel
let browser: Browser
const contexts: BrowserContext[] = []

/**
 * Run one tool as a user turn through the views API.
 * @param project - the project.
 * @param tool - the tool name.
 * @param params - the tool params.
 * @param inputs - the input references.
 * @returns the record.
 */
async function invoke(
  project: string,
  tool: string,
  params: Record<string, unknown>,
  inputs: Array<{ role: string; ref: string }> = [],
): Promise<OpWire> {
  return await harness.api.post('/api/vh/invoke', { project, tool, params, inputs, surface: 'canvas', intent: `seed: ${tool}` }) as OpWire
}

/** @returns the folded `main` state of a project. */
async function stateOf(project: string): Promise<StateWire> {
  return await harness.api.get(`/api/vh/state?project=${project}&head=main`) as StateWire
}

/**
 * Seed a project: an imported reference, a character, an approved plan whose shots last 1 s, 2 s, 1 s, … and render
 * into episode 1, and extra episodes made of the first clips.
 * @param title - the project title.
 * @param shots - how many shots the plan has.
 * @param episodes - for each extra episode (第 2 集, 第 3 集, …), how many clips it starts with.
 * @returns the project, its clips, and its shot records.
 */
async function seedProject(title: string, shots = 3, episodes: number[] = []): Promise<Seeded> {
  const created = await harness.api.post('/api/vh/projects', { title, surface: 'canvas' }) as { projectId: string }
  const id = created.projectId
  const imported = await invoke(id, 'asset.import', { base64: PNG_BASE64, mime: 'image/png', name: 'ref.png' })
  await invoke(id, 'bible.character_create', { character: 'c1', name: 'Dancer' }, [{ role: 'reference', ref: imported.outputs[0] ?? '' }])
  const plan = await invoke(id, 'plan.create', {
    title, continuity: 'independent', references: ['c1@1'],
    shots: Array.from({ length: shots }, (_, index) => ({ prompt: `${title} shot ${String(index + 1)}`, duration_sec: 1 + (index % 2) })),
  })
  await invoke(id, 'plan.approve', { plan: plan.id })
  const state = await waitFor(async () => {
    const current = await stateOf(id)
    const done = current.ops.filter(op => op.tool?.name === 'shot.render' && op.status === 'done')
    return done.length === shots && (current.sequences[0]?.items.length ?? 0) === shots ? current : null
  }, `${String(shots)} rendered shots of ${title}`, 120_000)
  const clips = [...state.sequences[0]?.items ?? []].sort((a, b) => a.slot - b.slot).map(item => item.assetId)
  for (const [index, count] of episodes.entries()) {
    await invoke(id, 'timeline.create', { timeline: `t${String(index + 2)}`, name: `第 ${String(index + 2)} 集`, assets: clips.slice(0, count) })
  }
  const shotOps = state.ops.filter(op => op.tool?.name === 'shot.render').map(op => op.id)
  return { id, clips, shots: shotOps }
}

/**
 * Open a fresh browser page with the session cookie, recording console errors and uncaught exceptions.
 * @param options - the browser language and color scheme.
 * @returns the page; `errors` collects the messages.
 */
async function openPage(options: { lang?: string; scheme?: 'light' | 'dark' } = {}): Promise<Page & { errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: options.lang ?? 'zh-CN', colorScheme: options.scheme ?? 'light' })
  contexts.push(context)
  context.setDefaultTimeout(10_000)
  const page = await context.newPage() as Page & { errors: string[] }
  page.errors = []
  page.on('console', (message) => { if (message.type() === 'error') page.errors.push(message.text()) })
  page.on('pageerror', (error) => { page.errors.push(`pageerror: ${error.message}`) })
  await page.goto(harness.tokenUrl, { waitUntil: 'load' })
  // A fresh browser profile first shows DSH's one-time beta notice (内测声明) over the whole page.
  const notice = page.getByRole('button', { name: /^(继续|Continue)$/ })
  await notice.waitFor({ timeout: 2500 }).then(() => notice.click(), () => undefined)
  return page
}

/**
 * Load a project location the way a shared link or a reload does, and wait until the center shows that project. A
 * fresh browser can land on the project of DSH's last session instead (VH-038, pinned by the navigation stories); the
 * story then opens the project from the navigator, so canvas and cuts stories do not depend on that defect.
 * @param page - the page.
 * @param project - the project.
 * @param view - the center view.
 */
async function gotoProject(page: Page, project: string, view: 'canvas' | 'cuts' = 'canvas'): Promise<void> {
  const links = await harness.api.get('/api/vh/workspaces') as { projects: Array<{ projectId: string; title: string }> }
  const title = links.projects.find(entry => entry.projectId === project)?.title ?? project
  await page.goto(`${harness.origin}/#project=${project}${view === 'cuts' ? '&view=cuts' : ''}`)
  await page.reload({ waitUntil: 'load' })
  const crumb = page.locator('[data-vh-workspace] header').first()
  const settled = async (): Promise<boolean> => {
    // The center keeps the project for two consecutive reads 750 ms apart.
    const first = await crumb.textContent({ timeout: 1000 }).catch(() => '')
    await page.waitForTimeout(750)
    const second = await crumb.textContent({ timeout: 1000 }).catch(() => '')
    return (first ?? '').startsWith(title) && (second ?? '').startsWith(title)
  }
  if (!await settled()) {
    await page.locator('nav, aside, body').getByText(title, { exact: true }).first().click()
    await expect.poll(settled, { timeout: 15_000 }).toBe(true)
    if (view === 'cuts') await viewToggle(page, '剪辑').or(viewToggle(page, 'Cuts')).first().click()
  }
  if (view === 'canvas') await page.locator('[data-testid="vh-canvas-view"]').waitFor({ timeout: 30_000 })
  else await page.locator('[data-testid="vh-cuts"]').waitFor({ timeout: 30_000 })
}

/** The 画布 | 剪辑 toggle button in the workspace top bar. */
function viewToggle(page: Page, name: string): Locator {
  return page.locator('[data-vh-workspace] header [role="tab"]', { hasText: name })
}

/** One episode tab of the cuts editor. */
function episodeTab(page: Page, name: string): Locator {
  return page.locator('[data-testid="vh-cuts"] [role="tab"]', { hasText: name })
}

/** @returns the cuts tab labels, the selected one marked with `*`. */
async function episodeTabs(page: Page): Promise<string[]> {
  return await page.locator('[data-testid="vh-cuts"] [role="tab"]').evaluateAll(tabs => tabs.map(tab => `${tab.textContent ?? ''}${tab.getAttribute('aria-selected') === 'true' ? '*' : ''}`))
}

/** @returns the cuts time label, such as `0:01.5 / 0:04.0`, as two numbers in seconds. */
async function cutsTime(page: Page): Promise<[number, number]> {
  const text = await page.locator('[data-testid="vh-cuts-time"]').textContent() ?? ''
  const seconds = (part: string): number => { const [m, s] = part.trim().split(':'); return Number(m) * 60 + Number(s) }
  const [position = '0:0', total = '0:0'] = text.split('/')
  return [seconds(position), seconds(total)]
}

/** @returns the asset ID the visible cuts viewer element shows, or null. */
async function viewerAsset(page: Page): Promise<string | null> {
  return await page.locator('[data-testid="vh-cuts-viewer"] video').evaluateAll((videos) => {
    const shown = videos.find(video => (video as HTMLVideoElement).style.visibility !== 'hidden')
    return /\/dv\/assets\/([0-9a-f]+)/.exec(shown?.getAttribute('src') ?? '')?.[1] ?? null
  })
}

/** @returns the slots of the clips on V1 in track order, the selected one marked with `*`. */
async function trackClips(page: Page): Promise<string[]> {
  return await page.locator('[data-clip-slot]').evaluateAll(clips => clips.map(clip => `${(clip as HTMLElement).dataset['clipSlot'] ?? ''}${clip.getAttribute('aria-pressed') === 'true' ? '*' : ''}`))
}

/** @returns the pixels per second of the cuts zoom slider. */
async function pxPerSecond(page: Page): Promise<number> {
  return Number(await page.locator('[data-testid="vh-cuts"] input[type="range"]').inputValue())
}

/** @returns the item list of one episode as `assetId[in-out]` strings in slot order. */
async function episodeItems(project: string, episode = 't1'): Promise<string[]> {
  const sequence = (await stateOf(project)).sequences.find(entry => entry.id === episode)
  return [...sequence?.items ?? []].sort((a, b) => a.slot - b.slot).map(item => `${item.assetId.slice(0, 8)}[${String(item.inSec ?? '')}-${String(item.outSec ?? '')}]`)
}

/** Click 适配 on the canvas toolbar. */
async function fitCanvas(page: Page): Promise<void> {
  await page.locator('[data-testid="vh-canvas-view"] button', { hasText: /^(适配|Fit)$/ }).click()
  await page.waitForTimeout(300)
}

/** The relative luminance of a CSS `rgb()` color, 0 (black) to 1 (white). */
function luminance(color: string): number {
  const [r = 0, g = 0, b = 0] = color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? []
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** @returns the first opaque background color from an element up to the document root. */
async function backgroundOf(locator: Locator): Promise<string> {
  return await locator.evaluate((element) => {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor
      if (color !== '' && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color
    }
    return 'rgb(255, 255, 255)'
  })
}

/** Open the 素材 tab of the right panel and wait for the asset tiles. */
async function openAssets(page: Page): Promise<void> {
  await page.getByText(/^(素材|Assets)$/).first().click()
  await page.locator('[data-asset-id]').first().waitFor({ timeout: 15_000 })
}

/** @returns pairs of canvas nodes whose boxes overlap on screen. */
async function overlappingNodes(page: Page): Promise<string[]> {
  return await page.locator('[data-node-id]').evaluateAll((nodes) => {
    const boxes = nodes.map(node => ({ id: node.getAttribute('aria-label') ?? '', box: node.getBoundingClientRect() }))
    const pairs: string[] = []
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]?.box
        const b = boxes[j]?.box
        if (a !== undefined && b !== undefined && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) pairs.push(`${boxes[i]?.id ?? ''} × ${boxes[j]?.id ?? ''}`)
      }
    }
    return pairs
  })
}

beforeAll(async () => {
  model = await startScriptedModel()
  harness = await bootHarness({ modelBaseUrl: model.baseURL, playableClips: true })
  const executablePath = process.env['DSH_PLAYWRIGHT_EXECUTABLE_PATH']
  browser = await playwright.chromium.launch(executablePath === undefined ? {} : { executablePath })
}, 150_000)

// Each story's pages close before the next story, so no playing video or open stream outlives its story.
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined)
})

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await harness?.close()
  await model?.close()
})

describe('canvas stories', () => {
  it('fit shows every node; pan, zoom, and a dragged node are restored after a reload', async () => {
    const project = await seedProject('canvas-layout')
    const page = await openPage()
    await gotoProject(page, project.id)
    await page.locator('[data-node-id]').first().waitFor()
    await fitCanvas(page)
    // After 适配 every node lies inside the visible canvas.
    const outside = await page.locator('[data-testid="vh-canvas-view"]').evaluate((canvas) => {
      const frame = canvas.getBoundingClientRect()
      return [...canvas.querySelectorAll('[data-node-id]')].filter((node) => {
        const box = node.getBoundingClientRect()
        return box.left < frame.left || box.right > frame.right || box.top < frame.top || box.bottom > frame.bottom
      }).map(node => node.getAttribute('aria-label'))
    })
    expect(outside).toEqual([])
    const clip = page.locator('[data-node-kind="clip"]').first()
    const id = await clip.getAttribute('data-node-id') ?? ''
    const before = await clip.boundingBox()
    if (before === null) throw new Error('clip node has no box')
    await page.mouse.move(before.x + 40, before.y + 40)
    await page.mouse.down()
    await page.mouse.move(before.x + 160, before.y + 90, { steps: 8 })
    await page.mouse.up()
    // A drag moves the node and does not open its editor.
    expect(await page.locator('[data-testid="vh-node-editor"]').count()).toBe(0)
    const frame = await page.locator('[data-testid="vh-canvas-view"]').boundingBox()
    if (frame === null) throw new Error('canvas has no box')
    await page.mouse.move(frame.x + 30, frame.y + frame.height - 120)
    await page.mouse.down()
    await page.mouse.move(frame.x + 90, frame.y + frame.height - 160, { steps: 5 })
    await page.mouse.up()
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
    await page.mouse.wheel(0, -200)
    await page.waitForTimeout(1200)
    const node = page.locator(`[data-node-id="${id}"]`)
    const placed = {
      left: await node.evaluate(el => (el as HTMLElement).style.left),
      top: await node.evaluate(el => (el as HTMLElement).style.top),
    }
    const transform = await page.locator('[data-testid="vh-canvas-view"] > div[style*="transform"]').evaluate(el => (el as HTMLElement).style.transform)
    await page.reload({ waitUntil: 'load' })
    await page.locator(`[data-node-id="${id}"]`).waitFor({ timeout: 30_000 })
    await page.waitForTimeout(500)
    expect({
      left: await node.evaluate(el => (el as HTMLElement).style.left),
      top: await node.evaluate(el => (el as HTMLElement).style.top),
    }).toEqual(placed)
    expect(await page.locator('[data-testid="vh-canvas-view"] > div[style*="transform"]').evaluate(el => (el as HTMLElement).style.transform)).toBe(transform)
    expect(page.errors).toEqual([])
  })

  it('clicking a node opens the floating editor; ✕ and Escape close it', async () => {
    const project = await seedProject('canvas-editor')
    const page = await openPage()
    await gotoProject(page, project.id)
    const editor = page.locator('[data-testid="vh-node-editor"]')
    await page.locator('[data-node-kind="clip"]').first().click()
    await expect.poll(() => editor.count()).toBe(1)
    await editor.getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => editor.count()).toBe(0)
    await page.locator('[data-node-kind="clip"]').first().click()
    await page.locator('#vh-editor-prompt').click()
    await page.keyboard.press('Escape')
    await expect.poll(() => editor.count()).toBe(0)
    // Escape also closes the editor when focus left it, for example after clicking the editor's video.
    await page.locator('[data-node-kind="plan"]').first().click()
    await expect.poll(() => editor.count()).toBe(1)
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
    await page.keyboard.press('Escape')
    await expect.poll(() => editor.count()).toBe(0)
  })

  it('clicking empty canvas closes the floating editor', async () => {
    const project = await seedProject('canvas-editor-bg')
    const page = await openPage()
    await gotoProject(page, project.id)
    await fitCanvas(page)
    await page.locator('[data-node-kind="entity"]').first().click()
    const editor = page.locator('[data-testid="vh-node-editor"]')
    await expect.poll(() => editor.count()).toBe(1)
    const frame = await page.locator('[data-testid="vh-canvas-view"]').boundingBox()
    if (frame === null) throw new Error('canvas has no box')
    // The bottom-right corner of the canvas holds no node, no editor, and no toolbar.
    await page.mouse.click(frame.x + frame.width - 20, frame.y + frame.height - 20)
    await expect.poll(() => editor.count(), { timeout: 2000 }).toBe(0)
  })

  it('switching to cuts and back, or to another project, leaves no editor behind', async () => {
    const first = await seedProject('canvas-leave-a')
    const second = await seedProject('canvas-leave-b', 2)
    const page = await openPage()
    await gotoProject(page, first.id)
    const editor = page.locator('[data-testid="vh-node-editor"]')
    await page.locator('[data-node-kind="clip"]').first().click()
    await expect.poll(() => editor.count()).toBe(1)
    await viewToggle(page, '剪辑').click()
    await page.locator('[data-testid="vh-cuts"]').waitFor()
    expect(await editor.count()).toBe(0)
    await viewToggle(page, '画布').click()
    await page.locator('[data-node-id]').first().waitFor()
    expect(await editor.count()).toBe(0)
    await page.locator('[data-node-kind="clip"]').first().click()
    await expect.poll(() => editor.count()).toBe(1)
    await page.getByText('canvas-leave-b', { exact: true }).first().click()
    await expect.poll(() => page.locator('[data-vh-workspace] header').first().textContent()).toContain('canvas-leave-b')
    expect(await editor.count()).toBe(0)
    expect(page.url()).toContain(second.id)
  })

  it('the clip editor plays the clip', async () => {
    const project = await seedProject('canvas-play', 2)
    const page = await openPage()
    await gotoProject(page, project.id)
    await page.locator('[data-node-kind="clip"]').first().click()
    const video = page.locator('[data-testid="vh-node-editor"] video')
    await video.waitFor()
    await expect.poll(
      () => video.evaluate(el => ({ error: (el as HTMLVideoElement).error?.code ?? 0, moving: (el as HTMLVideoElement).currentTime > 0 })),
      { timeout: 10_000 },
    )
      .toEqual({ error: 0, moving: true })
  })

  it('生成新版本 adds a take linked to the original by a take edge', async () => {
    const project = await seedProject('canvas-take', 2)
    const page = await openPage()
    await gotoProject(page, project.id)
    const clips = page.locator('[data-node-kind="clip"]')
    await expect.poll(() => clips.count()).toBe(2)
    const original = await clips.first().getAttribute('data-node-id') ?? ''
    await clips.first().click()
    await page.locator('#vh-editor-prompt').fill('canvas-take shot 1, take two')
    const requests = harness.backend.requests.length
    await page.getByRole('button', { name: '生成新版本' }).click()
    await expect.poll(() => page.locator('[data-testid="vh-node-editor"]').count()).toBe(0)
    await expect.poll(() => clips.count(), { timeout: 30_000 }).toBe(3)
    await expect.poll(() => harness.backend.requests.length, { timeout: 30_000 }).toBe(requests + 1)
    const take = await waitFor(async () => {
      const latest = (await stateOf(project.id)).ops.filter(op => op.tool?.name === 'shot.render').at(-1)
      return latest?.status === 'done' ? latest : null
    }, 'the new take renders')
    expect(await page.locator(`path[data-edge="${original}>${take?.id ?? ''}"]`).count()).toBe(1)
  })

  it('the original clip and its new take are told apart on the canvas', async () => {
    const project = await seedProject('canvas-take-names', 2)
    const page = await openPage()
    await gotoProject(page, project.id)
    const clips = page.locator('[data-node-kind="clip"]')
    await clips.first().click()
    await page.locator('#vh-editor-prompt').fill('canvas-take-names shot 1, take two')
    await page.getByRole('button', { name: '生成新版本' }).click()
    await expect.poll(() => clips.count(), { timeout: 30_000 }).toBe(3)
    // Two cards that both read 镜头 1 leave the creator guessing which is the new version.
    const titles = await clips.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('让 agent 改 prefills the chat with a reference to the node and closes the editor', async () => {
    const project = await seedProject('canvas-ask', 2)
    const page = await openPage()
    await gotoProject(page, project.id)
    await page.locator('[data-node-kind="clip"]').first().click()
    await page.getByRole('button', { name: '让 agent 改' }).click()
    await expect.poll(() => page.locator('[data-testid="vh-node-editor"]').count()).toBe(0)
    await expect.poll(() => page.locator('[data-vh-chat] [contenteditable="true"]').first().innerText(), { timeout: 10_000 }).toContain('镜头 1')
  })

  it('the canvas follows the light and the dark theme', async () => {
    const project = await seedProject('canvas-theme', 2)
    const light = await openPage({ scheme: 'light' })
    await gotoProject(light, project.id)
    expect(luminance(await backgroundOf(light.locator('[data-testid="vh-canvas-view"]')))).toBeGreaterThan(0.8)
    expect(luminance(await backgroundOf(light.locator('[data-node-kind="clip"]').first()))).toBeGreaterThan(0.8)
    const dark = await openPage({ scheme: 'dark' })
    await gotoProject(dark, project.id)
    expect(luminance(await backgroundOf(dark.locator('[data-testid="vh-canvas-view"]')))).toBeLessThan(0.25)
    expect(luminance(await backgroundOf(dark.locator('[data-node-kind="clip"]').first()))).toBeLessThan(0.3)
  })

  it('at fit zoom node text is readable and cards do not overlap, also after a trim badge', async () => {
    const project = await seedProject('canvas-readable', 3)
    // A split marks clip 2 as trimmed, which adds a badge row to its card.
    await invoke(project.id, 'timeline.clip_split', { timeline: 't1', clip: 2, at_sec: 0.5 })
    const page = await openPage()
    await gotoProject(page, project.id)
    await fitCanvas(page)
    const smallest = await page.locator('[data-node-id]').evaluateAll(nodes => Math.min(...nodes.map((node) => {
      const title = node.querySelector(':scope > div:last-child > div')
      return title === null ? 0 : title.getBoundingClientRect().height
    })))
    expect(smallest).toBeGreaterThanOrEqual(12)
    expect(await overlappingNodes(page)).toEqual([])
  })

  it('the first visit shows every node without pressing 适配, after the right panel opened', async () => {
    const project = await seedProject('canvas-first-fit', 3)
    const page = await openPage()
    await gotoProject(page, project.id)
    await page.locator('[data-node-id]').first().waitFor()
    await page.waitForTimeout(2000)
    const outside = await page.locator('[data-testid="vh-canvas-view"]').evaluate((canvas) => {
      const frame = canvas.getBoundingClientRect()
      return [...canvas.querySelectorAll('[data-node-id]')].filter((node) => {
        const box = node.getBoundingClientRect()
        return box.left < frame.left || box.right > frame.right || box.top < frame.top || box.bottom > frame.bottom
      }).map(node => node.getAttribute('aria-label'))
    })
    expect(outside).toEqual([])
  })

  it('a 22-shot project fits on screen without overlapping cards', async () => {
    const project = await seedProject('canvas-many', 22)
    const page = await openPage()
    await gotoProject(page, project.id)
    await expect.poll(() => page.locator('[data-node-kind="clip"]').count(), { timeout: 30_000 }).toBe(22)
    await fitCanvas(page)
    expect(await overlappingNodes(page)).toEqual([])
    const outside = await page.locator('[data-testid="vh-canvas-view"]').evaluate((canvas) => {
      const frame = canvas.getBoundingClientRect()
      return [...canvas.querySelectorAll('[data-node-id]')].filter((node) => {
        const box = node.getBoundingClientRect()
        return box.left < frame.left || box.right > frame.right || box.top < frame.top || box.bottom > frame.bottom
      }).length
    })
    expect(outside).toBe(0)
  })

  it('an empty project shows the empty-canvas hint and no stray controls', async () => {
    const created = await harness.api.post('/api/vh/projects', { title: 'canvas-empty', surface: 'canvas' }) as { projectId: string }
    const page = await openPage()
    await gotoProject(page, created.projectId)
    await expect.poll(() => page.locator('[data-testid="vh-canvas-view"]').innerText()).toContain('画布还是空的')
    expect(await page.locator('[data-node-id]').count()).toBe(0)
  })

  it('clips whose character changed are drawn stale (red) on the canvas and the track until the creator keeps them', async () => {
    const project = await seedProject('canvas-stale', 2)
    const state = await stateOf(project.id)
    const frame = state.assets.find(asset => asset.mime.startsWith('image/') && asset.name !== 'ref.png')
    await invoke(project.id, 'bible.character_update', { character: 'c1' }, [{ role: 'reference', ref: frame?.id ?? '' }])
    const page = await openPage()
    await gotoProject(page, project.id)
    const staleClips = page.locator('[data-node-kind="clip"][data-node-stale="true"]')
    await expect.poll(() => staleClips.count()).toBe(2)
    const border = await staleClips.first().evaluate(el => getComputedStyle(el).borderTopColor)
    const [r = 0, g = 0, b = 0] = border.match(/\d+/g)?.map(Number) ?? []
    expect(r).toBeGreaterThan(150)
    expect(g + b).toBeLessThan(r)
    await viewToggle(page, '剪辑').click()
    await expect.poll(() => page.locator('[data-clip-stale="true"]').count()).toBe(2)
    // Keeping both renders (proj.stale_accept) clears the marks on the track and, back on the canvas, on the clips.
    for (const shot of project.shots) {
      await harness.api.post('/api/vh/stale/accept', { project: project.id, record: shot, surface: 'canvas' })
    }
    await expect.poll(() => page.locator('[data-clip-stale="true"]').count()).toBe(0)
    await viewToggle(page, '画布').click()
    await expect.poll(() => page.locator('[data-node-stale="true"]').count()).toBe(0)
  })

  it('a draft draws dashed nodes with an accept bar; accepting makes them solid', async () => {
    const project = await seedProject('canvas-draft', 2)
    model.rules.push({ match: 'draft-shot-please', steps: [{ calls: [{ name: 'dv_shot_render', args: { reason: 'draft shot', project_id: project.id, prompt: 'canvas-draft extra shot', duration_sec: 1, inputs: { reference: ['c1@1'] } } }] }], endText: '草稿待确认' })
    const page = await openPage()
    await gotoProject(page, project.id)
    const composer = page.locator('[data-vh-chat] [contenteditable="true"]').first()
    await composer.waitFor({ timeout: 30_000 })
    await composer.click()
    await page.keyboard.type('draft-shot-please')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('[data-node-draft="true"]').count(), { timeout: 60_000 }).toBeGreaterThan(0)
    const outline = await page.locator('[data-node-draft="true"]').first().evaluate(el => getComputedStyle(el).outlineStyle)
    expect(outline).toBe('dashed')
    await page.locator('[data-testid="vh-canvas-view"] button', { hasText: '接受' }).first().click()
    await expect.poll(() => page.locator('[data-node-draft="true"]').count(), { timeout: 15_000 }).toBe(0)
    expect(await page.locator('[data-node-kind="clip"]').count()).toBe(3)
  })

  it('dragging an image tile from 素材 onto the canvas places it on the canvas', async () => {
    const project = await seedProject('canvas-drop', 2)
    const extra = await invoke(project.id, 'asset.import', { base64: PNG_BASE64, mime: 'image/png', name: 'extra.png' })
    const page = await openPage()
    await gotoProject(page, project.id)
    await openAssets(page)
    const nodes = await page.locator('[data-node-id]').count()
    const canvas = page.locator('[data-testid="vh-canvas-view"]')
    const frame = await canvas.boundingBox()
    if (frame === null) throw new Error('canvas has no box')
    const tile = page.locator(`[data-asset-id="${extra.outputs[0] ?? ''}"]`)
    // The empty-canvas hint tells the creator to drag references in from 素材; the canvas must accept the drop.
    const accepted = await canvas.evaluate((element, assetId) => {
      const transfer = new DataTransfer()
      transfer.setData('application/x-vh-asset', assetId)
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 400, clientY: 500 })
      element.dispatchEvent(over)
      return over.defaultPrevented
    }, extra.outputs[0] ?? '')
    expect(accepted).toBe(true)
    await tile.dragTo(canvas, { targetPosition: { x: 120, y: frame.height - 140 } })
    // Dropping places the asset's node under the pointer.
    await expect.poll(async () => {
      const placed = await page.locator('[data-node-id]').evaluateAll((all, point) => all.some((node) => {
        const box = node.getBoundingClientRect()
        return box.left <= point.x && point.x <= box.right && box.top <= point.y && point.y <= box.bottom
      }), { x: frame.x + 120, y: frame.y + frame.height - 140 })
      return placed
    }, { timeout: 5000 }).toBe(true)
    expect(await page.locator('[data-node-id]').count()).toBeGreaterThanOrEqual(nodes)
  })
  it('a file dropped on the canvas is not also attached to the chat', async () => {
    const project = await seedProject('canvas-file-drop', 2)
    const page = await openPage()
    await gotoProject(page, project.id)
    await page.locator('[data-vh-chat] [contenteditable="true"]').first().waitFor({ timeout: 30_000 })
    const canvas = page.locator('[data-testid="vh-canvas-view"]')
    const frame = await canvas.boundingBox()
    if (frame === null) throw new Error('canvas has no box')
    const transfer = await page.evaluateHandle((base64) => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'dropped-on-canvas.png', { type: 'image/png' }))
      data.items.add(new File(['notes'], 'notes-on-canvas.txt', { type: 'text/plain' }))
      return data
    }, OTHER_PNG_BASE64)
    const at = { clientX: frame.x + 160, clientY: frame.y + 160 }
    for (const type of ['dragenter', 'dragover', 'drop']) await canvas.dispatchEvent(type, { dataTransfer: transfer, ...at })
    await expect.poll(() => page.locator('[data-node-kind="reference"]').count(), { timeout: 10_000 }).toBe(1)
    // The composer shows a dropped attachment as a chip with its file name; only the canvas notice may name the file.
    await page.waitForTimeout(500)
    const outside = await page.getByText('notes-on-canvas.txt').evaluateAll(nodes => nodes.filter(node => node.closest('[data-testid="vh-canvas-view"]') === null).length)
    expect(outside).toBe(0)
  })
})

describe('cuts stories', () => {
  it('one tab per episode; switching moves the viewer, playhead, time, and selection with it', async () => {
    const project = await seedProject('cuts-tabs', 3, [2, 0])
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    expect(await episodeTabs(page)).toEqual(['第 1 集*', '第 2 集', '第 3 集'])
    expect(await cutsTime(page)).toEqual([0, 4])
    const ruler = await page.locator('[data-testid="vh-cuts-ruler"]').boundingBox()
    if (ruler === null) throw new Error('ruler has no box')
    await page.mouse.click(ruler.x + 2.5 * await pxPerSecond(page), ruler.y + 10)
    await page.locator('[data-clip-slot="2"]').click()
    expect(await trackClips(page)).toEqual(['1', '2*', '3'])
    expect((await cutsTime(page))[0]).toBeCloseTo(2.5, 1)
    await episodeTab(page, '第 2 集').click()
    expect(await episodeTabs(page)).toEqual(['第 1 集', '第 2 集*', '第 3 集'])
    expect(await trackClips(page)).toEqual(['1', '2'])
    await expect.poll(() => cutsTime(page), { timeout: 3000 }).toEqual([0, 3])
    await expect.poll(() => viewerAsset(page)).toBe(project.clips[0])
    await episodeTab(page, '第 3 集').click()
    expect(await trackClips(page)).toEqual([])
    await expect.poll(() => cutsTime(page), { timeout: 3000 }).toEqual([0, 0])
    expect(await viewerAsset(page)).toBeNull()
    await expect.poll(() => page.locator('[data-testid="vh-cuts-viewer-empty"]').count()).toBe(1)
    expect(page.errors).toEqual([])
  })

  it('＋ 新建 adds the next 第 N 集, selects it, and its empty track explains what to do', async () => {
    const project = await seedProject('cuts-new', 2)
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await page.getByRole('button', { name: '＋ 新建' }).click()
    await expect.poll(() => episodeTabs(page)).toEqual(['第 1 集', '第 2 集*'])
    await page.getByRole('button', { name: '＋ 新建' }).click()
    await expect.poll(() => episodeTabs(page)).toEqual(['第 1 集', '第 2 集', '第 3 集*'])
    expect((await stateOf(project.id)).sequences.map(sequence => sequence.title)).toEqual(['第 1 集', '第 2 集', '第 3 集'])
    await expect.poll(() => page.locator('[data-testid="vh-cuts"]').innerText()).toContain('这一集还没有片段')
  })

  it('an empty episode explains what to do once, not twice', async () => {
    const project = await seedProject('cuts-empty-hint', 2, [0])
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await episodeTab(page, '第 2 集').click()
    const text = await page.locator('[data-testid="vh-cuts"]').innerText()
    expect(text.split('这一集还没有片段').length - 1).toBe(1)
  })

  it('an episode created in English is titled 第 2 集 in the Chinese interface', async () => {
    const project = await seedProject('cuts-title-language', 2)
    const english = await openPage({ lang: 'en-US' })
    await gotoProject(english, project.id, 'cuts')
    await english.locator('[data-testid="vh-cuts"] [role="tablist"]').getByRole('button', { name: '＋ New' }).click()
    await expect.poll(() => episodeTabs(english)).toEqual(['Episode 1', 'Episode 2*'])
    const chinese = await openPage({ lang: 'zh-CN' })
    await gotoProject(chinese, project.id, 'cuts')
    expect(await episodeTabs(chinese)).toEqual(['第 1 集*', '第 2 集'])
  })

  it('a very short clip can still be selected by clicking its middle at the default zoom', async () => {
    const project = await seedProject('cuts-narrow', 3)
    await invoke(project.id, 'timeline.clip_trim', { timeline: 't1', clip: 1, out_sec: 0.2 })
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    const clip = await page.locator('[data-clip-slot="1"]').boundingBox()
    if (clip === null) throw new Error('clip 1 has no box')
    await page.mouse.click(clip.x + clip.width / 2, clip.y + clip.height / 2)
    await expect.poll(() => trackClips(page)).toEqual(['1*', '2', '3'])
  })

  it('an episode can be renamed by double-clicking its tab', async () => {
    const project = await seedProject('cuts-rename', 2, [1])
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await episodeTab(page, '第 2 集').dblclick()
    const box = page.locator('[data-testid="vh-cuts"] [role="tablist"] input')
    await box.waitFor({ timeout: 3000 })
    await box.fill('片尾')
    await box.press('Enter')
    await expect.poll(() => episodeTabs(page)).toEqual(['第 1 集', '片尾*'])
    await expect.poll(async () => (await stateOf(project.id)).sequences.find(sequence => sequence.id === 't2')?.title).toBe('片尾')
  })

  it('an episode can be deleted from its tab menu after a confirmation', async () => {
    const project = await seedProject('cuts-delete', 2, [1, 0])
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await episodeTab(page, '第 2 集').click()
    page.once('dialog', (dialog) => { void dialog.accept() })
    await episodeTab(page, '第 2 集').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /删除/ }).click({ timeout: 3000 })
    const confirm = page.getByRole('dialog').getByRole('button', { name: /删除/ })
    if (await confirm.count() > 0) await confirm.click()
    await expect.poll(() => episodeTabs(page)).toEqual(['第 1 集*', '第 3 集'])
    await expect.poll(async () => (await stateOf(project.id)).sequences.map(sequence => sequence.id)).toEqual(['t1', 't3'])
  })

  it('deleting an episode can be undone from the toolbar', async () => {
    const project = await seedProject('cuts-delete-undo', 2, [1])
    const page = await openPage()
    page.on('dialog', (dialog) => { void dialog.accept() })
    await gotoProject(page, project.id, 'cuts')
    await episodeTab(page, '第 2 集').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /删除/ }).click()
    const confirm = page.getByRole('dialog').getByRole('button', { name: /删除/ })
    if (await confirm.count() > 0) await confirm.click()
    await expect.poll(() => episodeTabs(page)).toEqual(['第 1 集*'])
    const undo = page.getByRole('button', { name: '撤销' })
    await expect.poll(() => undo.isEnabled()).toBe(true)
    await undo.click()
    await expect.poll(() => episodeTabs(page)).toContain('第 2 集')
    expect((await stateOf(project.id)).sequences.map(sequence => sequence.id)).toEqual(['t1', 't2'])
  })

  it('deleting the last episode leaves an honest empty state', async () => {
    const project = await seedProject('cuts-delete-last', 2)
    const page = await openPage()
    page.on('dialog', (dialog) => { void dialog.accept() })
    await gotoProject(page, project.id, 'cuts')
    await episodeTab(page, '第 1 集').click({ button: 'right' })
    const remove = page.getByRole('menuitem', { name: /删除/ })
    // Refusing to delete the only episode is also acceptable.
    if (await remove.count() === 0) return
    await remove.click()
    const confirm = page.getByRole('dialog').getByRole('button', { name: /删除/ })
    if (await confirm.count() > 0) await confirm.click()
    await expect.poll(() => episodeTabs(page)).toEqual([])
    // With no episode, nothing may talk about "this episode" or offer a disabled ＋; ＋ 新建 is the way forward.
    const text = await page.locator('[data-testid="vh-cuts"]').innerText()
    expect(text).not.toContain('这一集')
    expect(await page.getByRole('button', { name: '＋ 新建' }).isEnabled()).toBe(true)
  })

  it('play runs the whole episode continuously across its clips to the end', async () => {
    const project = await seedProject('cuts-play', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await expect.poll(() => viewerAsset(page)).toBe(project.clips[0])
    await page.getByRole('button', { name: '播放' }).click()
    const shown = new Set<string>()
    const started = Date.now()
    for (;;) {
      const asset = await viewerAsset(page)
      if (asset !== null) shown.add(asset)
      const [position, total] = await cutsTime(page)
      if (position >= total - 0.05 || Date.now() - started > 12_000) break
      await page.waitForTimeout(100)
    }
    // Four seconds of clips play in about four seconds and every clip appears in the viewer on the way.
    const players = await page.locator('[data-testid="vh-cuts-viewer"] video').evaluateAll(videos => videos.map((video) => {
      const element = video as HTMLVideoElement
      return `${element.style.visibility}:${String(element.currentTime)}:${element.paused ? 'paused' : 'playing'}:ready=${String(element.readyState)}:error=${String(element.error?.code ?? 0)}`
    }).join(' | '))
    expect(await cutsTime(page), players).toEqual([4, 4])
    expect(Date.now() - started).toBeLessThan(9000)
    expect([...shown].sort()).toEqual([...new Set(project.clips)].sort())
    await expect.poll(() => page.getByRole('button', { name: '播放' }).count(), { timeout: 2000 }).toBe(1)
  })

  it('scrubbing the ruler moves the playhead, the time, and the viewer frame', async () => {
    const project = await seedProject('cuts-scrub', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    const ruler = await page.locator('[data-testid="vh-cuts-ruler"]').boundingBox()
    if (ruler === null) throw new Error('ruler has no box')
    const px = await pxPerSecond(page)
    await page.mouse.move(ruler.x + 0.2 * px, ruler.y + 10)
    await page.mouse.down()
    await page.mouse.move(ruler.x + 1.6 * px, ruler.y + 10, { steps: 6 })
    await page.mouse.up()
    expect((await cutsTime(page))[0]).toBeCloseTo(1.6, 1)
    const playhead = await page.locator('[data-testid="vh-cuts-playhead"]').boundingBox()
    expect(Math.abs((playhead?.x ?? 0) - (ruler.x + 1.6 * px))).toBeLessThan(4)
    await expect.poll(() => viewerAsset(page)).toBe(project.clips[1])
  })

  it('split at the playhead, trim by the edges, reorder by drag, and Delete each edit the episode once', async () => {
    const project = await seedProject('cuts-edit', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await page.getByRole('button', { name: '适配' }).click()
    const px = await pxPerSecond(page)
    const ruler = await page.locator('[data-testid="vh-cuts-ruler"]').boundingBox()
    if (ruler === null) throw new Error('ruler has no box')
    const [a, b, c] = project.clips.map(id => id.slice(0, 8))
    // Clip 2 spans 1 s to 3 s; splitting at 2 s cuts it into two 1-second halves.
    await page.mouse.click(ruler.x + 2 * px, ruler.y + 10)
    await page.getByRole('button', { name: '分割' }).click()
    await expect.poll(() => episodeItems(project.id)).toEqual([`${a ?? ''}[-]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`, `${c ?? ''}[-]`])
    await expect.poll(() => trackClips(page)).toHaveLength(4)
    // Drag the end edge of clip 1 left by 0.5 s.
    const first = await page.locator('[data-clip-slot="1"]').boundingBox()
    if (first === null) throw new Error('clip 1 has no box')
    await page.mouse.move(first.x + first.width - 3, first.y + 20)
    await page.mouse.down()
    await page.mouse.move(first.x + first.width - 3 - 0.5 * px, first.y + 20, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => episodeItems(project.id)).toEqual([`${a ?? ''}[-0.5]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`, `${c ?? ''}[-]`])
    // The track redraws after the refetch; the next drag needs the shortened layout (3.5 s in total).
    await expect.poll(async () => (await cutsTime(page))[1]).toBeCloseTo(3.5, 1)
    // Drag the start edge of the last clip right by 0.25 s.
    const last = await page.locator('[data-clip-slot="4"]').boundingBox()
    if (last === null) throw new Error('clip 4 has no box')
    await page.mouse.move(last.x + 3, last.y + 20)
    await page.mouse.down()
    await page.mouse.move(last.x + 3 + 0.25 * px, last.y + 20, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => episodeItems(project.id)).toEqual([`${a ?? ''}[-0.5]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`, `${c ?? ''}[0.25-]`])
    await expect.poll(async () => (await cutsTime(page))[1]).toBeCloseTo(3.25, 1)
    // Drag clip 4 by its body to the front.
    const moving = await page.locator('[data-clip-slot="4"]').boundingBox()
    const target = await page.locator('[data-clip-slot="1"]').boundingBox()
    if (moving === null || target === null) throw new Error('clip has no box')
    await page.mouse.move(moving.x + moving.width / 2, moving.y + 30)
    await page.mouse.down()
    await page.mouse.move(target.x + 2, moving.y + 30, { steps: 10 })
    await page.mouse.up()
    await expect.poll(() => episodeItems(project.id)).toEqual([`${c ?? ''}[0.25-]`, `${a ?? ''}[-0.5]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`])
    // After the move, only the moved clip (now slot 1) may be selected.
    expect((await trackClips(page)).filter(slot => slot.endsWith('*') && slot !== '1*')).toEqual([])
    // Select clip 2 and press Delete.
    await page.locator('[data-clip-slot="2"]').click()
    await page.keyboard.press('Delete')
    await expect.poll(() => episodeItems(project.id)).toEqual([`${c ?? ''}[0.25-]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`])
    await expect.poll(() => trackClips(page)).toEqual(['1', '2', '3'])
    expect(page.errors).toEqual([])
  })

  it('＋ inserts a picked asset at the end of the episode', async () => {
    const project = await seedProject('cuts-plus', 2, [0])
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await episodeTab(page, '第 2 集').click()
    await page.getByRole('button', { name: '添加片段' }).click()
    const picker = page.getByRole('dialog', { name: '选一个素材加到末尾' })
    await picker.waitFor()
    await picker.getByRole('button').first().click()
    await expect.poll(() => picker.count()).toBe(0)
    await expect.poll(async () => (await episodeItems(project.id, 't2')).length).toBe(1)
    await expect.poll(() => trackClips(page)).toEqual(['1'])
    expect(await episodeItems(project.id, 't1')).toHaveLength(2)
  })

  it('dragging a video tile from 素材 onto the track inserts it where it is dropped', async () => {
    const project = await seedProject('cuts-drop', 2)
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await openAssets(page)
    const track = page.locator('[data-testid="vh-cuts"] [role="list"]')
    await page.locator(`[data-asset-id="${project.clips[1] ?? ''}"]`).dragTo(track, { targetPosition: { x: 4, y: 30 } })
    await expect.poll(() => episodeItems(project.id)).toEqual([project.clips[1], project.clips[0], project.clips[1]].map(id => `${(id ?? '').slice(0, 8)}[-]`))
  })

  it('加入剪辑 in the 素材 preview adds the clip to the open episode', async () => {
    const project = await seedProject('cuts-add-from-preview', 2, [0])
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await episodeTab(page, '第 2 集').click()
    await openAssets(page)
    await page.locator(`[data-asset-id="${project.clips[0] ?? ''}"]`).click()
    await page.getByRole('button', { name: '加入剪辑' }).click()
    await expect.poll(() => episodeItems(project.id, 't2'), { timeout: 5000 }).toEqual([`${(project.clips[0] ?? '').slice(0, 8)}[-]`])
    await expect.poll(() => trackClips(page)).toEqual(['1'])
  })

  it('undo reverts the last edit and redo brings it back', async () => {
    const project = await seedProject('cuts-undo', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    const original = await episodeItems(project.id)
    await page.locator('[data-clip-slot="1"]').click()
    await page.keyboard.press('Delete')
    await expect.poll(() => episodeItems(project.id)).toHaveLength(2)
    const edited = await episodeItems(project.id)
    await page.getByRole('button', { name: '撤销' }).click()
    await expect.poll(() => episodeItems(project.id)).toEqual(original)
    await expect.poll(() => trackClips(page)).toHaveLength(3)
    const redo = page.getByRole('button', { name: '重做' })
    expect(await redo.isEnabled()).toBe(true)
    await redo.click()
    await expect.poll(() => episodeItems(project.id)).toEqual(edited)
  })

  it('export produces one playable video as long as the episode', async () => {
    const project = await seedProject('cuts-export', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await page.getByRole('button', { name: '导出' }).click()
    const link = page.locator('[data-testid="vh-cuts-exported"]')
    await link.waitFor({ timeout: 60_000 })
    const href = await link.getAttribute('href') ?? ''
    const assetId = /\/dv\/assets\/([0-9a-f]+)/.exec(href)?.[1] ?? ''
    const exported = (await stateOf(project.id)).assets.find(asset => asset.id === assetId)
    expect(exported?.mime.startsWith('video/')).toBe(true)
    const duration = await page.evaluate(async url => await new Promise<number>((resolve) => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => { resolve(video.duration) }
      video.onerror = () => { resolve(-1) }
      video.src = url
    }), href)
    expect(duration).toBeGreaterThan(3.8)
    expect(duration).toBeLessThan(4.3)
    // The export link belongs to this episode only.
    await page.getByRole('button', { name: '＋ 新建' }).click()
    await expect.poll(() => link.count()).toBe(0)
  })

  it('an episode the agent creates appears as a tab without moving the creator off the open episode', async () => {
    const project = await seedProject('cuts-agent', 2, [1])
    model.rules.push({ match: 'make-timeline-four', steps: [{ calls: [{ name: 'dv_timeline_create', args: { reason: '新建第 4 集', project_id: project.id, timeline: 't4', name: '第 4 集', assets: [] } }] }] })
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await episodeTab(page, '第 2 集').click()
    await page.locator('[data-clip-slot="1"]').click()
    const composer = page.locator('[data-vh-chat] [contenteditable="true"]').first()
    await composer.waitFor({ timeout: 30_000 })
    await composer.click()
    await page.keyboard.type('make-timeline-four')
    await page.keyboard.press('Enter')
    await expect.poll(() => episodeTabs(page), { timeout: 60_000 }).toEqual(['第 1 集', '第 2 集*', '第 4 集'])
    expect(await trackClips(page)).toEqual(['1*'])
  })

  it('an edit from elsewhere does not move the selection onto a different clip', async () => {
    const project = await seedProject('cuts-external', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await page.locator('[data-clip-slot="2"]').click()
    const selectedAsset = project.clips[1]
    await invoke(project.id, 'timeline.clip_remove', { timeline: 't1', clip: 1 })
    await expect.poll(() => trackClips(page)).toHaveLength(2)
    // Whatever stays selected must be the clip the creator picked, so Delete cannot remove a clip they never chose.
    const selected = await page.locator('[data-clip-slot][aria-pressed="true"]').evaluateAll(clips => clips.map(clip => clip.getAttribute('aria-label') ?? ''))
    const items = (await stateOf(project.id)).sequences[0]?.items ?? []
    for (const label of selected) {
      const slot = Number(/(\d+)/.exec(label)?.[1])
      expect(items.find(item => item.slot === slot)?.assetId).toBe(selectedAsset)
    }
  })

  it('the selected episode survives canvas ↔ cuts switches and a reload', async () => {
    const project = await seedProject('cuts-location', 2, [1, 0])
    const page = await openPage()
    await gotoProject(page, project.id, 'cuts')
    await episodeTab(page, '第 2 集').click()
    for (let round = 0; round < 3; round += 1) {
      await viewToggle(page, '画布').click()
      await page.locator('[data-testid="vh-canvas-view"]').waitFor()
      await viewToggle(page, '剪辑').click()
      await page.locator('[data-testid="vh-cuts"]').waitFor()
    }
    expect(await episodeTabs(page)).toEqual(['第 1 集', '第 2 集*', '第 3 集'])
    await page.reload({ waitUntil: 'load' })
    await page.locator('[data-testid="vh-cuts"] [role="tab"]').first().waitFor({ timeout: 30_000 })
    await expect.poll(() => episodeTabs(page), { timeout: 5000 }).toEqual(['第 1 集', '第 2 集*', '第 3 集'])
    expect(await trackClips(page)).toEqual(['1'])
    expect(page.errors).toEqual([])
  })

  it('the cuts editor follows the light theme of the app', async () => {
    const project = await seedProject('cuts-theme', 2)
    const page = await openPage({ scheme: 'light' })
    await gotoProject(page, project.id, 'cuts')
    // The track area and toolbar sit on the app's light surface; only the video viewer stays black.
    expect(luminance(await backgroundOf(page.locator('[data-testid="vh-cuts"]')))).toBeGreaterThan(0.8)
  })
})

describe('English interface', () => {
  it('every canvas and cuts label, editor, picker, and empty state is in English', async () => {
    const project = await seedProject('english', 2, [0])
    const page = await openPage({ lang: 'en-US' })
    await gotoProject(page, project.id)
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
    /** CJK text in the workspace chrome; project titles and prompts here are ASCII, so any CJK is interface copy. */
    const chinese = async (): Promise<string[]> => await page.locator('[data-vh-workspace]').evaluate((root) => {
      const found = new Set<string>()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent?.trim() ?? ''
        if (/[一-鿿]/.test(text)) found.add(text)
      }
      for (const element of root.querySelectorAll('[aria-label], [title], [placeholder]')) {
        for (const name of ['aria-label', 'title', 'placeholder']) {
          const value = element.getAttribute(name) ?? ''
          if (/[一-鿿]/.test(value)) found.add(`${name}=${value}`)
        }
      }
      return [...found]
    })
    expect(await chinese()).toEqual([])
    for (const kind of ['clip', 'entity', 'plan']) {
      await page.locator(`[data-node-kind="${kind}"]`).first().click()
      await page.locator('[data-testid="vh-node-editor"]').waitFor()
      expect(await chinese()).toEqual([])
      await page.locator('[data-testid="vh-node-editor"]').getByRole('button', { name: 'Close' }).click()
    }
    await viewToggle(page, 'Cuts').click()
    await page.locator('[data-testid="vh-cuts"]').waitFor()
    expect(await episodeTabs(page)).toEqual(['Episode 1*', 'Episode 2'])
    expect(await chinese()).toEqual([])
    await episodeTab(page, 'Episode 2').click()
    await page.getByRole('button', { name: 'Add a clip' }).click()
    expect(await chinese()).toEqual([])
    const created = await harness.api.post('/api/vh/projects', { title: 'english-empty', surface: 'canvas' }) as { projectId: string }
    await gotoProject(page, created.projectId)
    expect(await chinese()).toEqual([])
    await viewToggle(page, 'Cuts').click()
    await page.locator('[data-testid="vh-cuts"]').waitFor()
    expect(await chinese()).toEqual([])
  })
})
