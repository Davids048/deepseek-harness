// User stories of the History panel (历史), walked in Chromium against the shipped profile with a fake video backend that
// renders playable VP9 videos and a scripted agent model. Projects are seeded through the `/api/dv` routes; agent turns
// go through the chat. Every story checks the action rows the creator sees: their order, labels, who, thumbnails, the
// 当前 mark of the current step, the renders folded under a plan approval, the focus a selected row gives the canvas or
// the timeline, and live updates. The history works like an image editor's History panel: undo (Ctrl+Z, the undo
// button), redo (Shift+Ctrl+Z, the redo button) and 回到这一步 in a row's ⋮ menu only move 当前 and add no row; the rows
// after 当前 are greyed; a new edit after a move discards them.
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectRecord, WireState } from '@dv/ui-kit/types.ts'
import { bootHarness, playwright, waitFor, type BootedHarness } from '../harness.ts'
import { startScriptedModel, type ScriptedModel } from '../scripted-model.ts'

/** A 1×1 opaque PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** A seeded project: its ID and the records of its import, its two renders, and its timeline `t1`. */
interface Seeded {
  id: string
  imported: ProjectRecord
  renders: ProjectRecord[]
  timeline: ProjectRecord
}

let harness: BootedHarness
let model: ScriptedModel
let browser: Browser
const contexts: BrowserContext[] = []
let projectCount = 0

/**
 * Run one operation as a user action on the canvas through `/api/dv/operation`.
 * @param project - the project.
 * @param operation - the operation name.
 * @param params - the operation params.
 * @param inputs - the input references.
 * @param session - the chat session the record names; the record goes at the end of the project's history either way.
 * @returns the record.
 */
async function runOperation(
  project: string,
  operation: string,
  params: Record<string, unknown>,
  inputs: Array<{ role: string; ref: string }> = [],
  session?: string,
): Promise<ProjectRecord> {
  const origin = session === undefined ? {} : { session }
  const body = { project, operation, params, inputs, surface: 'canvas', intent: `seed: ${operation}`, ...origin }
  return await harness.api.post('/api/dv/operation', body) as ProjectRecord
}

/** @returns the project's current state. */
async function stateOf(project: string): Promise<WireState> {
  return await harness.api.get(`/api/dv/state?project=${project}`) as WireState
}

/** @returns a project created through the API with a unique title. */
async function createProject(prefix: string): Promise<string> {
  projectCount += 1
  const title = `${prefix}-${String(projectCount)}`
  const created = await harness.api.post('/api/dv/projects', { title, surface: 'canvas' }) as { id: string }
  return created.id
}

/**
 * Seed a project on `main`: an imported reference image, two takes rendered from it, and timeline `t1` holding both.
 * @param prefix - the project title prefix.
 * @returns the project and its records.
 */
async function seedProject(prefix: string): Promise<Seeded> {
  const id = await createProject(prefix)
  const imported = await runOperation(id, 'asset.import', { base64: PNG_BASE64, mime: 'image/png', name: 'ref.png' })
  const renders: ProjectRecord[] = []
  for (const prompt of [`${prefix} shot 1`, `${prefix} shot 2`]) {
    const reference = [{ role: 'reference', ref: imported.outputs[0] ?? '' }]
    const render = await runOperation(id, 'shot.render_ref2va', { prompt, duration_sec: 1 }, reference)
    expect(render.status).toBe('done')
    renders.push(render)
  }
  const timeline = await runOperation(id, 'timeline.create', { timeline: 't1', assets: renders.map(render => render.outputs[0] ?? '') })
  return { id, imported, renders, timeline }
}

/**
 * Open a fresh browser page with the session cookie, recording console errors and uncaught exceptions.
 * @returns the page; `errors` collects the messages.
 */
async function openPage(): Promise<Page & { errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN', colorScheme: 'light' })
  contexts.push(context)
  context.setDefaultTimeout(10_000)
  const page = await context.newPage() as Page & { errors: string[] }
  page.errors = []
  page.on('pageerror', (error) => { page.errors.push(`pageerror: ${error.message}`) })
  await page.goto(harness.tokenUrl, { waitUntil: 'load' })
  // A fresh browser profile first shows DSH's one-time beta notice (内测声明) over the whole page.
  const notice = page.getByRole('button', { name: /^(继续|Continue)$/ })
  await notice.waitFor({ timeout: 2500 }).then(() => notice.click(), () => undefined)
  return page
}

/**
 * Load a project's canvas the way a shared link does, and wait until the center shows that project; a fresh browser
 * that lands on another project opens it from the navigator instead.
 * @param page - the page.
 * @param project - the project.
 */
async function gotoProject(page: Page, project: string): Promise<void> {
  const links = await harness.api.get('/api/dv/workspaces') as { projects: Array<{ id: string; title: string }> }
  const title = links.projects.find(entry => entry.id === project)?.title ?? project
  await page.goto(`${harness.origin}/#project=${project}`)
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
  }
  await page.locator('[data-testid="dv-canvas-view"]').waitFor({ timeout: 30_000 })
}

/** The 画布 | 时间线 toggle button in the workspace top bar. */
function viewToggle(page: Page, name: string): Locator {
  return page.locator('[data-dv-workspace] header [role="tab"]', { hasText: name })
}

/** The History panel; a project switch can leave the replaced seat's panel for a moment, so only the visible one counts. */
function historyPanel(page: Page): Locator {
  return page.locator('[data-testid="dv-history-panel"]:visible')
}

/** The rows of the visible History panel. */
function rows(page: Page): Locator {
  return historyPanel(page).locator('[data-testid="dv-history-row"]')
}

/** The row of one record. */
function rowOf(page: Page, record: string): Locator {
  return historyPanel(page).locator(`[data-testid="dv-history-row"][data-record="${record}"]`)
}

/** @returns the record IDs of the shown rows, top to bottom. */
async function shownRecords(page: Page): Promise<string[]> {
  return await rows(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-record') ?? ''))
}

/**
 * Open the 历史 tab of the right panel and wait for the panel.
 * @param page - a page showing a project.
 */
async function openHistory(page: Page): Promise<void> {
  const tab = page.locator('[role="tab"]', { hasText: /^历史$/ }).filter({ visible: true }).first()
  // The panels open by themselves once the project's chat session is in place; the top bar's right-panel open button
  // reopens a collapsed panel.
  const shown = await tab.waitFor({ timeout: 5000 }).then(() => true, () => false)
  if (!shown) await page.getByRole('button', { name: '打开右侧面板', exact: true }).click()
  // A project switch remounts the right panel's session seat, so the tab found first can be replaced mid-click.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await tab.click({ timeout: 3000 }).then(() => true, () => false)) break
  }
  await expect.poll(() => historyPanel(page).count(), { timeout: 15_000 }).toBe(1)
}

/**
 * Ask the scripted agent to rename timeline t1 in the chat, which writes one agent record whose intent is
 * `改名：<word>` at the end of the project's history, then return to 历史.
 * @param page - a page showing the project.
 * @param project - the project.
 * @param word - the chat message, unique to the story.
 * @returns the agent's record.
 */
async function agentRename(page: Page, project: string, word: string): Promise<ProjectRecord> {
  model.rules.push({
    match: word, endText: '改好了',
    steps: [{ calls: [{
      name: 'dv_timeline_rename', args: { reason: `改名：${word}`, project_id: project, timeline: 't1', name: `${word} 改名` },
    }] }],
  })
  // The composer lives in the 对话 tab; the story returns to 历史 once the record is written.
  await page.locator('[role="tab"]', { hasText: /^对话$/ }).filter({ visible: true }).first().click()
  const composer = page.locator('[data-dv-chat] [contenteditable="true"]:visible').first()
  await composer.waitFor({ timeout: 30_000 })
  await composer.click()
  await page.keyboard.type(word)
  await page.keyboard.press('Enter')
  const record = await waitFor(async () => (await stateOf(project)).components.proj.records
    .find(entry => entry.actor === 'agent' && entry.intent === `改名：${word}`), 'the agent record', 60_000)
  await openHistory(page)
  return record
}

/**
 * Choose 回到这一步 in a row's ⋮ menu.
 * @param row - a history row.
 */
async function stepBack(row: Locator): Promise<void> {
  await row.locator('[data-testid="dv-history-step-actions"]').click()
  await row.locator('[data-testid="dv-history-step-back"]').click()
}

/** @returns the names of the timeline tabs the timeline editor shows. */
async function timelineTabs(page: Page): Promise<string[]> {
  return await page.locator('[data-testid="dv-timeline-editor"] [role="tab"]').evaluateAll(tabs => tabs.map(tab => tab.textContent ?? ''))
}

/**
 * @param page - a page showing the History panel.
 * @param record - a record.
 * @returns the place the record's row shows: `before`, `current` or `after` the current step.
 */
async function placeOf(page: Page, record: string): Promise<string | null> {
  return await rowOf(page, record).getAttribute('data-place')
}

/**
 * Rename timeline t1 three times, as three user steps.
 * @param project - the project.
 * @returns the three rename records, oldest first.
 */
async function threeRenames(project: string): Promise<ProjectRecord[]> {
  const renames: ProjectRecord[] = []
  for (const name of ['first', 'second', 'third']) renames.push(await runOperation(project, 'timeline.rename', { timeline: 't1', name }))
  return renames
}

/** @returns the record ID of the row that carries 当前: the project's current step. */
async function currentRow(page: Page): Promise<string | null> {
  const marked = historyPanel(page).locator('[data-testid="dv-history-row"]:has([data-testid="dv-history-current"])')
  return await marked.count() === 1 ? await marked.getAttribute('data-record') : null
}

/** @returns the name of timeline `t1` in the project's current state, or undefined when the state has no timeline. */
async function timelineName(project: string): Promise<string | undefined> {
  return (await stateOf(project)).components.timeline.timelines[0]?.name
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

describe('History panel', () => {
  it('a seeded project shows one row per action, newest first, with label, who, status and one loaded thumbnail', async () => {
    const project = await seedProject('history-rows')
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    const records = (await stateOf(project.id)).components.proj.records
    await expect.poll(() => shownRecords(page)).toEqual(records.map(record => record.id).reverse())
    const render = rowOf(page, project.renders[1]?.id ?? '')
    expect(await render.getAttribute('data-actor')).toBe('user')
    expect(await render.getAttribute('data-status')).toBe('done')
    const text = await render.innerText()
    for (const word of ['你', '参考图生成镜头']) expect(text).toContain(word)
    // One thumbnail per row: the take's still, which the browser loads.
    const thumb = render.locator('[data-testid="dv-history-thumb"]')
    expect(await thumb.count()).toBe(1)
    await expect.poll(() => thumb.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0))
      .toBe(true)
    expect(await historyPanel(page).locator('[data-testid="dv-history-turn"]').count()).toBe(0)
    expect(await rowOf(page, project.timeline.id).innerText()).toContain('新建时间线')
    expect(page.errors).toEqual([])
  })

  it('an agent row shows the intent the agent gave for its call; the agent\'s and the human\'s edits go at the end of one history at once', async () => {
    const project = await seedProject('history-turn')
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    const agent = await agentRename(page, project.id, 'history-turn-request')
    const agentRow = rowOf(page, agent.id)
    // The quoted words are the agent record's own intent, which the scripted call sets apart from the typed message.
    await expect.poll(() => agentRow.innerText(), { timeout: 30_000 }).toContain('改名：history-turn-request')
    expect(await agentRow.innerText()).toContain('智能体')
    expect(await agentRow.getAttribute('data-surface')).toBe('chat')
    await expect.poll(() => currentRow(page)).toBe(agent.id)
    const edit = await runOperation(project.id, 'timeline.rename', { timeline: 't1', name: '人工改名' }, [], agent.session ?? undefined)
    // The human's edit follows the agent's on the same line and becomes the newest row.
    await expect.poll(() => currentRow(page)).toBe(edit.id)
    expect((await shownRecords(page)).slice(0, 2)).toEqual([edit.id, agent.id])
    expect(edit.parents).toEqual([agent.id])
    expect(await timelineName(project.id)).toBe('人工改名')
    expect(page.errors).toEqual([])
  })

  it('undo and redo move 当前 without adding a row and grey the steps after it; a new edit discards the greyed steps', async () => {
    const project = await seedProject('history-undo')
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    const records = (await stateOf(project.id)).components.proj.records
    await expect.poll(() => rows(page).count()).toBe(records.length)
    const before = await shownRecords(page)
    const previous = before[1] ?? ''
    expect(await currentRow(page)).toBe(project.timeline.id)
    // Undo moves 当前 one step back and writes no record; the step it took back is greyed.
    const line = await harness.api.post('/api/dv/undo', { project: project.id }) as { tip: string; at: string }
    expect(line).toEqual({ tip: project.timeline.id, at: previous })
    await expect.poll(() => currentRow(page), { timeout: 15_000 }).toBe(previous)
    expect(await shownRecords(page)).toEqual(before)
    expect(await placeOf(page, project.timeline.id)).toBe('after')
    expect((await stateOf(project.id)).components.timeline.timelines).toEqual([])
    // Redo moves it forward again.
    const redo = historyPanel(page).locator('[data-testid="dv-history-redo"]')
    await expect.poll(() => redo.isEnabled()).toBe(true)
    await redo.click()
    await expect.poll(() => currentRow(page), { timeout: 15_000 }).toBe(project.timeline.id)
    expect((await stateOf(project.id)).components.timeline.timelines[0]?.clips).toHaveLength(2)
    // Undo again, then edit: the edit follows 当前 and discards the greyed step for good.
    await historyPanel(page).locator('[data-testid="dv-history-undo"]').click()
    await expect.poll(() => currentRow(page), { timeout: 15_000 }).toBe(previous)
    const again = await runOperation(project.id, 'timeline.create', { timeline: 't1', assets: [project.renders[0]?.outputs[0] ?? ''] })
    expect(again.parents).toEqual([previous])
    await expect.poll(() => currentRow(page), { timeout: 15_000 }).toBe(again.id)
    expect(await shownRecords(page)).toEqual([again.id, ...before.slice(1)])
    expect(await rowOf(page, project.timeline.id).count()).toBe(0)
    await expect.poll(() => redo.isEnabled()).toBe(false)
    expect((await stateOf(project.id)).components.timeline.timelines[0]?.clips).toHaveLength(1)
    // The current row offers no 回到这一步; the project already shows it.
    expect(await rowOf(page, again.id).locator('[data-testid="dv-history-step-actions"]').count()).toBe(0)
    expect(page.errors).toEqual([])
  })

  it('a plan approval folds the renders it scheduled under its row; the toggle shows them', async () => {
    const id = await createProject('history-fold')
    const imported = await runOperation(id, 'asset.import', { base64: PNG_BASE64, mime: 'image/png', name: 'ref.png' })
    const shots = [1, 2].map(shot => ({ prompt: `history-fold shot ${String(shot)}`, duration_sec: 1, mode: 'ref2va' }))
    const plan = await runOperation(id, 'plan.create', { title: '折叠', references: [imported.outputs[0] ?? ''], shots })
    expect(plan.report?.['plan']).toBe('p1')
    const approval = await runOperation(id, 'plan.approve', { plan: 'p1' })
    const scheduled = approval.report?.['scheduled'] as string[]
    expect(scheduled).toHaveLength(3)
    const page = await openPage()
    await gotoProject(page, id)
    await openHistory(page)
    const approvalRow = rowOf(page, approval.id)
    await expect.poll(() => approvalRow.innerText()).toContain('批准分镜计划 p1 v1')
    expect(await rowOf(page, plan.id).innerText()).toContain('新建分镜计划《折叠》')
    // Folded: the scheduled renders and the timeline are not rows until the toggle opens them.
    for (const record of scheduled) expect(await rowOf(page, record).count()).toBe(0)
    const fold = historyPanel(page).locator('[data-testid="dv-history-fold"]')
    await expect.poll(() => fold.innerText(), { timeout: 30_000 }).toMatch(/^▸ 渲染 2 个镜头$/)
    await fold.click()
    await expect.poll(() => fold.getAttribute('aria-expanded')).toBe('true')
    // The folded rows follow the approval's scheduled order: 参考图生成镜头 1, 参考图生成镜头 2, then 新建时间线.
    expect(await shownRecords(page)).toEqual([approval.id, ...scheduled, plan.id, imported.id, expect.any(String)])
    expect(await rowOf(page, scheduled[2] ?? '').innerText()).toContain('新建时间线')
    const firstShot = rowOf(page, scheduled[0] ?? '')
    expect(await firstShot.innerText()).toContain('参考图生成镜头 1')
    expect(await firstShot.getAttribute('data-actor')).toBe('system')
    expect(await firstShot.innerText()).toContain('自动')
    // The approval's thumbnail is its first render's still.
    const thumb = approvalRow.locator('[data-testid="dv-history-thumb"]')
    await expect.poll(() => thumb.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth > 0)).toBe(true)
    expect(page.errors).toEqual([])
  })

  it('selecting a render row opens its take on the canvas and plays the take in the preview', async () => {
    const project = await seedProject('history-focus-take')
    const page = await openPage()
    await gotoProject(page, project.id)
    await viewToggle(page, '时间线').click()
    await page.locator('[data-testid="dv-timeline-editor"]').waitFor()
    await openHistory(page)
    const render = rowOf(page, project.renders[0]?.id ?? '')
    await render.click()
    await expect.poll(() => render.getAttribute('aria-selected')).toBe('true')
    await page.locator('[data-testid="dv-canvas-view"]').waitFor({ timeout: 15_000 })
    const editor = page.locator('[data-testid="dv-canvas-node-editor"]')
    await editor.waitFor({ timeout: 15_000 })
    const preview = historyPanel(page).locator('[data-testid="dv-history-preview"] video')
    await expect.poll(() => preview.count()).toBe(1)
    expect(await preview.getAttribute('src')).toContain(project.renders[0]?.outputs[0] ?? 'none')
    expect(page.errors).toEqual([])
  })

  it('selecting a clip move row switches to the timeline view and selects the clip', async () => {
    const project = await seedProject('history-focus-clip')
    const clip = (await stateOf(project.id)).components.timeline.timelines[0]?.clips[1]?.id ?? ''
    const move = await runOperation(project.id, 'timeline.clip_move', { clip, to: 1 })
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    await rowOf(page, move.id).click()
    await page.locator('[data-testid="dv-timeline-editor"]').waitFor({ timeout: 15_000 })
    await expect.poll(() => page.locator(`[data-clip="${clip}"][aria-pressed="true"]`).count(), { timeout: 15_000 }).toBe(1)
    expect(page.errors).toEqual([])
  })

  it('an empty project says so, and a record written while the panel is open appears and finishes without a reload', async () => {
    const id = await createProject('history-live')
    const page = await openPage()
    await gotoProject(page, id)
    await openHistory(page)
    await expect.poll(() => historyPanel(page).locator('[data-testid="dv-history-empty"]').innerText()).toContain('还没有记录')
    const imported = await runOperation(id, 'asset.import', { base64: PNG_BASE64, mime: 'image/png', name: 'live.png' })
    await expect.poll(() => rowOf(page, imported.id).getAttribute('data-status'), { timeout: 15_000 }).toBe('done')
    expect(await historyPanel(page).locator('[data-testid="dv-history-empty"]').count()).toBe(0)
    const reference = [{ role: 'reference', ref: imported.outputs[0] ?? '' }]
    const render = await runOperation(id, 'shot.render_ref2va', { prompt: 'history-live shot', duration_sec: 1 }, reference)
    await expect.poll(() => rowOf(page, render.id).getAttribute('data-status'), { timeout: 30_000 }).toBe('done')
    await expect.poll(() => rowOf(page, render.id).locator('[data-testid="dv-history-thumb"]').count()).toBe(1)
    expect(page.errors).toEqual([])
  })

  it('在轨迹中查看 on an agent row opens 轨迹 and shows that tool call', async () => {
    const project = await seedProject('history-trajectory')
    const page = await openPage()
    await gotoProject(page, project.id)
    await agentRename(page, project.id, 'history-trajectory-request')
    const agentRow = historyPanel(page).locator('[data-testid="dv-history-row"][data-actor="agent"]')
    await expect.poll(() => agentRow.count(), { timeout: 30_000 }).toBe(1)
    // The link sits in the details of the selected row.
    await agentRow.click()
    await agentRow.locator('[data-testid="dv-history-open-trajectory"]').click()
    // 轨迹 comes to the front and selects the row of the tool call that wrote the record.
    const selected = page.locator('[data-dv-trajectory]:visible tr[data-selected]')
    await expect.poll(() => selected.count(), { timeout: 15_000 }).toBe(1)
    expect(await selected.getAttribute('data-kind')).toBe('tool')
    expect(await selected.innerText()).toMatch(/dv_timeline_rename|重命名时间线/)
    expect(page.errors).toEqual([])
  })

  it('回到这一步 moves 当前 to the first of three edits and then forward to the third, without adding a row', async () => {
    const project = await seedProject('history-jump')
    const [first, second, third] = await threeRenames(project.id)
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    await expect.poll(() => currentRow(page)).toBe(third?.id)
    expect(await rowOf(page, third?.id ?? '').locator('[data-testid="dv-history-current"]').innerText()).toBe('当前')
    // The header holds the undo and the redo button.
    expect(await historyPanel(page).locator('[data-testid="dv-history-undo"]').count()).toBe(1)
    expect(await historyPanel(page).locator('[data-testid="dv-history-redo"]').count()).toBe(1)
    const listed = await shownRecords(page)
    await stepBack(rowOf(page, first?.id ?? ''))
    await expect.poll(() => timelineName(project.id), { timeout: 15_000 }).toBe('first')
    await expect.poll(() => currentRow(page), { timeout: 15_000 }).toBe(first?.id)
    expect(await shownRecords(page)).toEqual(listed)
    for (const later of [second, third]) expect(await placeOf(page, later?.id ?? '')).toBe('after')
    await viewToggle(page, '时间线').click()
    await page.locator('[data-testid="dv-timeline-editor"]').waitFor({ timeout: 15_000 })
    await expect.poll(() => timelineTabs(page)).toEqual(['first'])
    // 回到这一步 on a greyed step moves 当前 forward to it.
    await stepBack(rowOf(page, third?.id ?? ''))
    await expect.poll(() => timelineName(project.id), { timeout: 15_000 }).toBe('third')
    await expect.poll(() => currentRow(page), { timeout: 15_000 }).toBe(third?.id)
    expect(await shownRecords(page)).toEqual(listed)
    expect(page.errors).toEqual([])
  })

  it('Ctrl+Z undoes and Shift+Ctrl+Z redoes the last step of the whole project outside text fields', async () => {
    const project = await seedProject('history-keys')
    const [, , third] = await threeRenames(project.id)
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    await expect.poll(() => currentRow(page)).toBe(third?.id)
    const listed = (await shownRecords(page)).length
    // The keys reach the page only while no text field has the focus.
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
    await page.keyboard.press('Control+Z')
    await expect.poll(() => timelineName(project.id)).toBe('second')
    await page.keyboard.press('Control+Z')
    await expect.poll(() => timelineName(project.id)).toBe('first')
    await page.keyboard.press('Control+Shift+Z')
    await expect.poll(() => timelineName(project.id)).toBe('second')
    // The moves add no row.
    await expect.poll(() => currentRow(page), { timeout: 15_000 }).not.toBe(third?.id)
    expect((await shownRecords(page)).length).toBe(listed)
    // In the chat composer Ctrl+Z edits the text and leaves the project alone.
    await page.locator('[role="tab"]', { hasText: /^对话$/ }).filter({ visible: true }).first().click()
    const composer = page.locator('[data-dv-chat] [contenteditable="true"]:visible').first()
    await composer.click()
    await page.keyboard.type('history-keys')
    await page.keyboard.press('Control+Z')
    await page.waitForTimeout(500)
    expect(await timelineName(project.id)).toBe('second')
    expect(page.errors).toEqual([])
  })

  it('a new edit after going back discards the later steps: they leave History and redo is off', async () => {
    const project = await seedProject('history-drop')
    const [first, second, third] = await threeRenames(project.id)
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    await expect.poll(() => currentRow(page)).toBe(third?.id)
    await stepBack(rowOf(page, first?.id ?? ''))
    await expect.poll(() => timelineName(project.id), { timeout: 15_000 }).toBe('first')
    const fourth = await runOperation(project.id, 'timeline.rename', { timeline: 't1', name: 'fourth' })
    expect(fourth.parents).toEqual([first?.id])
    await expect.poll(() => currentRow(page), { timeout: 15_000 }).toBe(fourth.id)
    expect(await timelineName(project.id)).toBe('fourth')
    // The second and third renames are discarded: no rows, no redo, and the API refuses a move to them.
    for (const dropped of [second, third]) expect(await rowOf(page, dropped?.id ?? '').count()).toBe(0)
    await expect.poll(() => historyPanel(page).locator('[data-testid="dv-history-redo"]').isEnabled()).toBe(false)
    await expect(harness.api.post('/api/dv/undo', { project: project.id, to: third?.id })).rejects.toThrow(/invalid_params|400/)
    expect(page.errors).toEqual([])
  })

  it('在历史中查看 on a tool row in the chat opens 历史 with the record selected', async () => {
    const project = await seedProject('history-chat-link')
    const page = await openPage()
    await gotoProject(page, project.id)
    await agentRename(page, project.id, 'history-chat-link-request')
    const records = (await stateOf(project.id)).components.proj.records
    const agentRecord = records.find(record => record.actor === 'agent' && record.operation === 'timeline.rename')
    expect(agentRecord?.tool_call).toBeTruthy()
    // The chat folds a finished turn's tool rows; the link stays in the page, so the event reaches it while folded.
    const link = page.locator('[data-dv-chat] [data-tool="dv_timeline_rename"] [data-testid="dv-composer-open-history"]').first()
    await link.waitFor({ state: 'attached', timeout: 30_000 })
    await link.dispatchEvent('click')
    await expect.poll(() => historyPanel(page).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => rowOf(page, agentRecord?.id ?? '').getAttribute('aria-selected'), { timeout: 15_000 }).toBe('true')
    expect(page.errors).toEqual([])
  })
})
