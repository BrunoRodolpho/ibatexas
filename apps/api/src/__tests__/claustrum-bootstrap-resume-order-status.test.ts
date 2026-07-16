// claustrum-bootstrap-resume-order-status.test.ts — FE-T05b (live-disproof
// follow-up): a FOCUSED unit test of `enrichResumeState`'s NEW
// `order.status.transition` branch, calling the REAL exported function
// directly (not a hand-authored mirror — a hand-rolled mirror of a WRONG
// assumption is exactly what let the original bug ship: intent_audit rows
// 3362/3366 on dev — park worked, "sim" resume REFUSEd order.not_found
// because `enrichResumeState`'s generic customer-scoped fallback silently
// no-ops for the ops plane's `staff:<id>` "customerId", never populating
// `ctx.orderId` even though the order existed and the parked payload
// carried its id).
//
// `@ibatexas/domain`'s `createOrderQueryService` is mocked (this repo's
// established idiom — see order-cancel-governance.test.ts) so the test stays
// DB-free; every OTHER branch of `enrichResumeState` (refund/price/special/
// the generic customer-plane fallback) is untouched by these envelopes and
// is regression-covered separately by its own e2e suite.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { enrichResumeState } from "../claustrum-bootstrap.js";

const mockGetById = vi.hoisted(() => vi.fn());

// A flat `vi.mock` providing only `createOrderQueryService` would silently
// stub out the OTHER 10 named exports `claustrum-bootstrap.ts` imports from
// `@ibatexas/domain` (`prisma`, `claustrumMemoryPrisma`,
// `createOrderCommandService`, `createOrderEventLogService`,
// `createPaymentCommandService`, `createPaymentQueryService`,
// `createOpsAlertService`, `createIncidentService`, `createScheduleService`,
// `createDailySpecialService`) as `undefined` — a real fragility risk given
// this repo's vi.mock history (PR #248 saga: a flat domain mock silently
// broke an unrelated code path that happened to share the mocked module).
// `@ibatexas/domain`'s `prisma` / `claustrumMemoryPrisma` are lazy `Proxy`
// singletons (see client.ts / claustrum-memory-client.ts — PrismaClient
// construction defers to first property access) and `index.ts` has no
// top-level side effects, so `importOriginal` is safe here: only
// `createOrderQueryService` is overridden, every other export stays REAL
// (inert — this test only ever constructs `order.status.transition`
// envelopes, so no other `enrichResumeState` branch, and thus no other
// domain factory, is ever invoked).
vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/domain")>();
  return { ...actual, createOrderQueryService: () => ({ getById: mockGetById }) };
});

beforeEach(() => {
  mockGetById.mockReset();
});

function parkedEnvelope(orderId: string, staffId = "owner1"): IntentEnvelope {
  return buildEnvelope({
    kind: "order.status.transition",
    payload: { orderId, newStatus: "ready" },
    actor: { principal: "user", sessionId: `admin:${staffId}`, role: "OWNER" },
    taint: "UNTRUSTED",
    nonce: "n-resume-test",
    createdAt: "2026-07-16T12:00:00.000Z",
  }) as IntentEnvelope;
}

/** The capsule's bare, current-turn state for the ops system channel —
 *  `{channel:"system", customerId:"staff:<id>"}` (opsTenantResolver's shape,
 *  ops-e2e-harness.ts) — what `Adjudicator.resume()` actually receives. */
const OPS_CAPSULE_STATE = { channel: "system", customerId: "staff:owner1" };

describe("enrichResumeState — order.status.transition (FE-T05b)", () => {
  it("re-projects ctx.orderId from a FRESH read of the PINNED orderId (the fix)", async () => {
    mockGetById.mockResolvedValueOnce({
      customerId: "cust_recent",
      paymentMethod: "pix",
      paymentStatus: "paid",
      totalInCentavos: 8_900,
      fulfillmentStatus: "preparing",
    });

    const state = await enrichResumeState(parkedEnvelope("order_recent"), OPS_CAPSULE_STATE);

    expect(mockGetById).toHaveBeenCalledWith("order_recent");
    expect(state).toEqual({
      ctx: {
        channel: "web",
        customerId: "cust_recent",
        cartId: null,
        orderId: "order_recent",
        fulfillmentStatus: "preparing",
      },
    });
  });

  it("reproduces the LIVE BUG'S SYMPTOM if the order lookup misses: ctx.orderId is null (honest REFUSE, not a stale EXECUTE)", async () => {
    mockGetById.mockResolvedValueOnce(null);

    const state = await enrichResumeState(parkedEnvelope("order_deleted"), OPS_CAPSULE_STATE);

    expect(state).toEqual({
      ctx: { channel: "web", customerId: null, cartId: null, orderId: null, fulfillmentStatus: null },
    });
  });

  it("a since-parked STATUS CHANGE is reflected FRESH — resume adjudicates against the CURRENT status, not the parked snapshot", async () => {
    mockGetById.mockResolvedValueOnce({
      customerId: "cust_recent",
      paymentMethod: "pix",
      paymentStatus: "paid",
      totalInCentavos: 8_900,
      // The order advanced past "preparing" since the turn parked.
      fulfillmentStatus: "delivered",
    });

    const state = (await enrichResumeState(parkedEnvelope("order_recent"), OPS_CAPSULE_STATE)) as {
      ctx: { fulfillmentStatus: string | null };
    };

    expect(state.ctx.fulfillmentStatus).toBe("delivered");
  });

  it("a read THROW is fail-closed to a null ctx.orderId (never propagates, never silently EXECUTEs)", async () => {
    mockGetById.mockRejectedValueOnce(new Error("db down"));

    const state = await enrichResumeState(parkedEnvelope("order_recent"), OPS_CAPSULE_STATE);

    expect(state).toEqual({
      ctx: { channel: "web", customerId: null, cartId: null, orderId: null, fulfillmentStatus: null },
    });
  });

  it("an empty pinned orderId (malformed payload) short-circuits WITHOUT a DB read", async () => {
    const state = await enrichResumeState(parkedEnvelope(""), OPS_CAPSULE_STATE);

    expect(mockGetById).not.toHaveBeenCalled();
    expect(state).toEqual({
      ctx: { channel: "web", customerId: null, cartId: null, orderId: null, fulfillmentStatus: null },
    });
  });

  it("does NOT engage for a non-admin session (falls through to the generic customer-plane path)", async () => {
    const nonAdminEnvelope = buildEnvelope({
      kind: "order.status.transition",
      payload: { orderId: "order_recent", newStatus: "ready" },
      actor: { principal: "llm", sessionId: "web:sess-1" },
      taint: "UNTRUSTED",
      nonce: "n-nonadmin",
      createdAt: "2026-07-16T12:00:00.000Z",
    }) as IntentEnvelope;

    await enrichResumeState(nonAdminEnvelope, { channel: "web", customerId: "cust_1" });

    // The order.status.transition branch's own DB read never fires — proves
    // the `admin:` session guard, not just "some code ran without throwing".
    expect(mockGetById).not.toHaveBeenCalled();
  });
});
