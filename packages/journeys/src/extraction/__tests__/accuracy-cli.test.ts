// extraction/accuracy-cli.test.ts — FE-T10: the ops-history/session clearer
// (`createOpsHistoryClearer`) pins BOTH keys it must clear per case so a
// money-tier corpus (which ALWAYS parks a REQUEST_CONFIRMATION) never bleeds
// a stale park into a later case — see accuracy-runner.ts's module header
// for the live-caught defect this closes.

import { describe, expect, it, vi } from "vitest"

const delMock = vi.fn(async () => 1)
const rkMock = vi.fn((key: string) => `ibx:${key}`)

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({ del: delMock })),
  rk: rkMock,
}))

describe("createOpsHistoryClearer", () => {
  it("clears BOTH the ops chat-history key AND the claustrum session key (the FE-T10 pending-confirmation fix)", async () => {
    const { createOpsHistoryClearer } = await import("../accuracy-cli.js")
    const clear = createOpsHistoryClearer(() => undefined)
    await clear("staff_1")

    expect(rkMock).toHaveBeenCalledWith("ops:chat:history:staff_1")
    expect(rkMock).toHaveBeenCalledWith("claustrum:session:admin:staff_1")
    expect(delMock).toHaveBeenCalledWith("ibx:ops:chat:history:staff_1")
    expect(delMock).toHaveBeenCalledWith("ibx:claustrum:session:admin:staff_1")
    expect(delMock).toHaveBeenCalledTimes(2)
  })

  it("warns ONCE and re-throws on every call when Redis is unreachable (isolation must never silently degrade)", async () => {
    vi.resetModules()
    vi.doMock("@ibatexas/tools", () => ({
      getRedisClient: vi.fn(async () => {
        throw new Error("connection refused")
      }),
      rk: rkMock,
    }))
    const { createOpsHistoryClearer } = await import("../accuracy-cli.js")
    const warnings: string[] = []
    const clear = createOpsHistoryClearer((line) => warnings.push(line))

    await expect(clear("staff_1")).rejects.toThrow("connection refused")
    await expect(clear("staff_1")).rejects.toThrow("connection refused")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("isolation NOT guaranteed")
  })
})

// ── FE-T12 — createCustomerHistoryClearer (the customer/web-plane sibling) ──

describe("createCustomerHistoryClearer", () => {
  it("clears BOTH the web conversation-history key AND the claustrum session key, keyed by sessionId (NOT customerId)", async () => {
    // Module-level delMock/rkMock are shared across this file's describe
    // blocks (vitest does not auto-reset vi.fn() call counts between tests) —
    // clear the accumulated call history from the OpsHistoryClearer tests
    // above before asserting an exact call count here.
    delMock.mockClear()
    rkMock.mockClear()
    vi.resetModules()
    vi.doMock("@ibatexas/tools", () => ({
      getRedisClient: vi.fn(async () => ({ del: delMock })),
      rk: rkMock,
    }))
    const { createCustomerHistoryClearer } = await import("../accuracy-cli.js")
    const clear = createCustomerHistoryClearer(() => undefined)
    await clear("sess-1")

    expect(rkMock).toHaveBeenCalledWith("session:sess-1")
    expect(rkMock).toHaveBeenCalledWith("claustrum:session:sess-1")
    expect(delMock).toHaveBeenCalledWith("ibx:session:sess-1")
    expect(delMock).toHaveBeenCalledWith("ibx:claustrum:session:sess-1")
    expect(delMock).toHaveBeenCalledTimes(2)
  })

  it("warns ONCE and re-throws on every call when Redis is unreachable (isolation must never silently degrade)", async () => {
    vi.resetModules()
    vi.doMock("@ibatexas/tools", () => ({
      getRedisClient: vi.fn(async () => {
        throw new Error("connection refused")
      }),
      rk: rkMock,
    }))
    const { createCustomerHistoryClearer } = await import("../accuracy-cli.js")
    const warnings: string[] = []
    const clear = createCustomerHistoryClearer((line) => warnings.push(line))

    await expect(clear("sess-1")).rejects.toThrow("connection refused")
    await expect(clear("sess-1")).rejects.toThrow("connection refused")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("isolation NOT guaranteed")
  })
})

// ── `--customer-index` (team-lead ruling, post-FE-T12-calibration) ──────────
// The F4 token-budget guard meters per customerId, not sessionId (see
// accuracy-runner.ts's module header) — a single shared calibration
// identity means every ticket sharing this driver metering onto the SAME
// customer's cumulative total. `resolveCustomerPhoneForIndex` is the pure
// range-check backing `--customer-index`; it must fail with a clear,
// actionable error for an out-of-range index rather than letting `undefined`
// silently reach `domain.customerByPhone`.

describe("resolveCustomerPhoneForIndex", () => {
  it("returns the phone at a valid index, index 0 matching the backward-compat ACCURACY_RUN_CUSTOMER_PHONE alias", async () => {
    const { resolveCustomerPhoneForIndex, ACCURACY_RUN_CUSTOMER_PHONE, ACCURACY_RUN_CUSTOMER_PHONES } =
      await import("../accuracy-cli.js")
    expect(resolveCustomerPhoneForIndex(0)).toBe(ACCURACY_RUN_CUSTOMER_PHONE)
    expect(resolveCustomerPhoneForIndex(0)).toBe("+5519900000001")
    expect(resolveCustomerPhoneForIndex(1)).toBe("+5519900000002")
    expect(resolveCustomerPhoneForIndex(9)).toBe(ACCURACY_RUN_CUSTOMER_PHONES[9])
  })

  it("throws a clear ExtractionAccuracyCliError for an out-of-range index (never a silent undefined phone)", async () => {
    const { resolveCustomerPhoneForIndex, ExtractionAccuracyCliError } = await import("../accuracy-cli.js")
    expect(() => resolveCustomerPhoneForIndex(10)).toThrow(ExtractionAccuracyCliError)
    expect(() => resolveCustomerPhoneForIndex(10)).toThrow(/out of range/)
    expect(() => resolveCustomerPhoneForIndex(-1)).toThrow(/out of range/)
  })
})

// ── `--reset-customer-token-budget` (team-lead budget ruling (b)) ───────────
// Opt-in ONLY (default false) — pinning that a run without the flag NEVER
// touches the token-budget counter is exactly the discipline the ruling's
// bright line (no governance workarounds without an explicit ask) exists
// for. `shouldResetCustomerTokenBudget` is the single, pure decision point;
// `resetCustomerTokenBudgetCounter` is the actual DEL, unit-tested in
// isolation mirroring the history-clearer tests above.

describe("shouldResetCustomerTokenBudget", () => {
  it("is false when resetCustomerTokenBudget is omitted (opt-in off by default)", async () => {
    const { shouldResetCustomerTokenBudget } = await import("../accuracy-cli.js")
    expect(shouldResetCustomerTokenBudget({})).toBe(false)
  })

  it("is false when resetCustomerTokenBudget is explicitly false", async () => {
    const { shouldResetCustomerTokenBudget } = await import("../accuracy-cli.js")
    expect(shouldResetCustomerTokenBudget({ resetCustomerTokenBudget: false })).toBe(false)
  })

  it("is true ONLY when resetCustomerTokenBudget is explicitly true", async () => {
    const { shouldResetCustomerTokenBudget } = await import("../accuracy-cli.js")
    expect(shouldResetCustomerTokenBudget({ resetCustomerTokenBudget: true })).toBe(true)
  })
})

describe("resetCustomerTokenBudgetCounter", () => {
  it("DELs exactly the customerId+channel token-budget key via the same rk()/getRedisClient mechanism the history clearers use, and logs loudly", async () => {
    vi.resetModules()
    delMock.mockClear()
    rkMock.mockClear()
    vi.doMock("@ibatexas/tools", () => ({
      getRedisClient: vi.fn(async () => ({ del: delMock })),
      rk: rkMock,
    }))
    const { resetCustomerTokenBudgetCounter } = await import("../accuracy-cli.js")
    const progress: string[] = []

    await resetCustomerTokenBudgetCounter("cust_1", "web", (line) => progress.push(line))

    expect(rkMock).toHaveBeenCalledWith("llm:tokens:web:cust_1")
    expect(delMock).toHaveBeenCalledWith("ibx:llm:tokens:web:cust_1")
    expect(delMock).toHaveBeenCalledTimes(1)
    expect(progress).toHaveLength(1)
    expect(progress[0]).toContain("--reset-customer-token-budget")
    expect(progress[0]).toContain("cust_1")
  })
})

// ── createCheckoutCartSeeder (the beforeCase capability dispatcher) ─────────

describe("createCheckoutCartSeeder", () => {
  it("seeds a cart ONLY for order.checkout.create — a no-op for every other capability sharing the driver (order.cancel)", async () => {
    vi.resetModules()
    const seedCheckoutCartMock = vi.fn(async () => ({ cartId: "cart_1", totalCentavos: 5_000 }))
    vi.doMock("../../live/seed-checkout-cart.js", () => ({
      seedCheckoutCart: seedCheckoutCartMock,
      targetCentavosForCase: (caseId: string) =>
        caseId === "money-boundary-confirm-exact-threshold" ? 100_000 : 5_000,
    }))
    const { createCheckoutCartSeeder } = await import("../accuracy-cli.js")
    const beforeCase = createCheckoutCartSeeder(() => undefined)

    await beforeCase("sess-1", { id: "pix-pickup-direct" }, "order.checkout.create")
    await beforeCase("sess-2", { id: "bare-direct" }, "order.cancel")

    expect(seedCheckoutCartMock).toHaveBeenCalledTimes(1)
    expect(seedCheckoutCartMock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      targetCentavos: 5_000,
      onProgress: expect.any(Function),
    })
  })

  it("threads the case id through targetCentavosForCase, so a money-boundary case seeds its OWN specific total", async () => {
    vi.resetModules()
    const seedCheckoutCartMock = vi.fn(async () => ({ cartId: "cart_1", totalCentavos: 100_000 }))
    vi.doMock("../../live/seed-checkout-cart.js", () => ({
      seedCheckoutCart: seedCheckoutCartMock,
      targetCentavosForCase: (caseId: string) =>
        caseId === "money-boundary-confirm-exact-threshold" ? 100_000 : 5_000,
    }))
    const { createCheckoutCartSeeder } = await import("../accuracy-cli.js")
    const beforeCase = createCheckoutCartSeeder(() => undefined)

    await beforeCase("sess-3", { id: "money-boundary-confirm-exact-threshold" }, "order.checkout.create")

    expect(seedCheckoutCartMock).toHaveBeenCalledWith({
      sessionId: "sess-3",
      targetCentavos: 100_000,
      onProgress: expect.any(Function),
    })
  })
})

// ── createCancelOrderSeeder (team-lead ruling: fix the cancel money-boundary seeding) ──

describe("createCancelOrderSeeder", () => {
  it("seeds a cancelable order ONLY for order.cancel — a no-op for every other capability sharing the driver (order.checkout.create)", async () => {
    vi.resetModules()
    const seedCancelableOrderMock = vi.fn(async () => ({ orderId: "order_1", amountInCentavos: 5_000 }))
    vi.doMock("../../live/seed-cancelable-order.js", () => ({
      seedCancelableOrder: seedCancelableOrderMock,
      targetCentavosForCancelCase: (caseId: string) =>
        caseId === "escalate-exact-threshold-boundary" ? 100_000 : 5_000,
    }))
    const { createCancelOrderSeeder } = await import("../accuracy-cli.js")
    const beforeCase = createCancelOrderSeeder("cust_1", () => undefined)

    await beforeCase("sess-1", { id: "bare-direct" }, "order.cancel")
    await beforeCase("sess-2", { id: "pix-pickup-direct" }, "order.checkout.create")

    expect(seedCancelableOrderMock).toHaveBeenCalledTimes(1)
    expect(seedCancelableOrderMock).toHaveBeenCalledWith({
      customerId: "cust_1",
      targetCentavos: 5_000,
      onProgress: expect.any(Function),
    })
  })

  it("threads the case id through targetCentavosForCancelCase, so a named boundary case seeds its OWN specific total", async () => {
    vi.resetModules()
    const seedCancelableOrderMock = vi.fn(async () => ({ orderId: "order_1", amountInCentavos: 100_000 }))
    vi.doMock("../../live/seed-cancelable-order.js", () => ({
      seedCancelableOrder: seedCancelableOrderMock,
      targetCentavosForCancelCase: (caseId: string) =>
        caseId === "escalate-exact-threshold-boundary" ? 100_000 : 5_000,
    }))
    const { createCancelOrderSeeder } = await import("../accuracy-cli.js")
    const beforeCase = createCancelOrderSeeder("cust_1", () => undefined)

    await beforeCase("sess-1", { id: "escalate-exact-threshold-boundary" }, "order.cancel")

    expect(seedCancelableOrderMock).toHaveBeenCalledWith({
      customerId: "cust_1",
      targetCentavos: 100_000,
      onProgress: expect.any(Function),
    })
  })

  it("ignores sessionId entirely — the cancel precondition is keyed by customer, not session", async () => {
    vi.resetModules()
    const seedCancelableOrderMock = vi.fn(async (_opts: { customerId: string; targetCentavos: number }) => ({
      orderId: "order_1",
      amountInCentavos: 5_000,
    }))
    vi.doMock("../../live/seed-cancelable-order.js", () => ({
      seedCancelableOrder: seedCancelableOrderMock,
      targetCentavosForCancelCase: () => 5_000,
    }))
    const { createCancelOrderSeeder } = await import("../accuracy-cli.js")
    const beforeCase = createCancelOrderSeeder("cust_1", () => undefined)

    await beforeCase("sess-a", { id: "bare-direct" }, "order.cancel")
    await beforeCase("sess-b", { id: "bare-formal" }, "order.cancel")

    // Both calls have the SAME args shape regardless of sessionId — no sessionId key anywhere.
    for (const call of seedCancelableOrderMock.mock.calls) {
      expect(call[0]).not.toHaveProperty("sessionId")
    }
  })
})

describe("composeBeforeCase", () => {
  it("runs EVERY composed hook in sequence for a given case, each independently dispatching by capability", async () => {
    const { composeBeforeCase } = await import("../accuracy-cli.js")
    const calls: string[] = []
    const checkoutHook = async (_s: string, _k: { id: string }, capability: string): Promise<void> => {
      calls.push(`checkout-called:${capability}`)
      if (capability === "order.checkout.create") calls.push("checkout-acted")
    }
    const cancelHook = async (_s: string, _k: { id: string }, capability: string): Promise<void> => {
      calls.push(`cancel-called:${capability}`)
      if (capability === "order.cancel") calls.push("cancel-acted")
    }
    const composed = composeBeforeCase(checkoutHook, cancelHook)

    await composed("sess-1", { id: "case-a" }, "order.checkout.create")

    // BOTH hooks are called (never just the first one matching) — only the
    // one whose capability matches actually acts.
    expect(calls).toEqual([
      "checkout-called:order.checkout.create",
      "checkout-acted",
      "cancel-called:order.checkout.create",
    ])
  })

  it("with zero hooks composed, resolves as a clean no-op", async () => {
    const { composeBeforeCase } = await import("../accuracy-cli.js")
    const composed = composeBeforeCase()
    await expect(composed("sess-1", { id: "case-a" }, "order.cancel")).resolves.toBeUndefined()
  })
})
