/** The plugin's registrations, and their removal when the plugin goes. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { VhClient } from '@video-harness/ui-kit/api.ts'
import { TIMELINE_ID, TIMELINE_KIND } from '../src/client/definition.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { TimelineBody } from '../src/client/TimelineBody.tsx'
import { apply as hostApply } from '../src/index.ts'

interface Recorded {
  name: string
  key: string
  locale: string
  inject: () => { client: unknown }
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber }
}

describe('ui-timeline apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers the type, its dictionaries, and the body seat under the type\'s id with an API client', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(TIMELINE_KIND)
    expect(definition?.id).toBe(TIMELINE_ID)
    expect(definition?.priority).toBe('builtin')
    expect(definition?.title('sidebar://vh-timeline')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()])).toEqual([[41, 'guide.title', 'guide.description']])
    expect(dictionaries.get('vhTimeline')).toEqual({ zh, en })
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([['sidebar.right.pane.tab', TIMELINE_ID, 'vhTimeline', TimelineBody]])
    expect(registered[0]?.inject().client).toBeInstanceOf(VhClient)
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('removes everything when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(TIMELINE_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
