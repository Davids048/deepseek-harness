/**
 * Right-panel tabs of the DreamVerse shell: 对话 shows the main session's chat in the narrow panel, and 轨迹 shows the
 * same session's trajectory without a composer. Both are page types of the session seat, so they follow the main
 * session. The 素材 tab is registered by `@video-harness/ui-assets`.
 *
 * @module @video-harness/ui-shell/tabs
 */
import { Fragment, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { pickText, useText } from '@video-harness/ui-kit/locale.ts'
import { ChatOnlyView } from './Center.tsx'
import css from './shell.module.css'

/** Implementation identity of the chat tab. */
export const CHAT_ID = '@video-harness/ui-shell/chat'
/** Implementation identity of the trajectory tab. */
export const TRAJECTORY_ID = '@video-harness/ui-shell/trajectory'

/** The chat tab type. */
export const chatDefinition: SidebarRightTabDefinition = {
  id: CHAT_ID, kind: 'vh-chat', priority: 'builtin', keepMounted: true, title: () => pickText('对话', 'Chat'),
  guide: [{
    id: 'vh-chat', order: 30, title: () => pickText('对话', 'Chat'),
    description: () => pickText('和 agent 对话，让它规划和生成', 'Talk with the agent to plan and generate'),
  }],
}

/** The trajectory tab type. */
export const trajectoryDefinition: SidebarRightTabDefinition = {
  id: TRAJECTORY_ID, kind: 'vh-trajectory', priority: 'builtin', title: () => pickText('轨迹', 'Trajectory'),
  guide: [{
    id: 'vh-trajectory', order: 40, title: () => pickText('轨迹', 'Trajectory'),
    description: () => pickText('agent 的每一步调用（开发者视图）', 'Every agent step (developer view)'),
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
    <div className={css.tab} data-vh-chat="">
      {!active && !settling && (
        <p className={`${css.tabHint} ${css.chatHint}`}>
          {t('告诉 agent 你想做什么视频，比如“做一支 15 秒的咖啡广告”。用 @ 引用项目里的片段、人物或素材。', 'Tell the agent what video to make, such as "a 15-second coffee ad". Type @ to reference clips, characters, or assets in the project.')}
        </p>
      )}
      <Fragment key={remounts}>
        {renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : 'active', hero: false }, { slots: { views: ChatOnlyView } })}
      </Fragment>
    </div>
  )
}

/** The trajectory view alone. */
function TrajectoryOnlyView(props: ConversationViewsProps): ReactNode {
  return <>{props.renderSlot('conversation.session', { view: 'trajectory' })}</>
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
 * The main session's trajectory, read-only. A session without turns shows what will appear here instead of a blank tab.
 * @param props - the tab props.
 * @returns the trajectory, or the empty-state hint.
 */
export function TrajectoryTab({ useSession, useConversation, renderFactorySlot }: TabProps): ReactNode {
  const t = useText()
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  if (!active) {
    return (
      <div className={`${css.tab} ${css.trajectory}`} data-vh-trajectory="">
        <p className={css.tabHint}>
          {t('这里会显示 agent 的每一步调用。在「对话」里发出请求后开始记录。', 'Every agent step appears here. It starts recording after you send a request in Chat.')}
        </p>
      </div>
    )
  }
  return (
    <div className={`${css.tab} ${css.trajectory}`} data-vh-trajectory="">
      <TrajectoryContent renderFactorySlot={renderFactorySlot} />
    </div>
  )
}
