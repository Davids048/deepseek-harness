// Chat with the agent: user stories of the right-panel chat and its composer, driven in Chromium against the shipped
// profile with the fake video backend and a scripted OpenAI-compatible model (`scripted-model.ts`). Each story opens a
// fresh browser context and its own project, then checks the screen against the UI state contract (the destination is
// shown, nothing is left over) and, where the story is about what the agent sees, the request the model received.
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bootHarness, playwright, waitFor, type BootedHarness } from '../harness.ts'
import { assetIdOf, opIdOf, startScriptedModel, textOf, type ChatRequest, type ScriptedModel, type ScriptedRule } from '../scripted-model.ts'

/** A 1×1 opaque PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
/** Two more 1×1 PNGs with other colors: assets are stored by content, so each seeded project gets its own bytes. */
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4IScHAAK2AQU0pnWqAAAAAElFTkSuQmCC'
const GREEN_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQOyEHAAIMAQUtuDZBAAAAAElFTkSuQmCC'

interface OpWire { id: string; tool?: { name: string }; status: string; outputs: string[] }
interface StateWire { ops: OpWire[]; sequence: { items: unknown[] } | null }

/**
 * The scripted agent. `只回复<X>` answers `收到<X>`; `慢慢想` streams for six seconds; `加人物` registers a character;
 * `慢慢做` uploads an image and then streams for eight seconds, so a stop leaves an open draft; `新建项目` creates a
 * project as the agent does from the entry page; `做两个镜头的广告` uploads a reference, plans two shots, approves, and
 * waits, leaving an open draft; `两段待批` asks for two generations at once, which wait for approval cards in 生成前先问
 * mode.
 */
const RULES: ScriptedRule[] = [
  { match: /只回复\S+/, steps: [view => ({ text: `收到${/只回复(\S+)/.exec(view.userText)?.[1] ?? ''}` })] },
  { match: '慢慢想', steps: [{ text: '想好了', delayMs: 6000 }] },
  { match: '新建项目', steps: [{ calls: [{ name: 'vh_project_create', args: { title: '入口创建的项目' } }] }], endText: '项目建好了，收到十六' },
  {
    match: '讲一个故事',
    steps: [
      { calls: [{ name: 'vh_project_create', args: { title: '故事项目' } }] },
      { calls: [{ name: 'ask_user_question', args: { questions: [{ id: 'length', header: '长度', question: '视频要多长？', options: [{ label: '15 秒', description: '三个镜头' }, { label: '30 秒', description: '六个镜头' }] }] } }] },
    ],
    endText: '好的，请发一张参考图。',
  },
  {
    match: '慢慢做',
    steps: [
      { calls: [{ name: 'vh_asset_upload', args: { reason: '产品图', base64: PNG_BASE64, mime: 'image/png', name: 'slow.png' } }] },
      { text: '还在做……', delayMs: 8000 },
    ],
  },
  { match: '看看这张图', steps: [view => ({ calls: [{ name: 'vh_perception_describe', args: { reason: '看图', inputs: { image: /asset (\w+)/.exec(view.userText)?.[1] ?? '' } } }] })], endText: '看过了。' },
  {
    match: '点名生成一段',
    steps: [
      { calls: [{ name: 'vh_asset_upload', args: { reason: '产品图', base64: PNG_BASE64, mime: 'image/png', name: 'named.png' } }] },
      view => ({ calls: [{ name: 'vh_generate_video', args: { reason: '用户点名', prompt: '点名的镜头', duration_sec: 1, inputs: { reference: assetIdOf(view.toolResults[0], 'asset') }, user_requested: true } }] }),
    ],
    endText: '生成好了。',
  },
  { match: '看项目', steps: [{ calls: [{ name: 'vh_project_state', args: { reason: '读项目' } }] }], endText: '项目已读。' },
  {
    match: '加人物',
    steps: [
      { calls: [{ name: 'vh_asset_upload', args: { reason: '人物参考图', base64: PNG_BASE64, mime: 'image/png', name: 'hero.png' } }] },
      view => ({ calls: [{ name: 'vh_entity_character_create', args: { reason: '登记人物', entity: 'c1', name: '小橘', refs: [assetIdOf(view.toolResults[0], 'asset')] } }] }),
    ],
    endText: '人物小橘已登记。',
  },
  {
    match: '做两个镜头的广告',
    steps: [
      { calls: [{ name: 'vh_asset_upload', args: { reason: '产品图', base64: PNG_BASE64, mime: 'image/png', name: 'product.png' } }] },
      view => ({ calls: [{ name: 'vh_plan_create', args: {
        reason: '规划', title: '产品广告', continuity: 'independent', references: [assetIdOf(view.toolResults[0], 'asset')],
        shots: [{ prompt: '产品特写', duration_sec: 1 }, { prompt: '产品使用场景', duration_sec: 2 }],
      } }] }),
      view => ({ calls: [{ name: 'vh_plan_approve', args: { reason: '用户同意', plan: opIdOf(view.toolResults[1]), user_approved: true } }] }),
      { calls: [{ name: 'vh_wait', args: {} }] },
    ],
    endText: '两个镜头已生成。草稿待确认',
  },
  {
    match: '两段待批',
    steps: [
      { calls: [{ name: 'vh_asset_upload', args: { reason: '产品图', base64: PNG_BASE64, mime: 'image/png', name: 'product.png' } }] },
      view => ({ calls: [
        { name: 'vh_generate_video', args: { reason: '第一段', prompt: '第一段画面', duration_sec: 1, inputs: { reference: assetIdOf(view.toolResults[0], 'asset') } } },
        { name: 'vh_generate_video', args: { reason: '第二段', prompt: '第二段画面', duration_sec: 2, inputs: { reference: assetIdOf(view.toolResults[0], 'asset') } } },
      ] }),
    ],
    endText: '处理完毕。',
  },
]

describe('chat with the agent', () => {
  let harness: BootedHarness
  let model: ScriptedModel
  let browser: Browser
  const contexts: BrowserContext[] = []
  let lastPage: Page | null = null

  beforeAll(async () => {
    model = await startScriptedModel(RULES)
    harness = await bootHarness({ modelBaseUrl: model.baseURL })
    const executablePath = process.env['DSH_PLAYWRIGHT_EXECUTABLE_PATH']
    browser = await playwright.chromium.launch(executablePath === undefined ? {} : { executablePath })
  }, 150_000)

  afterEach(async (context) => {
    // With VH_E2E_SHOTS set, a failed story leaves a screenshot of its page there.
    const dir = process.env['VH_E2E_SHOTS']
    if (dir === undefined || lastPage === null || context.task.result?.state !== 'fail') return
    await lastPage.screenshot({ path: `${dir}/${context.task.name.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 80)}.png` }).catch(() => undefined)
  })

  afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    await harness?.close()
    await model?.close()
  })

  /** A fresh browser context on the harness with the beta notice dismissed; page errors are collected. */
  async function openPage(lang: 'zh' | 'en' = 'zh', hash = ''): Promise<{ page: Page; errors: string[] }> {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: lang === 'en' ? 'en-US' : 'zh-CN' })
    contexts.push(context)
    const page = await context.newPage()
    lastPage = page
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(String(error)) })
    await page.goto(harness.tokenUrl, { waitUntil: 'load' })
    // DSH shows its beta notice once per browser profile, a moment after load.
    const notice = page.getByRole('button', { name: lang === 'en' ? 'Continue' : '继续', exact: true }).first()
    if (await notice.waitFor({ timeout: 8000 }).then(() => true, () => false)) await notice.click()
    await page.locator('[data-vh-entry], [data-vh-workspace]').first().waitFor({ timeout: 30_000 })
    if (hash !== '') {
      // A fresh document load (the query string differs from `/`) restores the location the hash names.
      await page.goto(`${harness.origin}/?story=1${hash}`, { waitUntil: 'load' })
      const project = new URLSearchParams(hash.replace(/^#/, '')).get('project')
      await waitFor(() => Promise.resolve(locationOf(page).project === project), 'the URL location to be restored', 15_000)
      await page.locator('[data-vh-workspace]').waitFor({ timeout: 30_000 })
    }
    return { page, errors }
  }

  /** The project and session of the URL hash. */
  function locationOf(page: Page): { project: string | null; session: string | null; view: string | null } {
    const params = new URLSearchParams(new URL(page.url()).hash.replace(/^#/, ''))
    return { project: params.get('project'), session: params.get('session'), view: params.get('view') }
  }

  /** The visible chat composer of the right panel. */
  const composer = (page: Page) => page.locator('[data-vh-chat]:visible [contenteditable="true"]:visible').first()
  /** The right-panel chat that is on screen; the panel keeps earlier sessions' chats mounted but hidden. */
  const chat = (page: Page) => page.locator('[data-vh-chat]:visible').first()
  /** The user message bubbles of the right-panel chat, in order. */
  const userMessages = async (page: Page): Promise<string[]> =>
    (await chat(page).locator('[data-chat-flow-kind="user"]').allInnerTexts()).map(text => (text.split('\n')[0] ?? '').replace(/\d{1,2}:\d{2}$/, '').trim())

  /** Click 新项目 / New project and wait until the workspace and its chat composer are up. */
  async function newProject(page: Page, lang: 'zh' | 'en' = 'zh'): Promise<string> {
    await page.getByText(lang === 'zh' ? '新项目' : 'New project', { exact: false }).first().click()
    await page.locator('[data-vh-workspace]').waitFor({ timeout: 30_000 })
    await composer(page).waitFor({ timeout: 30_000 })
    return await waitFor(() => Promise.resolve(locationOf(page).project), 'a project in the URL', 10_000)
  }

  /**
   * Whether the user can see an element: its center is inside the viewport and the topmost element there is it or its
   * descendant. Playwright's isVisible also counts elements that an overflow-hidden ancestor clips away.
   */
  async function onScreen(locator: Locator): Promise<boolean> {
    if (await locator.count() === 0) return false
    return await locator.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      if (box.width === 0 || box.height === 0 || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
      const hit = document.elementFromPoint(x, y)
      return hit !== null && (element === hit || element.contains(hit))
    })
  }

  /** Type a message into the right-panel composer and press Enter. */
  async function send(page: Page, text: string): Promise<void> {
    await composer(page).click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }

  /** Wait until the right-panel chat shows `text`. */
  async function waitChat(page: Page, text: string, timeout = 30_000): Promise<void> {
    await chat(page).getByText(text, { exact: false }).first().waitFor({ timeout })
  }

  /** The system and developer prompt of a model request, joined. */
  function promptOf(request: ChatRequest): string {
    return request.messages.filter(message => message.role === 'system' || message.role === 'developer').map(message => textOf(message.content)).join('\n')
  }

  /** The typed user message of a model request (skipping DSH runtime context and reminders). */
  function userTextOf(request: ChatRequest): string {
    const typed = request.messages.filter(message => message.role === 'user' && !/^(<system-reminder>|Current runtime context|Attached image|The user referenced these project items)/.test(textOf(message.content)))
    return textOf(typed.at(-1)?.content)
  }

  /** The @ reference expansion the mentions plugin added to a model request, or the empty string. */
  function referencesOf(request: ChatRequest): string {
    const block = request.messages.filter(message => message.role === 'user' && textOf(message.content).startsWith('The user referenced these project items'))
    return textOf(block.at(-1)?.content)
  }

  /** The newest model request whose typed user message contains `text`. */
  function requestFor(text: string): ChatRequest | undefined {
    return [...model.requests].reverse().find(request => userTextOf(request).includes(text))
  }

  /** Invoke a tool through the views API. */
  async function invoke(
    project: string,
    tool: string,
    params: Record<string, unknown>,
    inputs: Array<{ role: string; ref: string }> = [],
  ): Promise<OpWire> {
    return await harness.api.post('/api/vh/invoke', { project, tool, params, inputs, surface: 'canvas', intent: `story: ${tool}` }) as OpWire
  }

  /** Create a project through the API with an uploaded image named `name`; returns the project and asset IDs. */
  async function seedProject(title: string, name: string, base64 = PNG_BASE64): Promise<{ projectId: string; assetId: string }> {
    const created = await harness.api.post('/api/vh/projects', { title, surface: 'canvas' }) as { projectId: string }
    const upload = await invoke(created.projectId, 'asset.upload', { base64, mime: 'image/png', name })
    return { projectId: created.projectId, assetId: upload.outputs[0] ?? '' }
  }

  it('keeps three messages in a row in order, each with its own reply, and clears the composer after each', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    for (const word of ['一', '二', '三']) {
      await send(page, `只回复${word}`)
      await waitChat(page, `收到${word}`)
      expect((await composer(page).innerText()).trim()).toBe('')
    }
    expect(await userMessages(page)).toEqual(['只回复一', '只回复二', '只回复三'])
    const replies = await chat(page).innerText()
    expect(replies.indexOf('收到一')).toBeLessThan(replies.indexOf('收到二'))
    expect(replies.indexOf('收到二')).toBeLessThan(replies.indexOf('收到三'))
    // The agent works inside the open project and introduces itself as a video agent.
    const prompt = promptOf(requestFor('只回复一') as ChatRequest)
    expect(prompt).toContain('never call vh_project_create')
    expect(prompt).not.toContain('coding agent')
    expect(prompt).not.toContain('powered by DeepSeek Harness')
    // Creators get the video tools, not the developer tool set.
    const tools = (requestFor('只回复一')?.tools ?? []).map(tool => tool.function?.name ?? '')
    expect(tools.filter(name => ['bash', 'glob', 'grep', 'edit', 'write', 'web_fetch', 'web_search'].includes(name))).toEqual([])
    expect(errors).toEqual([])
  })

  it('a turn that only looks at an image leaves no draft to accept', async () => {
    const { projectId, assetId } = await seedProject('只看图', 'look.png', RED_PNG)
    const { page, errors } = await openPage('zh', `#project=${projectId}`)
    await send(page, `看看这张图 asset ${assetId}`)
    await waitChat(page, '看过了')
    const workspace = page.locator('[data-vh-workspace]')
    await page.waitForTimeout(2000)
    expect(await workspace.getByRole('button', { name: '接受', exact: true }).count()).toBe(0)
    expect(await workspace.locator('[data-node-draft="true"]').count()).toBe(0)
    expect(errors).toEqual([])
  })

  it('a generation the user asked for by name lands at turn end, recorded as accepted by the system, not the user', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await send(page, '点名生成一段')
    await waitChat(page, '生成好了', 60_000)
    const state = await waitFor(async () => {
      const value = await harness.api.get(`/api/vh/state?project=${projectId}&head=main`) as { ops: Array<OpWire & { kind?: string; actor?: string; params?: Record<string, unknown> }> }
      return value.ops.some(op => op.tool?.name === 'generate.video') ? value : null
    }, 'the generation on main', 30_000)
    const accepts = state.ops.filter(op => op.kind === 'approve' && op.params?.['approval_of'] === undefined)
    expect(accepts.length).toBeGreaterThan(0)
    expect(accepts.every(op => op.actor !== 'user')).toBe(true)
    expect(errors).toEqual([])
  })

  it('after 停止生成 the draft bar offers 丢弃, and discarding clears it without errors', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    await send(page, '慢慢做')
    const workspace = page.locator('[data-vh-workspace]')
    await workspace.locator('[data-node-kind="reference"]').first().waitFor({ timeout: 15_000 })
    await chat(page).getByRole('button', { name: /停止|Stop/ }).first().click({ timeout: 10_000 })
    const discard = workspace.getByRole('button', { name: '丢弃', exact: true })
    await discard.first().click({ timeout: 15_000 })
    await waitFor(async () => await discard.count() === 0, 'the draft bar to close', 10_000)
    await page.reload({ waitUntil: 'load' })
    await composer(page).waitFor({ timeout: 30_000 })
    expect(await workspace.getByRole('button', { name: '丢弃', exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
  })

  it('answers a message sent while a turn is still running, without losing it, and never shows DeepSeek branding', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    await send(page, '慢慢想')
    await page.waitForTimeout(1000)
    // While the first turn streams, the running status is DreamVerse copy, not the DSH "深度求索中" brand line.
    expect.soft(await chat(page).innerText()).not.toContain('深度求索')
    await send(page, '只回复四')
    await waitChat(page, '想好了', 20_000)
    await waitChat(page, '收到四', 20_000)
    expect(await userMessages(page)).toEqual(['慢慢想', '只回复四'])
    expect((await composer(page).innerText()).trim()).toBe('')
    expect(errors).toEqual([])
  })

  it('restores the same project, session, and chat history after a reload, and the composer still sends', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    await send(page, '只回复五')
    await waitChat(page, '收到五')
    const before = locationOf(page)
    await page.reload({ waitUntil: 'load' })
    await waitChat(page, '收到五')
    expect(locationOf(page)).toEqual(before)
    await send(page, '只回复六')
    await waitChat(page, '收到六')
    expect(locationOf(page)).toEqual(before)
    expect(await userMessages(page)).toEqual(['只回复五', '只回复六'])
    expect(errors).toEqual([])
  })

  it('switching to another project shows that project\'s chat, leaves no unsent text behind, and switching back restores the history', async () => {
    const { page, errors } = await openPage()
    const first = await newProject(page)
    await send(page, '只回复七')
    await waitChat(page, '收到七')
    await composer(page).click()
    await page.keyboard.type('还没发出去的话')
    const second = await harness.api.post('/api/vh/projects', { title: '切换目标项目', surface: 'canvas' }) as { projectId: string }
    await page.locator('[title="切换目标项目"]').first().click({ timeout: 15_000 })
    await waitFor(() => Promise.resolve(locationOf(page).project === second.projectId), 'the second project in the URL', 15_000)
    await composer(page).waitFor({ timeout: 15_000 })
    // The chat follows the project within a moment of the click.
    await waitFor(async () => (await userMessages(page)).length === 0, 'the second project\'s empty chat', 3000).catch(() => undefined)
    expect(await userMessages(page)).toEqual([])
    expect(await composer(page).innerText()).not.toContain('还没发出去的话')
    const firstTitle = await page.evaluate(async (id) => {
      const links = await (await fetch('/api/vh/workspaces')).json() as { projects: Array<{ projectId: string; title: string }> }
      return links.projects.find(project => project.projectId === id)?.title ?? ''
    }, first)
    await page.locator(`[title="${firstTitle}"]`).first().click()
    await waitFor(() => Promise.resolve(locationOf(page).project === first), 'the first project in the URL', 15_000)
    await waitChat(page, '收到七')
    expect(await userMessages(page)).toEqual(['只回复七'])
    expect(errors).toEqual([])
  })

  it('accepting the agent draft on the canvas clears the draft bar, and the agent is told no draft is open', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    await send(page, '做两个镜头的广告')
    await waitChat(page, '两个镜头已生成', 60_000)
    const workspace = page.locator('[data-vh-workspace]')
    await workspace.locator('[data-node-kind="plan"]').first().waitFor({ timeout: 15_000 })
    const accept = workspace.getByRole('button', { name: '接受', exact: true })
    await accept.first().click({ timeout: 15_000 })
    await waitFor(async () => await accept.count() === 0, 'the draft bar to close', 10_000)
    expect(await workspace.locator('[data-node-draft="true"]').count()).toBe(0)
    await send(page, '只回复八')
    await waitChat(page, '收到八')
    const prompt = promptOf(requestFor('只回复八') as ChatRequest)
    expect(prompt).toContain('No draft is open.')
    expect(prompt).not.toContain('exploration branch')
    expect(errors).toEqual([])
  })

  it('discarding the agent draft from the cuts top bar empties the cuts and the canvas drafts', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await send(page, '做两个镜头的广告')
    await waitChat(page, '两个镜头已生成', 60_000)
    await page.getByRole('tab', { name: '剪辑' }).click()
    const workspace = page.locator('[data-vh-workspace]')
    const discard = workspace.getByRole('button', { name: '丢弃', exact: true })
    await discard.first().click({ timeout: 15_000 })
    await waitFor(async () => await discard.count() === 0, 'the top-bar draft bar to close', 10_000)
    const state = await harness.api.get(`/api/vh/state?project=${projectId}&head=main`) as StateWire
    expect(state.sequence?.items.length ?? 0).toBe(0)
    await page.getByRole('tab', { name: '画布' }).click()
    expect(await workspace.locator('[data-node-draft="true"]').count()).toBe(0)
    await send(page, '只回复九')
    await waitChat(page, '收到九')
    expect(promptOf(requestFor('只回复九') as ChatRequest)).toContain('No draft is open.')
    expect(errors).toEqual([])
  })

  it('in 生成前先问 mode shows each generation as a visible approval card with a count, and handles 跳过 and 批准', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    await chat(page).getByRole('button', { name: '生成前先问', exact: true }).click()
    await send(page, '两段待批')
    // The agent asks for two generations; the tool calls run one at a time, so one card waits at a time.
    const cards = chat(page).locator('[data-state="awaiting-approval"]')
    await cards.first().waitFor({ state: 'attached', timeout: 30_000 })
    await chat(page).getByText('待批准 (1)').waitFor({ timeout: 10_000 })
    expect.soft(await onScreen(cards.first()), 'the approval card is on screen, not folded into the tool row').toBe(true)
    // dispatchEvent reaches the button even while the card is folded away.
    await cards.first().locator('button', { hasText: '跳过' }).dispatchEvent('click')
    await waitFor(async () => (await cards.first().textContent() ?? '').includes('第二段画面'), 'the second approval card', 30_000)
    expect.soft(await onScreen(cards.first()), 'the second approval card is on screen').toBe(true)
    await chat(page).getByText('待批准 (1)').waitFor({ timeout: 10_000 })
    await cards.first().locator('button', { hasText: '批准' }).dispatchEvent('click')
    await waitChat(page, '处理完毕', 60_000)
    expect(await cards.count()).toBe(0)
    expect(await chat(page).getByText('待批准 (').count()).toBe(0)
    const finished = chat(page).locator('[data-tool="vh_generate_video"]')
    expect(await finished.filter({ hasText: '未生成' }).count()).toBe(1)
    expect(await finished.filter({ hasText: '已生成' }).count()).toBe(1)
    // The mode belongs to the session and survives a reload.
    await page.reload({ waitUntil: 'load' })
    await composer(page).waitFor({ timeout: 30_000 })
    const ask = chat(page).getByRole('button', { name: '生成前先问', exact: true })
    await ask.waitFor({ timeout: 15_000 })
    await waitFor(async () => await ask.evaluate(element => getComputedStyle(element).color) === 'rgb(255, 255, 255)', 'the ask-first toggle to be active', 10_000)
    expect(errors).toEqual([])
  })

  it('in 生成前先问 mode a plan approval waits for one card that lists every shot before anything generates', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await chat(page).getByRole('button', { name: '生成前先问', exact: true }).click()
    await send(page, '做两个镜头的广告')
    const card = chat(page).locator('[data-state="awaiting-approval"]').first()
    await card.waitFor({ state: 'attached', timeout: 30_000 })
    expect(await card.textContent()).toContain('产品特写')
    expect(await card.textContent()).toContain('产品使用场景')
    expect(await onScreen(card)).toBe(true)
    // The card names the product model, and the waiting step is named for creators, never by its wire tool name.
    expect(await card.textContent()).toContain('DreamVerse 视频模型')
    await waitFor(async () => (await chat(page).locator('[data-process-activity]').allTextContents()).some(text => text.includes('批准计划')), 'the 批准计划 step title', 10_000)
    expect(await chat(page).getByText('vh_plan_approve').count()).toBe(0)
    const pending = await harness.api.get(`/api/vh/state?project=${projectId}&head=main`) as StateWire
    expect(pending.ops.filter(op => op.tool?.name === 'generate.video')).toHaveLength(0)
    await card.locator('button', { hasText: '批准' }).first().click()
    await waitChat(page, '两个镜头已生成', 60_000)
    expect(errors).toEqual([])
  })

  it('an image attached in the chat becomes a project asset', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await composer(page).click()
    await chat(page).locator('button', { hasText: '＋' }).first().click().catch(async () => {
      // The ＋ button carries an icon; fall back to the first button of the composer bar.
      await chat(page).locator('[data-slot="conversation.composer"] button').first().click()
    })
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10_000 }),
      page.locator('[role="option"], [role="menuitem"]').filter({ hasText: '文件' }).first().click(),
    ])
    await chooser.setFiles({ name: 'attached-ad.png', mimeType: 'image/png', buffer: Buffer.from(RED_PNG, 'base64') })
    await page.keyboard.type('只回复图')
    await page.keyboard.press('Enter')
    await waitChat(page, '收到图')
    const state = await waitFor(async () => {
      const value = await harness.api.get(`/api/vh/state?project=${projectId}&head=main`) as { assets: Array<{ name: string; mime: string }> }
      return value.assets.some(asset => asset.mime.startsWith('image/')) ? value : null
    }, 'the attachment as a project asset', 15_000).catch(() => null)
    expect(state, 'the chat attachment is recorded as a project asset').not.toBeNull()
    expect(errors).toEqual([])
  })

  it('@ lists the open project\'s items only, and the agent receives the concrete asset ID of a picked item', async () => {
    await seedProject('提及甲', 'alpha-only.png', RED_PNG)
    const target = await seedProject('提及乙', 'beta-only.png', GREEN_PNG)
    const { page, errors } = await openPage('zh', `#project=${target.projectId}`)
    await composer(page).waitFor({ timeout: 30_000 })
    // The @ list is a listbox of options; the canvas also shows the asset name, so the lookups stay inside the list.
    const options = page.locator('[role="listbox"] [role="option"]')
    const candidate = options.filter({ hasText: 'beta-only.png' })
    // In a blank chat the composer sits at the top of the panel; the @ list must still be on screen there.
    await composer(page).click()
    await page.keyboard.type('@')
    await candidate.first().waitFor({ state: 'attached', timeout: 15_000 })
    expect.soft(await onScreen(candidate.first()), 'the @ list is visible in a blank chat').toBe(true)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Backspace')
    await send(page, '只回复准备')
    await waitChat(page, '收到准备')
    await composer(page).click()
    // Chinese writers type @ straight after a character, without a space.
    await page.keyboard.type('用这个只回复十@')
    await candidate.first().waitFor({ timeout: 15_000 })
    expect(await options.filter({ hasText: 'alpha-only.png' }).count()).toBe(0)
    // DSH's own @ sources (workspace files such as the oplog's ops.jsonl, and every session on the server) stay out.
    expect.soft(await options.filter({ hasText: /ops\.jsonl|session-/ }).count(), 'DSH file and session candidates in the @ list').toBe(0)
    await candidate.first().click()
    await page.keyboard.press('Enter')
    await waitChat(page, '收到十')
    // The sent bubble shows the chip label, not the wire form of the reference.
    expect(await chat(page).locator('[data-chat-flow-kind="user"]').last().innerText()).not.toContain('vh:')
    const expansion = referencesOf(requestFor('用这个') as ChatRequest)
    // The expansion names the asset and its upload record in this project.
    expect(expansion).toContain(`asset ${target.assetId} made by record`)
    expect(errors).toEqual([])
  })

  it('让 agent 改 on a canvas clip prefills the open project\'s chat composer with a reference the agent can resolve', async () => {
    const { projectId, assetId } = await seedProject('改片段', 'ref.png')
    const plan = await invoke(projectId, 'plan.create', { title: '改片段', continuity: 'independent', references: [assetId], shots: [{ prompt: '镜头甲', duration_sec: 1 }] })
    await invoke(projectId, 'plan.approve', { plan: plan.id })
    const done = await waitFor(async () => {
      const state = await harness.api.get(`/api/vh/state?project=${projectId}&head=main`) as StateWire
      return state.ops.find(op => op.tool?.name === 'generate.video' && op.status === 'done')
    }, 'the clip to render', 60_000)
    // Visit another project first, so a stale composer from it would be a wrong target.
    const { page, errors } = await openPage()
    await newProject(page)
    await page.locator('[title="改片段"]').first().click({ timeout: 15_000 })
    await waitFor(() => Promise.resolve(locationOf(page).project === projectId), 'the seeded project in the URL', 15_000)
    const editor = page.locator('[data-testid="vh-node-editor"]')
    await waitFor(async () => {
      // The canvas fits its view after the nodes load; a click during that move can miss, so click until it opens.
      await page.locator('[data-vh-workspace] [data-node-kind="clip"]').first().click({ timeout: 10_000 })
      return await editor.isVisible()
    }, 'the clip editor', 30_000)
    await editor.getByRole('button', { name: '让 agent 改', exact: true }).click()
    await waitFor(async () => (await composer(page).innerText()).includes('修改'), 'the prefilled composer', 10_000)
    expect(locationOf(page).project).toBe(projectId)
    await page.keyboard.type('只回复十一')
    await page.keyboard.press('Enter')
    await waitChat(page, '收到十一')
    expect(await chat(page).locator('[data-chat-flow-kind="user"]').last().innerText()).not.toContain('vh:')
    // The expansion resolves the clip to its record in this project.
    const expansion = referencesOf(requestFor('只回复十一') as ChatRequest)
    expect(expansion).toContain(`made by record ${done.id}`)
    expect(errors).toEqual([])
  })

  it('a second chat session in the same project sees what the first session made', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await send(page, '加人物')
    await waitChat(page, '人物小橘已登记')
    const first = locationOf(page).session
    await page.locator('[data-vh-workspace] [data-node-kind="entity"]').first().waitFor({ timeout: 15_000 })
    // The project row's ＋ starts a second chat session in the same project.
    await page.locator('[data-vh-navigator] [data-active]').filter({ hasText: '＋' }).first().locator('button', { hasText: '＋' }).click()
    await waitFor(() => Promise.resolve(locationOf(page).session !== first && locationOf(page).session !== null), 'a second session', 15_000)
    expect(locationOf(page).project).toBe(projectId)
    expect(await userMessages(page)).toEqual([])
    expect(await page.locator('[data-vh-workspace] [data-node-kind="entity"]').count()).toBeGreaterThan(0)
    await send(page, '只回复十三')
    await waitChat(page, '收到十三')
    expect(promptOf(requestFor('只回复十三') as ChatRequest)).toContain('小橘')
    expect(errors).toEqual([])
  })

  it('chatting while the cuts view is open keeps the cuts view and the project', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await page.getByRole('tab', { name: '剪辑' }).click()
    await send(page, '只回复十四')
    await waitChat(page, '收到十四')
    expect(locationOf(page)).toMatchObject({ project: projectId, view: 'cuts' })
    expect(await page.getByRole('tab', { name: '剪辑' }).getAttribute('data-active')).toBe('')
    expect(errors).toEqual([])
  })

  it('a request typed on the entry page creates a project and moves the chat, with its history, to the right panel', async () => {
    const { page, errors } = await openPage()
    await page.locator('[data-vh-entry] [contenteditable="true"]').first().click({ timeout: 30_000 })
    await page.keyboard.type('新建项目做个短片')
    await page.keyboard.press('Enter')
    await waitFor(() => Promise.resolve(locationOf(page).project), 'a project in the URL', 30_000)
    await page.locator('[data-vh-workspace]').waitFor({ timeout: 15_000 })
    await waitChat(page, '收到十六')
    expect(await userMessages(page)).toEqual(['新建项目做个短片'])
    expect(await page.locator('[data-vh-workspace]').innerText()).toContain('入口创建的项目')
    expect(await page.locator('[data-vh-entry]').count()).toBe(0)
    expect(errors).toEqual([])
  })

  it('after an entry-page request, a question card, an image-only message, and a look at 轨迹, the 对话 composer still sends', async () => {
    const { page, errors } = await openPage()
    await page.locator('[data-vh-entry] [contenteditable="true"]').first().click({ timeout: 30_000 })
    await page.keyboard.type('讲一个故事')
    await page.keyboard.press('Enter')
    // The agent creates the project from the entry chat, so the chat moves to the right panel, then asks a question.
    const question = chat(page).locator('[data-question-key]')
    await question.waitFor({ timeout: 30_000 })
    await question.locator('[role="radio"]').first().click()
    await question.locator('footer button').last().click()
    await waitChat(page, '请发一张参考图')
    expect(await question.count()).toBe(0)
    // An image with no text.
    await chat(page).locator('input[type="file"]').first().setInputFiles({ name: 'hero.png', mimeType: 'image/png', buffer: Buffer.from(RED_PNG, 'base64') })
    await chat(page).locator('[data-composer-seat] button[aria-label="发送消息"], [data-composer-seat] button[aria-label="Send message"]').first().click({ timeout: 10_000 })
    // No rule matches an image-only message, so the scripted model answers 好的。
    await waitChat(page, '好的。')
    // The developer view mounts the same session's conversation next to the kept-mounted chat.
    const tab = (title: string) => page.locator('[data-dockkit-tab]:visible', { has: page.locator('[data-dockkit-tab-title]', { hasText: title }) }).first()
    await tab('轨迹').click()
    await page.locator('[data-vh-trajectory]').first().waitFor({ timeout: 10_000 })
    await tab('对话').click()
    await send(page, '只回复十八')
    await waitChat(page, '收到十八')
    expect((await composer(page).innerText()).trim()).toBe('')
    expect(await userMessages(page)).toContain('只回复十八')
    expect(errors).toEqual([])
  })

  it('the composer shows DreamVerse copy only: the placeholder names project items, and no DSH file-permission chip', async () => {
    const { page } = await openPage()
    await newProject(page)
    const placeholder = await composer(page).getAttribute('data-placeholder') ?? ''
    expect(placeholder).not.toContain('文件或对话')
    expect(await chat(page).getByText('工作区内修改').count()).toBe(0)
  })

  it('in English, the composer controls, placeholder, and approval cards are English', async () => {
    const { page, errors } = await openPage('en')
    expect(await page.evaluate(() => document.documentElement.lang)).toMatch(/^en/)
    await newProject(page, 'en')
    // The mode controls render once the session's mode has been read, which can be after the composer shows.
    await chat(page).getByRole('button', { name: 'Ask first', exact: true }).waitFor()
    for (const label of ['Ask first', 'Generate directly', 'Quality', 'Speed']) {
      expect(await chat(page).getByRole('button', { name: label, exact: true }).count()).toBe(1)
    }
    await chat(page).getByRole('button', { name: 'Ask first', exact: true }).click()
    await send(page, '两段待批')
    await chat(page).locator('[data-state="awaiting-approval"]').first().waitFor({ state: 'attached', timeout: 30_000 })
    await chat(page).getByText('Pending approval (1)').waitFor({ timeout: 10_000 })
    // Apart from the typed message and the scripted prompts, nothing in the chat panel is Chinese.
    const panel = (await chat(page).innerText()).replaceAll('两段待批', '').replaceAll('第一段画面', '').replaceAll('第二段画面', '')
    expect(panel.match(/[一-鿿]+/g) ?? []).toEqual([])
    expect.soft(await composer(page).getAttribute('data-placeholder') ?? '').not.toContain('files or sessions')
    // Approve the first card, then the second one when it arrives.
    const cards = chat(page).locator('[data-state="awaiting-approval"]')
    for (const prompt of ['第一段画面', '第二段画面']) {
      await waitFor(async () => (await cards.first().textContent() ?? '').includes(prompt), `the approval card of ${prompt}`, 30_000)
      expect.soft(await onScreen(cards.first().locator('button', { hasText: 'Approve' }).first()), 'the Approve button is on screen').toBe(true)
      await cards.first().locator('button', { hasText: 'Approve' }).first().dispatchEvent('click')
    }
    await waitChat(page, '处理完毕', 60_000)
    expect(errors).toEqual([])
  })
})
