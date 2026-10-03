/** @vitest-environment jsdom */
import '../../kit/tests/support/setup.client.ts'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import ReferencePicker from '../src/client/components/assets/ReferencePicker.tsx'
import { en } from '../src/client/locales.ts'
import type { ReferenceDraft } from '@dreamverse/assets-manager/client/assets.ts'
import { imageAsset, mockReferenceImageLayout } from '../../kit/tests/support/assetFixtures.client.ts'

const t = makeTranslate(en)

function Picker() {
  const [references, setReferences] = useState<ReferenceDraft[]>([])
  return <ReferencePicker t={t} references={references} onReferencesChange={setReferences} onOpenAssets={() => {}} accept="image/png,image/jpeg,image/webp" maxCount={3} maxBytes={15728640} />
}

describe('reference drafts', () => {
  it.each(['localFile', 'savedAsset'] as const)('previews a %s by click or Enter and restores focus without uploading', async (kind) => {
    const reference: ReferenceDraft = kind === 'localFile'
      ? { draftId: 'reference', kind, file: new File(['png'], 'subject.png', { type: 'image/png' }) }
      : { draftId: 'reference', kind, asset: imageAsset() }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const changeReferences = vi.fn()
    const user = userEvent.setup()
    render(<ReferencePicker t={t} references={[reference]} onReferencesChange={changeReferences} onOpenAssets={() => {}} accept="image/png" maxCount={3} maxBytes={15728640} />)
    const thumbnail = screen.getByRole('button', { name: 'Preview picture 1: subject.png' })
    await user.click(thumbnail)
    const dialog = screen.getByRole('dialog', { name: 'subject.png' })
    expect(within(dialog).getByRole('img', { name: 'subject.png' })).toHaveAttribute('src',
      kind === 'savedAsset' ? imageAsset().content_url : 'blob:mock-url')
    const close = within(dialog).getByRole('button', { name: 'Close preview' })
    expect(close).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(thumbnail).toHaveFocus())
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: 'subject.png' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close preview' }))
    await waitFor(() => expect(thumbnail).toHaveFocus())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(changeReferences).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('opens image upload and asset selection from the compact button', async () => {
    const openAssets = vi.fn()
    const user = userEvent.setup()
    render(<ReferencePicker t={t} references={[]} onReferencesChange={vi.fn()} onOpenAssets={openAssets} accept="image/png" maxCount={3} maxBytes={15728640} />)
    expect(screen.queryByRole('button', { name: 'Add image' })).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Add reference' })
    await user.click(trigger)
    const inputClick = vi.spyOn(screen.getByLabelText('Add reference images'), 'click')
    await user.click(screen.getByRole('button', { name: 'Add image' }))
    expect(inputClick).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'From assets' }))
    expect(openAssets).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Reference image options' })).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens from the keyboard and returns focus after Escape', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    const trigger = screen.getByRole('button', { name: 'Add reference' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: 'Reference image options' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Reference image options' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('stages, reorders, removes, and reselects images without uploading', async () => {
    mockReferenceImageLayout()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const user = userEvent.setup()
    render(<Picker />)
    const files = ['front.png', 'side.png'].map(name => new File(['png'], name, { type: 'image/png' }))
    await user.upload(screen.getByLabelText('Add reference images'), files)
    expect(screen.queryByRole('dialog', { name: 'Reference image options' })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'front.png' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'side.png' })).toBeVisible()
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('front.png')
    await user.click(screen.getByRole('button', { name: 'Preview picture 2: side.png' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview picture 2: side.png' })).toHaveFocus())
    screen.getByRole('button', { name: 'Preview picture 2: side.png' }).focus()
    await user.keyboard('[Space]')
    await user.keyboard('[ArrowLeft]')
    await user.keyboard('[Escape]')
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('front.png')
    screen.getByRole('button', { name: 'Preview picture 2: side.png' }).focus()
    await user.keyboard('[Space]')
    await user.keyboard('[ArrowLeft]')
    await user.keyboard('[Space]')
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('side.png')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Remove picture 1'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.drop(screen.getByLabelText('Reference images'), { dataTransfer: { files: [files[1]] } })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects videos and excess pictures before changing the draft', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<Picker />)
    await user.upload(screen.getByLabelText('Add reference images'), new File(['mp4'], 'clip.mp4', { type: 'video/mp4' }))
    expect(screen.getByRole('alert')).toHaveTextContent('supported images')
    fireEvent.drop(screen.getByLabelText('Reference images'), { dataTransfer: { files: Array.from({ length: 4 }, (_, i) => new File(['png'], `${i}.png`, { type: 'image/png' })) } })
    expect(screen.getByRole('alert')).toHaveTextContent('at most 3')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })
})
