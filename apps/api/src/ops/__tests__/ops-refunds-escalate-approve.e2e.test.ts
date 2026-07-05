// ops-refunds-escalate-approve — the AUT-017 crown-jewel proof: an above-threshold
// (>R$1000) staff refund driven END-TO-END through composeOpsConductor + the REAL
// composed policy router + REAL audited kernel ESCALATEs and PARKS; an OWNER then
// approves it out-of-band and the SAME audited kernel resumes it to EXECUTE and
// runs the BKL-085 refund trio. No DB/network — the model, payment reads, park
// store, and refund WRITE are fakes/spies.
//
// Proves the whole ESCALATE→OWNER-approve→executable-resume loop:
//   - OWNER "reembolsa 1500 do pedido 4242" → ESCALATE (audit row) + the resumable
//     envelope PARKED (the HandoffPort's AUT-017 seam), NOT the CONFIRM session-park.
//   - approve (a DIFFERENT owner) → the parked envelope re-adjudicates through the
//     composed router (staffRoleGuard re-runs) with the escalationApproval marker +
//     confirmationReceipt → EXECUTE (audit row, confirmation_resolved + binding.approver)
//     → writeAdjudicatedRefund ONCE + payment.status_changed ONCE; the lineage
//     invariant holds over the captured rows.
//   - token replay after a successful approve → suppressed (single-use park); write
//     stays exactly once.
//   - deny → the write NEVER runs.
//   - a partial refund since parking (live-state divergence) → REFUSE on resume; the
//     write never runs and the park is consumed (single-use).

import { describe, expect, it, vi } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";
import {
  createOpsResolver,
  buildOpsRefundResumeState,
} from "../ops-resolver.js";
import { executeRefund, type OpsToolRegistryDeps } from "../ops-tool-registry.js";
import {
  buildEscalationParkInput,
  ESCALATION_RESUMABLE_KINDS,
  type EscalationParkStore,
  type ParkedEscalationIntent,
} from "../../escalation/escalation-park-store.js";
import {
  createEscalationApprovalEngine,
  verifyEscalationApprovalLineage,
} from "../../escalation/escalation-approval.js";
import {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
  scriptedModel,
  OPS_ROUTER,
  type ScriptedToolCall,
  type StaffRole,
} from "./ops-e2e-harness.js";

/** A refundable active payment with a BIG balance so >R$1000 ESCALATEs (not over-balance). */
const BIG_PAID = {
  paymentId: "pay_db_1",
  status: "paid",
  amountInCentavos: 500_000, // R$5000 balance
  refundedAmountCentavos: 0,
  method: "pix",
  version: 3,
  orderId: "order_4242",
};

/** An in-memory single-use park store (get/consume/park) + a peek at the tokens. */
function makeFakeParkStore(): EscalationParkStore & {
  size(): number;
  lastToken(): string | undefined;
} {
  const m = new Map<string, ParkedEscalationIntent>();
  let last: string | undefined;
  return {
    async park(input) {
      const token = input.token ?? `park-${m.size + 1}`;
      m.set(token, { ...input, token });
      last = token;
      return { token, ttlSeconds: 86_400 };
    },
    async consume(token) {
      const r = m.get(token) ?? null;
      if (r) m.delete(token);
      return r;
    },
    async get(token) {
      return m.get(token) ?? null;
    },
    size: () => m.size,
    lastToken: () => last,
  };
}

function buildHarness(opts: {
  toolCalls: ReadonlyArray<ScriptedToolCall>;
  paymentById?: (id: string) => typeof BIG_PAID | null;
}) {
  const sink = makeCapturingAuditSink();
  const session = makeStatefulSession();
  const { tools, spies } = buildOpsTools({}, sink);
  const paymentById = opts.paymentById ?? (() => BIG_PAID);
  const parkStore = makeFakeParkStore();

  // AUT-017 — the PARKING HandoffPort: a resumable-kind ESCALATE parks the FULL
  // envelope (exactly what natsHandoff(publish, parkDeps) does in production).
  const parkingHandoff = {
    queue: async (envelope: IntentEnvelope) => {
      if (ESCALATION_RESUMABLE_KINDS.has(String(envelope.kind))) {
        await parkStore.park(buildEscalationParkInput(envelope));
      }
    },
  };

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
    handoff: parkingHandoff,
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
                totalInCentavos: 500_000,
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
                    totalInCentavos: 500_000,
                  },
                ]
              : [],
          listRecentActive: async () => [],
        },
        lookupActivePayment: async () => BIG_PAID,
      }),
  });

  // The escalation-approval engine wired to the SAME sink + refund spies, so the
  // ESCALATE row (turn) and the resumed EXECUTE row (approve) land in one trail and
  // the refund write count is shared.
  const markSpy = vi.fn(async () => null);
  const refundDeps = {
    paymentCmdSvc: { writeAdjudicatedRefund: spies.writeAdjudicatedRefund },
    publishPaymentStatusChanged: spies.publishPaymentStatusChanged,
    appendRefundEventLog: spies.appendRefundEventLog,
  } as unknown as OpsToolRegistryDeps;

  const engine = createEscalationApprovalEngine({
    get: (t) => parkStore.get(t),
    consume: (t) => parkStore.consume(t),
    rebuildState: async (env) => {
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      const paymentId =
        typeof payload.paymentId === "string" ? payload.paymentId : "";
      return buildOpsRefundResumeState(
        paymentId === "" ? null : paymentById(paymentId),
        "ibatexas",
      );
    },
    policyFor: () => OPS_ROUTER as never,
    sink,
    executors: {
      "payment.refund.issue": async (payload, approverStaffId) => {
        await executeRefund(refundDeps, payload as never, approverStaffId);
      },
    },
    markIntentResolved: markSpy,
    now: () => "2026-07-04T13:00:00.000Z",
  });

  return { deps, session, spies, sink, parkStore, engine, markSpy };
}

const runTurn = (
  deps: ReturnType<typeof buildHarness>["deps"],
  role: StaffRole,
  staffId: string,
  text: string,
) => runOpsTurn(deps, { role, staffId, text });

const REFUND_CALL = (orderRef: string, reais: number): ScriptedToolCall => ({
  id: "tc-refund",
  name: "express_intent",
  input: {
    capability: "payment.refund.issue",
    payload: { orderId: orderRef, amount: reais, reason: "cliente pediu" },
  },
});

describe("AUT-017 refunds-escalate-approve — end-to-end ESCALATE → OWNER approve → EXECUTE", () => {
  it("OWNER >R$1000 refund ESCALATEs + parks, then an OWNER approval EXECUTEs it ONCE with lineage", async () => {
    const { deps, session, spies, sink, parkStore, engine, markSpy } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 1500)],
    });

    // Turn 1 — ESCALATE + park.
    const t1 = await runTurn(deps, "OWNER", "owner1", "reembolsa 1500 reais do pedido 4242");
    expect(t1.decision.kind).toBe("ESCALATE");
    expect(parkStore.size()).toBe(1);
    expect(session.parksFor("system:staff:owner1")).toHaveLength(0); // NOT the CONFIRM park
    const escalateRec = sink.lastDecision("ESCALATE");
    expect(escalateRec).toBeDefined();
    expect(String(escalateRec!.envelope.kind)).toBe("payment.refund.issue");
    expect(escalateRec!.envelope.actor.role).toBe("OWNER");
    const intentHash = escalateRec!.envelope.intentHash;
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();

    // The proposer is owner1; a DIFFERENT owner (owner2) approves.
    const token = parkStore.lastToken()!;
    const result = await engine.resolve({
      token,
      accept: true,
      approver: { id: "owner2", role: "OWNER" },
    });
    expect(result.status).toBe("approved");
    expect(result.decision?.kind).toBe("EXECUTE");
    // The refund trio ran exactly once, authored by the APPROVER.
    expect(spies.writeAdjudicatedRefund).toHaveBeenCalledTimes(1);
    const [writePayload] = spies.writeAdjudicatedRefund.mock.calls[0]!;
    expect(writePayload.paymentId).toBe("pay_db_1");
    expect(writePayload.refundAmountCentavos).toBe(150_000); // R$1500 threaded to centavos
    expect(writePayload.actorId).toBe("owner2"); // author = approver
    expect(spies.publishPaymentStatusChanged).toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledWith(
      expect.any(String),
      intentHash,
      "approved",
      "staff:owner2",
      expect.any(String),
    );

    // KERNEL FACT — the resumed EXECUTE carries confirmation_resolved + the approver binding.
    const executeRec = sink.lastDecision("EXECUTE");
    expect(executeRec).toBeDefined();
    expect(executeRec!.envelope.intentHash).toBe(intentHash);
    expect(executeRec!.supersedes?.reason).toBe("confirmation_resolved");
    expect(executeRec!.supersedes?.binding).toMatchObject({ approver: "staff:owner2" });

    // The lineage invariant holds over the captured trail (ESCALATE + resumed EXECUTE).
    const lineage = verifyEscalationApprovalLineage(sink.records, intentHash, {
      token,
      intentKind: "payment.refund.issue",
      intentHash,
      summaryPtBr: "reembolso de R$ 1.500,00",
      requestedAt: "2026-07-04T12:00:00.000Z",
      status: "approved",
      resolvedBy: "staff:owner2",
    });
    expect(lineage.ok).toBe(true);

    // Token replay after a successful approve → suppressed (single-use park).
    const replay = await engine.resolve({
      token,
      accept: true,
      approver: { id: "owner2", role: "OWNER" },
    });
    expect(replay.status).toBe("missing");
    expect(spies.writeAdjudicatedRefund).toHaveBeenCalledTimes(1); // still once
  });

  it("deny → the write NEVER runs and the park is consumed", async () => {
    const { deps, spies, parkStore, engine } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 1500)],
    });
    await runTurn(deps, "OWNER", "owner1", "reembolsa 1500 reais do pedido 4242");
    const token = parkStore.lastToken()!;
    const result = await engine.resolve({
      token,
      accept: false,
      approver: { id: "owner2", role: "OWNER" },
    });
    expect(result.status).toBe("rejected");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    expect(parkStore.size()).toBe(0); // consumed
  });

  it("a partial refund SINCE parking (live divergence) → REFUSE on resume; no write; park consumed", async () => {
    // At park time the payload snapshot said currentRefunded=0; by resume the live
    // payment shows R$1000 already refunded → the magnitude guard's divergence check
    // REFUSEs on the fresh state (money-safe).
    const { deps, spies, parkStore, engine } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 1500)],
      paymentById: () => ({ ...BIG_PAID, refundedAmountCentavos: 100_000 }),
    });
    await runTurn(deps, "OWNER", "owner1", "reembolsa 1500 reais do pedido 4242");
    const token = parkStore.lastToken()!;
    const result = await engine.resolve({
      token,
      accept: true,
      approver: { id: "owner2", role: "OWNER" },
    });
    expect(result.status).toBe("denied_by_kernel");
    expect(result.decision?.kind).toBe("REFUSE");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    expect(parkStore.size()).toBe(0); // consumed even on a denied resume
  });
});
