// Tests for medusaAdjudicated — the kernel-gated Medusa HTTP wrapper.
//
// Covers the seven invariants the Task 17 spec calls out plus a couple
// of safety cases (idempotency header propagation, path-map specificity,
// audit-emit failure non-blocking, GET pass-through).
//
// The transport (`medusaStore` / `medusaAdmin`) is exercised end-to-end
// via a mocked `global.fetch` so the retry / auth / publishable-key
// pathways still run — same shape as src/cart/__tests__/_shared.test.ts.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { AuditRecord, AuditSink } from "@adjudicate/core"
import {
  MEDUSA_INTENT_KINDS,
  MedusaAdjudicateNeedsReviewError,
  MedusaAdjudicateRefusedError,
  detectMedusaIntentKind,
  medusaAdjudicated,
} from "../adjudicated.js"

// ── Mock global.fetch + module-level cache priming ────────────────────────

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

process.env.MEDUSA_ADMIN_EMAIL = "test@example.com"
process.env.MEDUSA_ADMIN_PASSWORD = "test-password"

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

function makeFakeJwt(expSecondsFromNow = 3600): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString("base64url")
  return `${header}.${payload}.sig`
}

function makeAuthResponse() {
  return makeOkResponse({ token: makeFakeJwt() })
}

// Prime the module-level admin-token + publishable-key caches once so
// individual tests can mock the upstream Medusa endpoint without having
// to thread the /auth/user/emailpass + /admin/api-keys calls themselves.
beforeAll(async () => {
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/auth/user/emailpass")) {
      return Promise.resolve(makeAuthResponse())
    }
    if (typeof url === "string" && url.includes("/admin/api-keys")) {
      return Promise.resolve(
        makeOkResponse({ api_keys: [{ token: "pk_resolved" }] }),
      )
    }
    return Promise.resolve(makeOkResponse({}))
  })
  // Trigger a single GET via medusaAdjudicated to prime caches.
  await medusaAdjudicated({
    scope: "store",
    method: "GET",
    path: "/store/__prime__",
    sourceSubject: "test:prime",
    auditSink: noopAuditSink,
  })
  mockFetch.mockReset()
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── In-memory audit sink ────────────────────────────────────────────────

function createMemoryAuditSink(): {
  sink: AuditSink
  records: AuditRecord[]
} {
  const records: AuditRecord[] = []
  const sink: AuditSink = {
    async emit(record) {
      records.push(record)
    },
  }
  return { sink, records }
}

// audit-2026-05-24 H2 (A1): `auditSink` is required on wrapper meta.
// Tests that don't assert on emit behaviour pass an explicit no-op sink.
const noopAuditSink: AuditSink = {
  async emit() {
    /* no-op */
  },
}

// ── Path-to-intent-kind detection ───────────────────────────────────────

describe("detectMedusaIntentKind", () => {
  it("maps POST /store/carts to medusa.cart.create", () => {
    expect(detectMedusaIntentKind("POST", "/store/carts")).toBe(
      "medusa.cart.create",
    )
  })

  it("maps POST /store/carts/<id>/line-items to medusa.cart.line_items.add", () => {
    expect(
      detectMedusaIntentKind("POST", "/store/carts/cart_01/line-items"),
    ).toBe("medusa.cart.line_items.add")
  })

  it("differentiates item-scoped POST (update) from bare line-items POST (add)", () => {
    expect(
      detectMedusaIntentKind("POST", "/store/carts/cart_01/line-items"),
    ).toBe("medusa.cart.line_items.add")
    expect(
      detectMedusaIntentKind(
        "POST",
        "/store/carts/cart_01/line-items/li_42",
      ),
    ).toBe("medusa.cart.line_items.update")
  })

  it("maps DELETE /store/carts/<id>/line-items/<itemId> to medusa.cart.line_items.remove", () => {
    expect(
      detectMedusaIntentKind(
        "DELETE",
        "/store/carts/cart_01/line-items/li_42",
      ),
    ).toBe("medusa.cart.line_items.remove")
  })

  it("maps POST /store/carts/<id>/complete to medusa.cart.complete", () => {
    expect(
      detectMedusaIntentKind("POST", "/store/carts/cart_01/complete"),
    ).toBe("medusa.cart.complete")
  })

  it("maps POST /store/carts/<id>/promotions to medusa.cart.promotion.apply", () => {
    expect(
      detectMedusaIntentKind("POST", "/store/carts/cart_01/promotions"),
    ).toBe("medusa.cart.promotion.apply")
  })

  it("maps bare POST /store/carts/<id> to medusa.cart.update", () => {
    expect(detectMedusaIntentKind("POST", "/store/carts/cart_01")).toBe(
      "medusa.cart.update",
    )
  })

  it("maps POST /store/payment-collections to medusa.payment_collection.create", () => {
    expect(
      detectMedusaIntentKind("POST", "/store/payment-collections"),
    ).toBe("medusa.payment_collection.create")
  })

  it("maps the admin order-edit suite in specificity order", () => {
    expect(
      detectMedusaIntentKind("POST", "/admin/orders/order_01/edits"),
    ).toBe("medusa.admin.order.edit.create")
    expect(
      detectMedusaIntentKind(
        "POST",
        "/admin/orders/order_01/edits/items",
      ),
    ).toBe("medusa.admin.order.edit.items")
    expect(
      detectMedusaIntentKind(
        "POST",
        "/admin/orders/order_01/edits/confirm",
      ),
    ).toBe("medusa.admin.order.edit.confirm")
  })

  // W7-P6: order.service.ts uses the actual Medusa shape with :editId.
  it("maps POST /admin/orders/:id/edits/:editId/confirm to medusa.admin.order.edit.confirm", () => {
    expect(
      detectMedusaIntentKind(
        "POST",
        "/admin/orders/order_01/edits/edit_99/confirm",
      ),
    ).toBe("medusa.admin.order.edit.confirm")
  })

  // W7-P6: order.service.cancelItem() DELETEs a single line from an edit.
  it("maps DELETE /admin/orders/:id/edits/:editId/items/:itemId to medusa.admin.order.edit.items.remove", () => {
    expect(
      detectMedusaIntentKind(
        "DELETE",
        "/admin/orders/order_01/edits/edit_99/items/item_42",
      ),
    ).toBe("medusa.admin.order.edit.items.remove")
  })

  // W7-P6: order.service.capturePayment().
  it("maps POST /admin/orders/:id/capture-payment to medusa.admin.order.capture_payment", () => {
    expect(
      detectMedusaIntentKind(
        "POST",
        "/admin/orders/order_01/capture-payment",
      ),
    ).toBe("medusa.admin.order.capture_payment")
  })

  it("maps POST /admin/orders/<id>/cancel to medusa.admin.order.cancel", () => {
    expect(
      detectMedusaIntentKind("POST", "/admin/orders/order_01/cancel"),
    ).toBe("medusa.admin.order.cancel")
  })

  it("maps bare POST /admin/orders/<id> to medusa.admin.order.update_metadata", () => {
    expect(detectMedusaIntentKind("POST", "/admin/orders/order_01")).toBe(
      "medusa.admin.order.update_metadata",
    )
  })

  // P0-X9 follow-up — additional kinds needed by route-level migrations.
  it("maps bare POST /admin/products/<id> to medusa.admin.product.update", () => {
    expect(detectMedusaIntentKind("POST", "/admin/products/prod_01")).toBe(
      "medusa.admin.product.update",
    )
  })

  it("maps POST /store/payment-collections/<id>/payment-sessions to medusa.payment_session.create", () => {
    expect(
      detectMedusaIntentKind(
        "POST",
        "/store/payment-collections/pc_01/payment-sessions",
      ),
    ).toBe("medusa.payment_session.create")
  })

  it("differentiates POST /store/payment-collections (collection.create) from /<id>/payment-sessions (session.create)", () => {
    expect(
      detectMedusaIntentKind("POST", "/store/payment-collections"),
    ).toBe("medusa.payment_collection.create")
    expect(
      detectMedusaIntentKind(
        "POST",
        "/store/payment-collections/pc_01/payment-sessions",
      ),
    ).toBe("medusa.payment_session.create")
  })

  it("ignores query strings on the path", () => {
    expect(
      detectMedusaIntentKind("POST", "/store/carts?fields=id,total"),
    ).toBe("medusa.cart.create")
  })

  it("returns medusa.unknown for unmapped path", () => {
    expect(detectMedusaIntentKind("POST", "/store/unknown/route")).toBe(
      "medusa.unknown",
    )
  })

  it("returns medusa.unknown for known path with wrong method", () => {
    expect(detectMedusaIntentKind("PATCH", "/store/carts")).toBe(
      "medusa.unknown",
    )
  })
})

// ── MEDUSA_INTENT_KINDS sanity check ────────────────────────────────────

describe("MEDUSA_INTENT_KINDS", () => {
  it("exposes the 18 mapped kinds plus medusa.unknown", () => {
    // P0-X9 follow-up added medusa.admin.product.update +
    // medusa.payment_session.create to the union → 16 total.
    // W7-P6 added medusa.admin.order.edit.items.remove (DELETE shape) +
    // medusa.admin.order.capture_payment → 18 total.
    // audit-2026-05-24 H3 Wave-B added medusa.admin.customer.update (POST
    // /admin/customers/:id, for the LGPD cross-DB compensation chain)
    // → 19 total.
    expect(MEDUSA_INTENT_KINDS).toHaveLength(19)
    expect(new Set(MEDUSA_INTENT_KINDS).size).toBe(19)
    expect(MEDUSA_INTENT_KINDS).toContain("medusa.unknown")
    expect(MEDUSA_INTENT_KINDS).toContain("medusa.admin.product.update")
    expect(MEDUSA_INTENT_KINDS).toContain("medusa.payment_session.create")
    expect(MEDUSA_INTENT_KINDS).toContain(
      "medusa.admin.order.edit.items.remove",
    )
    expect(MEDUSA_INTENT_KINDS).toContain("medusa.admin.order.capture_payment")
    expect(MEDUSA_INTENT_KINDS).toContain("medusa.admin.customer.update")
  })
})

// ── GET pass-through ────────────────────────────────────────────────────

describe("medusaAdjudicated — GET", () => {
  it("passes GET through without adjudication / audit", async () => {
    const body = { cart: { id: "cart_01" } }
    mockFetch.mockResolvedValue(makeOkResponse(body))
    const { sink, records } = createMemoryAuditSink()

    const result = await medusaAdjudicated<unknown, { cart: { id: string } }>({
      scope: "store",
      method: "GET",
      path: "/store/carts/cart_01",
      sourceSubject: "test:get",
      auditSink: sink,
    })

    expect(result).toEqual(body)
    expect(records).toHaveLength(0)
    // Verify the underlying transport was hit exactly once.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain("/store/carts/cart_01")
    // GET should not have a body.
    expect((opts as RequestInit | undefined)?.body).toBeUndefined()
  })
})

// ── POST EXECUTE branches ───────────────────────────────────────────────

describe("medusaAdjudicated — POST EXECUTE", () => {
  it("builds an envelope with kind = medusa.cart.create and emits audit", async () => {
    const responseBody = { cart: { id: "cart_new" } }
    mockFetch.mockResolvedValue(makeOkResponse(responseBody))
    const { sink, records } = createMemoryAuditSink()

    const result = await medusaAdjudicated<{ region_id: string }, { cart: { id: string } }>({
      scope: "store",
      method: "POST",
      path: "/store/carts",
      payload: { region_id: "reg_01" },
      sourceSubject: "test:post",
      auditSink: sink,
    })

    expect(result).toEqual(responseBody)
    // Wait a microtask so the fire-and-forget audit emit completes.
    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0].envelope.kind).toBe("medusa.cart.create")
    expect(records[0].envelope.actor.principal).toBe("system")
    expect(records[0].envelope.taint).toBe("SYSTEM")
    expect(records[0].decision.kind).toBe("EXECUTE")
  })

  it("forwards a sanitized body and idempotency header to the transport", async () => {
    const responseBody = { ok: true }
    mockFetch.mockResolvedValue(makeOkResponse(responseBody))

    await medusaAdjudicated<{ variantId: string; quantity: number }, unknown>({
      scope: "store",
      method: "POST",
      path: "/store/carts/cart_01/line-items",
      payload: { variantId: "var_01", quantity: 2 },
      idempotencyKey: "idem-abc-123",
      sourceSubject: "test:add",
      auditSink: noopAuditSink,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, opts] = mockFetch.mock.calls[0]
    const init = opts as RequestInit
    expect(init.method).toBe("POST")
    expect(init.body).toBe(JSON.stringify({ variantId: "var_01", quantity: 2 }))
    const headers = init.headers as Record<string, string>
    expect(headers["Idempotency-Key"]).toBe("idem-abc-123")
  })
})

// ── Idempotency key → envelope nonce ────────────────────────────────────

describe("medusaAdjudicated — idempotency key", () => {
  it("sets envelope.nonce to the supplied idempotencyKey", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ ok: true }))
    const { sink, records } = createMemoryAuditSink()

    await medusaAdjudicated({
      scope: "store",
      method: "POST",
      path: "/store/carts",
      payload: {},
      idempotencyKey: "nonce-from-key",
      sourceSubject: "test:idem",
      auditSink: sink,
    })

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0].envelope.nonce).toBe("nonce-from-key")
  })

  it("generates a non-empty nonce when no idempotencyKey is supplied", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ ok: true }))
    const { sink, records } = createMemoryAuditSink()

    await medusaAdjudicated({
      scope: "store",
      method: "POST",
      path: "/store/carts",
      payload: {},
      sourceSubject: "test:no-idem",
      auditSink: sink,
    })

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(typeof records[0].envelope.nonce).toBe("string")
    expect(records[0].envelope.nonce.length).toBeGreaterThan(0)
  })

  it("two calls with the same idempotencyKey produce identical intentHash", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ ok: true }))
    const { sink, records } = createMemoryAuditSink()

    const args = {
      scope: "store" as const,
      method: "POST" as const,
      path: "/store/carts/cart_01/line-items",
      payload: { variantId: "var_01", quantity: 1 },
      idempotencyKey: "stable-replay-key",
      sourceSubject: "test:replay",
      auditSink: sink,
    }

    await medusaAdjudicated(args)
    await medusaAdjudicated(args)
    await Promise.resolve()

    expect(records).toHaveLength(2)
    expect(records[0].envelope.intentHash).toBe(records[1].envelope.intentHash)
  })
})

// ── Unknown path → REFUSE ───────────────────────────────────────────────

describe("medusaAdjudicated — REFUSE on unmapped path", () => {
  it("throws MedusaAdjudicateRefusedError when path is not in the map", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ ok: true }))
    const { sink, records } = createMemoryAuditSink()

    await expect(
      medusaAdjudicated({
        scope: "store",
        method: "POST",
        path: "/store/some/new/route",
        payload: {},
        sourceSubject: "test:refuse",
        auditSink: sink,
      }),
    ).rejects.toBeInstanceOf(MedusaAdjudicateRefusedError)

    // The transport must NOT have been called on REFUSE.
    expect(mockFetch).not.toHaveBeenCalled()

    // The audit record was still emitted with decision.kind = REFUSE.
    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0].decision.kind).toBe("REFUSE")
    expect(records[0].envelope.kind).toBe("medusa.unknown")
  })

  it("surfaces the pt-BR userFacing copy on the thrown error", async () => {
    let captured: MedusaAdjudicateRefusedError | null = null
    try {
      await medusaAdjudicated({
        scope: "store",
        method: "POST",
        path: "/store/no/such/route",
        payload: {},
        sourceSubject: "test:refuse-msg",
        auditSink: noopAuditSink,
      })
    } catch (err) {
      captured = err as MedusaAdjudicateRefusedError
    }
    expect(captured).not.toBeNull()
    expect(captured?.code).toBe("medusa.path.unmapped")
    expect(captured?.userFacing).toContain("Medusa")
  })
})

// ── intentKind override ──────────────────────────────────────────────────

describe("medusaAdjudicated — intentKind override", () => {
  it("accepts an explicit intentKind even when auto-detection would return unknown", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ ok: true }))
    const { sink, records } = createMemoryAuditSink()

    await medusaAdjudicated({
      scope: "store",
      method: "POST",
      path: "/store/custom/route", // would auto-detect as medusa.unknown
      intentKind: "medusa.cart.create",
      payload: {},
      sourceSubject: "test:override",
      auditSink: sink,
    })

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0].envelope.kind).toBe("medusa.cart.create")
    expect(records[0].decision.kind).toBe("EXECUTE")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// ── REQUEST_CONFIRMATION / ESCALATE — typed error ───────────────────────

describe("medusaAdjudicated — needs-review error class", () => {
  // The wrapper's inline policy never emits REQUEST_CONFIRMATION /
  // ESCALATE today, so we cannot trigger these branches end-to-end
  // without extending the policy. The error class is still tested
  // structurally: it carries the decision shape so adopters can read
  // `prompt` / `to` / `reason` off the thrown error.
  it("carries the decision payload through the error class", () => {
    const confirmDecision = {
      kind: "REQUEST_CONFIRMATION" as const,
      prompt: "Confirm this admin action?",
      basis: [],
    }
    const err = new MedusaAdjudicateNeedsReviewError(confirmDecision)
    expect(err.decision).toBe(confirmDecision)
    expect(err.message).toContain("Confirm this admin action?")

    const escalateDecision = {
      kind: "ESCALATE" as const,
      to: "human" as const,
      reason: "Force-cancel requires staff review",
      basis: [],
    }
    const escErr = new MedusaAdjudicateNeedsReviewError(escalateDecision)
    expect(escErr.decision).toBe(escalateDecision)
    expect(escErr.message).toContain("Force-cancel requires staff review")
  })
})

// ── Audit sink failure non-blocking ─────────────────────────────────────

describe("medusaAdjudicated — audit fail-open", () => {
  it("does not propagate audit sink errors to the caller", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ ok: true }))
    const failingSink: AuditSink = {
      async emit() {
        throw new Error("nats broker down")
      },
    }
    const errorLog = vi.fn()

    const result = await medusaAdjudicated<unknown, { ok: boolean }>({
      scope: "store",
      method: "POST",
      path: "/store/carts",
      payload: {},
      sourceSubject: "test:audit-fail",
      auditSink: failingSink,
      log: { error: errorLog },
    })

    expect(result).toEqual({ ok: true })
    // Give the fire-and-forget emit a microtask to settle.
    await new Promise((r) => setTimeout(r, 0))
    expect(errorLog).toHaveBeenCalled()
  })

  // audit-2026-05-24 H2 (A1): `auditSink` is required at the type level.
  // The legacy "works without an audit sink" semantics no longer exist;
  // tests that don't want a real emit pass a `noopAuditSink` instead.
  it("accepts a no-op audit sink (callers MUST pass a sink post-H2 A1)", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ ok: true }))
    const result = await medusaAdjudicated<unknown, { ok: boolean }>({
      scope: "store",
      method: "POST",
      path: "/store/carts",
      payload: {},
      sourceSubject: "test:noop-sink",
      auditSink: noopAuditSink,
    })
    expect(result).toEqual({ ok: true })
  })
})

// ── Admin scope routing ─────────────────────────────────────────────────

describe("medusaAdjudicated — admin scope", () => {
  it("routes admin paths through the admin transport (Bearer JWT)", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/auth/user/emailpass")) {
        return Promise.resolve(makeAuthResponse())
      }
      return Promise.resolve(makeOkResponse({ order: { id: "order_01" } }))
    })
    const { sink, records } = createMemoryAuditSink()

    await medusaAdjudicated({
      scope: "admin",
      method: "POST",
      path: "/admin/orders/order_01/cancel",
      payload: { reason: "stale" },
      sourceSubject: "test:admin",
      auditSink: sink,
    })

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0].envelope.kind).toBe("medusa.admin.order.cancel")

    // Verify the admin auth header was attached to the underlying call.
    const adminCall = mockFetch.mock.calls.find(
      ([u]) => typeof u === "string" && u.includes("/admin/orders/order_01/cancel"),
    )
    expect(adminCall).toBeDefined()
    const opts = adminCall![1] as RequestInit
    const headers = opts.headers as Record<string, string>
    expect(headers["Authorization"]).toMatch(/^Bearer /)
  })
})
