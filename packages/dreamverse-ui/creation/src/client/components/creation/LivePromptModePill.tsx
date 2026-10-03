import { Check, ChevronDown, GitBranch } from 'lucide-react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

import ConfigPill from './ConfigPill.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dreamverse/ui-kit/components/ui/dropdown-menu.tsx'

/** The two things a submitted live prompt can do; `rewrite` is the boolean the composer stores. */
const LIVE_PROMPT_MODES = [
  { rewrite: true, labelKey: 'promptAction.rewrite', descriptionKey: 'promptAction.rewrite.description' },
  { rewrite: false, labelKey: 'promptAction.continue', descriptionKey: 'promptAction.continue.description' },
] as const

interface LivePromptModePillProps {
  /** Whether a submitted prompt rewrites the prompt window; false continues from the last segment. */
  rewrite: boolean
  disabled?: boolean
  onChange: (rewrite: boolean) => void
  t: TranslateNS<'dreamverse.creation'>
}

/** Choose whether the next live prompt rewrites the prompt window or continues from the last segment. */
export default function LivePromptModePill({ rewrite, disabled = false, onChange, t }: LivePromptModePillProps) {
  const selected = LIVE_PROMPT_MODES.find(mode => mode.rewrite === rewrite) ?? LIVE_PROMPT_MODES[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ConfigPill disabled={disabled} aria-label={t('promptAction.label')}>
          <GitBranch className="size-3" />
          {t(selected.labelKey)}
          <ChevronDown className="size-2.5 opacity-60" />
        </ConfigPill>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>{t('promptAction.label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LIVE_PROMPT_MODES.map(mode => (
          <DropdownMenuItem key={mode.labelKey} onClick={() => { onChange(mode.rewrite) }} className="flex-col items-start gap-1 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              {t(mode.labelKey)}
              {mode.rewrite === rewrite && <Check className="size-3.5" aria-label={t('promptAction.selected')} />}
            </span>
            <span className="text-xs text-muted-foreground">{t(mode.descriptionKey)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
