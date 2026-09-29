/** @vitest-environment jsdom */
import '../../kit/tests/support/setup.client.ts'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ChatBar from '../src/client/components/ChatBar.tsx'
import { imageAsset } from '../../kit/tests/support/assetFixtures.client.ts'

it('uses the same ordered attachment picker for project rewrite controls', async () => {
  const submit = vi.fn()
  const change = vi.fn()
  const user = userEvent.setup()
  render(<ChatBar projectStarted continuationDraft="Walk toward the camera" canSubmitContinuation onSubmitContinuation={submit}
    referencePicker={{ references: [{ draftId: 'one', kind: 'savedAsset', asset: imageAsset() }], onReferencesChange: change, onOpenAssets: vi.fn(), accept: 'image/png', maxCount: 9, maxBytes: 15728640 }} />)
  await user.click(screen.getByRole('button', { name: 'Rewrite rollout' }))
  expect(submit).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('img', { name: 'subject.png' })).toBeVisible()
  expect(screen.queryByRole('dialog', { name: 'Reference image options' })).not.toBeInTheDocument()
  await user.click(screen.getByLabelText('Remove picture 1'))
  expect(change).toHaveBeenCalledWith([])
})

/** Opt-in edits a draft, while the server's round status controls when prompts become editable. */
it('shows opt-in before generation and only a stop action during automatic generation', async () => {
  const change = vi.fn()
  const stop = vi.fn()
  const user = userEvent.setup()
  const props = { projectStarted: true, canChooseAutoExtension: true, continuationDraft: 'Follow the river', canSubmitContinuation: true, onAutoExtensionRequestChange: change, onStopGeneration: stop }
  const { rerender } = render(<ChatBar {...props} />)
  const toggle = screen.getByRole('checkbox', { name: 'Auto extension' })
  expect(toggle).not.toBeChecked()
  await user.click(toggle)
  expect(change).toHaveBeenLastCalledWith(true)
  expect(toggle).not.toBeChecked()
  rerender(<ChatBar {...props} autoExtensionRequested />)
  expect(toggle).toBeChecked()
  expect(screen.getByRole('button', { name: 'Rewrite rollout' })).toBeEnabled()
  rerender(<ChatBar {...props} generationRoundBusy autoExtensionRequested autoExtensionEnabled />)
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
  expect(screen.getByText('Finishes the current round.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Stop generation' }))
  expect(stop).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('textbox', { name: 'Continuation prompt' })).toBeDisabled()
  rerender(<ChatBar {...props} generationRoundBusy />)
  expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument()
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Continuation prompt' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Rewrite rollout' })).toBeDisabled()
  rerender(<ChatBar {...props} />)
  expect(screen.getByRole('checkbox', { name: 'Auto extension' })).not.toBeChecked()
  expect(screen.getByRole('textbox', { name: 'Continuation prompt' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Rewrite rollout' })).toBeEnabled()
})

/** Lobby choices remain available before submission; disconnected and archived projects have no controls. */
it('offers opt-in in the lobby and hides it while busy, disconnected, or viewing archives', () => {
  const props = { canChooseAutoExtension: true, onAutoExtensionRequestChange: vi.fn() }
  const { rerender } = render(<ChatBar {...props} />)
  expect(screen.getByRole('checkbox', { name: 'Auto extension' })).toBeEnabled()
  rerender(<ChatBar {...props} projectStarted canChooseAutoExtension={false} />)
  expect(screen.getByRole('checkbox', { name: 'Auto extension' })).toBeDisabled()
  rerender(<ChatBar {...props} projectStarted generationRoundBusy />)
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
  rerender(<ChatBar {...props} projectStarted projectResetPending />)
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
  rerender(<ChatBar {...props} projectStarted connectionClosed />)
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
  rerender(<ChatBar {...props} projectStarted viewingReadOnly />)
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
})
