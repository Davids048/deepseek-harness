// Chat with the agent: user stories of the right-panel chat and its composer, driven in Chromium against the shipped
// profile with the fake video backend and a scripted OpenAI-compatible model (`scripted-model.ts`). Each story opens a
// fresh browser context and its own project, then checks the screen against the UI state contract (the destination is
// shown, nothing is left over) and, where the story is about what the agent sees, the request the model received.
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectRecord, WireState } from '@dv/ui-kit/types.ts'
import { bootHarness, playwright, waitFor, type BootedHarness } from '../harness.ts'
import {
  assetIdOf, startScriptedModel, textOf, type ChatRequest, type ScriptedModel, type ScriptedRule, type ScriptedStep, type TurnView,
} from '../scripted-model.ts'

/** A 1×1 opaque PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
/** Three more 1×1 PNGs with other colors: assets are stored by content, so each seeded project gets its own bytes. */
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4IScHAAK2AQU0pnWqAAAAAElFTkSuQmCC'
const GREEN_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQOyEHAAIMAQUtuDZBAAAAAElFTkSuQmCC'
const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcLgAAAG0ATF+kRwWAAAAAElFTkSuQmCC'

/**
 * The scripted `dv_plan_create` call of a two-shot plan whose shots render from the image the turn imported first.
 * @param view - the turn so far; its first tool result is the import.
 * @param title - the plan title.
 * @returns the step.
 */
function planCall(view: TurnView, title: string): ScriptedStep {
  return { calls: [{ name: 'dv_plan_create', args: {
    reason: '规划', title, references: [assetIdOf(view.toolResults[0], 'asset')],
    shots: [
      { prompt: 'Picture 1 产品特写', duration_sec: 1, mode: 'ref2va' },
      { prompt: 'Picture 1 产品使用场景', duration_sec: 2, mode: 'ref2va' },
    ],
  } }] }
}

/**
 * The scripted agent. `只回复<X>` answers `收到<X>`; `慢慢想` streams for six seconds; `加人物` registers a character;
 * `慢慢做` imports an image and then streams for eight seconds, so a stop lands while the turn runs; `新建项目` creates a
 * project as the agent does from the entry page; `做两个镜头的广告` imports a reference, plans two shots, approves, and
 * waits; every record lands on the project's current branch at once; `先给我看计划` imports a reference, plans two shots,
 * calls the plan approval without the user's agreement (Project refuses it), and asks in bold; `可以渲染` approves that
 * plan with the user's agreement and waits; `两段渲染` renders two shots at once.
 */
const RULES: ScriptedRule[] = [
  { match: /只回复\S+/, steps: [view => ({ text: `收到${/只回复(\S+)/.exec(view.userText)?.[1] ?? ''}` })] },
  { match: '慢慢想', steps: [{ text: '想好了', delayMs: 6000 }] },
  { match: '新建项目', steps: [{ calls: [{ name: 'dv_proj_create', args: { title: '入口创建的项目' } }] }], endText: '项目建好了，收到十六' },
  {
    match: '讲一个故事',
    steps: [
      { calls: [{ name: 'dv_proj_create', args: { title: '故事项目' } }] },
      { calls: [{ name: 'ask_user_question', args: { questions: [{ id: 'length', header: '长度', question: '视频要多长？', options: [{ label: '15 秒', description: '三个镜头' }, { label: '30 秒', description: '六个镜头' }] }] } }] },
    ],
    endText: '好的，请发一张参考图。',
  },
  {
    match: '慢慢做',
    steps: [
      { calls: [{ name: 'dv_asset_import', args: { reason: '产品图', base64: PNG_BASE64, mime: 'image/png', name: 'slow.png' } }] },
      { text: '还在做……', delayMs: 8000 },
    ],
  },
  { match: '看看这张图', steps: [view => ({ calls: [{ name: 'dv_inspect_image', args: { reason: '看图', inputs: { image: /asset (\w+)/.exec(view.userText)?.[1] ?? '' } } }] })], endText: '看过了。' },
  {
    match: '点名渲染一段',
    steps: [
      { calls: [{ name: 'dv_asset_import', args: { reason: '产品图', base64: PNG_BASE64, mime: 'image/png', name: 'named.png' } }] },
      view => ({ calls: [{ name: 'dv_shot_render_ref2va', args: {
        reason: '用户点名', prompt: '点名的镜头', duration_sec: 1, user_requested: true,
        inputs: { reference: assetIdOf(view.toolResults[0], 'asset') },
      } }] }),
    ],
    endText: '渲染好了。',
  },
  { match: '看项目', steps: [{ calls: [{ name: 'dv_proj_state', args: {} }] }], endText: '项目已读。' },
  {
    match: '加人物',
    steps: [
      { calls: [{ name: 'dv_asset_import', args: { reason: '人物参考图', base64: PNG_BASE64, mime: 'image/png', name: 'hero.png' } }] },
      view => ({ calls: [{
        name: 'dv_bible_character_create',
        args: { reason: '登记人物', character: 'c1', name: '小橘', inputs: { reference: [assetIdOf(view.toolResults[0], 'asset')] } },
      }] }),
    ],
    endText: '人物小橘已登记。',
  },
  {
    match: '做两个镜头的广告',
    steps: [
      { calls: [{ name: 'dv_asset_import', args: { reason: '产品图', base64: PNG_BASE64, mime: 'image/png', name: 'product.png' } }] },
      view => planCall(view, '产品广告'),
      // The story's project is new, so its first plan is p1.
      { calls: [{ name: 'dv_plan_approve', args: { reason: '用户同意', plan: 'p1', user_approved: true } }] },
      { calls: [{ name: 'dv_proj_wait', args: {} }] },
    ],
    endText: '两个镜头已渲染。',
  },
  {
    match: '先给我看计划',
    steps: [
      { calls: [{ name: 'dv_asset_import', args: { reason: '产品图', base64: PNG_BASE64, mime: 'image/png', name: 'ask-first.png' } }] },
      view => planCall(view, '先问再渲染'),
      // Without user_approved, Project refuses the call and tells the agent to ask in the conversation.
      { calls: [{ name: 'dv_plan_approve', args: { reason: '按计划渲染', plan: 'p1' } }] },
      { text: '计划有两个镜头。**现在渲染这两个镜头吗？**' },
    ],
  },
  {
    match: '可以渲染',
    steps: [
      { calls: [{ name: 'dv_plan_approve', args: { reason: '用户同意', plan: 'p1', user_approved: true } }] },
      { calls: [{ name: 'dv_proj_wait', args: {} }] },
    ],
    endText: '两个镜头已渲染。',
  },
  {
    match: '两段渲染',
    steps: [
      { calls: [{ name: 'dv_asset_import', args: { reason: '产品图', base64: PNG_BASE64, mime: 'image/png', name: 'product.png' } }] },
      view => ({ calls: [1, 2].map(segment => ({ name: 'dv_shot_render_ref2va', args: {
        reason: `第${String(segment)}段`, prompt: segment === 1 ? '第一段画面' : '第二段画面', duration_sec: segment,
        inputs: { reference: assetIdOf(view.toolResults[0], 'asset') },
      } })) }),
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
    // With DV_E2E_SHOTS set, a failed story leaves a screenshot of its page there.
    const dir = process.env['DV_E2E_SHOTS']
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
    await page.locator('[data-dv-entry], [data-dv-workspace]').first().waitFor({ timeout: 30_000 })
    if (hash !== '') {
      // A fresh document load (the query string differs from `/`) restores the location the hash names.
      await page.goto(`${harness.origin}/?story=1${hash}`, { waitUntil: 'load' })
      const project = new URLSearchParams(hash.replace(/^#/, '')).get('project')
      await waitFor(() => Promise.resolve(locationOf(page).project === project), 'the URL location to be restored', 15_000)
      await page.locator('[data-dv-workspace]').waitFor({ timeout: 30_000 })
    }
    return { page, errors }
  }

  /** The project and session of the URL hash. */
  function locationOf(page: Page): { project: string | null; session: string | null; view: string | null } {
    const params = new URLSearchParams(new URL(page.url()).hash.replace(/^#/, ''))
    return { project: params.get('project'), session: params.get('session'), view: params.get('view') }
  }

  /** The visible chat composer of the right panel. */
  const composer = (page: Page) => page.locator('[data-dv-chat]:visible [contenteditable="true"]:visible').first()
  /** The right-panel chat that is on screen; the panel keeps earlier sessions' chats mounted but hidden. */
  const chat = (page: Page) => page.locator('[data-dv-chat]:visible').first()
  /** The user message bubbles of the right-panel chat, in order. */
  const userMessages = async (page: Page): Promise<string[]> =>
    (await chat(page).locator('[data-chat-flow-kind="user"]').allInnerTexts()).map(text => (text.split('\n')[0] ?? '').replace(/\d{1,2}:\d{2}$/, '').trim())

  /** Click 新建项目 / Create project and wait until the workspace and its chat composer are up. */
  async function newProject(page: Page, lang: 'zh' | 'en' = 'zh'): Promise<string> {
    await page.getByRole('button', { name: lang === 'zh' ? '新建项目' : 'Create project' }).first().click()
    await page.locator('[data-dv-workspace]').waitFor({ timeout: 30_000 })
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

  /** The `dv:` mention expansion that `@dv/chat-references` added to a model request, or the empty string. */
  function referencesOf(request: ChatRequest): string {
    const block = request.messages.filter(message => message.role === 'user' && textOf(message.content).startsWith('The user referenced these project items'))
    return textOf(block.at(-1)?.content)
  }

  /** The newest model request whose typed user message contains `text`. */
  function requestFor(text: string): ChatRequest | undefined {
    return [...model.requests].reverse().find(request => userTextOf(request).includes(text))
  }

  /** Run an operation through the API. */
  async function runOperation(
    project: string,
    operation: string,
    params: Record<string, unknown>,
    inputs: Array<{ role: string; ref: string }> = [],
  ): Promise<ProjectRecord> {
    return await harness.api.post('/api/dv/operation', { project, operation, params, inputs, surface: 'canvas', intent: `story: ${operation}` }) as ProjectRecord
  }

  /** Create a project through the API with an imported image named `name`; returns the project and asset IDs. */
  async function seedProject(title: string, name: string, base64 = PNG_BASE64): Promise<{ projectId: string; assetId: string }> {
    const created = await harness.api.post('/api/dv/projects', { title, surface: 'canvas' }) as { id: string }
    const imported = await runOperation(created.id, 'asset.import', { base64, mime: 'image/png', name })
    return { projectId: created.id, assetId: imported.outputs[0] ?? '' }
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
    expect(prompt).toContain('never call dv_proj_create')
    expect(prompt).not.toContain('coding agent')
    expect(prompt).not.toContain('powered by DeepSeek Harness')
    // Creators get the video tools, not the developer tool set.
    const tools = (requestFor('只回复一')?.tools ?? []).map(tool => tool.function?.name ?? '')
    expect(tools.filter(name => ['bash', 'glob', 'grep', 'edit', 'write', 'web_fetch', 'web_search'].includes(name))).toEqual([])
    // The e2e profile mounts only the ref2va render mode, so its render tool is the only one the agent gets.
    expect(tools).toContain('dv_shot_render_ref2va')
    expect(tools).not.toContain('dv_shot_render_t2va')
    expect(errors).toEqual([])
  })

  it('a turn that only looks at an image writes no record and forks no branch', async () => {
    const { projectId, assetId } = await seedProject('只看图', 'look.png', RED_PNG)
    const before = await harness.api.get(`/api/dv/state?project=${projectId}`) as WireState
    const { page, errors } = await openPage('zh', `#project=${projectId}`)
    await send(page, `看看这张图 asset ${assetId}`)
    await waitChat(page, '看过了')
    // The Inspector's tool answered as a read: the model got its report and no record.
    const answered = requestFor('看看这张图')?.messages.filter(message => message.role === 'tool').map(message => textOf(message.content)) ?? []
    expect(answered.some(text => text.startsWith('done: dv_inspect_image answered'))).toBe(true)
    await page.waitForTimeout(2000)
    const after = await harness.api.get(`/api/dv/state?project=${projectId}`) as WireState
    expect(after.components.proj.records.map(record => record.id)).toEqual(before.components.proj.records.map(record => record.id))
    expect(after.branches.map(branch => branch.name)).toEqual(['main'])
    expect(errors).toEqual([])
  })

  it('the agent\'s changes of two turns land on the current branch at once, with no accept step', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await send(page, '加人物')
    await waitChat(page, '人物小橘已登记', 30_000)
    await send(page, '点名渲染一段')
    await waitChat(page, '渲染好了', 60_000)
    const state = await harness.api.get(`/api/dv/state?project=${projectId}`) as WireState
    expect(state.current).toBe('main')
    expect(state.branches.map(branch => branch.name)).toEqual(['main'])
    const agentRecords = state.components.proj.records.filter(record => record.actor === 'agent' && record.operation !== 'proj.create')
    expect(agentRecords.map(record => record.operation))
      .toEqual(['asset.import', 'bible.character_create', 'asset.import', 'shot.render_ref2va'])
    expect(agentRecords.every(record => record.branch === 'main')).toBe(true)
    expect(new Set(agentRecords.map(record => record.turn)).size).toBe(2)
    // Nothing waits for the user: the workspace offers no accept and names the current branch in its bottom bar.
    const workspace = page.locator('[data-dv-workspace]')
    expect(await workspace.getByRole('button', { name: '接受', exact: true }).count()).toBe(0)
    expect(await workspace.locator('[data-testid="dv-kit-branch-menu"]').first().getAttribute('data-branch')).toBe('main')
    expect(errors).toEqual([])
  })

  it('after 停止生成 the image the agent already imported stays on the current branch, and the composer sends after a reload', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await send(page, '慢慢做')
    const imported = async (): Promise<boolean> => ((await harness.api.get(`/api/dv/state?project=${projectId}`)) as WireState)
      .components.proj.records.some(record => record.operation === 'asset.import' && record.actor === 'agent')
    await waitFor(imported, 'the agent\'s import', 15_000)
    await chat(page).getByRole('button', { name: /停止|Stop/ }).first().click({ timeout: 10_000 })
    await page.reload({ waitUntil: 'load' })
    await composer(page).waitFor({ timeout: 30_000 })
    expect(await imported()).toBe(true)
    expect(await page.locator('[data-dv-workspace]').getByRole('button', { name: '丢弃', exact: true }).count()).toBe(0)
    await send(page, '只回复十')
    await waitChat(page, '收到十')
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
    const second = await harness.api.post('/api/dv/projects', { title: '切换目标项目', surface: 'canvas' }) as { id: string }
    await page.locator('[title="切换目标项目"]').first().click({ timeout: 15_000 })
    await waitFor(() => Promise.resolve(locationOf(page).project === second.id), 'the second project in the URL', 15_000)
    await composer(page).waitFor({ timeout: 15_000 })
    // The chat follows the project within a moment of the click.
    await waitFor(async () => (await userMessages(page)).length === 0, 'the second project\'s empty chat', 3000).catch(() => undefined)
    expect(await userMessages(page)).toEqual([])
    expect(await composer(page).innerText()).not.toContain('还没发出去的话')
    const firstTitle = await page.evaluate(async (id) => {
      const links = await (await fetch('/api/dv/workspaces')).json() as { projects: Array<{ id: string; title: string }> }
      return links.projects.find(project => project.id === id)?.title ?? ''
    }, first)
    await page.locator(`[title="${firstTitle}"]`).first().click()
    await waitFor(() => Promise.resolve(locationOf(page).project === first), 'the first project in the URL', 15_000)
    await waitChat(page, '收到七')
    expect(await userMessages(page)).toEqual(['只回复七'])
    expect(errors).toEqual([])
  })

  it('the agent\'s plan shows on the canvas at once, and the agent reads the current branch', async () => {
    const { page, errors } = await openPage()
    await newProject(page)
    await send(page, '做两个镜头的广告')
    await waitChat(page, '两个镜头已渲染', 60_000)
    const workspace = page.locator('[data-dv-workspace]')
    await workspace.locator('[data-node-kind="plan"]').first().waitFor({ timeout: 15_000 })
    expect(await workspace.getByRole('button', { name: '接受', exact: true }).count()).toBe(0)
    await send(page, '只回复八')
    await waitChat(page, '收到八')
    const prompt = promptOf(requestFor('只回复八') as ChatRequest)
    expect(prompt).toContain('Project summary of the current branch (main)')
    expect(prompt).toContain('"branches": [')
    expect(errors).toEqual([])
  })

  it('撤销 in the timeline view takes back a step, and the agent\'s next change continues on 分支 2', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await send(page, '做两个镜头的广告')
    await waitChat(page, '两个镜头已渲染', 60_000)
    const stateOf = async (branch?: string): Promise<WireState> =>
      await harness.api.get(`/api/dv/state?project=${projectId}${branch === undefined ? '' : `&branch=${branch}`}`) as WireState
    const tip = (await stateOf()).head
    await page.getByRole('tab', { name: '时间线' }).click()
    const editor = page.locator('[data-testid="dv-timeline-editor"]')
    await editor.waitFor({ timeout: 15_000 })
    await editor.getByRole('button', { name: '撤销', exact: true }).click()
    await waitFor(async () => (await stateOf()).redo_steps.length > 0, 'the undo', 10_000)
    // The agent writes after the undo, so its change forks 分支 2; 主线 keeps every step it had.
    await send(page, '加人物')
    await waitChat(page, '人物小橘已登记', 30_000)
    const forked = await stateOf()
    expect(forked.current).toBe('b2')
    expect(forked.components.proj.records.filter(record => record.operation === 'bible.character_create')).toHaveLength(1)
    const main = await stateOf('main')
    expect(main.head).toBe(tip)
    expect(main.components.proj.records.some(record => record.operation === 'bible.character_create')).toBe(false)
    const status = page.locator('[data-dv-workspace] [data-testid="dv-kit-branch-menu"]').first()
    await waitFor(async () => await status.getAttribute('data-branch') === 'b2', 'the bottom bar on 分支 2', 10_000)
    await send(page, '只回复九')
    await waitChat(page, '收到九')
    expect(promptOf(requestFor('只回复九') as ChatRequest)).toContain('Project summary of the current branch (b2)')
    expect(errors).toEqual([])
  })

  it('the plan approval waits for the user\'s agreement in the conversation; meanwhile the canvas plan editor shows it', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await send(page, '先给我看计划')
    await waitChat(page, '现在渲染这两个镜头吗')
    // Project refused the call without user_approved and told the agent to ask in the conversation.
    const answered = requestFor('先给我看计划')?.messages.filter(message => message.role === 'tool').map(message => textOf(message.content)) ?? []
    const refusal = answered.find(text => text.includes('dv_plan_approve needs the user\'s agreement'))
    expect(refusal).toContain('user_approved: true')
    // The agent's question is bold, and the refused step is named for creators, never by its wire tool name.
    expect(await chat(page).locator('strong', { hasText: '现在渲染这两个镜头吗？' }).count()).toBeGreaterThan(0)
    const approveRows = chat(page).locator('[data-tool="dv_plan_approve"]')
    await waitFor(async () => (await approveRows.allTextContents()).some(text => text.includes('批准分镜计划')), 'the 批准分镜计划 step', 10_000)
    expect(await chat(page).getByText('dv_plan_approve').count()).toBe(0)
    // Nothing renders before the user agrees: the plan waits for approval.
    const currentState = async (): Promise<WireState> => await harness.api.get(`/api/dv/state?project=${projectId}`) as WireState
    const waiting = await currentState()
    expect(waiting.components.plan.plans['p1']?.[0]?.approved_by).toBeNull()
    expect(waiting.components.proj.records.filter(record => record.operation === 'shot.render_ref2va')).toHaveLength(0)
    // The canvas plan editor lists each shot with its reference image, the image in place of the bare Picture 1, and its render mode.
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    await waitFor(async () => {
      // The canvas fits its view after the nodes load; a click during that move can miss, so click until it opens.
      await page.locator('[data-dv-workspace] [data-node-kind="plan"]').first().click({ timeout: 10_000 })
      return await editor.isVisible()
    }, 'the plan editor', 30_000)
    expect(await editor.getByText('待批准').count()).toBe(1)
    const shots = editor.locator('ol > li')
    expect(await shots.count()).toBe(2)
    for (const shot of await shots.all()) {
      expect(await shot.locator('img[alt=""]').count()).toBe(1)
      expect(await shot.locator('img[alt="Picture 1"]').count()).toBe(1)
      expect(await shot.innerText()).not.toContain('Picture 1')
      expect(await shot.locator('[data-testid="dv-canvas-shot-mode"]').textContent()).toBe('参考图生成')
    }
    await page.keyboard.press('Escape')
    // The user agrees in the conversation; the agent approves with user_approved and both shots render.
    await send(page, '可以渲染')
    await waitChat(page, '两个镜头已渲染', 60_000)
    const rendered = (await currentState()).components.proj.records.filter(record => record.operation === 'shot.render_ref2va')
    expect(rendered.map(record => [record.params['shot'], record.status])).toEqual([[1, 'done'], [2, 'done']])
    expect(errors).toEqual([])
  })

  it('an image attached in the chat becomes a project asset on the canvas', async () => {
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
      const value = await harness.api.get(`/api/dv/state?project=${projectId}&branch=main`) as { assets: Array<{ id: string; name: string; mime: string }> }
      return value.assets.some(asset => asset.mime.startsWith('image/')) ? value : null
    }, 'the attachment as a project asset', 15_000).catch(() => null)
    expect(state, 'the chat attachment is recorded as a project asset').not.toBeNull()
    // The browser placed the sent image on the canvas list under the asset ID the import gave it, so the canvas draws it.
    const imageId = state?.assets.find(asset => asset.mime.startsWith('image/'))?.id
    await expect.poll(async () => (await harness.api.get(`/api/dv/layout?project=${projectId}`) as { placed: string[] }).placed, { timeout: 10_000 })
      .toEqual([imageId])
    await page.locator('[data-dv-workspace] [data-node-kind="asset"]').first().waitFor({ timeout: 15_000 })
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
    // DSH's own @ sources (workspace files such as a project's records.jsonl, and every session on the server) stay out.
    expect.soft(await options.filter({ hasText: /records\.jsonl|session-/ }).count(), 'DSH file and session candidates in the @ list').toBe(0)
    await candidate.first().click()
    await page.keyboard.press('Enter')
    await waitChat(page, '收到十')
    // The sent bubble shows the chip label, not the wire form of the reference.
    expect(await chat(page).locator('[data-chat-flow-kind="user"]').last().innerText()).not.toContain('dv:')
    const expansion = referencesOf(requestFor('用这个') as ChatRequest)
    // The expansion names the asset and its import record in this project.
    expect(expansion).toContain(`asset ${target.assetId} made by record`)
    expect(errors).toEqual([])
  })

  it('the composer\'s ＋ menu offers 引用, which lists the open project\'s items, and a pick reaches the agent as a reference', async () => {
    const target = await seedProject('加号引用', 'plus-only.png', BLUE_PNG)
    const { page, errors } = await openPage('zh', `#project=${target.projectId}`)
    await composer(page).waitFor({ timeout: 30_000 })
    await composer(page).click()
    await page.keyboard.type('用这个只回复十一')
    await chat(page).getByRole('button', { name: '添加文件或调用指令' }).click()
    await page.locator('[role="listbox"] [role="option"]').filter({ hasText: '引用' }).first().click()
    const candidate = page.locator('[role="listbox"] [role="option"]').filter({ hasText: 'plus-only.png' })
    await candidate.first().waitFor({ timeout: 15_000 })
    await candidate.first().click()
    expect(await composer(page).locator('[data-composer-chip="dv-project"]').count(), 'a reference chip in the composer').toBe(1)
    await page.keyboard.press('Enter')
    await waitChat(page, '收到十一')
    expect(referencesOf(requestFor('用这个只回复十一') as ChatRequest)).toContain(`asset ${target.assetId} made by record`)
    expect(errors).toEqual([])
  })

  it('让智能体改 on a canvas take prefills the open project\'s chat composer with a reference the agent can resolve', async () => {
    const { projectId, assetId } = await seedProject('改片段', 'ref.png')
    const plan = await runOperation(projectId, 'plan.create', {
      title: '改片段', references: [assetId], shots: [{ prompt: '镜头甲', duration_sec: 1, mode: 'ref2va' }],
    })
    await runOperation(projectId, 'plan.approve', { plan: plan.report?.['plan'] })
    const done = await waitFor(async () => {
      const state = await harness.api.get(`/api/dv/state?project=${projectId}&branch=main`) as WireState
      return state.components.proj.records.find(record => record.operation === 'shot.render_ref2va' && record.status === 'done')
    }, 'the take to render', 60_000)
    // Visit another project first, so a stale composer from it would be a wrong target.
    const { page, errors } = await openPage()
    await newProject(page)
    await page.locator('[title="改片段"]').first().click({ timeout: 15_000 })
    await waitFor(() => Promise.resolve(locationOf(page).project === projectId), 'the seeded project in the URL', 15_000)
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    await waitFor(async () => {
      // The canvas fits its view after the nodes load; a click during that move can miss, so click until it opens.
      await page.locator('[data-dv-workspace] [data-node-kind="take"]').first().click({ timeout: 10_000 })
      return await editor.isVisible()
    }, 'the take editor', 30_000)
    await editor.getByRole('button', { name: '让智能体改', exact: true }).click()
    await waitFor(async () => (await composer(page).innerText()).includes('修改'), 'the prefilled composer', 10_000)
    expect(locationOf(page).project).toBe(projectId)
    await page.keyboard.type('只回复十一')
    await page.keyboard.press('Enter')
    await waitChat(page, '收到十一')
    expect(await chat(page).locator('[data-chat-flow-kind="user"]').last().innerText()).not.toContain('dv:')
    // The expansion resolves the take to its record in this project.
    const expansion = referencesOf(requestFor('只回复十一') as ChatRequest)
    expect(expansion).toContain(`made by record ${done.id}`)
    expect(errors).toEqual([])
  })

  it('a second chat session in the same project sees the first session\'s character at once', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await send(page, '加人物')
    await waitChat(page, '人物小橘已登记')
    const first = locationOf(page).session
    await page.locator('[data-dv-workspace] [data-node-kind="bible"]').first().waitFor({ timeout: 15_000 })
    // The character is on the project's current branch, which every chat session of the project reads.
    // The project row's ＋ starts a second chat session in the same project.
    await page.locator('[data-dv-navigator] [data-active]').filter({ hasText: '＋' }).first().locator('button', { hasText: '＋' }).click()
    await waitFor(() => Promise.resolve(locationOf(page).session !== first && locationOf(page).session !== null), 'a second session', 15_000)
    expect(locationOf(page).project).toBe(projectId)
    expect(await userMessages(page)).toEqual([])
    expect(await page.locator('[data-dv-workspace] [data-node-kind="bible"]').count()).toBeGreaterThan(0)
    await send(page, '只回复十三')
    await waitChat(page, '收到十三')
    expect(promptOf(requestFor('只回复十三') as ChatRequest)).toContain('小橘')
    expect(errors).toEqual([])
  })

  it('chatting while the timeline view is open keeps the timeline view and the project', async () => {
    const { page, errors } = await openPage()
    const projectId = await newProject(page)
    await page.getByRole('tab', { name: '时间线' }).click()
    await send(page, '只回复十四')
    await waitChat(page, '收到十四')
    expect(locationOf(page)).toMatchObject({ project: projectId, view: 'timeline' })
    expect(await page.getByRole('tab', { name: '时间线' }).getAttribute('data-active')).toBe('')
    expect(errors).toEqual([])
  })

  it('a request typed on the entry page creates a project and moves the chat, with its history, to the right panel', async () => {
    const { page, errors } = await openPage()
    await page.locator('[data-dv-entry] [contenteditable="true"]').first().click({ timeout: 30_000 })
    await page.keyboard.type('新建项目做个短片')
    await page.keyboard.press('Enter')
    await waitFor(() => Promise.resolve(locationOf(page).project), 'a project in the URL', 30_000)
    await page.locator('[data-dv-workspace]').waitFor({ timeout: 15_000 })
    await waitChat(page, '收到十六')
    expect(await userMessages(page)).toEqual(['新建项目做个短片'])
    expect(await page.locator('[data-dv-workspace]').innerText()).toContain('入口创建的项目')
    expect(await page.locator('[data-dv-entry]').count()).toBe(0)
    expect(errors).toEqual([])
  })

  it('after an entry-page request, a question card, an image-only message, and a look at 轨迹, the 对话 composer still sends', async () => {
    const { page, errors } = await openPage()
    await page.locator('[data-dv-entry] [contenteditable="true"]').first().click({ timeout: 30_000 })
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
    await page.locator('[data-dv-trajectory]').first().waitFor({ timeout: 10_000 })
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

  it('in English, the composer placeholder, the tool rows, and the render cards of the chat are English', async () => {
    const { page, errors } = await openPage('en')
    expect(await page.evaluate(() => document.documentElement.lang)).toMatch(/^en/)
    await newProject(page, 'en')
    await send(page, '两段渲染')
    await waitChat(page, '处理完毕', 60_000)
    // Apart from the typed message and the scripted prompts and reply, nothing in the chat panel is Chinese.
    const panel = ['两段渲染', '第一段画面', '第二段画面', '处理完毕。'].reduce((text, typed) => text.replaceAll(typed, ''), await chat(page).innerText())
    expect(panel.match(/[一-鿿]+/g) ?? []).toEqual([])
    expect.soft(await composer(page).getAttribute('data-placeholder') ?? '').not.toContain('files or sessions')
    // A finished turn folds its tool rows, so the labels are read from the page text rather than from what is on screen.
    expect(await chat(page).locator('[data-tool="dv_asset_import"]').first().textContent()).toContain('Import asset')
    const cards = chat(page).locator('[data-tool="dv_shot_render_ref2va"]')
    expect(await cards.count()).toBe(2)
    for (const card of await cards.all()) {
      expect(await card.locator('strong').textContent()).toBe('Render shot from references')
      expect(await card.textContent()).toContain('Rendered')
    }
    expect(errors).toEqual([])
  })
})
