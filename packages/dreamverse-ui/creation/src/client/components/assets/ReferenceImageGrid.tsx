import { useState } from 'react'
import { createPortal } from 'react-dom'
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { X } from 'lucide-react'
import AssetPreview from '@dreamverse/ui-kit/components/assets/AssetPreview.tsx'
import type { ReferenceDraft } from '@dreamverse/assets-manager/client/assets.ts'

interface Props {
  references: ReferenceDraft[]
  onReferencesChange: (references: ReferenceDraft[]) => void
  onPreview: (referenceId: string) => void
}

/** Reorder request-local references by dragging thumbnails; commit their order only on drop. */
export default function ReferenceImageGrid({ references, onReferencesChange, onPreview }: Props) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const draggedReference = references.find(reference => reference.draftId === draggedId)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] },
    }),
  )
  function finishReorder({ active, over }: DragEndEvent) {
    setDraggedId(null)
    if (!over || active.id === over.id) return
    const fromIndex = references.findIndex(reference => reference.draftId === active.id)
    const toIndex = references.findIndex(reference => reference.draftId === over.id)
    if (fromIndex < 0 || toIndex < 0) return
    onReferencesChange(arrayMove(references, fromIndex, toIndex))
  }
  return (
    <DndContext sensors={sensors}
      collisionDetection={args => args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)}
      onDragStart={({ active }) => { setDraggedId(String(active.id)) }}
      onDragCancel={() => { setDraggedId(null) }} onDragEnd={finishReorder}
      accessibility={{ screenReaderInstructions: {
        draggable: 'Press Enter to preview. Press Space to pick up a reference, arrow keys to move it, Space to drop, or Escape to cancel.',
      }, announcements: {
        onDragStart: ({ active }) => `Picked up ${active.data.current?.name}.`,
        onDragOver: ({ over }) => over ? `Drop at picture ${over.data.current?.position}.` : 'Outside the reference images. Drop to cancel.',
        onDragEnd: ({ active, over }) => over ? `${active.data.current?.name} is picture ${over.data.current?.position}.` : 'Reordering cancelled.',
        onDragCancel: () => 'Reordering cancelled.',
      } }}>
      <SortableContext items={references.map(reference => reference.draftId)} strategy={rectSortingStrategy}>
        <ol aria-label="Selected reference images" className="flex min-w-0 flex-wrap gap-2">
          {references.map((reference, index) => (
            <SortableReferenceImage key={reference.draftId} reference={reference} index={index}
              onPreview={() => { onPreview(reference.draftId) }}
              onRemove={() => { onReferencesChange(references.filter(entry => entry.draftId !== reference.draftId)) }} />
          ))}
        </ol>
      </SortableContext>
      {typeof document !== 'undefined' && createPortal(
        <DragOverlay dropAnimation={null} zIndex={70}>
          {draggedReference && <div aria-hidden="true" className="size-16 overflow-hidden rounded-lg bg-popover shadow-xl ring-2 ring-primary [&_img]:h-16 [&_img]:object-cover">
            <AssetPreview source={draggedReference.kind === 'localFile' ? draggedReference.file : draggedReference.asset} />
          </div>}
        </DragOverlay>, document.body,
      )}
    </DndContext>
  )
}

/** Open a preview on click or Enter; use dragging or Space and arrow keys to reorder. */
function SortableReferenceImage({ reference, index, onRemove, onPreview }: {
  reference: ReferenceDraft
  index: number
  onRemove: () => void
  onPreview: () => void
}) {
  const source = reference.kind === 'localFile' ? reference.file : reference.asset
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: reference.draftId, data: { name: source.name, position: index + 1 },
  })
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0 : 1 }}
      className="relative size-16 shrink-0 rounded-lg border border-border bg-muted" title={source.name}>
      <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} aria-label={`Preview picture ${index + 1}: ${source.name}`}
        onClick={(event) => { event.currentTarget.focus(); onPreview() }}
        onDragStart={(event) => { event.preventDefault() }}
        className={`block size-full touch-none select-none overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_img]:h-full [&_img]:object-cover ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}>
        <AssetPreview source={source} />
      </button>
      <span aria-hidden="true" className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/65 px-1 text-[10px] font-medium text-white">{index + 1}</span>
      <p className="sr-only">{source.name}</p>
      <button type="button" className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-sm hover:bg-muted" aria-label={`Remove picture ${index + 1}`} onClick={onRemove}>
        <X className="size-3" aria-hidden="true" />
      </button>
    </li>
  )
}
