// Browser smoke: boot the shipped video-harness profile with a fake backend and a scripted model, seed a project through
// the views API (upload, character, two-shot plan, approval), let the fake backend render both shots, then open the
// canvas tab in Chromium and assert it draws the plan, its two generations, and the sequence from the same log.
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootHarness, playwright, waitFor, type BootedHarness } from './harness.ts'

/** A 1×1 opaque PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

interface OpWire { id: string; tool?: { name: string }; status: string; outputs: string[] }
interface StateWire { ops: OpWire[]; sequence: { items: unknown[] } | null }

describe('video harness browser smoke: canvas tab', () => {
  let harness: BootedHarness
  let browser: Browser
  let page: Page
  let projectId = ''

  beforeAll(async () => {
    harness = await bootHarness()
    const created = await harness.api.post('/api/vh/projects', { title: 'smoke', surface: 'canvas' }) as { projectId: string }
    projectId = created.projectId
    const invoke = async (
      tool: string,
      params: Record<string, unknown>,
      inputs: Array<{ role: string; ref: string }> = [],
    ): Promise<OpWire> =>
      await harness.api.post('/api/vh/invoke', { project: projectId, tool, params, inputs, surface: 'canvas', intent: `smoke: ${tool}` }) as OpWire
    const upload = await invoke('asset.upload', { base64: PNG_BASE64, mime: 'image/png', name: 'ref.png' })
    await invoke('entity.character.create', { entity: 'c1', name: 'Dancer', refs: [upload.outputs[0]] })
    const plan = await invoke('plan.create', {
      title: 'smoke', continuity: 'independent', references: ['c1@1'],
      shots: [{ prompt: 'shot one', duration_sec: 1 }, { prompt: 'shot two', duration_sec: 1 }],
    })
    await invoke('plan.approve', { plan: plan.id })
    await waitFor(async () => {
      const state = await harness.api.get(`/api/vh/state?project=${projectId}&head=main`) as StateWire
      const done = state.ops.filter(op => op.tool?.name === 'generate.video' && op.status === 'done')
      return done.length === 2 && state.sequence !== null ? state : null
    }, 'two rendered shots and a sequence', 90_000)
    const executablePath = process.env['DSH_PLAYWRIGHT_EXECUTABLE_PATH']
    browser = await playwright.chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
  }, 150_000)

  afterAll(async () => {
    await page?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    await harness?.close()
  })

  it('draws the seeded plan, both generations, and the sequence on the canvas tab', async () => {
    await page.goto(harness.tokenUrl, { waitUntil: 'load' })
    // The right sidebar opens collapsed; its guide lists every registered tab type, and picking the canvas entry
    // opens the tab in the pane.
    const expand = page.getByRole('button', { name: 'Open right sidebar' })
    if (await expand.count() > 0) await expand.first().click()
    const entry = page.locator('[data-sidebar-right-guide-entry="vh-canvas"]')
    if (await entry.count() === 0) {
      const addTab = page.getByRole('button', { name: 'New tab' })
      await addTab.first().click()
    }
    await entry.first().click()
    const canvas = page.locator('[data-testid="vh-canvas"]')
    await canvas.waitFor({ timeout: 30_000 })
    await page.locator('[aria-label="plan.create"]').first().waitFor({ timeout: 30_000 })
    expect(await page.locator('[aria-label="plan.create"]').count()).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[aria-label="generate.video"]').count()).toBe(2)
    expect(await page.locator('[aria-label="sequence.create"]').count()).toBe(1)
    // The log, not the page, is the source of truth: the state route reports the same records the canvas drew.
    const state = await harness.api.get(`/api/vh/state?project=${projectId}&head=main`) as StateWire
    expect(state.ops.filter(op => op.tool?.name === 'generate.video')).toHaveLength(2)
    expect(harness.backend.requests).toHaveLength(2)
  })
})
