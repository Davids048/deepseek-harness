// The assets panel (素材): user stories driven in Chromium against the shipped profile with the fake video backend and
// a scripted model. Each story opens a fresh browser context and its own project, then checks the screen against the
// UI state contract: the destination is shown, nothing is left over, and the log holds what the user did.
import { crc32, deflateSync } from 'node:zlib'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootHarness, playwright, waitFor, type BootedHarness } from '../harness.ts'
import { assetIdOf, recordIdOf, startScriptedModel, type ScriptedModel, type ScriptedRule } from '../scripted-model.ts'

interface OpWire {
  id: string
  tool?: { name: string }
  status: string
  outputs: string[]
  params: Record<string, unknown>
  surface?: string
}
interface AssetWire { id: string; name: string; mime: string }
interface StateWire { ops: OpWire[]; assets: AssetWire[]; sequences?: Array<{ id: string; title: string; items: unknown[] }> }

/**
 * A 16×16 PNG of one color, built in memory so every test can import distinct bytes.
 * @param rgb - the color as `[r, g, b]`.
 * @returns the PNG bytes.
 */
function solidPng(rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const size = 16
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())])
  const pixels = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

let colorSeed = 1
/** A PNG whose bytes no other test imports. */
function freshPng(): Buffer {
  colorSeed += 37
  return solidPng([colorSeed % 256, (colorSeed * 7) % 256, (colorSeed * 13) % 256])
}

/**
 * The scripted agent. `只回复<X>` answers `收到<X>`; `做草稿` imports a reference, plans two shots, approves, and waits,
 * leaving an open draft whose assets the panel flags.
 */
const RULES: ScriptedRule[] = [
  { match: /只回复\S+/, steps: [view => ({ text: `收到${/只回复(\S+)/.exec(view.userText)?.[1] ?? ''}` })] },
  {
    match: '做草稿',
    steps: [
      { calls: [{ name: 'dv_asset_import', args: { reason: '产品图', base64: solidPng([200, 40, 40]).toString('base64'), mime: 'image/png', name: 'draft-product.png' } }] },
      view => ({ calls: [{ name: 'dv_plan_create', args: {
        reason: '规划', title: '草稿广告', continuity: 'independent', references: [assetIdOf(view.toolResults[0], 'asset')],
        shots: [{ prompt: '草稿镜头一', duration_sec: 1 }],
      } }] }),
      view => ({ calls: [{ name: 'dv_plan_approve', args: { reason: '用户同意', plan: recordIdOf(view.toolResults[1]), user_approved: true } }] }),
      { calls: [{ name: 'dv_proj_wait', args: {} }] },
    ],
    endText: '镜头已生成。草稿待确认',
  },
]

describe('The assets panel', () => {
  let harness: BootedHarness
  let model: ScriptedModel
  let browser: Browser
  const contexts: BrowserContext[] = []
  let projectCount = 0

  beforeAll(async () => {
    model = await startScriptedModel(RULES)
    harness = await bootHarness({ modelBaseUrl: model.baseURL, playableClips: true })
    const executablePath = process.env['DSH_PLAYWRIGHT_EXECUTABLE_PATH']
    browser = await playwright.chromium.launch(executablePath === undefined ? {} : { executablePath })
  }, 150_000)

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    await harness?.close()
    await model?.close()
  })

  /** A fresh browser context on the harness with the beta notice dismissed; uncaught page errors are collected. */
  async function openPage(options: { lang?: 'zh' | 'en'; dark?: boolean } = {}): Promise<{ page: Page; errors: string[] }> {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 }, locale: options.lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: options.dark === true ? 'dark' : 'light',
    })
    contexts.push(context)
    context.setDefaultTimeout(10_000)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(String(error)) })
    await page.goto(harness.tokenUrl, { waitUntil: 'load' })
    await dismissNotice(page)
    await page.locator('[data-vh-navigator]').waitFor({ timeout: 30_000 })
    return { page, errors }
  }

  /** Close the beta notice when it shows. */
  async function dismissNotice(page: Page): Promise<void> {
    const notice = page.getByRole('button', { name: /^(继续|Continue)$/ }).first()
    await notice.waitFor({ timeout: 8000 }).then(() => notice.click(), () => undefined)
  }

  const nav = (page: Page): Locator => page.locator('[data-vh-navigator]')
  const assetsPanel = (page: Page): Locator => page.locator('[data-testid="vh-assets-panel"]')
  const crumb = (page: Page): Locator => page.locator('[data-vh-workspace] header').first()

  /** Create a project through the API with a unique title; returns its ID and title. */
  async function createProject(prefix = 'assets'): Promise<{ id: string; title: string }> {
    projectCount += 1
    const title = `${prefix}-${String(projectCount)}`
    const created = await harness.api.post('/api/vh/projects', { title, surface: 'canvas' }) as { projectId: string }
    return { id: created.projectId, title }
  }

  /** Open a project the way a user does: click its row in the navigator. */
  async function openProject(page: Page, title: string): Promise<void> {
    await nav(page).getByText(title, { exact: true }).first().click()
    await waitFor(async () => (await crumb(page).innerText().catch(() => '')).startsWith(title), `the workspace of ${title}`, 30_000)
  }

  /**
   * Store a reference image and render one shot from it through the API, as a user's canvas edits would.
   * @param projectId - the project.
   * @param prompt - the shot prompt.
   * @returns the ID of the rendered video asset.
   */
  async function seedVideo(projectId: string, prompt: string): Promise<string> {
    const reference = await harness.api.post('/api/vh/invoke', {
      project: projectId, tool: 'asset.import', params: { base64: freshPng().toString('base64'), mime: 'image/png', name: `${prompt}.png` },
      inputs: [], surface: 'canvas', intent: 'seed',
    }) as OpWire
    const shot = await harness.api.post('/api/vh/invoke', {
      project: projectId, tool: 'shot.render', params: { prompt, duration_sec: 1 },
      inputs: [{ role: 'reference', ref: reference.outputs[0] }], surface: 'canvas', intent: 'seed',
    }) as OpWire
    expect(shot.status).toBe('done')
    return shot.outputs[0] ?? ''
  }

  /** The folded `main` state of a project. */
  const stateOf = async (projectId: string): Promise<StateWire> => await harness.api.get(`/api/vh/state?project=${projectId}&head=main`) as StateWire

  /** Open the 素材 / Assets tab of the right panel. */
  async function openAssets(page: Page, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    // The tab strip of the right panel; 面板 / Panels reopens a collapsed panel.
    const tab = page.locator('[role="tab"]', { hasText: lang === 'zh' ? /^素材$/ : /^Assets$/ }).filter({ visible: true }).first()
    // The panels open by themselves once the project's chat session is in place; wait for that before reopening them.
    if (!await tab.waitFor({ timeout: 5000 }).then(() => true, () => false)) await page.getByRole('button', { name: lang === 'zh' ? '面板' : 'Panels', exact: true }).click()
    // A project switch remounts the right panel's session seat, so the tab found first can be replaced mid-click.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await tab.click({ timeout: 3000 }).then(() => true, () => false)) break
    }
    await assetsPanel(page).waitFor({ timeout: 15_000 })
  }

  describe('assets panel', () => {
    it('lists only the open project\'s assets, says what to do when empty, and shows no panel content on the entry page', async () => {
      const { page, errors } = await openPage()
      expect(await assetsPanel(page).locator('[data-asset-id]').count()).toBe(0)
      const full = await createProject('assets-full')
      await harness.api.post('/api/vh/invoke', {
        project: full.id, tool: 'asset.import', params: { base64: freshPng().toString('base64'), mime: 'image/png', name: 'only-here.png' }, inputs: [], surface: 'canvas', intent: 'seed',
      })
      const empty = await createProject('assets-empty')
      await openProject(page, full.title)
      await openAssets(page)
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count()).toBe(1)
      await openProject(page, empty.title)
      await openAssets(page)
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count()).toBe(0)
      expect(await assetsPanel(page).innerText()).toContain('拖入图片或视频导入，或点击选择文件')
      expect(errors).toEqual([])
    })

    it('imports through the file chooser and the drop zone, listed under 导入 and 参考', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await openAssets(page)
      await assetsPanel(page).locator('input[type="file"]').setInputFiles({ name: 'chosen.png', mimeType: 'image/png', buffer: freshPng() })
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count()).toBe(1)
      const dropped = freshPng().toString('base64')
      await page.evaluate(async (base64) => {
        const zone = document.querySelector('[data-testid="vh-assets-panel"] [role="button"]')
        const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob()
        const transfer = new DataTransfer()
        transfer.items.add(new File([blob], 'dropped.png', { type: 'image/png' }))
        zone?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
        zone?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }, dropped)
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count()).toBe(2)
      await assetsPanel(page).getByRole('button', { name: '导入', exact: true }).click()
      const titles = await assetsPanel(page).locator('[data-asset-id]').evaluateAll(rows => rows.map(row => row.getAttribute('title')))
      expect(titles.sort()).toEqual(['chosen.png', 'dropped.png'])
      expect(errors).toEqual([])
    })

    it('keeps the name a file was imported with when another project already holds the same bytes under another name', async () => {
      const { page, errors } = await openPage()
      const bytes = freshPng()
      const other = await createProject()
      await harness.api.post('/api/vh/invoke', {
        project: other.id, tool: 'asset.import', params: { base64: bytes.toString('base64'), mime: 'image/png', name: 'someone-else.png' }, inputs: [], surface: 'canvas', intent: 'seed',
      })
      const project = await createProject()
      await openProject(page, project.title)
      await openAssets(page)
      await assetsPanel(page).locator('input[type="file"]').setInputFiles({ name: 'mine.png', mimeType: 'image/png', buffer: bytes })
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count()).toBe(1)
      expect(await assetsPanel(page).locator('[data-asset-id]').first().getAttribute('title')).toBe('mine.png')
      expect(errors).toEqual([])
    })

    it('lists an image attached in the chat as a project asset', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await page.locator('[data-vh-chat] input[type="file"]').first().setInputFiles({ name: 'chat-attachment.png', mimeType: 'image/png', buffer: freshPng() })
      await page.waitForTimeout(1000)
      const composer = page.locator('[data-vh-chat] [contenteditable="true"]:visible').first()
      await composer.click()
      await page.keyboard.type('只回复图')
      await page.keyboard.press('Enter')
      await page.locator('[data-vh-chat]').getByText('收到图').first().waitFor({ timeout: 30_000 })
      await openAssets(page)
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count(), { timeout: 10_000 }).toBe(1)
      expect(errors).toEqual([])
    })

    it('lists rendered videos under 渲染结果', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      const videos = [await seedVideo(project.id, 'listed prompt one'), await seedVideo(project.id, 'listed prompt two')]
      await openProject(page, project.title)
      await openAssets(page)
      await assetsPanel(page).getByRole('button', { name: '渲染结果', exact: true }).click()
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count()).toBe(2)
      const ids = await assetsPanel(page).locator('[data-asset-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-asset-id')))
      expect(ids.sort()).toEqual(videos.sort())
      expect(errors).toEqual([])
    })

    it('flags the assets of an open draft with 草稿', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      const composer = page.locator('[data-vh-chat] [contenteditable="true"]:visible').first()
      await composer.click()
      await page.keyboard.type('做草稿')
      await page.keyboard.press('Enter')
      await page.locator('[data-vh-chat]').getByText('草稿待确认').first().waitFor({ timeout: 60_000 })
      await openAssets(page)
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').filter({ hasText: '草稿' }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
      expect(errors).toEqual([])
    })

    it('previews an asset on click and closes it with Escape; 加入剪辑 in the preview adds the video to the cuts', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await harness.api.post('/api/vh/invoke', { project: project.id, tool: 'timeline.create', params: { timeline: 't1', name: '第 1 集', assets: [] }, inputs: [], surface: 'timeline', intent: 'seed' })
      await seedVideo(project.id, 'preview prompt')
      await openProject(page, project.title)
      await openAssets(page)
      await assetsPanel(page).getByRole('button', { name: '渲染结果', exact: true }).click()
      await assetsPanel(page).locator('[data-asset-id]').first().click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await page.keyboard.press('Escape')
      await expect.poll(() => dialog.count()).toBe(0)
      await assetsPanel(page).locator('[data-asset-id]').first().click()
      await dialog.getByRole('button', { name: '加入剪辑' }).click()
      await expect.poll(async () => (await stateOf(project.id)).sequences?.[0]?.items.length ?? 0, { timeout: 10_000 }).toBe(1)
      expect(errors).toEqual([])
    })

    it('让 agent 使用 in the preview prefills the chat with a reference to the asset and shows 对话', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await harness.api.post('/api/vh/invoke', {
        project: project.id, tool: 'asset.import', params: { base64: freshPng().toString('base64'), mime: 'image/png', name: 'use-me.png' }, inputs: [], surface: 'canvas', intent: 'seed',
      })
      await openProject(page, project.title)
      await openAssets(page)
      await assetsPanel(page).locator('[data-asset-id]').first().click()
      await page.getByRole('dialog').getByRole('button', { name: '让 agent 使用' }).click()
      const composer = page.locator('[data-vh-chat] [contenteditable="true"]:visible').first()
      await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true)
      expect(await composer.locator('[data-lexical-decorator], [data-mention], [contenteditable="false"]').count()).toBeGreaterThan(0)
      expect(errors).toEqual([])
    })

    it('drags an asset onto the cuts track and onto the canvas', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await harness.api.post('/api/vh/invoke', { project: project.id, tool: 'timeline.create', params: { timeline: 't1', name: '第 1 集', assets: [] }, inputs: [], surface: 'timeline', intent: 'seed' })
      await seedVideo(project.id, 'drag prompt')
      await openProject(page, project.title)
      await page.getByRole('tab', { name: '剪辑', exact: true }).click()
      await openAssets(page)
      await assetsPanel(page).getByRole('button', { name: '渲染结果', exact: true }).click()
      const clip = assetsPanel(page).locator('[data-asset-id]').first()
      await clip.dragTo(page.locator('[role="list"]').first())
      await expect.poll(async () => (await stateOf(project.id)).sequences?.[0]?.items.length ?? 0, { timeout: 10_000 }).toBe(1)
      await page.getByRole('tab', { name: '画布', exact: true }).click()
      const canvas = page.locator('[data-testid="vh-canvas-view"]')
      await canvas.waitFor()
      // The canvas accepts an asset drop: its dragover handler claims the asset drag type.
      const accepted = await canvas.evaluate((element) => {
        const transfer = new DataTransfer()
        transfer.setData('application/x-vh-asset', 'probe')
        const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer })
        element.dispatchEvent(event)
        return event.defaultPrevented
      })
      expect(accepted).toBe(true)
      expect(errors).toEqual([])
    })
  })

  describe('language and theme', () => {
    it('shows every assets label in English', async () => {
      const { page, errors } = await openPage({ lang: 'en' })
      const project = await createProject('english')
      await openProject(page, project.title)
      await openAssets(page, 'en')
      for (const filter of ['All', 'Imported', 'Rendered']) {
        // The panel can still be re-laying out right after the tab opens; retry a click on an unstable chip.
        const chip = assetsPanel(page).getByRole('button', { name: filter, exact: true })
        for (let attempt = 0; attempt < 4; attempt++) {
          if (await chip.click({ timeout: 3000 }).then(() => true, () => false)) break
        }
      }
      const chinese = await page.evaluate(() => {
        const found: string[] = []
        const roots = document.querySelectorAll('[data-vh-navigator], [data-vh-workspace], [data-testid="vh-assets-panel"]')
        for (const root of roots) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) { const text = walker.currentNode.textContent ?? ''; if (/[一-鿿]/.test(text)) found.push(text.trim()) }
          for (const element of root.querySelectorAll('[placeholder], [title], [aria-label]')) {
            for (const name of ['placeholder', 'title', 'aria-label']) { const value = element.getAttribute(name) ?? ''; if (/[一-鿿]/.test(value)) found.push(value) }
          }
        }
        return found
      })
      expect(chinese).toEqual([])
      expect(errors).toEqual([])
    })

    it('renders the assets panel on a dark background with light text in the dark theme', async () => {
      const { page, errors } = await openPage({ dark: true })
      const project = await createProject()
      await openProject(page, project.title)
      await openAssets(page)
      const luminance = (rgb: string): number => {
        const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).map(Number)
        return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
      }
      const colors = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        // An inactive filter chip; the active one is drawn in the accent color.
        filter: getComputedStyle(document.querySelectorAll('[data-testid="vh-assets-panel"] button')[1] as Element).color,
      }))
      expect(luminance(colors.body)).toBeLessThan(60)
      expect(luminance(colors.filter)).toBeGreaterThan(160)
      expect(errors).toEqual([])
    })
  })
})
