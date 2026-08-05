// Customer order actions — post-order capabilities for web/mobile.
//
// POST /api/orders/:id/cancel                — cancel order (before PONR)
// POST /api/orders/:id/notes                 — add order note
// GET  /api/orders/:id/notes                 — list order notes
// GET  /api/orders/:id/payment               — payment status + PIX data
// POST /api/orders/:id/payment/retry         — retry payment (same method)
// POST /api/orders/:id/payment/regenerate-pix — regenerate PIX QR code
// PATCH /api/orders/:id/payment/method       — switch payment method
//
// All routes require authentication + ownership verification.

import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import {
  getRedisClient,
  rk,
  withLock,
  amendOrder,
  changeDeliveryAddress,
  switchOrderType,
  medusaAdmin,
  medusaAdjudicated,
} from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createOrderCommandService,
  createOrderQueryService,
  createPaymentCommandService,
  createPaymentQueryService,
  prisma,
  InvalidTransitionError,
  type OrderCommandService,
  type OrderQueryService,
  type PaymentCommandService,
  type PaymentQueryService,
  type OrderStatusTransitionPayload,
  type PaymentCreatePayload,
  type PaymentRefundIssuePayload,
  type PaymentRegenerationCountIncrementPayload,
  type PaymentStatusTransitionPayload,
} from "@ibatexas/domain";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";
// BKL-103 — the AUT-017 park seam for the HTTP cancel plane (the conductor's
// HandoffPort covers the conversational plane; runCustomerIntent has no handoff).
import {
  buildEscalationParkInput,
  ESCALATION_RESUMABLE_KINDS,
  getEscalationParkStore,
} from "../escalation/escalation-park-store.js";
import {
  OrderFulfillmentStatus,
  PaymentStatus,
  canPerformAction,
  canTransitionPayment,
  isTerminalPaymentStatus,
} from "@ibatexas/types";
import { getEffectivePonr } from "@ibatexas/domain";
import {
  ordersPolicyBundle,
  portugueseRefusalMessages,
  type OrderAddressChangePayload,
  type OrderAmendRequestPayload,
  type OrderCancelPayload,
  type OrderNoteAddPayload,
  type OrderState,
  type OrderTypeSwitchPayload,
} from "@ibatexas/pack-orders";
import {
  paymentsPolicyBundle,
  type PaymentMethodSwitchPayload,
  type PaymentRetryPayload,
  type PaymentState,
} from "@ibatexas/pack-payments";
import { getAuditSink } from "@ibatexas/audit-sink";
import { type AgentContext, Channel } from "@ibatexas/types";
import { requireAuth } from "../middleware/auth.js";
import {
  buildCustomerEnvelope,
  runCustomerIntent,
  type CustomerIntentReply,
} from "./__shared__/customer-intent-gateway.js";
import { createOrderCancelConfirmationStore } from "./order-cancel-confirmation-store.js";
import {
  identityCtx,
  buildOrderCtx,
  type OrderProjectionLite,
} from "../claustrum/resolve-and-assemble.js";

/** Build a minimal AgentContext for API-originated tool calls. */
function apiContext(customerId: string): AgentContext {
  return { customerId, channel: Channel.Web, sessionId: "api", userType: "customer" };
}

type PaymentMethodLiteral = "pix" | "card" | "cash";

/**
 * Result of {@link replaceActivePayment}.
 * - `ok`          — the old payment was canceled and the replacement created.
 * - `compensated` — the replacement `create(newMethod)` failed, but we re-created
 *   an active payment with the ORIGINAL method, so the order is left in a usable
 *   payment state (the customer's prior method is restored).
 * - `orphaned`    — the replacement create failed AND the compensating re-create
 *   also failed; the order may have no active payment. Caller MUST surface an
 *   actionable error (never an opaque 500).
 */
type ReplacePaymentResult =
  | { kind: "ok"; payment: { id: string; version: number } }
  | { kind: "compensated"; payment: { id: string; version: number }; error: unknown }
  | { kind: "orphaned"; error: unknown; compensationError: unknown };

/**
 * Compensating cancel→create for the payment retry / regenerate / method-switch
 * paths (P1-ERR-PAYSWITCH).
 *
 * The single-active-payment invariant (enforced inside `payment.create` as a DB
 * transaction + partial unique index) means the OLD payment MUST be terminal
 * before a replacement can be created — so create-before-cancel is impossible,
 * and `canceled` is terminal in the forward-only state machine so the canceled
 * row cannot be resurrected. `create` is atomic, so a thrown create rolls back
 * its own row insert and leaves the order with NO active payment.
 *
 * Therefore: if `create(newMethod)` fails, we compensate by re-creating an active
 * payment with the ORIGINAL method, restoring the customer's prior usable state.
 * Only if that compensating create ALSO fails do we report an orphaned state,
 * which the caller maps to an actionable (non-500) pt-BR error.
 *
 * Every mutation is kernel-adjudicated via the `*FromEnvelope` surface (a non-
 * EXECUTE create decision is treated as a create failure → compensate). The
 * cancel of the old payment tolerates REFUSE (already terminal) — the create's
 * single-active invariant is the authoritative guard. `cancelReason` is pt-BR
 * (Hard Rule #4); amounts are integer centavos carried verbatim (Hard Rule #2).
 */
async function replaceActivePayment(args: {
  paymentCmdSvc: ReturnType<typeof createPaymentCommandService>;
  orderId: string;
  currentPaymentId: string;
  currentMethod: PaymentMethodLiteral;
  newMethod: PaymentMethodLiteral;
  amountInCentavos: number;
  customerId: string;
  cancelReason: string;
  /** Optional pre-cancel transition (switch path: → switching_method). */
  preCancel?: () => Promise<void>;
  log: FastifyInstance["log"];
}): Promise<ReplacePaymentResult> {
  const {
    paymentCmdSvc, orderId, currentPaymentId, currentMethod, newMethod,
    amountInCentavos, customerId, cancelReason, preCancel, log,
  } = args;

  // Optional intermediate transition (switch path: → switching_method).
  if (preCancel) await preCancel();

  // Cancel the old payment — kernel-adjudicated. A pre-existing terminal state
  // surfaces as REFUSE and is benign (the old attempt is already dead), so
  // tolerate it; the create below still enforces the single-active invariant.
  const cancelEnv = buildEnvelope<
    "payment.status.transition",
    PaymentStatusTransitionPayload
  >({
    kind: "payment.status.transition",
    payload: {
      paymentId: currentPaymentId,
      newStatus: PaymentStatus.CANCELED,
      actor: "customer",
      actorId: customerId,
      reason: cancelReason,
    },
    nonce: randomUUID(),
    actor: { principal: "user", sessionId: customerId },
    taint: "TRUSTED",
  });
  await paymentCmdSvc.transitionStatusFromEnvelope(cancelEnv).catch(() => undefined);

  // Create a payment with `method` via the SYSTEM-only envelope. Throws on any
  // non-EXECUTE decision so the compensation try/catch below can react.
  const createWithMethod = async (
    method: PaymentMethodLiteral,
  ): Promise<{ id: string; version: number }> => {
    const createEnv = buildEnvelope<"payment.create", PaymentCreatePayload>({
      kind: "payment.create",
      payload: { orderId, method, amountInCentavos },
      nonce: randomUUID(),
      actor: { principal: "system", sessionId: `customer:${customerId}` },
      taint: "SYSTEM",
    });
    const outcome = await paymentCmdSvc.createFromEnvelope(createEnv);
    if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
      const msg =
        outcome.decision.kind === "REFUSE"
          ? outcome.decision.refusal.userFacing
          : `payment.create not authorized (${outcome.decision.kind})`;
      throw new Error(msg);
    }
    return outcome.result!;
  };

  try {
    const payment = await createWithMethod(newMethod);
    return { kind: "ok", payment };
  } catch (error) {
    log.error(
      { orderId, paymentId: currentPaymentId, newMethod, error: String(error) },
      "payment replacement create() failed — attempting compensation (restore original method)",
    );
    try {
      const restored = await createWithMethod(currentMethod);
      log.warn(
        { orderId, restoredPaymentId: restored.id, method: currentMethod },
        "payment replacement compensated — original method restored as new active payment",
      );
      return { kind: "compensated", payment: restored, error };
    } catch (compensationError) {
      log.error(
        { orderId, paymentId: currentPaymentId, error: String(error), compensationError: String(compensationError) },
        "payment replacement compensation FAILED — order may have no active payment",
      );
      return { kind: "orphaned", error, compensationError };
    }
  }
}

/**
 * BKL-041 — composite-kind adjudication seam for the two customer payment-
 * replacement routes (PATCH …/payment/method + POST …/payment/retry).
 *
 * Before BKL-041 both routes ran {@link replaceActivePayment} DIRECTLY — the
 * "two-envelope decomposition" (an inner cancel + create) executed without the
 * route ever adjudicating the `payment.method.switch` / `payment.retry` composite
 * kind the Pack registers, so `validateMethodSwitch` / `retryDailyCapGuard` were
 * unreachable (the WS4 executor gap). This helper closes it: it builds the
 * composite UNTRUSTED customer envelope, adjudicates it through
 * `paymentsPolicyBundle` (the same kernel `adjudicate()` the Pack ships), and on
 * EXECUTE runs the supplied executor — the route's `replaceActivePayment` closure.
 *
 * The inner cancel + create envelopes inside `replaceActivePayment` REMAIN the
 * authoritative single-active-payment enforcement; this outer adjudication is
 * additive composite-kind governance, never a replacement for them. The kinds
 * stay identity-tier / de-advertised (P0-7): no chat tool is registered, so this
 * HTTP surface is their only emitter.
 */
async function adjudicatePaymentReplacement<R>(args: {
  kind: "payment.method.switch" | "payment.retry";
  payload: PaymentMethodSwitchPayload | PaymentRetryPayload;
  customerId: string;
  ctx: PaymentState["ctx"];
  route: string;
  executor: () => Promise<R>;
  log: FastifyInstance["log"];
}): Promise<CustomerIntentReply<R | Record<string, unknown>>> {
  const envelope = buildCustomerEnvelope<
    "payment.method.switch" | "payment.retry",
    PaymentMethodSwitchPayload | PaymentRetryPayload
  >({
    kind: args.kind,
    payload: args.payload,
    nonce: randomUUID(),
    customerId: args.customerId,
  });
  return runCustomerIntent<R>({
    envelope,
    state: { ctx: args.ctx },
    policy: paymentsPolicyBundle as unknown as Parameters<
      typeof runCustomerIntent
    >[0]["policy"],
    executor: async () => args.executor(),
    ctx: { customerId: args.customerId, route: args.route, log: args.log },
    auditSink: getAuditSink(),
  });
}

/**
 * Derive a deterministic envelope `nonce` from a logical idempotency
 * identifier (e.g. `${orderId}:cancel`). The same logical key on retry
 * produces the same `intentHash` so the kernel's Execution Ledger can
 * dedupe HTTP retries / double-clicks / network blips.
 *
 * Hex-encoded SHA-256 is collision-resistant for the small key space we
 * derive from (orderId / customerId UUIDs + a short action suffix). Per
 * CLAUDE.md rule 9, the inputs are non-PII identifiers only — see the
 * `idempotency-key derivation` notes on each call site.
 *
 * P0-7 audit-2026-05-24 remediation.
 */
function deriveNonce(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

/**
 * P2-LOGIC-CANCELPAY — thrown from the cancel executor when the order row was
 * transitioned to CANCELED but its active payment is still LIVE (non-terminal)
 * afterward. The route maps it to 409 PAYMENT_CANCEL_FAILED and the executor
 * throws BEFORE publishNatsEvent("order.canceled"), so the event is withheld —
 * a canceled order can never retain a billable payment that later reconciles to
 * paid. runCustomerIntent does not catch executor errors, so this propagates to
 * the route's try/catch.
 */
class PaymentCancelFailedError extends Error {
  constructor(public readonly paymentId: string | undefined) {
    super("order canceled but active payment is not terminal");
    this.name = "PaymentCancelFailedError";
  }
}

/**
 * BKL-130 — thrown from the cancel executor when a PAID order's adjudicated
 * refund did NOT settle (the kernel returned ESCALATE / REQUEST_CONFIRMATION /
 * REFUSE — e.g. the FE-T03 ≥R$1000 money band escalates a big-ticket refund).
 * The executor throws BEFORE the order→canceled transition, so state stays
 * WHOLE (order untouched, payment untouched); the route surfaces it as an
 * actionable "refund needs review" response. No-half-apply cuts both ways: no
 * settled refund ⇒ no cancel.
 */
export class PaidCancelRefundNotSettledError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly decisionKind: string,
  ) {
    super(`paid cancel refund not settled (kernel decision: ${decisionKind})`);
    this.name = "PaidCancelRefundNotSettledError";
  }
}

/**
 * BKL-103 — make the customer-facing "a human will handle it" promise TRUE.
 * Both paid-cancel escalation exits (the BKL-036 kernel ESCALATE at step 1 and
 * the BKL-130 executor's refund-not-settled 409) tell the customer staff will
 * review — this publishes the BKL-178 `support.handoff_requested` recipe with a
 * synthetic non-conversation sessionId keyed by the ORDER (the dispute:{id}
 * precedent, stripe-webhook.ts), so the escalation lands in the escalation
 * store → Escalações panel + pendingEscalations KPI and fires the staff
 * WhatsApp ping via the existing handoff-subscriber. The subscriber dedups on
 * `handoff:{sessionId}`, so a customer RETRYING the cancel surfaces exactly ONE
 * staff record + ping. Best-effort by design: the customer reply must not fail
 * on a NATS hiccup — a publish failure logs loudly (the kernel audit row is
 * the fallback truth). No PII rides the event: displayId + amount only (the
 * reason string renders verbatim on the Escalações row).
 */
async function publishPaidCancelEscalation(
  orderId: string,
  order: { readonly displayId: number; readonly totalInCentavos?: number | null },
  log: FastifyInstance["log"],
  /**
   * BKL-103 — the ESCALATEd envelope. When supplied AND the kind is resumable, the
   * FULL envelope is PARKED before the publish so an OWNER can approve-and-execute
   * it (the AUT-017 loop). Absent on the paths where no envelope is in hand, which
   * degrade to today's notification-only escalation.
   */
  envelope?: IntentEnvelope,
): Promise<void> {
  const cents = order.totalInCentavos ?? null;
  // Display-only formatting; the amount stays integer centavos everywhere else.
  const amount = cents === null ? "" : ` de R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
  // ── BKL-103 — the SYNTHETIC session id, and why it must be this exact string ──
  //
  // The HTTP cancel plane has no conversation, so the escalation is keyed by the
  // ORDER (the dispute:{id} precedent). This ONE string has to serve three surfaces
  // that must agree or the Approve button is silently dead:
  //   1. the NATS event's `sessionId` → the escalation store record staff see;
  //   2. the PARKED record's own `sessionId`;
  //   3. the resolve route's FIX-6 binding — `POST /api/admin/escalations/
  //      :sessionId/intents/:token/resolve` refuses as `missing` (without burning
  //      the token) unless `parked.sessionId === expectedSessionId`.
  // `buildEscalationParkInput` derives sessionId from `envelope.actor.sessionId`,
  // which on this plane is the CUSTOMER id — so it is deliberately OVERRIDDEN here.
  // Pinned end-to-end by the park→list→resolve test in order-cancel-governance.
  const sessionId = `order-cancel:${orderId}`;
  // Park BEFORE the publish so the event can carry the token (fail-soft: a park
  // failure degrades to a notification-only escalation and never breaks the reply).
  let park:
    | { token: string; intentHash: string; summaryPtBr: string }
    | undefined;
  if (
    envelope !== undefined &&
    ESCALATION_RESUMABLE_KINDS.has(String(envelope.kind))
  ) {
    try {
      const input = buildEscalationParkInput(envelope);
      const { token } = await getEscalationParkStore().park({
        ...input,
        sessionId,
      });
      park = {
        token,
        intentHash: envelope.intentHash,
        summaryPtBr: input.summaryPtBr,
      };
    } catch (err) {
      log.error(
        { orderId, err: (err as Error).message },
        "paid-cancel ESCALATE park failed — degrading to a notification-only escalation (BKL-103)",
      );
    }
  }
  try {
    await publishNatsEvent("support.handoff_requested", {
      sessionId,
      reason: `Cancelamento de pedido pago requer aprovação — pedido #${order.displayId}, reembolso${amount}`,
      // The payload itself NEVER rides NATS — only the opaque token + hash + kind +
      // pt-BR summary, so the escalação row is actionable without leaking the intent.
      ...(park === undefined
        ? {}
        : {
            parkToken: park.token,
            intentHash: park.intentHash,
            intentKind: String(envelope!.kind),
            summaryPtBr: park.summaryPtBr,
          }),
    });
    log.warn(
      { orderId },
      "paid-cancel ESCALATE surfaced — support.handoff_requested published (BKL-103)",
    );
  } catch (err) {
    log.error(
      { orderId, err: (err as Error).message },
      "paid-cancel ESCALATE surfacing FAILED — escalation is audit-row-only until the customer retries (BKL-103)",
    );
  }
}

/**
 * The order.cancel EXECUTE money-path — extracted verbatim (BKL-146) from the
 * `POST /api/orders/:id/cancel` executor so the two-phase confirm route
 * (`POST /api/orders/:id/cancel/confirm`) runs the IDENTICAL side effects: the
 * projection-level order + payment transitions, the P2-LOGIC-CANCELPAY
 * terminality guard, the C3 best-effort Medusa-native cancel, and the
 * `order.canceled` NATS emit. No behavior change — a byte-for-byte move; both
 * routes call this so the direct-EXECUTE and confirmed-EXECUTE paths can never
 * drift (the finalizeCheckout precedent). Throws propagate to each route's
 * try/catch (PaymentCancelFailedError → 409, InvalidTransitionError → 422).
 */
export async function executeOrderCancel(args: {
  readonly orderId: string;
  readonly customerId: string;
  readonly reason: string;
  readonly order: { readonly fulfillmentStatus: string; readonly displayId: number };
  readonly orderCmdSvc: ReturnType<typeof createOrderCommandService>;
  readonly paymentCmdSvc: ReturnType<typeof createPaymentCommandService>;
  readonly paymentQuerySvc: ReturnType<typeof createPaymentQueryService>;
  readonly log: FastifyInstance["log"];
}): Promise<{ success: true; version: number; fulfillmentStatus: string }> {
  const { orderId, customerId, reason, order, orderCmdSvc, paymentCmdSvc, paymentQuerySvc, log } = args;

  // ── BKL-130: a PAID order must be REFUNDED (adjudicated) BEFORE the cancel
  // transition ──────────────────────────────────────────────────────────────
  // Root cause: the executor used to transition order→CANCELED FIRST, then
  // attempt the payment cancel; a PAID payment's paid→canceled transition is
  // ILLEGAL (409), leaving a CANCELED order with a LIVE paid payment (a
  // half-applied money-safety hole — live-reproduced on both CARD and CASH).
  // paid→canceled stays illegal (never legalized); the money-reversal is a
  // REFUND. We BUILD + ADJUDICATE a refund envelope THROUGH THE KERNEL first, so
  // the FE-T03 magnitude bands stay live — a ≥R$1000 refund ESCALATEs, so a
  // big-ticket paid cancel parks/escalates instead of silently refunding. The
  // refund WRITE is ledger-only (no Stripe/PIX egress — the provider refund is
  // the inbound charge.refunded webhook reconcile), so this works identically
  // for CARD and CASH; a cash refund is recorded operationally, never the
  // paid→canceled attempt that 409'd. No-half-apply cuts BOTH ways: unless the
  // refund SETTLES (EXECUTE), the order is NOT canceled either.
  const paidActive = await paymentCmdSvc.findActiveByOrderId(orderId);
  if (paidActive && paidActive.status === PaymentStatus.PAID) {
    const payment = await paymentQuerySvc.getById(paidActive.id);
    if (payment === null) {
      throw new PaidCancelRefundNotSettledError(orderId, "payment_not_found");
    }
    const currentRefunded = payment.refundedAmountCentavos ?? 0;
    const refundable = payment.amountInCentavos - currentRefunded;
    // System-completion actor (the payload actor enum is admin|system; the
    // cancel-triggered refund is issued BY THE SYSTEM on the customer's behalf).
    const refundEnvelope = buildSystemEnvelope<"payment.refund.issue", PaymentRefundIssuePayload>({
      kind: "payment.refund.issue",
      payload: {
        paymentId: payment.id,
        refundAmountCentavos: refundable,
        refundableBalanceCentavos: refundable,
        amountInCentavos: payment.amountInCentavos,
        currentRefundedCentavos: currentRefunded,
        actor: "system",
        reason,
      },
      sourceSubject: "order.cancel.refund",
      eventId: `${orderId}:${payment.id}:cancel-refund`,
    });
    const refundOutcome = await paymentCmdSvc.issueRefundFromEnvelope(refundEnvelope);
    if (
      refundOutcome.decision.kind !== "EXECUTE" &&
      refundOutcome.decision.kind !== "REWRITE"
    ) {
      // Band ESCALATE / REQUEST_CONFIRMATION / REFUSE (e.g. ≥R$1000): do NOT
      // cancel. State whole — no order transition, payment untouched.
      log.warn(
        { orderId, paymentId: payment.id, decision: refundOutcome.decision.kind, refundable },
        "paid cancel: kernel did not settle the refund (band escalate/refuse) — order NOT canceled (BKL-130)",
      );
      throw new PaidCancelRefundNotSettledError(orderId, refundOutcome.decision.kind);
    }
    // EXECUTE ⇒ the paid payment is now REFUNDED (terminal). The existing
    // payment-terminality block below sees no active payment (findActiveByOrderId
    // → null) ⇒ never attempts the illegal paid→canceled transition ⇒ the old
    // 409 is no longer reachable for a paid order.
  }

  // ── R1-DELETE (sibling fix) ────────────────────────────────
  // Inner mutations migrated from bare-arg `transitionStatus`
  // to envelope-typed `transitionStatusFromEnvelope`. The
  // outer `order.cancel` envelope is already adjudicated by
  // runCustomerIntent; these inner envelopes adjudicate the
  // projection-level transitions (order + payment).
  const orderTransitionEnvelope = buildCustomerEnvelope<
    "order.status.transition",
    OrderStatusTransitionPayload
  >({
    kind: "order.status.transition",
    payload: {
      orderId,
      newStatus: OrderFulfillmentStatus.CANCELED,
      actor: "customer",
      actorId: customerId,
      reason,
    },
    nonce: randomUUID(),
    customerId,
  });
  const orderOutcome = await orderCmdSvc.transitionStatusFromEnvelope(
    orderTransitionEnvelope,
  );
  if (
    orderOutcome.decision.kind !== "EXECUTE" &&
    orderOutcome.decision.kind !== "REWRITE"
  ) {
    // Inner adjudication refused — propagate as transition error.
    throw new InvalidTransitionError(
      orderId,
      order.fulfillmentStatus,
      OrderFulfillmentStatus.CANCELED,
    );
  }
  const result = orderOutcome.result!;

  // Cancel the active payment so a canceled order never retains a LIVE
  // payment that could later reconcile to `paid` (P2-LOGIC-CANCELPAY).
  // We must NOT emit `order.canceled` unless the payment is actually
  // terminal afterward — otherwise a swallowed cancel failure leaves a
  // billable payment behind an order the customer believes is canceled.
  const activePayment = await paymentCmdSvc.findActiveByOrderId(orderId);
  let paymentTerminal = true; // no active payment ⇒ nothing left to settle
  if (activePayment && !isTerminalPaymentStatus(activePayment.status as PaymentStatus)) {
    paymentTerminal = false;
    try {
      const paymentCancelEnvelope = buildEnvelope<
        "payment.status.transition",
        PaymentStatusTransitionPayload
      >({
        kind: "payment.status.transition",
        payload: {
          paymentId: activePayment.id,
          newStatus: PaymentStatus.CANCELED,
          actor: "customer",
          actorId: customerId,
          reason: "Pedido cancelado pelo cliente",
          // P2-CONC-CONFIRMVER: pin the version we validated against so
          // a concurrent transition (e.g. a webhook flipping the payment
          // to `paid`) can't be silently clobbered — it surfaces as a
          // concurrency error and we re-check terminality below.
          expectedVersion: activePayment.version,
        },
        nonce: randomUUID(),
        actor: { principal: "user", sessionId: customerId },
        taint: "TRUSTED",
      });
      const cancelOutcome = await paymentCmdSvc.transitionStatusFromEnvelope(paymentCancelEnvelope);
      // EXECUTE/REWRITE ⇒ canceled (terminal). A REFUSE means the kernel
      // declined (e.g. already terminal) — re-read below rather than assume.
      paymentTerminal =
        cancelOutcome.decision.kind === "EXECUTE" ||
        cancelOutcome.decision.kind === "REWRITE";
    } catch {
      // May have failed because the payment is already terminal (benign)
      // OR because it concurrently moved to a live state like `paid`
      // (NOT benign). Re-read authoritative state below.
      paymentTerminal = false;
    }
    if (!paymentTerminal) {
      // Authoritative re-read: no active (non-terminal) payment now ⇒ it
      // settled to a terminal state ⇒ safe. A still-active payment ⇒ unsafe.
      const after = await paymentCmdSvc.findActiveByOrderId(orderId);
      paymentTerminal = after === null;
    }
  }

  if (!paymentTerminal) {
    // Order row is CANCELED but the payment is still live. Do NOT emit
    // `order.canceled` (downstream treats it as fully settled). Throw so
    // the route surfaces an actionable 409 — the cancel is retried /
    // escalated rather than leaving a canceled order with a billable
    // payment (P2-LOGIC-CANCELPAY).
    log.error(
      { orderId, paymentId: activePayment?.id },
      "order canceled but active payment is not terminal — withholding order.canceled (P2-LOGIC-CANCELPAY)",
    );
    throw new PaymentCancelFailedError(activePayment?.id);
  }

  // C3 (CQRS dual-write): cancel the Medusa-native order too, so the
  // public."order" row reflects canceled (status + canceled_at) instead
  // of reading stale `pending`. Kernel-gated like every Medusa mutation.
  // Best-effort: the domain projection is already authoritative and the
  // payment is terminal — a Medusa hiccup must NOT undo a successful
  // cancel (that would resurrect a billable order), so we log and let
  // the projection + NATS remain the source of truth.
  //
  // FIRE-AND-FORGET (finding 29): the result is only logged, so awaiting
  // it just adds a Medusa admin round-trip to the customer's cancel
  // response latency for no observable benefit. Run it in a background
  // async IIFE (persistent Fastify server — the promise survives) whose
  // try/catch absorbs BOTH a synchronous throw and an async rejection, so
  // a Medusa hiccup never becomes an unhandled rejection or a 500.
  void (async () => {
    try {
      await medusaAdjudicated({
        scope: "admin",
        method: "POST",
        path: `/admin/orders/${orderId}/cancel`,
        idempotencyKey: `${orderId}:medusa-cancel:${customerId}`,
        sourceSubject: "route:order.cancel",
        auditSink: getAuditSink(),
      });
    } catch (err) {
      log.error(
        { orderId, error: String(err) },
        "domain order canceled but Medusa-native cancel failed — public.order may read stale; projection remains authoritative (C3)",
      );
    }
  })();

  await publishNatsEvent("order.canceled", {
    eventType: "order.canceled",
    orderId,
    displayId: order.displayId,
    customerId,
    reason,
    canceledBy: "customer",
    timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    version: result.version,
    fulfillmentStatus: result.newStatus,
  };
}

/**
 * Prefer the caller's explicit `Idempotency-Key` HTTP header when
 * supplied (industry standard for client-driven dedup, e.g. Stripe).
 * Otherwise fall back to the route's derived key. Returns the resolved
 * value verbatim — callers SHA-256 it via `deriveNonce` for the
 * envelope nonce.
 */
function resolveIdempotencyKey(
  headerValue: string | string[] | undefined,
  fallback: string,
): string {
  if (typeof headerValue === "string" && headerValue.length > 0) {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue[0]) {
    return headerValue[0];
  }
  return fallback;
}

/**
 * No-op rejection handler. Kept at module scope so awaited `.catch()` calls in
 * deeply-nested closures don't add an extra nested-function level (S2004).
 */
const ignoreError = () => undefined;

/** Loaded order state for the batch-amend route (projection-first, Medusa fallback). */
type AmendOrderLoadResult =
  | { found: false }
  | {
      found: true;
      fulfillmentStatus: OrderFulfillmentStatus;
      itemProductTypeMap: Map<string, string | undefined>;
    };

/**
 * Resolve the current fulfillment status + item→productType map for an order,
 * preferring the local projection and falling back to a Medusa admin read.
 * Returns `{ found: false }` when neither source has the order.
 */
async function loadAmendOrderState(
  orderQuerySvc: ReturnType<typeof createOrderQueryService>,
  id: string,
): Promise<AmendOrderLoadResult> {
  const projection = await orderQuerySvc.getById(id);
  if (projection) {
    const projectionItems =
      (projection.itemsJson as Array<{ title: string; productType?: string }>) ?? [];
    return {
      found: true,
      fulfillmentStatus: projection.fulfillmentStatus as OrderFulfillmentStatus,
      itemProductTypeMap: new Map(
        projectionItems.map((i) => [i.title.toLowerCase(), i.productType]),
      ),
    };
  }

  // Fallback: projection not populated — read from Medusa
  try {
    const data = (await medusaAdmin(
      `/admin/orders/${id}?fields=id,fulfillment_status,*items`,
    )) as {
      order?: {
        fulfillment_status?: string;
        items?: Array<{ title?: string; metadata?: Record<string, string> }>;
      };
    };
    if (!data.order) {
      return { found: false };
    }
    const itemProductTypeMap = Array.isArray(data.order.items)
      ? new Map<string, string | undefined>(
          data.order.items.map((i) => [
            (i.title ?? "").toLowerCase(),
            i.metadata?.["productType"],
          ]),
        )
      : new Map<string, string | undefined>();
    return {
      found: true,
      fulfillmentStatus: (data.order.fulfillment_status ?? "pending") as OrderFulfillmentStatus,
      itemProductTypeMap,
    };
  } catch {
    return { found: false };
  }
}

type AmendChange = { type: "remove" | "update_qty"; itemTitle: string; quantity?: number };

/**
 * Pre-validate every requested change against the current fulfillment status.
 * Returns `{ ok: false }` with the refusal reason on the first disallowed
 * action, otherwise `{ ok: true }` with the list of locked (in-preparation
 * food) item titles.
 */
function validateAmendChanges(
  changes: ReadonlyArray<AmendChange>,
  fulfillmentStatus: OrderFulfillmentStatus,
  isPreparing: boolean,
  itemProductTypeMap: Map<string, string | undefined>,
): { ok: false; reason: string | undefined } | { ok: true; lockedItems: string[] } {
  const lockedItems: string[] = [];
  for (const change of changes) {
    // Check if action is allowed for current fulfillment status
    const actionType = change.type === "remove" ? "amend_remove_item" : "amend_update_qty";
    const check = canPerformAction(actionType as Parameters<typeof canPerformAction>[0], {
      fulfillmentStatus,
    });
    if (!check.allowed) {
      return { ok: false, reason: check.reason };
    }

    // During preparing: food items are locked
    if (isPreparing) {
      const productType = itemProductTypeMap.get(change.itemTitle.toLowerCase());
      if (productType === "food") {
        lockedItems.push(change.itemTitle);
      }
    }
  }
  return { ok: true, lockedItems };
}

/**
 * Apply the batch of amend changes sequentially, stopping at the first thrown
 * error to avoid partial state. Returns the per-item results and whether any
 * change failed.
 */
async function applyAmendChanges(
  changes: ReadonlyArray<AmendChange>,
  orderId: string,
  ctx: AgentContext,
): Promise<{
  results: Array<{ itemTitle: string; success: boolean; message?: string }>;
  hasFailure: boolean;
}> {
  const results: Array<{ itemTitle: string; success: boolean; message?: string }> = [];
  let hasFailure = false;
  for (const change of changes) {
    try {
      const result = await amendOrder(
        {
          orderId,
          action: change.type,
          itemTitle: change.itemTitle,
          quantity: change.quantity,
        },
        ctx,
      );
      results.push({ itemTitle: change.itemTitle, success: result.success, message: result.message });
      if (!result.success) hasFailure = true;
    } catch (err) {
      results.push({ itemTitle: change.itemTitle, success: false, message: (err as Error).message });
      hasFailure = true;
      break; // Stop on first failure to prevent partial state
    }
  }
  return { results, hasFailure };
}

const OrderIdParams = z.object({ id: z.string().min(1) });

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;

// ── R5 rollout, family 4 — this route's Redis client seam ──────────────────
//
// The five `getRedisClient()` calls this module used to make directly now
// resolve through `OrderActionRouteDeps.redis`. Per-consumer types below are
// the R5-S1 NARROWING rule applied one site at a time.
//
// ── THE FAIL-CLOSED PICK ANALYSIS (the R5-S12 / #539 / #543 rule) ───────────
//
// The honest Pick is {issued} ∪ {optionally consumed downstream}. MEASURED for
// this module: the downstream half is EMPTY. All five sites bind the client to
// a handler-local `const redis` and issue every command on it directly; no site
// passes `redis` to anything. (Verified by reading every `redis` occurrence in
// the file, not by reading the five call sites.)
//
// ── The one resolution deliberately NOT collapsed, and why it decides the ───
// ── whole file's CLASSIFICATION ────────────────────────────────────────────
//
// `createOrderCancelConfirmationStore()` — built once in the plugin body and
// used by the PAID-cancel park/confirm round trip — resolves its OWN client per
// command and is deliberately left doing so. Its `consume` is the single-use
// CONSUME **Lua** (`order-cancel-confirmation-store.ts`, one of the census's
// four CONSUME sites). Threading it off `deps.redis` — the shape `routes/cart.ts`
// chose for its sibling checkout store, which is why `CartRouteRedisClient`
// carries `eval` — would pull `eval` into the union below and move this entire
// route into the owner-gated Lua bucket, un-servable by the in-memory adapter
// (W4 RULE 3). Nothing here needs the store's client, so the Pick boundary is
// what keeps this file migratable. A future slice that threads that store must
// re-classify this file, not merely widen the type.
//
// ── Feature detection: MEASURED, none ──────────────────────────────────────
//
// `typeof client.X === "function"` was swept over `apps/api/src/routes`,
// `apps/api/src/middleware` and `packages/tools/src`: zero live Redis probes.
//
// ── Swallowing consumers: NONE ─────────────────────────────────────────────
//
// Unlike `me.ts`, every site here awaits its commands with no `catch`, so a
// missing member surfaces as a 500 rather than degrading silently. The
// direction that matters instead is FAIL-OPEN: these counters are the only
// thing bounding cancel / amend / retry / PIX-regeneration attempts, so a
// client whose `incr` does not actually count turns every cap into no cap. The
// seam suite pins the counters against the INJECTED keyspace for that reason.

/**
 * The four attempt-capping rate limiters (cancel, amend ×2, PIX regeneration):
 * `INCR` the counter, and `EXPIRE` it to open the window on first use.
 */
type OrderActionRateLimitRedis = Pick<RedisClient, "incr" | "expire">;

/**
 * The payment-retry DAILY cap. Distinct from the four above because it READS
 * the count first — the value is projected into the kernel's
 * `ctx.dailyRetryCount` for `retryDailyCapGuard` — and only bumps AFTER a retry
 * actually executes. Same handler-scoped client for all three commands.
 */
type PaymentRetryCapRedis = Pick<RedisClient, "get" | "incr" | "expire">;

/**
 * The EXHAUSTIVE union of Redis commands this route issues — the type
 * `OrderActionRouteDeps.redis` resolves to.
 *
 * Hand-written on purpose rather than derived as an intersection of the
 * per-consumer types above: a derived union can never disagree with its
 * consumers, so it could not catch a consumer that grew a command nobody
 * declared (F-14).
 */
export type OrderActionRouteRedisClient = Pick<
  RedisClient,
  "get" | "incr" | "expire"
>;

// ── R5-S5 — this route's composition root ──────────────────────────────────
//
// Four of the five members replace plugin-body constructions and keep that
// REGISTRATION-time timing exactly (the plugin invokes them once, where the
// inline `create*Service()` calls used to sit). The fifth,
// `noteOrderCommandService`, replaces a PER-REQUEST construction inside the
// note handler and stays per-request: it closes over `getAuditSink()`, and
// keeping it a factory is what preserves the sink resolving on the request
// rather than at registration (the R5-S2 factories-not-instances rule).

/** The domain services `order-actions.ts` resolves through the seam. */
export interface OrderActionRouteDeps {
  /** Builds the OrderCommandService behind the customer-facing order actions. */
  readonly orderCommandService: () => OrderCommandService;
  /** Builds the OrderQueryService behind the ownership + projection reads. */
  readonly orderQueryService: () => OrderQueryService;
  /** Builds the PaymentCommandService behind the payment-method/retry actions. */
  readonly paymentCommandService: () => PaymentCommandService;
  /** Builds the PaymentQueryService behind the active-payment reads. */
  readonly paymentQueryService: () => PaymentQueryService;
  /**
   * Builds the AUDIT-WIRED OrderCommandService for the W7-P4
   * `order.note.add` path. A SEPARATE member from `orderCommandService`
   * above: that one is constructed bare (`createOrderCommandService()`) at
   * registration, whereas this one binds `server.log` AND a per-request
   * `getAuditSink()`. Collapsing them would either add an audit sink to the
   * action paths or drop it from the note path — both behavior changes.
   */
  readonly noteOrderCommandService: () => OrderCommandService;
  /**
   * Resolves the Redis client the five rate-limit / retry-cap sites issue
   * against.
   *
   * A FACTORY returning a promise, not an instance, so every site keeps its
   * `await` exactly where it was — per REQUEST, inside the handler that needs
   * it. An instance would hoist the resolution to registration and change when
   * a Redis outage first surfaces (today: on the first capped action, as a
   * 500 — never at boot).
   */
  readonly redis: () => Promise<OrderActionRouteRedisClient>;
}

/**
 * Fastify plugin options. Overrides nest under `deps` so no member collides
 * with a Fastify-reserved register option (`prefix`, `logLevel`,
 * `logSerializers`); omitted or partial → the production default fills the
 * remainder, so the registration in routes/index.ts is unchanged.
 */
export interface OrderActionRoutesOptions {
  readonly deps?: Partial<OrderActionRouteDeps>;
}

/**
 * The production set — byte-for-byte the construction this file did inline.
 * Takes `server` because two of the five constructions bind `server.log`.
 */
function defaultOrderActionRouteDeps(
  server: FastifyInstance,
): OrderActionRouteDeps {
  return {
    orderCommandService: () => createOrderCommandService(),
    orderQueryService: () => createOrderQueryService(),
    paymentCommandService: () => createPaymentCommandService(server.log),
    paymentQueryService: () => createPaymentQueryService(),
    noteOrderCommandService: () =>
      createOrderCommandService(server.log, { auditSink: getAuditSink() }),
    redis: () => getRedisClient(),
  };
}

function resolveOrderActionRouteDeps(
  server: FastifyInstance,
  options?: OrderActionRoutesOptions,
): OrderActionRouteDeps {
  return { ...defaultOrderActionRouteDeps(server), ...(options?.deps ?? {}) };
}

export async function orderActionRoutes(
  server: FastifyInstance,
  options?: OrderActionRoutesOptions,
): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  // Resolved ONCE per registration. The members are factories, so the four
  // below construct here exactly as before, and the note-path member stays
  // unconstructed until its handler runs.
  const deps = resolveOrderActionRouteDeps(server, options);
  const orderCmdSvc = deps.orderCommandService();
  const orderQuerySvc = deps.orderQueryService();
  const paymentCmdSvc = deps.paymentCommandService();
  const paymentQuerySvc = deps.paymentQueryService();
  // BKL-146 — single-use store for parked PAID cancels (REQUEST_CONFIRMATION).
  const cancelConfirmationStore = createOrderCancelConfirmationStore();

  // ── Ownership helper ──────────────────────────────────────────────────────
  async function verifyOwnership(orderId: string, customerId: string): Promise<boolean> {
    // Primary: check projection
    const order = await orderQuerySvc.getById(orderId);
    if (order) return order.customerId === customerId;

    // Fallback: projection not populated yet — check Medusa + lazy-create projection
    try {
      const owned = await verifyOwnershipViaMedusa(orderId, customerId);
      if (!owned) return false;

      // Ownership confirmed — ensure projection exists for downstream FK writes
      await ensureProjectionExists(orderId);
      return true;
    } catch {
      return false;
    }
  }

  /** Check ownership directly against Medusa (no projection needed). */
  async function verifyOwnershipViaMedusa(orderId: string, customerId: string): Promise<boolean> {
    try {
      const data = await medusaAdmin(
        `/admin/orders/${orderId}?fields=id,metadata,customer_id,*customer`,
      ) as { order?: { metadata?: Record<string, string>; customer?: { id: string }; customer_id?: string } };
      const medusaOrder = data.order;
      if (!medusaOrder) return false;
      const ownerCustomerId = medusaOrder.metadata?.["customerId"] ?? medusaOrder.customer_id ?? medusaOrder.customer?.id;
      return ownerCustomerId === customerId;
    } catch {
      return false;
    }
  }

  // ── Ensure projection exists (lazy-create from Medusa if missing) ────────
  async function ensureProjectionExists(orderId: string): Promise<boolean> {
    const existing = await orderQuerySvc.getById(orderId);
    if (existing) return true;

    try {
      const data = await medusaAdmin(
        `/admin/orders/${orderId}?fields=id,display_id,status,total,subtotal,shipping_total,customer_id,metadata,created_at,*items`,
      ) as {
        order?: {
          id: string;
          display_id: number;
          status: string;
          total: number;
          subtotal: number;
          shipping_total: number;
          customer_id?: string;
          metadata?: Record<string, string>;
          created_at: string;
          items?: Array<{ title?: string; quantity?: number; unit_price?: number; variant_id?: string; product_id?: string; metadata?: Record<string, string> }>;
        };
      };

      const mo = data.order;
      if (!mo) return false;

      const reaisToCents = (v: number) => Math.round(v * 100);
      const items = (mo.items ?? []).map((i) => ({
        productId: i.product_id ?? "",
        variantId: i.variant_id ?? "",
        title: i.title ?? "",
        quantity: i.quantity ?? 1,
        priceInCentavos: reaisToCents(i.unit_price ?? 0),
        productType: i.metadata?.["productType"] as "food" | "frozen" | "merchandise" | undefined,
      }));

      // ── R1-DELETE (NEW-P0-X4 sibling) ─────────────────────────────────
      //
      // Migrated from bare-arg `orderCmdSvc.create(...)` to the envelope
      // path so projection creation is adjudicated like every other
      // mutation. order.projection.create is a SYSTEM-only intent kind
      // (the projection is a derived projection from Medusa, not a
      // customer-initiated state mutation).
      const projectionFullInput = {
        id: mo.id,
        displayId: mo.display_id,
        customerId: mo.metadata?.["customerId"] ?? mo.customer_id ?? null,
        customerEmail: mo.metadata?.["customerEmail"] ?? null,
        customerName: mo.metadata?.["customerName"] ?? null,
        customerPhone: mo.metadata?.["customerPhone"] ?? null,
        fulfillmentStatus: mo.status === "completed" ? "delivered" : "pending",
        paymentStatus: mo.metadata?.["paymentStatus"] ?? "pending",
        totalInCentavos: reaisToCents(mo.total),
        subtotalInCentavos: reaisToCents(mo.subtotal),
        shippingInCentavos: reaisToCents(mo.shipping_total),
        itemCount: items.length,
        itemsJson: items,
        itemsSchemaVersion: 1,
        shippingAddressJson: null,
        deliveryType: mo.metadata?.["deliveryType"] ?? null,
        paymentMethod: mo.metadata?.["paymentMethod"] ?? null,
        tipInCentavos: Number(mo.metadata?.["tipInCentavos"]) || 0,
        medusaCreatedAt: new Date(mo.created_at),
      };
      const projectionEnvelope = buildEnvelope<
        "order.projection.create",
        { readonly orderId: string; readonly displayId: number; readonly customerId: string | null; readonly fulfillmentStatus: string; readonly paymentStatus: string | null; readonly totalInCentavos: number }
      >({
        kind: "order.projection.create",
        payload: {
          orderId: mo.id,
          displayId: mo.display_id,
          customerId: projectionFullInput.customerId,
          fulfillmentStatus: projectionFullInput.fulfillmentStatus,
          paymentStatus: projectionFullInput.paymentStatus,
          totalInCentavos: projectionFullInput.totalInCentavos,
        },
        nonce: randomUUID(),
        actor: { principal: "system", sessionId: `lazy-create:${mo.id}` },
        taint: "SYSTEM",
      });
      const createOutcome = await orderCmdSvc.createFromEnvelope(
        projectionEnvelope,
        projectionFullInput,
      );
      if (
        createOutcome.decision.kind !== "EXECUTE" &&
        createOutcome.decision.kind !== "REWRITE"
      ) {
        // Projection creation refused — surface as a non-throw so the
        // ownership-check path can fall through to its existing failure.
        server.log.warn(
          { orderId, decisionKind: createOutcome.decision.kind },
          "[ensureProjectionExists] kernel refused projection create",
        );
        return false;
      }
      server.log.info({ orderId }, "order projection lazy-created from Medusa");
      return true;
    } catch (err) {
      // P2002 = unique constraint — projection was created concurrently, that's fine
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
        return true;
      }
      server.log.warn({ orderId, error: String(err) }, "ensureProjectionExists failed");
      return false;
    }
  }

  // ── POST /api/orders/:id/cancel ───────────────────────────────────────────
  app.post(
    "/api/orders/:id/cancel",
    {
      schema: {
        tags: ["orders"],
        summary: "Cancelar pedido (cliente)",
        params: OrderIdParams,
        body: z.object({ reason: z.string().max(500).optional() }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      // Rate limit: 5 cancel attempts per 10 minutes
      const redis: OrderActionRateLimitRedis = await deps.redis();
      const cancelRlKey = rk(`rate:cancel:${customerId}`);
      const cancelCount = await redis.incr(cancelRlKey);
      if (cancelCount === 1) await redis.expire(cancelRlKey, 600);
      if (cancelCount > 5) {
        return reply.code(429).send({
          error: "Muitas tentativas de cancelamento. Aguarde 10 minutos.",
          code: "RATE_LIMIT",
        });
      }

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const order = await orderQuerySvc.getById(id);
      if (!order) return reply.code(404).send({ error: "Pedido ainda sendo processado. Tente novamente em instantes." });

      // ── Pre-kernel: order-age (time-window) cancel PONR ONLY (BKL-036 finding 1) ──
      //
      // The fulfillment-state PONR (ready / out-for-delivery / delivered /
      // preparing) and the already-cancelled refusal are now adjudicated by the
      // kernel's `requireCancellable` guard (pack-orders) so every such refusal
      // is AUDITED — we translate the kernel's REFUSE back to the legacy 422
      // contract after `runCustomerIntent` below, instead of pre-empting it here
      // with an UNaudited 422. The order-AGE window stays pre-kernel: the
      // kernel's OrderState ctx does not carry the order's createdAt /
      // cancelMinutes (that ctx projection is BKL-036 tier b, out of scope), so
      // dropping it would WEAKEN the guard. For a pending/confirmed order the
      // only way `canPerformAction("cancel_order")` denies is the elapsed
      // window, so this pre-empts exactly that case byte-identically (same
      // reason + PONR_EXPIRED code) and lets every other status fall through to
      // the kernel.
      const isTimeWindowCancellableStatus =
        order.fulfillmentStatus === "pending" ||
        order.fulfillmentStatus === "confirmed";
      if (isTimeWindowCancellableStatus) {
        const ponr = getEffectivePonr({});
        const cancelCheck = canPerformAction("cancel_order", {
          fulfillmentStatus: order.fulfillmentStatus as OrderFulfillmentStatus,
          orderCreatedAt: order.createdAt,
          ponrMinutes: ponr.cancelMinutes,
        });
        if (!cancelCheck.allowed) {
          return reply.code(422).send({
            error: cancelCheck.reason,
            code: cancelCheck.escalate ? "PONR_EXPIRED" : "PAST_PONR",
            fulfillmentStatus: order.fulfillmentStatus,
          });
        }
      }

      // ── Task 14 — wrap cancel in adjudicate envelope ───────────────────
      //
      // The customer-facing cancel kind is `order.cancel` (per
      // `@ibatexas/pack-orders`). The kernel may REFUSE (post-PONR) /
      // REQUEST_CONFIRMATION (paid orders) / ESCALATE (shipped). On
      // EXECUTE we keep the existing imperative path that uses the
      // command-service to transition + cancel payment + publish NATS.
      const cancelPayload: OrderCancelPayload = {
        orderId: id,
        reason: request.body.reason ?? "Cancelado pelo cliente",
        // BKL-103 — the PROPOSER stamp. `order.cancel` is a resumable escalation
        // kind, and `gatePaidCancel`'s OWNER-approval overlay compares
        // `approval.approverId !== payload.actorId`; without this stamp that
        // comparand is absent and the overlay refuses to convert at all (it
        // requires a non-empty proposer), so an approved >=R$1.000 paid cancel
        // could never resume. Sourced from the AUTHENTICATED customer only —
        // never from request input. It is also the customer scope the resume
        // re-projection uses (`escalationResumeSeedState`).
        actorId: customerId,
      };
      // ── P0-7 (audit-2026-05-24) — deterministic idempotency-key ───────
      //
      // Each order can legitimately be cancelled exactly once by its
      // owner. Browser retries, double-clicks, and network blips on
      // POST /api/orders/:id/cancel MUST produce the same `intentHash`
      // so the Execution Ledger dedupes. Prefer the client's explicit
      // `Idempotency-Key` header; fall back to a route-derived key from
      // `${orderId}:cancel:${customerId}` (both non-PII UUIDs).
      const cancelIdempotencyKey = resolveIdempotencyKey(
        request.headers["idempotency-key"],
        `${id}:cancel:${customerId}`,
      );
      const envelope = buildCustomerEnvelope<"order.cancel", OrderCancelPayload>({
        kind: "order.cancel",
        payload: cancelPayload,
        nonce: deriveNonce(cancelIdempotencyKey),
        customerId,
      });

      // Unified state contract (Phase 2): build the orders ctx from the already-
      // loaded `order` projection via the shared resolve-and-assemble builder, so
      // the HTTP and conductor paths adjudicate against the identical ctx shape.
      const orderState = {
        ctx: buildOrderCtx(
          identityCtx(customerId, "web"),
          id,
          order as unknown as OrderProjectionLite,
        ),
      };

      try {
        const out = await runCustomerIntent({
          envelope,
          state: orderState,
          policy: ordersPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
          executor: async () =>
            executeOrderCancel({
              orderId: id,
              customerId,
              reason: request.body.reason ?? "Cancelado pelo cliente",
              order,
              orderCmdSvc,
              paymentCmdSvc,
              paymentQuerySvc,
              log: server.log,
            }),
          ctx: {
            customerId,
            route: "order.cancel",
            log: server.log,
          },
          auditSink: getAuditSink(),
          refusalMessages: portugueseRefusalMessages,
        });

        // ── BKL-146 — PAID cancel parks (kernel REQUEST_CONFIRMATION, BKL-036
        // gatePaidCancel): the executor did NOT run. Store the cancel under a
        // single-use receipt and enrich the 202 with the confirmationId so the
        // customer can COMPLETE it via POST /api/orders/:id/cancel/confirm — the
        // kernel stays the confirm authority (the confirm route re-adjudicates
        // the IDENTICAL envelope with a confirmationReceipt). Mirrors the
        // checkout-confirm park (cart.ts).
        if (out.decision.kind === "REQUEST_CONFIRMATION") {
          const prompt = out.decision.prompt;
          const parked = await cancelConfirmationStore.create({
            kind: "order.cancel",
            orderId: id,
            payload: cancelPayload,
            idempotencyKey: cancelIdempotencyKey,
            customerId,
            prompt,
            createdAt: new Date().toISOString(),
          });
          return reply.code(202).send({
            confirmationRequired: true,
            confirmationId: parked.confirmationId,
            prompt,
            ttlSeconds: parked.ttlSeconds,
          });
        }

        // ── Translate the AUDITED kernel cancel-PONR refusal back to the legacy
        // 422 HTTP contract (BKL-036 finding 1). The kernel now OWNS the
        // fulfillment-state + already-cancelled cancel refusals
        // (`requireCancellable`), adjudicated + audited by runCustomerIntent
        // above; here we map the two stable refusal codes onto the exact status
        // + code clients saw when the check was pre-kernel: `preparing` →
        // PONR_EXPIRED (was escalate=true), every other post-PONR /
        // already-cancelled status → PAST_PONR. Any other REFUSE keeps the
        // gateway default (403).
        if (out.decision.kind === "REFUSE") {
          const refusalCode = out.decision.refusal.code;
          if (
            refusalCode === "order.past_ponr" ||
            refusalCode === "order.already_cancelled"
          ) {
            return reply.code(422).send({
              error:
                (out.body as { error?: string }).error ??
                out.decision.refusal.userFacing,
              code:
                order.fulfillmentStatus === "preparing"
                  ? "PONR_EXPIRED"
                  : "PAST_PONR",
              fulfillmentStatus: order.fulfillmentStatus,
            });
          }
        }

        // BKL-103 — the kernel ESCALATE (BKL-036 >=R$1000 paid-cancel guard)
        // returns 503 "Operação requer atendimento humano": surface it to staff
        // BEFORE replying, so the promise is true (dedup makes retries safe).
        if (out.decision.kind === "ESCALATE") {
          await publishPaidCancelEscalation(id, order, server.log, envelope);
        }
        return reply.code(out.statusCode).send(out.body);
      } catch (err) {
        if (err instanceof PaidCancelRefundNotSettledError) {
          // BKL-130 — a PAID order's refund did not settle (kernel band
          // escalate/refuse, e.g. ≥R$1000). The order was NOT canceled and the
          // payment is untouched (state whole); the refund needs human review.
          // BKL-103 — "avisaremos você" must be true: surface to staff first.
          await publishPaidCancelEscalation(id, order, server.log, envelope);
          return reply.code(409).send({
            error:
              "O reembolso deste pedido precisa de revisão da equipe. Nada foi alterado; avisaremos você.",
            code: "REFUND_REQUIRES_REVIEW",
          });
        }
        if (err instanceof PaymentCancelFailedError) {
          // P2-LOGIC-CANCELPAY: order row was canceled but the payment is still
          // live; order.canceled was withheld. Surface an actionable error so the
          // cancel is retried / escalated.
          return reply.code(409).send({
            error: "Não foi possível cancelar o pagamento do pedido. Tente novamente em instantes.",
            code: "PAYMENT_CANCEL_FAILED",
          });
        }
        if (err instanceof InvalidTransitionError) {
          return reply.code(422).send({ error: "Transição de status inválida.", from: err.from, to: err.to });
        }
        throw err;
      }
    },
  );

  // ── POST /api/orders/:id/cancel/confirm — complete a parked PAID cancel ─────
  //
  // BKL-146 — resume the parked cancel (the REQUEST_CONFIRMATION reply from
  // POST /api/orders/:id/cancel). The single-use receipt is consumed, ownership
  // re-checked, the order re-loaded FRESH, and the IDENTICAL order.cancel
  // envelope rebuilt + re-adjudicated through the AUDITED kernel carrying a
  // confirmationReceipt — so the kernel substitutes EXECUTE for the matching
  // intentHash while STILL enforcing every state/taint/auth guard (an order that
  // moved past the cancel PONR since the park is still REFUSEd here; the receipt
  // substitutes the confirmation, never bypasses a guard). Mirrors POST
  // /api/cart/checkout/confirm. On EXECUTE the SHARED executeOrderCancel runs the
  // identical money-path the direct route runs.
  app.post(
    "/api/orders/:id/cancel/confirm",
    {
      schema: {
        tags: ["orders"],
        summary: "Confirmar cancelamento de pedido pago (cliente)",
        params: OrderIdParams,
        body: z.object({ confirmationId: z.string().min(1).max(64) }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      // Single-use consume — unknown / expired / already-confirmed → 410 Gone.
      const pending = await cancelConfirmationStore.consume(request.body.confirmationId);
      if (!pending) {
        return reply.status(410).send({
          statusCode: 410,
          error: "Gone",
          message: "Esta confirmação expirou ou já foi utilizada. Refaça o cancelamento.",
          code: "CONFIRMATION_EXPIRED",
        });
      }

      // ── Money-safety ownership (IDOR) ────────────────────────────────────
      // The receipt binds the parked customerId + orderId. A different logged-in
      // customer (or a guest holding a leaked receipt) cannot confirm someone
      // else's cancel, and a receipt cannot be replayed against a different order.
      if (pending.customerId !== customerId || pending.orderId !== id) {
        return reply.status(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Esta confirmação pertence a outro pedido ou usuário.",
        });
      }
      // Projection-ownership parity with the cancel route (defense-in-depth).
      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      // Re-load the order FRESH so a since-changed status re-adjudicates.
      const order = await orderQuerySvc.getById(id);
      if (!order) return reply.code(404).send({ error: "Pedido não encontrado." });

      // Rebuild the IDENTICAL envelope — same kind/payload/nonce/actor → same
      // intentHash — so the receipt matches and the kernel resolves the confirm.
      const envelope = buildCustomerEnvelope<"order.cancel", OrderCancelPayload>({
        kind: "order.cancel",
        payload: pending.payload,
        nonce: deriveNonce(pending.idempotencyKey),
        customerId,
      });
      const orderState = {
        ctx: buildOrderCtx(
          identityCtx(customerId, "web"),
          id,
          order as unknown as OrderProjectionLite,
        ),
      };

      try {
        const out = await runCustomerIntent({
          envelope,
          state: orderState,
          policy: ordersPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
          executor: async () =>
            executeOrderCancel({
              orderId: id,
              customerId,
              reason: pending.payload.reason ?? "Cancelado pelo cliente",
              order,
              orderCmdSvc,
              paymentCmdSvc,
              paymentQuerySvc,
              log: server.log,
            }),
          ctx: { customerId, route: "order.cancel.confirm", log: server.log },
          auditSink: getAuditSink(),
          refusalMessages: portugueseRefusalMessages,
          confirmationReceipt: {
            intentHash: envelope.intentHash,
            at: new Date().toISOString(),
            token: request.body.confirmationId,
          },
        });

        // A since-changed order can now REFUSE (e.g. moved past the PONR) — map
        // the cancel-PONR codes onto the same 422 contract the direct route uses.
        if (out.decision.kind === "REFUSE") {
          const refusalCode = out.decision.refusal.code;
          if (refusalCode === "order.past_ponr" || refusalCode === "order.already_cancelled") {
            return reply.code(422).send({
              error: (out.body as { error?: string }).error ?? out.decision.refusal.userFacing,
              code: order.fulfillmentStatus === "preparing" ? "PONR_EXPIRED" : "PAST_PONR",
              fulfillmentStatus: order.fulfillmentStatus,
            });
          }
        }

        // BKL-103 — the kernel ESCALATE (BKL-036 >=R$1000 paid-cancel guard)
        // returns 503 "Operação requer atendimento humano": surface it to staff
        // BEFORE replying, so the promise is true (dedup makes retries safe).
        if (out.decision.kind === "ESCALATE") {
          await publishPaidCancelEscalation(id, order, server.log, envelope);
        }
        return reply.code(out.statusCode).send(out.body);
      } catch (err) {
        if (err instanceof PaidCancelRefundNotSettledError) {
          // BKL-130 — a PAID order's refund did not settle (kernel band
          // escalate/refuse, e.g. ≥R$1000). The order was NOT canceled and the
          // payment is untouched (state whole); the refund needs human review.
          // BKL-103 — "avisaremos você" must be true: surface to staff first.
          await publishPaidCancelEscalation(id, order, server.log, envelope);
          return reply.code(409).send({
            error:
              "O reembolso deste pedido precisa de revisão da equipe. Nada foi alterado; avisaremos você.",
            code: "REFUND_REQUIRES_REVIEW",
          });
        }
        if (err instanceof PaymentCancelFailedError) {
          return reply.code(409).send({
            error: "Não foi possível cancelar o pagamento do pedido. Tente novamente em instantes.",
            code: "PAYMENT_CANCEL_FAILED",
          });
        }
        if (err instanceof InvalidTransitionError) {
          return reply.code(422).send({ error: "Transição de status inválida.", from: err.from, to: err.to });
        }
        throw err;
      }
    },
  );

  // ── POST /api/orders/:id/amend/batch — atomic batch amendment ─────────────
  app.post(
    "/api/orders/:id/amend/batch",
    {
      schema: {
        tags: ["orders"],
        summary: "Batch amendment — validate all, then apply atomically",
        params: OrderIdParams,
        body: z.object({
          changes: z.array(z.object({
            type: z.enum(["remove", "update_qty"]),
            itemTitle: z.string().min(1),
            quantity: z.number().int().positive().optional(),
          })).min(1).max(50),
        }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      // Rate limit: 5 batch amend attempts per 10 minutes
      const redis: OrderActionRateLimitRedis = await deps.redis();
      const amendRlKey = rk(`rate:amend:${customerId}`);
      const amendCount = await redis.incr(amendRlKey);
      if (amendCount === 1) await redis.expire(amendRlKey, 600);
      if (amendCount > 5) {
        return reply.code(429).send({
          error: "Muitas tentativas de alteração. Aguarde 10 minutos.",
          code: "RATE_LIMIT",
        });
      }

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      // Fetch current order state (projection-first, Medusa fallback)
      const state = await loadAmendOrderState(orderQuerySvc, id);
      if (!state.found) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }
      const { fulfillmentStatus, itemProductTypeMap } = state;
      const isPreparing = fulfillmentStatus === "preparing";

      // ── Pre-validate ALL changes before applying any ──────────────────
      const validation = validateAmendChanges(
        request.body.changes,
        fulfillmentStatus,
        isPreparing,
        itemProductTypeMap,
      );
      if (!validation.ok) {
        return reply.code(422).send({
          error: validation.reason,
          code: "ACTION_NOT_ALLOWED",
        });
      }
      if (validation.lockedItems.length > 0) {
        return reply.code(422).send({
          error: "Alguns itens estão em preparo e não podem ser alterados.",
          code: "ITEM_NOW_LOCKED",
          lockedItems: validation.lockedItems,
        });
      }

      // ── Reject if all items would be removed (use cancel instead) ────
      const removeCount = request.body.changes.filter(c => c.type === "remove").length;
      const totalItemCount = itemProductTypeMap.size;
      if (totalItemCount > 0 && removeCount >= totalItemCount) {
        return reply.code(422).send({
          error: "Todos os itens foram removidos. Use o cancelamento do pedido.",
          code: "ALL_ITEMS_REMOVED",
        });
      }

      // ── Apply all changes sequentially ────────────────────────────────
      const { results, hasFailure } = await applyAmendChanges(
        request.body.changes,
        id,
        apiContext(customerId),
      );

      if (hasFailure) {
        return reply.code(422).send({
          error: "Algumas alterações falharam.",
          code: "PARTIAL_FAILURE",
          results,
        });
      }

      return reply.send({ success: true, results });
    },
  );

  // ── POST /api/orders/:id/amend — single action (legacy + WhatsApp) ──────
  app.post(
    "/api/orders/:id/amend",
    {
      schema: {
        tags: ["orders"],
        summary: "Alterar pedido (cliente)",
        params: OrderIdParams,
        body: z.object({
          action: z.enum(["add", "remove", "update_qty"]),
          variantId: z.string().optional(),
          itemTitle: z.string().optional(),
          quantity: z.number().int().positive().optional(),
        }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      // Rate limit: 5 amend attempts per 10 minutes
      const redis: OrderActionRateLimitRedis = await deps.redis();
      const amendRlKey = rk(`rate:amend:${customerId}`);
      const amendCount = await redis.incr(amendRlKey);
      if (amendCount === 1) await redis.expire(amendRlKey, 600);
      if (amendCount > 5) {
        return reply.code(429).send({
          error: "Muitas tentativas de alteração. Aguarde 10 minutos.",
          code: "RATE_LIMIT",
        });
      }

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      // ── Task 14 — wrap amend in adjudicate envelope ────────────────────
      //
      // The pack's `order.amend.request` kind carries a `changes` array
      // (the kernel supports batch + single via the same payload shape).
      // Single-action callers wrap their op in a 1-element changes array.
      // Map IbateXas's amend action vocabulary to the pack's. The HTTP
      // surface uses `update_qty` for legacy compatibility; the pack's
      // payload uses `update` per the master taxonomy.
      const packOp: "add" | "remove" | "update" =
        request.body.action === "update_qty" ? "update" : request.body.action;
      const amendPayload: OrderAmendRequestPayload = {
        orderId: id,
        changes: [
          {
            op: packOp,
            ...(request.body.variantId === undefined ? {} : { variantId: request.body.variantId }),
            ...(request.body.quantity === undefined ? {} : { quantity: request.body.quantity }),
          },
        ],
      };
      const envelope = buildCustomerEnvelope<"order.amend.request", OrderAmendRequestPayload>({
        kind: "order.amend.request",
        payload: amendPayload,
        nonce: randomUUID(),
        customerId,
      });

      // Unified state contract (Phase 2): shared orders-ctx builder. Load the
      // order projection so the kernel's `requireAmendable` guard can gate the
      // amend point-of-no-return on `fulfillmentStatus` (BKL-036 finding 3) —
      // the amend-window gating now REACHES the kernel instead of never running.
      // This route carried NO pre-dispatch PONR check and passed a null
      // projection, so the guard read no status and reduced to "order exists".
      // Only the fulfillment status is projected (tier a); the order-age
      // time-window (createdAt / amendPonrMinutes) is tier b, out of scope.
      // Ownership was verified above; a null projection (race) keeps the guard
      // inert, exactly as before.
      const amendOrderProjection = await orderQuerySvc.getById(id);
      const orderState = {
        ctx: buildOrderCtx(
          identityCtx(customerId, "web"),
          id,
          amendOrderProjection
            ? (amendOrderProjection as unknown as OrderProjectionLite)
            : null,
        ),
      };

      try {
        const out = await runCustomerIntent({
          envelope,
          state: orderState,
          policy: ordersPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
          executor: async () => {
            return amendOrder(
              {
                orderId: id,
                action: request.body.action,
                variantId: request.body.variantId,
                itemTitle: request.body.itemTitle,
                quantity: request.body.quantity,
              },
              apiContext(customerId),
            );
          },
          ctx: {
            customerId,
            route: "order.amend",
            log: server.log,
          },
          auditSink: getAuditSink(),
          refusalMessages: portugueseRefusalMessages,
        });

        return reply.code(out.statusCode).send(out.body);
      } catch (err) {
        if (err instanceof Error && err.name === "NonRetryableError") {
          return reply.code(422).send({ error: err.message });
        }
        server.log.error(err, "amendOrder falhou");
        return reply.code(500).send({ error: "Erro ao alterar pedido." });
      }
    },
  );

  // ── POST /api/orders/:id/notes ────────────────────────────────────────────
  app.post(
    "/api/orders/:id/notes",
    {
      schema: {
        tags: ["orders"],
        summary: "Adicionar observação ao pedido",
        params: OrderIdParams,
        body: z.object({ content: z.string().min(1).max(500) }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      // W7-P4: route the customer note through addNoteFromEnvelope so the
      // order.note.add intent is kernel-adjudicated and audit-emitted. The
      // Wave-6 finding flagged the direct prisma.orderNote.create as a
      // parallel/duplicate surface bypass.
      const projection = await orderQuerySvc.getById(id);
      if (!projection) {
        // Should not occur — verifyOwnership above passed — but bail safely.
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }
      const noteEnvelope = buildCustomerEnvelope<
        "order.note.add",
        OrderNoteAddPayload
      >({
        kind: "order.note.add" as const,
        payload: {
          orderId: id,
          body: request.body.content,
        },
        nonce: randomUUID(),
        customerId: `customer:${customerId}`,
      });
      // Unified state contract (Phase 2): build from the already-loaded projection
      // (no redundant query) via the shared builder — same ctx shape as the conductor.
      const noteOrderState = {
        ctx: buildOrderCtx(
          identityCtx(customerId, "web"),
          id,
          projection as unknown as OrderProjectionLite,
        ),
      } as unknown as OrderState;
      const noteAddSvc = deps.noteOrderCommandService();
      const outcome = await noteAddSvc.addNoteFromEnvelope(
        noteEnvelope,
        noteOrderState,
        { author: "customer", authorId: customerId },
      );

      if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
        const message =
          outcome.decision.kind === "REFUSE"
            ? outcome.decision.refusal.userFacing
            : "Não foi possível adicionar a observação no momento.";
        return reply.code(403).send({ error: message });
      }

      const noteResult = outcome.result!;
      // The service returns { noteId, orderId }. The route response shape
      // includes content + createdAt — refetch the row to surface those
      // (the service-layer chokepoint stays narrow).
      const persisted = await prisma.orderNote.findUnique({
        where: { id: noteResult.noteId },
      });

      await publishNatsEvent("order.note_added", {
        eventType: "order.note_added",
        orderId: id,
        noteId: noteResult.noteId,
        author: "customer",
        timestamp: new Date().toISOString(),
      });

      return reply.code(201).send({
        id: noteResult.noteId,
        content: persisted?.content ?? request.body.content,
        createdAt:
          persisted?.createdAt?.toISOString() ?? new Date().toISOString(),
      });
    },
  );

  // ── GET /api/orders/:id/notes ─────────────────────────────────────────────
  app.get(
    "/api/orders/:id/notes",
    {
      schema: {
        tags: ["orders"],
        summary: "Listar observações do pedido",
        params: OrderIdParams,
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const notes = await prisma.orderNote.findMany({
        where: { orderId: id, isInternal: false },
        orderBy: { createdAt: "asc" },
        take: 200,
      });

      return reply.send({
        notes: notes.map((n) => ({
          id: n.id,
          author: n.author,
          content: n.content,
          createdAt: n.createdAt.toISOString(),
        })),
      });
    },
  );

  // ── GET /api/orders/:id/payment ───────────────────────────────────────────
  app.get(
    "/api/orders/:id/payment",
    {
      schema: {
        tags: ["orders"],
        summary: "Status do pagamento do pedido",
        params: OrderIdParams,
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const payment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!payment) {
        return reply.send({ payment: null });
      }

      return reply.send({
        payment: {
          id: payment.id,
          method: payment.method,
          status: payment.status,
          amountInCentavos: payment.amountInCentavos,
          pixExpiresAt: payment.pixExpiresAt?.toISOString() ?? null,
          version: payment.version,
          createdAt: payment.createdAt.toISOString(),
        },
      });
    },
  );

  // ── POST /api/orders/:id/payment/retry ────────────────────────────────────
  app.post(
    "/api/orders/:id/payment/retry",
    {
      schema: {
        tags: ["orders"],
        summary: "Tentar pagamento novamente (mesmo método)",
        params: OrderIdParams,
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const order = await orderQuerySvc.getById(id);
      if (!order) return reply.code(404).send({ error: "Pedido não encontrado." });

      // Only pending/confirmed orders can retry payment
      const retryable = [OrderFulfillmentStatus.PENDING, OrderFulfillmentStatus.CONFIRMED] as string[];
      if (!retryable.includes(order.fulfillmentStatus)) {
        return reply.code(422).send({ error: "Pedido não permite nova tentativa de pagamento.", code: "NOT_RETRYABLE" });
      }

      // Rate limit: max 10 payment attempts per order
      const { count: attemptCount } = await paymentQuerySvc.listByOrderId(id);
      if (attemptCount >= 10) {
        return reply.code(429).send({ error: "Limite de tentativas atingido.", code: "RETRY_LIMIT" });
      }

      // Get current payment — must be in a retryable state
      const currentPayment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!currentPayment) {
        return reply.code(422).send({ error: "Nenhum pagamento ativo encontrado.", code: "NO_ACTIVE_PAYMENT" });
      }

      const retryableStatuses = [PaymentStatus.PAYMENT_FAILED, PaymentStatus.PAYMENT_EXPIRED] as string[];
      if (!retryableStatuses.includes(currentPayment.status)) {
        return reply.code(422).send({
          error: "Pagamento não está em estado que permite nova tentativa.",
          code: "NOT_RETRYABLE_STATUS",
          currentStatus: currentPayment.status,
        });
      }

      // ── BKL-041 — governed `payment.retry` composite kind (WS4) ───────
      //
      // Pre-BKL-041 this route ran `replaceActivePayment` directly (an inner
      // cancel + create) and never adjudicated the `payment.retry` composite kind
      // the Pack registers — so `retryDailyCapGuard` was unreachable (the two-
      // envelope decomposition the old "Wave 5" note anticipated). We now build the
      // composite UNTRUSTED customer envelope and adjudicate it through
      // `paymentsPolicyBundle` first; on EXECUTE the SAME `replaceActivePayment`
      // logic runs as the kind's executor. The inner cancel + create envelopes
      // remain the authoritative single-active-payment enforcement.
      //
      // `retryDailyCapGuard` reads `ctx.dailyRetryCount` (default cap 3, env
      // `MAX_PAYMENT_RETRIES_PER_DAY`) projected from Redis
      // (`payment-retry:{customerId}:{YYYY-MM-DD}`); the counter is bumped only
      // after a retry actually executes. The per-order lifetime cap (`RETRY_LIMIT`,
      // 10 attempts) stays the fast-fail above.
      const redis: PaymentRetryCapRedis = await deps.redis();
      const retryDay = new Date().toISOString().slice(0, 10);
      const retryCountKey = rk(`payment-retry:${customerId}:${retryDay}`);
      const dailyRetryCount = Number((await redis.get(retryCountKey)) ?? 0) || 0;

      // Retry uses the SAME method, so the replacement and the compensation target
      // are identical — the only distinct executor outcomes are `ok` and `orphaned`
      // (P1-ERR-PAYSWITCH).
      const method = currentPayment.method as PaymentMethodLiteral;
      const retryPayload: PaymentRetryPayload = {
        orderId: id,
        previousPaymentId: currentPayment.id,
        newMethod: method,
      };
      const out = await adjudicatePaymentReplacement<ReplacePaymentResult>({
        kind: "payment.retry",
        payload: retryPayload,
        customerId,
        ctx: {
          actor: { principal: "user", id: customerId },
          exists: true,
          currentStatus: currentPayment.status,
          currentMethod: method,
          orderId: id,
          dailyRetryCount,
        },
        route: "payment.retry",
        log: server.log,
        executor: () =>
          replaceActivePayment({
            paymentCmdSvc,
            orderId: id,
            currentPaymentId: currentPayment.id,
            currentMethod: method,
            newMethod: method,
            amountInCentavos: currentPayment.amountInCentavos,
            customerId,
            cancelReason: "Nova tentativa de pagamento",
            log: server.log,
          }),
      });

      // Kernel REFUSE — the daily-retry cap maps to the legacy 429 surface
      // (RETRY_LIMIT already lives there); any other refusal keeps the gateway 403.
      if (out.decision.kind === "REFUSE") {
        if (out.decision.refusal.code === "retry.cap_exceeded") {
          return reply.code(429).send({
            error: out.decision.refusal.userFacing,
            code: "RETRY_CAP",
          });
        }
        return reply.code(out.statusCode).send(out.body);
      }

      const result = out.body as ReplacePaymentResult;
      if (result.kind === "orphaned") {
        // Both create and compensation failed — actionable error, not a 500.
        return reply.code(503).send({
          error: "Não foi possível criar a nova tentativa de pagamento. Tente novamente em instantes.",
          code: "PAYMENT_RETRY_FAILED",
        });
      }

      // The retry executed — bump the daily-retry counter (date-scoped key, 24h
      // TTL). Best-effort: a counter blip must not fail a completed retry.
      const bumped = await redis.incr(retryCountKey);
      if (bumped === 1) await redis.expire(retryCountKey, 86_400);

      return reply.send({
        success: true,
        paymentId: result.payment.id,
        method,
        message: "Nova tentativa de pagamento criada. Conclua o pagamento.",
      });
    },
  );

  // ── POST /api/orders/:id/payment/regenerate-pix ───────────────────────────
  app.post(
    "/api/orders/:id/payment/regenerate-pix",
    {
      schema: {
        tags: ["orders"],
        summary: "Regenerar QR code PIX",
        params: OrderIdParams,
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      // Rate limit: 3 regenerations per hour per customer
      const redis: OrderActionRateLimitRedis = await deps.redis();
      const rateLimitKey = rk(`pix:regen:rate:${customerId}`);
      const count = await redis.incr(rateLimitKey);
      if (count === 1) await redis.expire(rateLimitKey, 3600);
      if (count > 3) {
        return reply.code(429).send({
          error: "Limite de regenerações atingido. Tente novamente em 1 hora ou escolha outro método.",
          code: "REGEN_RATE_LIMIT",
        });
      }

      // Get current payment — must be payment_expired and PIX method
      const currentPayment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!currentPayment) {
        return reply.code(422).send({ error: "Nenhum pagamento ativo encontrado.", code: "NO_ACTIVE_PAYMENT" });
      }

      if (currentPayment.method !== "pix") {
        return reply.code(422).send({ error: "Regeneração de PIX disponível apenas para pagamentos PIX.", code: "NOT_PIX" });
      }

      if (currentPayment.status !== "payment_expired") {
        return reply.code(422).send({
          error: "PIX só pode ser regenerado quando expirado.",
          code: "NOT_EXPIRED",
          currentStatus: currentPayment.status,
        });
      }

      // ── W3 P0-2 (audit remediation) ──────────────────────────────────
      //
      // The per-order cap is also enforced inside the kernel's
      // `regenerationCountCapGuard` (default 5; env override
      // `MAX_PIX_REGENERATIONS_PER_PAYMENT`). The HTTP-layer check stays
      // as a fast-fail for the common case; the kernel guard is the
      // authoritative gate.
      if (currentPayment.regenerationCount >= 5) {
        return reply.code(429).send({
          error: "Limite de regenerações para este pedido atingido.",
          code: "ORDER_REGEN_LIMIT",
        });
      }

      // Cancel current payment + create the regenerated PIX as a single
      // compensating sequence (P1-ERR-PAYSWITCH). Method is always pix here, so
      // the replacement and the compensation target are identical.
      const result = await replaceActivePayment({
        paymentCmdSvc,
        orderId: id,
        currentPaymentId: currentPayment.id,
        currentMethod: "pix",
        newMethod: "pix",
        amountInCentavos: currentPayment.amountInCentavos,
        customerId,
        cancelReason: "Regeneração de PIX",
        log: server.log,
      });

      if (result.kind === "orphaned") {
        // Both create and compensation failed — actionable error, not a 500.
        return reply.code(503).send({
          error: "Não foi possível gerar um novo QR code PIX. Tente novamente em instantes.",
          code: "PIX_REGEN_FAILED",
        });
      }
      const newPayment = result.payment;

      // 3. Bump the regeneration counter via the kernel-adjudicated path.
      //    The cap guard refuses bumps above
      //    `MAX_PIX_REGENERATIONS_PER_PAYMENT` (default 5).
      const bumpPayload: PaymentRegenerationCountIncrementPayload = {
        paymentId: newPayment.id,
        currentCount: 0,
      };
      const bumpEnvelope = buildEnvelope<
        "payment.regeneration.count.increment",
        PaymentRegenerationCountIncrementPayload
      >({
        kind: "payment.regeneration.count.increment",
        payload: bumpPayload,
        nonce: randomUUID(),
        actor: { principal: "system", sessionId: `customer:${customerId}` },
        taint: "SYSTEM",
      });
      const bumpOutcome =
        await paymentCmdSvc.bumpRegenerationCountFromEnvelope(bumpEnvelope);
      if (
        bumpOutcome.decision.kind !== "EXECUTE" &&
        bumpOutcome.decision.kind !== "REWRITE"
      ) {
        const text =
          bumpOutcome.decision.kind === "REFUSE"
            ? bumpOutcome.decision.refusal.userFacing
            : "Limite de regenerações atingido.";
        return reply.code(429).send({ error: text, code: "REGEN_CAP" });
      }

      return reply.send({
        success: true,
        paymentId: newPayment.id,
        message: "Novo QR code PIX gerado.",
      });
    },
  );

  // ── PATCH /api/orders/:id/payment/method ──────────────────────────────────
  app.patch(
    "/api/orders/:id/payment/method",
    {
      schema: {
        tags: ["orders"],
        summary: "Trocar método de pagamento",
        params: OrderIdParams,
        body: z.object({ method: z.enum(["pix", "card", "cash"]) }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const { method: newMethod } = request.body;
      const customerId = request.customerId!;

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const currentPayment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!currentPayment) {
        return reply.code(422).send({ error: "Nenhum pagamento ativo encontrado.", code: "NO_ACTIVE_PAYMENT" });
      }

      // Can't switch if already paid
      if (currentPayment.status === "paid") {
        return reply.code(422).send({
          error: "Pagamento já foi confirmado. Solicite reembolso para trocar.",
          code: "ALREADY_PAID",
        });
      }

      // Can't switch to same method
      if (currentPayment.method === newMethod) {
        return reply.code(422).send({ error: "Método de pagamento já é o mesmo.", code: "SAME_METHOD" });
      }

      // Switchable states
      const switchable = [
        PaymentStatus.AWAITING_PAYMENT,
        PaymentStatus.PAYMENT_PENDING,
        PaymentStatus.PAYMENT_EXPIRED,
        PaymentStatus.PAYMENT_FAILED,
        PaymentStatus.CASH_PENDING,
      ] as string[];

      if (!switchable.includes(currentPayment.status)) {
        return reply.code(422).send({
          error: "Pagamento não está em estado que permite troca de método.",
          code: "NOT_SWITCHABLE",
          currentStatus: currentPayment.status,
        });
      }

      // ── BKL-041 — governed `payment.method.switch` composite kind (WS4) ──
      //
      // Pre-BKL-041 this route ran `replaceActivePayment` directly (the
      // switching_method → cancel → create decomposition) and never adjudicated
      // the `payment.method.switch` composite kind the Pack registers — so
      // `validateMethodSwitch` was unreachable (the aspirational "build a
      // payment.method.switch envelope" note that used to sit here). We now build
      // the composite UNTRUSTED customer envelope and adjudicate it through
      // `paymentsPolicyBundle` first; on EXECUTE the SAME `replaceActivePayment`
      // logic runs as the kind's executor, held under the per-payment lock so the
      // whole switching_method → cancel → create → compensate sequence stays
      // serialized (cycle-2 invariant). The inner cancel + create envelopes remain
      // the authoritative single-active-payment enforcement; the HTTP pre-checks
      // (paid, same-method, switchable) stay the fast-fails above.
      const currentMethod = currentPayment.method as PaymentMethodLiteral;
      const out = await adjudicatePaymentReplacement<ReplacePaymentResult | null>({
        kind: "payment.method.switch",
        payload: {
          orderId: id,
          fromMethod: currentMethod,
          toMethod: newMethod,
          customerId,
        },
        customerId,
        ctx: {
          actor: { principal: "user", id: customerId },
          exists: true,
          currentStatus: currentPayment.status,
          currentMethod,
          orderId: id,
        },
        route: "payment.method.switch",
        log: server.log,
        executor: () =>
          withLock(`payment:${currentPayment.id}`, async () => {
            const replaced = await replaceActivePayment({
              paymentCmdSvc,
              orderId: id,
              currentPaymentId: currentPayment.id,
              currentMethod,
              newMethod,
              amountInCentavos: currentPayment.amountInCentavos,
              customerId,
              cancelReason: `Troca de método: ${currentMethod} → ${newMethod}`,
              // Transition old payment → switching_method before canceling (if the
              // current state allows it). Tolerate a non-EXECUTE here — the cancel +
              // create inside replaceActivePayment are the authoritative steps.
              preCancel: canTransitionPayment(currentPayment.status as PaymentStatus, PaymentStatus.SWITCHING_METHOD)
                ? async () => {
                    const switchingEnvelope = buildEnvelope<
                      "payment.status.transition",
                      PaymentStatusTransitionPayload
                    >({
                      kind: "payment.status.transition",
                      payload: {
                        paymentId: currentPayment.id,
                        newStatus: PaymentStatus.SWITCHING_METHOD,
                        actor: "customer",
                        actorId: customerId,
                        reason: `Troca de ${currentMethod} para ${newMethod}`,
                      },
                      nonce: randomUUID(),
                      actor: { principal: "user", sessionId: customerId },
                      taint: "TRUSTED",
                    });
                    await paymentCmdSvc.transitionStatusFromEnvelope(switchingEnvelope).catch(ignoreError);
                  }
                : undefined,
              log: server.log,
            });

            // Only emit method_changed when the NEW method actually became active.
            // On compensation the original method is restored, so the method did NOT
            // change and no event is published.
            if (replaced.kind === "ok") {
              await publishNatsEvent("payment.method_changed", {
                eventType: "payment.method_changed",
                orderId: id,
                paymentId: replaced.payment.id,
                previousMethod: currentMethod,
                newMethod,
                timestamp: new Date().toISOString(),
              });
            }

            return replaced;
          }, 15),
      });

      // Kernel REFUSE (e.g. the `validateMethodSwitch` shape guard) → surface the
      // gateway's localized decision (403). No mutation ran.
      if (out.decision.kind === "REFUSE") {
        return reply.code(out.statusCode).send(out.body);
      }

      const result = out.body as ReplacePaymentResult | null;

      if (!result) {
        return reply.code(409).send({ error: "Operação em andamento. Tente novamente.", code: "LOCK_CONFLICT" });
      }

      if (result.kind === "orphaned") {
        // Both the new-method create and the compensating restore failed.
        return reply.code(503).send({
          error: "Não foi possível trocar o método de pagamento. Tente novamente em instantes.",
          code: "PAYMENT_SWITCH_FAILED",
        });
      }

      if (result.kind === "compensated") {
        // The switch failed but the original method was restored as the active
        // payment — actionable error, order still in a usable payment state.
        return reply.code(503).send({
          error: `Não foi possível trocar para ${newMethod}. Seu método de pagamento (${currentMethod}) continua ativo. Tente novamente.`,
          code: "PAYMENT_SWITCH_FAILED",
          activePaymentId: result.payment.id,
          method: currentMethod,
        });
      }

      return reply.send({
        success: true,
        paymentId: result.payment.id,
        method: newMethod,
        message: `Método de pagamento alterado para ${newMethod}.`,
      });
    },
  );

  // ── PATCH /api/orders/:id/address ─────────────────────────────────────────
  app.patch(
    "/api/orders/:id/address",
    {
      schema: {
        tags: ["orders"],
        summary: "Alterar endereço de entrega",
        params: OrderIdParams,
        body: z.object({
          address: z.object({
            address1: z.string().min(1),
            address2: z.string().optional(),
            city: z.string().min(1),
            state: z.string().min(2).max(2),
            postalCode: z.string().min(8).max(9),
            neighborhood: z.string().optional(),
          }),
        }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      // ── Task 14 — wrap address change in adjudicate envelope ──────────
      //
      // The customer-facing kind is `order.address.change` (per
      // `@ibatexas/pack-orders`). The kernel adjudicates against the
      // outer pack-orders bundle; the inner `changeDeliveryAddress` tool
      // then re-adjudicates against `orderProjectionPolicyBundle` at the
      // service-layer chokepoint (`changeAddressFromEnvelope`). Map the
      // HTTP body's IbateXas-vocab address (`address1`/`postalCode`/…)
      // onto the Pack's canonical vocab (`street`/`zip`/…).
      const reqBody = request.body;
      const addressPayload: OrderAddressChangePayload = {
        orderId: id,
        address: {
          street: reqBody.address.address1,
          ...(reqBody.address.address2 === undefined
            ? {}
            : { complement: reqBody.address.address2 }),
          ...(reqBody.address.neighborhood === undefined
            ? {}
            : { neighborhood: reqBody.address.neighborhood }),
          city: reqBody.address.city,
          state: reqBody.address.state,
          zip: reqBody.address.postalCode,
        },
      };
      const envelope = buildCustomerEnvelope<"order.address.change", OrderAddressChangePayload>({
        kind: "order.address.change",
        payload: addressPayload,
        nonce: randomUUID(),
        customerId,
      });

      // Unified state contract (Phase 2): shared orders-ctx builder. This route's
      // own logic enforces PONR before dispatch, so the kernel guard is additive
      // here; the ctx SHAPE matches the conductor path (identity base + tenantId).
      const orderState = {
        ctx: buildOrderCtx(identityCtx(customerId, "web"), id, null),
      };

      try {
        const out = await runCustomerIntent({
          envelope,
          state: orderState,
          policy: ordersPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
          executor: async () => {
            return changeDeliveryAddress(
              { orderId: id, address: reqBody.address },
              apiContext(customerId),
            );
          },
          ctx: {
            customerId,
            route: "order.address.change",
            log: server.log,
          },
          auditSink: getAuditSink(),
          refusalMessages: portugueseRefusalMessages,
        });

        // The inner tool returns `{ success: boolean, message, needsEscalation? }`
        // on its own — surface the legacy 422 mapping when the tool's
        // service-layer adjudication or business validator refused even
        // though the outer pack-orders adjudication permitted EXECUTE.
        if (out.statusCode === 200) {
          const toolResult = out.body as {
            success: boolean;
            message: string;
            needsEscalation?: boolean;
          };
          if (!toolResult.success) {
            return reply.code(422).send({
              error: toolResult.message,
              needsEscalation: toolResult.needsEscalation,
            });
          }
        }
        return reply.code(out.statusCode).send(out.body);
      } catch (err) {
        if (err instanceof Error && err.name === "NonRetryableError") {
          return reply.code(422).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // ── PATCH /api/orders/:id/type ────────────────────────────────────────────
  app.patch(
    "/api/orders/:id/type",
    {
      schema: {
        tags: ["orders"],
        summary: "Alterar tipo do pedido (entrega/retirada/local)",
        params: OrderIdParams,
        body: z.object({
          type: z.enum(["delivery", "pickup", "dine_in"]),
        }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { id } = request.params;
      const customerId = request.customerId!;

      if (!(await verifyOwnership(id, customerId))) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      // ── Task 14 — wrap type switch in adjudicate envelope ─────────────
      //
      // The customer-facing kind is `order.type.switch`. Pack-orders uses
      // the binary `delivery` | `takeout` vocabulary; IbateXas's HTTP
      // surface distinguishes `pickup` vs `dine_in` (both non-delivery).
      // Collapse both to `takeout` for the outer envelope; the inner
      // `switchOrderType` tool preserves the precise vocab via the
      // projection-policy envelope it builds internally.
      //
      // audit-2026-05-24 P2-3: the audit record is built from the outer
      // envelope's payload. Without preserving the original HTTP
      // vocabulary, an operator reading the audit row can't tell
      // whether the customer asked for `pickup` or `dine_in` — both
      // collapse to `takeout`. We carry the original via `httpVocab`
      // (descriptive-only, pack guards ignore it) so the audit record
      // captures both the policy-adjudicated value AND what the customer
      // actually said.
      const newType = request.body.type;
      const packNewType: "delivery" | "takeout" =
        newType === "delivery" ? "delivery" : "takeout";
      const typePayload: OrderTypeSwitchPayload = {
        orderId: id,
        newType: packNewType,
        httpVocab: newType,
      };
      const envelope = buildCustomerEnvelope<"order.type.switch", OrderTypeSwitchPayload>({
        kind: "order.type.switch",
        payload: typePayload,
        nonce: randomUUID(),
        customerId,
      });

      // Unified state contract (Phase 2): shared orders-ctx builder. This route's
      // own logic enforces PONR before dispatch, so the kernel guard is additive
      // here; the ctx SHAPE matches the conductor path (identity base + tenantId).
      const orderState = {
        ctx: buildOrderCtx(identityCtx(customerId, "web"), id, null),
      };

      try {
        const out = await runCustomerIntent({
          envelope,
          state: orderState,
          policy: ordersPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
          executor: async () => {
            return switchOrderType(
              { orderId: id, newType },
              apiContext(customerId),
            );
          },
          ctx: {
            customerId,
            route: "order.type.switch",
            log: server.log,
          },
          auditSink: getAuditSink(),
          refusalMessages: portugueseRefusalMessages,
        });

        // Preserve legacy 422 mapping when the inner tool refuses despite
        // the outer pack-orders adjudication permitting EXECUTE.
        if (out.statusCode === 200) {
          const toolResult = out.body as {
            success: boolean;
            message: string;
            needsEscalation?: boolean;
          };
          if (!toolResult.success) {
            return reply.code(422).send({
              error: toolResult.message,
              needsEscalation: toolResult.needsEscalation,
            });
          }
        }
        return reply.code(out.statusCode).send(out.body);
      } catch (err) {
        if (err instanceof Error && err.name === "NonRetryableError") {
          return reply.code(422).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
