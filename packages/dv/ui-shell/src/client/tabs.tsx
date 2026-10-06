/**
 * Right-panel tabs of the DreamVerse shell: 对话 shows the main session's chat in the narrow panel, and 轨迹 shows the
 * same session's trajectory without a composer. Both are page types of the session seat, so they follow the main
 * session. Opening 轨迹 with the param `callId` scrolls its trajectory to that tool call. The 素材库 tab is registered by
 * `@dv/ui-asset-pool`.
 *
 * @module @dv/ui-shell/tabs
 */
import { Fragment, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { pickText, useText } from '@dv/ui-kit/locale.ts'
import { ChatOnlyView } from './Center.tsx'
import css from './shell.module.css'

/** Implementation identity of the chat tab. */
export const CHAT_ID = '@dv/ui-shell/chat'
/** Implementation identity of the trajectory tab. */
export const TRAJECTORY_ID = '@dv/ui-shell/trajectory'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The tool call the trajectory scrolls to (the model's call ID, which records store as `tool_call`). */
    'dv-trajectory': { readonly callId?: string }
  }
}

/** The chat tab type. */
export const chatDefinition: SidebarRightTabDefinition = {
  id: CHAT_ID, kind: 'dv-chat', priority: 'builtin', keepMounted: true, title: () => pickText('对话', 'Chat'),
  guide: [{
    id: 'dv-chat', order: 30, title: () => pickText('对话', 'Chat'),
    description: () => pickText('和智能体对话，让它规划和渲染', 'Talk with the agent to plan and render'),
  }],
}

/** The trajectory tab type. */
export const trajectoryDefinition: SidebarRightTabDefinition = {
  id: TRAJECTORY_ID, kind: 'dv-trajectory', priority: 'builtin', title: () => pickText('轨迹', 'Trajectory'),
  guide: [{
    id: 'dv-trajectory', order: 40, title: () => pickText('轨迹', 'Trajectory'),
    description: () => pickText('智能体的每一步调用（开发者视图）', 'Every agent step (developer view)'),
  }],
}

/** Props of both tab bodies. */
export type TabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderFactories

/*
 * DSH keeps one composer editor per session and binds it to the composer view that mounted last; an unmounting view
 * unbinds it. The 轨迹 tab's Conversation content mounts a hidden composer of the same session, so closing 轨迹 leaves the
 * kept-mounted 对话 composer unbound: typed text shows, but Enter and 发送 do nothing. Each closed 轨迹 body bumps this
 * count, and the 对话 tab remounts its Conversation content on the bump, which binds the editor to its composer again.
 */
let trajectoryCloses = 0
const trajectoryCloseListeners = new Set<() => void>()

/** Subscribe to closed 轨迹 bodies. */
function subscribeTrajectoryCloses(listener: () => void): () => void {
  trajectoryCloseListeners.add(listener)
  return () => { trajectoryCloseListeners.delete(listener) }
}

/**
 * The main session's chat, sized for the panel. A blank session shows the plain composer: the DSH hero headline and
 * its Workspace picker never appear, because the session always belongs to the open project's Workspace.
 * @param props - the tab props.
 * @returns the Conversation content.
 */
export function ChatTab({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }: TabProps): ReactNode {
  const t = useText()
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const summaryBlank = useSessions(s => s.byId[sessionId]?.blank)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const settling = !active && session.openState === 'loading' && summaryBlank !== true
  const remounts = useSyncExternalStore(subscribeTrajectoryCloses, () => trajectoryCloses)
  return (
    <div className={css.tab} data-dv-chat="">
      {!active && !settling && (
        <p className={`${css.tabHint} ${css.chatHint}`}>
          {t('告诉智能体你想做什么视频，比如“做一支 15 秒的咖啡广告”。用 @ 引用项目里的片段、角色或素材。', 'Tell the agent what video to make, such as "a 15-second coffee ad". Type @ to reference clips, characters, or assets in the project.')}
        </p>
      )}
      <Fragment key={remounts}>
        {renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : 'active', hero: false }, { slots: { views: ChatOnlyView } })}
      </Fragment>
    </div>
  )
}

/** The tool call a session's 轨迹 tab was last opened on, with the tab navigation's revision. */
interface TrajectoryFocus { callId: string; revision: number }

/*
 * The 轨迹 tab body reads its navigation params, but the trajectory view sits inside DSH's Conversation content, whose
 * local view component receives only session props. The body publishes the requested tool call per session here, and
 * the view reads it.
 */
const trajectoryFocus = new Map<SessionId, TrajectoryFocus>()
const trajectoryFocusListeners = new Set<() => void>()

/** Subscribe to changed trajectory focus requests. */
function subscribeTrajectoryFocus(listener: () => void): () => void {
  trajectoryFocusListeners.add(listener)
  return () => { trajectoryFocusListeners.delete(listener) }
}

/**
 * The trajectory view alone. A requested tool call reaches DSH's trajectory as its focus; each new request mounts the
 * session body again, so a second request for the same call scrolls to it again.
 */
function TrajectoryOnlyView(props: ConversationViewsProps): ReactNode {
  const focus = useSyncExternalStore(subscribeTrajectoryFocus, () => trajectoryFocus.get(props.sessionId))
  if (focus === undefined) return <>{props.renderSlot('conversation.session', { view: 'trajectory' })}</>
  return <Fragment key={focus.revision}>{props.renderSlot('conversation.session', { view: 'trajectory', focus: focus.callId })}</Fragment>
}

/**
 * The trajectory's Conversation content. Its unmount runs after its hidden composer unbound the session editor, so
 * the bump lets the 对话 tab bind the editor again.
 * @param props - the tab's factory renderer.
 * @returns the Conversation content with the trajectory view.
 */
function TrajectoryContent({ renderFactorySlot }: Pick<TabProps, 'renderFactorySlot'>): ReactNode {
  useEffect(() => () => {
    trajectoryCloses += 1
    for (const listener of [...trajectoryCloseListeners]) listener()
  }, [])
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: { views: TrajectoryOnlyView } })
}

/**
 * Publish the tool call that the 轨迹 tab of a session was opened on; a navigation without `callId` clears it.
 * @param sessionId - the session.
 * @param callId - the requested tool call, if any.
 * @param revision - the tab navigation's revision, which grows with every open.
 */
function useTrajectoryFocus(sessionId: SessionId, callId: string | undefined, revision: number): void {
  useEffect(() => {
    if (callId === undefined) trajectoryFocus.delete(sessionId)
    else trajectoryFocus.set(sessionId, { callId, revision })
    for (const listener of [...trajectoryFocusListeners]) listener()
  }, [sessionId, callId, revision])
}

/**
 * The main session's trajectory, read-only, scrolled to the tool call named by the tab's `callId` param. A session
 * without turns shows what will appear here instead of a blank tab.
 * @param props - the tab props.
 * @returns the trajectory, or the empty-state hint.
 */
export function TrajectoryTab({ sessionId, useSession, useConversation, useTabInfo, renderFactorySlot }: TabProps): ReactNode {
  const t = useText()
  const { navigation } = useTabInfo().tab
  const callId = typeof navigation.params === 'object' && 'callId' in navigation.params ? navigation.params.callId : undefined
  useTrajectoryFocus(sessionId, callId, navigation.revision)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  if (!active) {
    return (
      <div className={`${css.tab} ${css.trajectory}`} data-dv-trajectory="">
        <p className={css.tabHint}>
          {t('这里会显示智能体的每一步调用。在「对话」里发出请求后开始记录。', 'Every agent step appears here. It starts recording after you send a request in Chat.')}
        </p>
      </div>
    )
  }
  return (
    <div className={`${css.tab} ${css.trajectory}`} data-dv-trajectory="">
      <TrajectoryContent renderFactorySlot={renderFactorySlot} />
    </div>
  )
}
