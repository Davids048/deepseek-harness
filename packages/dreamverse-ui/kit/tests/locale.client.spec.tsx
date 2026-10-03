/** @vitest-environment jsdom */
/**
 * The DreamVerse page through the real DSH renderer and locale service in a Chinese browser: the kit and every page
 * occupant plugin register their dictionaries, and the lobby renders each package's copy in Chinese.
 */
import './support/setup.client.ts'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import * as rendererPlugin from '@deepseek-ai/dsh-client-ui-renderer/client'
import { act, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as assetsPlugin from '../../assets/src/client/index.ts'
import * as creationPlugin from '../../creation/src/client/index.ts'
import { zh as creationZh } from '../../creation/src/client/locales.ts'
import * as directingPlugin from '../../directing/src/client/index.ts'
import * as playerPlugin from '../../player/src/client/index.ts'
import * as projectHistoryPlugin from '../../project-history/src/client/index.ts'
import { zh as projectHistoryZh } from '../../project-history/src/client/locales.ts'
import * as kitPlugin from '../src/client/index.ts'
import { en as kitEn, zh as kitZh } from '../src/client/locales.ts'

usePinnedBrowserLanguages('zh-CN')

afterEach(() => {
  vi.unstubAllGlobals()
})

it('renders the lobby copy of the kit and its occupants in the browser language', async () => {
  // The capability and project reads stay pending, so the lobby keeps showing the capability loading notice.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  const ctx = new Context()
  await ctx.plugin(rendererPlugin).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.slots.installLocale(locale)
  for (const plugin of [kitPlugin, creationPlugin, playerPlugin, directingPlugin, assetsPlugin, projectHistoryPlugin]) {
    await ctx.plugin(plugin).await()
  }
  const container = document.body.appendChild(document.createElement('div'))
  let unmount = (): void => {}
  await act(async () => { unmount = ctx.uiRenderer.mount(container) })

  const page = within(container)
  expect(page.getAllByText(kitZh['header.joinWaitlist'])).not.toHaveLength(0)
  expect(page.queryByText(kitEn['header.joinWaitlist'])).toBeNull()
  expect(page.getByText(kitZh['capabilities.loading'])).toBeInTheDocument()
  expect(page.getByLabelText(creationZh['nav.label'])).toBeInTheDocument()
  expect(page.getByLabelText(projectHistoryZh['sidebar.label'])).toBeInTheDocument()

  act(() => { unmount() })
  container.remove()
  await ctx.fiber.dispose()
})
