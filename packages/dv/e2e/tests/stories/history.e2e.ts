// User stories of the History panel (历史), walked in Chromium against the shipped profile with a fake video backend that
// renders playable VP9 videos and a scripted agent model. Projects are seeded through the `/api/dv` routes; agent turns
// go through the chat. Every story checks the action rows the creator sees: their order, labels, who, thumbnails, marks,
// the renders folded under a plan approval, filters, the focus a selected row gives the canvas or the timeline, and live
// updates.
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Branch, DraftCounts, ProjectRecord, WireState } from '@dv/ui-kit/types.ts'
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
 * @param session - the chat session whose working branch receives the record; none writes to `main`.
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

/** @returns the folded state of a project branch, `main` by default. */
async function stateOf(project: string, branch = 'main'): Promise<WireState> {
  return await harness.api.get(`/api/dv/state?project=${project}&branch=${encodeURIComponent(branch)}`) as WireState
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
    const render = await runOperation(id, 'shot.render', { prompt, duration_sec: 1 }, reference)
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

/** @returns one attribute of every shown row, top to bottom. */
async function rowAttributes(page: Page, name: string): Promise<string[]> {
  return await rows(page).evaluateAll((elements, attribute) => elements.map(element => element.getAttribute(attribute) ?? ''), name)
}

/**
 * Open the 历史 tab of the right panel and wait for the panel.
 * @param page - a page showing a project.
 */
async function openHistory(page: Page): Promise<void> {
  const tab = page.locator('[role="tab"]', { hasText: /^历史$/ }).filter({ visible: true }).first()
  // The panels open by themselves once the project's chat session is in place; 面板 reopens a collapsed panel.
  const shown = await tab.waitFor({ timeout: 5000 }).then(() => true, () => false)
  if (!shown) await page.getByRole('button', { name: '面板', exact: true }).click()
  // A project switch remounts the right panel's session seat, so the tab found first can be replaced mid-click.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await tab.click({ timeout: 3000 }).then(() => true, () => false)) break
  }
  await expect.poll(() => historyPanel(page).count(), { timeout: 15_000 }).toBe(1)
}

/** @returns the branches of a project. */
async function branchesOf(project: string): Promise<Branch[]> {
  return (await stateOf(project)).branches
}

/**
 * Ask the scripted agent to rename timeline t1 in the chat, which opens the chat session's draft with one agent record.
 * @param page - a page showing the project.
 * @param project - the project.
 * @param word - the chat message, unique to the story; the turn's request text.
 * @returns the open draft.
 */
async function openAgentDraft(page: Page, project: string, word: string): Promise<Branch & { session: string }> {
  model.rules.push({
    match: word, endText: '改好了',
    steps: [{ calls: [{
      name: 'dv_timeline_rename', args: { reason: 'rename', project_id: project, timeline: 't1', name: `${word} 改名` },
    }] }],
  })
  // The composer lives in the 对话 tab; the story returns to 历史 once the draft is open.
  await page.locator('[role="tab"]', { hasText: /^对话$/ }).filter({ visible: true }).first().click()
  const composer = page.locator('[data-dv-chat] [contenteditable="true"]:visible').first()
  await composer.waitFor({ timeout: 30_000 })
  await composer.click()
  await page.keyboard.type(word)
  await page.keyboard.press('Enter')
  const opened = await waitFor(async () => {
    const draft = (await branchesOf(project)).find(branch => branch.counts !== null && branch.session !== null)
    return draft === undefined || draft.session === null ? null : { ...draft, session: draft.session }
  }, 'the open draft', 60_000)
  await openHistory(page)
  return opened
}

/**
 * Discard a chat session's draft through the API: the dry read for its counts, then the discard with those counts.
 * @param project - the project.
 * @param session - the chat session that owns the draft.
 */
async function discardDraft(project: string, session: string): Promise<void> {
  const read = await harness.api.post('/api/dv/drafts/discard', { project, session, surface: 'canvas' }) as { counts: DraftCounts }
  await harness.api.post('/api/dv/drafts/discard', { project, session, surface: 'canvas', counts: read.counts })
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
    const operations = (await stateOf(project.id)).components.proj.records.filter(record => record.kind === 'operation')
    await expect.poll(() => shownRecords(page)).toEqual(operations.map(record => record.id).reverse())
    const render = rowOf(page, project.renders[1]?.id ?? '')
    expect(await render.getAttribute('data-actor')).toBe('user')
    expect(await render.getAttribute('data-status')).toBe('done')
    expect(await render.getAttribute('data-mark')).toBe('main')
    const text = await render.innerText()
    for (const word of ['你', '渲染镜头']) expect(text).toContain(word)
    // One thumbnail per row: the take's still, which the browser loads.
    const thumb = render.locator('[data-testid="dv-history-thumb"]')
    expect(await thumb.count()).toBe(1)
    await expect.poll(() => thumb.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0))
      .toBe(true)
    expect(await historyPanel(page).locator('[data-testid="dv-history-turn"]').count()).toBe(0)
    expect(await rowOf(page, project.timeline.id).innerText()).toContain('新建时间线')
    expect(page.errors).toEqual([])
  })

  it('an agent row shows its turn\'s request words; a human edit on the draft shows 草稿, then 已接受 after accept', async () => {
    const project = await seedProject('history-turn')
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    const draft = await openAgentDraft(page, project.id, 'history-turn-request')
    const agentRow = historyPanel(page).locator('[data-testid="dv-history-row"][data-actor="agent"]')
    await expect.poll(() => agentRow.count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => agentRow.innerText()).toContain('history-turn-request')
    expect(await agentRow.innerText()).toContain('智能体')
    expect(await agentRow.getAttribute('data-surface')).toBe('chat')
    expect(await agentRow.getAttribute('data-mark')).toBe('draft')
    const edit = await runOperation(project.id, 'timeline.rename', { timeline: 't1', name: '人工改名' }, [], draft.session)
    await expect.poll(() => rowOf(page, edit.id).getAttribute('data-mark')).toBe('draft')
    expect(await rowOf(page, edit.id).innerText()).toContain('草稿')
    await harness.api.post('/api/dv/drafts/accept', { project: project.id, session: draft.session, surface: 'canvas' })
    await expect.poll(() => rowOf(page, edit.id).getAttribute('data-mark')).toBe('main')
    expect(await rowOf(page, edit.id).innerText()).toContain('已接受')
    expect(await agentRow.innerText()).toContain('已接受')
    expect(page.errors).toEqual([])
  })

  it('undo shows the undone record as 已撤销; discard shows the draft records as 已丢弃; nothing is hidden', async () => {
    const project = await seedProject('history-marks')
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    const operations = (await stateOf(project.id)).components.proj.records.filter(record => record.kind === 'operation')
    await expect.poll(() => rows(page).count()).toBe(operations.length)
    const before = await shownRecords(page)
    await harness.api.post('/api/dv/undo', { project: project.id, surface: 'canvas' })
    await expect.poll(() => rowOf(page, project.timeline.id).getAttribute('data-mark')).toBe('undone')
    expect(await rowOf(page, project.timeline.id).innerText()).toContain('已撤销')
    // The undo is a record of its own, and the record it took back stays listed.
    expect(await shownRecords(page)).toEqual(expect.arrayContaining(before))
    expect(await rows(page).count()).toBe(before.length + 1)
    await harness.api.post('/api/dv/redo', { project: project.id, surface: 'canvas' })
    const draft = await openAgentDraft(page, project.id, 'history-marks-request')
    const agentRows = historyPanel(page).locator('[data-testid="dv-history-row"][data-actor="agent"]')
    await expect.poll(() => agentRows.count(), { timeout: 30_000 }).toBe(1)
    await discardDraft(project.id, draft.session)
    await expect.poll(() => agentRows.getAttribute('data-mark')).toBe('discarded')
    expect(await agentRows.innerText()).toContain('已丢弃')
    expect(page.errors).toEqual([])
  })

  it('a plan approval folds the renders it scheduled under its row; the toggle shows them', async () => {
    const id = await createProject('history-fold')
    const imported = await runOperation(id, 'asset.import', { base64: PNG_BASE64, mime: 'image/png', name: 'ref.png' })
    const shots = [{ prompt: 'history-fold shot 1', duration_sec: 1 }, { prompt: 'history-fold shot 2', duration_sec: 1 }]
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
    // The folded rows follow the approval's scheduled order: 渲染镜头 1, 渲染镜头 2, then 新建时间线.
    expect(await shownRecords(page)).toEqual([approval.id, ...scheduled, plan.id, imported.id, expect.any(String)])
    expect(await rowOf(page, scheduled[2] ?? '').innerText()).toContain('新建时间线')
    const firstShot = rowOf(page, scheduled[0] ?? '')
    expect(await firstShot.innerText()).toContain('渲染镜头 1')
    expect(await firstShot.getAttribute('data-actor')).toBe('system')
    expect(await firstShot.innerText()).toContain('自动')
    // The approval's thumbnail is its first render's still.
    const thumb = approvalRow.locator('[data-testid="dv-history-thumb"]')
    await expect.poll(() => thumb.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth > 0)).toBe(true)
    expect(page.errors).toEqual([])
  })

  it('the actor, branch, operation kind and timeline filters each narrow the rows', async () => {
    const project = await seedProject('history-filters')
    const t2 = await runOperation(project.id, 'timeline.create', { timeline: 't2', assets: [project.renders[0]?.outputs[0] ?? ''] })
    const page = await openPage()
    await gotoProject(page, project.id)
    await openHistory(page)
    const draft = await openAgentDraft(page, project.id, 'history-filters-request')
    await expect.poll(() => rowAttributes(page, 'data-actor'), { timeout: 30_000 }).toContain('agent')
    const all = (await shownRecords(page)).length
    const filter = (name: string): Locator => historyPanel(page).locator(`[data-testid="dv-history-filter-${name}"]`)
    // Each filter's empty option names the filter and shows every row.
    const reset = async (name: string): Promise<void> => { await filter(name).selectOption('') }
    // Actor.
    await filter('actor').selectOption({ label: '智能体' })
    await expect.poll(() => rowAttributes(page, 'data-actor')).toEqual(['agent'])
    await filter('actor').selectOption({ label: '你' })
    await expect.poll(async () => new Set(await rowAttributes(page, 'data-actor'))).toEqual(new Set(['user']))
    await reset('actor')
    // Branch: `main` leaves the draft out; the draft option shows only its records.
    await filter('branch').selectOption({ label: 'main' })
    await expect.poll(async () => (await rowAttributes(page, 'data-mark')).includes('draft')).toBe(false)
    const draftOption = await filter('branch').locator('option').evaluateAll(options => options
      .map(option => ({ value: (option as HTMLOptionElement).value, label: option.textContent ?? '' }))
      .find(option => option.label.startsWith('草稿 · '))?.value ?? '')
    expect(draftOption).not.toBe('')
    await filter('branch').selectOption(draftOption)
    await expect.poll(async () => new Set(await rowAttributes(page, 'data-mark'))).toEqual(new Set(['draft']))
    await reset('branch')
    // Operation kind: the timeline component's records only.
    await filter('component').selectOption({ label: '时间线' })
    const timelineRecords = new Set((await stateOf(project.id, draft.name)).components.proj.records
      .filter(record => record.operation?.startsWith('timeline.') === true).map(record => record.id))
    await expect.poll(async () => (await shownRecords(page)).length).toBeLessThan(all)
    expect((await shownRecords(page)).every(record => timelineRecords.has(record))).toBe(true)
    await reset('component')
    // Timeline: t2's records hold its create record and not t1's.
    await filter('timeline').selectOption({ label: '时间线 2' })
    await expect.poll(() => shownRecords(page)).toContain(t2.id)
    expect(await shownRecords(page)).not.toContain(project.timeline.id)
    await reset('timeline')
    await expect.poll(async () => (await shownRecords(page)).length).toBe(all)
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
    const render = await runOperation(id, 'shot.render', { prompt: 'history-live shot', duration_sec: 1 }, reference)
    await expect.poll(() => rowOf(page, render.id).getAttribute('data-status'), { timeout: 30_000 }).toBe('done')
    await expect.poll(() => rowOf(page, render.id).locator('[data-testid="dv-history-thumb"]').count()).toBe(1)
    expect(page.errors).toEqual([])
  })

  it('在轨迹中查看 on an agent row opens 轨迹 and shows that tool call', async () => {
    const project = await seedProject('history-trajectory')
    const page = await openPage()
    await gotoProject(page, project.id)
    await openAgentDraft(page, project.id, 'history-trajectory-request')
    await openHistory(page)
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

  it('在历史中查看 on a tool row in the chat opens 历史 with the record selected', async () => {
    const project = await seedProject('history-chat-link')
    const page = await openPage()
    await gotoProject(page, project.id)
    const draft = await openAgentDraft(page, project.id, 'history-chat-link-request')
    const records = (await stateOf(project.id, draft.name)).components.proj.records
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
