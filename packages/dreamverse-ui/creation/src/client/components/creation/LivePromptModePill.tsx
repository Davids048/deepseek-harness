import { Check, ChevronDown, GitBranch } from 'lucide-react'

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
  { rewrite: true, label: 'Rewrite', description: 'Rewrite the prompt window and generate it again.' },
  { rewrite: false, label: 'Continue from the last segment', description: 'Generate the next segment from where the video ends.' },
] as const

interface LivePromptModePillProps {
  /** Whether a submitted prompt rewrites the prompt window; false continues from the last segment. */
  rewrite: boolean
  disabled?: boolean
  onChange: (rewrite: boolean) => void
}

/** Choose whether the next live prompt rewrites the prompt window or continues from the last segment. */
export default function LivePromptModePill({ rewrite, disabled = false, onChange }: LivePromptModePillProps) {
  const selected = LIVE_PROMPT_MODES.find(mode => mode.rewrite === rewrite) ?? LIVE_PROMPT_MODES[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ConfigPill disabled={disabled} aria-label="Prompt action">
          <GitBranch className="size-3" />
          {selected.label}
          <ChevronDown className="size-2.5 opacity-60" />
        </ConfigPill>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Prompt action</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LIVE_PROMPT_MODES.map(mode => (
          <DropdownMenuItem key={mode.label} onClick={() => { onChange(mode.rewrite) }} className="flex-col items-start gap-1 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              {mode.label}
              {mode.rewrite === rewrite && <Check className="size-3.5" aria-label="Selected" />}
            </span>
            <span className="text-xs text-muted-foreground">{mode.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
