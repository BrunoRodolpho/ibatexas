// audit-metadata.test.ts — the audit-record extension (the decided test
// seam): `buildLanguageEngineAuditMetadata` derives {ExtractionIR,
// HydratedIntentIR} PURELY from the final (post-resolution) AuditRecord, and
// is INERT (returns undefined) for every capability besides the ones it
// explicitly dispatches on.

import { describe, expect, it } from "vitest";
import type { AuditRecord, Decision } from "@adjudicate/core";
import { buildLanguageEngineAuditMetadata } from "../audit-metadata.js";
import { OPS_REFUND_DEFAULT_REASON } from "../payment-refund-issue.schema.js";

function record(
  kind: string,
  payload: Record<string, unknown>,
  decision: Decision = { kind: "REQUEST_CONFIRMATION", prompt: "Confirma?" } as unknown as Decision,
): AuditRecord {
  return {
    version: 5,
    intentHash: "h".repeat(64),
    envelope: {
      kind,
      payload,
      actor: { principal: "user", sessionId: "admin:staff_1", role: "OWNER" },
      taint: "UNTRUSTED",
      nonce: "n-1",
      createdAt: "2026-07-16T12:00:00.000Z",
      intentHash: "h".repeat(64),
    } as unknown as AuditRecord["envelope"],
    decision,
    decision_basis: [],
    at: "2026-07-16T12:00:00.000Z",
    durationMs: 10,
  };
}

describe("buildLanguageEngineAuditMetadata — order.status.transition", () => {
  it("derives ExtractionIR carrying ONLY {newStatus} — no orderId, model/untrusted", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.status.transition", { orderId: "order_9", newStatus: "ready" }),
    );
    expect(meta).toBeDefined();
    const le = (meta as { languageEngine: unknown }).languageEngine as {
      extractionIR: { capability: string; payload: Record<string, unknown>; provenance: unknown };
      hydratedIntentIR: {
        capability: string;
        payload: Record<string, unknown>;
        provenance: Record<string, { producer: string; confidence: string; trust: string }>;
        confirmationRequired: boolean;
      };
    };

    expect(le.extractionIR.capability).toBe("order.status.transition");
    expect(le.extractionIR.payload).toEqual({ newStatus: "ready" });
    expect(Object.keys(le.extractionIR.payload)).not.toContain("orderId");
    expect(le.extractionIR.provenance).toEqual({
      newStatus: { producer: "model", confidence: "explicit", trust: "untrusted" },
    });
  });

  it("derives HydratedIntentIR: orderId=grounded/session-derived, newStatus=model/untrusted, confirmationRequired=true", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.status.transition", { orderId: "order_9", newStatus: "ready" }),
    );
    const le = (
      meta as {
        languageEngine: {
          hydratedIntentIR: {
            payload: Record<string, unknown>;
            provenance: Record<string, { producer: string; confidence: string; trust: string }>;
            confirmationRequired: boolean;
          };
        };
      }
    ).languageEngine;

    expect(le.hydratedIntentIR.payload).toEqual({ orderId: "order_9", newStatus: "ready" });
    expect(le.hydratedIntentIR.provenance.orderId).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "grounded",
    });
    expect(le.hydratedIntentIR.provenance.newStatus).toEqual({
      producer: "model",
      confidence: "explicit",
      trust: "untrusted",
    });
    expect(le.hydratedIntentIR.confirmationRequired).toBe(true);
  });

  it("is undefined (inert) for every other capability", () => {
    expect(
      buildLanguageEngineAuditMetadata(record("order.note.add", { orderId: "o-1", body: "x" })),
    ).toBeUndefined();
    expect(
      buildLanguageEngineAuditMetadata(
        record("product.availability.set", { productId: "p-1", available: false }),
      ),
    ).toBeUndefined();
  });

  it("is undefined when the envelope carries no payload", () => {
    const withoutPayload = record("order.status.transition", {});
    (withoutPayload.envelope as { payload?: unknown }).payload = undefined;
    expect(buildLanguageEngineAuditMetadata(withoutPayload)).toBeUndefined();
  });

  it("MAJOR-1b review fix: an extra unexpected payload key is NOT materialized into either IR (not schema-declared, not the resolver-field allowlist)", () => {
    // json-mode does not enforce additionalProperties:false, so a malformed
    // or adversarial model completion could smuggle an extra key through to
    // the resolved envelope payload. Neither IR may become a second,
    // unfiltered leak surface for whatever happens to land there.
    const meta = buildLanguageEngineAuditMetadata(
      record("order.status.transition", {
        orderId: "order_9",
        newStatus: "ready",
        customerEmail: "smuggled@example.com",
        cpf: "12345678900",
      }),
    );
    const le = (
      meta as {
        languageEngine: {
          extractionIR: { payload: Record<string, unknown> };
          hydratedIntentIR: { payload: Record<string, unknown> };
        };
      }
    ).languageEngine;

    expect(le.extractionIR.payload).toEqual({ newStatus: "ready" });
    expect(le.hydratedIntentIR.payload).toEqual({ orderId: "order_9", newStatus: "ready" });
    for (const ir of [le.extractionIR.payload, le.hydratedIntentIR.payload]) {
      expect(ir).not.toHaveProperty("customerEmail");
      expect(ir).not.toHaveProperty("cpf");
    }
  });
});

// ── FE-T09 (D-a) — the granular post-checkout amend kinds ───────────────────

type LanguageEngineMeta = {
  extractionIR: { capability: string; payload: Record<string, unknown>; provenance: unknown };
  hydratedIntentIR: {
    capability: string;
    payload: Record<string, unknown>;
    provenance: Record<string, { producer: string; confidence: string; trust: string }>;
    confirmationRequired: boolean;
  };
};

function languageEngineOf(meta: unknown): LanguageEngineMeta {
  return (meta as { languageEngine: LanguageEngineMeta }).languageEngine;
}

describe("buildLanguageEngineAuditMetadata — order.amend.add_item (FE-T09)", () => {
  it("derives ExtractionIR carrying ONLY {item, quantity} — no orderId/variantId/allergens, model/untrusted", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.amend.add_item", {
        orderId: "order_9",
        item: "coca",
        quantity: 1,
        variantId: "var_coke",
        allergens: ["gluten"],
      }),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.capability).toBe("order.amend.add_item");
    expect(le.extractionIR.payload).toEqual({ item: "coca", quantity: 1 });
    expect(le.extractionIR.provenance).toEqual({
      item: { producer: "model", confidence: "explicit", trust: "untrusted" },
      quantity: { producer: "model", confidence: "explicit", trust: "untrusted" },
    });
  });

  it("derives HydratedIntentIR: orderId=grounded, variantId/allergens=resolver/authoritative (explicit-reference resolution, not a guess), confirmationRequired=true (orderId is grounded)", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.amend.add_item", {
        orderId: "order_9",
        item: "coca",
        quantity: 1,
        variantId: "var_coke",
        allergens: ["gluten"],
      }),
    );
    const le = languageEngineOf(meta);
    expect(le.hydratedIntentIR.payload).toEqual({
      item: "coca",
      quantity: 1,
      orderId: "order_9",
      variantId: "var_coke",
      allergens: ["gluten"],
    });
    expect(le.hydratedIntentIR.provenance.orderId).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "grounded",
    });
    expect(le.hydratedIntentIR.provenance.variantId).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "authoritative",
    });
    expect(le.hydratedIntentIR.provenance.allergens).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "authoritative",
    });
    expect(le.hydratedIntentIR.confirmationRequired).toBe(true);
  });

  it("a stray unexpected key (e.g. smuggled PII) is dropped from both IRs — not schema-declared, not the resolver-field allowlist", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.amend.add_item", {
        orderId: "order_9",
        item: "coca",
        quantity: 1,
        variantId: "var_coke",
        allergens: ["gluten"],
        cpf: "12345678900",
      }),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.payload).not.toHaveProperty("cpf");
    expect(le.hydratedIntentIR.payload).not.toHaveProperty("cpf");
  });
});

describe("buildLanguageEngineAuditMetadata — order.amend.update_qty / remove_item (FE-T09)", () => {
  it("update_qty derives ExtractionIR {item, quantity} and HydratedIntentIR with orderId=grounded, itemId=authoritative", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.amend.update_qty", {
        orderId: "order_9",
        item: "hambúrguer",
        quantity: 2,
        itemId: "var_burger",
      }),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.payload).toEqual({ item: "hambúrguer", quantity: 2 });
    expect(le.hydratedIntentIR.provenance.orderId?.trust).toBe("grounded");
    expect(le.hydratedIntentIR.provenance.itemId).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "authoritative",
    });
  });

  it("remove_item derives ExtractionIR {item} only (no quantity) and the same orderId/itemId provenance shape", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.amend.remove_item", {
        orderId: "order_9",
        item: "hambúrguer",
        itemId: "var_burger",
      }),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.payload).toEqual({ item: "hambúrguer" });
    expect(le.hydratedIntentIR.provenance.itemId).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "authoritative",
    });
  });

  it("is undefined (unresolved itemId) when hydration never resolved a line — the payload just has no itemId key to project", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.amend.remove_item", { orderId: "order_9", item: "algo desconhecido" }),
    );
    const le = languageEngineOf(meta);
    expect(le.hydratedIntentIR.payload).toEqual({ item: "algo desconhecido", orderId: "order_9" });
    expect(le.hydratedIntentIR.provenance.itemId).toBeUndefined();
  });
});

// ── FE-T10 — payment.refund.issue (the money-tier slice) ───────────────────

interface RefundLanguageEngineShape {
  extractionIR: {
    capability: string;
    payload: Record<string, unknown>;
    provenance: Record<string, { producer: string; confidence: string; trust: string }>;
  };
  hydratedIntentIR: {
    capability: string;
    payload: Record<string, unknown>;
    provenance: Record<string, { producer: string; confidence: string; trust: string }>;
    confirmationRequired: boolean;
  };
}

function refundLanguageEngine(
  meta: Readonly<Record<string, unknown>> | undefined,
): RefundLanguageEngineShape {
  return (meta as { languageEngine: RefundLanguageEngineShape }).languageEngine;
}

/** The resolved envelope payload `resolveRefundTarget` stamps (STOP-GATE B):
 *  model-controlled orderReference/amount/reason are ALREADY GONE by this
 *  point (the resolver rewrites orderReference -> orderId and amount ->
 *  refundAmountCentavos) — this is the FINAL, post-resolution shape
 *  buildLanguageEngineAuditMetadata receives, matching ops-resolver.ts's
 *  `stampedPayload`. */
function resolvedRefundPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    refundAmountCentavos: 2000,
    reason: "o cliente desistiu",
    paymentId: "pay_1",
    refundableBalanceCentavos: 5000,
    amountInCentavos: 5000,
    currentRefundedCentavos: 0,
    actor: "admin",
    actorId: "staff_1",
    orderId: "order_9",
    ...over,
  };
}

describe("buildLanguageEngineAuditMetadata — payment.refund.issue (FE-T10)", () => {
  it("derives ExtractionIR carrying {reason, refundAmountCentavos} — the amount survives under its WIRE name (orderReference is consumed by the resolver, never surfaced)", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("payment.refund.issue", resolvedRefundPayload()),
    );
    const le = refundLanguageEngine(meta);
    expect(le.extractionIR.capability).toBe("payment.refund.issue");
    // The schema declares {orderReference, amount, reason}; the RESOLVED
    // payload no longer carries orderReference/amount under those names (the
    // resolver rewrote them to orderId/refundAmountCentavos). `reason`
    // survives under its own schema-declared name; `refundAmountCentavos` is
    // the amount field's resolved wire projection — WITHOUT it, "the amount
    // extracted correctly" would be unassertable by any corpus case.
    expect(le.extractionIR.payload).toEqual({
      reason: "o cliente desistiu",
      refundAmountCentavos: 2000,
    });
    expect(le.extractionIR.provenance).toEqual({
      reason: { producer: "model", confidence: "explicit", trust: "untrusted" },
      refundAmountCentavos: { producer: "model", confidence: "explicit", trust: "untrusted" },
    });
  });

  it("derives HydratedIntentIR: orderId=AUTHORITATIVE (explicit reference, never a guess), refundAmountCentavos stays model/untrusted, paymentId/balances resolver-stamped", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("payment.refund.issue", resolvedRefundPayload()),
    );
    const le = refundLanguageEngine(meta);
    expect(le.hydratedIntentIR.payload).toMatchObject({
      orderId: "order_9",
      paymentId: "pay_1",
      refundableBalanceCentavos: 5000,
      amountInCentavos: 5000,
      currentRefundedCentavos: 0,
      reason: "o cliente desistiu",
      refundAmountCentavos: 2000,
    });
    expect(le.hydratedIntentIR.provenance.orderId).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "authoritative",
    });
    expect(le.hydratedIntentIR.provenance.refundAmountCentavos).toEqual({
      producer: "model",
      confidence: "explicit",
      trust: "untrusted",
    });
  });

  it("a RESOLVER-DEFAULTED reason (the model mentioned none) is excluded from ExtractionIR entirely and attributed to the RESOLVER (authoritative) in HydratedIntentIR — never misread as model output", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "payment.refund.issue",
        resolvedRefundPayload({ reason: OPS_REFUND_DEFAULT_REASON }),
      ),
    );
    const le = refundLanguageEngine(meta);
    // The model extracted NOTHING here — extractionIR must not carry the
    // resolver's own fallback text as if it were model output.
    expect(le.extractionIR.payload).toEqual({ refundAmountCentavos: 2000 });
    expect(le.extractionIR.provenance.reason).toBeUndefined();
    // The hydrated intent still carries the (defaulted) reason — it IS the
    // final intent — but with honest, non-model, non-guess provenance.
    expect(le.hydratedIntentIR.payload.reason).toBe(OPS_REFUND_DEFAULT_REASON);
    expect(le.hydratedIntentIR.provenance.reason).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "authoritative",
    });
  });

  it("confirmationRequired is TRUE via the decision (REQUEST_CONFIRMATION) — NOT via a grounded guess (order.status.transition's own mechanism)", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "payment.refund.issue",
        resolvedRefundPayload(),
        { kind: "REQUEST_CONFIRMATION", prompt: "Confirma?" } as unknown as Decision,
      ),
    );
    const le = refundLanguageEngine(meta);
    // No field is `grounded` here (the reference is authoritative) — proves
    // confirmationRequired is NOT coming from hasGroundedField, only from
    // the decision union.
    expect(
      Object.values(le.hydratedIntentIR.provenance).some((p) => p.trust === "grounded"),
    ).toBe(false);
    expect(le.hydratedIntentIR.confirmationRequired).toBe(true);
  });

  it("confirmationRequired is TRUE for an ESCALATE decision too (the ≥R$1000 band pre-empts CONFIRM, still counts as 'forces friction')", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "payment.refund.issue",
        resolvedRefundPayload({ refundAmountCentavos: 150_000 }),
        { kind: "ESCALATE", to: "human", reason: "refund_above_escalate_threshold" } as unknown as Decision,
      ),
    );
    const le = refundLanguageEngine(meta);
    expect(le.hydratedIntentIR.confirmationRequired).toBe(true);
  });

  it("confirmationRequired is FALSE when neither a grounded guess NOR a confirm/escalate decision applies (proves the union isn't unconditionally true)", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "payment.refund.issue",
        resolvedRefundPayload(),
        { kind: "EXECUTE", basis: [] } as unknown as Decision,
      ),
    );
    const le = refundLanguageEngine(meta);
    expect(le.hydratedIntentIR.confirmationRequired).toBe(false);
  });

  it("an extra unexpected payload key (adversarial/malformed completion) is NOT materialized into either IR", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "payment.refund.issue",
        resolvedRefundPayload({ cpf: "12345678900", allergens: ["amendoim"] }),
      ),
    );
    const le = refundLanguageEngine(meta);
    for (const ir of [le.extractionIR.payload, le.hydratedIntentIR.payload]) {
      expect(ir).not.toHaveProperty("cpf");
      expect(ir).not.toHaveProperty("allergens");
    }
  });
});

// ── FE-T12 — order.checkout.create (orders governance-tier, customer-plane) ─

describe("buildLanguageEngineAuditMetadata — order.checkout.create (FE-T12)", () => {
  it("derives ExtractionIR carrying ONLY {payment_method} (the WIRE name) — no cartId/pixDetails, model/untrusted", () => {
    // The record() helper builds the RESOLVED/POST-HYDRATION envelope
    // payload — `paymentMethod` (internal) is what resolve-and-assemble.ts's
    // mapCheckoutPaymentMethodWireField renames the model's wire
    // `payment_method` TO, before the kernel/guards ever see it.
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        { cartId: "cart_1", paymentMethod: "pix" },
        { kind: "EXECUTE", basis: [] } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.capability).toBe("order.checkout.create");
    expect(le.extractionIR.payload).toEqual({ payment_method: "pix" });
    expect(le.extractionIR.provenance).toEqual({
      payment_method: { producer: "model", confidence: "explicit", trust: "untrusted" },
    });
  });

  it("a checkout with NO payment_method mentioned (team-lead review: the field is optional) derives an EMPTY extractionIR payload — never a fabricated method", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        { cartId: "cart_1" },
        { kind: "REFUSE", basis: [] } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.payload).toEqual({});
    expect(le.hydratedIntentIR.payload).toEqual({ cartId: "cart_1" });
  });

  it("derives HydratedIntentIR: cartId=resolver/AUTHORITATIVE (session-derived, never a guess), payment_method stays model/untrusted", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        { cartId: "cart_1", paymentMethod: "pix" },
        { kind: "EXECUTE", basis: [] } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    expect(le.hydratedIntentIR.payload).toEqual({ payment_method: "pix", cartId: "cart_1" });
    expect(le.hydratedIntentIR.provenance.cartId).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "authoritative",
    });
    expect(le.hydratedIntentIR.provenance.payment_method).toEqual({
      producer: "model",
      confidence: "explicit",
      trust: "untrusted",
    });
  });

  it("confirmationRequired is FALSE on a plain EXECUTE (cartId is authoritative, never grounded — no guess, no confirm/escalate decision)", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        { cartId: "cart_1", paymentMethod: "cash" },
        { kind: "EXECUTE", basis: [] } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    expect(le.hydratedIntentIR.confirmationRequired).toBe(false);
  });

  it("confirmationRequired is TRUE when the money-boundary ladder forces REQUEST_CONFIRMATION (>=R$1000 cart total), via the decision union, not a grounded guess", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        { cartId: "cart_1", paymentMethod: "card" },
        { kind: "REQUEST_CONFIRMATION", prompt: "Confirma?" } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    expect(
      Object.values(le.hydratedIntentIR.provenance).some((p) => p.trust === "grounded"),
    ).toBe(false);
    expect(le.hydratedIntentIR.confirmationRequired).toBe(true);
  });

  it("confirmationRequired is TRUE for an ESCALATE decision too (>=R$10000 cart total)", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        { cartId: "cart_1", paymentMethod: "card" },
        { kind: "ESCALATE", to: "human", reason: "checkout_above_escalate_threshold" } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    expect(le.hydratedIntentIR.confirmationRequired).toBe(true);
  });

  it("pixDetails is NEVER materialized into either IR even when present on the resolved envelope payload — PII never rides the audit sidecar", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        {
          cartId: "cart_1",
          paymentMethod: "pix",
          pixDetails: { name: "Cliente Teste", email: "cliente@example.com", cpf: "12345678900" },
        },
        { kind: "EXECUTE", basis: [] } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    for (const ir of [le.extractionIR.payload, le.hydratedIntentIR.payload]) {
      expect(ir).not.toHaveProperty("pixDetails");
    }
  });

  // ── delivery_type (cart-seeding investigation follow-up) ──────────────────

  it("derives ExtractionIR carrying {payment_method, delivery_type} (BOTH wire names) when the resolved payload has both internal keys — model/untrusted", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        { cartId: "cart_1", paymentMethod: "pix", deliveryType: "pickup" },
        { kind: "EXECUTE", basis: [] } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.payload).toEqual({ payment_method: "pix", delivery_type: "pickup" });
    expect(le.extractionIR.provenance).toEqual({
      payment_method: { producer: "model", confidence: "explicit", trust: "untrusted" },
      delivery_type: { producer: "model", confidence: "explicit", trust: "untrusted" },
    });
  });

  it("a checkout with delivery_type but NO payment_method derives an extractionIR carrying ONLY delivery_type — each field's absence is independent, never a fabricated sibling", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        { cartId: "cart_1", deliveryType: "delivery" },
        { kind: "REFUSE", basis: [] } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.payload).toEqual({ delivery_type: "delivery" });
  });

  it("derives HydratedIntentIR carrying delivery_type alongside payment_method and the resolver-authoritative cartId", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record(
        "order.checkout.create",
        { cartId: "cart_1", paymentMethod: "card", deliveryType: "delivery" },
        { kind: "EXECUTE", basis: [] } as unknown as Decision,
      ),
    );
    const le = languageEngineOf(meta);
    expect(le.hydratedIntentIR.payload).toEqual({
      payment_method: "card",
      delivery_type: "delivery",
      cartId: "cart_1",
    });
    expect(le.hydratedIntentIR.provenance.delivery_type).toEqual({
      producer: "model",
      confidence: "explicit",
      trust: "untrusted",
    });
  });
});

// ── FE-T12 — order.cancel (orders governance-tier, customer-plane) ─────────

describe("buildLanguageEngineAuditMetadata — order.cancel (FE-T12)", () => {
  it("derives ExtractionIR carrying ONLY {reason} — no orderId, model/untrusted", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.cancel", { orderId: "order_9", reason: "mudei de ideia" }),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.capability).toBe("order.cancel");
    expect(le.extractionIR.payload).toEqual({ reason: "mudei de ideia" });
    expect(le.extractionIR.provenance).toEqual({
      reason: { producer: "model", confidence: "explicit", trust: "untrusted" },
    });
  });

  it("a bare cancel with no reason mentioned derives an EMPTY extractionIR payload — reason is optional", () => {
    const meta = buildLanguageEngineAuditMetadata(record("order.cancel", { orderId: "order_9" }));
    const le = languageEngineOf(meta);
    expect(le.extractionIR.payload).toEqual({});
  });

  it("derives HydratedIntentIR: orderId=resolver/GROUNDED (auto-resolved most-recent order, a guess), reason stays model/untrusted, confirmationRequired=true", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.cancel", { orderId: "order_9", reason: "mudei de ideia" }),
    );
    const le = languageEngineOf(meta);
    expect(le.hydratedIntentIR.payload).toEqual({ reason: "mudei de ideia", orderId: "order_9" });
    expect(le.hydratedIntentIR.provenance.orderId).toEqual({
      producer: "resolver",
      confidence: "resolved",
      trust: "grounded",
    });
    expect(le.hydratedIntentIR.provenance.reason).toEqual({
      producer: "model",
      confidence: "explicit",
      trust: "untrusted",
    });
    expect(le.hydratedIntentIR.confirmationRequired).toBe(true);
  });

  it("a stray unexpected key (e.g. smuggled PII) is dropped from both IRs — not schema-declared, not the resolver-field allowlist", () => {
    const meta = buildLanguageEngineAuditMetadata(
      record("order.cancel", { orderId: "order_9", reason: "mudei de ideia", cpf: "12345678900" }),
    );
    const le = languageEngineOf(meta);
    expect(le.extractionIR.payload).not.toHaveProperty("cpf");
    expect(le.hydratedIntentIR.payload).not.toHaveProperty("cpf");
  });
});
