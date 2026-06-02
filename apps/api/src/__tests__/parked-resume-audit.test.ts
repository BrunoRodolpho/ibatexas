/**
 * P0-B parked-resume — the audit invariant, against the REAL audited kernel.
 *
 * The conductor's resume verb (`buildAdjudicator().resume`) must RE-ADJUDICATE
 * a parked envelope, never dispatch-on-confirm. This pins the load-bearing
 * properties through the production `adjudicateAndAudit` bridge + a capturing
 * audit sink (no DB, no network):
 *
 *  1. The first adjudication of a confirmation-gated intent returns
 *     REQUEST_CONFIRMATION and emits one audit row (the envelope is parked by
 *     the dispatcher, NOT executed).
 *  2. `resume` with a receipt matching the parked intentHash re-runs the kernel
 *     against FRESH state; the receipt satisfies only the "ask first" threshold
 *     → EXECUTE, and exactly ONE AuditRecord is emitted (BEFORE the caller
 *     dispatches), carrying a `confirmation_resolved` supersession link back to
 *     the parked REQUEST_CONFIRMATION row.
 *  3. If the state changed since the confirmation was requested, the kernel
 *     REFUSEs and the receipt does NOT override it — no EXECUTE, the refusal is
 *     still audited (money-safety: a stale confirmation cannot license a
 *     now-unsafe mutation).
 *  4. `resume` WITHOUT a receipt is a plain re-adjudication (no override).
 *
 * This is the exact wrong move a naive fix would make (dispatch the parked
 * envelope directly on "yes", firing a mutation with no audited decision); the
 * tests below would catch it.
 */

import { describe, expect, it } from "vitest";
import type { AuditRecord, AuditSink } from "@adjudicate/core";
import {
  buildEnvelope,
  decisionRefuse,
  decisionRequestConfirmation,
  refuse,
} from "@adjudicate/core";
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel";
import { buildAdjudicator } from "../claustrum-bootstrap.js";

function capturingSink(): AuditSink & { readonly records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    async emit(record: AuditRecord) {
      records.push(record);
    },
  };
}

interface MoneyState {
  readonly balanceOk: boolean;
}

/**
 * A confirmation-gated payment policy:
 *  - a STATE guard REFUSEs when the balance is no longer OK (runs first, so it
 *    short-circuits ahead of the confirmation threshold);
 *  - a BUSINESS guard asks for confirmation (REQUEST_CONFIRMATION) for an
 *    otherwise-legal charge.
 * So: balanceOk → REQUEST_CONFIRMATION; !balanceOk → REFUSE (even with a
 * receipt, because the state guard fires before the threshold).
 */
function confirmationGatedPayment(): PolicyBundle<string, unknown, MoneyState> {
  const requireBalance: Guard<string, unknown, MoneyState> = (_env, state) =>
    state.balanceOk
      ? null
      : decisionRefuse(
          refuse(
            "STATE",
            "insufficient_balance",
            "Saldo insuficiente para concluir o pagamento.",
            "balance changed between confirmation request and resume",
          ),
          [],
        );
  const askToConfirm: Guard<string, unknown, MoneyState> = () =>
    decisionRequestConfirmation("Confirma o pagamento de R$50,00?", []);
  return {
    stateGuards: [requireBalance],
    authGuards: [],
    business: [askToConfirm],
    taint: { minimumFor: () => "UNTRUSTED" as const },
    default: "REFUSE",
  };
}

function paymentEnvelope() {
  return buildEnvelope({
    kind: "payment.charge",
    payload: { amountCents: 5000 },
    actor: { principal: "user", sessionId: "web:cust-1" },
    taint: "UNTRUSTED",
    nonce: "n-resume-pay",
    createdAt: "2026-05-28T12:00:00.000Z",
  });
}

const ihOf = (env: unknown): string => (env as { intentHash: string }).intentHash;

describe("P0-B parked-resume — audit invariant (real audited kernel)", () => {
  it("first adjudication of a confirmation-gated charge → REQUEST_CONFIRMATION, one audit row, no EXECUTE", async () => {
    const sink = capturingSink();
    const bridge = buildAdjudicator({ sink });
    const env = paymentEnvelope();

    const decision = await bridge.adjudicate(
      env,
      { balanceOk: true } as never,
      confirmationGatedPayment() as never,
    );

    expect(decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(sink.records).toHaveLength(1); // the confirmation request itself is audited
    expect(sink.records[0]!.intentHash).toBe(ihOf(env));
  });

  it("resume with a matching receipt RE-ADJUDICATES → EXECUTE + exactly ONE audit row (confirmation_resolved) before dispatch", async () => {
    const sink = capturingSink();
    const bridge = buildAdjudicator({ sink });
    const env = paymentEnvelope();
    const intentHash = ihOf(env);

    // The conductor calls resume() AFTER matching the user's "yes" reply — with
    // FRESH state (still safe here). The audit row is written by resume itself,
    // BEFORE the caller dispatches the tool.
    const decision = await bridge.resume!(
      env,
      { balanceOk: true } as never,
      confirmationGatedPayment() as never,
      {
        intentHash,
        at: "2026-05-28T12:05:00.000Z",
        originalAt: "2026-05-28T12:00:00.000Z",
      },
    );

    expect(decision.kind).toBe("EXECUTE"); // the receipt satisfied the "ask first" threshold
    expect(sink.records).toHaveLength(1); // exactly ONE row, emitted before any side-effect
    expect(sink.records[0]!.intentHash).toBe(intentHash);
    // The EXECUTE record links back to the parked REQUEST_CONFIRMATION row.
    const supersedes = (sink.records[0] as { supersedes?: { reason?: string } })
      .supersedes;
    expect(supersedes?.reason).toBe("confirmation_resolved");
  });

  it("resume after the state changed REFUSEs and runs NO execute — receipt does NOT override (money-safety)", async () => {
    const sink = capturingSink();
    const bridge = buildAdjudicator({ sink });
    const env = paymentEnvelope();
    const intentHash = ihOf(env);

    const decision = await bridge.resume!(
      env,
      { balanceOk: false } as never, // balance changed since the confirmation was requested
      confirmationGatedPayment() as never,
      { intentHash, at: "2026-05-28T12:05:00.000Z" },
    );

    expect(decision.kind).toBe("REFUSE"); // state guard fires ahead of the threshold
    expect(sink.records).toHaveLength(1); // the refusal is still audited
    expect(sink.records[0]!.intentHash).toBe(intentHash);
  });

  it("resume WITHOUT a receipt is a plain re-adjudication (no confirmation override)", async () => {
    const sink = capturingSink();
    const bridge = buildAdjudicator({ sink });
    const env = paymentEnvelope();

    const decision = await bridge.resume!(
      env,
      { balanceOk: true } as never,
      confirmationGatedPayment() as never,
    );

    expect(decision.kind).toBe("REQUEST_CONFIRMATION"); // no receipt → no EXECUTE flip
    expect(sink.records).toHaveLength(1);
  });
});
