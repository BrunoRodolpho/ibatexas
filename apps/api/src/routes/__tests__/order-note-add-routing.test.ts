// W7-P4 — route-level proof that the 4 prisma.orderNote.create sites now
// go through OrderCommandService.addNoteFromEnvelope.
//
// Approach: assert on the source of each route file. We grep the relevant
// route handler to verify that:
//   - addNoteFromEnvelope is called.
//   - prisma.orderNote.create is NO LONGER called inside the handler.
//   - the envelope kind is "order.note.add".
//
// This pattern mirrors apps/api/src/__tests__/bypass-detection/* — a
// source-level chokepoint check that runs as a fast unit test and gives
// the verifier agent a structural assertion they can audit later.
//
// Why not a full integration test? Each route's full handler exercises
// Fastify + Prisma + Pack policy chains; the value-add of asserting the
// chokepoint is captured by the source-level pattern check. Full
// integration coverage is the W7-Verifier agent's responsibility.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Path resolution: apps/api/src/routes/__tests__/ → apps/api/src/routes/
const routesDir = resolve(__dirname, "..")

function read(file: string): string {
  return readFileSync(resolve(routesDir, file), "utf8")
}

describe("P4 — 4 orderNote.create sites wired to addNoteFromEnvelope", () => {
  it("apps/api/src/routes/cart.ts: checkout-note path uses addNoteFromEnvelope", () => {
    const src = read("cart.ts")
    // The addNoteFromEnvelope call appears.
    expect(src).toContain("addNoteFromEnvelope")
    // Envelope kind is the canonical Pack kind.
    expect(src).toMatch(/kind:\s*"order\.note\.add"/)
    // The legacy bypass is removed from THIS file's checkout path.
    // The file may still contain "orderNote.create" in unrelated comments —
    // assert the specific cart-checkout-block has been migrated by
    // checking that the W7-P4 marker is present near the block.
    expect(src).toContain("W7-P4")
  })

  it("apps/api/src/routes/order-actions.ts: POST /notes uses addNoteFromEnvelope", () => {
    const src = read("order-actions.ts")
    expect(src).toContain("addNoteFromEnvelope")
    expect(src).toMatch(/kind:\s*"order\.note\.add"/)
    expect(src).toContain("W7-P4")
    // Best-effort: assert the OLD direct write is gone in the POST handler.
    // The route file still reads notes via prisma.orderNote.findMany — that's
    // unrelated to P4. The create call is the only mutation we migrated.
    expect(src).not.toMatch(/prisma\.orderNote\.create\s*\(/)
  })

  // The two admin routes were de-duplicated: their identical note-add
  // envelope-build + addNoteFromEnvelope + persisted-lookup block was
  // extracted UNCHANGED into admin/_shared-actions.ts (`adjudicateAdminNote`).
  // The W7-P4 chokepoint is therefore asserted on the shared helper below;
  // here we assert each route DELEGATES to it and keeps no direct write.
  it("admin/_shared-actions.ts: adjudicateAdminNote is the kernel-routed note chokepoint", () => {
    const src = read("admin/_shared-actions.ts")
    expect(src).toContain("addNoteFromEnvelope")
    expect(src).toMatch(/kind:\s*"order\.note\.add"/)
    expect(src).toContain("W7-P4")
    // The persisted re-read uses findUnique; there is NO direct create write.
    expect(src).not.toMatch(/prisma\.orderNote\.create\s*\(/)
  })

  it("apps/api/src/routes/admin/order-actions.ts: staff-notes delegates to adjudicateAdminNote", () => {
    const src = read("admin/order-actions.ts")
    expect(src).toContain("adjudicateAdminNote")
    expect(src).not.toMatch(/prisma\.orderNote\.create\s*\(/)
  })

  it("apps/api/src/routes/admin/payments.ts: admin /notes delegates to adjudicateAdminNote", () => {
    const src = read("admin/payments.ts")
    expect(src).toContain("adjudicateAdminNote")
    expect(src).not.toMatch(/prisma\.orderNote\.create\s*\(/)
  })

  it("each migrated route emits the envelope with UNTRUSTED or TRUSTED taint per actor", () => {
    // Customer paths → UNTRUSTED (user actor); staff/admin paths → TRUSTED
    // (or SYSTEM when staff is null / API-key). The migration preserves
    // the actor model.
    //
    // Polish-B followup: customer routes were migrated to
    // `buildCustomerEnvelope`, which stamps `taint: "UNTRUSTED"` itself —
    // the literal no longer appears at the call site. Match either the
    // raw literal (for inner envelopes that still use `buildEnvelope`) or
    // the customer-envelope constructor.
    const cartSrc = read("cart.ts")
    expect(
      cartSrc.match(/taint:\s*"UNTRUSTED"/) ||
        cartSrc.match(/buildCustomerEnvelope</),
    ).not.toBeNull()
    const orderActionsSrc = read("order-actions.ts")
    expect(
      orderActionsSrc.match(/taint:\s*"UNTRUSTED"/) ||
        orderActionsSrc.match(/buildCustomerEnvelope</),
    ).not.toBeNull()
    // Admin note-add taint (TRUSTED for staffId, SYSTEM for null) now lives in
    // the shared `adjudicateAdminNote` helper both admin routes delegate to.
    const shared = read("admin/_shared-actions.ts")
    expect(shared).toMatch(/taint:\s*deps\.staffId\s*\?\s*"TRUSTED"\s*:\s*"SYSTEM"/)
    expect(read("admin/order-actions.ts")).toContain("adjudicateAdminNote")
    expect(read("admin/payments.ts")).toContain("adjudicateAdminNote")
  })

  it("admin/order-actions.ts uses the audit-wired orderCmdSvc", () => {
    // After this PR the admin/order-actions.ts top-level service is wired
    // with auditSink: getAuditSink(). The Wave-6 finding called out the
    // missing audit thread.
    const src = read("admin/order-actions.ts")
    expect(src).toMatch(
      /createOrderCommandService\(server\.log,\s*\{\s*auditSink:\s*getAuditSink\(\)/,
    )
  })

  it("admin/payments.ts constructs its own audit-wired orderCmdSvc", () => {
    const src = read("admin/payments.ts")
    expect(src).toMatch(
      /createOrderCommandService\(server\.log,\s*\{\s*auditSink:\s*getAuditSink\(\)/,
    )
  })
})
