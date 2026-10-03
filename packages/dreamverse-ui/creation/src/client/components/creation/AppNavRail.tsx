import { FolderOpen, Home, Sparkles } from 'lucide-react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import { cn } from '@dreamverse/ui-kit/utils.ts'

import type { AppNavSection } from '@dreamverse/ui-kit/contracts.ts'
import type { DreamverseCreationKey } from '../../locales.ts'

export type { AppNavSection }

interface AppNavRailProps {
  activeSection?: AppNavSection
  onSectionChange?: (section: AppNavSection) => void
  onOpenAssets?: (() => void) | undefined
  className?: string
  t: TranslateNS<'dreamverse.creation'>
}

const NAV_ITEMS: Array<{ id: AppNavSection; labelKey: DreamverseCreationKey; icon: typeof Home }> = [
  { id: 'explore', labelKey: 'nav.explore', icon: Home },
  { id: 'create', labelKey: 'nav.create', icon: Sparkles },
  { id: 'assets', labelKey: 'nav.assets', icon: FolderOpen },
]

/** Show the lobby section links; the Assets link also opens the asset library. */
export default function AppNavRail({
  activeSection = 'create',
  onSectionChange = () => {},
  onOpenAssets,
  className,
  t,
}: AppNavRailProps) {
  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col items-center gap-2 border-r border-border/40 bg-background/30 px-2.5 py-5 lg:flex',
        className,
      )}
      aria-label={t('nav.label')}
    >
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const isActive = item.id === activeSection
        return (
          <button
            key={item.id}
            type="button"
            aria-label={t(item.labelKey)}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => {
              if (item.id === 'assets') {
                onOpenAssets?.()
              }
              onSectionChange(item.id)
            }}
            className={cn(
              'studio-control studio-control-press flex w-[4.5rem] min-h-11 flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[10px] font-medium tracking-wide',
              isActive
                ? 'bg-secondary/90 text-foreground shadow-sm ring-1 ring-border/60'
                : 'text-muted-foreground hover-capable:hover:bg-secondary/50 hover-capable:hover:text-foreground',
            )}
          >
            <Icon className={cn('size-[18px]', isActive && 'text-accent-blue')} />
            {t(item.labelKey)}
          </button>
        )
      })}
    </aside>
  )
}
