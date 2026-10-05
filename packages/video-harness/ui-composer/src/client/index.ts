/**
 * Browser half of the video harness composer additions:
 * - an `@` source listing the bound project's clips, characters, and assets;
 * - the 生成前先问 / 直接生成 and 质量 / 速度 toggles in `conversation.input.left`;
 * - the `vh_generate_video` tool card, which shows the prompt, status, and generated video;
 * - creator-facing names for the other `vh_*` tools in their chat rows and in the running group title;
 * - the approval cards (批准 / 跳过, and 全部批准 when several wait) in `conversation.input.dock`;
 * - an empty `conversation.input.permission` entry that hides DSH's file-permission chip;
 * - the `vh:compose` prefill from the canvas, Tool, and asset views, which also brings the 对话 tab to the front.
 *
 * @module @video-harness/ui-composer/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { createElement, useCallback } from 'react'
import { VH_COMPOSE_EVENT, type VhComposeDetail } from '@video-harness/ui-kit/compose.ts'
import { deliverCompose, mountComposer } from './compose.ts'
import { projectMentionSource } from './mention.ts'
import { addToolNames, VH_TOOL_LABELS } from './tool-labels.ts'
import { GenerateCard, ModeControls, PendingBar, ToolLabelRow } from './views.tsx'

export { projectItems, referenceText, MENTION_SOURCE } from './mention.ts'
export { uriOf } from './compose.ts'

/** The branded session ID the session-scoped slots receive. */
type SessionId = ToolCallViewProps['sessionId']

/** The DSH tool name of `generate.video`. */
const GENERATE_TOOL = 'vh_generate_video'

/** Required services: the trigger registry, the sessions, the slots, and the right sidebar that holds 对话. */
export const inject = ['inputTriggers', 'sessions', 'slots', 'sidebarRight']

/**
 * Register the composer additions.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.inputTriggers.registerSource(projectMentionSource()), 'vh-composer: @ source')

  /** The input facade of one session, while its scope and conversation service exist. */
  const inputOf = (sessionId: SessionId): SessionInput | undefined => {
    const scope = ctx.sessions.scope(sessionId)
    return scope?.get('conversation')?.input.for(scope)
  }

  function Controls(props: { sessionId: SessionId }) {
    const { sessionId } = props
    const onMount = useCallback(() => mountComposer(() => inputOf(sessionId)), [sessionId])
    return createElement(ModeControls, { sessionId, onMount })
  }
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'vh-composer-modes', order: 50 }, Controls))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'vh-approvals', order: 5 }, PendingBar))
  // DreamVerse sessions always edit inside their project's Workspace, so DSH's file-permission chip (工作区内修改) is
  // hidden: an empty entry at a lower priority shadows the permission picker.
  ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({ name: 'conversation.input.permission', priority: -1 }, () => null))

  function GenerateRow(props: ToolCallViewProps) {
    return createElement(GenerateCard, { sessionId: props.sessionId, callId: props.callId, phase: props.phase, block: props.block })
  }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: GENERATE_TOOL }, GenerateRow))

  // Every other vh_* tool shows its creator-facing name in its chat row and in the running group title.
  function LabelRow(props: ToolCallViewProps) {
    const label = VH_TOOL_LABELS[props.toolName] ?? [props.toolName, props.toolName]
    return createElement(ToolLabelRow, { label, toolName: props.toolName, phase: props.phase, block: props.block })
  }
  for (const name of Object.keys(VH_TOOL_LABELS)) {
    if (name !== GENERATE_TOOL) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name }, LabelRow))
  }
  ctx.effect(() => {
    const locale: unknown = ctx.get('locale')
    addToolNames(locale)
    // Dictionaries registered later get the names when the runtime announces them.
    const subscribe: unknown = locale === undefined ? undefined : Reflect.get(locale as object, 'subscribe')
    if (typeof subscribe !== 'function') return () => {}
    const unsubscribe: unknown = Reflect.apply(subscribe, locale, [() => { addToolNames(locale) }])
    return typeof unsubscribe === 'function' ? () => { Reflect.apply(unsubscribe, undefined, []) } : () => {}
  }, 'vh-composer: tool names in the chat')

  ctx.effect(() => {
    const onCompose = (event: Event): void => {
      const detail = (event as CustomEvent<VhComposeDetail>).detail
      if (typeof detail !== 'object' || detail === null || !Array.isArray(detail.refs)) return
      // Bring 对话 to the front so the user sees the prefilled draft; a closed chat tab reopens and takes the event.
      if (ctx.sidebarRight.mounted.getSnapshot() !== undefined) ctx.sidebarRight.openTab('vh-chat')
      deliverCompose(detail)
    }
    window.addEventListener(VH_COMPOSE_EVENT, onCompose)
    return () => { window.removeEventListener(VH_COMPOSE_EVENT, onCompose) }
  }, 'vh-composer: vh:compose listener')
}
