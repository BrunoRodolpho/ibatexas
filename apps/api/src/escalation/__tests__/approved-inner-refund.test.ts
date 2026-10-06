// approved-inner-refund — BKL-103. Proof that the approved cancel's implied refund
// is settled through the REAL composed policy router + REAL kernel on the APPROVER's
// authority, and that every failure mode refuses to move money.
//
// This is the money-critical arm of BKL-103. The naive alternatives both fail:
// re-running the inner refund ESCALATEs at >=R$1.000 (dead), and jumping straight to
// `writeAdjudicatedRefund` moves real money with no kernel decision (a bypass). Arm 1
// proves the composition actually reaches an audited EXECUTE with the escalate-band
// marker basis, driven through OPS_ROUTER — the exact composed bundle production's
// `policyForKind("payment.refund.issue")` resolves.

import { describe, expect, it, vi } from "vitest";
import { adjudicateAndAudit } from "@adjudicate/core/kernel";
import type { AuditRecord, Decision, IntentEnvelope } from "@adjudicate/core";
import {
  settleApprovedInnerRefund,
  refundExecuteReachedViaMarker,
  createInnerRefundPaymentStateProjector,
  createRefundPolicyResolver,
  REFUND_ESCALATION_APPROVED_BASIS,
  type ApprovedInnerRefundDeps,
} from "../approved-inner-refund.js";
import { buildOpsRefundResumeState } from "../../ops/ops-resolver.js";
import { OPS_ROUTER } from "../../ops/__tests__/ops-e2e-harness.js";

const AT = "2026-07-25T13:00:00.000Z";
const ORDER_ID = "order_bkl103";
const PAYMENT_ID = "pay_bkl103";
/** The CANCEL's proposer — a CUSTOMER id. */
const PROPOSER = "cust_1";
const APPROVER = { id: "owner_approver", role: "OWNER" };
/** R$1.500 — at/above the R$1.000 refund escalate band. */
const BIG = 150_000;

const LIVE_PAID = {
  status: "paid",
  amountInCentavos: BIG,
  refundedAmountCentavos: 0,
  method: "pix",
  version: 3,
  orderId: ORDER_ID,
};

/**
 * The REAL audited kernel over the REAL composed router — only the sink is a spy.
 * `adjudicateAndAudit` (not the pure `adjudicate`, which takes no receipt) is where
 * the confirmation-receipt 2a override lives, and it is the exact verb production's
 * escalation-approval engine calls.
 */
function realAdjudicate(records: AuditRecord[] = []): ApprovedInnerRefundDeps["adjudicate"] {
  return async ({ envelope, state, policy, receipt }) =>
    (
      await adjudicateAndAudit(envelope as never, state as never, policy as never, {
        sink: {
          emit: async (r: AuditRecord) => {
            records.push(r);
          },
        },
        confirmationReceipt: receipt,
      } as never)
    ).decision as Decision;
}

function makeDeps(
  overrides: Partial<ApprovedInnerRefundDeps> = {},
  payment: typeof LIVE_PAID | null = LIVE_PAID,
) {
  const auditRecords: AuditRecord[] = [];
  const writeRefund = vi.fn<ApprovedInnerRefundDeps["writeRefund"]>(
    async () => undefined,
  );
  const deps: ApprovedInnerRefundDeps = {
    projectPaymentState: async () =>
      buildOpsRefundResumeState(payment, "ibatexas"),
    policyForRefund: () => OPS_ROUTER,
    adjudicate: realAdjudicate(auditRecords),
    writeRefund,
    now: () => AT,
    ...overrides,
  };
  return { deps, writeRefund, auditRecords };
}

const ARGS = {
  orderId: ORDER_ID,
  paymentId: PAYMENT_ID,
  amountInCentavos: BIG,
  currentRefundedCentavos: 0,
  proposerId: PROPOSER,
  approver: APPROVER,
  reason: "Cancelamento aprovado",
};

describe("BKL-103 — settleApprovedInnerRefund", () => {
  it("settles a >=R$1.000 implied refund through the REAL router: EXECUTE carrying the escalate-band marker basis", async () => {
    const { deps, writeRefund } = makeDeps();
    const result = await settleApprovedInnerRefund(deps, ARGS);

    expect(result.settled).toBe(true);
    expect(result.refundAmountCentavos).toBe(BIG);
    // The kernel actually EXECUTEd — not a mocked verdict.
    expect(result.decision?.kind).toBe("EXECUTE");
    // …and it got there through the OWNER-approval marker branch, not some other
    // band. This is the assertion that distinguishes an authorized settlement from
    // a laundered one.
    expect(refundExecuteReachedViaMarker(result.decision!)).toBe(true);
    expect(
      result.decision!.basis.some(
        (b) =>
          (b.detail as { reason?: string } | undefined)?.reason ===
          REFUND_ESCALATION_APPROVED_BASIS,
      ),
    ).toBe(true);

    // Persisted exactly once, authored by the APPROVER.
    expect(writeRefund).toHaveBeenCalledTimes(1);
    const [payload, approverStaffId] = writeRefund.mock.calls[0]!;
    expect(approverStaffId).toBe(APPROVER.id);
    expect(payload).toMatchObject({
      paymentId: PAYMENT_ID,
      refundAmountCentavos: BIG,
      // The ADJUDICATED payload names the cancel's PROPOSER — the comparand the
      // pack overlay checks the approver against.
      actorId: PROPOSER,
    });
  });

  it("SELF-APPROVAL cannot settle: an approver equal to the cancel's proposer never converts the ESCALATE", async () => {
    const { deps, writeRefund } = makeDeps();
    await expect(
      settleApprovedInnerRefund(deps, {
        ...ARGS,
        approver: { id: PROPOSER, role: "OWNER" },
      }),
    ).rejects.toThrow(/did NOT settle \(kernel decision: ESCALATE\)/);
    expect(writeRefund).not.toHaveBeenCalled();
  });

  it("a NON-OWNER approver cannot settle (the overlay hard-gates on OWNER)", async () => {
    const { deps, writeRefund } = makeDeps();
    await expect(
      settleApprovedInnerRefund(deps, {
        ...ARGS,
        approver: { id: "mgr_1", role: "MANAGER" },
      }),
    ).rejects.toThrow(/did NOT settle/);
    expect(writeRefund).not.toHaveBeenCalled();
  });

  it("a payment that became NON-REFUNDABLE under the park (disputed) REFUSEs — no money moves", async () => {
    const { deps, writeRefund } = makeDeps({}, { ...LIVE_PAID, status: "disputed" });
    await expect(settleApprovedInnerRefund(deps, ARGS)).rejects.toThrow(
      /did NOT settle/,
    );
    expect(writeRefund).not.toHaveBeenCalled();
  });

  it("a VANISHED payment projection REFUSEs — fail-closed", async () => {
    const { deps, writeRefund } = makeDeps({}, null);
    await expect(settleApprovedInnerRefund(deps, ARGS)).rejects.toThrow(
      /did NOT settle/,
    );
    expect(writeRefund).not.toHaveBeenCalled();
  });

  it("a partial refund SINCE parking is honoured — only the REMAINING balance is refunded", async () => {
    const { deps, writeRefund } = makeDeps(
      {},
      { ...LIVE_PAID, refundedAmountCentavos: 50_000 },
    );
    const result = await settleApprovedInnerRefund(deps, {
      ...ARGS,
      currentRefundedCentavos: 50_000,
    });
    expect(result.settled).toBe(true);
    expect(result.refundAmountCentavos).toBe(100_000);
    expect(writeRefund.mock.calls[0]![0]).toMatchObject({
      refundAmountCentavos: 100_000,
      currentRefundedCentavos: 50_000,
    });
  });

  it("a FULLY refunded balance is a no-op, not a failure (settled:false, nothing written)", async () => {
    const { deps, writeRefund } = makeDeps();
    const result = await settleApprovedInnerRefund(deps, {
      ...ARGS,
      currentRefundedCentavos: BIG,
    });
    expect(result.settled).toBe(false);
    expect(result.refundAmountCentavos).toBe(0);
    expect(writeRefund).not.toHaveBeenCalled();
  });

  it("BKL-116 parity — an EXECUTE reached WITHOUT the marker basis refuses to move money", async () => {
    // Simulate escalate-threshold drift: the kernel says EXECUTE, but via a band
    // that carries no owner/self-approve assertion. The unconditional receipt must
    // not be able to launder that into a settlement.
    const { deps, writeRefund } = makeDeps({
      adjudicate: async () =>
        ({
          kind: "EXECUTE",
          basis: [
            {
              category: "business",
              code: "RULE_SATISFIED",
              detail: { reason: "some_other_band" },
            },
          ],
        }) as unknown as Decision,
    });
    await expect(settleApprovedInnerRefund(deps, ARGS)).rejects.toThrow(
      /WITHOUT the escalation-approval basis/,
    );
    expect(writeRefund).not.toHaveBeenCalled();
  });

  it("the inner refund envelope's nonce is DETERMINISTIC so a retried approval is ledger-suppressed, not double-refunded", async () => {
    const seen: IntentEnvelope[] = [];
    const { deps } = makeDeps({
      adjudicate: async ({ envelope, state, policy, receipt }) => {
        seen.push(envelope);
        return realAdjudicate()({ envelope, state, policy, receipt });
      },
    });
    await settleApprovedInnerRefund(deps, ARGS);
    await settleApprovedInnerRefund(deps, ARGS);
    expect(seen).toHaveLength(2);
    // Same order + payment ⇒ same nonce ⇒ same intentHash ⇒ the always-on ledger
    // suppresses the duplicate in production.
    expect(seen[0]!.nonce).toBe(seen[1]!.nonce);
    expect(seen[0]!.intentHash).toBe(seen[1]!.intentHash);
  });
});

// ── The production wiring helpers (extracted OUT of the composition root so they
//    are drivable here rather than only reachable via a booted process) ──────────

describe("BKL-103 — createInnerRefundPaymentStateProjector", () => {
  it("maps a live payment row into the refund state, defaulting a null refunded total to ZERO", async () => {
    const seen: unknown[] = [];
    const project = createInnerRefundPaymentStateProjector({
      getPayment: async () => ({
        status: "paid",
        amountInCentavos: BIG,
        // A null refunded total must read as NOTHING refunded — never as the full
        // amount, which would silently make the refundable balance zero.
        refundedAmountCentavos: null,
        method: "pix",
        version: 3,
        orderId: ORDER_ID,
      }),
      buildRefundState: (p, tenantId) => {
        seen.push({ p, tenantId });
        return { ctx: { exists: p !== null } };
      },
      tenantId: "ibatexas",
    });

    await project(PAYMENT_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tenantId: "ibatexas",
      p: {
        status: "paid",
        amountInCentavos: BIG,
        refundedAmountCentavos: 0,
        method: "pix",
        version: 3,
        orderId: ORDER_ID,
      },
    });
  });

  it("projects NULL for a vanished payment — the kernel then REFUSEs (fail-closed)", async () => {
    const project = createInnerRefundPaymentStateProjector({
      getPayment: async () => null,
      buildRefundState: (p) => ({ ctx: { exists: p !== null } }),
      tenantId: "ibatexas",
    });
    expect(await project(PAYMENT_ID)).toEqual({ ctx: { exists: false } });
  });

  it("is wired to the REAL projector: a live paid row yields a refundable state, a disputed one does not", async () => {
    const paid = createInnerRefundPaymentStateProjector({
      getPayment: async () => ({
        status: "paid",
        amountInCentavos: BIG,
        refundedAmountCentavos: 0,
        method: "pix",
        version: 3,
        orderId: ORDER_ID,
      }),
      buildRefundState: buildOpsRefundResumeState,
      tenantId: "ibatexas",
    });
    expect(await paid(PAYMENT_ID)).not.toEqual({ ctx: { exists: false } });

    const disputed = createInnerRefundPaymentStateProjector({
      getPayment: async () => ({
        status: "disputed",
        amountInCentavos: BIG,
        refundedAmountCentavos: 0,
        method: "pix",
        version: 3,
        orderId: ORDER_ID,
      }),
      buildRefundState: buildOpsRefundResumeState,
      tenantId: "ibatexas",
    });
    // OPS_REFUNDABLE_STATUSES excludes `disputed` ⇒ no refund on a chargeback.
    expect(await disputed(PAYMENT_ID)).toEqual({ ctx: { exists: false } });
  });
});

describe("BKL-103 — createRefundPolicyResolver", () => {
  it("returns the composed refund bundle", () => {
    const resolve = createRefundPolicyResolver((kind) =>
      kind === "payment.refund.issue" ? OPS_ROUTER : null,
    );
    expect(resolve()).toBe(OPS_ROUTER);
  });

  it("THROWS LOUDLY when no installed pack owns the kind (never adjudicates against undefined)", () => {
    expect(() => createRefundPolicyResolver(() => null)()).toThrow(
      /no installed pack owns kind "payment.refund.issue"/,
    );
    expect(() => createRefundPolicyResolver(() => undefined)()).toThrow(
      /no installed pack owns/,
    );
  });
});
