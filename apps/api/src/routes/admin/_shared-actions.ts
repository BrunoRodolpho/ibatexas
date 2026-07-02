// Shared admin order/payment action helpers.
//
// ── Why this module exists ───────────────────────────────────────────────
//
// The admin order-actions (`order-actions.ts`) and payment-control
// (`payments.ts`) route modules implement the same two-step
// confirmation protocol over four destructive money/governance routes
// (force-cancel, waive, refund, force-status). Several blocks were
// byte-for-byte duplicated across both files:
//
//   1. The consume-receipt + two-person separation-of-duty rejection
//      ladder (missing / null_staff / actor_type_mismatch / same_actor /
//      wrong-route), each refusal kind emitting its own audit entry.
//   2. The `principalFor` actor/taint derivation.
//   3. The non-EXECUTE "refused" audit-log + 403 reply.
//   4. The kernel refusal-text fallback string.
//   5. The admin internal/admin note adjudication (envelope build +
//      order-state + `addNoteFromEnvelope` + persisted lookup).
//
// These are extracted here UNCHANGED — same inputs produce the same
// outputs, side-effects, ordering, await timing, and audit-envelope
// content. Only the per-route `eventPrefix` / `expectedRoute` /
// fallback-message vary, and those are passed in by the caller.
//
// MONEY/GOVERNANCE NOTE: this module carries NO threshold, confirm, or
// escalate logic — those stay in `payments.ts` (refund drip cap,
// threshold branch) and `order-actions.ts`. This module only holds the
// already-identical glue.

import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import {
  createOrderCommandService,
  createOrderEventLogService,
  createOrderQueryService,
  prisma,
} from "@ibatexas/domain";
import type {
  OrderNoteAddPayload,
  OrderState,
} from "@ibatexas/pack-orders";
import {
  ACTOR_TYPE_MISMATCH_REFUSAL_PT_BR,
  consumeWithSameActorCheck,
  NULL_STAFF_REFUSAL_PT_BR,
  SAME_ACTOR_REFUSAL_PT_BR,
  type AdminConfirmationStore,
  type ConsumeWithSameActorOutcome,
  type PendingAdminAction,
} from "./admin-confirmation-store.js";

/**
 * Derive envelope `actor` + `taint` from the authenticated request's
 * staffId.
 *
 * `requireManager` / `requireStaff` ensure `request.staffId` is set on
 * JWT-authenticated routes; the outer admin guard accepts API-key
 * callers too (no staff identity). When `staffId` is null we treat
 * the caller as `"system"` with `SYSTEM` taint — same convention as
 * the Stripe webhook and customer route migrations.
 *
 * Behavior-preserving extraction of the identical `principalFor`
 * previously defined in both `order-actions.ts` and `payments.ts`.
 */
export function principalFor(staffId: string | null): {
  readonly actorPrincipal: "user" | "system";
  readonly taint: "TRUSTED" | "SYSTEM";
  readonly sessionId: string;
} {
  if (staffId) {
    return {
      actorPrincipal: "user",
      taint: "TRUSTED",
      sessionId: `admin:${staffId}`,
    };
  }
  return {
    actorPrincipal: "system",
    taint: "SYSTEM",
    sessionId: "admin:api-key",
  };
}

/**
 * Map a non-EXECUTE/REWRITE kernel decision onto its operator-facing
 * text: a `REFUSE` surfaces the kernel's own `userFacing` copy; any
 * other kind (DEFER / ESCALATE / REQUEST_CONFIRMATION) surfaces the
 * supplied `fallback`.
 *
 * Behavior-preserving extraction of the inline
 * `decision.kind === "REFUSE" ? decision.refusal.userFacing : "<fallback>"`
 * ternary repeated across both route modules (and of `payments.ts`'s
 * `transitionRefusalText`). The `decision.refusal !== undefined` guard is
 * a type narrowing only — `refusal` is always present on a `REFUSE`
 * decision, so the returned value is identical to the original ternary.
 */
export function kernelRefusalText(
  decision: {
    readonly kind: string;
    readonly refusal?: { readonly userFacing: string };
  },
  fallback = "Operação não permitida pela política do kernel.",
): string {
  return decision.kind === "REFUSE" && decision.refusal !== undefined
    ? decision.refusal.userFacing
    : fallback;
}

/**
 * Build the kernel envelope for a confirm-step (etapa-2) status transition.
 *
 * Behavior-preserving extraction of the provably-identical envelope-build
 * skeleton shared by the `force-cancel/confirm` (order.status.transition),
 * `waive/confirm` and `force-status/confirm` (payment.status.transition)
 * handlers:
 *
 *   1. derive `principalFor(staffId)` → actor principal / taint / sessionId,
 *   2. thread the step-1 snapshot version into the payload (audit-2026-05-24
 *      P2-5): `{ ...storedPayload, ...(expectedVersion ?? omit) }`,
 *   3. `buildEnvelope` with `{ kind, payload, nonce: pending.nonce, actor,
 *      taint }`.
 *
 * The resulting `payload` is byte-identical to the previous inline build
 * (same keys, same values, same conditional `expectedVersion`) so the
 * computed `intentHash` is unchanged. `principalFor` is pure, so deriving it
 * here (rather than before each call site's inline divergent guards) has no
 * observable effect.
 *
 * The per-route DIVERGENT money/governance logic stays inline at each call
 * site and is intentionally NOT unified here: the `paymentId` active-payment
 * swap guard, the concurrency try/catch (order `ConcurrencyError` → 409 vs
 * payment `PaymentConcurrencyError` → `logStaleVersionRefusal`), the
 * non-EXECUTE refusal `eventType`, which NATS event is published, the
 * executed-audit payload, and the `cancelActivePaymentBestEffort` call. The
 * derived `actorPrincipal` / `taint` / `sessionId` are surfaced so the
 * force-cancel path can reuse them for its payment-cancel call.
 */
export function buildAdminTransitionEnvelope<
  K extends string,
  P extends { readonly expectedVersion?: number },
>(deps: {
  readonly pending: PendingAdminAction;
  readonly staffId: string | null;
  readonly kind: K;
}): {
  readonly envelope: IntentEnvelope<K, P>;
  readonly actorPrincipal: "user" | "system";
  readonly taint: "TRUSTED" | "SYSTEM";
  readonly sessionId: string;
} {
  const { actorPrincipal, taint, sessionId } = principalFor(deps.staffId);
  const storedPayload = deps.pending.payload as unknown as P;
  const payload = {
    ...storedPayload,
    ...(deps.pending.expectedVersion === undefined
      ? {}
      : { expectedVersion: deps.pending.expectedVersion }),
  } as unknown as P;
  const envelope = buildEnvelope<K, P>({
    kind: deps.kind,
    payload,
    nonce: deps.pending.nonce,
    actor: { principal: actorPrincipal, sessionId },
    taint,
  });
  return { envelope, actorPrincipal, taint, sessionId };
}

/**
 * Result of {@link gateConsumedAdminAction} / {@link consumeAndGateAdminAction}:
 * either a reply descriptor for a refused/invalid receipt (`ok: false`)
 * or the validated pending action to proceed with (`ok: true`).
 */
export type AdminConsumeGate =
  | { readonly ok: false; readonly code: number; readonly error: string }
  | { readonly ok: true; readonly pending: PendingAdminAction };

/** Audit-event prefix per destructive admin route. */
type AdminEventPrefix =
  | "admin.force_cancel"
  | "admin.waive"
  | "admin.refund"
  | "admin.force_status";

/**
 * Validate a consumed admin-confirmation receipt and enforce the
 * two-person separation-of-duty gate shared by every confirm-step route.
 * Emits the matching refusal audit entry for each violation kind and
 * returns either a reply descriptor (`ok: false`) or the validated
 * pending action (`ok: true`).
 *
 * Behavior-preserving extraction of the previously-inlined
 * consume-rejection ladder (kept identical ordering + event payloads;
 * only the `eventPrefix` prefix and the expected route vary per caller).
 */
async function gateConsumedAdminAction(
  consumed: ConsumeWithSameActorOutcome,
  deps: {
    readonly eventLogSvc: ReturnType<typeof createOrderEventLogService>;
    readonly orderId: string;
    readonly confirmationId: string;
    readonly staffId: string | null;
    readonly eventPrefix: AdminEventPrefix;
    readonly expectedRoute: PendingAdminAction["route"];
  },
): Promise<AdminConsumeGate> {
  const {
    eventLogSvc,
    orderId,
    confirmationId,
    staffId,
    eventPrefix,
    expectedRoute,
  } = deps;
  const invalidReceipt: AdminConsumeGate = {
    ok: false,
    code: 410,
    error: "Confirmação inválida, expirada ou já utilizada.",
  };
  if (consumed.kind === "missing") {
    return invalidReceipt;
  }
  // Wrong route/order for this receipt: refused BEFORE the consume (the
  // receipt survives for a correctly aimed confirm), same 410 to the caller.
  if (consumed.kind === "target_mismatch") {
    return invalidReceipt;
  }
  if (consumed.kind === "null_staff_violation") {
    await eventLogSvc.append({
      orderId,
      eventType: `${eventPrefix}.null_staff_refused`,
      discriminator: confirmationId,
      payload: {
        confirmationId,
        staffId,
        pendingStaffId: consumed.pending.staffId,
        reason: consumed.reason,
      },
      timestamp: new Date(),
    });
    return { ok: false, code: 403, error: NULL_STAFF_REFUSAL_PT_BR };
  }
  if (consumed.kind === "actor_type_mismatch") {
    await eventLogSvc.append({
      orderId,
      eventType: `${eventPrefix}.actor_type_mismatch_refused`,
      discriminator: confirmationId,
      payload: {
        confirmationId,
        staffId,
        pendingActor: consumed.pendingActor,
        requestActor: consumed.requestActor,
      },
      timestamp: new Date(),
    });
    return { ok: false, code: 403, error: ACTOR_TYPE_MISMATCH_REFUSAL_PT_BR };
  }
  if (consumed.kind === "same_actor_violation") {
    await eventLogSvc.append({
      orderId,
      eventType: `${eventPrefix}.same_actor_refused`,
      discriminator: confirmationId,
      payload: {
        confirmationId,
        staffId,
        pendingStaffId: consumed.pending.staffId,
      },
      timestamp: new Date(),
    });
    return { ok: false, code: 403, error: SAME_ACTOR_REFUSAL_PT_BR };
  }
  const pending = consumed.pending;
  if (pending.route !== expectedRoute || pending.orderId !== orderId) {
    return invalidReceipt;
  }
  return { ok: true, pending };
}

/**
 * Consume an admin-confirmation receipt (with the two-person same-actor
 * check) and run it through {@link gateConsumedAdminAction}. Combines the
 * `principalFor` → `consumeWithSameActorCheck` → gate sequence that was
 * inlined identically at the head of all four confirm-step handlers.
 *
 * Returns the gate descriptor: `{ ok: false, code, error }` for any
 * refusal (the audit entry is already emitted inside the gate) or
 * `{ ok: true, pending }` to proceed.
 */
export async function consumeAndGateAdminAction(deps: {
  readonly confirmationStore: AdminConfirmationStore;
  readonly eventLogSvc: ReturnType<typeof createOrderEventLogService>;
  readonly confirmationId: string;
  readonly orderId: string;
  readonly staffId: string | null;
  readonly eventPrefix: AdminEventPrefix;
  readonly expectedRoute: PendingAdminAction["route"];
}): Promise<AdminConsumeGate> {
  const { actorPrincipal: requestActorPrincipal } = principalFor(deps.staffId);
  const consumed = await consumeWithSameActorCheck(
    deps.confirmationStore,
    deps.confirmationId,
    deps.staffId,
    requestActorPrincipal,
    { route: deps.expectedRoute, orderId: deps.orderId },
  );
  return gateConsumedAdminAction(consumed, {
    eventLogSvc: deps.eventLogSvc,
    orderId: deps.orderId,
    confirmationId: deps.confirmationId,
    staffId: deps.staffId,
    eventPrefix: deps.eventPrefix,
    expectedRoute: deps.expectedRoute,
  });
}

/**
 * Emit the `<eventPrefix>.refused` audit entry for a non-EXECUTE kernel
 * decision on a confirm-step route and return the 403 reply. Behavior-
 * preserving extraction of the identical append-then-403 block in
 * force-cancel/confirm, waive/confirm and force-status/confirm.
 */
export async function refuseTransitionWithLog(deps: {
  readonly eventLogSvc: ReturnType<typeof createOrderEventLogService>;
  readonly reply: FastifyReply;
  readonly orderId: string;
  readonly confirmationId: string;
  readonly staffId: string | null;
  readonly eventType: string;
  readonly decisionKind: string;
  readonly intentHash: string;
  readonly refusalText: string;
}) {
  await deps.eventLogSvc.append({
    orderId: deps.orderId,
    eventType: deps.eventType,
    discriminator: deps.confirmationId,
    payload: {
      confirmationId: deps.confirmationId,
      staffId: deps.staffId,
      decision: deps.decisionKind,
      intentHash: deps.intentHash,
    },
    timestamp: new Date(),
  });
  return deps.reply.code(403).send({ error: deps.refusalText });
}

/**
 * Emit the `<eventType>` stale-version audit entry for a
 * `PaymentConcurrencyError` raised between step 1 and step 2 of a payment
 * mutation, then return the canonical 409 "payment was updated by another
 * operator" reply. Behavior-preserving extraction of the identical
 * append-then-409 block in waive/confirm and force-status/confirm (the
 * `eventType` is the only per-route difference; `message` carries the
 * underlying error text, identical to the previous inline code).
 */
export async function logStaleVersionRefusal(deps: {
  readonly eventLogSvc: ReturnType<typeof createOrderEventLogService>;
  readonly reply: FastifyReply;
  readonly orderId: string;
  readonly confirmationId: string;
  readonly staffId: string | null;
  readonly eventType: string;
  readonly expectedVersion: number | null;
  readonly message: string;
}) {
  await deps.eventLogSvc.append({
    orderId: deps.orderId,
    eventType: deps.eventType,
    discriminator: deps.confirmationId,
    payload: {
      confirmationId: deps.confirmationId,
      staffId: deps.staffId,
      expectedVersion: deps.expectedVersion,
      message: deps.message,
    },
    timestamp: new Date(),
  });
  return deps.reply.code(409).send({
    error:
      "Pagamento foi atualizado por outro atendente após a aprovação. Reabra a operação.",
  });
}

type AdminOrder = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createOrderQueryService>["getById"]>>
>;

type AddNoteOutcome = Awaited<
  ReturnType<ReturnType<typeof createOrderCommandService>["addNoteFromEnvelope"]>
>;

/**
 * Result of {@link adjudicateAdminNote}: a refused kernel decision (the
 * caller maps it onto its own operator-facing message) or the executed
 * note id + persisted row (the caller renders its own reply / NATS event).
 */
export type AdminNoteResult =
  | { readonly kind: "refused"; readonly decision: AddNoteOutcome["decision"] }
  | {
      readonly kind: "executed";
      readonly noteId: string;
      readonly persisted: Awaited<
        ReturnType<typeof prisma.orderNote.findUnique>
      >;
    };

/**
 * Adjudicate an admin order note through `addNoteFromEnvelope` and (on
 * EXECUTE/REWRITE) re-read the persisted row. Behavior-preserving
 * extraction of the envelope-build + order-state + adjudicate + lookup
 * block shared by `order-actions.ts` (staff internal note, `isInternal`)
 * and `payments.ts` (admin note). The only per-caller difference —
 * whether `isInternal: true` is stamped on the payload — is the
 * `isInternal` flag; everything downstream (nonce, actor, taint,
 * order-state, adjudication, persisted lookup) is identical.
 *
 * W7-P4: routing through `addNoteFromEnvelope` keeps the `order.note.add`
 * intent kernel-adjudicated and audit-emitted (the Wave-6 finding flagged
 * the direct `prisma.orderNote.create` as a parallel/duplicate surface
 * bypass). `isInternal` is carried in the payload so the pack-orders
 * policy can observe it.
 */
export async function adjudicateAdminNote(deps: {
  readonly orderCmdSvc: ReturnType<typeof createOrderCommandService>;
  readonly order: AdminOrder;
  readonly orderId: string;
  readonly staffId: string | null;
  readonly content: string;
  readonly isInternal?: boolean;
}): Promise<AdminNoteResult> {
  const noteEnvelope = buildEnvelope<"order.note.add", OrderNoteAddPayload>({
    kind: "order.note.add" as const,
    payload: {
      orderId: deps.orderId,
      body: deps.content,
      ...(deps.isInternal ? { isInternal: true } : {}),
    },
    nonce: randomUUID(),
    actor: deps.staffId
      ? { principal: "user", sessionId: `admin:${deps.staffId}` }
      : { principal: "system", sessionId: "admin:api-key" },
    taint: deps.staffId ? "TRUSTED" : "SYSTEM",
  });
  const noteOrderState: OrderState = {
    ctx: {
      channel: "web",
      customerId: deps.order.customerId,
      cartId: null,
      orderId: deps.orderId,
      paymentMethod:
        (deps.order.paymentMethod as "pix" | "card" | "cash" | null) ?? null,
      paymentStatus: deps.order.paymentStatus,
      totalInCentavos: deps.order.totalInCentavos,
    },
  };
  const outcome = await deps.orderCmdSvc.addNoteFromEnvelope(
    noteEnvelope,
    noteOrderState,
    {
      author: "staff",
      ...(deps.staffId ? { authorId: deps.staffId } : {}),
    },
  );

  if (
    outcome.decision.kind !== "EXECUTE" &&
    outcome.decision.kind !== "REWRITE"
  ) {
    return { kind: "refused", decision: outcome.decision };
  }

  const noteResult = outcome.result!;
  const persisted = await prisma.orderNote.findUnique({
    where: { id: noteResult.noteId },
  });
  return { kind: "executed", noteId: noteResult.noteId, persisted };
}
