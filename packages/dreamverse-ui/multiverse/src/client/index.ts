/**
 * DreamVerse multiverse UI, browser half: fills the shell's `root` slot with the multiverse page, declares the DreamVerse
 * page slots that the page renders, registers the page's copy as the `dreamverse.multiverse` locale namespace, and loads
 * the kit's Tailwind stylesheet so the page looks like the DreamVerse page. `@dreamverse/ui-creation` and
 * `@dreamverse/ui-assets` fill the declared slots.
 *
 * The DSH renderer wraps `root` in a `session-maybe` scope that needs an installed `session` scope adapter. The
 * multiverse page has no DSH Sessions, so this plugin installs an adapter whose binding is permanently absent, as the
 * DreamVerse kit does.
 *
 * @module @dreamverse/ui-multiverse/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { HostObservable, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import '@dreamverse/ui-kit/styles/app.generated.css'
import { MULTIVERSE_SLOTS, MultiverseRoot } from './MultiverseApp.tsx'
import { en, zh } from './locales.ts'

/** The absent `session` scope binding: no Session key, no standard sources. */
const NO_SESSION: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }

/** A constant observable of {@link NO_SESSION}; it never changes, so subscribers are never called. */
const noSession: HostObservable<StandardSourceBinding> = {
  getSnapshot: () => NO_SESSION,
  subscribe: () => () => {},
}

/** Required services: the UI slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Set the document title and the stored theme, install the absent `session` scope, register the page's dictionaries,
 * and register the multiverse page as the `root` occupant with its child slots for the plugin's lifetime.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const previousTitle = document.title
    document.title = 'Multiverse'
    try {
      // The kit's theme toggle stores the choice under `theme`, as on the DreamVerse page.
      if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark')
    } catch {
      // Storage can be unavailable (private mode or blocked site data); the page then starts in the light theme.
    }
    return () => { document.title = previousTitle }
  }, 'multiverse document settings')
  ctx.slots.installScope('session', { current: noSession, bindingSource: () => noSession })
  ctx.effect(() => ctx.locale.register('dreamverse.multiverse', { zh, en }), 'multiverse copy')
  ctx.effect(() => ctx.slots.register({ name: 'root', children: MULTIVERSE_SLOTS, locale: 'dreamverse.multiverse' }, MultiverseRoot),
    'multiverse root')
}
