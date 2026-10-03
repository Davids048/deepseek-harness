/** @vitest-environment jsdom */
import '../../kit/tests/support/setup.client.ts'
import { assetUploadPolicy, imageAsset } from '../../kit/tests/support/assetFixtures.client.ts'
import { useState, type ComponentProps } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { LobbyCreationCapabilities, LobbySelection } from '@dreamverse/project-controller/client/creationCapabilities.ts'
import CreationComposer from '../src/client/components/creation/CreationComposer.tsx'
import { en } from '../src/client/locales.ts'

type ComposerProps = ComponentProps<typeof CreationComposer>

const t = makeTranslate(en)

const supportedCapabilities: LobbyCreationCapabilities = {
  model_id: 'fast-h3',
  generation_modes: ['t2va', 'i2v'],
  aspect_ratios: ['16:9'],
  resolutions: ['720p'],
  min_segment_duration_sec: 5, max_segment_duration_sec: 15, segment_counts: [1, 2, 3, 4, 5, 6],
  unsupported_generation_modes: { fl2va: 'First/last frame generation is unsupported.' },
  reference_inputs: { media_types: ['image'], max_count: 1, conditioning: 'first_frame' },
  asset_upload: assetUploadPolicy,
}
const supportedSelection: LobbySelection = {
  modeId: 't2v', aspectRatio: '16:9', resolution: '720p', segmentDurationSec: 5, segmentCount: 6,
}

/** Keep draft edits in React state while testing the real composer and its callbacks. */
function ComposerWithDraft(props: Partial<ComposerProps>) {
  const [value, setValue] = useState(props.value ?? 'A river')
  const [selection, setSelection] = useState(props.selection ?? supportedSelection)
  return <CreationComposer
    t={t}
    canSubmit
    capabilities={supportedCapabilities}
    capabilityNotice={null}
    onSubmit={() => {}}
    {...props}
    value={value}
    onValueChange={setValue}
    selection={selection}
    onSelectionChange={(changes) => {
      setSelection(current => ({ ...current, ...changes }))
      props.onSelectionChange?.(changes)
    }}
  />
}

function renderComposer(props: Partial<ComposerProps> = {}) {
  const onSubmit = vi.fn()
  render(<ComposerWithDraft {...props} onSubmit={onSubmit} />)
  const prompt = screen.getByRole('textbox', { name: 'Initial prompt' })
  if (!(prompt instanceof HTMLTextAreaElement)) throw new Error('Expected the initial prompt to be a textarea')
  return {
    onSubmit,
    prompt,
    generate: screen.getByRole('button', { name: 'Generate' }),
  }
}

describe('CreationComposer submission', () => {
  it.each(['Enter', 'Generate'])('submits a valid prompt once through %s', async (action) => {
    const user = userEvent.setup()
    const { onSubmit, prompt, generate } = renderComposer()
    if (action === 'Enter') {
      await user.click(prompt)
      await user.keyboard('{Enter}')
    } else {
      await user.click(generate)
    }
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveValue('A river')
  })

  it.each([
    { reason: 'creation is not permitted', props: { canSubmit: false } },
    { reason: 'the composer is disabled', props: { disabled: true } },
    { reason: 'generation is in progress', props: { isGenerating: true } },
    { reason: 'the prompt is empty', props: { value: '' } },
    { reason: 'the prompt is whitespace', props: { value: ' \n ' } },
    {
      reason: 'a required reference is missing',
      props: { selection: { ...supportedSelection, modeId: 'i2v' }, referencePicker: undefined },
    },
  ] satisfies Array<{ reason: string; props: Partial<ComposerProps> }>)(
    'blocks both actions when $reason',
    async ({ props }) => {
      const user = userEvent.setup()
      const { onSubmit, prompt, generate } = renderComposer(props)
      expect(generate).toBeDisabled()
      await user.click(generate)
      fireEvent.keyDown(prompt, { key: 'Enter', code: 'Enter' })
      expect(onSubmit).not.toHaveBeenCalled()
    },
  )

  /** Each submit producer accepts a prompt once its required reference is present. */
  it.each(['Enter', 'Generate'])('allows %s with a required reference present', async (action) => {
    const user = userEvent.setup()
    const { onSubmit, prompt, generate } = renderComposer({
      selection: { ...supportedSelection, modeId: 'i2v' },
      referencePicker: { references: [{ draftId: 'one', kind: 'savedAsset', asset: imageAsset() }], onReferencesChange: vi.fn(), onOpenAssets: vi.fn(), accept: 'image/png', maxCount: 1, maxBytes: 15728640 },
    })
    expect(generate).toBeEnabled()
    if (action === 'Enter') {
      await user.click(prompt)
      await user.keyboard('{Enter}')
    } else {
      await user.click(generate)
    }
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('keeps Shift+Enter as a newline', async () => {
    const user = userEvent.setup()
    const { onSubmit, prompt } = renderComposer()
    await user.click(prompt)
    prompt.setSelectionRange(prompt.value.length, prompt.value.length)
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(prompt).toHaveValue('A river\n')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves native composition when the mention menu is open: %s', async (withMention) => {
    const user = userEvent.setup()
    const { onSubmit, prompt } = renderComposer({
      value: '', mentionOptions: [{ id: 'river', label: 'River', kind: 'preset' }],
    })
    const draft = withMention ? '@Ri' : 'A river'
    await user.type(prompt, draft)
    if (withMention) expect(screen.getByText('Mention')).toBeInTheDocument()
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true,
    })
    fireEvent(prompt, composing)
    expect(composing.defaultPrevented).toBe(false)
    expect(prompt).toHaveValue(draft)
    expect(onSubmit).not.toHaveBeenCalled()
    if (withMention) expect(screen.getByText('Mention')).toBeInTheDocument()
  })

  it.each(['Enter', 'Tab'])('selects a matching mention with %s before submission', async (key) => {
    const user = userEvent.setup()
    const { onSubmit, prompt } = renderComposer({
      value: '', mentionOptions: [{ id: 'river', label: 'River', kind: 'preset' }],
    })
    await user.type(prompt, '@Ri')
    expect(screen.getByText('Mention')).toBeInTheDocument()
    await user.keyboard(`{${key}}`)
    expect(prompt).toHaveValue('@River ')
    expect(screen.queryByText('Mention')).not.toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('dismisses mentions with Escape and retains the draft', async () => {
    const user = userEvent.setup()
    const { onSubmit, prompt } = renderComposer({
      value: '', mentionOptions: [{ id: 'river', label: 'River', kind: 'preset' }],
    })
    await user.type(prompt, '@Ri')
    expect(screen.getByText('Mention')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(prompt).toHaveValue('@Ri')
    expect(screen.queryByText('Mention')).not.toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits Enter when no mention matches the query', async () => {
    const user = userEvent.setup()
    const { onSubmit, prompt } = renderComposer({
      value: '', mentionOptions: [{ id: 'river', label: 'River', kind: 'preset' }],
    })
    await user.type(prompt, '@Desert')
    expect(screen.queryByText('Mention')).not.toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveValue('@Desert')
  })

  /** Capability availability blocks both submit producers while preserving draft and reference editing. */
  it.each([
    'Loading model capabilities…',
    'Model capabilities are unavailable. Reload the page after the backend is available.',
  ])('keeps drafts editable while displaying %s', async (notice) => {
    const user = userEvent.setup()
    const { onSubmit, prompt, generate } = renderComposer({
      capabilities: null, capabilityNotice: notice,
    })
    expect(screen.getByText(notice)).toBeVisible()
    expect(prompt).toBeEnabled()
    expect(screen.queryByText('FastH3')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Text to video' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '16:9 720P' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Duration per segment: 5s' })).not.toBeInTheDocument()
    await user.type(prompt, ' in rain')
    expect(prompt).toHaveValue('A river in rain')
    expect(generate).toBeDisabled()
    await user.click(generate)
    await user.click(prompt)
    await user.keyboard('{Enter}')
    expect(prompt).toHaveValue('A river in rain')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  /** A model label supplies information while its advertised geometry supplies the editable choices. */
  it('shows only the served model and its geometry without a model selector', async () => {
    const user = userEvent.setup()
    renderComposer()
    expect(screen.getByText('FastH3')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'FastH3' })).not.toBeInTheDocument()
    expect(screen.queryByText('FastLTX 2.3')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '16:9 720P' }))
    expect(screen.getByRole('button', { name: '16:9' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '720P' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '9:16' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '480P' })).not.toBeInTheDocument()
  })

  /** H3 length and count remain independent, and duration cannot exceed the advertised maximum. */
  it('edits segment count and announces the derived duration', async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn<ComposerProps['onSelectionChange']>()
    renderComposer({ onSelectionChange })
    expect(screen.getByRole('status')).toHaveTextContent('6 segments × 5s = 30s total')
    expect(screen.getByText('5s per segment')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Duration per segment: 5s' }))
    const slider = screen.getByRole('slider', { name: 'Duration per segment' })
    expect(slider).toHaveAttribute('aria-valuemin', '5')
    expect(slider).toHaveAttribute('aria-valuemax', '15')
    slider.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{Escape}')
    expect(screen.getByRole('status')).toHaveTextContent('6 segments × 7s = 42s total')
    screen.getByRole('button', { name: 'Segments: 6' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getAllByRole('menuitem').map(choice => choice.textContent)).toEqual([
      '1 segment', '2 segments', '3 segments', '4 segments', '5 segments', '6 segments',
    ])
    await user.click(screen.getByRole('menuitem', { name: '3 segments' }))
    expect(screen.getByRole('status')).toHaveTextContent('3 segments × 7s = 21s total')
    await user.click(screen.getByRole('button', { name: 'Duration per segment: 7s' }))
    screen.getByRole('slider', { name: 'Duration per segment' }).focus()
    await user.keyboard('{End}{ArrowRight}{Escape}')
    expect(screen.getByRole('status')).toHaveTextContent('3 segments × 15s = 45s total')
    expect(onSelectionChange.mock.calls.map(([changes]) => changes)).toEqual([
      { segmentDurationSec: 6 }, { segmentDurationSec: 7 }, { segmentCount: 3 }, { segmentDurationSec: 15 },
    ])
  })

  /** Duration uses whole-second steps through the model maximum without changing sibling preferences. */
  it('selects a seven-second segment and stops at the model maximum', async () => {
    const user = userEvent.setup()
    const onSelectionChange = vi.fn<ComposerProps['onSelectionChange']>()
    renderComposer({
      capabilities: {
        ...supportedCapabilities, model_id: 'fast-ltx23', aspect_ratios: ['16:9', '9:16'],
        resolutions: ['720p', '480p'], min_segment_duration_sec: 1, max_segment_duration_sec: 20, segment_counts: [1, 2, 3, 4, 5, 6],
      },
      onSelectionChange,
    })
    screen.getByRole('button', { name: 'Text to video' }).focus()
    await user.keyboard('{Enter}')
    await user.click(screen.getByRole('menuitem', { name: /Image to video/ }))
    expect(screen.getByRole('button', { name: '16:9 720P' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Duration per segment: 5s' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '16:9 720P' }))
    await user.click(screen.getByRole('button', { name: '9:16' }))
    expect(screen.getByRole('button', { name: '9:16 720P' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '480P' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Duration per segment: 5s' }))
    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('aria-valuetext', '5 seconds')
    slider.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(slider).toHaveAttribute('aria-valuenow', '7')
    expect(slider).toHaveAttribute('aria-valuemin', '1')
    expect(slider).toHaveAttribute('aria-valuemax', '20')
    expect(slider).toHaveAttribute('aria-valuetext', '7 seconds')
    expect(screen.getByRole('button', { name: 'Duration per segment: 7s' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('6 segments × 7s = 42s total')
    await user.keyboard('{End}{ArrowRight}')
    expect(slider).toHaveAttribute('aria-valuenow', '20')
    expect(screen.getByRole('button', { name: 'Duration per segment: 20s' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('6 segments × 20s = 120s total')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Image to video' })).toBeVisible()
    expect(screen.getByRole('button', { name: '9:16 480P' })).toBeVisible()
    expect(onSelectionChange.mock.calls.map(([changes]) => changes)).toEqual([
      { modeId: 'i2v' }, { aspectRatio: '9:16' }, { resolution: '480p' },
      { segmentDurationSec: 6 }, { segmentDurationSec: 7 }, { segmentDurationSec: 20 },
    ])
  })
})
