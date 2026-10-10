// @vitest-environment jsdom
/**
 * The left sidebar fold: collapse and restore requested in one tick, before DSH's frame renders the first fold, and a
 * fold the user toggles from DSH's rail.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createSidebarFold, type SidebarFold } from '../src/client/sidebar.ts'

/**
 * A stand-in for DSH's app frame: the layout store flips at once, and the attribute follows in one batched render a
 * microtask later, like React's commit of the store updates of one tick.
 */
class FakeFrame {
  readonly element = document.createElement('div')
  collapsed = false
  toggles = 0
  private scheduled = false

  constructor() {
    document.body.append(this.element)
  }

  /** `ctx.layout.toggleSidebar()`: flip the store now and render the attribute in a later microtask. */
  toggle = (): boolean => {
    this.toggles += 1
    this.collapsed = !this.collapsed
    if (!this.scheduled) {
      this.scheduled = true
      queueMicrotask(() => { this.scheduled = false; this.render() })
    }
    return true
  }

  /** The user's click on DSH's rail, rendered at once. */
  userToggle(): void {
    this.collapsed = !this.collapsed
    this.render()
  }

  render(): void {
    if (this.collapsed) this.element.setAttribute('data-sidebar-collapsed', 'true')
    else this.element.removeAttribute('data-sidebar-collapsed')
  }
}

/** Let pending microtasks (frame renders and attribute observers) run. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

let fold: SidebarFold | null = null

afterEach(() => {
  fold?.dispose()
  fold = null
  document.body.replaceChildren()
})

describe('createSidebarFold', () => {
  it('keeps the sidebar collapsed when a project opens in the same tick as the entry page restored it', async () => {
    const frame = new FakeFrame()
    fold = createSidebarFold(frame.toggle)
    fold.collapse()
    await settle()
    expect(frame.collapsed).toBe(true)
    // 首页 restores the sidebar, and a project card opens a project before the frame renders the restore.
    fold.restore()
    fold.collapse()
    await settle()
    expect(frame.collapsed).toBe(true)
    expect(frame.element.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(frame.toggles).toBe(3)
    // Repeated requests in one tick toggle once.
    fold.restore()
    fold.restore()
    await settle()
    expect(frame.collapsed).toBe(false)
    expect(frame.toggles).toBe(4)
  })

  it('leaves a fold the user toggled from the rail alone', async () => {
    const frame = new FakeFrame()
    fold = createSidebarFold(frame.toggle)
    fold.collapse()
    await settle()
    // The user expands the sidebar in the project, then collapses it again; 首页 keeps the user's fold.
    frame.userToggle()
    await settle()
    frame.userToggle()
    await settle()
    fold.restore()
    await settle()
    expect(frame.collapsed).toBe(true)
    expect(frame.toggles).toBe(1)
    // An expanded sidebar stays expanded on 首页 and collapses when a project opens.
    frame.userToggle()
    await settle()
    fold.restore()
    fold.collapse()
    await settle()
    expect(frame.collapsed).toBe(true)
    expect(frame.toggles).toBe(2)
  })

  it('records no fold when no layout service is mounted', async () => {
    const frame = new FakeFrame()
    fold = createSidebarFold(() => false)
    fold.collapse()
    fold.restore()
    await settle()
    expect(frame.collapsed).toBe(false)
  })
})
