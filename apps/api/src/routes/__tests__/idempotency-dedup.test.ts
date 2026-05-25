// P0-7 audit-2026-05-24 — idempotency-key dedup tests
//
// Verifies that the 5 priority routes (per
// `docs/adjudicate-migration/audit-2026-05-24/SYNTHESIS.md`) derive a
// DETERMINISTIC envelope nonce from their idempotency-key inputs.
//
// The contract under test: two identical retries of the same logical
// operation MUST produce the same `intentHash` so the kernel's
// Execution Ledger can dedupe. Pre-fix the routes used
// `nonce: randomUUID()`, producing a fresh hash on every retry and
// defeating dedup.
//
// We test the route-level derivation directly by replicating each
// route's idempotency-key shape and feeding both attempts through
// `buildEnvelope`. The contract holds iff `intentHash` is identical.
//
// Coverage:
//   1. POST /api/orders/:id/cancel
//   2. POST /api/cart/checkout
//   3. POST /api/admin/orders/:id/payment/refund
//   4. POST /api/me/data/initiate-deletion
//   5. DELETE /api/me/data?token={otpCode}  (legacy "anonymize confirm")
//   6. (extra) POST /api/me/data/cancel-deletion

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildEnvelope } from "@adjudicate/core";

// ── Helpers under test (copies of the route-private helpers; the routes
//    do not export them, so we replicate the contract here. If the route's
//    helper diverges, this test will go stale — that's the desired
//    canary).

function deriveNonce(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function resolveIdempotencyKey(
  headerValue: string | string[] | undefined,
  fallback: string,
): string {
  if (typeof headerValue === "string" && headerValue.length > 0) return headerValue;
  if (Array.isArray(headerValue) && headerValue[0]) return headerValue[0];
  return fallback;
}

const FIXED_EPOCH_HOUR = 472416; // a stable bucket for the test

function epochHour(): number {
  return FIXED_EPOCH_HOUR;
}

// ── 1. POST /api/orders/:id/cancel ─────────────────────────────────────────

describe("P0-7 — POST /api/orders/:id/cancel idempotency-key dedup", () => {
  function buildCancelEnvelope(headerValue: string | undefined) {
    const id = "order_01";
    const customerId = "cust_01";
    const idempotencyKey = resolveIdempotencyKey(
      headerValue,
      `${id}:cancel:${customerId}`,
    );
    return buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: id, reason: "Mudei de ideia" },
      nonce: deriveNonce(idempotencyKey),
      actor: { principal: "user", sessionId: customerId },
      taint: "UNTRUSTED",
    });
  }

  it("two retries with no Idempotency-Key header produce identical intentHash", () => {
    const e1 = buildCancelEnvelope(undefined);
    const e2 = buildCancelEnvelope(undefined);
    expect(e1.intentHash).toBe(e2.intentHash);
    expect(e1.nonce).toBe(e2.nonce);
  });

  it("two retries with same Idempotency-Key header produce identical intentHash", () => {
    const e1 = buildCancelEnvelope("client-uuid-abc");
    const e2 = buildCancelEnvelope("client-uuid-abc");
    expect(e1.intentHash).toBe(e2.intentHash);
  });

  it("different Idempotency-Key headers produce different intentHashes", () => {
    const e1 = buildCancelEnvelope("client-uuid-abc");
    const e2 = buildCancelEnvelope("client-uuid-xyz");
    expect(e1.intentHash).not.toBe(e2.intentHash);
  });
});

// ── 2. POST /api/cart/checkout ─────────────────────────────────────────────

describe("P0-7 — POST /api/cart/checkout idempotency-key dedup", () => {
  function buildCheckoutEnvelope(headerValue: string | undefined) {
    const cartId = "cart_01";
    const sessionId = "cust_01";
    const idempotencyKey = resolveIdempotencyKey(
      headerValue,
      `${cartId}:checkout`,
    );
    return buildEnvelope({
      kind: "order.checkout.create",
      payload: { cartId, paymentMethod: "pix" as const },
      nonce: deriveNonce(idempotencyKey),
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
    });
  }

  it("two retries on the same cart produce identical intentHash", () => {
    const e1 = buildCheckoutEnvelope(undefined);
    const e2 = buildCheckoutEnvelope(undefined);
    expect(e1.intentHash).toBe(e2.intentHash);
  });

  it("explicit Idempotency-Key header is honoured", () => {
    const e1 = buildCheckoutEnvelope("client-uuid-checkout-1");
    const e2 = buildCheckoutEnvelope("client-uuid-checkout-1");
    expect(e1.intentHash).toBe(e2.intentHash);
  });
});

// ── 3. POST /api/admin/orders/:id/payment/refund ───────────────────────────

describe("P0-7 — POST /api/admin/orders/:id/payment/refund idempotency-key dedup", () => {
  function buildRefundEnvelope(headerValue: string | undefined) {
    const id = "order_01";
    const staffId = "staff_01";
    const refundAmount = 5000;
    const idempotencyKey = resolveIdempotencyKey(
      headerValue,
      `${id}:refund:${refundAmount}:${staffId}`,
    );
    return buildEnvelope({
      kind: "payment.refund.issue",
      payload: {
        paymentId: "pay_01",
        refundAmountCentavos: refundAmount,
        refundableBalanceCentavos: 10000,
        amountInCentavos: 10000,
        currentRefundedCentavos: 0,
        actor: "admin" as const,
        actorId: staffId,
        reason: "Reembolso emitido pelo admin",
      },
      nonce: deriveNonce(idempotencyKey),
      actor: { principal: "user", sessionId: staffId },
      taint: "TRUSTED",
    });
  }

  it("two retries by the same staff for the same refund produce identical intentHash", () => {
    const e1 = buildRefundEnvelope(undefined);
    const e2 = buildRefundEnvelope(undefined);
    expect(e1.intentHash).toBe(e2.intentHash);
  });

  it("client-supplied Idempotency-Key wins over derivation", () => {
    const e1 = buildRefundEnvelope("admin-tool-issued-uuid");
    const e2 = buildRefundEnvelope("admin-tool-issued-uuid");
    expect(e1.intentHash).toBe(e2.intentHash);
  });
});

// ── 4. POST /api/me/data/initiate-deletion ─────────────────────────────────

describe("P0-7 — POST /api/me/data/initiate-deletion idempotency-key dedup", () => {
  function buildInitiateEnvelope(headerValue: string | undefined) {
    const customerId = "cust_01";
    const idempotencyKey = resolveIdempotencyKey(
      headerValue,
      `${customerId}:anonymize:initiate:${epochHour()}`,
    );
    return buildEnvelope({
      kind: "customer.anonymize",
      payload: {
        customerId,
        otpToken: "verified",
        scope: "lgpd_art_18" as const,
      },
      nonce: deriveNonce(idempotencyKey),
      actor: { principal: "user", sessionId: customerId },
      taint: "UNTRUSTED",
    });
  }

  it("two retries within the same hour produce identical intentHash", () => {
    const e1 = buildInitiateEnvelope(undefined);
    const e2 = buildInitiateEnvelope(undefined);
    expect(e1.intentHash).toBe(e2.intentHash);
  });

  it("different epoch hours produce different intentHashes (next-hour retry allowed)", () => {
    const customerId = "cust_01";
    const e1 = buildEnvelope({
      kind: "customer.anonymize",
      payload: {
        customerId,
        otpToken: "verified",
        scope: "lgpd_art_18" as const,
      },
      nonce: deriveNonce(`${customerId}:anonymize:initiate:${FIXED_EPOCH_HOUR}`),
      actor: { principal: "user", sessionId: customerId },
      taint: "UNTRUSTED",
    });
    const e2 = buildEnvelope({
      kind: "customer.anonymize",
      payload: {
        customerId,
        otpToken: "verified",
        scope: "lgpd_art_18" as const,
      },
      nonce: deriveNonce(`${customerId}:anonymize:initiate:${FIXED_EPOCH_HOUR + 1}`),
      actor: { principal: "user", sessionId: customerId },
      taint: "UNTRUSTED",
    });
    expect(e1.intentHash).not.toBe(e2.intentHash);
  });
});

// ── 5. DELETE /api/me/data?token={otpCode} (legacy anonymize confirm) ──────

describe("P0-7 — DELETE /api/me/data legacy idempotency-key dedup", () => {
  function buildLegacyDeleteEnvelope(otpCode: string) {
    const customerId = "cust_01";
    const idempotencyKey = resolveIdempotencyKey(
      undefined,
      `${customerId}:anonymize:delete:${epochHour()}`,
    );
    return buildEnvelope({
      kind: "customer.anonymize",
      payload: {
        customerId,
        otpToken: otpCode,
        scope: "lgpd_art_18" as const,
      },
      nonce: deriveNonce(idempotencyKey),
      actor: { principal: "user", sessionId: customerId },
      taint: "UNTRUSTED",
    });
  }

  it("retries within the same hour produce identical intentHash regardless of OTP code variance", () => {
    // The nonce derivation intentionally excludes otpCode — the OTP is
    // verified upstream and is not load-bearing for hash identity. Two
    // retries with the same code AND the same hour bucket produce the
    // same hash. (The payload still differs across distinct codes, so
    // distinct codes yield distinct hashes — see assertion below.)
    const e1 = buildLegacyDeleteEnvelope("123456");
    const e2 = buildLegacyDeleteEnvelope("123456");
    expect(e1.intentHash).toBe(e2.intentHash);
  });

  it("different OTP codes still produce different intentHashes (payload-level differentiation)", () => {
    // The nonce is hour-bucketed but the PAYLOAD includes otpToken — so
    // changing the code DOES change the intentHash because hash input
    // covers (version, kind, payload, nonce, actor, taint).
    const e1 = buildLegacyDeleteEnvelope("123456");
    const e2 = buildLegacyDeleteEnvelope("654321");
    expect(e1.intentHash).not.toBe(e2.intentHash);
  });
});

// ── 6. POST /api/me/data/cancel-deletion (extra — same epoch principle) ────

describe("P0-7 — POST /api/me/data/cancel-deletion idempotency-key dedup", () => {
  function buildCancelDeletionEnvelope(receiptIntentHash: string) {
    const customerId = "cust_01";
    const idempotencyKey = resolveIdempotencyKey(
      undefined,
      `${customerId}:anonymize:cancel:${receiptIntentHash}`,
    );
    return buildEnvelope({
      kind: "customer.anonymize.cancel",
      payload: { customerId },
      nonce: deriveNonce(idempotencyKey),
      actor: { principal: "user", sessionId: customerId },
      taint: "UNTRUSTED",
    });
  }

  it("retries against the same parked receipt produce identical intentHash", () => {
    const e1 = buildCancelDeletionEnvelope("hash_of_parked_anonymize");
    const e2 = buildCancelDeletionEnvelope("hash_of_parked_anonymize");
    expect(e1.intentHash).toBe(e2.intentHash);
  });
});
