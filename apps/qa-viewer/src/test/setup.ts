// Vitest setup — the React Flow measurement shims from the official testing
// guide (reactflow.dev/learn/advanced-use/testing), guarded so a future
// happy-dom that implements them natively wins. With these in place (plus
// explicit width/height on every laid-out node) React Flow renders the full
// graph in the smoke test without a browser.

import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

class ResizeObserverMock {
  callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyMock {
  m22: number
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1]
    this.m22 = scale !== undefined ? +scale : 1
  }
}

const g = globalThis as unknown as Record<string, unknown>
if (typeof g["ResizeObserver"] === "undefined") g["ResizeObserver"] = ResizeObserverMock
if (typeof g["DOMMatrixReadOnly"] === "undefined") {
  g["DOMMatrixReadOnly"] = DOMMatrixReadOnlyMock
}

// React Flow reads offsetWidth/offsetHeight of its wrapper for fitView.
if (typeof HTMLElement !== "undefined") {
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 800
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.width) || 1200
      },
    },
  })
}

if (typeof SVGElement !== "undefined") {
  const svgProto = SVGElement.prototype as unknown as Record<string, unknown>
  if (typeof svgProto["getBBox"] === "undefined") {
    svgProto["getBBox"] = () => ({ x: 0, y: 0, width: 0, height: 0 })
  }
}

afterEach(() => {
  cleanup()
})
