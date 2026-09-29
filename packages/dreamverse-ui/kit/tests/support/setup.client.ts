/**
 * Browser test setup for the DreamVerse page specs, ported from the FastVideo DreamVerse frontend: jest-dom matchers,
 * mock clearing and restoring before each test (the frontend's `clearMocks` and `restoreMocks`), cleanup, and jsdom
 * gaps. Each spec imports this module first.
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { WebSocket as MockWebSocket } from 'mock-socket'
import { afterEach, beforeEach, vi } from 'vitest'

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
})

// Specs call `vi.unstubAllGlobals()` after each test, so the mock-socket class replaces WebSocket as a property.
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: MockWebSocket })
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'WebSocket', { configurable: true, writable: true, value: MockWebSocket })
}

// The FastVideo tests ran under a jsdom URL without object URLs; Node's URL global has real ones, so always mock them.
URL.createObjectURL = vi.fn(() => 'blob:mock-url')
URL.revokeObjectURL = vi.fn()

if (!globalThis.ResizeObserver) {
  class ResizeObserverMock implements ResizeObserver {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }

  globalThis.ResizeObserver = ResizeObserverMock
}

const matchMediaMock = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  // oxlint-disable-next-line typescript/no-deprecated -- MediaQueryList still declares this legacy listener method.
  addListener() {},
  // oxlint-disable-next-line typescript/no-deprecated -- MediaQueryList still declares this legacy listener method.
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return false
  },
} as MediaQueryList)

if (!globalThis.matchMedia) {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMediaMock,
  })
}

if (typeof window !== 'undefined' && window.matchMedia !== matchMediaMock) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMediaMock,
  })
}

if (typeof window !== 'undefined' && !('maxTouchPoints' in window.navigator)) {
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    configurable: true,
    get: () => 0,
  })
}

Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  writable: true,
  value: vi.fn(() => Promise.resolve()),
})

Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  writable: true,
  value: vi.fn(),
})

Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  configurable: true,
  writable: true,
  value: vi.fn(),
})
