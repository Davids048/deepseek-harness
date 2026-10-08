// @vitest-environment jsdom
/** The delegate's element renderer: parsed data, replacement, default fallback, and the streaming gate. */
import { cleanup, render } from '@testing-library/react'
import type * as Md from 'mdast'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider, type MarkdownElement, type MarkdownElementRenderer } from '../src/index.ts'
import { createReferenceTargets, renderBlocks } from '../src/markdown/render.tsx'
import { markdownLabels } from './labels.client.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

/** Render settled or streaming Markdown under a provider whose element renderer is `renderElement`. */
function renderWith(text: string, renderElement: MarkdownElementRenderer, streaming = false) {
  return render(
    <MarkdownDelegateProvider renderElement={renderElement}>
      <MarkdownText text={text} streaming={streaming} />
    </MarkdownDelegateProvider>,
  )
}

/** Record every offered element and keep the default rendering. */
function recorder() {
  const offered: MarkdownElement[] = []
  const renderElement = vi.fn<MarkdownElementRenderer>((element, fallback) => {
    offered.push(element)
    return fallback
  })
  return { offered, renderElement }
}

describe('Markdown element renderer', () => {
  it('offers settled links with the authored destination, title, and label text', () => {
    const { offered, renderElement } = recorder()
    renderWith('[**Play** it](/dv/assets/a1 "Shot 1") and [ref]\n\n[ref]: https://example.com/x "Ref"', renderElement)
    expect(offered).toEqual([
      { kind: 'link', href: '/dv/assets/a1', title: 'Shot 1', text: 'Play it' },
      { kind: 'link', href: 'https://example.com/x', title: 'Ref', text: 'ref' },
    ])
  })

  it('collapses label text from raw HTML, math, breaks, and footnote references', () => {
    const { offered, renderElement } = recorder()
    renderWith('[a <i>b</i> $x$\\\nc[^n]](https://example.com)\n\n[^n]: Note', renderElement)
    expect(offered).toEqual([{ kind: 'link', href: 'https://example.com', title: undefined, text: 'a <i>b</i> x c' }])
  })

  it('offers images outside links but keeps images inside a link label', () => {
    const { offered, renderElement } = recorder()
    renderWith('![Still](https://example.com/s.png "Title") [![badge](https://example.com/b.png)](https://example.com)', renderElement)
    expect(offered).toEqual([
      { kind: 'image', src: 'https://example.com/s.png', alt: 'Still', title: 'Title' },
      { kind: 'link', href: 'https://example.com', title: undefined, text: 'badge' },
    ])
  })

  it('offers tables with header and body cells and the links of each cell', () => {
    const { offered, renderElement } = recorder()
    renderWith([
      '| Shot | Content | Video |',
      '| --- | --- | --- |',
      '| 1 | Opening `line` | **[Play](/dv/assets/v1)** |',
      '| 2 | Close-up | [Play][v2] |',
      '',
      '[v2]: /dv/assets/v2',
    ].join('\n'), renderElement)
    const table = offered.find(element => element.kind === 'table')
    expect(table).toEqual({
      kind: 'table',
      header: [
        { text: 'Shot', links: [] },
        { text: 'Content', links: [] },
        { text: 'Video', links: [] },
      ],
      rows: [
        [
          { text: '1', links: [] },
          { text: 'Opening line', links: [] },
          { text: 'Play', links: [{ href: '/dv/assets/v1', text: 'Play' }] },
        ],
        [
          { text: '2', links: [] },
          { text: 'Close-up', links: [] },
          { text: 'Play', links: [{ href: '/dv/assets/v2', text: 'Play' }] },
        ],
      ],
    })
  })

  it('renders the replacement in place of the element', () => {
    const renderElement: MarkdownElementRenderer = (element, fallback): ReactNode => element.kind === 'table'
      ? <div data-testid="grid">{element.rows.length} rows</div>
      : fallback
    const view = renderWith('Before\n\n| A |\n| - |\n| 1 |\n| 2 |\n\nAfter', renderElement)
    expect(view.getByTestId('grid').textContent).toBe('2 rows')
    expect(view.container.querySelector('table')).toBeNull()
    expect(view.container.textContent).toContain('Before')
    expect(view.container.textContent).toContain('After')
  })

  it('keeps the default DOM when the renderer returns the fallback', () => {
    const text = '[site](https://example.com) ![pic](https://example.com/p.png)\n\n| A | B |\n| - | - |\n| [x](https://e.com) | 2 |'
    const plain = render(<MarkdownText text={text} />).container.innerHTML
    cleanup()
    const { renderElement } = recorder()
    expect(renderWith(text, renderElement).container.innerHTML).toBe(plain)
  })

  it('keeps a streamed image mounted when the message settles', () => {
    const { renderElement } = recorder()
    const text = '![pic](https://example.com/p.png)\n\n| A |\n| - |\n| 1 |'
    const view = render(
      <MarkdownDelegateProvider renderElement={renderElement}>
        <MarkdownText text={text} streaming />
      </MarkdownDelegateProvider>,
    )
    const streamed = view.container.querySelector('img')
    view.rerender(
      <MarkdownDelegateProvider renderElement={renderElement}>
        <MarkdownText text={text} />
      </MarkdownDelegateProvider>,
    )
    expect(view.container.querySelector('img')).toBe(streamed)
    expect(renderElement).toHaveBeenCalled()
  })

  it('never offers elements of a streaming render', () => {
    const { renderElement } = recorder()
    const view = renderWith('[site](https://example.com) ![pic](https://example.com/p.png)\n\n| A |\n| - |\n| 1 |', renderElement, true)
    expect(view.container.querySelector('a')).not.toBeNull()
    expect(renderElement).not.toHaveBeenCalled()
  })

  it('reads hand-built trees with unresolved references and null alt text', () => {
    // The grammar never emits either; the renderer still accepts them from hand-built trees.
    const { offered, renderElement } = recorder()
    const cell = (children: Md.PhrasingContent[]): Md.TableCell => ({ type: 'tableCell', children })
    const table: Md.Table = {
      type: 'table',
      children: [
        { type: 'tableRow', children: [cell([{ type: 'text', value: 'A' }])] },
        { type: 'tableRow', children: [cell([
          { type: 'linkReference', identifier: 'missing', referenceType: 'shortcut', children: [{ type: 'text', value: 'x' }] },
          { type: 'link', url: 'https://example.com', children: [{ type: 'image', url: 'https://example.com/i.png', alt: null }] },
        ])] },
      ],
    }
    render(
      <MarkdownDelegateProvider renderElement={renderElement}>
        {renderBlocks([{ node: table, key: 0 }], {
          streaming: false, labels: markdownLabels, fileMentions: undefined, pathImages: undefined,
          targets: createReferenceTargets(), footnoteOrder: [], footnoteCounts: new Map(),
        })}
      </MarkdownDelegateProvider>,
    )
    expect(offered.find(element => element.kind === 'table')).toEqual({
      kind: 'table',
      header: [{ text: 'A', links: [] }],
      rows: [[{ text: 'x', links: [{ href: 'https://example.com', text: '' }] }]],
    })
  })
})
