// Tool sessions and the assets panel (素材): user stories driven in Chromium against the shipped profile with the fake
// video backend (held open for a moment so the queued and generating states are visible, and failing on a marked
// prompt) and a scripted model. Each story opens a fresh browser context and its own project, then checks the screen
// against the UI state contract: the destination is shown, nothing is left over, and the log holds what the user did.
import { crc32, deflateSync } from 'node:zlib'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootHarness, playwright, waitFor, type BootedHarness } from '../harness.ts'
import { assetIdOf, opIdOf, startScriptedModel, type ScriptedModel, type ScriptedRule } from '../scripted-model.ts'

/** A generate prompt containing this marker makes the fake backend answer HTTP 500. */
const FAIL_MARKER = 'BACKEND-FAIL'

/** How long the fake backend holds every generate request open. */
const BACKEND_DELAY_MS = 2500

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
 * A 16×16 PNG of one color, built in memory so every test can upload distinct bytes.
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
/** A PNG whose bytes no other test uploads. */
function freshPng(): Buffer {
  colorSeed += 37
  return solidPng([colorSeed % 256, (colorSeed * 7) % 256, (colorSeed * 13) % 256])
}

/**
 * The scripted agent. `只回复<X>` answers `收到<X>`; `做草稿` uploads a reference, plans two shots, approves, and waits,
 * leaving an open agent draft whose assets the panel flags.
 */
const RULES: ScriptedRule[] = [
  { match: /只回复\S+/, steps: [view => ({ text: `收到${/只回复(\S+)/.exec(view.userText)?.[1] ?? ''}` })] },
  {
    match: '做草稿',
    steps: [
      { calls: [{ name: 'vh_asset_upload', args: { reason: '产品图', base64: solidPng([200, 40, 40]).toString('base64'), mime: 'image/png', name: 'draft-product.png' } }] },
      view => ({ calls: [{ name: 'vh_plan_create', args: {
        reason: '规划', title: '草稿广告', continuity: 'independent', references: [assetIdOf(view.toolResults[0], 'asset')],
        shots: [{ prompt: '草稿镜头一', duration_sec: 1 }],
      } }] }),
      view => ({ calls: [{ name: 'vh_plan_approve', args: { reason: '用户同意', plan: opIdOf(view.toolResults[1]), user_approved: true } }] }),
      { calls: [{ name: 'vh_wait', args: {} }] },
    ],
    endText: '镜头已生成。草稿待确认',
  },
]

describe('Tool sessions and the assets panel', () => {
  let harness: BootedHarness
  let model: ScriptedModel
  let browser: Browser
  const contexts: BrowserContext[] = []
  let projectCount = 0

  beforeAll(async () => {
    model = await startScriptedModel(RULES)
    harness = await bootHarness({
      modelBaseUrl: model.baseURL,
      playableClips: true,
      backendDelayMs: BACKEND_DELAY_MS,
      backendFailPrompt: FAIL_MARKER,
    })
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

  /** The location fields of the URL hash. */
  function locationOf(page: Page): { project: string | null; tool: string | null; view: string | null } {
    const params = new URLSearchParams(new URL(page.url()).hash.replace(/^#/, ''))
    return { project: params.get('project'), tool: params.get('tool'), view: params.get('view') }
  }

  const nav = (page: Page): Locator => page.locator('[data-vh-navigator]')
  const toolList = (page: Page): Locator => page.locator('[data-testid="vh-tool-sessions"]')
  const toolView = (page: Page): Locator => page.locator('[data-testid="vh-tool-view"]')
  const results = (page: Page): Locator => toolView(page).locator('[data-testid="vh-tool-result"]')
  const assetsPanel = (page: Page): Locator => page.locator('[data-testid="vh-assets-panel"]')
  const crumb = (page: Page): Locator => page.locator('[data-vh-workspace] header').first()

  /** Create a project through the API with a unique title; returns its ID and title. */
  async function createProject(prefix = 'tool'): Promise<{ id: string; title: string }> {
    projectCount += 1
    const title = `${prefix}-${String(projectCount)}`
    const created = await harness.api.post('/api/vh/projects', { title, surface: 'canvas' }) as { projectId: string }
    return { id: created.projectId, title }
  }

  /** Open a project the way a user does: click its row in the 对话 / Chat list of the navigator. */
  async function openProject(page: Page, title: string, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    await nav(page).getByRole('button', { name: lang === 'zh' ? '对话' : 'Chat', exact: true }).click()
    await nav(page).getByText(title, { exact: true }).first().click()
    await waitFor(async () => (await crumb(page).innerText().catch(() => '')).startsWith(title), `the workspace of ${title}`, 30_000)
  }

  /** Switch the navigator to Tool 会话 and click 新建 Tool 会话; returns the opened Tool session ID. */
  async function newToolSession(page: Page, lang: 'zh' | 'en' = 'zh'): Promise<string> {
    await nav(page).getByRole('button', { name: lang === 'zh' ? 'Tool 会话' : 'Tool sessions', exact: true }).click()
    await toolList(page).getByRole('button', { name: lang === 'zh' ? '＋ 新建 Tool 会话' : '+ New Tool session' }).click()
    await toolView(page).waitFor({ timeout: 15_000 })
    return await waitFor(() => Promise.resolve(locationOf(page).tool), 'a Tool session in the URL', 10_000)
  }

  /** Upload one reference image through the Tool view's 上传 file chooser and wait for its thumbnail. */
  async function addReference(page: Page, name: string, bytes: Buffer = freshPng()): Promise<void> {
    const before = await toolView(page).locator('aside img').count()
    await toolView(page).locator('aside input[type="file"]').setInputFiles({ name, mimeType: 'image/png', buffer: bytes })
    await waitFor(async () => (await toolView(page).locator('aside img').count()) > before, 'the reference thumbnail', 15_000)
  }

  /** Fill the prompt and click 生成. */
  async function generate(page: Page, prompt: string): Promise<void> {
    await toolView(page).locator('textarea').fill(prompt)
    await toolView(page).getByRole('button', { name: '生成', exact: true }).click()
  }

  /** Wait until the newest result card shows a playable video. */
  async function waitDone(page: Page, prompt: string): Promise<void> {
    await waitFor(async () => (await results(page).filter({ hasText: prompt }).locator('video').count()) > 0, `the video of "${prompt}"`, 30_000)
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

  /** The draft text of the visible chat composer. */
  const chatDraft = (page: Page): Promise<string> => page.locator('[data-vh-chat] [contenteditable="true"]:visible').first().innerText()

  describe('Tool session list', () => {
    it('shows no Tool session on the entry page, and inside a project lists 新建 Tool 会话 and a disabled 创建新工具 placeholder', async () => {
      const { page, errors } = await openPage()
      await nav(page).getByRole('button', { name: 'Tool 会话', exact: true }).click()
      await page.waitForTimeout(500)
      expect(await toolList(page).count()).toBe(0)
      expect(await toolView(page).count()).toBe(0)
      const project = await createProject()
      await openProject(page, project.title)
      await nav(page).getByRole('button', { name: 'Tool 会话', exact: true }).click()
      await toolList(page).waitFor()
      expect(await toolList(page).getByRole('button', { name: '＋ 新建 Tool 会话' }).isEnabled()).toBe(true)
      const placeholder = toolList(page).getByRole('button', { name: /创建新工具/ })
      expect(await placeholder.isDisabled()).toBe(true)
      expect(await placeholder.innerText()).toContain('即将推出')
      expect(errors).toEqual([])
    })

    it('reuses the empty Tool session when 新建 Tool 会话 is clicked again, so empty sessions never pile up', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      const first = await newToolSession(page)
      for (let i = 0; i < 3; i++) await toolList(page).getByRole('button', { name: '＋ 新建 Tool 会话' }).click()
      await page.waitForTimeout(1000)
      expect(locationOf(page).tool).toBe(first)
      const sessions = await harness.api.get(`/api/vh/tool-sessions?project=${project.id}`) as unknown[]
      expect(sessions).toHaveLength(1)
      expect(await toolList(page).getByRole('button', { name: /^Tool 会话 \d+$/ }).count()).toBe(1)
      expect(errors).toEqual([])
    })

    it('renames a Tool session and shows the new name in the list, the results header, the breadcrumb, and the assets folder', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'rename-ref.png')
      await generate(page, 'rename prompt')
      await waitDone(page, 'rename prompt')
      await toolList(page).getByRole('button', { name: 'Tool 会话 1', exact: true }).dblclick()
      const input = toolList(page).locator('input')
      await input.fill('红球镜头')
      await input.press('Enter')
      await expect.poll(() => toolList(page).innerText()).toContain('红球镜头')
      await expect.poll(() => toolView(page).locator('h2').innerText(), { timeout: 5000 }).toBe('红球镜头')
      await expect.poll(() => crumb(page).innerText(), { timeout: 5000 }).toContain('红球镜头')
      await openAssets(page)
      await assetsPanel(page).getByRole('button', { name: '文件夹', exact: true }).click()
      await expect.poll(() => assetsPanel(page).innerText()).toContain('红球镜头')
      expect(errors).toEqual([])
    })

    it('deletes a Tool session after confirmation: it leaves the list, and the center leaves the deleted session', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      const session = await newToolSession(page)
      page.once('dialog', (dialog) => { void dialog.accept() })
      const actions = toolList(page).locator('[aria-haspopup="menu"]')
      expect(await actions.count(), 'each Tool session row offers a ⋯ actions menu like chat sessions and projects').toBeGreaterThan(0)
      await actions.first().click({ force: true })
      await page.getByRole('menuitem', { name: /删除/ }).click()
      await expect.poll(async () => await harness.api.get(`/api/vh/tool-sessions?project=${project.id}`) as unknown[]).toHaveLength(0)
      await expect.poll(() => toolList(page).getByRole('button', { name: 'Tool 会话 1', exact: true }).count()).toBe(0)
      expect(locationOf(page).tool).not.toBe(session)
      expect(await toolView(page).count()).toBe(0)
      expect(errors).toEqual([])
    })

    it('reload in a Tool session restores the same project and the same Tool session with its results', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      const session = await newToolSession(page)
      await addReference(page, 'reload-ref.png')
      await generate(page, 'reload prompt')
      await waitDone(page, 'reload prompt')
      await page.reload({ waitUntil: 'load' })
      await dismissNotice(page)
      await waitFor(async () => (await crumb(page).innerText().catch(() => '')).startsWith(project.title), 'the project after reload', 30_000)
      await page.waitForTimeout(1500)
      expect(locationOf(page)).toMatchObject({ project: project.id, tool: session })
      await toolView(page).waitFor({ timeout: 10_000 })
      expect(await results(page).filter({ hasText: 'reload prompt' }).count()).toBe(1)
      expect(errors).toEqual([])
    })

    it('a link to a deleted Tool session opens the project without the Tool form or a raw error', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      const session = await harness.api.post('/api/vh/tool-sessions', { project: project.id, title: '' }) as { id: string }
      await harness.api.post('/api/vh/tool-sessions/delete', { project: project.id, session: session.id })
      await page.goto('about:blank')
      await page.goto(`${harness.origin}/#project=${project.id}&tool=${session.id}`, { waitUntil: 'load' })
      await dismissNotice(page)
      await waitFor(async () => (await crumb(page).innerText().catch(() => '')).startsWith(project.title), 'the project of the link', 30_000)
      await expect.poll(() => locationOf(page).tool, { timeout: 5000 }).toBeNull()
      expect(await toolView(page).count()).toBe(0)
      expect(await page.locator('body').innerText()).not.toContain('VhApiError')
      expect(errors).toEqual([])
    })

    it('browser Back from a Tool session returns to the canvas of the same project instead of leaving DreamVerse', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await page.waitForTimeout(1000)
      await newToolSession(page)
      await page.goBack({ waitUntil: 'load' })
      await page.waitForTimeout(1500)
      expect(new URL(page.url()).origin).toBe(harness.origin)
      expect(locationOf(page)).toMatchObject({ project: project.id, tool: null })
      expect(await toolView(page).count()).toBe(0)
      expect(errors).toEqual([])
    })
  })

  describe('generating in Tool mode', () => {
    it('refuses to generate without a reference image and says why, without sending a request', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      const sent = harness.backend.requests.length
      await generate(page, 'no reference prompt')
      await expect.poll(() => toolView(page).locator('aside').innerText()).toContain('参考模式至少需要一张参考图。')
      await page.waitForTimeout(500)
      expect(harness.backend.requests.length).toBe(sent)
      expect(await results(page).count()).toBe(0)
      expect((await stateOf(project.id)).ops.filter(op => op.tool?.name === 'generate.video')).toHaveLength(0)
      expect(errors).toEqual([])
    })

    it('generates from an uploaded reference with the chosen duration and seed, showing honest status until the video plays', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'status-ref.png')
      const slider = toolView(page).locator('input[type="range"]')
      await slider.fill('2')
      await expect.poll(() => toolView(page).locator('aside').innerText()).toContain('时长 · 2 秒')
      await toolView(page).locator('input[inputmode="numeric"]').fill('1234')
      const sent = harness.backend.requests.length
      await generate(page, 'status prompt')
      // While the backend holds the request, the card says it is queued or generating, with the elapsed time.
      await expect.poll(() => results(page).first().innerText(), { timeout: 5000 }).toMatch(/(排队中|生成中)… 已(等|用) \d+ 秒/)
      await waitDone(page, 'status prompt')
      const card = await results(page).first().innerText()
      expect(card).toContain('2 秒')
      expect(card).toContain('种子 1234')
      const request = harness.backend.requests[sent]
      expect(request?.['seed']).toBe(1234)
      expect(request?.['num_frames']).toBe(49)
      expect(errors).toEqual([])
    })

    it('generates from an asset picked with 从素材选择', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      const upload = await harness.api.post('/api/vh/invoke', {
        project: project.id, tool: 'asset.upload', params: { base64: freshPng().toString('base64'), mime: 'image/png', name: 'picked.png' }, inputs: [], surface: 'canvas', intent: 'seed',
      }) as OpWire
      await openProject(page, project.title)
      await newToolSession(page)
      await toolView(page).getByRole('button', { name: '从素材选择' }).click()
      await toolView(page).getByRole('button', { name: 'picked.png' }).click()
      await expect.poll(() => toolView(page).locator('aside').innerText()).toContain('参考图 (1/')
      await generate(page, 'picked prompt')
      await waitDone(page, 'picked prompt')
      const op = (await stateOf(project.id)).ops.find(row => row.tool?.name === 'generate.video')
      expect(op?.status).toBe('done')
      expect(JSON.stringify(op)).toContain(upload.outputs[0] ?? 'missing')
      expect(errors).toEqual([])
    })

    it('shows a failed generation as 生成失败 with its reason, and the next generation still works', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'fail-ref.png')
      await generate(page, `${FAIL_MARKER} prompt`)
      await expect.poll(() => results(page).first().innerText(), { timeout: 30_000 }).toMatch(/生成失败：\S+/)
      expect(await results(page).first().innerText()).not.toContain('未知原因')
      await generate(page, 'after failure prompt')
      await waitDone(page, 'after failure prompt')
      expect(errors).toEqual([])
    })

    it('says how many reference images fit when the user chooses more, and does not upload the extras', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await toolView(page).locator('aside input[type="file"]').setInputFiles(['one', 'two', 'three'].map(name => ({ name: `${name}.png`, mimeType: 'image/png', buffer: freshPng() })))
      await expect.poll(() => toolView(page).locator('aside').innerText()).toContain('参考图 (2/2)')
      expect(await toolView(page).locator('aside').innerText()).toMatch(/最多.*2/)
      await page.waitForTimeout(1000)
      expect((await stateOf(project.id)).ops.filter(op => op.tool?.name === 'asset.upload')).toHaveLength(2)
      expect(errors).toEqual([])
    })

    it('lists several generations in a row newest first', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'row-ref.png')
      for (const word of ['one', 'two', 'three']) {
        await generate(page, `row ${word}`)
        await expect.poll(() => results(page).first().innerText(), { timeout: 10_000 }).toContain(`row ${word}`)
      }
      await waitDone(page, 'row one')
      await waitDone(page, 'row three')
      const prompts = (await results(page).allInnerTexts()).map(text => /row \w+/.exec(text)?.[0])
      expect(prompts).toEqual(['row three', 'row two', 'row one'])
      expect(errors).toEqual([])
    })

    it('keeps the result action buttons on one line in the default layout with the right panel open', async () => {
      const { page } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'layout-ref.png')
      await generate(page, 'layout prompt')
      await waitDone(page, 'layout prompt')
      const card = results(page).first()
      const cardBox = await card.boundingBox()
      for (const name of ['加入剪辑', '在画布打开', '让 agent 接着做']) {
        const box = await card.getByRole('button', { name }).boundingBox()
        expect(box?.height, `${name} wraps onto several lines`).toBeLessThan(40)
        expect((box?.x ?? 0) + (box?.width ?? 0), `${name} overflows its card`).toBeLessThanOrEqual((cardBox?.x ?? 0) + (cardBox?.width ?? 0))
      }
    })

    it('加入剪辑 puts the clip into the episode selected in 剪辑', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      for (const [id, title] of [['v1', '第 1 集'], ['v2', '第 2 集']]) {
        await harness.api.post('/api/vh/invoke', { project: project.id, tool: 'sequence.create', params: { sequence: id, title, assets: [] }, inputs: [], surface: 'timeline', intent: 'seed' })
      }
      await openProject(page, project.title)
      await page.getByRole('tab', { name: '剪辑', exact: true }).click()
      await page.locator('[role="tab"][data-video-id="v2"]').click()
      await newToolSession(page)
      await addReference(page, 'cut-ref.png')
      await generate(page, 'cut prompt')
      await waitDone(page, 'cut prompt')
      await results(page).first().getByRole('button', { name: '加入剪辑' }).click()
      await expect.poll(async () => (await stateOf(project.id)).sequences?.map(row => `${row.id}:${String(row.items.length)}`), { timeout: 10_000 }).toEqual(['v1:0', 'v2:1'])
      await page.getByRole('tab', { name: '剪辑', exact: true }).click()
      await expect.poll(() => page.locator('[role="tab"][aria-selected="true"][data-video-id]').getAttribute('data-video-id')).toBe('v2')
      expect(errors).toEqual([])
    })

    it('加入剪辑 in a project without episodes puts the clip into a visible episode instead of dropping it', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'noep-ref.png')
      await generate(page, 'no episode prompt')
      await waitDone(page, 'no episode prompt')
      await results(page).first().getByRole('button', { name: '加入剪辑' }).click()
      await expect.poll(
        async () => (await stateOf(project.id)).sequences?.reduce((sum, row) => sum + row.items.length, 0) ?? 0,
        { timeout: 10_000 },
      ).toBe(1)
      await page.getByRole('tab', { name: '剪辑', exact: true }).click()
      await expect.poll(() => page.locator('[role="tab"][data-video-id]').count()).toBeGreaterThan(0)
      expect(errors).toEqual([])
    })

    it('在画布打开 shows the canvas with that generation opened in the node editor', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'canvas-ref.png')
      await generate(page, 'canvas prompt')
      await waitDone(page, 'canvas prompt')
      await results(page).first().getByRole('button', { name: '在画布打开' }).click()
      await page.locator('[data-testid="vh-canvas-view"]').waitFor({ timeout: 10_000 })
      expect(locationOf(page)).toMatchObject({ project: project.id, tool: null })
      expect(await toolView(page).count()).toBe(0)
      await expect.poll(() => page.locator('[data-testid="vh-node-editor"]').count(), { timeout: 5000 }).toBe(1)
      expect(await page.locator('[data-testid="vh-node-editor"] textarea').first().inputValue()).toContain('canvas prompt')
      expect(errors).toEqual([])
    })

    it('让 agent 接着做 prefills the chat with the prompt and a reference to the generation, and shows 对话', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'continue-ref.png')
      await generate(page, 'continue prompt')
      await waitDone(page, 'continue prompt')
      await openAssets(page)
      await results(page).first().getByRole('button', { name: '让 agent 接着做' }).click()
      await expect.poll(() => chatDraft(page), { timeout: 5000 }).toContain('continue prompt')
      expect(await page.locator('[data-vh-chat] [contenteditable="true"]').first().isVisible()).toBe(true)
      // The draft carries a structured @ reference to the generation, not only its prompt text.
      expect(await page.locator('[data-vh-chat] [contenteditable="true"]').first().locator('[data-lexical-decorator], [data-mention], [contenteditable="false"]').count()).toBeGreaterThan(0)
      expect(errors).toEqual([])
    })
  })

  describe('switching projects', () => {
    it('switching from a generating Tool session in project A to project B shows nothing of A, and A shows the result on return', async () => {
      const { page, errors } = await openPage()
      const a = await createProject('switch-A')
      const b = await createProject('switch-B')
      await openProject(page, a.title)
      const session = await newToolSession(page)
      await addReference(page, 'switch-ref.png')
      await generate(page, 'switch prompt')
      await openProject(page, b.title)
      expect(locationOf(page)).toMatchObject({ project: b.id, tool: null })
      expect(await toolView(page).count()).toBe(0)
      expect(await page.getByText('switch prompt').count()).toBe(0)
      await nav(page).getByRole('button', { name: 'Tool 会话', exact: true }).click()
      expect(await toolList(page).getByRole('button', { name: /^Tool 会话 \d+$/ }).count()).toBe(0)
      await openAssets(page)
      expect(await assetsPanel(page).locator('[data-asset-id]').count()).toBe(0)
      await openProject(page, a.title)
      await nav(page).getByRole('button', { name: 'Tool 会话', exact: true }).click()
      await toolList(page).getByRole('button', { name: 'Tool 会话 1', exact: true }).click()
      expect(locationOf(page).tool).toBe(session)
      await waitDone(page, 'switch prompt')
      expect(errors).toEqual([])
    })
  })

  describe('assets panel', () => {
    it('lists only the open project\'s assets, says what to do when empty, and shows no panel content on the entry page', async () => {
      const { page, errors } = await openPage()
      expect(await assetsPanel(page).locator('[data-asset-id]').count()).toBe(0)
      const full = await createProject('assets-full')
      await harness.api.post('/api/vh/invoke', {
        project: full.id, tool: 'asset.upload', params: { base64: freshPng().toString('base64'), mime: 'image/png', name: 'only-here.png' }, inputs: [], surface: 'canvas', intent: 'seed',
      })
      const empty = await createProject('assets-empty')
      await openProject(page, full.title)
      await openAssets(page)
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count()).toBe(1)
      await openProject(page, empty.title)
      await openAssets(page)
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count()).toBe(0)
      expect(await assetsPanel(page).innerText()).toContain('拖入图片或视频上传，或点击选择文件')
      expect(errors).toEqual([])
    })

    it('uploads through the file chooser and the drop zone, listed under 上传 and 参考', async () => {
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
      await assetsPanel(page).getByRole('button', { name: '上传', exact: true }).click()
      const titles = await assetsPanel(page).locator('[data-asset-id]').evaluateAll(rows => rows.map(row => row.getAttribute('title')))
      expect(titles.sort()).toEqual(['chosen.png', 'dropped.png'])
      expect(errors).toEqual([])
    })

    it('keeps the name a file was uploaded with when another project already holds the same bytes under another name', async () => {
      const { page, errors } = await openPage()
      const bytes = freshPng()
      const other = await createProject()
      await harness.api.post('/api/vh/invoke', {
        project: other.id, tool: 'asset.upload', params: { base64: bytes.toString('base64'), mime: 'image/png', name: 'someone-else.png' }, inputs: [], surface: 'canvas', intent: 'seed',
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

    it('files Tool outputs in a folder named after the Tool session and lists them under 生成', async () => {
      const { page, errors } = await openPage()
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'folder-ref.png')
      await generate(page, 'folder prompt one')
      await waitDone(page, 'folder prompt one')
      await generate(page, 'folder prompt two')
      await waitDone(page, 'folder prompt two')
      await openAssets(page)
      await assetsPanel(page).getByRole('button', { name: '生成', exact: true }).click()
      await expect.poll(() => assetsPanel(page).locator('[data-asset-id]').count()).toBe(2)
      await assetsPanel(page).getByRole('button', { name: '文件夹', exact: true }).click()
      await assetsPanel(page).getByRole('button', { name: /Tool 会话 1/ }).click()
      expect(await assetsPanel(page).locator('[data-asset-id]').count()).toBe(2)
      expect(errors).toEqual([])
    })

    it('flags the assets of an unaccepted agent draft with 草稿', async () => {
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
      await harness.api.post('/api/vh/invoke', { project: project.id, tool: 'sequence.create', params: { sequence: 'v1', title: '第 1 集', assets: [] }, inputs: [], surface: 'timeline', intent: 'seed' })
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'preview-ref.png')
      await generate(page, 'preview prompt')
      await waitDone(page, 'preview prompt')
      await openAssets(page)
      await assetsPanel(page).getByRole('button', { name: '生成', exact: true }).click()
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
        project: project.id, tool: 'asset.upload', params: { base64: freshPng().toString('base64'), mime: 'image/png', name: 'use-me.png' }, inputs: [], surface: 'canvas', intent: 'seed',
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
      await harness.api.post('/api/vh/invoke', { project: project.id, tool: 'sequence.create', params: { sequence: 'v1', title: '第 1 集', assets: [] }, inputs: [], surface: 'timeline', intent: 'seed' })
      await openProject(page, project.title)
      await newToolSession(page)
      await addReference(page, 'drag-ref.png')
      await generate(page, 'drag prompt')
      await waitDone(page, 'drag prompt')
      await page.getByRole('tab', { name: '剪辑', exact: true }).click()
      await openAssets(page)
      await assetsPanel(page).getByRole('button', { name: '生成', exact: true }).click()
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
    it('shows every Tool and assets label in English, default Tool session names included', async () => {
      const { page, errors } = await openPage({ lang: 'en' })
      const project = await createProject('english')
      await harness.api.post('/api/vh/tool-sessions', { project: project.id, title: '' })
      await openProject(page, project.title, 'en')
      await nav(page).getByRole('button', { name: 'Tool sessions', exact: true }).click()
      await toolList(page).getByRole('button', { name: 'Tool session 1', exact: true }).click()
      await toolView(page).waitFor()
      await openAssets(page, 'en')
      for (const filter of ['All', 'Uploads', 'Generated', 'Folders']) {
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

    it('renders the Tool view and the assets panel on a dark background with light text in the dark theme', async () => {
      const { page, errors } = await openPage({ dark: true })
      const project = await createProject()
      await openProject(page, project.title)
      await newToolSession(page)
      await openAssets(page)
      const luminance = (rgb: string): number => {
        const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).map(Number)
        return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
      }
      const colors = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        heading: getComputedStyle(document.querySelector('[data-testid="vh-tool-view"] h2') as Element).color,
        // An inactive filter chip; the active one is drawn in the accent color.
        filter: getComputedStyle(document.querySelectorAll('[data-testid="vh-assets-panel"] button')[1] as Element).color,
      }))
      expect(luminance(colors.body)).toBeLessThan(60)
      expect(luminance(colors.heading)).toBeGreaterThan(160)
      expect(luminance(colors.filter)).toBeGreaterThan(160)
      expect(errors).toEqual([])
    })
  })
})
