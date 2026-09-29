/** The `root` slot occupant: the DreamVerse page and the toast container of the FastVideo root layout. */
import type { ReactNode } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { Toaster } from './components/ui/sonner.tsx'
import { DreamverseApp } from './app/DreamverseApp.tsx'
import type { DreamverseSlot, DreamverseSlotRenderer } from './contracts.ts'

/**
 * Render the DreamVerse page with the renderer's child slot function.
 * @param props - the renderer-provided child slot share.
 */
export function DreamverseRoot({ renderSlot }: PropsRenderSlots<DreamverseSlot>) {
  // The DSH share types each slot's owner through SlotMap; the contracts declare the same owners per slot, which
  // TypeScript cannot correlate across the generic slot name.
  const render = renderSlot as (name: DreamverseSlot, owner: object) => ReactNode
  const renderDreamverseSlot: DreamverseSlotRenderer = (name, owner) => render(name, owner)
  return (
    <>
      <DreamverseApp renderSlot={renderDreamverseSlot} />
      <Toaster />
    </>
  )
}
