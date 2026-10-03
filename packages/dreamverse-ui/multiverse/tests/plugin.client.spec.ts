/** @vitest-environment jsdom */
/**
 * The multiverse page plugin on the real DSH slot registry and locale registry: it occupies the `root` slot, the
 * `session` scope, and the `dreamverse.multiverse` locale namespace while loaded, the DreamVerse creation and asset
 * library plugins fill the child slots that it declares, and unloading it frees the slots and the namespace so the
 * plugin can load again.
 */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { expect, it } from 'vitest'
import * as assetsPlugin from '../../assets/src/client/index.ts'
import * as creationPlugin from '../../creation/src/client/index.ts'
import { MultiverseRoot } from '../src/client/MultiverseApp.tsx'
import * as multiversePage from '../src/client/index.ts'

it('registers the page as the root occupant for its lifetime and loads again after unloading', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.slots.installLocale(locale)
  await ctx.plugin(creationPlugin).await()
  await ctx.plugin(assetsPlugin).await()
  document.title = 'Shell'

  const first = ctx.plugin(multiversePage)
  await first.await()
  expect(ctx.slots.entriesOfSlot('root').map(entry => entry.component)).toEqual([MultiverseRoot])
  expect(ctx.slots.entriesOfSlot('dreamverse.creation-studio')).toHaveLength(1)
  expect(ctx.slots.entriesOfSlot('dreamverse.asset-library')).toHaveLength(1)
  expect(document.title).toBe('Multiverse')
  const t = locale.bind('dreamverse.multiverse')
  expect(t('mode.player')).toBe('Player mode')

  await first.dispose()
  expect(ctx.slots.entriesOfSlot('root')).toEqual([])
  expect(ctx.slots.entriesOfSlot('dreamverse.creation-studio')).toEqual([])
  expect(document.title).toBe('Shell')
  expect(t('mode.player')).toBe('mode.player')

  const second = ctx.plugin(multiversePage)
  await second.await()
  expect(ctx.slots.entriesOfSlot('root').map(entry => entry.component)).toEqual([MultiverseRoot])
  expect(ctx.slots.entriesOfSlot('dreamverse.creation-studio')).toHaveLength(1)
  await ctx.fiber.dispose()
})
