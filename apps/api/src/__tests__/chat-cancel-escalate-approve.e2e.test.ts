// chat-cancel-escalate-approve — BKL-103's crown-jewel proof, at the REAL
// customer turn seam.
//
// THE HOLE (live-proven 2026-07-19). A customer paid-cancel of a >=R$1.000 order
// ESCALATEs. The customer is told a human will take over — and then NOTHING
// actionable happened: `order.cancel` was absent from `ESCALATION_RESUMABLE_KINDS`,
// so the AUT-017 HandoffPort park seam skipped it. There was no parked envelope, so
// no OWNER could approve-and-execute it; the escalation was audit-row-only (PR #340
// later added a staff NOTIFICATION, but nothing an owner could ACT on).
//
// WHAT THIS DRIVES. A REAL `handleTurn` through `composeCustomerConductor` — the
// production planner, the production RESOLVE stage (`createIbatexasResolver` →
// `resolveAndAssemble`, which is what STAMPS the BKL-103 proposer `actorId`), the
// REAL composed policy router and REAL audited kernel — then the REAL
// `createEscalationApprovalEngine` and the REAL extracted executor
// (`createApprovedOrderCancelExecutor`). The only doubles are the model and the
// outermost I/O clients (`redis`, `@ibatexas/tools`, `@ibatexas/domain`), i.e. the
// DB/cache boundary, never a layer above it.
//
// PROVES, end to end:
//   1. >=R$1.000 PAID cancel → ESCALATE (audit row) + the envelope PARKED, with
//      `proposerId` derived from the STAMP (not the session fallback — the
//      conversational actor.sessionId is a CONVERSATION id, so a fallback would
//      have parked the wrong identity and broken separation of duty).
//   2. STAFF VISIBILITY — the parked record reaches the ops plane read surface
//      (`GET .../escalations` projection shape: intentKind + pt-BR summary + token)
//      and the OWNER approve verb reaches it. This is the assertion the ticket
//      demands: "surfaces nowhere" is only closed if staff can SEE and ACT.
//   3. APPROVE (a DIFFERENT owner) → resume re-adjudicates on FRESH state through
//      the audited kernel → EXECUTE carrying `paid_cancel_escalation_approved`
//      (the marker branch's OWN basis) → the cancel runs EXACTLY ONCE.
//   4. NO RE-MINT — exactly ONE `order.cancel` EXECUTE row for the whole loop.
//   5. SELF-APPROVAL by the proposer is refused without burning the token.
//   6. STATE CHANGED UNDER THE PARK (the order was cancelled meanwhile) → the
//      FRESH adjudication REFUSEs; nothing executes; the park is consumed.
//   7. BELOW-BAND (<R$1.000) paid cancel is UNCHANGED — REQUEST_CONFIRMATION, and
//      NOTHING parks in the escalation store.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";
import { adjudicateAndAudit } from "@adjudicate/core/kernel";

// ── Client-boundary doubles (hoisted — vitest lifts vi.mock above imports) ─────

const redisStorage = vi.hoisted(() => new Map<string, string>());

const orderRows = vi.hoisted(
  () =>
    new Map<
      string,
      {
        id: string;
        displayId: number;
        customerId: string;
        fulfillmentStatus: string;
        paymentStatus: string;
        paymentMethod: string;
        totalInCentavos: number;
        createdAt: string;
      }
    >(),
);
const paymentRows = vi.hoisted(
  () =>
    new Map<
      string,
      {
        id: string;
        orderId: string;
        status: string;
        amountInCentavos: number;
        refundedAmountCentavos: number;
        method: string;
        version: number;
      }
    >(),
);

const spyWriteAdjudicatedRefund = vi.hoisted(() => vi.fn());
const spyCancelRan = vi.hoisted(() => vi.fn());
const spyPublishNats = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("redis", () => {
  const client = {
    isOpen: true,
    connect: async () => client,
    on: () => client,
    get: async (k: string) => redisStorage.get(k) ?? null,
    set: async (k: string, v: string) => {
      redisStorage.set(k, v);
      return "OK";
    },
    del: async (k: string) => (redisStorage.delete(k) ? 1 : 0),
    incr: async () => 1,
    expire: async () => 1,
    eval: async () => null,
    quit: async () => undefined,
  };
  return { createClient: () => client };
});

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getRedisClient: async () => ({
      get: async (k: string) => redisStorage.get(k) ?? null,
      set: async (k: string, v: string) => {
        redisStorage.set(k, v);
        return "OK";
      },
      del: async (k: string) => (redisStorage.delete(k) ? 1 : 0),
      incr: async () => 1,
      expire: async () => 1,
      eval: async () => null,
    }),
    withLock: async (_r: string, fn: () => Promise<unknown>) => fn(),
  };
});

vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createOrderQueryService: () => ({
      getById: async (id: string, opts?: { customerId?: string }) => {
        const row = orderRows.get(id) ?? null;
        if (row === null) return null;
        if (opts?.customerId !== undefined && row.customerId !== opts.customerId) {
          return null;
        }
        return row;
      },
      listByCustomer: async (customerId: string) => ({
        orders: [...orderRows.values()].filter((o) => o.customerId === customerId),
      }),
      findByDisplayId: async (d: number) =>
        [...orderRows.values()].filter((o) => o.displayId === d),
      listAll: async () => ({ orders: [...orderRows.values()] }),
    }),
    createPaymentQueryService: () => ({
      getById: async (id: string) => paymentRows.get(id) ?? null,
      getActiveByOrderId: async (orderId: string) =>
        [...paymentRows.values()].find(
          (p) => p.orderId === orderId && p.status !== "refunded" && p.status !== "canceled",
        ) ?? null,
    }),
    createPaymentCommandService: () => ({
      findActiveByOrderId: async (orderId: string) =>
        [...paymentRows.values()].find(
          (p) => p.orderId === orderId && p.status !== "refunded" && p.status !== "canceled",
        ) ?? null,
      writeAdjudicatedRefund: async (payload: { paymentId: string }) => {
        spyWriteAdjudicatedRefund(payload);
        const p = paymentRows.get(payload.paymentId)!;
        // The committed refund makes the payment TERMINAL — the ordering the
        // approved-cancel executor depends on.
        paymentRows.set(p.id, { ...p, status: "refunded", version: p.version + 1 });
        return {
          version: p.version + 1,
          previousStatus: p.status,
          newStatus: "refunded",
          orderId: p.orderId,
          method: p.method,
          totalRefundedCentavos: p.amountInCentavos,
          refundAmountCentavos: payload_amount(payload),
        };
      },
    }),
  };
});

function payload_amount(p: unknown): number {
  const v = (p as { refundAmountCentavos?: unknown }).refundAmountCentavos;
  return typeof v === "number" ? v : 0;
}

vi.mock("@ibatexas/nats-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, publishNatsEvent: spyPublishNats };
});

// ── Imports (after the mocks) ─────────────────────────────────────────────────

import { resolveAndAssemble } from "../claustrum/resolve-and-assemble.js";
import {
  composeCustomerConductor,
  CUSTOMER_ROUTER,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulCustomerSession,
  runCustomerTurn,
  scriptedModel,
  type ScriptedToolCall,
} from "./customer-e2e-harness.js";
import {
  buildEscalationParkInput,
  ESCALATION_RESUMABLE_KINDS,
  summarizeEscalation,
  type EscalationParkStore,
  type ParkedEscalationIntent,
} from "../escalation/escalation-park-store.js";
import { createEscalationApprovalEngine } from "../escalation/escalation-approval.js";
import { createApprovedOrderCancelExecutor } from "../escalation/approved-cancel-executor.js";
import { settleApprovedInnerRefund } from "../escalation/approved-inner-refund.js";
import { buildOpsRefundResumeState } from "../ops/ops-resolver.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CUSTOMER = "cust_bkl103";
const CONVERSATION = "conv_bkl103";
const ORDER_ID = "order_bkl103";
const PAYMENT_ID = "pay_bkl103";
/** R$1.500 — at/above the R$1.000 escalate band (`>=`). */
const BIG_TOTAL = 150_000;
/** R$50 — below the escalate band, so it CONFIRMS instead. */
const SMALL_TOTAL = 5_000;

function seedOrder(totalInCentavos: number, fulfillmentStatus = "confirmed"): void {
  orderRows.clear();
  paymentRows.clear();
  orderRows.set(ORDER_ID, {
    id: ORDER_ID,
    displayId: 4242,
    customerId: CUSTOMER,
    fulfillmentStatus,
    paymentStatus: "paid",
    paymentMethod: "pix",
    totalInCentavos,
    createdAt: "2026-07-25T10:00:00.000Z",
  });
  paymentRows.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    status: "paid",
    amountInCentavos: totalInCentavos,
    refundedAmountCentavos: 0,
    method: "pix",
    version: 3,
  });
}

const CANCEL_CALL: ScriptedToolCall = {
  id: "tc-cancel",
  name: "express_intent",
  input: { capability: "order.cancel", payload: { reason: "mudei de ideia" } },
};

/** In-memory single-use park store (the production one is Redis-backed). */
function makeFakeParkStore(): EscalationParkStore & {
  size(): number;
  lastToken(): string | undefined;
  all(): ParkedEscalationIntent[];
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
    all: () => [...m.values()],
  };
}

/**
 * The FRESH customer-plane resume projection, built by the SAME production pair
 * the customer branch of `enrichResumeState` composes (`resolveAndAssemble` for
 * the ctx). Driving the real projector — rather than a hand-authored ctx literal —
 * is what makes assertion 6 (state changed under the park) meaningful.
 */
async function projectCancelResumeState(envelope: IntentEnvelope): Promise<unknown> {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const customerId = typeof payload.actorId === "string" ? payload.actorId : "";
  if (customerId === "") return { ctx: { exists: false } };
  const { ctx } = await resolveAndAssemble({
    kind: String(envelope.kind),
    payload,
    customerId,
    channel: "web",
  });
  return { ctx };
}

function buildHarness() {
  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();
  const parkStore = makeFakeParkStore();

  // The AUT-017 PARKING HandoffPort — exactly what natsHandoff(publish, parkDeps)
  // does in production: park the FULL envelope for a resumable kind.
  const parkingHandoff = {
    queue: async (envelope: IntentEnvelope) => {
      if (ESCALATION_RESUMABLE_KINDS.has(String(envelope.kind))) {
        await parkStore.park(buildEscalationParkInput(envelope));
      }
    },
  };

  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: projectCancelResumeState,
  });

  const harness = composeCustomerConductor({
    model: scriptedModel([CANCEL_CALL]),
    session,
    adjudicator,
    handoff: parkingHandoff,
  });

  // The REAL approval engine + the REAL extracted executor.
  const markSpy = vi.fn(async () => null);
  const engine = createEscalationApprovalEngine({
    get: (t) => parkStore.get(t),
    consume: (t) => parkStore.consume(t),
    rebuildState: projectCancelResumeState,
    policyFor: () => CUSTOMER_ROUTER as never,
    sink,
    executors: {
      "order.cancel": createApprovedOrderCancelExecutor({
        getOrder: async (orderId, customerId) => {
          const row = orderRows.get(orderId);
          if (row === undefined || row.customerId !== customerId) return null;
          return { fulfillmentStatus: row.fulfillmentStatus, displayId: row.displayId };
        },
        findActivePayment: async (orderId) =>
          [...paymentRows.values()].find(
            (p) => p.orderId === orderId && p.status === "paid",
          ) ?? null,
        getPayment: async (paymentId) => paymentRows.get(paymentId) ?? null,
        isPaidStatus: (status) => status === "paid",
        // The REAL adjudicated inner-refund settlement: the marker + receipt go
        // through the REAL composed router, so the refund keeps its own kernel
        // decision and audit row (proven per-branch in approved-inner-refund.test.ts).
        settleInnerRefund: (args) =>
          settleApprovedInnerRefund(
            {
              projectPaymentState: async (paymentId) => {
                const p = paymentRows.get(paymentId);
                return buildOpsRefundResumeState(
                  p === undefined
                    ? null
                    : {
                        status: p.status,
                        amountInCentavos: p.amountInCentavos,
                        refundedAmountCentavos: p.refundedAmountCentavos,
                        method: p.method,
                        version: p.version,
                        orderId: p.orderId,
                      },
                  "ibatexas",
                );
              },
              policyForRefund: () => CUSTOMER_ROUTER,
              adjudicate: async ({ envelope, state, policy, receipt }) =>
                (
                  await adjudicateAndAudit(
                    envelope as never,
                    state as never,
                    policy as never,
                    { sink, confirmationReceipt: receipt } as never,
                  )
                ).decision,
              writeRefund: async (payload, approverStaffId) => {
                spyWriteAdjudicatedRefund({ ...payload, actorId: approverStaffId });
                const p = paymentRows.get(payload.paymentId)!;
                paymentRows.set(p.id, { ...p, status: "refunded" });
              },
              now: () => "2026-07-25T13:00:00.000Z",
            },
            args,
          ),
        runCancel: async (args) => {
          spyCancelRan(args);
          const row = orderRows.get(args.orderId)!;
          orderRows.set(row.id, { ...row, fulfillmentStatus: "canceled" });
        },
      }),
    },
    markIntentResolved: markSpy,
    now: () => "2026-07-25T13:00:00.000Z",
  });

  return { harness, session, sink, parkStore, engine, markSpy };
}

/**
 * Drive the REAL two-turn customer cancel flow to the ESCALATE.
 *
 * Turn 1 does NOT escalate: `order.cancel` is in `ORDER_AUTORESOLVE_KINDS` +
 * `AUTORESOLVE_CONFIRM_KINDS`, so a cancel whose target the customer left implicit
 * ("cancela meu pedido") is auto-resolved to their most-recent order and the
 * confirm-on-autoresolve guard FORCES a REQUEST_CONFIRMATION — the customer must
 * first see WHICH order. Turn 2's "sim" resumes that park, and it is on the
 * re-adjudication that `gatePaidCancel`'s >=R$1.000 HIGH band fires. Driving both
 * turns is the point of a turn-seam test: the escalate-and-park seam is only
 * reachable through the confirm-resume, so a single-turn test would assert against
 * a state production never reaches here.
 */
async function escalateViaTurns(harness: ReturnType<typeof buildHarness>["harness"]) {
  const proposal = await runCustomerTurn(harness, {
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    text: "cancela meu pedido, por favor",
  });
  const confirm = await runCustomerTurn(harness, {
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    text: "sim",
  });
  return { proposal, confirm };
}

describe("BKL-103 — >=R$1.000 paid cancel: ESCALATE → park → staff-visible → OWNER approve → resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStorage.clear();
    seedOrder(BIG_TOTAL);
  });

  it("ESCALATEs and PARKS with the proposer stamp; an OWNER approval resumes it to EXACTLY ONE cancel", async () => {
    const { harness, sink, parkStore, engine, markSpy } = buildHarness();

    // ── 1) the customer turns: propose → confirm the auto-resolved order ────
    const { proposal, confirm } = await escalateViaTurns(harness);
    expect(proposal.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(confirm.decision.kind).toBe("ESCALATE");

    const escalateRec = sink.lastDecision("ESCALATE");
    expect(escalateRec).toBeDefined();
    expect(String(escalateRec!.envelope.kind)).toBe("order.cancel");
    const intentHash = escalateRec!.envelope.intentHash;
    // The ESCALATE came from the paid-cancel HIGH band, not some other guard.
    expect(
      escalateRec!.decision.basis.some(
        (b) =>
          (b.detail as { reason?: string } | undefined)?.reason ===
          "paid_cancel_refund_above_escalate_threshold",
      ),
    ).toBe(true);

    // ── 2) the envelope PARKED (this is the whole pre-BKL-103 hole) ──────────
    expect(parkStore.size()).toBe(1);
    const token = parkStore.lastToken()!;
    const parked = (await parkStore.get(token))!;
    expect(parked.intentKind).toBe("order.cancel");
    expect(parked.intentHash).toBe(intentHash);
    // The PROPOSER STAMP — the authenticated customer, resolver-stamped onto
    // payload.actorId. NOT the session fallback: the conversational envelope's
    // actor.sessionId is the CONVERSATION id, so a fallback would have parked
    // that instead and the self-approve comparand would be meaningless.
    expect(parked.proposerId).toBe(CUSTOMER);
    expect(parked.proposerId).not.toBe(CONVERSATION);
    expect((parked.payload as { actorId?: string }).actorId).toBe(CUSTOMER);

    // ── 3) STAFF VISIBILITY: the parked record carries everything the ops
    //      escalations surface renders + the approve verb addresses. The route
    //      (routes/admin/escalations.ts) is kind-AGNOSTIC — `intentKind:
    //      z.string()` — so a projection with these fields IS reachable.
    expect(parked.summaryPtBr).toBe(`cancelamento do pedido ${ORDER_ID}`);
    expect(summarizeEscalation(escalateRec!.envelope)).toBe(parked.summaryPtBr);
    // pt-BR, never a bare kind string (Hard Rule #4).
    expect(parked.summaryPtBr).not.toBe("order.cancel");
    // The approve verb is addressed by (sessionId, token) — both present.
    expect(parked.sessionId).toBe(CONVERSATION);
    expect(token).toBeTruthy();

    // ── 4) SELF-APPROVAL by the proposer is refused WITHOUT burning the token ─
    const selfApprove = await engine.resolve({
      token,
      accept: true,
      approver: { id: CUSTOMER, role: "OWNER" },
      expectedSessionId: parked.sessionId,
    });
    expect(selfApprove.status).toBe("self_approve");
    expect(parkStore.size()).toBe(1); // token NOT burned
    expect(spyCancelRan).not.toHaveBeenCalled();

    // ── 5) a DIFFERENT owner approves → resume EXECUTEs ─────────────────────
    const result = await engine.resolve({
      token,
      accept: true,
      approver: { id: "owner_approver", role: "OWNER" },
      expectedSessionId: parked.sessionId,
    });
    expect(result.status).toBe("approved");
    expect(result.decision?.kind).toBe("EXECUTE");
    // The EXECUTE was reached through the OWNER-APPROVAL MARKER BRANCH — the
    // BKL-116 threshold-drift assertion the engine enforces for this kind.
    expect(
      result.decision!.basis.some(
        (b) =>
          b.category === "business" &&
          (b.detail as { reason?: string } | undefined)?.reason ===
            "paid_cancel_escalation_approved",
      ),
    ).toBe(true);

    // The cancel ran EXACTLY ONCE, and the refund was settled first.
    expect(spyCancelRan).toHaveBeenCalledTimes(1);
    expect(spyWriteAdjudicatedRefund).toHaveBeenCalledTimes(1);
    expect(spyCancelRan.mock.calls[0]![0]).toMatchObject({
      orderId: ORDER_ID,
      customerId: CUSTOMER,
    });
    // Refund authored by the APPROVER (Option 1 provenance), full balance.
    expect(spyWriteAdjudicatedRefund.mock.calls[0]![0]).toMatchObject({
      paymentId: PAYMENT_ID,
      refundAmountCentavos: BIG_TOTAL,
      actorId: "owner_approver",
    });
    expect(markSpy).toHaveBeenCalledWith(
      CONVERSATION,
      intentHash,
      "approved",
      "staff:owner_approver",
      expect.any(String),
    );

    // ── 6) NO RE-MINT: exactly ONE order.cancel EXECUTE row for the loop ────
    const cancelExecutes = sink.records.filter(
      (r) => String(r.envelope.kind) === "order.cancel" && r.decision.kind === "EXECUTE",
    );
    expect(cancelExecutes).toHaveLength(1);
    expect(cancelExecutes[0]!.envelope.intentHash).toBe(intentHash);
    expect(cancelExecutes[0]!.supersedes?.reason).toBe("confirmation_resolved");
    expect(cancelExecutes[0]!.supersedes?.binding).toMatchObject({
      approver: "staff:owner_approver",
    });

    // ── 7) token replay after a successful approve → suppressed ─────────────
    const replay = await engine.resolve({
      token,
      accept: true,
      approver: { id: "owner_approver", role: "OWNER" },
    });
    expect(replay.status).toBe("missing");
    expect(spyCancelRan).toHaveBeenCalledTimes(1); // still once
  });

  it("STATE CHANGED UNDER THE PARK — the order was cancelled meanwhile → FRESH adjudication REFUSEs; nothing executes; park consumed", async () => {
    const { harness, parkStore, engine } = buildHarness();
    const { confirm } = await escalateViaTurns(harness);
    expect(confirm.decision.kind).toBe("ESCALATE");
    const token = parkStore.lastToken()!;

    // The world moves under the park: the order is already canceled.
    const row = orderRows.get(ORDER_ID)!;
    orderRows.set(ORDER_ID, { ...row, fulfillmentStatus: "canceled" });

    const result = await engine.resolve({
      token,
      accept: true,
      approver: { id: "owner_approver", role: "OWNER" },
    });
    // The resume re-projected FRESH state and the kernel refused on it — the
    // approval could not rescue a since-changed order.
    expect(result.status).toBe("denied_by_kernel");
    expect(result.decision?.kind).not.toBe("EXECUTE");
    expect(spyCancelRan).not.toHaveBeenCalled();
    expect(spyWriteAdjudicatedRefund).not.toHaveBeenCalled();
    expect(parkStore.size()).toBe(0); // consumed even on a denied resume
  });

  it("a DENIED approval never runs the cancel and consumes the park", async () => {
    const { harness, parkStore, engine } = buildHarness();
    await escalateViaTurns(harness);
    const token = parkStore.lastToken()!;
    const result = await engine.resolve({
      token,
      accept: false,
      approver: { id: "owner_approver", role: "OWNER" },
    });
    expect(result.status).toBe("rejected");
    expect(spyCancelRan).not.toHaveBeenCalled();
    expect(parkStore.size()).toBe(0);
  });

  it("BELOW-BAND (<R$1.000) paid cancel is UNCHANGED — REQUEST_CONFIRMATION and NOTHING parks", async () => {
    seedOrder(SMALL_TOTAL);
    const { harness, parkStore } = buildHarness();
    const { proposal, confirm } = await escalateViaTurns(harness);
    // Turn 1 confirms (auto-resolve), and the "sim" resume EXECUTEs or confirms —
    // either way it never ESCALATEs, so nothing reaches the escalation park.
    expect(proposal.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(confirm.decision.kind).not.toBe("ESCALATE");
    // The escalation park is for the ESCALATE band only — a confirm parks in the
    // SESSION (the ordinary two-phase confirm), never in the escalation store.
    expect(parkStore.size()).toBe(0);
  });
});
