// User stories of the canvas (画布) and the timeline editor (时间线), walked in Chromium against the shipped profile with a
// fake video backend that renders playable VP9 videos and a scripted agent model. Projects are seeded through the
// `/api/dv` routes, so each story starts from plans, takes, drafts, and several timelines without waiting for an agent. Every story
// asserts what the creator must see after the action; a story whose expected behavior is not built yet fails.
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Branch, ProjectRecord, WireState } from '@dv/ui-kit/types.ts'
import { bootHarness, playwright, waitFor, type BootedHarness } from '../harness.ts'
import { startScriptedModel, type ScriptedModel } from '../scripted-model.ts'

/** A 2×2 PNG with other bytes than {@link PNG_BASE64}, so its import is a new asset. */
const OTHER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEIGBkZGBgYAAAhGQIBk6M1bQAAAABJRU5ErkJggg=='

/** A 1×1 opaque PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** The Shot render operation of every seeded shot: the e2e profile mounts only the `ref2va` render mode. */
const RENDER_OPERATION = 'shot.render_ref2va'

/** A seeded project: its ID, the rendered take assets in shot order (the clips of timeline t1), and the shot records. */
interface Seeded { id: string; clipAssets: string[]; shots: string[] }

let harness: BootedHarness
let model: ScriptedModel
let browser: Browser
const contexts: BrowserContext[] = []

/**
 * Run one operation as a user action through `/api/dv/operation`.
 * @param project - the project.
 * @param operation - the operation name.
 * @param params - the operation params.
 * @param inputs - the input references.
 * @returns the record.
 */
async function runOperation(
  project: string,
  operation: string,
  params: Record<string, unknown>,
  inputs: Array<{ role: string; ref: string }> = [],
): Promise<ProjectRecord> {
  return await harness.api.post('/api/dv/operation', { project, operation, params, inputs, surface: 'canvas', intent: `seed: ${operation}` }) as ProjectRecord
}

/** @returns the folded `main` state of a project. */
async function stateOf(project: string): Promise<WireState> {
  return await harness.api.get(`/api/dv/state?project=${project}&branch=main`) as WireState
}

/**
 * The clip ID at a position of a project's first timeline on `main`, which the clip operations take in `clip`.
 * @param project - the project.
 * @param position - the 1-based position.
 * @returns the clip ID.
 */
async function clipAt(project: string, position: number): Promise<string> {
  const clip = (await stateOf(project)).components.timeline.timelines[0]?.clips[position - 1]
  if (clip === undefined) throw new Error(`timeline t1 of ${project} has no clip at position ${String(position)}`)
  return clip.id
}

/**
 * Seed a project: an imported reference, a character, an approved plan whose shots last 1 s, 2 s, 1 s, … and render
 * into timeline t1, and extra timelines made of the first clips.
 * @param title - the project title.
 * @param shots - how many shots the plan has.
 * @param timelines - for each extra timeline (t2, t3, …, created without a name), how many clips it starts with.
 * @returns the project, its clip assets, and its shot records.
 */
async function seedProject(title: string, shots = 3, timelines: number[] = []): Promise<Seeded> {
  const created = await harness.api.post('/api/dv/projects', { title, surface: 'canvas' }) as { id: string }
  const id = created.id
  const imported = await runOperation(id, 'asset.import', { base64: PNG_BASE64, mime: 'image/png', name: 'ref.png' })
  await runOperation(id, 'bible.character_create', { character: 'c1', name: 'Dancer' }, [{ role: 'reference', ref: imported.outputs[0] ?? '' }])
  const plan = await runOperation(id, 'plan.create', {
    title, references: ['c1@1'],
    shots: Array.from({ length: shots }, (_, index) => ({
      prompt: `${title} shot ${String(index + 1)}`, duration_sec: 1 + (index % 2), mode: 'ref2va',
    })),
  })
  await runOperation(id, 'plan.approve', { plan: plan.report?.['plan'] })
  const state = await waitFor(async () => {
    const current = await stateOf(id)
    const done = current.components.proj.records.filter(record => record.operation === RENDER_OPERATION && record.status === 'done')
    const clips = current.components.timeline.timelines[0]?.clips ?? []
    return done.length === shots && clips.length === shots && clips.every(clip => clip.asset !== null) ? current : null
  }, `${String(shots)} rendered shots of ${title}`, 120_000)
  const clipAssets = (state.components.timeline.timelines[0]?.clips ?? []).flatMap(clip => clip.asset === null ? [] : [clip.asset])
  for (const [index, count] of timelines.entries()) {
    await runOperation(id, 'timeline.create', { timeline: `t${String(index + 2)}`, assets: clipAssets.slice(0, count) })
  }
  const shotRecords = state.components.proj.records.filter(record => record.operation === RENDER_OPERATION).map(record => record.id)
  return { id, clipAssets, shots: shotRecords }
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
 * fresh browser can land on the project of DSH's last session instead of the linked one, a defect that the navigation
 * stories pin; the story then opens the project from the navigator, so canvas and timeline stories do not depend on it.
 * @param page - the page.
 * @param project - the project.
 * @param view - the center view.
 */
async function gotoProject(page: Page, project: string, view: 'canvas' | 'timeline' = 'canvas'): Promise<void> {
  const links = await harness.api.get('/api/dv/workspaces') as { projects: Array<{ id: string; title: string }> }
  const title = links.projects.find(entry => entry.id === project)?.title ?? project
  await page.goto(`${harness.origin}/#project=${project}${view === 'timeline' ? '&view=timeline' : ''}`)
  await page.reload({ waitUntil: 'load' })
  const crumb = page.locator('[data-dv-workspace] header').first()
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
    if (view === 'timeline') await viewToggle(page, '时间线').or(viewToggle(page, 'Timeline')).first().click()
  }
  if (view === 'canvas') await page.locator('[data-testid="dv-canvas-view"]').waitFor({ timeout: 30_000 })
  else await page.locator('[data-testid="dv-timeline-editor"]').waitFor({ timeout: 30_000 })
}

/** The 画布 | 时间线 toggle button in the workspace top bar. */
function viewToggle(page: Page, name: string): Locator {
  return page.locator('[data-dv-workspace] header [role="tab"]', { hasText: name })
}

/** One timeline tab of the timeline editor. */
function timelineTab(page: Page, name: string): Locator {
  return page.locator('[data-testid="dv-timeline-editor"] [role="tab"]', { hasText: name })
}

/** @returns the timeline tab labels, the selected one marked with `*`. */
async function timelineTabs(page: Page): Promise<string[]> {
  return await page.locator('[data-testid="dv-timeline-editor"] [role="tab"]').evaluateAll(tabs => tabs.map(tab => `${tab.textContent ?? ''}${tab.getAttribute('aria-selected') === 'true' ? '*' : ''}`))
}

/** @returns the timeline time label, such as `0:01.5 / 0:04.0`, as two numbers in seconds. */
async function timelineTime(page: Page): Promise<[number, number]> {
  const text = await page.locator('[data-testid="dv-timeline-time"]').textContent() ?? ''
  const seconds = (part: string): number => { const [m, s] = part.trim().split(':'); return Number(m) * 60 + Number(s) }
  const [position = '0:0', total = '0:0'] = text.split('/')
  return [seconds(position), seconds(total)]
}

/** @returns the asset ID the visible timeline viewer element shows, or null. */
async function viewerAsset(page: Page): Promise<string | null> {
  return await page.locator('[data-testid="dv-timeline-viewer"] video').evaluateAll((videos) => {
    const shown = videos.find(video => (video as HTMLVideoElement).style.visibility !== 'hidden')
    return /\/dv\/assets\/([0-9a-f]+)/.exec(shown?.getAttribute('src') ?? '')?.[1] ?? null
  })
}

/** @returns the positions of the clips on V1 in track order, the selected one marked with `*`. */
async function trackClips(page: Page): Promise<string[]> {
  return await page.locator('[data-clip-position]').evaluateAll(clips => clips.map(clip => `${(clip as HTMLElement).dataset['clipPosition'] ?? ''}${clip.getAttribute('aria-pressed') === 'true' ? '*' : ''}`))
}

/** @returns the clip IDs on V1 in track order, as the page renders them. */
async function trackClipIds(page: Page): Promise<string[]> {
  return await page.locator('[data-clip-position]').evaluateAll(clips => clips.map(clip => clip.getAttribute('data-clip') ?? ''))
}

/** @returns the pixels per second of the timeline zoom slider. */
async function pxPerSecond(page: Page): Promise<number> {
  return Number(await page.locator('[data-testid="dv-timeline-editor"] input[type="range"]').inputValue())
}

/** @returns the clips of one timeline as `assetId[in-out]` strings in playback order. */
async function timelineClips(project: string, timelineId = 't1'): Promise<string[]> {
  const timeline = (await stateOf(project)).components.timeline.timelines.find(entry => entry.id === timelineId)
  return (timeline?.clips ?? []).map(clip => `${(clip.asset ?? 'pending').slice(0, 8)}[${String(clip.in_sec ?? '')}-${String(clip.out_sec ?? '')}]`)
}

/** Click 适配 on the canvas toolbar. */
async function fitCanvas(page: Page): Promise<void> {
  await page.locator('[data-testid="dv-canvas-view"] button', { hasText: /^(适配|Fit)$/ }).click()
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

/** Open the 素材库 tab of the right panel and wait for the asset tiles. */
async function openAssets(page: Page): Promise<void> {
  await page.getByText(/^(素材库|Asset pool)$/).first().click()
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
  harness = await bootHarness({ modelBaseUrl: model.baseURL, playableVideos: true })
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
    const outside = await page.locator('[data-testid="dv-canvas-view"]').evaluate((canvas) => {
      const frame = canvas.getBoundingClientRect()
      return [...canvas.querySelectorAll('[data-node-id]')].filter((node) => {
        const box = node.getBoundingClientRect()
        return box.left < frame.left || box.right > frame.right || box.top < frame.top || box.bottom > frame.bottom
      }).map(node => node.getAttribute('aria-label'))
    })
    expect(outside).toEqual([])
    const take = page.locator('[data-node-kind="take"]').first()
    const id = await take.getAttribute('data-node-id') ?? ''
    const before = await take.boundingBox()
    if (before === null) throw new Error('take node has no box')
    await page.mouse.move(before.x + 40, before.y + 40)
    await page.mouse.down()
    await page.mouse.move(before.x + 160, before.y + 90, { steps: 8 })
    await page.mouse.up()
    // A drag moves the node and does not open its editor.
    expect(await page.locator('[data-testid="dv-canvas-node-editor"]').count()).toBe(0)
    const frame = await page.locator('[data-testid="dv-canvas-view"]').boundingBox()
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
    const transform = await page.locator('[data-testid="dv-canvas-view"] > div[style*="transform"]').evaluate(el => (el as HTMLElement).style.transform)
    await page.reload({ waitUntil: 'load' })
    await page.locator(`[data-node-id="${id}"]`).waitFor({ timeout: 30_000 })
    await page.waitForTimeout(500)
    expect({
      left: await node.evaluate(el => (el as HTMLElement).style.left),
      top: await node.evaluate(el => (el as HTMLElement).style.top),
    }).toEqual(placed)
    expect(await page.locator('[data-testid="dv-canvas-view"] > div[style*="transform"]').evaluate(el => (el as HTMLElement).style.transform)).toBe(transform)
    expect(page.errors).toEqual([])
  })

  it('clicking a node opens the floating editor; ✕ and Escape close it', async () => {
    const project = await seedProject('canvas-editor')
    const page = await openPage()
    await gotoProject(page, project.id)
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    await page.locator('[data-node-kind="take"]').first().click()
    await expect.poll(() => editor.count()).toBe(1)
    // The take editor names the render mode of the take's record.
    expect(await editor.locator('[data-testid="dv-canvas-render-mode"]').textContent()).toBe('参考图生成')
    await editor.getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => editor.count()).toBe(0)
    await page.locator('[data-node-kind="take"]').first().click()
    await page.locator('#dv-canvas-editor-prompt').click()
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
    await page.locator('[data-node-kind="bible"]').first().click()
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    await expect.poll(() => editor.count()).toBe(1)
    const frame = await page.locator('[data-testid="dv-canvas-view"]').boundingBox()
    if (frame === null) throw new Error('canvas has no box')
    // The bottom-right corner of the canvas holds no node, no editor, and no toolbar.
    await page.mouse.click(frame.x + frame.width - 20, frame.y + frame.height - 20)
    await expect.poll(() => editor.count(), { timeout: 2000 }).toBe(0)
  })

  it('a wheel over an open plan editor scrolls the editor and leaves the canvas alone; a wheel over empty canvas zooms', async () => {
    const project = await seedProject('canvas-editor-wheel')
    const v1 = (await stateOf(project.id)).components.plan.plans['p1']?.[0]
    if (v1 === undefined) throw new Error('the seeded plan is not p1')
    // An unapproved v2 with 40 shots makes the plan editor taller than the canvas.
    await runOperation(project.id, 'plan.update', {
      plan: 'p1', title: v1.title, references: v1.references,
      shots: Array.from({ length: 40 }, (_, index) => ({
        prompt: `canvas-editor-wheel shot ${String(index + 1)}`, duration_sec: 1, mode: 'ref2va',
      })),
    })
    const page = await openPage()
    await gotoProject(page, project.id)
    await fitCanvas(page)
    const plan = page.locator('[data-node-kind="plan"]')
    await expect.poll(() => plan.textContent()).toContain('v2')
    await plan.click()
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    await expect.poll(() => editor.count()).toBe(1)
    const scroll = await editor.evaluate(el => ({ top: el.scrollTop, scrollable: el.scrollHeight - el.clientHeight > 200 }))
    expect(scroll).toEqual({ top: 0, scrollable: true })
    // The editor is also a transformed direct child of the canvas; the pan-and-zoom surface comes first.
    const surface = page.locator('[data-testid="dv-canvas-view"] > div[style*="transform"]').first()
    const transform = async (): Promise<string> => await surface.evaluate(el => (el as HTMLElement).style.transform)
    const before = await transform()
    const box = await editor.boundingBox()
    if (box === null) throw new Error('editor has no box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 300)
    await expect.poll(() => editor.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    expect(await transform()).toBe(before)
    const frame = await page.locator('[data-testid="dv-canvas-view"]').boundingBox()
    if (frame === null) throw new Error('canvas has no box')
    // The tall editor leaves a 16 px margin; the bottom-right corner of that margin holds no node, no editor, and no toolbar.
    await page.mouse.move(frame.x + frame.width - 8, frame.y + frame.height - 8)
    await page.mouse.wheel(0, -200)
    await expect.poll(transform).not.toBe(before)
    expect(page.errors).toEqual([])
  })

  it('switching to the timeline and back, or to another project, leaves no editor behind', async () => {
    const first = await seedProject('canvas-leave-a')
    const second = await seedProject('canvas-leave-b', 2)
    const page = await openPage()
    await gotoProject(page, first.id)
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    await page.locator('[data-node-kind="take"]').first().click()
    await expect.poll(() => editor.count()).toBe(1)
    await viewToggle(page, '时间线').click()
    await page.locator('[data-testid="dv-timeline-editor"]').waitFor()
    expect(await editor.count()).toBe(0)
    await viewToggle(page, '画布').click()
    await page.locator('[data-node-id]').first().waitFor()
    expect(await editor.count()).toBe(0)
    await page.locator('[data-node-kind="take"]').first().click()
    await expect.poll(() => editor.count()).toBe(1)
    await page.getByText('canvas-leave-b', { exact: true }).first().click()
    await expect.poll(() => page.locator('[data-dv-workspace] header').first().textContent()).toContain('canvas-leave-b')
    expect(await editor.count()).toBe(0)
    expect(page.url()).toContain(second.id)
  })

  it('the take editor plays the take', async () => {
    const project = await seedProject('canvas-play', 2)
    const page = await openPage()
    await gotoProject(page, project.id)
    await page.locator('[data-node-kind="take"]').first().click()
    const video = page.locator('[data-testid="dv-canvas-node-editor"] video')
    await video.waitFor()
    await expect.poll(
      () => video.evaluate(el => ({ error: (el as HTMLVideoElement).error?.code ?? 0, moving: (el as HTMLVideoElement).currentTime > 0 })),
      { timeout: 10_000 },
    )
      .toEqual({ error: 0, moving: true })
  })

  it('渲染新版本 adds a take linked to the original by a take edge', async () => {
    const project = await seedProject('canvas-take', 2)
    const page = await openPage()
    await gotoProject(page, project.id)
    const takes = page.locator('[data-node-kind="take"]')
    await expect.poll(() => takes.count()).toBe(2)
    const original = await takes.first().getAttribute('data-node-id') ?? ''
    await takes.first().click()
    await page.locator('#dv-canvas-editor-prompt').fill('canvas-take shot 1, take two')
    const requests = harness.backend.requests.length
    await page.getByRole('button', { name: '渲染新版本' }).click()
    await expect.poll(() => page.locator('[data-testid="dv-canvas-node-editor"]').count()).toBe(0)
    await expect.poll(() => takes.count(), { timeout: 30_000 }).toBe(3)
    await expect.poll(() => harness.backend.requests.length, { timeout: 30_000 }).toBe(requests + 1)
    const retake = await waitFor(async () => {
      const latest = (await stateOf(project.id)).components.proj.records.filter(record => record.operation === RENDER_OPERATION).at(-1)
      return latest?.status === 'done' ? latest : null
    }, 'the new take renders')
    expect(await page.locator(`path[data-edge="${original}>${retake?.id ?? ''}"]`).count()).toBe(1)
  })

  it('the original take and its new take are told apart on the canvas', async () => {
    const project = await seedProject('canvas-take-names', 2)
    const page = await openPage()
    await gotoProject(page, project.id)
    const takes = page.locator('[data-node-kind="take"]')
    await takes.first().click()
    await page.locator('#dv-canvas-editor-prompt').fill('canvas-take-names shot 1, take two')
    await page.getByRole('button', { name: '渲染新版本' }).click()
    await expect.poll(() => takes.count(), { timeout: 30_000 }).toBe(3)
    // Two cards that both read 镜头 1 leave the creator guessing which is the new version.
    const titles = await takes.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('a plan updated from 2 to 3 shots stays one plan node with v1 and v2, renders only 镜头 3, and the timeline reuses the first two takes', async () => {
    const project = await seedProject('canvas-plan-versions', 2)
    const v1 = (await stateOf(project.id)).components.plan.plans['p1']?.[0]
    if (v1 === undefined) throw new Error('the seeded plan is not p1')
    // Shot 3 continues shot 2, so its render starts from the last still of shot 2's take.
    await runOperation(project.id, 'plan.update', {
      plan: 'p1', title: v1.title, references: v1.references,
      shots: [...v1.shots, { prompt: 'canvas-plan-versions shot 3', duration_sec: 1, mode: 'ref2va', continue_previous: true }],
    })
    await runOperation(project.id, 'plan.approve', { plan: 'p1' })
    const state = await waitFor(async () => {
      const current = await stateOf(project.id)
      const done = current.components.proj.records.filter(record => record.operation === RENDER_OPERATION && record.status === 'done')
      return done.length === 3 && (current.components.timeline.timelines[0]?.clips.length ?? 0) === 3 ? current : null
    }, 'shot 3 of plan p1 v2 renders onto timeline t1', 120_000)
    // The approval of v2 renders only the added shot and puts all three takes on the plan's one timeline.
    expect(state.components.timeline.timelines.map(timeline => timeline.id)).toEqual(['t1'])
    expect(state.components.timeline.timelines[0]?.clips.map(clip => clip.asset).slice(0, 2)).toEqual(project.clipAssets)
    const renders = state.components.proj.records.filter(record => record.operation === RENDER_OPERATION)
    expect(renders.map(record => [record.params['plan'], record.params['plan_version'], record.params['shot']])).toEqual([
      ['p1', 1, 1], ['p1', 1, 2], ['p1', 2, 3],
    ])
    const firstFrames = (render: ProjectRecord | undefined): unknown[] =>
      (render?.inputs ?? []).filter(input => input.role === 'first_frame').map(input => input.ref)
    expect(firstFrames(renders[2])).toEqual([{ record: renders[1]?.id, output: 1 }])
    expect(firstFrames(renders[1])).toEqual([])
    const page = await openPage()
    await gotoProject(page, project.id)
    const plans = page.locator('[data-node-kind="plan"]')
    await expect.poll(() => plans.count()).toBe(1)
    expect(await plans.getAttribute('data-node-id')).toBe('plan:p1')
    expect(await plans.textContent()).toContain('v2')
    const takes = page.locator('[data-node-kind="take"]')
    await expect.poll(() => takes.count()).toBe(3)
    expect(await takes.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['镜头 1', '镜头 2', '镜头 3'])
    // Each take hangs off the one plan node.
    for (const render of renders) expect(await page.locator(`path[data-edge="plan:p1>${render.id}"]`).count()).toBe(1)
    await plans.click()
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    const versions = editor.getByRole('group', { name: '分镜计划版次' }).getByRole('button')
    expect(await versions.allTextContents()).toEqual(['v1', 'v2'])
    expect(await editor.getByRole('button', { name: 'v2' }).getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => editor.locator('ol > li').count()).toBe(3)
    // Each shot names its render mode; the continuing shot says so.
    expect(await editor.locator('[data-testid="dv-canvas-shot-mode"]').allTextContents()).toEqual(['参考图生成', '参考图生成', '参考图生成 · 接上一镜头'])
    await editor.getByRole('button', { name: 'v1' }).click()
    await expect.poll(() => editor.locator('ol > li').count()).toBe(2)
    expect(page.errors).toEqual([])
  })

  it('the canvas shows only the current plan version and its takes; a jump back shows that step\'s version again', async () => {
    const project = await seedProject('canvas-current', 3)
    const v1 = (await stateOf(project.id)).components.plan.plans['p1']?.[0]
    if (v1 === undefined) throw new Error('the seeded plan is not p1')
    const base = { plan: 'p1', title: v1.title, references: v1.references }
    const added = [...v1.shots, { prompt: 'canvas-current shot 4', duration_sec: 1, mode: 'ref2va' }]
    // v2 adds shot 4 and is approved; v3 changes shot 2 and is never approved; v4 returns to the three v1 shots.
    await runOperation(project.id, 'plan.update', { ...base, shots: added })
    await runOperation(project.id, 'plan.approve', { plan: 'p1' })
    const v2State = await waitFor(async () => {
      const current = await stateOf(project.id)
      const clips = current.components.timeline.timelines[0]?.clips ?? []
      return clips.length === 4 && clips.every(clip => clip.asset !== null) ? current : null
    }, 'shot 4 of plan p1 v2 renders onto timeline t1', 120_000)
    const v2Layout = v2State.components.proj.records.findLast(record => record.operation === 'timeline.update')
    const shot4 = v2State.components.proj.records.find(record => record.operation === RENDER_OPERATION && record.params['shot'] === 4)
    if (v2Layout === undefined || shot4 === undefined) throw new Error('the v2 approval wrote no timeline update or shot 4 render')
    await runOperation(project.id, 'plan.update', { ...base, shots: added.map((shot, index) => index === 1 ? { ...shot, prompt: 'canvas-current shot 2, closer' } : shot) })
    await runOperation(project.id, 'plan.update', { ...base, shots: v1.shots })
    await runOperation(project.id, 'plan.approve', { plan: 'p1' })
    await waitFor(async () => {
      const clips = (await stateOf(project.id)).components.timeline.timelines[0]?.clips ?? []
      return clips.length === 3 ? clips : null
    }, 'the v4 approval lays the three v1 takes on timeline t1')
    const page = await openPage()
    await gotoProject(page, project.id)
    const plans = page.locator('[data-node-kind="plan"]')
    const takes = page.locator('[data-node-kind="take"]')
    await expect.poll(() => plans.textContent()).toContain('v4')
    // v4 reuses the v1 takes: three takes, no take of the removed shot 4.
    await expect.poll(() => takes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-node-id')))).toEqual(project.shots)
    expect(await takes.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['镜头 1', '镜头 2', '镜头 3'])
    await plans.click()
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    await editor.getByRole('button', { name: 'v3' }).click()
    await expect.poll(() => editor.getByText('已被 v4 取代').count()).toBe(1)
    expect(await editor.getByText('待批准').count()).toBe(0)
    await page.keyboard.press('Escape')
    // A jump back to the v2 approval's timeline update shows plan v2 and its four takes again.
    await harness.api.post('/api/dv/undo', { project: project.id, surface: 'canvas', to: v2Layout.id })
    await expect.poll(() => plans.textContent(), { timeout: 15_000 }).toContain('v2')
    await expect.poll(() => takes.count()).toBe(4)
    expect(await page.locator(`[data-node-id="${shot4.id}"]`).count()).toBe(1)
    expect(page.errors).toEqual([])
  })

  it('让智能体改 prefills the chat with a reference to the node and closes the editor', async () => {
    const project = await seedProject('canvas-ask', 2)
    const page = await openPage()
    await gotoProject(page, project.id)
    await page.locator('[data-node-kind="take"]').first().click()
    await page.getByRole('button', { name: '让智能体改' }).click()
    await expect.poll(() => page.locator('[data-testid="dv-canvas-node-editor"]').count()).toBe(0)
    await expect.poll(() => page.locator('[data-dv-chat] [contenteditable="true"]').first().innerText(), { timeout: 10_000 }).toContain('镜头 1')
  })

  it('the canvas follows the light and the dark theme', async () => {
    const project = await seedProject('canvas-theme', 2)
    const light = await openPage({ scheme: 'light' })
    await gotoProject(light, project.id)
    expect(luminance(await backgroundOf(light.locator('[data-testid="dv-canvas-view"]')))).toBeGreaterThan(0.8)
    expect(luminance(await backgroundOf(light.locator('[data-node-kind="take"]').first()))).toBeGreaterThan(0.8)
    const dark = await openPage({ scheme: 'dark' })
    await gotoProject(dark, project.id)
    expect(luminance(await backgroundOf(dark.locator('[data-testid="dv-canvas-view"]')))).toBeLessThan(0.25)
    expect(luminance(await backgroundOf(dark.locator('[data-node-kind="take"]').first()))).toBeLessThan(0.3)
  })

  it('at fit zoom node text is readable and cards do not overlap, also after a trim badge', async () => {
    const project = await seedProject('canvas-readable', 3)
    // A split marks clip 2 as trimmed, which adds a badge row to its card.
    await runOperation(project.id, 'timeline.clip_split', { clip: await clipAt(project.id, 2), at_sec: 0.5 })
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
    const outside = await page.locator('[data-testid="dv-canvas-view"]').evaluate((canvas) => {
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
    await expect.poll(() => page.locator('[data-node-kind="take"]').count(), { timeout: 30_000 }).toBe(22)
    await fitCanvas(page)
    expect(await overlappingNodes(page)).toEqual([])
    const outside = await page.locator('[data-testid="dv-canvas-view"]').evaluate((canvas) => {
      const frame = canvas.getBoundingClientRect()
      return [...canvas.querySelectorAll('[data-node-id]')].filter((node) => {
        const box = node.getBoundingClientRect()
        return box.left < frame.left || box.right > frame.right || box.top < frame.top || box.bottom > frame.bottom
      }).length
    })
    expect(outside).toBe(0)
  })

  it('an empty project shows the empty-canvas hint and no stray controls', async () => {
    const created = await harness.api.post('/api/dv/projects', { title: 'canvas-empty', surface: 'canvas' }) as { id: string }
    const page = await openPage()
    await gotoProject(page, created.id)
    await expect.poll(() => page.locator('[data-testid="dv-canvas-view"]').innerText()).toContain('画布还是空的')
    expect(await page.locator('[data-node-id]').count()).toBe(0)
  })

  it('takes whose character changed are drawn stale (red) on the canvas and their clips on the track until the creator keeps them', async () => {
    const project = await seedProject('canvas-stale', 2)
    const state = await stateOf(project.id)
    const frame = state.assets.find(asset => asset.mime.startsWith('image/') && asset.name !== 'ref.png')
    await runOperation(project.id, 'bible.character_update', { character: 'c1' }, [{ role: 'reference', ref: frame?.id ?? '' }])
    const page = await openPage()
    await gotoProject(page, project.id)
    const staleTakes = page.locator('[data-node-kind="take"][data-node-stale="true"]')
    await expect.poll(() => staleTakes.count()).toBe(2)
    const border = await staleTakes.first().evaluate(el => getComputedStyle(el).borderTopColor)
    const [r = 0, g = 0, b = 0] = border.match(/\d+/g)?.map(Number) ?? []
    expect(r).toBeGreaterThan(150)
    expect(g + b).toBeLessThan(r)
    await viewToggle(page, '时间线').click()
    await expect.poll(() => page.locator('[data-clip-stale="true"]').count()).toBe(2)
    // Keeping both takes (proj.stale_accept) clears the marks on the track and, back on the canvas, on the take nodes.
    for (const shot of project.shots) {
      await harness.api.post('/api/dv/stale/accept', { project: project.id, record: shot, surface: 'canvas' })
    }
    await expect.poll(() => page.locator('[data-clip-stale="true"]').count()).toBe(0)
    await viewToggle(page, '画布').click()
    await expect.poll(() => page.locator('[data-node-stale="true"]').count()).toBe(0)
  })

  it('a draft draws dashed nodes with an accept bar; accepting makes them solid', async () => {
    const project = await seedProject('canvas-draft', 2)
    model.rules.push({
      match: 'draft-shot-please',
      steps: [{ calls: [{ name: 'dv_shot_render_ref2va', args: {
        reason: 'draft shot', project_id: project.id, prompt: 'canvas-draft extra shot', duration_sec: 1, inputs: { reference: ['c1@1'] },
      } }] }],
      endText: '草稿待确认',
    })
    const page = await openPage()
    await gotoProject(page, project.id)
    const composer = page.locator('[data-dv-chat] [contenteditable="true"]').first()
    await composer.waitFor({ timeout: 30_000 })
    await composer.click()
    await page.keyboard.type('draft-shot-please')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('[data-node-draft="true"]').count(), { timeout: 60_000 }).toBeGreaterThan(0)
    const outline = await page.locator('[data-node-draft="true"]').first().evaluate(el => getComputedStyle(el).outlineStyle)
    expect(outline).toBe('dashed')
    await page.locator('[data-testid="dv-canvas-view"] button', { hasText: '接受' }).first().click()
    await expect.poll(() => page.locator('[data-node-draft="true"]').count(), { timeout: 15_000 }).toBe(0)
    expect(await page.locator('[data-node-kind="take"]').count()).toBe(3)
  })

  it('dragging an image tile from 素材库 onto the canvas places it on the canvas', async () => {
    const project = await seedProject('canvas-drop', 2)
    const extra = await runOperation(project.id, 'asset.import', { base64: PNG_BASE64, mime: 'image/png', name: 'extra.png' })
    const page = await openPage()
    await gotoProject(page, project.id)
    await openAssets(page)
    const nodes = await page.locator('[data-node-id]').count()
    const canvas = page.locator('[data-testid="dv-canvas-view"]')
    const frame = await canvas.boundingBox()
    if (frame === null) throw new Error('canvas has no box')
    const tile = page.locator(`[data-asset-id="${extra.outputs[0] ?? ''}"]`)
    // The empty-canvas hint tells the creator to drag references in from 素材库; the canvas must accept the drop.
    const accepted = await canvas.evaluate((element, assetId) => {
      const transfer = new DataTransfer()
      transfer.setData('application/x-dv-asset', assetId)
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
    await page.locator('[data-dv-chat] [contenteditable="true"]').first().waitFor({ timeout: 30_000 })
    const canvas = page.locator('[data-testid="dv-canvas-view"]')
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
    await expect.poll(() => page.locator('[data-node-kind="asset"]').count(), { timeout: 10_000 }).toBe(1)
    // The composer shows a dropped attachment as a chip with its file name; only the canvas notice may name the file.
    await page.waitForTimeout(500)
    const outside = await page.getByText('notes-on-canvas.txt').evaluateAll(nodes => nodes.filter(node => node.closest('[data-testid="dv-canvas-view"]') === null).length)
    expect(outside).toBe(0)
  })
})

describe('timeline stories', () => {
  it('one tab per timeline; switching moves the viewer, playhead, time, and selection with it', async () => {
    const project = await seedProject('timeline-tabs', 3, [2, 0])
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    expect(await timelineTabs(page)).toEqual(['时间线 1*', '时间线 2', '时间线 3'])
    expect(await timelineTime(page)).toEqual([0, 4])
    const ruler = await page.locator('[data-testid="dv-timeline-ruler"]').boundingBox()
    if (ruler === null) throw new Error('ruler has no box')
    await page.mouse.click(ruler.x + 2.5 * await pxPerSecond(page), ruler.y + 10)
    await page.locator('[data-clip-position="2"]').click()
    expect(await trackClips(page)).toEqual(['1', '2*', '3'])
    expect((await timelineTime(page))[0]).toBeCloseTo(2.5, 1)
    await timelineTab(page, '时间线 2').click()
    expect(await timelineTabs(page)).toEqual(['时间线 1', '时间线 2*', '时间线 3'])
    expect(await trackClips(page)).toEqual(['1', '2'])
    await expect.poll(() => timelineTime(page), { timeout: 3000 }).toEqual([0, 3])
    await expect.poll(() => viewerAsset(page)).toBe(project.clipAssets[0])
    await timelineTab(page, '时间线 3').click()
    expect(await trackClips(page)).toEqual([])
    await expect.poll(() => timelineTime(page), { timeout: 3000 }).toEqual([0, 0])
    expect(await viewerAsset(page)).toBeNull()
    await expect.poll(() => page.locator('[data-testid="dv-timeline-viewer-empty"]').count()).toBe(1)
    expect(page.errors).toEqual([])
  })

  it('＋ 新建 adds the next 时间线 N, selects it, and its empty track explains what to do', async () => {
    const project = await seedProject('timeline-new', 2)
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await page.locator('[data-testid="dv-timeline-editor"]').getByRole('button', { name: '＋ 新建' }).click()
    await expect.poll(() => timelineTabs(page)).toEqual(['时间线 1', '时间线 2*'])
    await page.locator('[data-testid="dv-timeline-editor"]').getByRole('button', { name: '＋ 新建' }).click()
    await expect.poll(() => timelineTabs(page)).toEqual(['时间线 1', '时间线 2', '时间线 3*'])
    expect((await stateOf(project.id)).components.timeline.timelines.map(timeline => timeline.name)).toEqual(['', '', ''])
    await expect.poll(() => page.locator('[data-testid="dv-timeline-editor"]').innerText()).toContain('这条时间线还没有片段')
  })

  it('an empty timeline explains what to do once, not twice', async () => {
    const project = await seedProject('timeline-empty-hint', 2, [0])
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await timelineTab(page, '时间线 2').click()
    const text = await page.locator('[data-testid="dv-timeline-editor"]').innerText()
    expect(text.split('这条时间线还没有片段').length - 1).toBe(1)
  })

  it('a timeline created in English is titled 时间线 2 in the Chinese interface', async () => {
    const project = await seedProject('timeline-title-language', 2)
    const english = await openPage({ lang: 'en-US' })
    await gotoProject(english, project.id, 'timeline')
    await english.locator('[data-testid="dv-timeline-editor"] [role="tablist"]').getByRole('button', { name: '＋ New' }).click()
    await expect.poll(() => timelineTabs(english)).toEqual(['Timeline 1', 'Timeline 2*'])
    const chinese = await openPage({ lang: 'zh-CN' })
    await gotoProject(chinese, project.id, 'timeline')
    expect(await timelineTabs(chinese)).toEqual(['时间线 1*', '时间线 2'])
  })

  it('a very short clip can still be selected by clicking its middle at the default zoom', async () => {
    const project = await seedProject('timeline-narrow', 3)
    await runOperation(project.id, 'timeline.clip_trim', { clip: await clipAt(project.id, 1), out_sec: 0.2 })
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    const clip = await page.locator('[data-clip-position="1"]').boundingBox()
    if (clip === null) throw new Error('clip 1 has no box')
    await page.mouse.click(clip.x + clip.width / 2, clip.y + clip.height / 2)
    await expect.poll(() => trackClips(page)).toEqual(['1*', '2', '3'])
  })

  it('a timeline can be renamed by double-clicking its tab', async () => {
    const project = await seedProject('timeline-rename', 2, [1])
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await timelineTab(page, '时间线 2').dblclick()
    const box = page.locator('[data-testid="dv-timeline-editor"] [role="tablist"] input')
    await box.waitFor({ timeout: 3000 })
    await box.fill('片尾')
    await box.press('Enter')
    await expect.poll(() => timelineTabs(page)).toEqual(['时间线 1', '片尾*'])
    await expect.poll(async () => (await stateOf(project.id)).components.timeline.timelines.find(timeline => timeline.id === 't2')?.name).toBe('片尾')
  })

  it('a timeline can be deleted from its tab menu after a confirmation', async () => {
    const project = await seedProject('timeline-delete', 2, [1, 0])
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await timelineTab(page, '时间线 2').click()
    page.once('dialog', (dialog) => { void dialog.accept() })
    await timelineTab(page, '时间线 2').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /删除/ }).click({ timeout: 3000 })
    const confirm = page.getByRole('dialog').getByRole('button', { name: /删除/ })
    if (await confirm.count() > 0) await confirm.click()
    await expect.poll(() => timelineTabs(page)).toEqual(['时间线 1*', '时间线 3'])
    await expect.poll(async () => (await stateOf(project.id)).components.timeline.timelines.map(timeline => timeline.id)).toEqual(['t1', 't3'])
  })

  it('deleting a timeline can be undone from the toolbar', async () => {
    const project = await seedProject('timeline-delete-undo', 2, [1])
    const page = await openPage()
    page.on('dialog', (dialog) => { void dialog.accept() })
    await gotoProject(page, project.id, 'timeline')
    await timelineTab(page, '时间线 2').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /删除/ }).click()
    const confirm = page.getByRole('dialog').getByRole('button', { name: /删除/ })
    if (await confirm.count() > 0) await confirm.click()
    await expect.poll(() => timelineTabs(page)).toEqual(['时间线 1*'])
    const undo = page.getByRole('button', { name: '撤销' })
    await expect.poll(() => undo.isEnabled()).toBe(true)
    await undo.click()
    await expect.poll(() => timelineTabs(page)).toContain('时间线 2')
    expect((await stateOf(project.id)).components.timeline.timelines.map(timeline => timeline.id)).toEqual(['t1', 't2'])
  })

  it('deleting the last timeline leaves an honest empty state', async () => {
    const project = await seedProject('timeline-delete-last', 2)
    const page = await openPage()
    page.on('dialog', (dialog) => { void dialog.accept() })
    await gotoProject(page, project.id, 'timeline')
    await timelineTab(page, '时间线 1').click({ button: 'right' })
    const remove = page.getByRole('menuitem', { name: /删除/ })
    // Refusing to delete the only timeline is also acceptable.
    if (await remove.count() === 0) return
    await remove.click()
    const confirm = page.getByRole('dialog').getByRole('button', { name: /删除/ })
    if (await confirm.count() > 0) await confirm.click()
    await expect.poll(() => timelineTabs(page)).toEqual([])
    // With no timeline, nothing may talk about "this timeline" (这条时间线) or offer a disabled ＋; ＋ 新建 is the way forward.
    const text = await page.locator('[data-testid="dv-timeline-editor"]').innerText()
    expect(text).not.toContain('这条时间线')
    expect(await page.locator('[data-testid="dv-timeline-editor"]').getByRole('button', { name: '＋ 新建' }).isEnabled()).toBe(true)
  })

  it('play runs the whole timeline continuously across its clips to the end', async () => {
    const project = await seedProject('timeline-play', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await expect.poll(() => viewerAsset(page)).toBe(project.clipAssets[0])
    await page.getByRole('button', { name: '播放' }).click()
    const shown = new Set<string>()
    const started = Date.now()
    for (;;) {
      const asset = await viewerAsset(page)
      if (asset !== null) shown.add(asset)
      const [position, total] = await timelineTime(page)
      if (position >= total - 0.05 || Date.now() - started > 12_000) break
      await page.waitForTimeout(100)
    }
    // Four seconds of clips play in about four seconds and every clip appears in the viewer on the way.
    const players = await page.locator('[data-testid="dv-timeline-viewer"] video').evaluateAll(videos => videos.map((video) => {
      const element = video as HTMLVideoElement
      return `${element.style.visibility}:${String(element.currentTime)}:${element.paused ? 'paused' : 'playing'}:ready=${String(element.readyState)}:error=${String(element.error?.code ?? 0)}`
    }).join(' | '))
    expect(await timelineTime(page), players).toEqual([4, 4])
    expect(Date.now() - started).toBeLessThan(9000)
    expect([...shown].sort()).toEqual([...new Set(project.clipAssets)].sort())
    await expect.poll(() => page.getByRole('button', { name: '播放' }).count(), { timeout: 2000 }).toBe(1)
  })

  it('scrubbing the ruler moves the playhead, the time, and the viewer frame', async () => {
    const project = await seedProject('timeline-scrub', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    const ruler = await page.locator('[data-testid="dv-timeline-ruler"]').boundingBox()
    if (ruler === null) throw new Error('ruler has no box')
    const px = await pxPerSecond(page)
    await page.mouse.move(ruler.x + 0.2 * px, ruler.y + 10)
    await page.mouse.down()
    await page.mouse.move(ruler.x + 1.6 * px, ruler.y + 10, { steps: 6 })
    await page.mouse.up()
    expect((await timelineTime(page))[0]).toBeCloseTo(1.6, 1)
    const playhead = await page.locator('[data-testid="dv-timeline-playhead"]').boundingBox()
    expect(Math.abs((playhead?.x ?? 0) - (ruler.x + 1.6 * px))).toBeLessThan(4)
    await expect.poll(() => viewerAsset(page)).toBe(project.clipAssets[1])
  })

  it('split at the playhead, trim by the edges, reorder by drag, and Delete each edit the timeline once', async () => {
    const project = await seedProject('timeline-edit', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await page.getByRole('button', { name: '适配' }).click()
    const px = await pxPerSecond(page)
    const ruler = await page.locator('[data-testid="dv-timeline-ruler"]').boundingBox()
    if (ruler === null) throw new Error('ruler has no box')
    const [a, b, c] = project.clipAssets.map(id => id.slice(0, 8))
    // Clip 2 spans 1 s to 3 s; splitting at 2 s makes two 1-second halves.
    await page.mouse.click(ruler.x + 2 * px, ruler.y + 10)
    await page.getByRole('button', { name: '拆分' }).click()
    await expect.poll(() => timelineClips(project.id)).toEqual([`${a ?? ''}[-]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`, `${c ?? ''}[-]`])
    await expect.poll(() => trackClips(page)).toHaveLength(4)
    // Drag the end edge of clip 1 left by 0.5 s.
    const first = await page.locator('[data-clip-position="1"]').boundingBox()
    if (first === null) throw new Error('clip 1 has no box')
    await page.mouse.move(first.x + first.width - 3, first.y + 20)
    await page.mouse.down()
    await page.mouse.move(first.x + first.width - 3 - 0.5 * px, first.y + 20, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => timelineClips(project.id)).toEqual([`${a ?? ''}[-0.5]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`, `${c ?? ''}[-]`])
    // The track redraws after the refetch; the next drag needs the shortened layout (3.5 s in total).
    await expect.poll(async () => (await timelineTime(page))[1]).toBeCloseTo(3.5, 1)
    // Drag the start edge of the last clip right by 0.25 s.
    const last = await page.locator('[data-clip-position="4"]').boundingBox()
    if (last === null) throw new Error('clip 4 has no box')
    await page.mouse.move(last.x + 3, last.y + 20)
    await page.mouse.down()
    await page.mouse.move(last.x + 3 + 0.25 * px, last.y + 20, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => timelineClips(project.id)).toEqual([`${a ?? ''}[-0.5]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`, `${c ?? ''}[0.25-]`])
    await expect.poll(async () => (await timelineTime(page))[1]).toBeCloseTo(3.25, 1)
    // Drag clip 4 by its body to the front.
    const moving = await page.locator('[data-clip-position="4"]').boundingBox()
    const target = await page.locator('[data-clip-position="1"]').boundingBox()
    if (moving === null || target === null) throw new Error('clip has no box')
    await page.mouse.move(moving.x + moving.width / 2, moving.y + 30)
    await page.mouse.down()
    await page.mouse.move(target.x + 2, moving.y + 30, { steps: 10 })
    await page.mouse.up()
    await expect.poll(() => timelineClips(project.id)).toEqual([`${c ?? ''}[0.25-]`, `${a ?? ''}[-0.5]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`])
    // The track redraws after the refetch; a click before that lands on the clip that was at the position before the move.
    const movedOrder = (await stateOf(project.id)).components.timeline.timelines[0]?.clips.map(clip => clip.id)
    await expect.poll(() => trackClipIds(page)).toEqual(movedOrder)
    // After the move, only the moved clip (now at position 1) may be selected.
    expect((await trackClips(page)).filter(position => position.endsWith('*') && position !== '1*')).toEqual([])
    // Select clip 2 and press Delete.
    await page.locator('[data-clip-position="2"]').click()
    await page.keyboard.press('Delete')
    await expect.poll(() => timelineClips(project.id)).toEqual([`${c ?? ''}[0.25-]`, `${b ?? ''}[-1]`, `${b ?? ''}[1-]`])
    await expect.poll(() => trackClips(page)).toEqual(['1', '2', '3'])
    expect(page.errors).toEqual([])
  })

  it('＋ inserts a picked asset at the end of the timeline', async () => {
    const project = await seedProject('timeline-plus', 2, [0])
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await timelineTab(page, '时间线 2').click()
    await page.getByRole('button', { name: '插入片段' }).click()
    const picker = page.getByRole('dialog', { name: '选一个素材插入到末尾' })
    await picker.waitFor()
    await picker.getByRole('button').first().click()
    await expect.poll(() => picker.count()).toBe(0)
    await expect.poll(async () => (await timelineClips(project.id, 't2')).length).toBe(1)
    await expect.poll(() => trackClips(page)).toEqual(['1'])
    expect(await timelineClips(project.id, 't1')).toHaveLength(2)
  })

  it('dragging a video tile from 素材库 onto the track inserts it where it is dropped', async () => {
    const project = await seedProject('timeline-drop', 2)
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await openAssets(page)
    const track = page.locator('[data-testid="dv-timeline-editor"] [role="list"]')
    await page.locator(`[data-asset-id="${project.clipAssets[1] ?? ''}"]`).dragTo(track, { targetPosition: { x: 4, y: 30 } })
    await expect.poll(() => timelineClips(project.id)).toEqual([project.clipAssets[1], project.clipAssets[0], project.clipAssets[1]].map(id => `${(id ?? '').slice(0, 8)}[-]`))
  })

  it('插入片段 in the 素材库 preview adds the clip to the open timeline', async () => {
    const project = await seedProject('timeline-add-from-preview', 2, [0])
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await timelineTab(page, '时间线 2').click()
    await openAssets(page)
    await page.locator(`[data-asset-id="${project.clipAssets[0] ?? ''}"]`).click()
    await page.getByRole('dialog').getByRole('button', { name: '插入片段' }).click()
    await expect.poll(() => timelineClips(project.id, 't2'), { timeout: 5000 }).toEqual([`${(project.clipAssets[0] ?? '').slice(0, 8)}[-]`])
    await expect.poll(() => trackClips(page)).toEqual(['1'])
  })

  it('undo reverts the last edit and redo brings it back', async () => {
    const project = await seedProject('timeline-undo', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    const original = await timelineClips(project.id)
    await page.locator('[data-clip-position="1"]').click()
    await page.keyboard.press('Delete')
    await expect.poll(() => timelineClips(project.id)).toHaveLength(2)
    const edited = await timelineClips(project.id)
    await page.getByRole('button', { name: '撤销' }).click()
    await expect.poll(() => timelineClips(project.id)).toEqual(original)
    await expect.poll(() => trackClips(page)).toHaveLength(3)
    const redo = page.getByRole('button', { name: '重做' })
    expect(await redo.isEnabled()).toBe(true)
    await redo.click()
    await expect.poll(() => timelineClips(project.id)).toEqual(edited)
  })

  it('export produces one playable video as long as the timeline', async () => {
    const project = await seedProject('timeline-export', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await page.getByRole('button', { name: '导出' }).click()
    const link = page.locator('[data-testid="dv-timeline-exported"]')
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
    // The export link belongs to this timeline only.
    await page.locator('[data-testid="dv-timeline-editor"]').getByRole('button', { name: '＋ 新建' }).click()
    await expect.poll(() => link.count()).toBe(0)
  })

  it('an approved 3-shot plan shows 3 placeholder clips at once, each becomes playable as its render finishes, and export waits for all', async () => {
    const created = await harness.api.post('/api/dv/projects', { title: 'timeline-pending', surface: 'canvas' }) as { id: string }
    const project = created.id
    const imported = await runOperation(project, 'asset.import', { base64: PNG_BASE64, mime: 'image/png', name: 'ref.png' })
    await runOperation(project, 'bible.character_create', { character: 'c1', name: 'Dancer' }, [{ role: 'reference', ref: imported.outputs[0] ?? '' }])
    const plan = await runOperation(project, 'plan.create', {
      title: 'timeline-pending', references: ['c1@1'],
      shots: [1, 2, 3].map(shot => ({ prompt: `timeline-pending shot ${String(shot)}`, duration_sec: shot === 2 ? 2 : 1, mode: 'ref2va' })),
    })
    harness.backend.hold()
    try {
      await runOperation(project, 'plan.approve', { plan: plan.report?.['plan'] })
      // The approval puts all three shots on timeline t1 right away, as placeholders of their running renders.
      const pending = await stateOf(project)
      expect(pending.components.timeline.timelines[0]?.clips.map(clip => clip.asset)).toEqual([null, null, null])
      const page = await openPage()
      await gotoProject(page, project)
      const takes = page.locator('[data-node-kind="take"]')
      await expect.poll(() => takes.count()).toBe(3)
      expect(await takes.allTextContents()).toEqual([expect.stringContaining('渲染中…'), expect.stringContaining('渲染中…'), expect.stringContaining('渲染中…')])
      await viewToggle(page, '时间线').click()
      const status = (): Promise<string[]> => page.locator('[data-clip-position]').evaluateAll(clips => clips.map(clip => clip.getAttribute('data-clip-status') ?? ''))
      await expect.poll(status).toEqual(['rendering', 'rendering', 'rendering'])
      // Each placeholder keeps the length of its shot, so the timeline is as long as the plan.
      expect((await timelineTime(page))[1]).toBeCloseTo(4, 1)
      expect(await page.locator('[data-clip-position="1"]').getAttribute('title')).toContain('渲染中…')
      expect(await page.locator('[data-clip-position="1"] [data-trim]').count()).toBe(0)
      expect(await page.locator('[data-testid="dv-timeline-viewer-placeholder"]').textContent()).toBe('片段 1：渲染中…')
      const exportButton = page.getByRole('button', { name: '导出' })
      expect(await exportButton.isDisabled()).toBe(true)
      expect(await page.locator('[data-testid="dv-timeline-export-waiting"]').textContent()).toBe('片段 1, 2, 3 还没就绪，全部就绪后才能导出')
      // Deliver refuses the export too, naming the clips that are not ready.
      const refused = await harness.api.post('/api/dv/operation', {
        project, operation: 'deliver.timeline_export', params: { timeline: 't1' }, inputs: [], surface: 'timeline', intent: 'export early',
      }).then(() => '', (error: unknown) => String(error))
      expect(refused).toContain('Clips 1, 2, 3 of timeline t1 are not ready yet.')
      // Each finished render turns its placeholder into a clip the viewer plays; the others stay placeholders.
      for (let finished = 1; finished <= 3; finished += 1) {
        harness.backend.release()
        await expect.poll(async () => (await status()).filter(entry => entry === 'ready').length, { timeout: 60_000 }).toBe(finished)
        const clips = (await stateOf(project)).components.timeline.timelines[0]?.clips ?? []
        const ready = (await status()).flatMap((entry, index) => entry === 'ready' ? [index] : [])
        for (const index of ready) {
          const clip = page.locator(`[data-clip-position="${String(index + 1)}"]`)
          const box = await clip.boundingBox()
          const ruler = await page.locator('[data-testid="dv-timeline-ruler"]').boundingBox()
          if (box === null || ruler === null) throw new Error(`clip ${String(index + 1)} or the ruler is not on screen`)
          await page.mouse.click(box.x + box.width / 2, ruler.y + ruler.height / 2)
          await expect.poll(() => viewerAsset(page)).toBe(clips[index]?.asset)
        }
        expect(await exportButton.isDisabled()).toBe(finished < 3)
      }
      expect(await page.locator('[data-testid="dv-timeline-export-waiting"]').count()).toBe(0)
      expect((await timelineTime(page))[1]).toBeCloseTo(4, 1)
      await exportButton.click()
      await page.locator('[data-testid="dv-timeline-exported"]').waitFor({ timeout: 60_000 })
      expect(page.errors).toEqual([])
    } finally {
      harness.backend.releaseAll()
    }
  })

  it('a timeline the agent creates appears as a tab without moving the creator off the open timeline', async () => {
    const project = await seedProject('timeline-agent', 2, [1])
    model.rules.push({ match: 'make-timeline-four', steps: [{ calls: [{ name: 'dv_timeline_create', args: { reason: '新建时间线 4', project_id: project.id, timeline: 't4', assets: [] } }] }] })
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await timelineTab(page, '时间线 2').click()
    await page.locator('[data-clip-position="1"]').click()
    const composer = page.locator('[data-dv-chat] [contenteditable="true"]').first()
    await composer.waitFor({ timeout: 30_000 })
    await composer.click()
    await page.keyboard.type('make-timeline-four')
    await page.keyboard.press('Enter')
    await expect.poll(() => timelineTabs(page), { timeout: 60_000 }).toEqual(['时间线 1', '时间线 2*', '时间线 4'])
    expect(await trackClips(page)).toEqual(['1*'])
  })

  it('an edit from elsewhere does not move the selection onto a different clip', async () => {
    const project = await seedProject('timeline-external', 3)
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await page.locator('[data-clip-position="2"]').click()
    const selectedAsset = project.clipAssets[1]
    await runOperation(project.id, 'timeline.clip_remove', { clip: await clipAt(project.id, 1) })
    await expect.poll(() => trackClips(page)).toHaveLength(2)
    // Whatever stays selected must be the clip the creator picked, so Delete cannot remove a clip they never chose.
    const selected = await page.locator('[data-clip-position][aria-pressed="true"]').evaluateAll(clips => clips.map(clip => clip.getAttribute('aria-label') ?? ''))
    const clips = (await stateOf(project.id)).components.timeline.timelines[0]?.clips ?? []
    for (const label of selected) {
      const position = Number(/(\d+)/.exec(label)?.[1])
      expect(clips[position - 1]?.asset).toBe(selectedAsset)
    }
  })

  it('the selected timeline survives canvas ↔ timeline switches and a reload', async () => {
    const project = await seedProject('timeline-location', 2, [1, 0])
    const page = await openPage()
    await gotoProject(page, project.id, 'timeline')
    await timelineTab(page, '时间线 2').click()
    for (let round = 0; round < 3; round += 1) {
      await viewToggle(page, '画布').click()
      await page.locator('[data-testid="dv-canvas-view"]').waitFor()
      await viewToggle(page, '时间线').click()
      await page.locator('[data-testid="dv-timeline-editor"]').waitFor()
    }
    expect(await timelineTabs(page)).toEqual(['时间线 1', '时间线 2*', '时间线 3'])
    await page.reload({ waitUntil: 'load' })
    await page.locator('[data-testid="dv-timeline-editor"] [role="tab"]').first().waitFor({ timeout: 30_000 })
    await expect.poll(() => timelineTabs(page), { timeout: 5000 }).toEqual(['时间线 1', '时间线 2*', '时间线 3'])
    expect(await trackClips(page)).toEqual(['1'])
    expect(page.errors).toEqual([])
  })

  it('the timeline editor follows the light theme of the app', async () => {
    const project = await seedProject('timeline-theme', 2)
    const page = await openPage({ scheme: 'light' })
    await gotoProject(page, project.id, 'timeline')
    // The track area and toolbar sit on the app's light surface; only the video viewer stays black.
    expect(luminance(await backgroundOf(page.locator('[data-testid="dv-timeline-editor"]')))).toBeGreaterThan(0.8)
  })
})

/**
 * Ask the scripted agent to rename timeline t1, which opens the chat session's draft with one agent change, and wait
 * until the canvas shows that draft as the working branch.
 * @param page - a page showing the project's canvas.
 * @param project - the project.
 * @param word - the chat message, unique to the story.
 * @returns the draft branch.
 */
async function openAgentDraft(page: Page, project: string, word: string): Promise<Branch> {
  model.rules.push({ match: word, steps: [{ calls: [{ name: 'dv_timeline_rename', args: { reason: 'rename', project_id: project, timeline: 't1', name: `${word} 改名` } }] }], endText: '改好了' })
  const composer = page.locator('[data-dv-chat] [contenteditable="true"]').first()
  await composer.waitFor({ timeout: 30_000 })
  await composer.click()
  await page.keyboard.type(word)
  await page.keyboard.press('Enter')
  const bar = page.locator('[data-testid="dv-canvas-view"] [data-testid="dv-kit-working-branch"]')
  await expect.poll(() => bar.getAttribute('data-branch'), { timeout: 60_000 }).toMatch(/^draft\//)
  return await waitFor(async () => (await branchesOf(project)).find(branch => branch.counts !== null) ?? null, 'the open draft', 10_000)
}

/** @returns the branches of a project. */
async function branchesOf(project: string): Promise<Branch[]> {
  return (await harness.api.get(`/api/dv/state?project=${project}&branch=main`) as { branches: Branch[] }).branches
}

describe('working branch, discard confirmation, and keep anyway', () => {
  it('the canvas and the timeline name the working branch, and a human edit lands on the open draft it names', async () => {
    const project = await seedProject('working-branch', 1)
    const page = await openPage()
    await gotoProject(page, project.id)
    const canvasBar = page.locator('[data-testid="dv-canvas-view"] [data-testid="dv-kit-working-branch"]')
    expect(await canvasBar.getAttribute('data-branch')).toBe('main')
    expect(await canvasBar.textContent()).toBe('当前分支：main')
    await viewToggle(page, '时间线').click()
    const timelineBar = page.locator('[data-testid="dv-timeline-editor"] [data-testid="dv-kit-working-branch"]')
    await expect.poll(() => timelineBar.getAttribute('data-branch')).toBe('main')
    await viewToggle(page, '画布').click()
    const draft = await openAgentDraft(page, project.id, 'wb-indicator')
    expect(await canvasBar.getAttribute('data-branch')).toBe(draft.name)
    expect(await canvasBar.textContent()).toContain('当前分支：草稿')
    await viewToggle(page, '时间线').click()
    await expect.poll(() => timelineBar.getAttribute('data-branch')).toBe(draft.name)
    // The human's new timeline goes to the draft the bar names, not to main.
    await page.locator('[data-testid="dv-timeline-editor"]').getByRole('button', { name: '＋ 新建' }).click()
    await expect.poll(async () => (await branchesOf(project.id)).find(branch => branch.name === draft.name)?.counts?.human_edits).toBe(1)
    expect((await stateOf(project.id)).components.timeline.timelines.map(timeline => timeline.id)).toEqual(['t1'])
    expect(page.errors).toEqual([])
  })

  it('discard asks first with the counts to be lost; cancel keeps the draft, a changed draft is shown again, confirm drops it', async () => {
    const project = await seedProject('discard-confirm', 1)
    const page = await openPage()
    await gotoProject(page, project.id)
    const draft = await openAgentDraft(page, project.id, 'wb-discard')
    await viewToggle(page, '时间线').click()
    await page.locator('[data-testid="dv-timeline-editor"]').getByRole('button', { name: '＋ 新建' }).click()
    await expect.poll(async () => (await branchesOf(project.id)).find(branch => branch.name === draft.name)?.counts?.human_edits).toBe(1)
    const agentChanges = (await branchesOf(project.id)).find(branch => branch.name === draft.name)?.counts?.agent_changes ?? -1
    const lost = (human: number): string => `丢弃后会丢失 ${String(agentChanges)} 处智能体修改和 ${String(human)} 处你自己的修改。`
    const bar = page.locator('[data-testid="dv-timeline-editor"] [data-testid="dv-kit-working-branch"]')
    const dialog = page.locator('[data-testid="dv-kit-discard-dialog"]')
    await bar.getByRole('button', { name: '丢弃', exact: true }).click()
    await dialog.waitFor()
    expect(await dialog.locator('p').first().textContent()).toBe(lost(1))
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    expect((await branchesOf(project.id)).some(branch => branch.name === draft.name)).toBe(true)
    // An edit lands between the dry read and the confirmation: the server refuses, and the dialog shows the new counts.
    await bar.getByRole('button', { name: '丢弃', exact: true }).click()
    await dialog.waitFor()
    await harness.api.post('/api/dv/operation', {
      project: project.id, operation: 'timeline.rename', params: { timeline: 't1', name: '人工改名' }, inputs: [], surface: 'canvas', session: draft.session, intent: 'rename',
    })
    await dialog.getByRole('button', { name: '丢弃', exact: true }).click()
    await expect.poll(() => dialog.getByRole('status').textContent()).toContain('草稿在你确认前变了')
    expect(await dialog.locator('p').first().textContent()).toBe(lost(2))
    await dialog.getByRole('button', { name: '丢弃', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await expect.poll(() => bar.getAttribute('data-branch')).toBe('main')
    expect((await branchesOf(project.id)).some(branch => branch.name === draft.name)).toBe(false)
    expect((await stateOf(project.id)).components.timeline.timelines.map(timeline => timeline.id)).toEqual(['t1'])
  })

  it('仍然保留 on a stale take node and on a stale clip removes that mark', async () => {
    const project = await seedProject('keep-anyway', 2)
    const state = await stateOf(project.id)
    const frame = state.assets.find(asset => asset.mime.startsWith('image/') && asset.name !== 'ref.png')
    await runOperation(project.id, 'bible.character_update', { character: 'c1' }, [{ role: 'reference', ref: frame?.id ?? '' }])
    const page = await openPage()
    await gotoProject(page, project.id)
    const staleTakes = page.locator('[data-node-kind="take"][data-node-stale="true"]')
    await expect.poll(() => staleTakes.count()).toBe(2)
    await staleTakes.first().click()
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    await editor.getByRole('button', { name: '仍然保留', exact: true }).click()
    await expect.poll(() => staleTakes.count()).toBe(1)
    await page.keyboard.press('Escape')
    await viewToggle(page, '时间线').click()
    const staleClips = page.locator('[data-clip-stale="true"]')
    await expect.poll(() => staleClips.count()).toBe(1)
    await staleClips.first().click()
    await page.locator('[data-testid="dv-timeline-editor"]').getByRole('button', { name: '仍然保留', exact: true }).click()
    await expect.poll(() => staleClips.count()).toBe(0)
    await viewToggle(page, '画布').click()
    await expect.poll(() => staleTakes.count()).toBe(0)
  })
})

describe('English interface', () => {
  it('every canvas and timeline label, editor, picker, and empty state is in English', async () => {
    const project = await seedProject('english', 2, [0])
    const page = await openPage({ lang: 'en-US' })
    await gotoProject(page, project.id)
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
    /** CJK text in the workspace chrome; project titles and prompts here are ASCII, so any CJK is interface copy. */
    const chinese = async (): Promise<string[]> => await page.locator('[data-dv-workspace]').evaluate((root) => {
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
    for (const kind of ['take', 'bible', 'plan']) {
      await page.locator(`[data-node-kind="${kind}"]`).first().click()
      await page.locator('[data-testid="dv-canvas-node-editor"]').waitFor()
      expect(await chinese()).toEqual([])
      await page.locator('[data-testid="dv-canvas-node-editor"]').getByRole('button', { name: 'Close' }).click()
    }
    await viewToggle(page, 'Timeline').click()
    await page.locator('[data-testid="dv-timeline-editor"]').waitFor()
    expect(await timelineTabs(page)).toEqual(['Timeline 1*', 'Timeline 2'])
    expect(await chinese()).toEqual([])
    await timelineTab(page, 'Timeline 2').click()
    await page.getByRole('button', { name: 'Insert clip' }).click()
    expect(await chinese()).toEqual([])
    const created = await harness.api.post('/api/dv/projects', { title: 'english-empty', surface: 'canvas' }) as { id: string }
    await gotoProject(page, created.id)
    expect(await chinese()).toEqual([])
    await viewToggle(page, 'Timeline').click()
    await page.locator('[data-testid="dv-timeline-editor"]').waitFor()
    expect(await chinese()).toEqual([])
  })
})
