/**
 * DSH chrome that DreamVerse hides or replaces: the internal-testing welcome notice, the sidebar's New Session button,
 * Plugins entry, and New-Session brand click, the right-panel guide that offers DSH tab types (workspace files,
 * terminal, the canvas and cuts tabs the center already shows), right-panel tab titles frozen in the language of the
 * moment they opened, a few DSH strings that name DeepSeek or Workspaces, and the developer details of the composer
 * (statistics, context meter, host slash commands).
 *
 * @module @video-harness/ui-shell/chrome
 */
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { useText } from '@video-harness/ui-kit/locale.ts'
import { ASSETS_KIND } from './actions.ts'
import { CHAT_ID, TRAJECTORY_ID } from './tabs.tsx'
import css from './chrome.module.css'

/** Implementation identity of the 素材 tab that `@video-harness/ui-assets` registers. */
const ASSETS_ID = '@video-harness/ui-assets'

/**
 * Sidebar controls DreamVerse hides. The DSH sidebar draws them without a slot, so the shell hides them by their CSS
 * Module class names, whose hashed prefix varies and whose `_name` suffix does not: the New Session button (expanded
 * and rail), the global panel list (its only entry is Plugins, whose page would replace the project center), and the
 * brand's New Session click. The composer's context-occupancy meter has no slot either; its button is found by its
 * accessible label. Composer menu rows show their localized label only, without the internal name (`file`) beside it.
 */
const HIDDEN_CHROME_CSS = `
button[class$="_newSession"] { display: none !important; }
nav[class$="_panelList"] { display: none !important; }
button[class*="_brand "] { pointer-events: none; cursor: default; }
button[aria-label^="上下文已用"], button[aria-label$=" of context used"] { display: none !important; }
[data-trigger-menu] span[class$="_itemAlias"] { display: none !important; }
`

/** DSH dictionary entries DreamVerse rewords: namespace → key → [Chinese, English]. */
const TEXT_OVERRIDES: Record<string, Record<string, [string, string]>> = {
  chat: {
    'chat.deepDiving': ['思考中', 'Thinking…'],
    'message.turnProcess.deepDivingFor': ['思考中，用时{duration}', 'Thinking for {duration}'],
  },
  conversation: {
    // Shown while the entry page's chat session is still opening.
    'placeholder.workspace': ['正在准备对话…', 'Preparing the chat…'],
    'placeholder.default': ['描述你想做的视频，@ 引用片段、人物或素材', 'Describe the video you want; type @ to reference clips, characters, or assets'],
    'placeholder.hero': ['描述你想做的视频，@ 引用片段、人物或素材', 'Describe the video you want; type @ to reference clips, characters, or assets'],
  },
}

/** Renders nothing in place of a DSH slot entry DreamVerse hides. */
function Hidden(): ReactNode {
  return null
}

/**
 * Remove the host slash commands (feedback, compact, permission, export, goal, plan) from the composer: DreamVerse
 * has no slash commands for creators, and the composer's ＋ menu keeps its file action. The command catalog fetcher
 * of `ctx.commandUi` is replaced by one that lists nothing; `ui-commands` has no public filter for host commands.
 * @param commandUi - the `commandUi` service.
 * @returns a disposer that restores the fetcher.
 */
function hideHostCommands(commandUi: unknown): () => void {
  const directory: unknown = Reflect.get(commandUi as object, 'directory')
  if (directory === null || typeof directory !== 'object') return () => {}
  const fetchCommands: unknown = Reflect.get(directory, 'fetchCommands')
  const invalidate = (): void => { Reflect.apply(Reflect.get(directory, 'invalidateAll') as () => void, directory, []) }
  if (typeof fetchCommands !== 'function') return () => {}
  Reflect.set(directory, 'fetchCommands', () => Promise.resolve([]))
  invalidate()
  return () => {
    Reflect.set(directory, 'fetchCommands', fetchCommands)
    invalidate()
  }
}

/** The right-panel tab kinds the DreamVerse guide offers, in order. */
const GUIDE_KINDS = ['vh-chat', ASSETS_KIND, 'vh-trajectory'] as const

/**
 * Rewrite the DSH dictionary entries in `TEXT_OVERRIDES` in place. The locale runtime keeps one dictionary object per
 * namespace and language and reads it on every translation, so editing the registered object changes the text without
 * a second registration, which the runtime refuses.
 * @param locale - `ctx.locale`.
 */
function overrideTexts(locale: unknown): void {
  const dicts: unknown = Reflect.get(locale as object, 'dicts')
  if (!(dicts instanceof Map)) return
  for (const [ns, entries] of Object.entries(TEXT_OVERRIDES)) {
    const byLocale: unknown = dicts.get(ns)
    if (!(byLocale instanceof Map)) continue
    for (const [key, [zh, en]] of Object.entries(entries)) {
      const zhDict: unknown = byLocale.get('zh')
      const enDict: unknown = byLocale.get('en')
      if (zhDict !== null && typeof zhDict === 'object') Reflect.set(zhDict, key, zh)
      if (enDict !== null && typeof enDict === 'object') Reflect.set(enDict, key, en)
    }
  }
}

/**
 * The welcome-notice onboarding step in DreamVerse: completes at once, so the DSH internal-testing modal never shows.
 * @param props - the onboarding coordinator's props.
 * @returns nothing.
 */
function SkipWelcome({ complete }: { complete: () => void }): ReactNode {
  useEffect(() => { complete() }, [complete])
  return null
}

/** A right-panel tab title that follows the interface language, for the 对话 / 素材 / 轨迹 tabs. */
function liveTitle(zh: string, en: string): (props: PropsRuntime<'sidebar.right.pane.tab.title'>) => ReactNode {
  return function LiveTitle(): ReactNode {
    const t = useText()
    return <>{t(zh, en)}</>
  }
}

/**
 * The right-panel guide (the page a new tab shows): a short hint and the three DreamVerse panels. The canvas and cuts
 * live in the center and DSH's tab types do not belong to a creator, so neither is offered.
 * @param props - the guide chain props.
 * @returns the guide.
 */
function DreamVerseGuide({ useTabInfo }: PropsRuntime<'sidebar.right.tab.guide'>): ReactNode {
  const { tab } = useTabInfo()
  const t = useText()
  const labels: Record<(typeof GUIDE_KINDS)[number], [string, string]> = {
    'vh-chat': [t('对话', 'Chat'), t('和 agent 对话，让它规划和渲染', 'Talk with the agent to plan and render')],
    [ASSETS_KIND]: [t('素材', 'Assets'), t('项目的人物、参考图、导入和渲染结果', "The project's characters, reference images, imports, and renders")],
    'vh-trajectory': [t('轨迹', 'Trajectory'), t('agent 的每一步调用（开发者视图）', 'Every agent step (developer view)')],
  }
  return (
    <div className={css.guide} data-vh-guide="">
      <p className={css.hint}>{t('选择要在这里打开的面板', 'Choose a panel to open here')}</p>
      {GUIDE_KINDS.map(kind => (
        <button key={kind} type="button" className={css.entry} onClick={() => { tab.actions.openTab(kind, { replaceTab: true }) }}>
          <span className={css.entryTitle}>{labels[kind][0]}</span>
          <span className={css.entryDescription}>{labels[kind][1]}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Register the DreamVerse replacements for DSH chrome.
 * @param ctx - client root context with `slots` and `locale`.
 */
export function applyChrome(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@video-harness/ui-shell/chrome'
    style.textContent = HIDDEN_CHROME_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'ui-shell: hidden DSH chrome')
  ctx.effect(() => {
    // `settings.onboarding` is declared by a settings package this bundle does not type against, so the registry is
    // reached untyped for this one registration.
    const slots: { inject(key: string, fn: () => () => void): () => void; register(options: object, component: unknown): () => void } = Reflect.get(ctx, 'slots')
    return slots.inject('settings.onboarding', () => slots.register(
      { name: 'settings.onboarding', id: 'welcome-notice', order: -100, priority: -1 }, SkipWelcome,
    ))
  }, 'ui-shell: skip the DSH welcome notice')
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'stats', priority: -1 }, Hidden,
  )), 'ui-shell: hide the composer statistics')
  ctx.inject(['commandUi'], (scope) => {
    scope.effect(() => hideHostCommands(scope.get('commandUi')), 'ui-shell: hide host slash commands')
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide', () => ctx.slots.register(
    { name: 'sidebar.right.tab.guide', select: () => true }, DreamVerseGuide,
  )), 'ui-shell: right-panel guide')
  const titles: Array<[string, string, string]> = [[CHAT_ID, '对话', 'Chat'], [ASSETS_ID, '素材', 'Assets'], [TRAJECTORY_ID, '轨迹', 'Trajectory']]
  for (const [key, zh, en] of titles) {
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key }, liveTitle(zh, en),
    )), `ui-shell: live title ${key}`)
  }
  ctx.effect(() => {
    const locale: unknown = ctx.get('locale')
    overrideTexts(locale)
    // Dictionaries registered later are rewritten when the runtime announces them.
    const subscribe: unknown = locale === undefined ? undefined : Reflect.get(locale as object, 'subscribe')
    if (typeof subscribe !== 'function') return () => {}
    const unsubscribe: unknown = Reflect.apply(subscribe, locale, [() => { overrideTexts(locale) }])
    return typeof unsubscribe === 'function' ? () => { Reflect.apply(unsubscribe, undefined, []) } : () => {}
  }, 'ui-shell: DreamVerse wording')
}
