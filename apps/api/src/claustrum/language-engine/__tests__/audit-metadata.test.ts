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
});
