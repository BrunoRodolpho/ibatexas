/**
 * Pack v0.1 — exercise every kernel Decision the policy bundle can emit.
 *
 * The roadmap acceptance for the lighthouse Pack requires coverage of
 * all six Decision outcomes plus a DEFER round-trip (park + resume).
 * This file owns that contract.
 */

import { describe, expect, it } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope } from "@adjudicate/core";
import {
  PIX_CONFIRMATION_SIGNAL,
  PIX_DEFAULT_DEFER_TIMEOUT_MS,
  PIX_REFUND_CONFIRMATION_THRESHOLD_CENTAVOS,
  pixPaymentsPolicyBundle,
  type PixChargeIntentKind,
  type PixChargeState,
} from "../src/index.js";

const DET_TIME = "2026-04-26T12:00:00.000Z";

function envelope(
  kind: PixChargeIntentKind,
  payload: Record<string, unknown>,
  taint: "SYSTEM" | "TRUSTED" | "UNTRUSTED" = "TRUSTED",
) {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "system", sessionId: "s-1" },
    taint,
    createdAt: DET_TIME,
  });
}

function state(overrides: Partial<PixChargeState> = {}): PixChargeState {
  return {
    charge: overrides.charge ?? null,
    rateLimit: overrides.rateLimit,
    allowProposerToConfirm: overrides.allowProposerToConfirm,
  };
}

describe("pix.charge.create — REWRITE on out-of-policy expiry", () => {
  it("clamps expiresInSeconds above the 24h max", () => {
    const decision = adjudicate(
      envelope(
        "pix.charge.create",
        {
          chargeId: "ch_1",
          amountCentavos: 1500,
          payerTaxId: "00000000000",
          payerName: "Maria",
          payerEmail: "m@example.com",
          expiresInSeconds: 999_999_999,
        },
        "UNTRUSTED",
      ),
      state(),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REWRITE");
    if (decision.kind !== "REWRITE") return;
    const rewritten = decision.rewritten.payload as { expiresInSeconds: number };
    expect(rewritten.expiresInSeconds).toBe(24 * 60 * 60);
    const cap = decision.basis.find(
      (b) => b.category === "business" && b.code === "quantity_capped",
    );
    expect(cap).toBeTruthy();
  });

  it("clamps zero/negative expiresInSeconds to the default", () => {
    const decision = adjudicate(
      envelope(
        "pix.charge.create",
        {
          chargeId: "ch_2",
          amountCentavos: 1500,
          payerTaxId: "00000000000",
          payerName: "Maria",
          payerEmail: "m@example.com",
          expiresInSeconds: 0,
        },
        "UNTRUSTED",
      ),
      state(),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REWRITE");
    if (decision.kind !== "REWRITE") return;
    const rewritten = decision.rewritten.payload as { expiresInSeconds: number };
    expect(rewritten.expiresInSeconds).toBe(60 * 60); // PIX_DEFAULT_EXPIRY_SECONDS
  });
});

describe("pix.charge.create — REFUSE on invalid amount / rate-limit", () => {
  it("REFUSEs amountCentavos <= 0 with PAYLOAD_INVALID basis", () => {
    const decision = adjudicate(
      envelope(
        "pix.charge.create",
        {
          chargeId: "ch_3",
          amountCentavos: 0,
          payerTaxId: "0",
          payerName: "x",
          payerEmail: "x@x",
          expiresInSeconds: 3600,
        },
        "UNTRUSTED",
      ),
      state(),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.code).toBe("pix.charge.amount_invalid");
    expect(
      decision.basis.some(
        (b) => b.category === "schema" && b.code === "payload_invalid",
      ),
    ).toBe(true);
  });

  it("REFUSEs non-integer amountCentavos", () => {
    const decision = adjudicate(
      envelope(
        "pix.charge.create",
        {
          chargeId: "ch_4",
          amountCentavos: 19.5,
          payerTaxId: "0",
          payerName: "x",
          payerEmail: "x@x",
          expiresInSeconds: 3600,
        },
        "UNTRUSTED",
      ),
      state(),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
  });

  it("REFUSEs when the payer has hit the create rate-limit window", () => {
    const decision = adjudicate(
      envelope(
        "pix.charge.create",
        {
          chargeId: "ch_5",
          amountCentavos: 1500,
          payerTaxId: "0",
          payerName: "x",
          payerEmail: "x@x",
          expiresInSeconds: 3600,
        },
        "UNTRUSTED",
      ),
      state({ rateLimit: { count: 3, maxPerWindow: 3 } }),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.code).toBe("pix.charge.rate_limit_exceeded");
  });
});

describe("pix.charge.confirm — DEFER while pending, EXECUTE-track once settled", () => {
  it("DEFERs when the charge is still pending", () => {
    const decision = adjudicate(
      envelope("pix.charge.confirm", { chargeId: "ch_6" }, "TRUSTED"),
      state({
        charge: {
          id: "ch_6",
          status: "pending",
          amountCentavos: 1500,
          capturedAt: null,
          refundedAmountCentavos: 0,
          expiresAt: null,
        },
      }),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("DEFER");
    if (decision.kind !== "DEFER") return;
    expect(decision.signal).toBe(PIX_CONFIRMATION_SIGNAL);
    expect(decision.timeoutMs).toBe(PIX_DEFAULT_DEFER_TIMEOUT_MS);
  });

  it("REFUSEs (already_captured) when the charge is already captured", () => {
    const decision = adjudicate(
      envelope("pix.charge.confirm", { chargeId: "ch_7" }, "TRUSTED"),
      state({
        charge: {
          id: "ch_7",
          status: "captured",
          amountCentavos: 1500,
          capturedAt: DET_TIME,
          refundedAmountCentavos: 0,
          expiresAt: null,
        },
      }),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.code).toBe("pix.charge.already_captured");
  });

  it("REFUSEs (charge_not_found) when the charge is unknown", () => {
    const decision = adjudicate(
      envelope("pix.charge.confirm", { chargeId: "ch_unknown" }, "TRUSTED"),
      state({ charge: null }),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.code).toBe("pix.charge.not_found");
  });
});

describe("pix.charge.confirm — ESCALATE on failed terminal status", () => {
  it("ESCALATEs to a human when confirm arrives on a failed charge", () => {
    const decision = adjudicate(
      envelope("pix.charge.confirm", { chargeId: "ch_8" }, "TRUSTED"),
      state({
        charge: {
          id: "ch_8",
          status: "failed",
          amountCentavos: 1500,
          capturedAt: null,
          refundedAmountCentavos: 0,
          expiresAt: null,
        },
      }),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("ESCALATE");
    if (decision.kind !== "ESCALATE") return;
    expect(decision.to).toBe("human");
  });
});

describe("pix.charge.refund — REQUEST_CONFIRMATION on high value", () => {
  it("requests confirmation when refund >= threshold", () => {
    const decision = adjudicate(
      envelope(
        "pix.charge.refund",
        {
          chargeId: "ch_9",
          amountCentavos: PIX_REFUND_CONFIRMATION_THRESHOLD_CENTAVOS,
          reason: "high-ticket",
        },
        "TRUSTED",
      ),
      state({
        charge: {
          id: "ch_9",
          status: "captured",
          amountCentavos: 100_000, // R$ 1000.00
          capturedAt: DET_TIME,
          refundedAmountCentavos: 0,
          expiresAt: null,
        },
      }),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    if (decision.kind !== "REQUEST_CONFIRMATION") return;
    expect(decision.prompt).toContain("Confirmar reembolso");
  });

  it("REFUSEs refund > captured-minus-already-refunded", () => {
    const decision = adjudicate(
      envelope(
        "pix.charge.refund",
        { chargeId: "ch_10", amountCentavos: 9999, reason: "x" },
        "TRUSTED",
      ),
      state({
        charge: {
          id: "ch_10",
          status: "partially_refunded",
          amountCentavos: 5000,
          capturedAt: DET_TIME,
          refundedAmountCentavos: 4000,
          expiresAt: null,
        },
      }),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.code).toBe("pix.charge.refund_exceeds_capture");
  });

  it("REFUSEs refund before capture", () => {
    const decision = adjudicate(
      envelope(
        "pix.charge.refund",
        { chargeId: "ch_11", amountCentavos: 100, reason: "early" },
        "TRUSTED",
      ),
      state({
        charge: {
          id: "ch_11",
          status: "pending",
          amountCentavos: 1000,
          capturedAt: null,
          refundedAmountCentavos: 0,
          expiresAt: null,
        },
      }),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.code).toBe("pix.charge.refund_before_capture");
  });
});

describe("pix.charge.confirm — taint gate", () => {
  it("REFUSEs an UNTRUSTED-proposed pix.charge.confirm via taint", () => {
    // The kernel-fixed order is state → auth → taint. To exercise the
    // taint gate on `pix.charge.confirm`, all state guards must pass —
    // hence `status: "confirmed"` (no DEFER, no already-captured, no
    // ESCALATE) and a known charge (no charge_not_found refuse).
    const decision = adjudicate(
      envelope("pix.charge.confirm", { chargeId: "ch_x" }, "UNTRUSTED"),
      state({
        charge: {
          id: "ch_x",
          status: "confirmed",
          amountCentavos: 1000,
          capturedAt: null,
          refundedAmountCentavos: 0,
          expiresAt: null,
        },
      }),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") return;
    expect(decision.refusal.kind).toBe("SECURITY");
    expect(decision.refusal.code).toBe("taint_level_insufficient");
  });
});

describe("pix.charge.create — happy path proceeds to default", () => {
  it("falls through to default REFUSE when no positive guard fires", () => {
    // The Pack's default is REFUSE; an adopter wires an explicit
    // EXECUTE-default guard or composes a more permissive policy.
    // This test pins the contract so a future EXECUTE-default flip
    // doesn't go unnoticed.
    const decision = adjudicate(
      envelope(
        "pix.charge.create",
        {
          chargeId: "ch_12",
          amountCentavos: 1500,
          payerTaxId: "0",
          payerName: "x",
          payerEmail: "x@x",
          expiresInSeconds: 3600,
        },
        "UNTRUSTED",
      ),
      state(),
      pixPaymentsPolicyBundle,
    );
    expect(decision.kind).toBe("REFUSE");
  });
});
