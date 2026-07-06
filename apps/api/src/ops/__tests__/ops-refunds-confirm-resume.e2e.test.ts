// ops-refunds-confirm-resume — the BKL-085 crown-jewel proof: refunds-by-message
// driven END-TO-END through composeOpsConductor + a full handleTurn against the
// REAL composed policy router + REAL audited kernel (adjudicateAndAudit) with a
// STATEFUL session store + the REAL OpsSystemChannel matchToParked driver. No
// DB/network — the model, the payment reads, and the refund WRITE are fakes/spies.
//
// The fake-model + composed-router machinery is the SHARED WS9 harness
// (./ops-e2e-harness.ts); this file supplies the refund-specific resume
// projection (buildOpsRefundResumeState) + resolver reads + tool spies, and asserts
// both the side effects AND the KERNEL facts (the captured AuditRecord's
// decision + decision_basis) via the harness capturing sink.
//
// Proves the whole money-safe flow:
//   - OWNER "reembolsa 50 do pedido 4242": order-ref → payment located → DB-stamped
//     balance payload → UNTRUSTED taint overlay → REQUEST_CONFIRMATION → PARKED
//     (asserted in the session store) → reply carries the amount prompt.
//   - "sim, confirma" → matchToParked confirm → resume (re-adjudicate the parked
//     envelope through the composed router, receipt flips CONFIRM→EXECUTE) →
//     writeAdjudicatedRefund called ONCE with the STAMPED payload + the
//     payment.status_changed publisher fired; the park is cleared.
//   - "não" → deny → unparked, the write NEVER runs.
//   - a defer phrase → deferred, the write NEVER runs.
//   - ATTENDANT → REFUSE staff_role_violation; nothing parks.
//   - >R$1000 → ESCALATE (the taint overlay does NOT pre-empt); nothing parks.
//   - forged payload balances → stamped from the DB; an over-balance refund REFUSEs.
//   - a DIFFERENT staff session cannot see another's park (staff-session-scoped).

import { describe, expect, it } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";
import {
  createOpsResolver,
  buildOpsRefundResumeState,
} from "../ops-resolver.js";
import { ESCALATION_RESUMABLE_KINDS } from "../../escalation/escalation-park-store.js";
import {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
  scriptedModel,
  type ScriptedToolCall,
  type StaffRole,
} from "./ops-e2e-harness.js";

/** A refundable active payment (the fake DB row the resolver + resume read). */
const ACTIVE_PAID = {
  paymentId: "pay_db_1",
  status: "paid",
  amountInCentavos: 10_000, // R$100 balance
  refundedAmountCentavos: 0,
  method: "pix",
  version: 3,
  orderId: "order_4242",
};

function buildHarness(opts: {
  toolCalls: ReadonlyArray<ScriptedToolCall>;
  activePayment?: typeof ACTIVE_PAID | null;
  paymentById?: (id: string) => typeof ACTIVE_PAID | null;
  handoff?: { queue: (envelope: IntentEnvelope, reason: string) => Promise<void> };
}) {
  const sink = makeCapturingAuditSink();
  const session = makeStatefulSession();
  const { tools, spies } = buildOpsTools({}, sink);
  const activePayment =
    opts.activePayment === undefined ? ACTIVE_PAID : opts.activePayment;
  const paymentById = opts.paymentById ?? (() => ACTIVE_PAID);
  // The production resume path (buildAdjudicator.resume → enrichResumeState) for
  // an admin refund re-projects the PaymentState via buildOpsRefundResumeState.
  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: (env: IntentEnvelope) => {
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      const paymentId =
        typeof payload.paymentId === "string" ? payload.paymentId : "";
      return buildOpsRefundResumeState(
        paymentId === "" ? null : paymentById(paymentId),
        "ibatexas",
      );
    },
  });
  const deps = composeOpsDeps({
    adjudicator,
    session,
    tools,
    model: scriptedModel(opts.toolCalls),
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => null,
        lookupOrder: async (orderId) =>
          orderId === "order_4242"
            ? {
                customerId: "cust_1",
                paymentMethod: "pix",
                paymentStatus: "paid",
                totalInCentavos: 10_000,
                fulfillmentStatus: "confirmed",
              }
            : null,
        orderReferenceReads: {
          findByDisplayId: async (d) =>
            d === 4242
              ? [
                  {
                    id: "order_4242",
                    displayId: 4242,
                    customerName: "Maria",
                    fulfillmentStatus: "confirmed",
                    customerId: "cust_1",
                    paymentMethod: "pix",
                    paymentStatus: "paid",
                    totalInCentavos: 10_000,
                  },
                ]
              : [],
          listRecentActive: async () => [],
        },
        lookupActivePayment: async () => activePayment,
      }),
    ...(opts.handoff ? { handoff: opts.handoff } : {}),
  });
  return { deps, session, spies, sink };
}

/** Positional adapter so the scenario bodies stay behaviour-identical. */
const runTurn = (
  deps: ReturnType<typeof buildHarness>["deps"],
  role: StaffRole,
  staffId: string,
  text: string,
) => runOpsTurn(deps, { role, staffId, text });

const REFUND_CALL = (orderRef: string, amount?: number): ScriptedToolCall => ({
  id: "tc-refund",
  name: "express_intent",
  input: {
    capability: "payment.refund.issue",
    payload: {
      orderId: orderRef,
      ...(amount === undefined ? {} : { refundAmountCentavos: amount }),
      reason: "cliente pediu",
    },
  },
});

/** BKL-094 — the shape the models ACTUALLY emit for "reembolsa N reais": the
 *  figure under `amount` in REAIS (not `refundAmountCentavos` in centavos). */
const REFUND_CALL_REAIS = (orderRef: string, reais: number): ScriptedToolCall => ({
  id: "tc-refund-reais",
  name: "express_intent",
  input: {
    capability: "payment.refund.issue",
    payload: { orderId: orderRef, amount: reais, reason: "cliente pediu" },
  },
});

describe("BKL-085 refunds-by-message — end-to-end park → confirm-resume → EXECUTE", () => {
  it("OWNER: parks a CONFIRM with the amount prompt, then 'sim' EXECUTEs the refund ONCE", async () => {
    const { deps, session, spies, sink } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    const sessionId = "system:staff:owner1";

    // Turn 1 — the refund parks for confirmation.
    const t1 = await runTurn(deps, "OWNER", "owner1", "reembolsa 50 reais do pedido 4242");
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    // The park landed in the session store, keyed to THIS staff session.
    const parks = session.parksFor(sessionId);
    expect(parks).toHaveLength(1);
    // The reply carries the parsed amount + payment ref (the staff confirms the numbers).
    expect(t1.response).toContain("R$ 50,00");
    expect(t1.response).toContain("pay_db_1");
    // No write yet.
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    // KERNEL FACT — the audited CONFIRM record: right kind, OWNER role, and the
    // taint-overlay basis is why a sub-R$500 refund still requires confirmation.
    const confirmRec = sink.lastDecision("REQUEST_CONFIRMATION");
    expect(confirmRec).toBeDefined();
    expect(String(confirmRec!.envelope.kind)).toBe("payment.refund.issue");
    expect(confirmRec!.envelope.actor.role).toBe("OWNER");
    expect(confirmRec!.envelope.actor.sessionId).toBe("admin:owner1");

    // Turn 2 — "sim, confirma" resumes → EXECUTE → the write runs ONCE.
    const t2 = await runTurn(deps, "OWNER", "owner1", "sim, confirma");
    expect(t2.decision.kind).toBe("EXECUTE");
    expect(spies.writeAdjudicatedRefund).toHaveBeenCalledTimes(1);
    const [writePayload] = spies.writeAdjudicatedRefund.mock.calls[0]!;
    // The write got the STAMPED payload (DB balance + Capsule identity).
    expect(writePayload.paymentId).toBe("pay_db_1");
    expect(writePayload.refundAmountCentavos).toBe(5_000);
    expect(writePayload.refundableBalanceCentavos).toBe(10_000);
    expect(writePayload.actor).toBe("admin");
    expect(writePayload.actorId).toBe("owner1");
    // The full side-effect chain fired (payment.status_changed publisher).
    expect(spies.publishPaymentStatusChanged).toHaveBeenCalledTimes(1);
    // The park was cleared.
    expect(session.parksFor(sessionId)).toHaveLength(0);
    // KERNEL FACT — the resumed EXECUTE carries the confirmation:received basis.
    const executeRec = sink.lastDecision("EXECUTE");
    expect(executeRec).toBeDefined();
    expect(String(executeRec!.envelope.kind)).toBe("payment.refund.issue");
    // The confirmation:received basis (category `confirmation`, code `received`)
    // is the audit proof that the EXECUTE came from a resolved park, not a fresh
    // command — this is the live-proven governance link (see the WS9 live proof).
    expect(sink.hasBasis("payment.refund.issue", "received")).toBe(true);
  });

  it("'não' after a park → deny → unparked, the write NEVER runs", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    const sessionId = "system:staff:owner2";
    await runTurn(deps, "OWNER", "owner2", "reembolsa 50 do pedido 4242");
    expect(session.parksFor(sessionId)).toHaveLength(1);
    const t2 = await runTurn(deps, "OWNER", "owner2", "não, cancela");
    expect(t2.decision.kind).not.toBe("EXECUTE");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    // Denied → unparked.
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });

  it("a defer phrase after a park → deferred, the write NEVER runs", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    const sessionId = "system:staff:owner3";
    await runTurn(deps, "OWNER", "owner3", "reembolsa 50 do pedido 4242");
    await runTurn(deps, "OWNER", "owner3", "deixa pra amanhã");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    // The confirm park moved to the deferred set (no auto-EXECUTE on the ops plane).
    expect(session.parksFor(sessionId)).toHaveLength(0);
    expect(session.deferredFor(sessionId)).toHaveLength(1);
  });

  it("ATTENDANT → REFUSE staff_role_violation; nothing parks; no write", async () => {
    const { deps, session, spies, sink } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    const t = await runTurn(deps, "ATTENDANT", "att1", "reembolsa 50 do pedido 4242");
    expect(t.decision.kind).toBe("REFUSE");
    if (t.decision.kind === "REFUSE") {
      expect(t.decision.refusal.code).toBe("staff_role_violation");
    }
    expect(session.parksFor("system:staff:att1")).toHaveLength(0);
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    // KERNEL FACT — the audited REFUSE record names the same kind + ATTENDANT role.
    const refuseRec = sink.lastDecision("REFUSE");
    expect(refuseRec).toBeDefined();
    expect(String(refuseRec!.envelope.kind)).toBe("payment.refund.issue");
    expect(refuseRec!.envelope.actor.role).toBe("ATTENDANT");
  });

  it(">R$1000 → ESCALATE (the taint overlay does NOT pre-empt) + an escalation park is created (AUT-017)", async () => {
    // AUT-017 — a resumable money-intent ESCALATE now PARKS the envelope (for OWNER
    // approve-and-execute) via the HandoffPort, instead of dropping it. It still does
    // NOT enter the CONFIRM session park (that is the sub-escalate taint path).
    const escalationParks: IntentEnvelope[] = [];
    const parkingHandoff = {
      queue: async (envelope: IntentEnvelope) => {
        if (ESCALATION_RESUMABLE_KINDS.has(String(envelope.kind))) {
          escalationParks.push(envelope);
        }
      },
    };
    const { deps, session } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 150_000)], // R$1500, but balance is only R$100…
      // …so give a big-balance payment so ESCALATE (not over-balance) is exercised.
      activePayment: {
        ...ACTIVE_PAID,
        amountInCentavos: 500_000,
        refundedAmountCentavos: 0,
      },
      paymentById: () => ({
        ...ACTIVE_PAID,
        amountInCentavos: 500_000,
        refundedAmountCentavos: 0,
      }),
      handoff: parkingHandoff,
    });
    const t = await runTurn(deps, "OWNER", "owner4", "reembolsa 1500 reais do pedido 4242");
    expect(t.decision.kind).toBe("ESCALATE");
    // The resumable refund was parked for OWNER approval (AUT-017)…
    expect(escalationParks).toHaveLength(1);
    expect(String(escalationParks[0]!.kind)).toBe("payment.refund.issue");
    // …but it did NOT enter the CONFIRM session-park (that is the taint overlay path).
    expect(session.parksFor("system:staff:owner4")).toHaveLength(0);
  });

  it("forged payload balances are stamped from the DB; an over-balance refund REFUSEs", async () => {
    const { deps, spies } = buildHarness({
      // Model forges a huge balance AND asks R$90 on a payment whose DB balance is R$100…
      // wait — R$90 < R$100 would pass; ask R$150 to exceed the true R$100 balance.
      toolCalls: [
        {
          id: "tc-forge",
          name: "express_intent",
          input: {
            capability: "payment.refund.issue",
            payload: {
              orderId: "4242",
              refundAmountCentavos: 15_000, // R$150 > true R$100 balance
              refundableBalanceCentavos: 999_999_999, // forged
              amountInCentavos: 999_999_999, // forged
              currentRefundedCentavos: 0,
              actor: "system",
              actorId: "forged",
            },
          },
        },
      ],
    });
    const t = await runTurn(deps, "OWNER", "owner5", "reembolsa 150 do pedido 4242");
    // The kernel decided on the TRUE (stamped) R$100 balance → over-balance REFUSE.
    expect(t.decision.kind).toBe("REFUSE");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
  });

  it("BKL-094: 'reembolsa 10 reais' ({amount:10}) parks R$ 10,00 (not the full balance) → 'sim' EXECUTEs 1000", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL_REAIS("4242", 10)], // reais, NOT centavos
    });
    const sessionId = "system:staff:owner8";

    // Turn 1 — the reais amount threads to 1000 centavos and parks for confirmation.
    const t1 = await runTurn(deps, "OWNER", "owner8", "reembolsa 10 reais do pedido 4242");
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    // The prompt shows the PARSED R$ 10,00 — NOT the full R$ 100,00 balance.
    expect(t1.response).toContain("R$ 10,00");
    expect(t1.response).not.toContain("R$ 100,00");
    // The parked envelope carries the threaded centavos amount.
    const parks = session.parksFor(sessionId);
    expect(parks).toHaveLength(1);
    const parkedPayload = parks[0]!.envelope.payload as Record<string, unknown>;
    expect(parkedPayload.refundAmountCentavos).toBe(1_000);
    // …with the balance still DB-stamped (the model only controls the amount).
    expect(parkedPayload.refundableBalanceCentavos).toBe(10_000);
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();

    // Turn 2 — "sim, confirma" resumes → EXECUTE → the write got the 1000.
    const t2 = await runTurn(deps, "OWNER", "owner8", "sim, confirma");
    expect(t2.decision.kind).toBe("EXECUTE");
    expect(spies.writeAdjudicatedRefund).toHaveBeenCalledTimes(1);
    const [writePayload] = spies.writeAdjudicatedRefund.mock.calls[0]!;
    expect(writePayload.refundAmountCentavos).toBe(1_000);
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });

  it("BKL-094: an over-balance reais ask ({amount:150} on R$100) is NOT clamped → pack REFUSEs", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL_REAIS("4242", 150)], // R$150 > the R$100 DB balance
    });
    const t = await runTurn(deps, "OWNER", "owner9", "reembolsa 150 reais do pedido 4242");
    // The threaded 15_000 exceeds the true (stamped) R$100 balance → honest REFUSE.
    expect(t.decision.kind).toBe("REFUSE");
    expect(session.parksFor("system:staff:owner9")).toHaveLength(0);
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
  });

  it("a park is staff-session-scoped: a DIFFERENT staff's 'sim' does not resume it", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    // owner6 parks a refund.
    await runTurn(deps, "OWNER", "owner6", "reembolsa 50 do pedido 4242");
    expect(session.parksFor("system:staff:owner6")).toHaveLength(1);
    // A DIFFERENT staff session (owner7) says "sim" — its session has NO park, so
    // matchToParked returns null and NOTHING resumes (structural staff-scoping).
    const other = await runTurn(deps, "OWNER", "owner7", "sim, confirma");
    expect(other.decision.kind).not.toBe("EXECUTE");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    // owner6's park is untouched.
    expect(session.parksFor("system:staff:owner6")).toHaveLength(1);
  });
});
