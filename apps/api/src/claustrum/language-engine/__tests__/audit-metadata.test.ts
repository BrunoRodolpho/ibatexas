// audit-metadata.test.ts — the audit-record extension (the decided test
// seam): `buildLanguageEngineAuditMetadata` derives {ExtractionIR,
// HydratedIntentIR} PURELY from the final (post-resolution) AuditRecord, and
// is INERT (returns undefined) for every capability besides
// order.status.transition.

import { describe, expect, it } from "vitest";
import type { AuditRecord } from "@adjudicate/core";
import { buildLanguageEngineAuditMetadata } from "../audit-metadata.js";

function record(kind: string, payload: Record<string, unknown>): AuditRecord {
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
    decision: { kind: "REQUEST_CONFIRMATION", prompt: "Confirma?" } as unknown as AuditRecord["decision"],
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
