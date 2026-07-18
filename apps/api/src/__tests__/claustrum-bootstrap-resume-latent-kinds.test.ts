// claustrum-bootstrap-resume-latent-kinds.test.ts — BKL-164: the four LATENT
// ops kinds pre-wired into `enrichResumeState`'s table (product.availability.set,
// ops.alert.resolve.staff, incident.ticket.close.staff, schedule.override.set).
//
// No confirm-forcing guard parks any of these today, so the resume cycle is
// never exercised live — but the table entries must re-project each kind's
// plan-stage `{ ctx, <slot> }` SystemState from a FRESH re-read of the parked
// reference, exactly like the wired kinds (refund/price/special/status/note),
// instead of falling through to the customer-scoped `resolveAndAssemble` that
// no-ops for the ops plane's `staff:<id>` and would REFUSE a valid "sim".
//
// The reads are mocked (this repo's `importOriginal` idiom — see
// claustrum-bootstrap-resume-order-status.test.ts) so the test stays DB-free
// and only overrides the specific factory / egress; every other export of the
// mocked module stays REAL.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { enrichResumeState } from "../claustrum-bootstrap.js";
import { todayInRestaurantTz } from "../routes/admin/_date-defaults.js";

const mockAlertGet = vi.hoisted(() => vi.fn());
const mockIncidentGet = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/domain")>();
  return {
    ...actual,
    createOpsAlertService: () => ({ get: mockAlertGet }),
    createIncidentService: () => ({ get: mockIncidentGet }),
  };
});

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return { ...actual, medusaAdmin: mockMedusaAdmin };
});

beforeEach(() => {
  mockAlertGet.mockReset();
  mockIncidentGet.mockReset();
  mockMedusaAdmin.mockReset();
});

function parked(
  kind: string,
  payload: Record<string, unknown>,
  staffId = "owner1",
): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "user", sessionId: `admin:${staffId}`, role: "OWNER" },
    taint: "UNTRUSTED",
    nonce: "n-latent",
    createdAt: "2026-07-18T12:00:00.000Z",
  }) as IntentEnvelope;
}

/** The capsule's bare current-turn state (opsTenantResolver's shape). */
const OPS_CAPSULE_STATE = { channel: "system", customerId: "staff:owner1" };
const tenantId = process.env.KERNEL_TENANT_ID ?? "ibatexas";
const staffCtx = { channel: "staff", customerId: null, staffId: "owner1", tenantId };

describe("enrichResumeState — BKL-164 latent pre-wired ops kinds", () => {
  describe("product.availability.set", () => {
    it("re-projects { ctx, product } from a FRESH product read of the pinned productId", async () => {
      mockMedusaAdmin.mockResolvedValueOnce({
        product: { id: "prod_1", status: "published", title: "Picanha" },
      });
      const state = await enrichResumeState(
        parked("product.availability.set", { productId: "prod_1", available: false }),
        OPS_CAPSULE_STATE,
      );
      expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/products/prod_1");
      // Mirrors the plan-stage `{id,status}` product shape (name dropped).
      expect(state).toEqual({ ctx: staffCtx, product: { id: "prod_1", status: "published" } });
    });

    it("a missing product ⇒ product:null (clean product_not_found REFUSE)", async () => {
      mockMedusaAdmin.mockResolvedValueOnce({ product: undefined });
      const state = await enrichResumeState(
        parked("product.availability.set", { productId: "ghost", available: true }),
        OPS_CAPSULE_STATE,
      );
      expect(state).toEqual({ ctx: staffCtx, product: null });
    });

    it("a read THROW is fail-closed to product:null", async () => {
      mockMedusaAdmin.mockRejectedValueOnce(new Error("medusa down"));
      const state = await enrichResumeState(
        parked("product.availability.set", { productId: "prod_1", available: true }),
        OPS_CAPSULE_STATE,
      );
      expect(state).toEqual({ ctx: staffCtx, product: null });
    });

    it("an empty productId short-circuits WITHOUT a read", async () => {
      const state = await enrichResumeState(
        parked("product.availability.set", { available: true }),
        OPS_CAPSULE_STATE,
      );
      expect(mockMedusaAdmin).not.toHaveBeenCalled();
      expect(state).toEqual({ ctx: staffCtx, product: null });
    });
  });

  describe("ops.alert.resolve.staff", () => {
    it("re-projects { ctx, alert } from a FRESH alert read", async () => {
      mockAlertGet.mockResolvedValueOnce({ id: "alert_1", status: "OPEN" });
      const state = await enrichResumeState(
        parked("ops.alert.resolve.staff", { alertId: "alert_1" }),
        OPS_CAPSULE_STATE,
      );
      expect(mockAlertGet).toHaveBeenCalledWith("alert_1");
      expect(state).toEqual({ ctx: staffCtx, alert: { id: "alert_1", status: "OPEN" } });
    });

    it("a missing alert / a read throw / an empty id all fail closed to alert:null (no read on empty)", async () => {
      mockAlertGet.mockResolvedValueOnce(null);
      expect(
        await enrichResumeState(parked("ops.alert.resolve.staff", { alertId: "ghost" }), OPS_CAPSULE_STATE),
      ).toEqual({ ctx: staffCtx, alert: null });

      mockAlertGet.mockRejectedValueOnce(new Error("db down"));
      expect(
        await enrichResumeState(parked("ops.alert.resolve.staff", { alertId: "alert_1" }), OPS_CAPSULE_STATE),
      ).toEqual({ ctx: staffCtx, alert: null });

      mockAlertGet.mockClear();
      expect(
        await enrichResumeState(parked("ops.alert.resolve.staff", {}), OPS_CAPSULE_STATE),
      ).toEqual({ ctx: staffCtx, alert: null });
      expect(mockAlertGet).not.toHaveBeenCalled();
    });
  });

  describe("incident.ticket.close.staff", () => {
    it("re-projects { ctx, incident } from a FRESH incident read; null / throw / empty ⇒ incident:null", async () => {
      mockIncidentGet.mockResolvedValueOnce({ id: "inc_1", status: "OPEN" });
      expect(
        await enrichResumeState(parked("incident.ticket.close.staff", { incidentId: "inc_1" }), OPS_CAPSULE_STATE),
      ).toEqual({ ctx: staffCtx, incident: { id: "inc_1", status: "OPEN" } });
      expect(mockIncidentGet).toHaveBeenCalledWith("inc_1");

      mockIncidentGet.mockResolvedValueOnce(null);
      expect(
        await enrichResumeState(parked("incident.ticket.close.staff", { incidentId: "ghost" }), OPS_CAPSULE_STATE),
      ).toEqual({ ctx: staffCtx, incident: null });

      mockIncidentGet.mockClear();
      expect(
        await enrichResumeState(parked("incident.ticket.close.staff", {}), OPS_CAPSULE_STATE),
      ).toEqual({ ctx: staffCtx, incident: null });
      expect(mockIncidentGet).not.toHaveBeenCalled();
    });
  });

  describe("schedule.override.set (keyless — no entity read)", () => {
    it("re-projects { ctx, schedule: { today } } with a FRESH today, WITHOUT any read", async () => {
      const state = await enrichResumeState(
        parked("schedule.override.set", { date: "2026-07-20", isOpen: false }),
        OPS_CAPSULE_STATE,
      );
      expect(state).toEqual({ ctx: staffCtx, schedule: { today: todayInRestaurantTz() } });
      expect(mockMedusaAdmin).not.toHaveBeenCalled();
      expect(mockAlertGet).not.toHaveBeenCalled();
    });
  });

  it("does NOT engage for a non-admin session (falls through to the generic customer-plane path)", async () => {
    const nonAdmin = buildEnvelope({
      kind: "product.availability.set",
      payload: { productId: "prod_1", available: false },
      actor: { principal: "llm", sessionId: "web:sess-1" },
      taint: "UNTRUSTED",
      nonce: "n-nonadmin",
      createdAt: "2026-07-18T12:00:00.000Z",
    }) as IntentEnvelope;
    await enrichResumeState(nonAdmin, { channel: "web", customerId: "cust_1" });
    expect(mockMedusaAdmin).not.toHaveBeenCalled();
  });
});
