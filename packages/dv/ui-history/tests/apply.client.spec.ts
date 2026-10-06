// @vitest-environment jsdom
/** The plugin's registrations, the tab opening on `dv:history-focus`, and their removal when the plugin goes. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { DvClient } from '@dv/ui-kit/api.ts'
import { DV_HISTORY_FOCUS_EVENT } from '@dv/ui-kit/workspace-events.ts'
import { HistoryTabBody } from '../src/client/HistoryPanel.tsx'
import { HISTORY_ID, HISTORY_KIND } from '../src/client/definition.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

interface Recorded {
  name: string
  key: string
  inject: () => { client: unknown }
  component: unknown
}

/**
 * Boot the client plugin over a real tab registry, a recording `ctx.slots` registry, and a recording right panel.
 * @returns the registry, the entries registered through `ctx.slots`, the opened tab kinds, and the plugin fiber.
 */
async function boot() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const opened: string[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('sidebarRight', { openTab: (kind: string) => { opened.push(kind) } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, opened, fiber }
}

const focus = (): void => { window.dispatchEvent(new CustomEvent(DV_HISTORY_FOCUS_EVENT, { detail: { session: 's1', toolCall: 'c1' } })) }

describe('ui-history apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers the type, the body seat under the type\'s id with an API client, and opens the tab on dv:history-focus', async () => {
    const { tabs, registered, opened } = await boot()
    const definition = tabs.get(HISTORY_KIND)
    expect(definition?.id).toBe(HISTORY_ID)
    expect(definition?.keepMounted).toBe(true)
    expect(definition?.guide?.map(entry => [entry.id, entry.order])).toEqual([[HISTORY_KIND, 45]])
    expect(registered.map(entry => [entry.name, entry.key, entry.component])).toEqual([['sidebar.right.pane.tab', HISTORY_ID, HistoryTabBody]])
    expect(registered[0]?.inject().client).toBeInstanceOf(DvClient)
    focus()
    expect(opened).toEqual([HISTORY_KIND])
  })

  it('removes everything when the plugin is disposed', async () => {
    const { tabs, registered, opened, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(HISTORY_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    focus()
    expect(opened).toEqual([])
  })
})
