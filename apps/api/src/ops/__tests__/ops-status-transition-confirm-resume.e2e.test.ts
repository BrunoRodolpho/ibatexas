// ops-status-transition-confirm-resume — FE-T05 (Language Engine) crown-jewel
// proof: "muda o status do meu último pedido para pronto" driven END-TO-END
// through composeOpsConductor + a full handleTurn against the REAL composed
// policy router + REAL audited kernel (adjudicateAndAudit), mirroring
// ops-price-confirm-resume.e2e.test.ts's harness. No DB/network — the model
// and the order reads are fakes/spies.
//
// Proves the whole tracer, end to end:
//   - the model emits `express_intent(capability:"order.status.transition",
//     payload:{newStatus:"ready"})` — NO orderId (the FE-1.1 extraction
//     schema never shows the model that field);
//   - the resolver auto-resolves "the most recent active order" (no explicit
//     reference given) — a GUESS, so it FORCES a REQUEST_CONFIRMATION
//     (never a silent EXECUTE) — the capability no longer REFUSEs at
//     planning for lack of a schema (SCN-115/116 closed for this capability);
//   - the parked envelope's payload carries NO provenance keys (only
//     {orderId, newStatus} — provenance is projected away at buildEnvelope,
//     FE-0.4);
//   - the CAPTURED AuditRecord's `metadata.languageEngine` materializes
//     ExtractionIR ({newStatus} only, model/untrusted) and HydratedIntentIR
//     (orderId=grounded/resolver, newStatus=model/untrusted,
//     confirmationRequired=true) — asserted via a `where`-shaped predicate
//     matching `@ibatexas/journeys`' `audit-trail-matcher.ts` oracle
//     signature `(payload, record) => boolean` (apps/api may not import
//     @ibatexas/journeys itself — TEST PLANE ONLY, check-bypass leg 6 — so
//     this mirrors the oracle's shape rather than importing it);
//   - "sim, confirma" resumes → EXECUTE → `writeAdjudicatedStatusTransition`
//     runs ONCE against the SAME (pinned) order.
//
// FE-T06 (declarative expectPayload + golden gate) AC2 — "the live-driven
// ExtractionIR matches via expectPayload": this test's `assertWhere` check
// below asserts EXACTLY the same clauses the authored corpus case
// `packages/journeys/extraction-corpus/order.status.transition.yaml`
// (case id `most-recent-order-to-ready`) declares via its `expectPayload`
// block, driven through this same scripted-model harness — the seam-level
// proof the ticket calls for (a live-4B drive is post-merge, orchestrator-
// coordinated). `packages/journeys/src/extraction/expect-payload.test.ts`
// proves the OTHER half: that the corpus file's declarative `expectPayload`
// compiles into a `PayloadPredicate` that accepts a record shaped exactly
// like the one this test produces (a hand-built fixture there, matching
// this test's real one — apps/api cannot import @ibatexas/journeys to
// literally share the predicate; TEST PLANE ONLY, check-bypass leg 6/7).
// Keep the two lock-step: a change to the corpus case's expectations should
// change this test's `assertWhere` clauses identically, and vice versa.

import { describe, expect, it } from "vitest";
import type { AuditRecord, DecisionKind } from "@adjudicate/core";
import { createOpsResolver } from "../ops-resolver.js";
import type { OrderCandidate, OrderReferenceReads } from "../ops-order-resolution.js";
import {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
  scriptedModel,
  type ScriptedToolCall,
} from "./ops-e2e-harness.js";

/** The single active order in the kitchen queue — the auto-resolve target. */
const ACTIVE_ORDER: OrderCandidate = {
  id: "order_recent",
  displayId: 4300,
  customerName: "João",
  fulfillmentStatus: "preparing",
  customerId: "cust_recent",
  paymentMethod: "pix",
  paymentStatus: "paid",
  totalInCentavos: 8_900,
};

function orderReferenceReads(): OrderReferenceReads {
  return {
    findByDisplayId: async () => [],
    listRecentActive: async () => [ACTIVE_ORDER],
  };
}

function buildHarness() {
  const sink = makeCapturingAuditSink();
  const session = makeStatefulSession();
  const { tools, spies } = buildOpsTools({}, sink);
  const adjudicator = makeAuditedAdjudicator({
    sink,
    // Mirrors production's `enrichResumeState` generic fallback for this kind
    // (order.status.transition has no ops-specific resume special-case in
    // claustrum-bootstrap.ts — see that module's `enrichResumeState`): the
    // PINNED orderId (already rewritten onto the parked payload) is re-read
    // directly, WITHOUT re-running the "most recent" auto-resolve — the
    // resumed turn re-adjudicates the SAME target, never re-guesses.
    projectResumeState: () => ({
      ctx: {
        channel: "web",
        customerId: ACTIVE_ORDER.customerId,
        cartId: null,
        orderId: ACTIVE_ORDER.id,
        fulfillmentStatus: ACTIVE_ORDER.fulfillmentStatus,
      },
    }),
  });
  const deps = composeOpsDeps({
    adjudicator,
    session,
    tools,
    model: scriptedModel([
      {
        id: "tc-status",
        name: "express_intent",
        input: { capability: "order.status.transition", payload: { newStatus: "ready" } },
      } satisfies ScriptedToolCall,
    ]),
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => null,
        // No direct id / reference given by the model ⇒ MISS ⇒ the
        // resolver falls back to resolveMostRecentActiveOrder.
        lookupOrder: async () => null,
        orderReferenceReads: orderReferenceReads(),
      }),
  });
  return { deps, session, spies, sink };
}

/** Mirrors `@ibatexas/journeys` oracle's `PayloadPredicate` shape (apps/api
 *  test plane cannot import that package — check-bypass leg 6). */
type WherePredicate = (payload: unknown, record: AuditRecord) => boolean;

function assertWhere(records: readonly AuditRecord[], kind: string, decision: DecisionKind, where: WherePredicate): AuditRecord {
  const record = records.find((r) => r.envelope.kind === kind && r.decision.kind === decision);
  expect(record, `expected a ${kind}/${decision} audit record`).toBeDefined();
  expect(where(record!.envelope.payload, record!)).toBe(true);
  return record!;
}

describe("FE-T05 — order.status.transition first tracer: end-to-end park → confirm-resume → EXECUTE", () => {
  it("no explicit order reference ⇒ auto-resolves the most recent active order, FORCES confirmation, no orderId in the model's extraction", async () => {
    const { deps, session, spies, sink } = buildHarness();
    const sessionId = "system:staff:owner1";

    const t1 = await runOpsTurn(deps, { role: "OWNER", staffId: "owner1", text: "muda o status do meu último pedido para pronto" });
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(spies.writeAdjudicatedStatusTransition).not.toHaveBeenCalled();
    // MAJOR-2 (review) — the confirm prompt NAMES the guessed order (its
    // display number) so an operator can recognize/reject a wrong guess.
    expect(t1.response).toContain(`#${ACTIVE_ORDER.displayId}`);

    // The park carries the RESOLVED orderId (auto-resolve rewrite).
    const parks = session.parksFor(sessionId);
    expect(parks).toHaveLength(1);
    const parkedPayload = parks[0]!.envelope.payload as Record<string, unknown>;
    expect(parkedPayload).toEqual({ orderId: "order_recent", newStatus: "ready" });

    // FE-0.4 — the envelope carries NO provenance keys (projected away).
    expect(Object.keys(parkedPayload).sort()).toEqual(["newStatus", "orderId"]);

    // KERNEL FACT — the audited CONFIRM record + the materialized IR pair.
    // FE-T06 AC2 — mirrors extraction-corpus/order.status.transition.yaml's
    // "most-recent-order-to-ready" case's expectPayload block clause for clause.
    assertWhere(sink.records, "order.status.transition", "REQUEST_CONFIRMATION", (_payload, record) => {
      const meta = record.metadata as
        | { languageEngine?: { extractionIR: unknown; hydratedIntentIR: unknown } }
        | undefined;
      if (meta?.languageEngine === undefined) return false;
      const { extractionIR, hydratedIntentIR } = meta.languageEngine as {
        extractionIR: {
          capability: string;
          payload: Record<string, unknown>;
          provenance: Record<string, { producer: string; trust: string }>;
        };
        hydratedIntentIR: {
          payload: Record<string, unknown>;
          provenance: Record<string, { producer: string; trust: string }>;
          confirmationRequired: boolean;
        };
      };
      return (
        extractionIR.capability === "order.status.transition" &&
        // ExtractionIR carries ONLY {newStatus} — AC1.
        Object.keys(extractionIR.payload).length === 1 &&
        extractionIR.payload.newStatus === "ready" &&
        extractionIR.provenance.newStatus?.trust === "untrusted" &&
        // HydratedIntentIR — AC2 + AC3.
        hydratedIntentIR.payload.orderId === "order_recent" &&
        hydratedIntentIR.payload.newStatus === "ready" &&
        hydratedIntentIR.provenance.orderId?.trust === "grounded" &&
        hydratedIntentIR.provenance.newStatus?.trust === "untrusted" &&
        hydratedIntentIR.confirmationRequired === true
      );
    });

    // Turn 2 — "sim, confirma" resumes the SAME (pinned) order → EXECUTE.
    const t2 = await runOpsTurn(deps, { role: "OWNER", staffId: "owner1", text: "sim, confirma" });
    expect(t2.decision.kind).toBe("EXECUTE");
    expect(spies.writeAdjudicatedStatusTransition).toHaveBeenCalledTimes(1);
    const [payload] = spies.writeAdjudicatedStatusTransition.mock.calls[0]!;
    expect(payload).toMatchObject({ orderId: "order_recent", newStatus: "ready" });
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });

  it("no active order in the system ⇒ honest REFUSE no_order — never a guessed EXECUTE", async () => {
    const sink = makeCapturingAuditSink();
    const session = makeStatefulSession();
    const { tools, spies } = buildOpsTools({}, sink);
    const adjudicator = makeAuditedAdjudicator({ sink });
    const deps = composeOpsDeps({
      adjudicator,
      session,
      tools,
      model: scriptedModel([
        {
          id: "tc-status",
          name: "express_intent",
          input: { capability: "order.status.transition", payload: { newStatus: "ready" } },
        } satisfies ScriptedToolCall,
      ]),
      buildResolver: (staffId: string) =>
        createOpsResolver({
          staffId,
          tenantId: "ibatexas",
          lookupProduct: async () => null,
          lookupOrder: async () => null,
          orderReferenceReads: { findByDisplayId: async () => [], listRecentActive: async () => [] },
        }),
    });

    const t = await runOpsTurn(deps, { role: "OWNER", staffId: "owner2", text: "muda o status do meu último pedido para pronto" });
    expect(t.decision.kind).toBe("REFUSE");
    if (t.decision.kind === "REFUSE") {
      expect(t.decision.refusal.code).toBe("order.not_found");
    }
    expect(spies.writeAdjudicatedStatusTransition).not.toHaveBeenCalled();
    expect(session.parksFor("system:staff:owner2")).toHaveLength(0);
  });
});
