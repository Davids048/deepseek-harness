// @vitest-environment jsdom
// Two composer hosts showing one session editor: the editor's root follows the newest host, returns to the remaining
// host when the newest unmounts, and moves to whichever host the user focuses.
import { describe, expect, it } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { createEditor } from 'lexical'
import { ComposerContentEditable } from '../src/client/input/editor/ComposerContentEditable.tsx'

describe('ComposerContentEditable root claims', () => {
  it('hands the shared editor back to the remaining host when another host unmounts', () => {
    const editor = createEditor({ namespace: 'claims', onError: (error) => { throw error } })
    const first = render(<ComposerContentEditable editor={editor} editable data-testid="first" />)
    const firstEl = first.getByTestId('first')
    expect(editor.getRootElement()).toBe(firstEl)
    const second = render(<ComposerContentEditable editor={editor} editable data-testid="second" />)
    expect(editor.getRootElement()).toBe(second.getByTestId('second'))
    act(() => { second.unmount() })
    expect(editor.getRootElement()).toBe(firstEl)
    act(() => { first.unmount() })
    expect(editor.getRootElement()).toBeNull()
  })

  it('moves the editor to the host the user focuses while both are mounted', () => {
    const editor = createEditor({ namespace: 'claims-focus', onError: (error) => { throw error } })
    const first = render(<ComposerContentEditable editor={editor} editable data-testid="first" />)
    const second = render(<ComposerContentEditable editor={editor} editable data-testid="second" />)
    fireEvent.pointerDown(first.getByTestId('first'))
    expect(editor.getRootElement()).toBe(first.getByTestId('first'))
    fireEvent.focus(second.getByTestId('second'))
    expect(editor.getRootElement()).toBe(second.getByTestId('second'))
    act(() => { first.unmount(); second.unmount() })
  })
})
