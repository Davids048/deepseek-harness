// Navigation, projects, chat sessions, and panels: user stories of the DreamVerse shell, driven in Chromium against the
// shipped profile with the fake video backend and a scripted OpenAI-compatible model (`scripted-model.ts`). Each story
// opens a fresh browser context and its own projects, then checks the screen against the UI state contract: after an
// action the center, breadcrumb, navigator highlight, right panel, and URL all show exactly the destination.
import type { Browser, BrowserContext, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { WireProjectLink } from '@dv/ui-kit/types.ts'
import { bootHarness, playwright, waitFor, type BootedHarness } from '../harness.ts'
import { startScriptedModel, type ScriptedModel, type ScriptedRule } from '../scripted-model.ts'

/** A 1×1 opaque PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Two more 1×1 PNGs with other colors, so imports in different stories are different files. */
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGM4ISf3HwAEugIEPlcfxwAAAABJRU5ErkJggg=='
const GREEN_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQW2DzHwAD1AH6mPShBQAAAABJRU5ErkJggg=='

/** The title the scripted agent gives the project it creates from the entry page. */
const ENTRY_PROJECT = 'E2E 入口项目'

/**
 * The scripted agent. `只回复<X>` answers `收到<X>`; `入口请求` creates the project {@link ENTRY_PROJECT} with
 * `dv_proj_create` and then answers.
 */
const RULES: ScriptedRule[] = [
  { match: /只回复\S+/, steps: [view => ({ text: `收到${/只回复(\S+)/.exec(view.userText)?.[1] ?? ''}` })] },
  { match: '另起项目', steps: [{ calls: [{ name: 'dv_proj_create', args: { title: 'NAV 另起' } }] }], endText: '已另起项目。' },
  { match: '入口请求', steps: [{ calls: [{ name: 'dv_proj_create', args: { title: ENTRY_PROJECT } }] }], endText: '项目已建好。' },
]

/** One project as `/api/dv/workspaces` lists it. */
/** The location fields of the URL hash. */
interface Location { project: string | null; session: string | null; view: string | null }

describe('navigation, projects, sessions, and panels', () => {
  let harness: BootedHarness
  let model: ScriptedModel
  let browser: Browser
  const contexts: BrowserContext[] = []
  /** Contexts that already hold the session cookie from the token URL. */
  const signedIn = new WeakSet<BrowserContext>()

  beforeAll(async () => {
    model = await startScriptedModel(RULES)
    harness = await bootHarness({ modelBaseUrl: model.baseURL })
    const executablePath = process.env['DSH_PLAYWRIGHT_EXECUTABLE_PATH']
    browser = await playwright.chromium.launch(executablePath === undefined ? {} : { executablePath })
  }, 150_000)

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    await harness?.close()
    await model?.close()
  })

  let firstContext = 0
  beforeEach(() => { firstContext = contexts.length })
  afterEach(async (test) => {
    // With DV_NAV_SHOTS=<dir>, a failed story leaves a screenshot of each page it opened in <dir>.
    const dir = process.env['DV_NAV_SHOTS']
    if (dir === undefined || test.task.result?.state !== 'fail') return
    let index = 0
    for (const context of contexts.slice(firstContext)) for (const page of context.pages()) {
      index += 1
      await page.screenshot({ path: `${dir}/${test.task.name.slice(0, 40).replace(/[^\p{L}\p{N}]+/gu, '-')}-${String(index)}.png` }).catch(() => undefined)
    }
  })

  /** A fresh Chinese or English browser context on the harness. Page errors are collected; confirm dialogs accepted. */
  async function newContext(lang: 'zh' | 'en' = 'zh'): Promise<BrowserContext> {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: lang === 'en' ? 'en-US' : 'zh-CN' })
    contexts.push(context)
    return context
  }

  /** Dismiss DSH's beta notice, which a fresh browser shows a moment after load. */
  async function dismissNotice(page: Page): Promise<void> {
    const notice = page.getByRole('button', { name: /^(继续|Continue)$/ }).first()
    const shown = await notice.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false)
    if (shown) await notice.click()
  }

  /**
   * Open a page on the harness, optionally at a location hash, with the beta notice dismissed.
   * @param options - the language, the hash, and an existing context to open the page in.
   * @returns the page and its collected page errors.
   */
  async function openPage(options: { lang?: 'zh' | 'en'; hash?: string; context?: BrowserContext; notice?: 'dismiss' | 'keep' } = {}): Promise<{ page: Page; errors: string[] }> {
    const context = options.context ?? await newContext(options.lang)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(String(error)) })
    page.on('dialog', (dialog) => { void dialog.accept() })
    // One full page load at the wanted location, as when a creator opens a link; a later hash-only goto would be a
    // same-document navigation instead.
    const hash = options.hash ?? ''
    await page.goto(signedIn.has(context) ? `${harness.origin}/${hash}` : `${harness.tokenUrl}${hash}`, { waitUntil: 'load' })
    signedIn.add(context)
    if (options.notice !== 'keep') await dismissNotice(page)
    await page.locator('[data-dv-navigator]').waitFor({ timeout: 30_000 })
    return { page, errors }
  }

  /** The location of the URL hash. */
  function locationOf(page: Page): Location {
    const params = new URLSearchParams(new URL(page.url()).hash.replace(/^#/, ''))
    return { project: params.get('project'), session: params.get('session'), view: params.get('view') }
  }

  /** The projects the server lists. */
  async function projects(): Promise<WireProjectLink[]> {
    return (await harness.api.get('/api/dv/workspaces') as { projects: WireProjectLink[] }).projects
  }

  /** The title of a project ID. */
  async function titleOf(projectId: string | null): Promise<string | undefined> {
    return (await projects()).find(project => project.id === projectId)?.title
  }

  /** The navigator. */
  const navigator = (page: Page) => page.locator('[data-dv-navigator]')
  /** A project row of the navigator. */
  const projectRow = (page: Page, title: string) => navigator(page).locator('div:not([role])', { has: page.locator(`span[role="button"][title="${title}"]`) }).last()
  /** The chat session rows of the navigator, in order. */
  const sessionRows = (page: Page) => navigator(page).locator('div[role="button"]')
  /** The highlighted chat session row. */
  const activeSessionRow = (page: Page) => navigator(page).locator('div[role="button"][data-active]')

  /** The highlighted project row's title, or null. */
  async function activeProject(page: Page): Promise<string | null> {
    const label = navigator(page).locator('div[data-active]:not([role]) span[role="button"][title]')
    return await label.count() === 0 ? null : await label.first().getAttribute('title')
  }

  /** The highlighted top-level navigator entries (首页 and similar), by text. */
  async function activeNavEntries(page: Page): Promise<string[]> {
    return (await navigator(page).locator(':scope > button[data-active]').allInnerTexts()).map(text => text.trim())
  }

  /** The breadcrumb as [project, session], or null on the entry page. */
  async function crumbs(page: Page): Promise<[string, string] | null> {
    const bar = page.locator('[data-dv-workspace] header > div').first()
    if (await bar.count() === 0) return null
    const spans = await bar.locator(':scope > span').allInnerTexts()
    return [spans[0]?.trim() ?? '', spans.at(-1)?.trim() ?? '']
  }

  /** The visible right-panel tab titles, in strip order. */
  async function rightTabs(page: Page): Promise<string[]> {
    return await page.locator('[data-dockkit-tab]:visible [data-dockkit-tab-title]').allInnerTexts()
  }

  /** Select a right-panel tab by title. */
  async function selectTab(page: Page, title: string): Promise<void> {
    await page.locator('[data-dockkit-tab]:visible', { has: page.locator('[data-dockkit-tab-title]', { hasText: title }) }).first().click()
  }

  /** The right-panel chat. */
  const chat = (page: Page) => page.locator('[data-dv-chat]:visible').first()
  /** The visible chat composer of the right panel or the entry page. */
  const composer = (page: Page) => page.locator('[data-dv-chat] [contenteditable="true"]:visible, [data-dv-entry] [contenteditable="true"]:visible').first()

  /** The user message texts of the visible chat. */
  async function userMessages(page: Page): Promise<string[]> {
    const bubbles = page.locator('[data-dv-chat]:visible [data-chat-flow-kind="user"]')
    return (await bubbles.allInnerTexts()).map(text => text.split('\n')[0]?.trim() ?? '')
  }

  /** Type a message into the visible composer, press Enter, and wait for the scripted reply. */
  async function send(page: Page, word: string): Promise<void> {
    await composer(page).click()
    await page.keyboard.type(`只回复${word}`)
    await page.keyboard.press('Enter')
    await page.locator('[data-dv-chat]:visible').getByText(`收到${word}`).first().waitFor({ timeout: 30_000 })
  }

  /** Wait until the shell shows project `title`: workspace, breadcrumb, and navigator highlight. */
  async function waitProject(page: Page, title: string): Promise<void> {
    await waitFor(async () => (await crumbs(page))?.[0] === title && await activeProject(page) === title, `project ${title} open`, 20_000)
  }

  /** Click 新建项目 and wait for the created project; returns its ID and title. */
  async function newProject(page: Page, label = '新建项目'): Promise<{ projectId: string; title: string }> {
    const before = locationOf(page).project
    await navigator(page).getByRole('button', { name: label }).click()
    const projectId = await waitFor(() => Promise.resolve(locationOf(page).project !== before && locationOf(page).project), 'a new project in the URL', 20_000)
    const title = await waitFor(() => titleOf(projectId), 'the new project title', 10_000)
    await waitProject(page, title)
    await composer(page).waitFor({ timeout: 20_000 })
    return { projectId, title }
  }

  /** Create a project through the API; returns its ID. */
  async function createProject(title: string): Promise<string> {
    return (await harness.api.post('/api/dv/projects', { title, surface: 'canvas' }) as { id: string }).id
  }

  /** Import a PNG (base64) named `name` into a project through the API. */
  async function importPng(projectId: string, name: string, png = PNG_BASE64): Promise<void> {
    await harness.api.post('/api/dv/operation', { project: projectId, operation: 'asset.import', params: { base64: png, mime: 'image/png', name }, inputs: [], surface: 'canvas', intent: 'story: import' })
  }

  /** Open a project from its navigator row and wait until the shell shows it. */
  async function openProject(page: Page, title: string): Promise<void> {
    await projectRow(page, title).locator('span[role="button"][title]').click()
    await waitProject(page, title)
    await waitFor(() => Promise.resolve(locationOf(page).session), `a chat session of ${title}`, 20_000)
    await composer(page).waitFor({ timeout: 20_000 })
    // The project's chat session can still be swapping in; typing before it settles loses the text.
    await page.waitForTimeout(1000)
  }

  /** Run one entry of a navigator row menu (project or session row). */
  async function rowMenu(page: Page, row: ReturnType<Page['locator']>, item: string | RegExp): Promise<void> {
    await row.hover()
    await row.locator('button[aria-haspopup="menu"]').click()
    await page.getByRole('menuitem', { name: item }).click()
  }

  /** Rename through an inline rename field that has focus. */
  async function typeRename(page: Page, title: string, key: 'Enter' | 'Escape' = 'Enter'): Promise<void> {
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(title)
    await page.keyboard.press(key)
  }

  /**
   * The contract check for an open project: the URL names it, the breadcrumb and the navigator highlight show its
   * title, and the 对话 tab is in the right panel.
   */
  async function expectProjectShown(page: Page, projectId: string): Promise<void> {
    const title = await titleOf(projectId)
    expect(locationOf(page).project).toBe(projectId)
    expect((await crumbs(page))?.[0]).toBe(title)
    expect(await activeProject(page)).toBe(title)
    expect(await activeNavEntries(page)).not.toContain('首页')
  }

  /** The contract check for the entry page: no project anywhere, 首页 highlighted, the right panel shows nothing. */
  async function expectEntryShown(page: Page): Promise<void> {
    await page.locator('[data-dv-entry]').waitFor({ timeout: 20_000 })
    expect(locationOf(page).project).toBeNull()
    expect(await page.locator('[data-dv-workspace]').count()).toBe(0)
    expect(await activeNavEntries(page)).toContain('首页')
    expect(await activeProject(page)).toBeNull()
    await waitFor(async () => (await rightTabs(page)).length === 0, 'the right panel to empty on the entry page', 5000).catch(() => undefined)
    expect(await rightTabs(page)).toEqual([])
  }

  it('first visit: the entry page is DreamVerse, highlights 首页, and shows no DSH notice or project panel', async () => {
    const { page, errors } = await openPage({ notice: 'keep' })
    await page.getByText('今天想做一个什么视频？').waitFor({ timeout: 20_000 })
    await expectEntryShown(page)
    // The first screen a creator sees must not read as a DeepSeek developer tool.
    const text = await page.locator('body').innerText()
    expect(text).not.toMatch(/DeepSeek Harness|内测声明|深度求索|选择一个工作区/)
    expect(errors).toEqual([])
  })

  it('typing a request on the entry page creates a project and moves into it', async () => {
    const { page, errors } = await openPage()
    await page.locator('[data-dv-entry]').waitFor()
    await composer(page).click()
    await page.keyboard.type('入口请求：做一个橘猫看日落的短片')
    await page.keyboard.press('Enter')
    const project = await waitFor(async () => (await projects()).find(candidate => candidate.title === ENTRY_PROJECT), 'the agent-created project', 30_000)
    await waitProject(page, ENTRY_PROJECT)
    await expectProjectShown(page, project.id)
    // The request that started the project stays visible in the project's 对话 tab.
    await waitFor(async () => (await rightTabs(page)).includes('对话'), 'the 对话 tab', 10_000)
    await chat(page).getByText('项目已建好').first().waitFor({ timeout: 20_000 })
    expect((await userMessages(page)).join('\n')).toContain('入口请求')
    expect(errors).toEqual([])
  })

  it('新建项目 several times gives unique titles, and each project opens clean: empty canvas, chat, and assets', async () => {
    const { page, errors } = await openPage()
    const first = await newProject(page)
    await importPng(first.projectId, 'only-in-first.png', RED_PNG)
    await send(page, '甲')
    const titles = [first.title]
    for (let round = 0; round < 3; round += 1) {
      const created = await newProject(page)
      titles.push(created.title)
      await expectProjectShown(page, created.projectId)
      expect(await crumbs(page)).toEqual([created.title, '新对话'])
      // Nothing from the previous project: no canvas nodes, no messages, no assets.
      expect(await page.locator('[data-dv-workspace] [data-node-id]').count()).toBe(0)
      expect(await userMessages(page)).toEqual([])
      await selectTab(page, '素材库')
      const assets = page.locator('[data-testid="dv-asset-pool-panel"]:visible')
      await assets.waitFor({ timeout: 10_000 })
      await page.waitForTimeout(1000)
      expect(await assets.locator('[data-asset-id]').count()).toBe(0)
      await selectTab(page, '对话')
    }
    expect(new Set(titles).size).toBe(titles.length)
    expect(errors).toEqual([])
  })

  it('two tabs that click 新建项目 at the same moment get two projects with different titles', async () => {
    const context = await newContext()
    const { page: one } = await openPage({ context })
    const { page: two } = await openPage({ context })
    const before = new Set((await projects()).map(project => project.id))
    await Promise.all([
      navigator(one).getByRole('button', { name: '新建项目' }).click(),
      navigator(two).getByRole('button', { name: '新建项目' }).click(),
    ])
    const created = await waitFor(async () => {
      const fresh = (await projects()).filter(project => !before.has(project.id))
      return fresh.length >= 2 ? fresh : null
    }, 'two new projects', 20_000)
    expect(created).toHaveLength(2)
    expect(created[0]?.title).not.toBe(created[1]?.title)
  })

  it('renames a project from its row menu and by double-clicking the breadcrumb; titles stay unique', async () => {
    const { page, errors } = await openPage()
    const other = await createProject('NAV 已占用')
    const { projectId, title } = await newProject(page)
    await rowMenu(page, projectRow(page, title), '重命名')
    await typeRename(page, 'NAV 行菜单改名')
    await waitProject(page, 'NAV 行菜单改名')
    expect(await titleOf(projectId)).toBe('NAV 行菜单改名')
    // Double-clicking the breadcrumb title renames in place; Escape cancels and an empty title changes nothing.
    await page.locator('[data-dv-workspace] header > div > span').first().dblclick()
    await typeRename(page, 'NAV 面包屑改名')
    await waitProject(page, 'NAV 面包屑改名')
    await page.locator('[data-dv-workspace] header > div > span').first().dblclick()
    await typeRename(page, '不要保存', 'Escape')
    await page.locator('[data-dv-workspace] header > div > span').first().dblclick()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    expect(await titleOf(projectId)).toBe('NAV 面包屑改名')
    expect(await page.locator('[data-dv-workspace] header input').count()).toBe(0)
    // A title another project already uses comes back unique, and the navigator never shows two equal titles.
    await rowMenu(page, projectRow(page, 'NAV 面包屑改名'), '重命名')
    await typeRename(page, 'NAV 已占用')
    const renamed = await waitFor(async () => {
      const current = await titleOf(projectId)
      return current !== 'NAV 面包屑改名' ? current : null
    }, 'the rename to land', 10_000)
    expect(renamed).not.toBe(await titleOf(other))
    await waitProject(page, renamed)
    const listed = await navigator(page).locator('span[role="button"][title]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))
    expect(listed.filter(listedTitle => listedTitle === renamed)).toHaveLength(1)
    expect(listed.filter(listedTitle => listedTitle === 'NAV 已占用')).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('deletes a project that is not open, then the open one, which returns to the entry page', async () => {
    const { page, errors } = await openPage()
    const side = await newProject(page)
    const open = await newProject(page)
    await rowMenu(page, projectRow(page, side.title), '删除项目')
    await waitFor(async () => await projectRow(page, side.title).count() === 0, 'the deleted row to disappear', 10_000)
    expect(await titleOf(side.projectId)).toBeUndefined()
    await expectProjectShown(page, open.projectId)
    const openHash = new URL(page.url()).hash
    await rowMenu(page, projectRow(page, open.title), '删除项目')
    await expectEntryShown(page)
    expect(await page.locator('[data-dv-entry]').innerText()).not.toContain(open.title)
    expect(await projectRow(page, open.title).count()).toBe(0)
    // A stale link to the deleted project lands on the entry page too.
    await page.goto(`${harness.origin}/${openHash}`, { waitUntil: 'load' })
    await page.reload({ waitUntil: 'load' })
    await expectEntryShown(page)
    expect(errors).toEqual([])
  })

  it('chat sessions: ＋ starts one without piling up blanks; switch, rename, reload, and delete open and not open', async () => {
    const { page, errors } = await openPage()
    const { projectId, title } = await newProject(page)
    await send(page, '一')
    const first = locationOf(page).session
    const plus = projectRow(page, title).getByRole('button', { name: '＋' })
    await plus.click()
    await waitFor(() => Promise.resolve(locationOf(page).session !== first), 'a second session', 20_000)
    const second = locationOf(page).session
    expect(await crumbs(page)).toEqual([title, '新对话'])
    expect(await userMessages(page)).toEqual([])
    // A second ＋ on a blank session keeps that session: no pile of empty chats.
    await plus.click()
    await page.waitForTimeout(1500)
    expect(locationOf(page).session).toBe(second)
    expect(await sessionRows(page).count()).toBe(2)
    await send(page, '二')
    await rowMenu(page, activeSessionRow(page), '重命名')
    await typeRename(page, '会话二')
    await waitFor(async () => (await crumbs(page))?.[1] === '会话二', 'the open session renamed', 10_000)
    const firstRow = sessionRows(page).filter({ hasNotText: '会话二' }).first()
    await rowMenu(page, firstRow, '重命名')
    await typeRename(page, '会话一')
    // Switch to the first session: URL, breadcrumb, highlight, and chat all follow, and survive a reload.
    await sessionRows(page).filter({ hasText: '会话一' }).click()
    await waitFor(async () => locationOf(page).session === first && (await crumbs(page))?.[1] === '会话一', 'the first session open', 10_000)
    expect(await activeSessionRow(page).innerText()).toContain('会话一')
    expect(await userMessages(page)).toEqual(['只回复一'])
    await page.reload({ waitUntil: 'load' })
    await waitFor(async () => (await crumbs(page))?.[1] === '会话一', 'the first session after reload', 20_000)
    expect(locationOf(page)).toMatchObject({ project: projectId, session: first })
    // Delete the session that is not open: it disappears and the location stays.
    await rowMenu(page, sessionRows(page).filter({ hasText: '会话二' }), /^删除(会话|对话)$/)
    await waitFor(async () => await sessionRows(page).filter({ hasText: '会话二' }).count() === 0, 'session 二 gone', 10_000)
    expect(locationOf(page).session).toBe(first)
    // Delete the open session: the page moves to the project's latest other session.
    await plus.click()
    await waitFor(() => Promise.resolve(locationOf(page).session !== first), 'a third session', 20_000)
    await send(page, '三')
    const third = locationOf(page).session
    await sessionRows(page).filter({ hasText: '会话一' }).click()
    await waitFor(() => Promise.resolve(locationOf(page).session === first), 'back on session 一', 10_000)
    await rowMenu(page, activeSessionRow(page), /^删除(会话|对话)$/)
    await waitFor(() => Promise.resolve(locationOf(page).session === third), 'moved to the latest other session', 20_000)
    await expectProjectShown(page, projectId)
    // Delete the last session: the project stays open on a blank chat.
    await rowMenu(page, activeSessionRow(page), /^删除(会话|对话)$/)
    await waitFor(() => Promise.resolve(locationOf(page).session !== third && locationOf(page).session !== null), 'a blank session', 20_000)
    await expectProjectShown(page, projectId)
    expect(await crumbs(page)).toEqual([title, '新对话'])
    expect(await userMessages(page)).toEqual([])
    expect(errors).toEqual([])
  })

  it('DSH New Session is gone, or starts a chat in the open project and on the entry page stays on the entry page', async () => {
    const { page, errors } = await openPage()
    const { projectId, title } = await newProject(page)
    await send(page, '四')
    const used = locationOf(page).session
    // Rule 4 allows removing DSH's own New Session button; when it is still shown it must act inside the project model.
    const dshNew = page.locator('button:visible', { hasText: /^\s*新会话\s*$/ })
    if (await dshNew.count() === 0) return
    await dshNew.first().click()
    await waitFor(() => Promise.resolve(locationOf(page).session !== used), 'a new session', 20_000)
    await expectProjectShown(page, projectId)
    expect(await crumbs(page)).toEqual([title, '新对话'])
    await navigator(page).getByRole('button', { name: '首页' }).click()
    await expectEntryShown(page)
    await dshNew.first().click()
    await page.waitForTimeout(1500)
    await expectEntryShown(page)
    expect(errors).toEqual([])
  })

  it('switching between two projects on the canvas and the timeline: nothing from one shows in the other', async () => {
    const a = await createProject('NAV 切换甲')
    const b = await createProject('NAV 切换乙')
    await importPng(a, 'only-in-jia.png', GREEN_PNG)
    const { page, errors } = await openPage()
    await openProject(page, 'NAV 切换甲')
    await send(page, '甲')
    await openProject(page, 'NAV 切换乙')
    await send(page, '乙')
    /** Open `title` and check that the right panel and center belong to it and not to `other`. */
    const checkSwitch = async (title: string, projectId: string, word: string, otherWord: string): Promise<void> => {
      await openProject(page, title)
      await expectProjectShown(page, projectId)
      await waitFor(async () => (await userMessages(page)).includes(`只回复${word}`), `${title} chat`, 10_000)
      expect(await userMessages(page)).not.toContain(`只回复${otherWord}`)
      await selectTab(page, '素材库')
      const assets = page.locator('[data-testid="dv-asset-pool-panel"]:visible')
      await assets.waitFor({ timeout: 10_000 })
      if (projectId === a) await assets.locator('[data-asset-id][title="only-in-jia.png"]').first().waitFor({ timeout: 10_000 })
      else {
        await page.waitForTimeout(1000)
        expect(await assets.locator('[data-asset-id]').count()).toBe(0)
      }
      await selectTab(page, '对话')
    }
    await checkSwitch('NAV 切换甲', a, '甲', '乙')
    await checkSwitch('NAV 切换乙', b, '乙', '甲')
    // From the timeline.
    await page.locator('[data-dv-workspace] [role="tab"]', { hasText: '时间线' }).click()
    await checkSwitch('NAV 切换甲', a, '甲', '乙')
    // Fast clicks end on the last project clicked.
    for (const title of ['NAV 切换甲', 'NAV 切换乙', 'NAV 切换甲', 'NAV 切换乙', 'NAV 切换甲']) {
      await projectRow(page, title).locator('span[role="button"][title]').click()
    }
    await waitProject(page, 'NAV 切换甲')
    await page.waitForTimeout(3000)
    await expectProjectShown(page, a)
    await waitFor(async () => (await userMessages(page)).includes('只回复甲'), '甲 chat after fast clicks', 10_000)
    expect(errors).toEqual([])
  })

  /** Reload `page` and expect the same location and breadcrumb as before. */
  async function expectReloadKeeps(page: Page, label: string): Promise<void> {
    // Let the location settle (the entry page adds its chat session to the URL) before taking the reference.
    await page.waitForTimeout(2000)
    const before = { location: locationOf(page), crumbs: await crumbs(page) }
    await page.reload({ waitUntil: 'load' })
    await page.waitForTimeout(4000)
    await waitFor(async () => JSON.stringify(await crumbs(page)) === JSON.stringify(before.crumbs), `${label}: breadcrumb after reload`, 20_000)
      .catch(() => undefined)
    expect({ label, location: locationOf(page), crumbs: await crumbs(page) }).toEqual({ label, ...before })
  }

  it('the same image imported into two projects under different names shows each project its own name', async () => {
    const a = await createProject('NAV 同图甲')
    const b = await createProject('NAV 同图乙')
    await importPng(a, 'jia-name.png')
    await importPng(b, 'yi-name.png')
    const { page, errors } = await openPage()
    await openProject(page, 'NAV 同图乙')
    await selectTab(page, '素材库')
    const assets = page.locator('[data-testid="dv-asset-pool-panel"]:visible')
    await assets.waitFor({ timeout: 10_000 })
    await page.waitForTimeout(1500)
    // Nothing from project 甲, not even the file name it gave the same bytes, shows in project 乙.
    const tiles = await assets.locator('[data-asset-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))
    expect({ where: '素材库', names: tiles }).toEqual({ where: '素材库', names: ['yi-name.png'] })
    expect({ where: 'canvas', text: await page.locator('[data-testid="dv-canvas-view"]').innerText() }).not.toMatchObject({ text: expect.stringContaining('jia-name') })
    expect(errors).toEqual([])
  })

  it('the open project stays listed and highlighted when many newer projects exist', async () => {
    const old = await createProject('NAV 很早的项目')
    for (let index = 0; index < 13; index += 1) await createProject(`NAV 较新 ${String(index)}`)
    const { page, errors } = await openPage({ hash: `#project=${old}` })
    await waitFor(async () => (await crumbs(page))?.[0] === 'NAV 很早的项目', 'the old project open', 20_000).catch(() => undefined)
    if ((await crumbs(page))?.[0] !== 'NAV 很早的项目') {
      await navigator(page).getByRole('button', { name: '全部项目' }).click()
      await openProject(page, 'NAV 很早的项目')
      await navigator(page).getByRole('button', { name: '收起项目' }).click()
    }
    await page.waitForTimeout(5000)
    expect(await activeProject(page)).toBe('NAV 很早的项目')
    expect(errors).toEqual([])
  })

  it('the sidebar and the right-panel ＋ offer only DreamVerse entries: no 插件, 工作区文件, or 终端', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    expect(await page.locator('button:visible, a:visible', { hasText: /^\s*插件\s*$/ }).count()).toBe(0)
    await page.getByRole('button', { name: '新标签页' }).click()
    await page.waitForTimeout(1000)
    // The new-tab guide lists DreamVerse panels only, each once.
    const body = await page.locator('body').innerText()
    for (const dsh of ['工作区文件', '新建终端', '视频画布']) expect(body).not.toContain(dsh)
    expect(errors).toEqual([])
  })

  it('an empty 对话 and 轨迹 tab of a new project say what to do next', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    const chatText = (await chat(page).innerText()).replace(/\s+/g, '')
    // Beyond the composer controls, the blank chat carries a hint in the interface language.
    expect(chatText.replace(/发消息|调用指令|文件或对话|工作区内修改/g, '').length).toBeGreaterThan(4)
    await selectTab(page, '轨迹')
    const trajectory = page.locator('[data-dv-trajectory]:visible')
    await trajectory.waitFor({ timeout: 10_000 })
    expect((await trajectory.innerText()).trim().length).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  it('a chat the agent moves into a project it creates is listed under one project only', async () => {
    const { page, errors } = await openPage()
    const first = await newProject(page)
    await composer(page).click()
    await page.keyboard.type('另起项目：换一个主题')
    await page.keyboard.press('Enter')
    await chat(page).getByText('已另起项目').first().waitFor({ timeout: 30_000 })
    await page.waitForTimeout(2000)
    // Whether the agent opened a second project or stayed in this one, the chat belongs to exactly one project: the one
    // the center shows.
    const shownProject = locationOf(page).project
    await expectProjectShown(page, shownProject ?? '')
    const session = locationOf(page).session
    await rowMenu(page, activeSessionRow(page), '重命名')
    await typeRename(page, 'NAV 漂移会话')
    await waitFor(async () => await sessionRows(page).filter({ hasText: 'NAV 漂移会话' }).count() > 0, 'the renamed row', 10_000)
    for (const title of [first.title, 'NAV 另起']) {
      const toggle = projectRow(page, title).locator('span[role="button"]').first()
      if (await toggle.count() > 0 && (await toggle.innerText()).includes('▸')) await toggle.click()
    }
    await page.waitForTimeout(1000)
    expect(await sessionRows(page).filter({ hasText: 'NAV 漂移会话' }).count()).toBe(1)
    expect(locationOf(page).session).toBe(session)
    expect(errors).toEqual([])
  })

  it('reload restores the entry page, the canvas, the timeline, and an older chat session', async () => {
    const { page, errors } = await openPage()
    await page.locator('[data-dv-entry]').waitFor()
    await expectReloadKeeps(page, 'entry')
    const { title } = await newProject(page)
    await send(page, '旧')
    await expectReloadKeeps(page, 'canvas')
    await page.locator('[data-dv-workspace] [role="tab"]', { hasText: '时间线' }).click()
    await expectReloadKeeps(page, 'timeline')
    await page.locator('[data-dv-workspace] [role="tab"]', { hasText: '画布' }).click()
    const older = locationOf(page).session
    await projectRow(page, title).getByRole('button', { name: '＋' }).click()
    await waitFor(() => Promise.resolve(locationOf(page).session !== older), 'a newer session', 20_000)
    await send(page, '新')
    await sessionRows(page).nth(1).click()
    await waitFor(() => Promise.resolve(locationOf(page).session === older), 'the older session open', 10_000)
    await expectReloadKeeps(page, 'older chat session')
    expect(await userMessages(page)).toEqual(['只回复旧'])
    expect(errors).toEqual([])
  })

  it('a project link opened in a fresh browser opens that project, whatever session DSH last used', async () => {
    await createProject('NAV 链接甲')
    const b = await createProject('NAV 链接乙')
    // One browser sits on 甲's blank chat, which makes it DSH's most recent session.
    const { page: sitter } = await openPage()
    await openProject(sitter, 'NAV 链接甲')
    await composer(sitter).waitFor({ timeout: 20_000 })
    const { page, errors } = await openPage({ hash: `#project=${b}` })
    await page.waitForTimeout(5000)
    await expectProjectShown(page, b)
    expect(errors).toEqual([])
  })

  it('a project link opened in a second tab shows that project with its latest chat and the right panel', async () => {
    const context = await newContext()
    const { page: first } = await openPage({ context })
    const target = await newProject(first)
    await send(first, '链')
    const targetSession = locationOf(first).session
    await newProject(first)
    const { page: second, errors } = await openPage({ context, hash: `#project=${target.projectId}` })
    await waitFor(() => Promise.resolve(locationOf(second).session), 'a session in the second tab', 20_000).catch(() => undefined)
    await expectProjectShown(second, target.projectId)
    expect(locationOf(second).session).toBe(targetSession)
    expect(await rightTabs(second)).toContain('对话')
    expect(await userMessages(second)).toEqual(['只回复链'])
    expect(errors).toEqual([])
  })

  it('browser Back and Forward move between the locations the user visited', async () => {
    const a = await createProject('NAV 后退甲')
    await createProject('NAV 后退乙')
    const { page, errors } = await openPage()
    await page.locator('[data-dv-entry]').waitFor()
    await openProject(page, 'NAV 后退甲')
    await openProject(page, 'NAV 后退乙')
    await page.goBack({ waitUntil: 'load' })
    await page.waitForTimeout(3000)
    expect(page.url()).toContain(harness.origin)
    await waitProject(page, 'NAV 后退甲')
    await expectProjectShown(page, a)
    await page.goForward({ waitUntil: 'load' })
    await waitProject(page, 'NAV 后退乙')
    expect(errors).toEqual([])
  })

  it('closing every right-panel tab and collapsing both sidebars can all be undone', async () => {
    const { page, errors } = await openPage()
    const { projectId, title } = await newProject(page)
    await waitFor(async () => (await rightTabs(page)).length === 4, 'the four default tabs', 20_000)
    expect([...await rightTabs(page)].sort()).toEqual(['对话', '素材库', '历史', '轨迹'].sort())
    for (const tab of ['轨迹', '历史', '素材库', '对话']) {
      const item = page.locator('[data-dockkit-tab]', { has: page.locator('[data-dockkit-tab-title]', { hasText: tab }) }).first()
      await item.hover()
      await item.locator('[data-dockkit-tab-close]').click()
      await waitFor(async () => !(await rightTabs(page)).includes(tab), `${tab} closed`, 5000)
    }
    expect(await rightTabs(page)).toEqual([])
    // The top bar's 面板 brings back 对话 / 素材库 / 历史 / 轨迹 with 对话 in front.
    await page.getByRole('button', { name: '打开右侧面板', exact: true }).click()
    await waitFor(async () => (await rightTabs(page)).length === 4, 'tabs reopened', 10_000)
    await chat(page).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: '收起右侧边栏' }).click()
    await waitFor(async () => (await rightTabs(page)).length === 0, 'right panel collapsed', 5000)
    await page.getByRole('button', { name: '打开右侧面板', exact: true }).click()
    await waitFor(async () => (await rightTabs(page)).length === 4, 'right panel expanded', 10_000)
    await page.getByRole('button', { name: '收起侧边栏' }).click()
    await waitFor(async () => !await navigator(page).isVisible(), 'navigator hidden', 5000)
    await page.getByRole('button', { name: '打开侧边栏' }).click()
    await navigator(page).waitFor({ timeout: 5000 })
    await waitProject(page, title)
    await expectProjectShown(page, projectId)
    expect(errors).toEqual([])
  })

  it('deleting the last project returns to an entry page that says what to do next', async () => {
    const keep = await createProject('NAV 最后一个')
    for (const project of await projects()) {
      if (project.id !== keep) await harness.api.post('/api/dv/projects/delete', { project: project.id })
    }
    const { page, errors } = await openPage()
    await openProject(page, 'NAV 最后一个')
    await rowMenu(page, projectRow(page, 'NAV 最后一个'), '删除项目')
    await expectEntryShown(page)
    expect(await projects()).toEqual([])
    expect(await page.getByText('最近项目').count()).toBe(0)
    // The empty project list tells the creator how to start instead of showing a bare 项目 heading.
    expect(await navigator(page).innerText()).toMatch(/还没有项目|暂无项目|没有项目/)
    expect(errors).toEqual([])
  })
  it('switching the DSH language to English turns every DreamVerse string English, and back', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    await waitFor(async () => (await rightTabs(page)).length === 4, 'the four default tabs', 20_000)
    /** Pick a language in DSH Settings → General. */
    const pickLanguage = async (settings: string, current: string, wanted: string): Promise<void> => {
      await page.getByRole('button', { name: settings }).click()
      await page.locator('[role="dialog"] button', { hasText: current }).click()
      await page.getByText(wanted, { exact: true }).last().click()
      await page.keyboard.press('Escape')
      await waitFor(() => page.evaluate(() => document.documentElement.lang), 'the language attribute', 5000)
    }
    await pickLanguage('设置', '中文', 'English')
    try {
      await waitFor(async () => await page.evaluate(() => document.documentElement.lang) === 'en', '<html lang> en', 5000)
      const nav = await navigator(page).innerText()
      for (const label of ['Create project', 'Home', 'Projects']) expect(nav).toContain(label)
      const bar = await page.locator('[data-dv-workspace] header').innerText()
      for (const label of ['Canvas', 'Timeline', 'New chat']) expect(bar).toContain(label)
      await expect.poll(() => page.locator('[data-dv-workspace] header').getByRole('button', { name: 'Open the right panel', exact: true }).count()).toBe(1)
      expect([...await rightTabs(page)].sort()).toEqual(['Asset pool', 'Chat', 'History', 'Trajectory'])
    } finally {
      // The language is a durable DSH preference shared by every browser of this harness; restore Chinese.
      await page.keyboard.press('Escape')
      await pickLanguage('Settings', 'English', '中文')
    }
    await waitFor(async () => (await page.evaluate(() => document.documentElement.lang)).startsWith('zh'), '<html lang> zh', 5000)
    expect([...await rightTabs(page)].sort()).toEqual(['对话', '素材库', '历史', '轨迹'].sort())
    expect(await navigator(page).innerText()).toContain('新建项目')
    expect(errors).toEqual([])
  })
})
