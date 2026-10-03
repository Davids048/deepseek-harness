/** The `root` slot occupant: the DreamVerse page and the toast container of the FastVideo root layout. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { Toaster } from './components/ui/sonner.tsx'
import { DreamverseApp } from './app/DreamverseApp.tsx'
import type { DreamverseSlot, DreamverseSlotRenderer } from './contracts.ts'
import type {} from './locales.ts'

/**
 * Render the DreamVerse page with the renderer's child slot function and the page frame's translate seat.
 * @param props - the renderer-provided child slot share and `dreamverse.kit` translate function.
 */
export function DreamverseRoot({ renderSlot, t }: PropsRenderSlots<DreamverseSlot> & PropsLocale<'dreamverse.kit'>) {
  // The DSH share types each slot's owner through SlotMap; the contracts declare the same owners per slot, which
  // TypeScript cannot correlate across the generic slot name.
  const render = renderSlot as (name: DreamverseSlot, owner: object) => ReactNode
  const renderDreamverseSlot: DreamverseSlotRenderer = (name, owner) => render(name, owner)
  return (
    <>
      <DreamverseApp renderSlot={renderDreamverseSlot} t={t} />
      <Toaster />
    </>
  )
}
