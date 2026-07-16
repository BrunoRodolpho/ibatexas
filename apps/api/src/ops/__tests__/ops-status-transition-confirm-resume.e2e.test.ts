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
// FE-T05b (live-disproof follow-up, 2026-07-16) — the resume half was
// LIVE-DISPROVED on dev (intent_audit rows 3362/3366): park worked
// perfectly, but "sim" REFUSEd `order.not_found` because
// `claustrum-bootstrap.ts`'s `enrichResumeState` had NO
// `order.status.transition` special case and silently fell through to the
// customer-scoped `resolveAndAssemble`, which no-ops for the ops plane's
// `staff:<id>` "customerId" (never a real one) and produces a ctx with no
// `orderId` at all. `requireOrderIdForMutation` correctly REFUSEd that empty
// ctx — the bug was upstream of the guard, in resume state ASSEMBLY. Fixed
// by a new `buildOpsOrderStatusTransitionResumeState` builder + a matching
// `enrichResumeState` branch (mirrors the existing refund/price/special
// special cases). This test's `projectResumeState` now calls that REAL
// builder (previously a hand-rolled ctx literal that happened to look
// right and so never exercised, and never would have caught, the actual
// gap) — see also the focused DB-mocked unit test of `enrichResumeState`
// itself: `apps/api/src/__tests__/claustrum-bootstrap-resume-order-status.test.ts`.
//
// FE-T05b review MAJOR follow-up — the "fresh status" half of the fix was
// itself asserted-but-unproven END TO END: the unit test above projects a
// changed `ctx.fulfillmentStatus` but never adjudicates against it. The
// "since-parked STATUS CHANGE" test below drives the FULL park → resume
// cycle through a REAL `requireLegalStatusTransition` re-run (a stateGuard,
// so it re-runs on every resume regardless of the kernel's 2a confirmation
// override) and proves the terminal-status REFUSE actually happens — the
// exact class of gap ("the right ingredients are there but nothing was
// proven to consume them") that shipped the original bug.
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
import type { AuditRecord, DecisionKind, IntentEnvelope } from "@adjudicate/core";
import {
  createOpsResolver,
  buildOpsOrderStatusTransitionResumeState,
  toOpsResolverOrder,
} from "../ops-resolver.js";
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

/**
 * FE-T05b — a mutable "is the order still findable AT RESUME TIME" toggle, so
 * a test can park successfully (order present) and then simulate the order
 * vanishing (genuinely deleted / unowned) BEFORE "sim" resumes — the
 * true-negative the fix must NOT break: resume still honestly REFUSEs
 * `order.not_found`, never a stale/guessed EXECUTE.
 *
 * `orderStatusAtResume` (review MAJOR follow-up) — an independent toggle: the
 * order stays FINDABLE at resume, but its `fulfillmentStatus` differs from
 * what it was at park time (e.g. it reached a terminal status in between).
 * PLANNING always resolves against `ACTIVE_ORDER.fulfillmentStatus` ("the
 * most recent active order" read at turn 1 — `listRecentActive`); this
 * override only changes what the FRESH resume-time read reports, proving the
 * fix's fresh re-read (not the parked snapshot) is what
 * `requireLegalStatusTransition` re-adjudicates against on "sim".
 */
function buildHarness(opts: { orderFindableAtResume?: boolean; orderStatusAtResume?: string } = {}) {
  const orderFindableAtResume = opts.orderFindableAtResume ?? true;
  const orderStatusAtResume = opts.orderStatusAtResume ?? ACTIVE_ORDER.fulfillmentStatus;
  const sink = makeCapturingAuditSink();
  const session = makeStatefulSession();
  const { tools, spies } = buildOpsTools({}, sink);
  const adjudicator = makeAuditedAdjudicator({
    sink,
    // FE-T05b (live-disproof follow-up, intent_audit 3362/3366) — calls the
    // REAL production builder (`buildOpsOrderStatusTransitionResumeState`,
    // wired into `claustrum-bootstrap.ts`'s `enrichResumeState` for exactly
    // this kind) against a MOCKED fresh order-read, rather than a
    // hand-rolled ctx literal — the ORIGINAL version of this test hand-rolled
    // the "correct" ctx directly and so never exercised (and never would
    // have caught) the real wiring gap: `enrichResumeState` had NO
    // order.status.transition special case at all and silently fell through
    // to the customer-scoped `resolveAndAssemble`, which no-ops for the ops
    // plane's `staff:<id>` "customerId" and produces a ctx with NO orderId.
    // Re-reads the PINNED orderId (already rewritten onto the parked
    // payload) fresh, WITHOUT re-running the "most recent" auto-resolve —
    // the resumed turn re-adjudicates the SAME target, never re-guesses.
    projectResumeState: (envelope: IntentEnvelope) => {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
      if (orderId !== ACTIVE_ORDER.id || !orderFindableAtResume) {
        // Fresh read misses ⇒ null order (mirrors a genuinely-deleted /
        // unowned order — `buildOpsOrderStatusTransitionResumeState` maps
        // this to `ctx.orderId: null`).
        return buildOpsOrderStatusTransitionResumeState(orderId, null);
      }
      return buildOpsOrderStatusTransitionResumeState(
        orderId,
        toOpsResolverOrder({
          customerId: ACTIVE_ORDER.customerId,
          paymentMethod: ACTIVE_ORDER.paymentMethod,
          paymentStatus: ACTIVE_ORDER.paymentStatus,
          totalInCentavos: ACTIVE_ORDER.totalInCentavos,
          fulfillmentStatus: orderStatusAtResume,
        }),
      );
    },
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

  it("FE-T05b true-negative: the order genuinely vanishes between park and resume ⇒ resume still honestly REFUSEs order.not_found (never a stale EXECUTE)", async () => {
    const { deps, session, spies } = buildHarness({ orderFindableAtResume: false });
    const sessionId = "system:staff:owner3";

    const t1 = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner3",
      text: "muda o status do meu último pedido para pronto",
    });
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(session.parksFor(sessionId)).toHaveLength(1);

    // The order vanished (deleted / reassigned / unowned) since park — the
    // FIX's fresh re-read at resume time must catch this, not the stale
    // parked snapshot.
    const t2 = await runOpsTurn(deps, { role: "OWNER", staffId: "owner3", text: "sim, confirma" });
    expect(t2.decision.kind).toBe("REFUSE");
    if (t2.decision.kind === "REFUSE") {
      expect(t2.decision.refusal.code).toBe("order.not_found");
    }
    expect(spies.writeAdjudicatedStatusTransition).not.toHaveBeenCalled();
  });

  it("FE-T05b MAJOR (review follow-up): a since-parked STATUS CHANGE (order reaches a terminal status) ⇒ resume still honestly REFUSEs the illegal transition, never a stale EXECUTE — proves requireLegalStatusTransition re-adjudicates against the FRESH resume-time status, not the parked snapshot", async () => {
    // Parked while "preparing" (the plan-time read); by resume time the
    // order has independently reached "delivered" — a TERMINAL status with
    // no legal next state, regardless of the parked target ("ready").
    const { deps, session, spies } = buildHarness({ orderStatusAtResume: "delivered" });
    const sessionId = "system:staff:owner4";

    const t1 = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner4",
      text: "muda o status do meu último pedido para pronto",
    });
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(session.parksFor(sessionId)).toHaveLength(1);

    // "sim" resumes the SAME (pinned) order — the fix's fresh re-read
    // reports the order's CURRENT status ("delivered"), so
    // `requireLegalStatusTransition` (a stateGuard, unaffected by the
    // kernel's 2a confirmation override) re-refuses on resume exactly as it
    // would on a first pass against that same fresh state — never a stale
    // EXECUTE driven off the parked "preparing" snapshot.
    const t2 = await runOpsTurn(deps, { role: "OWNER", staffId: "owner4", text: "sim, confirma" });
    expect(t2.decision.kind).toBe("REFUSE");
    if (t2.decision.kind === "REFUSE") {
      expect(t2.decision.refusal.code).toBe("order.status.terminal");
    }
    expect(spies.writeAdjudicatedStatusTransition).not.toHaveBeenCalled();
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
