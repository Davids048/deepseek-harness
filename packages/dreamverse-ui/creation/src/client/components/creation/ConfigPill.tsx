import React from 'react'

import { cn } from '@dreamverse/ui-kit/utils.ts'

/** Forward the ref so Radix `asChild` triggers can anchor their content to the pill under React 18. */
const ConfigPill = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(function ConfigPill({
  children,
  className,
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'studio-control studio-control-press studio-hover-surface inline-flex h-9 min-h-9 shrink-0 items-center gap-1 rounded-full border border-border/50 bg-background/80 px-2.5 text-[11px] font-medium text-foreground/90',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
})

export default ConfigPill
