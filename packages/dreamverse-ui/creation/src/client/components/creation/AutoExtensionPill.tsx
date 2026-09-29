import { Checkbox } from '@dreamverse/ui-kit/components/ui/checkbox.tsx'
import { Label } from '@dreamverse/ui-kit/components/ui/label.tsx'
import { cn } from '@dreamverse/ui-kit/utils.ts'

const AUTO_EXTENSION_HELP = 'After this sequence, keep adding segments until you stop.'

interface AutoExtensionPillProps {
  requested: boolean
  disabled?: boolean
  onChange?: ((enabled: boolean) => void) | undefined
  className?: string
}

/** Toggle auto_extension rounds in line with the other creation knobs. */
export default function AutoExtensionPill({ requested, disabled = false, onChange, className }: AutoExtensionPillProps) {
  const interactive = Boolean(onChange) && !disabled

  return (
    <div
      title={AUTO_EXTENSION_HELP}
      className={cn(
        'studio-control studio-hover-surface inline-flex h-9 min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-border/50 bg-background/80 px-2.5 text-[11px] font-medium text-foreground/90',
        !interactive && 'opacity-70',
        className,
      )}
    >
      <Checkbox
        id="auto-extension"
        checked={requested}
        disabled={!interactive}
        onCheckedChange={checked => onChange?.(checked === true)}
      />
      <Label htmlFor="auto-extension" className={cn('text-[11px] font-medium', interactive && 'cursor-pointer')}>
        Auto extension
      </Label>
    </div>
  )
}
