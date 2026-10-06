/**
 * Browser half of the DreamVerse composer additions:
 * - an `@` source listing the bound project's clips, characters, and assets;
 * - a 引用 row in the composer's ＋ menu that opens that `@` list at the end of the draft;
 * - the 渲染前先问 / 直接渲染 and 质量 / 速度 toggles in `conversation.input.left`;
 * - the `dv_shot_render` tool card, which shows the prompt, status, and rendered video;
 * - creator-facing names for the other `dv_*` tools in their chat rows and in the running group title;
 * - 在历史中查看 on every settled row whose tool is not read-only, including failed calls, which dispatches
 *   `dv:history-focus`;
 * - the approval cards (批准 / 跳过, and 全部批准 when several wait) in `conversation.input.dock`;
 * - an empty `conversation.input.permission` entry that hides DSH's file-permission chip;
 * - the `dv:compose` prefill from the canvas and asset pool views, which also brings the 对话 tab to the front.
 *
 * @module @dv/ui-composer/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { IconLinkOutlineRegular, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { createElement, useCallback, type ComponentType } from 'react'
import { DV_COMPOSE_EVENT, type DvComposeDetail } from '@dv/ui-kit/compose.ts'
import { getCurrentProject } from '@dv/ui-kit/current-project.ts'
import { pickText } from '@dv/ui-kit/locale.ts'
import { deliverCompose, mountComposer } from './compose.ts'
import { MENTION_SOURCE, projectMentionSource } from './mention.ts'
import { DV_TOOL_LABELS } from '@dv/ui-kit/tool-labels.ts'
import { addToolNames } from './tool-labels.ts'
import { ModeControls, PendingBar, RenderCard, ToolLabelRow } from './views.tsx'

export { projectItems, referenceText, MENTION_SOURCE } from './mention.ts'
export { uriOf } from './compose.ts'

/** The branded session ID the session-scoped DSH UI slots receive. */
type SessionId = ToolCallViewProps['sessionId']

/** The agent tool of `shot.render`. */
const RENDER_TOOL = 'dv_shot_render'

/** Required services: the trigger registry, the sessions, the slots, and the right sidebar that holds 对话. */
export const inject = ['inputTriggers', 'sessions', 'slots', 'sidebarRight']

/**
 * The part of DSH's `ctx.commandUi` service (`@deepseek-ai/dsh-client-ui-commands`) that adds an action row to the
 * composer's ＋ menu; this package does not depend on `ui-commands`, so the face is declared here.
 */
interface CommandMenu {
  register(contribution: {
    readonly name: string
    label(): string
    description(): string
    readonly icon: ComponentType<IconProps>
    available(session: ClientSessionContext): boolean
    readonly ui: { readonly kind: 'action'; run(session: ClientSessionContext): void }
  }): () => void
}

/**
 * Register the composer additions.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.inputTriggers.registerSource(projectMentionSource()), 'dv-composer: @ source')

  /** The input facade of one session, while its scope and conversation service exist. */
  const inputOf = (sessionId: SessionId): SessionInput | undefined => {
    const scope = ctx.sessions.scope(sessionId)
    return scope?.get('conversation')?.input.for(scope)
  }

  /**
   * Open the `@` project-item list of one session's composer at the end of its draft; a pick inserts its chip there.
   * @param sessionId - the session whose ＋ menu row was picked.
   */
  function openMentionMenu(sessionId: SessionId): void {
    const scope = ctx.sessions.scope(sessionId)
    const input = inputOf(sessionId)
    if (scope === undefined || input === undefined) return
    const { draft, draftRev } = input.state.getSnapshot()
    ctx.inputTriggers.sessionOf(scope).toggleSource(MENTION_SOURCE, {
      trigger: '@', query: '', quoted: false, position: draft.trim() === '' ? 'leading' : 'inline',
      span: { start: draft.length, end: draft.length, draftRev },
    })
  }
  ctx.inject(['commandUi'], (scope) => {
    const commands = scope.get('commandUi') as CommandMenu
    scope.effect(() => commands.register({
      name: 'reference',
      label: () => pickText('引用', 'Reference'),
      description: () => pickText('项目里的片段、角色、场景、风格或素材', 'A clip, character, location, style, or asset of the project'),
      icon: IconLinkOutlineRegular,
      available: () => getCurrentProject() !== null,
      // The ＋ menu closes itself after running the action, so the `@` list opens on the next task.
      ui: { kind: 'action', run: (session) => { setTimeout(() => { openMentionMenu(session.sessionId) }, 0) } },
    }), 'dv-composer: ＋ menu reference row')
  })

  function Controls(props: { sessionId: SessionId }) {
    const { sessionId } = props
    const onMount = useCallback(() => mountComposer(() => inputOf(sessionId)), [sessionId])
    return createElement(ModeControls, { sessionId, onMount })
  }
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'dv-composer-modes', order: 50 }, Controls))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'dv-composer-approvals', order: 5 }, PendingBar))
  // DreamVerse sessions always edit inside their project's Workspace, so DSH's file-permission chip (工作区内修改) is
  // hidden: an empty entry at a lower priority shadows the permission picker.
  ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({ name: 'conversation.input.permission', priority: -1 }, () => null))

  function RenderRow(props: ToolCallViewProps) {
    return createElement(RenderCard, { sessionId: props.sessionId, callId: props.callId, phase: props.phase, block: props.block })
  }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: RENDER_TOOL }, RenderRow))

  // Every other labelled tool shows its creator-facing name in its chat row and in the running group title.
  function LabelRow(props: ToolCallViewProps) {
    const label = DV_TOOL_LABELS[props.toolName] ?? [props.toolName, props.toolName]
    return createElement(ToolLabelRow, {
      label, toolName: props.toolName, sessionId: props.sessionId, callId: props.callId, phase: props.phase, block: props.block,
    })
  }
  for (const name of Object.keys(DV_TOOL_LABELS)) {
    if (name !== RENDER_TOOL) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name }, LabelRow))
  }
  ctx.effect(() => {
    const locale: unknown = ctx.get('locale')
    addToolNames(locale)
    // Dictionaries registered later get the names when the runtime announces them.
    const subscribe: unknown = locale === undefined ? undefined : Reflect.get(locale as object, 'subscribe')
    if (typeof subscribe !== 'function') return () => {}
    const unsubscribe: unknown = Reflect.apply(subscribe, locale, [() => { addToolNames(locale) }])
    return typeof unsubscribe === 'function' ? () => { Reflect.apply(unsubscribe, undefined, []) } : () => {}
  }, 'dv-composer: tool names in the chat')

  ctx.effect(() => {
    const onCompose = (event: Event): void => {
      const detail = (event as CustomEvent<DvComposeDetail | null>).detail
      if (typeof detail !== 'object' || detail === null || !Array.isArray(detail.refs)) return
      // Bring 对话 to the front so the user sees the prefilled draft; a closed chat tab reopens and takes the event.
      if (ctx.sidebarRight.mounted.getSnapshot() !== undefined) ctx.sidebarRight.openTab('dv-chat')
      deliverCompose(detail)
    }
    window.addEventListener(DV_COMPOSE_EVENT, onCompose)
    return () => { window.removeEventListener(DV_COMPOSE_EVENT, onCompose) }
  }, 'dv-composer: dv:compose listener')
}
