import { useState, useEffect } from 'react'
import { Button } from '@dreamverse/ui-kit/components/ui/button.tsx'
import { Checkbox } from '@dreamverse/ui-kit/components/ui/checkbox.tsx'
import { Label } from '@dreamverse/ui-kit/components/ui/label.tsx'

const STORAGE_KEY = 'fastvideo-suppress-leave-warning'

interface LeaveProjectModalProps {
  open?: boolean
  onClose?: () => void
  onConfirmLeave?: () => void
}

/** Confirm project departure and remember the browser's warning preference. */
export default function LeaveProjectModal({
  open = false,
  onClose = () => {},
  onConfirmLeave = () => {},
}: LeaveProjectModalProps) {
  const [suppress, setSuppress] = useState(false)

  useEffect(() => {
    if (open) setSuppress(false)
  }, [open])

  if (!open) return null

  function handleConfirm() {
    if (suppress) {
      try {
        localStorage.setItem(STORAGE_KEY, '1')
      } catch (_error) {
        // Without storage access the warning shows again on the next departure.
      }
    }
    onConfirmLeave()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4 backdrop-blur-[3px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-project-title"
        className="w-full max-w-md rounded-3xl border border-border/70 bg-card/95 p-6 shadow-2xl"
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <h2 id="leave-project-title" className="text-lg font-semibold text-foreground">
              Leave project?
            </h2>
            <p className="text-sm text-muted-foreground">
              This closes the project's connection. Starting another project requests a GPU again.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="suppress-leave-warning"
              checked={suppress}
              onCheckedChange={(v) => { setSuppress(v === true) }}
            />
            <Label htmlFor="suppress-leave-warning" className="text-sm text-muted-foreground cursor-pointer">
              Do not warn again
            </Label>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            Leave project
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Whether leaving asks for confirmation; unreadable storage keeps the warning on. */
export function shouldShowLeaveWarning(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '1'
  } catch {
    return true
  }
}
