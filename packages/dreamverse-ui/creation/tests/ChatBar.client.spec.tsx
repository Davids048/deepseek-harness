/** @vitest-environment jsdom */
import '../../kit/tests/support/setup.client.ts'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import ChatBar from '../src/client/components/ChatBar.tsx'
import { en } from '../src/client/locales.ts'
import { imageAsset } from '../../kit/tests/support/assetFixtures.client.ts'

const t = makeTranslate(en)

it('uses the same ordered attachment picker for project rewrite controls', async () => {
  const submit = vi.fn()
  const change = vi.fn()
  const user = userEvent.setup()
  render(<ChatBar t={t} projectStarted continuationDraft="Walk toward the camera" canSubmitContinuation onSubmitContinuation={submit}
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
  const { rerender } = render(<ChatBar t={t} {...props} />)
  const toggle = screen.getByRole('checkbox', { name: 'Auto extension' })
  expect(toggle).not.toBeChecked()
  await user.click(toggle)
  expect(change).toHaveBeenLastCalledWith(true)
  expect(toggle).not.toBeChecked()
  rerender(<ChatBar t={t} {...props} autoExtensionRequested />)
  expect(toggle).toBeChecked()
  expect(screen.getByRole('button', { name: 'Rewrite rollout' })).toBeEnabled()
  rerender(<ChatBar t={t} {...props} generationRoundBusy autoExtensionRequested autoExtensionEnabled />)
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
  expect(screen.getByText('Finishes the current round.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Stop generation' }))
  expect(stop).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('textbox', { name: 'Continuation prompt' })).toBeDisabled()
  rerender(<ChatBar t={t} {...props} generationRoundBusy />)
  expect(screen.queryByRole('button', { name: 'Stop generation' })).not.toBeInTheDocument()
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Continuation prompt' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Rewrite rollout' })).toBeDisabled()
  rerender(<ChatBar t={t} {...props} />)
  expect(screen.getByRole('checkbox', { name: 'Auto extension' })).not.toBeChecked()
  expect(screen.getByRole('textbox', { name: 'Continuation prompt' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Rewrite rollout' })).toBeEnabled()
})

/** Lobby choices remain available before submission; disconnected projects have no controls. */
it('offers opt-in in the lobby and hides it while busy or disconnected', () => {
  const props = { canChooseAutoExtension: true, onAutoExtensionRequestChange: vi.fn() }
  const { rerender } = render(<ChatBar t={t} {...props} />)
  expect(screen.getByRole('checkbox', { name: 'Auto extension' })).toBeEnabled()
  rerender(<ChatBar t={t} {...props} projectStarted canChooseAutoExtension={false} />)
  expect(screen.getByRole('checkbox', { name: 'Auto extension' })).toBeDisabled()
  rerender(<ChatBar t={t} {...props} projectStarted generationRoundBusy />)
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
  rerender(<ChatBar t={t} {...props} projectStarted projectResetPending />)
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
  rerender(<ChatBar t={t} {...props} projectStarted connectionClosed />)
  expect(screen.queryByRole('checkbox', { name: 'Auto extension' })).not.toBeInTheDocument()
})

/** A disconnected project offers Reconnect only when the owner can reopen it, beside New Project. */
it('offers Reconnect for a disconnected project that the owner can reopen', async () => {
  const reconnect = vi.fn()
  const startNew = vi.fn()
  const user = userEvent.setup()
  const props = { projectStarted: true, connectionClosed: true, onStartNewProject: startNew }
  const { rerender } = render(<ChatBar t={t} {...props} />)
  expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument()
  rerender(<ChatBar t={t} {...props} onReconnect={reconnect} projectNotice="This project was opened in another window." />)
  expect(screen.getByText('This project was opened in another window.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Reconnect' }))
  expect(reconnect).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: 'New Project' }))
  expect(startNew).toHaveBeenCalledTimes(1)
})

/** The prompt action selection appears only when the owner can change it, and it reports the chosen action. */
it('selects whether a live prompt rewrites the prompt window or continues from the last segment', async () => {
  const change = vi.fn()
  const user = userEvent.setup()
  const props = { projectStarted: true, continuationDraft: 'Follow the river', canSubmitContinuation: true }
  const { rerender } = render(<ChatBar t={t} {...props} />)
  expect(screen.queryByRole('button', { name: 'Prompt action' })).not.toBeInTheDocument()
  rerender(<ChatBar t={t} {...props} onRewriteModeChange={change} />)
  expect(screen.getByRole('button', { name: 'Prompt action' })).toHaveTextContent('Rewrite')
  expect(screen.getByRole('button', { name: 'Rewrite rollout' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Prompt action' }))
  await user.click(await screen.findByRole('menuitem', { name: /Continue from the last segment/ }))
  expect(change).toHaveBeenLastCalledWith(false)
  rerender(<ChatBar t={t} {...props} rewriteMode={false} onRewriteModeChange={change} />)
  expect(screen.getByRole('button', { name: 'Prompt action' })).toHaveTextContent('Continue from the last segment')
  expect(screen.getByRole('button', { name: 'Continue video' })).toBeEnabled()
})
