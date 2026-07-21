// claustrum-bootstrap-resume-order-note.test.ts — FE-D14: a FOCUSED unit test
// of `enrichResumeState`'s NEW `order.note.add` branch, calling the REAL
// exported function directly (not a hand-authored mirror — the FE-T05b saga
// proved a hand-rolled mirror of a WRONG assumption is exactly what let the
// original order.status.transition resume gap ship: intent_audit 3362/3366).
//
// `order.note.add` shares the SAME latent `enrichResumeState` gap FE-T05b
// fixed for `order.status.transition`: without a per-kind branch a parked ops
// note-add resume falls through to the generic customer-scoped fallback, which
// silently no-ops for the ops plane's `staff:<id>` "customerId" and never
// populates `ctx.orderId` — `requireOrderIdForMutation` would then REFUSE
// `order.not_found` even though the parked payload carries the resolver-pinned
// id. The gap is UNREACHABLE today (no confirm-forcing guard parks an
// order.note.add), so this test asserts the pre-wired resume assembly directly.
//
// `@ibatexas/domain`'s `createOrderQueryService` is mocked (this repo's
// established idiom) so the test stays DB-free; every OTHER branch of
// `enrichResumeState` is untouched by these envelopes.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { enrichResumeState } from "../claustrum-bootstrap.js";

const mockGetById = vi.hoisted(() => vi.fn());

// A flat `vi.mock` providing only `createOrderQueryService` would silently stub
// out the OTHER 10 named exports `claustrum-bootstrap.ts` imports from
// `@ibatexas/domain` (`prisma`, `claustrumMemoryPrisma`, and 8 other service
// factories) as `undefined` — a real fragility risk given this repo's vi.mock
// history (PR #248 saga). `@ibatexas/domain`'s `prisma` / `claustrumMemoryPrisma`
// are lazy `Proxy` singletons (PrismaClient construction defers to first
// property access) and `index.ts` has no top-level side effects, so
// `importOriginal` is safe: only `createOrderQueryService` is overridden, every
// other export stays REAL (inert — this test only ever constructs
// `order.note.add` envelopes, so no other `enrichResumeState` branch, and thus
// no other domain factory, is ever invoked).
vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/domain")>();
  return { ...actual, createOrderQueryService: () => ({ getById: mockGetById }) };
});

beforeEach(() => {
  mockGetById.mockReset();
});

function parkedEnvelope(orderId: string, staffId = "owner1"): IntentEnvelope {
  return buildEnvelope({
    kind: "order.note.add",
    payload: { orderId, body: "cliente pediu sem cebola" },
    actor: { principal: "user", sessionId: `admin:${staffId}`, role: "OWNER" },
    taint: "UNTRUSTED",
    nonce: "n-note-resume-test",
    createdAt: "2026-07-17T12:00:00.000Z",
  }) as IntentEnvelope;
}

/** The capsule's bare, current-turn state for the ops system channel —
 *  `{channel:"system", customerId:"staff:<id>"}` (opsTenantResolver's shape,
 *  ops-e2e-harness.ts) — what `Adjudicator.resume()` actually receives. */
const OPS_CAPSULE_STATE = { channel: "system", customerId: "staff:owner1" };

describe("enrichResumeState — order.note.add (FE-D14)", () => {
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
        paymentMethod: "pix",
        paymentStatus: "paid",
        totalInCentavos: 8_900,
      },
    });
  });

  it("reproduces the LATENT GAP'S SYMPTOM if the order lookup misses: ctx.orderId is null (honest REFUSE, not a stale EXECUTE)", async () => {
    mockGetById.mockResolvedValueOnce(null);

    const state = await enrichResumeState(parkedEnvelope("order_deleted"), OPS_CAPSULE_STATE);

    expect(state).toEqual({
      ctx: {
        channel: "web",
        customerId: null,
        cartId: null,
        orderId: null,
        paymentMethod: null,
        paymentStatus: null,
        totalInCentavos: 0,
      },
    });
  });

  it("re-projects the order's CURRENT ctx FRESH — resume assembles from the live read, not the parked snapshot", async () => {
    mockGetById.mockResolvedValueOnce({
      customerId: "cust_recent",
      paymentMethod: "card",
      // Payment settled between park and resume.
      paymentStatus: "paid",
      totalInCentavos: 12_500,
      fulfillmentStatus: "ready",
    });

    const state = (await enrichResumeState(parkedEnvelope("order_recent"), OPS_CAPSULE_STATE)) as {
      ctx: { paymentStatus: string | null; totalInCentavos: number };
    };

    expect(state.ctx.paymentStatus).toBe("paid");
    expect(state.ctx.totalInCentavos).toBe(12_500);
  });

  it("a read THROW is fail-closed to a null ctx.orderId (never propagates, never silently EXECUTEs)", async () => {
    mockGetById.mockRejectedValueOnce(new Error("db down"));

    const state = await enrichResumeState(parkedEnvelope("order_recent"), OPS_CAPSULE_STATE);

    expect(state).toEqual({
      ctx: {
        channel: "web",
        customerId: null,
        cartId: null,
        orderId: null,
        paymentMethod: null,
        paymentStatus: null,
        totalInCentavos: 0,
      },
    });
  });

  it("an empty pinned orderId (malformed payload) short-circuits WITHOUT a DB read", async () => {
    const state = await enrichResumeState(parkedEnvelope(""), OPS_CAPSULE_STATE);

    expect(mockGetById).not.toHaveBeenCalled();
    expect(state).toEqual({
      ctx: {
        channel: "web",
        customerId: null,
        cartId: null,
        orderId: null,
        paymentMethod: null,
        paymentStatus: null,
        totalInCentavos: 0,
      },
    });
  });

  it("does NOT engage for a non-admin session (falls through to the generic customer-plane path)", async () => {
    // Unlike order.status.transition (which the customer-plane resolver does not
    // recognize, so its non-admin fall-through no-ops without a read),
    // order.note.add IS a customer-plane kind — the generic `resolveAndAssemble`
    // fallback issues a CUSTOMER-SCOPED read `getById(orderId, {customerId})`.
    // The ops admin branch, by contrast, calls `getById(orderId)` with a SINGLE
    // arg and no scoping object. Asserting the call carries the customer scope
    // proves the generic path ran and the `admin:` branch did NOT engage.
    mockGetById.mockResolvedValueOnce(null);
    const nonAdminEnvelope = buildEnvelope({
      kind: "order.note.add",
      payload: { orderId: "order_recent", body: "nota" },
      actor: { principal: "llm", sessionId: "web:sess-1" },
      taint: "UNTRUSTED",
      nonce: "n-note-nonadmin",
      createdAt: "2026-07-17T12:00:00.000Z",
    }) as IntentEnvelope;

    await enrichResumeState(nonAdminEnvelope, { channel: "web", customerId: "cust_1" });

    expect(mockGetById).toHaveBeenCalledTimes(1);
    expect(mockGetById).toHaveBeenCalledWith("order_recent", { customerId: "cust_1" });
  });
});
