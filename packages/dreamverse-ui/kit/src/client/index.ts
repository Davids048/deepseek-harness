/**
 * DreamVerse UI kit, browser half: fills the shell's `root` slot with the DreamVerse page, declares the page's child
 * slots, and applies the page-level settings of the FastVideo DreamVerse frontend's root layout: the document title,
 * the favicon, the stored dark theme, the toast container, and the Tailwind stylesheet of every dreamverse-ui package.
 *
 * The DSH renderer wraps `root` in a `session-maybe` scope that needs an installed `session` scope adapter. DreamVerse
 * has no DSH Sessions, so the kit installs an adapter whose binding is permanently absent instead of loading the DSH
 * Session UI plugins.
 *
 * @module @dreamverse/ui-kit/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { HostObservable, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import './styles/app.generated.css'
import { DreamverseRoot } from './DreamverseRoot.tsx'
import { DREAMVERSE_SLOTS } from './contracts.ts'

/** The absent `session` scope binding: no Session key, no standard sources. */
const NO_SESSION: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }

/** A constant observable of {@link NO_SESSION}; it never changes, so subscribers are never called. */
const noSession: HostObservable<StandardSourceBinding> = {
  getSnapshot: () => NO_SESSION,
  subscribe: () => () => {},
}

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Apply the document settings, install the absent `session` scope, and register the DreamVerse page as the `root`
 * occupant with its child slots for the plugin's lifetime.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => applyDocumentSettings(), 'dreamverse document settings')
  ctx.slots.installScope('session', { current: noSession, bindingSource: () => noSession })
  ctx.effect(() => ctx.slots.register({ name: 'root', children: DREAMVERSE_SLOTS }, DreamverseRoot), 'dreamverse root')
}

/**
 * Set the title, favicon, and stored dark theme like the FastVideo root layout, and restore the previous title and
 * icon on unload.
 * @returns the disposer that restores the previous document settings.
 */
function applyDocumentSettings(): () => void {
  const previousTitle = document.title
  document.title = 'Dreamverse'
  const icon = document.createElement('link')
  icon.rel = 'icon'
  icon.href = '/icon-simple.svg'
  document.head.append(icon)
  try {
    if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark')
  } catch {
    // Storage can be unavailable (private mode or blocked site data); the page then starts in the light theme.
  }
  return () => {
    document.title = previousTitle
    icon.remove()
  }
}
