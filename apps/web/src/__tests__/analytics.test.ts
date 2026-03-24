// Unit tests for analytics layer
// Session management, lazy session_started, scroll depth, PostHog integration

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetPostHogClient = vi.hoisted(() => vi.fn())

vi.mock("@/lib/posthog", () => ({
  getPostHogClient: mockGetPostHogClient,
}))

vi.mock("@/domains/consent", () => ({
  useConsentStore: {
    getState: () => ({ accepted: true }),
  },
}))

// ── Browser globals ────────────────────────────────────────────────────────────

const sessionStore = new Map<string, string>()
const mockSendBeacon = vi.fn(() => true)

function setupBrowserGlobals() {
  vi.stubGlobal("window", {
    location: { pathname: "/loja/produto/prod_01" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    scrollY: 0,
    innerHeight: 800,
  })

  vi.stubGlobal("document", {
    body: { scrollHeight: 3200 },
  })

  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => sessionStore.get(key) ?? null,
    setItem: (key: string, value: string) => { sessionStore.set(key, value) },
    removeItem: (key: string) => { sessionStore.delete(key) },
  })

  vi.stubGlobal("navigator", { sendBeacon: mockSendBeacon })

  // trackScrollDepth uses globalThis.addEventListener/removeEventListener directly
  vi.stubGlobal("addEventListener", vi.fn())
  vi.stubGlobal("removeEventListener", vi.fn())

  vi.stubGlobal("crypto", {
    randomUUID: () => "test-session-uuid-1234",
  })
}

function teardownBrowserGlobals() {
  sessionStore.clear()
  vi.unstubAllGlobals()
}

// ── Import after mocks ─────────────────────────────────────────────────────────

let track: typeof import("../domains/analytics/track").track
let getSessionId: typeof import("../domains/analytics/track").getSessionId
let trackScrollDepth: typeof import("../domains/analytics/track").trackScrollDepth

describe("Analytics Layer", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    teardownBrowserGlobals()
    setupBrowserGlobals()
    mockGetPostHogClient.mockReturnValue(null)

    // Set NODE_ENV to development so isDev = true → console.log fires
    process.env.NODE_ENV = "development"

    // Force re-import to reset module state (sessionId, isDev, etc.)
    vi.resetModules()
    const mod = await import("../domains/analytics/track")
    track = mod.track
    getSessionId = mod.getSessionId
    trackScrollDepth = mod.trackScrollDepth
  })

  afterEach(() => {
    process.env.NODE_ENV = "test"
    teardownBrowserGlobals()
  })

  // ── Session management ────────────────────────────────────────────────────

  describe("getSessionId()", () => {
    it("returns consistent session ID within session", () => {
      const id1 = getSessionId()
      const id2 = getSessionId()
      expect(id1).toBe(id2)
      expect(id1).toBe("test-session-uuid-1234")
    })

    it("persists session ID in sessionStorage", () => {
      getSessionId()
      expect(sessionStore.get("ibx_analytics_session")).toBe("test-session-uuid-1234")
    })

    it("reuses existing session ID from sessionStorage", () => {
      sessionStore.set("ibx_analytics_session", "existing-session-id")
      const id = getSessionId()
      expect(id).toBe("existing-session-id")
    })
  })

  // ── Lazy session_started ──────────────────────────────────────────────────

  describe("ensureSessionStarted (via track())", () => {
    it("fires session_started on first pdp_viewed (meaningful event)", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

      track("pdp_viewed", { productId: "prod_01" })

      // session_started should fire first, then pdp_viewed
      const calls = consoleSpy.mock.calls.filter((c) => c[0] === "[analytics]")
      expect(calls.length).toBe(2)
      expect(calls[0][1]).toBe("session_started")
      expect(calls[1][1]).toBe("pdp_viewed")

      consoleSpy.mockRestore()
    })

    it("fires session_started on first search_performed", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

      track("search_performed", { query: "costela" })

      const calls = consoleSpy.mock.calls.filter((c) => c[0] === "[analytics]")
      expect(calls.length).toBe(2)
      expect(calls[0][1]).toBe("session_started")
      expect(calls[1][1]).toBe("search_performed")

      consoleSpy.mockRestore()
    })

    it("fires session_started on first checkout_started (returning user edge case)", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

      track("checkout_started", { cartTotal: 8900 })

      const calls = consoleSpy.mock.calls.filter((c) => c[0] === "[analytics]")
      expect(calls.length).toBe(2)
      expect(calls[0][1]).toBe("session_started")
      expect(calls[1][1]).toBe("checkout_started")

      consoleSpy.mockRestore()
    })

    it("does NOT fire session_started on non-meaningful events", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

      track("cart_drawer_opened", {})

      const calls = consoleSpy.mock.calls.filter((c) => c[0] === "[analytics]")
      expect(calls.length).toBe(1)
      expect(calls[0][1]).toBe("cart_drawer_opened")

      consoleSpy.mockRestore()
    })

    it("fires session_started only once per session", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

      track("pdp_viewed", { productId: "prod_01" })
      track("pdp_viewed", { productId: "prod_02" })
      track("search_performed", { query: "test" })

      const sessionStartedCalls = consoleSpy.mock.calls.filter(
        (c) => c[0] === "[analytics]" && c[1] === "session_started",
      )
      expect(sessionStartedCalls.length).toBe(1)

      consoleSpy.mockRestore()
    })

    it("does not fire session_started if ibx_session_started flag exists", () => {
      sessionStore.set("ibx_session_started", "1")
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

      track("pdp_viewed", { productId: "prod_01" })

      const sessionStartedCalls = consoleSpy.mock.calls.filter(
        (c) => c[0] === "[analytics]" && c[1] === "session_started",
      )
      expect(sessionStartedCalls.length).toBe(0)

      consoleSpy.mockRestore()
    })
  })

  // ── PostHog integration ───────────────────────────────────────────────────

  describe("PostHog integration", () => {
    it("calls posthog.capture() when PostHog client is available", () => {
      const mockPostHog = { capture: vi.fn(), register: vi.fn() }
      mockGetPostHogClient.mockReturnValue(mockPostHog)

      // Skip session_started noise
      sessionStore.set("ibx_session_started", "1")
      track("add_to_cart", { productId: "prod_01", quantity: 2 })

      const addToCartCall = mockPostHog.capture.mock.calls.find(
        (c: unknown[]) => c[0] === "add_to_cart",
      )
      expect(addToCartCall).toBeDefined()
      expect(addToCartCall[1].productId).toBe("prod_01")
      expect(addToCartCall[1].ibx_session_id).toBeDefined()
    })

    it("does not throw when PostHog client is null", () => {
      mockGetPostHogClient.mockReturnValue(null)

      expect(() => {
        track("pdp_viewed", { productId: "prod_01" })
      }).not.toThrow()
    })

    it("registers ibx_session_id as super property on PostHog", () => {
      const mockPostHog = { capture: vi.fn(), register: vi.fn() }
      mockGetPostHogClient.mockReturnValue(mockPostHog)

      getSessionId()

      expect(mockPostHog.register).toHaveBeenCalledWith({
        ibx_session_id: expect.any(String),
      })
    })
  })

  // ── Scroll depth ──────────────────────────────────────────────────────────

  describe("trackScrollDepth()", () => {
    it("fires pdp_scroll_depth at 25/50/75/100% thresholds", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      sessionStore.set("ibx_session_started", "1")

      let scrollHandler: (() => void) | null = null
      const mockAddEventListener = vi.fn((event: string, handler: () => void) => {
        if (event === "scroll") scrollHandler = handler
      })
      vi.stubGlobal("window", {
        scrollY: 0,
        innerHeight: 800,
        addEventListener: mockAddEventListener,
        removeEventListener: vi.fn(),
        location: { pathname: "/test" },
      })
      vi.stubGlobal("addEventListener", mockAddEventListener)
      vi.stubGlobal("removeEventListener", vi.fn())
      vi.stubGlobal("scrollY", 0)
      vi.stubGlobal("innerHeight", 800)
      vi.stubGlobal("document", { body: { scrollHeight: 3200 } })

      const cleanup = trackScrollDepth("prod_01")

      // 25%: 0+800=800, 800/3200=25%
      vi.stubGlobal("scrollY", 0)
      scrollHandler?.()

      // 50%: 800+800=1600, 1600/3200=50%
      vi.stubGlobal("scrollY", 800)
      scrollHandler?.()

      // 75%: 1600+800=2400, 2400/3200=75%
      vi.stubGlobal("scrollY", 1600)
      scrollHandler?.()

      // 100%: 2400+800=3200, 3200/3200=100%
      vi.stubGlobal("scrollY", 2400)
      scrollHandler?.()

      const scrollCalls = consoleSpy.mock.calls.filter(
        (c) => c[0] === "[analytics]" && c[1] === "pdp_scroll_depth",
      )
      expect(scrollCalls.length).toBe(4)
      expect(scrollCalls[0][2].depth).toBe(25)
      expect(scrollCalls[1][2].depth).toBe(50)
      expect(scrollCalls[2][2].depth).toBe(75)
      expect(scrollCalls[3][2].depth).toBe(100)

      cleanup()
      consoleSpy.mockRestore()
    })

    it("fires each threshold exactly once", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      sessionStore.set("ibx_session_started", "1")

      let scrollHandler: (() => void) | null = null
      const mockAddEventListener = vi.fn((event: string, handler: () => void) => {
        if (event === "scroll") scrollHandler = handler
      })
      vi.stubGlobal("window", {
        scrollY: 0,
        innerHeight: 800,
        addEventListener: mockAddEventListener,
        removeEventListener: vi.fn(),
        location: { pathname: "/test" },
      })
      vi.stubGlobal("addEventListener", mockAddEventListener)
      vi.stubGlobal("removeEventListener", vi.fn())
      vi.stubGlobal("scrollY", 0)
      vi.stubGlobal("innerHeight", 800)
      vi.stubGlobal("document", { body: { scrollHeight: 3200 } })

      const cleanup = trackScrollDepth("prod_01")

      // Scroll to 50% multiple times
      vi.stubGlobal("scrollY", 800)
      scrollHandler?.()
      scrollHandler?.()
      scrollHandler?.()

      const scrollCalls = consoleSpy.mock.calls.filter(
        (c) => c[0] === "[analytics]" && c[1] === "pdp_scroll_depth" && c[2].depth === 50,
      )
      expect(scrollCalls.length).toBe(1)

      cleanup()
      consoleSpy.mockRestore()
    })

    it("fires 100% immediately for short pages", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      sessionStore.set("ibx_session_started", "1")

      vi.stubGlobal("document", { body: { scrollHeight: 600 } })
      vi.stubGlobal("window", {
        scrollY: 0,
        innerHeight: 800,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        location: { pathname: "/test" },
      })
      vi.stubGlobal("addEventListener", vi.fn())
      vi.stubGlobal("removeEventListener", vi.fn())
      vi.stubGlobal("innerHeight", 800)

      const cleanup = trackScrollDepth("prod_short")

      const scrollCalls = consoleSpy.mock.calls.filter(
        (c) => c[0] === "[analytics]" && c[1] === "pdp_scroll_depth",
      )
      expect(scrollCalls.length).toBe(1)
      expect(scrollCalls[0][2].depth).toBe(100)
      expect(scrollCalls[0][2].productId).toBe("prod_short")

      cleanup()
      consoleSpy.mockRestore()
    })

    it("returns cleanup function that removes scroll listener", () => {
      sessionStore.set("ibx_session_started", "1")
      const mockRemoveEventListener = vi.fn()
      vi.stubGlobal("window", {
        scrollY: 0,
        innerHeight: 800,
        addEventListener: vi.fn(),
        removeEventListener: mockRemoveEventListener,
        location: { pathname: "/test" },
      })
      vi.stubGlobal("addEventListener", vi.fn())
      vi.stubGlobal("removeEventListener", mockRemoveEventListener)
      vi.stubGlobal("innerHeight", 800)
      vi.stubGlobal("document", { body: { scrollHeight: 3200 } })

      const cleanup = trackScrollDepth("prod_01")
      cleanup()

      expect(mockRemoveEventListener).toHaveBeenCalledWith("scroll", expect.any(Function))
    })
  })

  // ── track() in dev mode ───────────────────────────────────────────────────

  describe("track() in dev mode", () => {
    it("logs event to console with properties", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      sessionStore.set("ibx_session_started", "1")

      track("product_card_clicked", { productId: "prod_01" })

      const call = consoleSpy.mock.calls.find(
        (c) => c[0] === "[analytics]" && c[1] === "product_card_clicked",
      )
      expect(call).toBeDefined()
      expect(call![2].productId).toBe("prod_01")
      expect(call![2].ibx_session_id).toBeDefined()
      expect(call![2].timestamp).toBeDefined()

      consoleSpy.mockRestore()
    })
  })

  // ── checkout_completed guard (ref-based idempotency) ──────────────────────

  describe("checkout_completed guard pattern", () => {
    it("track() fires every call — dedup responsibility is on the caller (useRef)", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      sessionStore.set("ibx_session_started", "1")

      track("checkout_completed", { orderId: "ord_01", orderTotal: 15000, currency: "BRL" })
      track("checkout_completed", { orderId: "ord_01", orderTotal: 15000, currency: "BRL" })

      const calls = consoleSpy.mock.calls.filter(
        (c) => c[0] === "[analytics]" && c[1] === "checkout_completed",
      )
      // track() itself has no dedup — fires both times
      // The checkout page uses checkoutCompletedRef.current to guard the second call
      expect(calls).toHaveLength(2)

      consoleSpy.mockRestore()
    })

    it("simulates ref-based guard: second call is blocked by caller", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      sessionStore.set("ibx_session_started", "1")

      // Simulate the checkout page's ref-based guard pattern
      let checkoutCompletedRef = false

      function fireCheckoutCompleted(orderId: string, orderTotal: number) {
        if (!checkoutCompletedRef && orderId) {
          checkoutCompletedRef = true
          track("checkout_completed", {
            orderId,
            orderTotal,
            currency: "BRL",
            ibx_session_id: "sess_test",
          })
        }
      }

      fireCheckoutCompleted("ord_01", 15000)
      fireCheckoutCompleted("ord_01", 15000) // double-click / re-render

      const calls = consoleSpy.mock.calls.filter(
        (c) => c[0] === "[analytics]" && c[1] === "checkout_completed",
      )
      expect(calls).toHaveLength(1)
      expect(calls[0][2].orderId).toBe("ord_01")
      expect(calls[0][2].orderTotal).toBe(15000)
      expect(calls[0][2].currency).toBe("BRL")
      // ibx_session_id is enriched by track() from getSessionId(), not the passed prop
      expect(calls[0][2].ibx_session_id).toBeDefined()

      consoleSpy.mockRestore()
    })
  })
})
