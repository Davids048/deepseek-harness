/**
 * Browser half of the DreamVerse shell: the center workspace in place of DSH's main Conversation, the DreamVerse
 * navigator and brand in the left sidebar, the 对话 / 轨迹 right-panel tabs, DSH's New Session action redirected
 * into the open project, the `dv:trajectory-focus` link that opens 轨迹 at one tool call, and the Ctrl+Z and Shift+Ctrl+Z keys
 * that undo and redo one step of the open project.
 *
 * @module @dv/ui-shell/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { DV_TRAJECTORY_FOCUS_EVENT, type DvWorkspaceEventMap } from '@dv/ui-kit/workspace-events.ts'
import { createActions } from './actions.ts'
import { CenterPanel, type ShellInjected } from './Center.tsx'
import { applyChrome } from './chrome.tsx'
import { BrandName, Navigator } from './Navigator.tsx'
import { getShell, refreshLinks } from './store.ts'
import { CHAT_ID, ChatTab, chatDefinition, TRAJECTORY_ID, TrajectoryTab, trajectoryDefinition } from './tabs.tsx'
import { listenHistoryKeys } from './undo-keys.ts'

export type { ShellActions } from './actions.ts'
export type { ShellInjected } from './Center.tsx'

/** Services the shell uses. */
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'workspaces', 'sessions', 'uiWorkspace']

/** Milliseconds between reads of the project ↔ Workspace links, which pick up projects the agent creates. */
const LINKS_POLL_MS = 4000

/**
 * Register the shell's DSH UI slot entries and tab types. The center and the navigator shadow DSH's entries at priority -1.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injected: ShellInjected = { shell: createActions(ctx) }
  ctx.effect(() => ctx.slots.inject('main.conversation', () => ctx.slots.register(
    { name: 'main.conversation', priority: -1, inject: () => injected }, CenterPanel,
  )), 'ui-shell: center')
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    { name: 'sidebar.workspaces', priority: -1, inject: () => injected }, Navigator,
  )), 'ui-shell: navigator')
  ctx.effect(() => ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
    { name: 'sidebar.brand.name', priority: -1 }, BrandName,
  )), 'ui-shell: brand')
  applyChrome(ctx)
  ctx.effect(() => ctx.sidebarRightTabs.register(chatDefinition), 'ui-shell: chat tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register(trajectoryDefinition), 'ui-shell: trajectory tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: CHAT_ID }, ChatTab,
  )), 'ui-shell: chat tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TRAJECTORY_ID }, TrajectoryTab,
  )), 'ui-shell: trajectory tab body')
  ctx.effect(() => {
    // DSH's New Session buttons (sidebar header and macOS window chrome) call `uiWorkspace.startSession`. In
    // DreamVerse they start a chat session in the open project, and on the entry page they equal 首页.
    const navigation = ctx.get('uiWorkspace')
    if (navigation === undefined) return () => {}
    Object.defineProperty(navigation, 'startSession', {
      configurable: true, writable: true,
      value: () => {
        const projectId = getShell().projectId
        const work = projectId === null ? injected.shell.goHome() : injected.shell.newSession(projectId)
        work.catch((error: unknown) => { console.warn('ui-shell: new session failed', error) })
      },
    })
    return () => { Reflect.deleteProperty(navigation, 'startSession') }
  }, 'ui-shell: New Session in the open project')
  ctx.effect(() => {
    // DSH's first-use start creates a default Workspace in the user's documents folder, which fails on hosts without
    // one and toasts "Unable to create default workspace". DreamVerse's first chat belongs to the entry Workspace, so
    // first-use initialization prepares that one instead.
    const workspaces = ctx.get('workspaces')
    if (workspaces === undefined) return () => {}
    Object.defineProperty(workspaces, 'initializeDefault', {
      configurable: true, writable: true,
      value: () => injected.shell.entryWorkspace(),
    })
    return () => { Reflect.deleteProperty(workspaces, 'initializeDefault') }
  }, 'ui-shell: entry Workspace as the default Workspace')
  ctx.effect(() => {
    const read = (): void => { refreshLinks().catch((error: unknown) => { console.warn('ui-shell: links read failed', error) }) }
    read()
    const timer = setInterval(read, LINKS_POLL_MS)
    return () => { clearInterval(timer) }
  }, 'ui-shell: links poll')
  ctx.effect(listenHistoryKeys, 'ui-shell: Ctrl+Z undo and Shift+Ctrl+Z redo of the open project')
  ctx.effect(() => {
    const seat = injected.shell.mountedSeat
    let stopWaiting = (): void => {}
    // Open 轨迹 on the event's chat session, moving the main session there first, and name the tool call to show.
    const onTrajectoryFocus = (event: Event): void => {
      const detail = (event as CustomEvent<DvWorkspaceEventMap['dv:trajectory-focus']>).detail
      if (typeof detail !== 'object' || detail === null || typeof detail.session !== 'string' || typeof detail.toolCall !== 'string') return
      stopWaiting()
      const open = (): void => { ctx.sidebarRight.openTab('dv-trajectory', { params: { callId: detail.toolCall } }) }
      if (seat.getSnapshot() === detail.session) {
        open()
        return
      }
      const unsubscribe = seat.subscribe(() => {
        if (seat.getSnapshot() !== detail.session) return
        stopWaiting()
        open()
      })
      stopWaiting = () => { unsubscribe(); stopWaiting = () => {} }
      injected.shell.openSession(detail.session)
    }
    window.addEventListener(DV_TRAJECTORY_FOCUS_EVENT, onTrajectoryFocus)
    return () => {
      stopWaiting()
      window.removeEventListener(DV_TRAJECTORY_FOCUS_EVENT, onTrajectoryFocus)
    }
  }, 'ui-shell: dv:trajectory-focus listener')
}
