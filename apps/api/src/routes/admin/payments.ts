// Admin payment control routes.
//
// POST  /api/admin/orders/:id/payment/confirm-cash         — confirm cash received (ATTENDANT+)
// POST  /api/admin/orders/:id/payment/refund               — refund step 1 (MANAGER+)
// POST  /api/admin/orders/:id/payment/refund/confirm       — refund step 2 (MANAGER+)
// PATCH /api/admin/orders/:id/payment/status               — force-status step 1 (OWNER)
// POST  /api/admin/orders/:id/payment/status/confirm       — force-status step 2 (OWNER)
// POST  /api/admin/orders/:id/notes                        — add admin note (ATTENDANT+)
// GET   /api/admin/orders/:id/notes                        — list notes
// GET   /api/admin/orders/:id/payments                     — list all payment attempts
//
// ── Task 13 (M3) — admin force-* governance ─────────────────────────────
//
// `refund` and `force-status` are the payment-side destructive admin
// actions. Per investigation 02 P0 #2 / #3, refunds send money out and
// force-status can move the payment to any terminal state without
// kernel review. After this task lands:
//
//   - **Refund** uses a THRESHOLD-based confirmation. Refunds < R$ 200
//     (20.000 centavos, per CLAUDE.md rule #2) execute directly under
//     the envelope path. Refunds >= R$ 200 enter the two-step
//     receipt protocol (202 → confirmation → 200).
//
//   - **Force-status** ALWAYS requires the two-step receipt protocol
//     regardless of the target status. It is the most flexible
//     mutation surface (any → any non-validated transition) and is
//     OWNER-only by policy.
//
//   - **Confirm-cash** is non-destructive (only `cash_pending → paid`)
//     and migrates to envelope dispatch without a confirmation flow.
//
// The legacy `prisma.payment.update` for the refunded amount field
// runs INSIDE the EXECUTE branch (post-adjudication). All mutations
// are now reachable only via `EXECUTE` decisions from the kernel.

import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { buildEnvelope } from "@adjudicate/core";
import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createOrderCommandService,
  createOrderEventLogService,
  createOrderQueryService,
  createPaymentCommandService,
  createPaymentQueryService,
  prisma,
  type PaymentRefundIssuePayload,
  type PaymentStatusTransitionPayload,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import {
  PaymentStatus,
  type PaymentStatusChangedEvent,
} from "@ibatexas/types";
import { requireStaff, requireManagerRole } from "../../middleware/staff-auth.js";
import { staffRoleGuard } from "../../claustrum/staff-role-guard.js";
import {
  createAdminConfirmationStore,
  type PendingAdminAction,
} from "./admin-confirmation-store.js";
import {
  actorFor,
  adjudicateAdminNote,
  buildAdminTransitionEnvelope,
  consumeAndGateAdminAction,
  kernelRefusalText,
  logStaleVersionRefusal,
  principalFor,
  refuseTransitionWithLog,
  resolveActorRole,
  type StaffActorRole,
} from "./_shared-actions.js";

const OrderIdParams = z.object({ id: z.string().min(1) });

// P2-AUTH-REFUNDATTR — synthetic actor stamped on a money action (refund /
// confirm-cash) reached via the bare ADMIN_API_KEY path rather than a staff JWT
// (requireManagerRole / requireStaff pass the API-key path through, so
// request.staffId is undefined there). Stamping an explicit sentinel guarantees
// the money-action row (paymentStatusHistory.actorId) + event log are never
// blank-attributed. Fixed identity marker, not config — so a constant here.
const API_KEY_ACTOR_ID = "api-key:admin";

const ConfirmationBody = z.object({
  confirmationId: z.string().min(1).max(64),
});

/**
 * Refund threshold. Operations at or above this require the two-step
 * confirmation receipt protocol. Below the threshold, refunds EXECUTE
 * directly (the envelope path still adjudicates — only the operator
 * receipt step is skipped).
 *
 * R$ 200,00 = 20.000 centavos (CLAUDE.md rule #2 — integer centavos).
 */
export const REFUND_CONFIRMATION_THRESHOLD_CENTAVOS = 20_000;

/**
 * W3 P1-I — refund drip cap (audit remediation).
 *
 * Sub-threshold refunds (< REFUND_CONFIRMATION_THRESHOLD_CENTAVOS) skip
 * the two-step receipt by design. An insider could drip 100 × R$199 ≈
 * R$19,900 in a single day with no aggregate gate. Per security audit
 * §C5, this is a session-window exposure.
 *
 * The cap is applied per-staff-day. Each refund EXECUTE increments a
 * Redis counter keyed by `refund:daily-total:{staffId}:{YYYY-MM-DD}`
 * with a 25-hour TTL. Before allowing a sub-threshold refund to
 * direct-execute, the cumulative sum (existing + this) is checked
 * against the cap. If exceeded, the route falls back to the two-step
 * receipt protocol (operator-UX gate).
 *
 * Env override `REFUND_DAILY_NO_CONFIRM_CAP_CENTAVOS`. Default R$2000.
 *
 * The API-key path uses sessionId `"api-key"` so all API-key refunds
 * share a single bucket — a leaked key is treated as a single actor.
 */
function getRefundDailyNoConfirmCapCentavos(): number {
  const raw = process.env["REFUND_DAILY_NO_CONFIRM_CAP_CENTAVOS"];
  if (!raw) return 200_000; // R$2000
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 200_000;
  return n;
}

const REFUND_DAILY_KEY_TTL_SECONDS = 25 * 60 * 60; // 25h to cover DST + clock skew

// ── P0-7 (audit-2026-05-24) — deterministic idempotency-key helpers ────────
//
// Admin financial mutations (refund, force-status, etc.) MUST dedupe on
// retry. Helpers SHA-256 a route-derived idempotency key into the
// envelope's `nonce` and accept an `Idempotency-Key` HTTP header
// override (industry standard, e.g. Stripe).
function deriveAdminNonce(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

/**
 * Normalize the `Idempotency-Key` header (single string, repeated-header
 * array, or absent) to one non-empty key or `null`. Extracted to keep the
 * refund route handler's cognitive complexity bounded.
 */
function normalizeIdempotencyKey(
  header: string | string[] | undefined,
): string | null {
  if (typeof header === "string" && header.length > 0) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  return null;
}

function refundDailyBucketKey(staffId: string | null, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const day = `${yyyy}-${mm}-${dd}`;
  const actor = staffId ?? "api-key";
  return rk(`refund:daily-total:${actor}:${day}`);
}

/**
 * P1-I-TRUE — Atomic check-and-increment for the refund drip cap.
 *
 * Pre-fix (P1-I): the cap was checked in three steps —
 *   1. GET current → 2. compute projected → 3. (much later) INCRBY.
 * Five concurrent refunds at R$1900 with cap R$2000 ALL read
 * currentTotal=0, ALL passed the check, ALL incremented — cap bypassed
 * by ~5x. Confirmed by audit 03 R4.
 *
 * Post-fix: a single Lua eval performs the check + increment + TTL
 * extension atomically on the Redis server, in one round trip. The
 * client sees either {kind: "allowed", new_total} or
 * {kind: "cap_exceeded", current_total}; no read-then-write window.
 */
const REFUND_CAP_CHECK_AND_INCR_LUA = `
  local key = KEYS[1]
  local amount = tonumber(ARGV[1])
  local cap = tonumber(ARGV[2])
  local ttl = tonumber(ARGV[3])
  local current = tonumber(redis.call("GET", key)) or 0
  if current + amount > cap then
    return {0, current}
  end
  local new_total = redis.call("INCRBY", key, amount)
  redis.call("EXPIRE", key, ttl)
  return {1, new_total}
`;

export type RefundReservationResult =
  | { readonly kind: "allowed"; readonly newTotal: number }
  | { readonly kind: "cap_exceeded"; readonly currentTotal: number };

/**
 * Atomically attempt to reserve `centavos` against the staff/day refund
 * cap. Returns `{kind: "allowed", newTotal}` if accepted; otherwise
 * `{kind: "cap_exceeded", currentTotal}` and the counter is NOT
 * incremented.
 *
 * Exported for testing.
 */
export async function tryReserveDailyRefund(
  staffId: string | null,
  centavos: number,
  capCentavos: number,
): Promise<RefundReservationResult> {
  const redis = await getRedisClient();
  const key = refundDailyBucketKey(staffId);
  const raw = (await (
    redis as unknown as {
      eval: (
        script: string,
        options: { keys: string[]; arguments: string[] },
      ) => Promise<unknown>;
    }
  ).eval(REFUND_CAP_CHECK_AND_INCR_LUA, {
    keys: [key],
    arguments: [
      String(centavos),
      String(capCentavos),
      String(REFUND_DAILY_KEY_TTL_SECONDS),
    ],
  })) as unknown;
  // node-redis returns Lua table as array; some shims may return
  // object-with-numeric-keys. Normalize.
  const arr = Array.isArray(raw)
    ? raw
    : [
        (raw as { 0: number })?.[0],
        (raw as { 1: number })?.[1],
      ];
  const flag = Number(arr[0]);
  const total = Number(arr[1]);
  if (flag === 1) {
    return { kind: "allowed", newTotal: total };
  }
  return { kind: "cap_exceeded", currentTotal: total };
}

/**
 * Best-effort rollback for the rare case where the kernel REFUSEs after
 * we reserved the slot. Symmetric with tryReserveDailyRefund — DECR by
 * the same amount. Failures are non-fatal; the counter self-heals at
 * the 25h TTL.
 */
async function rollbackDailyRefundReservation(
  staffId: string | null,
  centavos: number,
): Promise<void> {
  const redis = await getRedisClient();
  const key = refundDailyBucketKey(staffId);
  await redis.decrBy(key, centavos).catch(() => {});
}

/**
 * pt-BR refusal copy when the drip cap forces a sub-threshold refund
 * into the two-step receipt protocol. Returned in the 202 body so the
 * operator UI knows to render the confirmation prompt.
 */
const REFUND_DRIP_CAP_PT_BR =
  "Limite diário de reembolsos sem confirmação atingido. Esta operação requer confirmação de outro operador.";

export async function adminPaymentRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  // Defer audit-sink resolution to onReady. Plugin bodies execute during
  // await server.register() inside buildServer(), which runs BEFORE
  // bootstrapAuditSinkDI() in index.ts:start(). Calling getAuditSink()
  // here would throw AuditSinkNotInitializedError and crash production
  // boot. onReady fires during server.ready() (invoked implicitly by
  // server.listen()), which is AFTER bootstrapAuditSinkDI() has run —
  // the sink is initialized by then. Tests masked this previously
  // because apps/api/src/__tests__/setup.ts pre-wires noop deps at
  // module load.
  let paymentCmdSvc!: ReturnType<typeof createPaymentCommandService>;
  let orderCmdSvc!: ReturnType<typeof createOrderCommandService>;
  server.addHook("onReady", async () => {
    // BKL-074: inject the kernel-level staff-role backstop into both command
    // services (payment + the note-path order service). `staffRoleGuard` is
    // inert for non-`admin:` envelopes, so it REFUSES a mis-scoped staff role
    // at the kernel without touching system/customer/agent mutations.
    paymentCmdSvc = createPaymentCommandService(server.log, {
      auditSink: getAuditSink(),
      authGuards: [staffRoleGuard],
    });
    // W7-P4: addNoteFromEnvelope path needs an audit-wired OrderCommandService.
    orderCmdSvc = createOrderCommandService(server.log, {
      auditSink: getAuditSink(),
      authGuards: [staffRoleGuard],
    });
  });
  const paymentQuerySvc = createPaymentQueryService();
  const orderQuerySvc = createOrderQueryService();
  const eventLogSvc = createOrderEventLogService(server.log);
  const confirmationStore = createAdminConfirmationStore();

  // Behavior-preserving extraction of the order-existence + active-payment
  // load (404 on either miss) duplicated byte-for-byte between the
  // refund/confirm and force-status/confirm step-2 handlers. `getById`
  // validates the order exists (404 "Pedido não encontrado.") then
  // `getActiveByOrderId` loads the active payment (404 "Nenhum pagamento
  // ativo encontrado.") — same await ordering, no `.catch`, same codes /
  // messages. The order row itself is not returned: both call sites only
  // consume the active payment; the order load is purely an existence gate.
  async function loadOrderAndActivePayment(orderId: string): Promise<
    | {
        readonly ok: false;
        readonly code: number;
        readonly body: Record<string, unknown>;
      }
    | {
        readonly ok: true;
        readonly payment: NonNullable<
          Awaited<ReturnType<typeof paymentQuerySvc.getActiveByOrderId>>
        >;
      }
  > {
    const order = await orderQuerySvc.getById(orderId);
    if (!order) {
      return { ok: false, code: 404, body: { error: "Pedido não encontrado." } };
    }
    const payment = await paymentQuerySvc.getActiveByOrderId(orderId);
    if (!payment) {
      return {
        ok: false,
        code: 404,
        body: { error: "Nenhum pagamento ativo encontrado." },
      };
    }
    return { ok: true, payment };
  }

  // ── POST /api/admin/orders/:id/payment/confirm-cash ───────────────────────
  app.post(
    "/api/admin/orders/:id/payment/confirm-cash",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Confirmar recebimento de dinheiro",
        params: OrderIdParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const staffId = request.staffId ?? null;

      const payment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!payment) {
        return reply.code(404).send({ error: "Nenhum pagamento ativo encontrado." });
      }

      if (payment.method !== "cash") {
        return reply.code(422).send({ error: "Confirmação de dinheiro disponível apenas para pagamentos em dinheiro." });
      }

      if (payment.status !== "cash_pending") {
        return reply.code(422).send({
          error: "Pagamento não está aguardando confirmação de dinheiro.",
          currentStatus: payment.status,
        });
      }

      const { actorPrincipal, taint, sessionId, actorRole } = principalFor(
        staffId,
        resolveActorRole(request),
      );
      const payload: PaymentStatusTransitionPayload = {
        paymentId: payment.id,
        newStatus: PaymentStatus.PAID,
        actor: "admin",
        // P2-AUTH-REFUNDATTR: stamp the synthetic sentinel on the API-key path
        // (staffId undefined) so the money-action row is never blank-attributed.
        actorId: staffId ?? API_KEY_ACTOR_ID,
        // P2-CONC-CONFIRMVER: pin the version read above so a concurrent
        // transition (method switch, second attendant, webhook flip) is rejected
        // as a concurrency error instead of racing the X→X state-machine guard.
        expectedVersion: payment.version,
        reason: "Dinheiro confirmado pelo atendente",
      };
      const envelope = buildEnvelope<
        "payment.status.transition",
        PaymentStatusTransitionPayload
      >({
        kind: "payment.status.transition",
        payload,
        nonce: randomUUID(),
        actor: actorFor({ principal: actorPrincipal, sessionId, role: actorRole }),
        taint,
      });

      const outcome = await paymentCmdSvc.transitionStatusFromEnvelope(envelope);
      if (
        outcome.decision.kind !== "EXECUTE" &&
        outcome.decision.kind !== "REWRITE"
      ) {
        const refusalText = kernelRefusalText(outcome.decision);
        return reply.code(403).send({ error: refusalText });
      }
      const result = outcome.result!;

      await publishNatsEvent("payment.status_changed", {
        eventType: "payment.status_changed",
        orderId: id,
        paymentId: payment.id,
        previousStatus: "cash_pending",
        newStatus: PaymentStatus.PAID,
        method: "cash",
        version: result.version,
        timestamp: new Date().toISOString(),
      } satisfies PaymentStatusChangedEvent & { eventType: string });

      return reply.send({
        success: true,
        version: result.version,
        message: "Pagamento em dinheiro confirmado.",
      });
    },
  );

  // ── Refund execution helper — shared between direct-execute (low refund)
  //    and step-2 confirm path.
  //
  // ── W3 P0-1 (audit remediation) ──────────────────────────────────────
  //
  // The previous version of this helper adjudicated only the status
  // transition (`payment.status.transition`) and updated
  // `refundedAmountCentavos` via a direct `prisma.payment.update` AFTER
  // the kernel returned EXECUTE. The refund MAGNITUDE was never in the
  // envelope payload — the kernel signed off on the shape but not on
  // the amount. An attacker (or buggy code) could transition the
  // payment with a small status-decision basis and then write any
  // amount to the DB.
  //
  // The fix: route through `paymentCmdSvc.issueRefundFromEnvelope`,
  // which carries `refundAmountCentavos` + `refundableBalanceCentavos`
  // + `currentRefundedCentavos` in the envelope payload. The
  // `paymentProjectionPolicyBundle` magnitude guard refuses
  // out-of-balance / non-positive refunds, REQUEST_CONFIRMATION above
  // R$500, ESCALATE above R$1000. The executor performs the
  // `refundedAmountCentavos` update + status transition + history row
  // in a single Prisma `$transaction`. No more direct
  // `prisma.payment.update` outside the kernel-adjudicated path.
  async function executeRefund(args: {
    readonly orderId: string;
    readonly paymentId: string;
    readonly previousStatus: string;
    readonly method: string;
    readonly version: number;
    readonly refundedAmountCentavos: number;
    readonly amountInCentavos: number;
    readonly refundAmount: number;
    readonly reason: string;
    readonly staffId: string | null;
    readonly nonce: string;
    readonly actorPrincipal: "user" | "system";
    readonly taint: "TRUSTED" | "SYSTEM";
    readonly sessionId: string;
    /** Executing operator's adopter role (WS7 / BKL-069) — absent stays absent. */
    readonly actorRole?: StaffActorRole;
    readonly confirmationId?: string;
  }) {
    const refundableBalance =
      args.amountInCentavos - args.refundedAmountCentavos;

    const payload: PaymentRefundIssuePayload = {
      paymentId: args.paymentId,
      refundAmountCentavos: args.refundAmount,
      refundableBalanceCentavos: refundableBalance,
      amountInCentavos: args.amountInCentavos,
      currentRefundedCentavos: args.refundedAmountCentavos,
      actor: args.actorPrincipal === "system" ? "system" : "admin",
      // P2-AUTH-REFUNDATTR: refund is reachable via the bare ADMIN_API_KEY path
      // (requireManagerRole passes it through when there is no staff JWT), where
      // args.staffId is null. Fall back to the synthetic sentinel so this money
      // action's paymentStatusHistory.actorId + event log are never blank. A
      // real staff JWT still attributes to that staff.
      actorId: args.staffId ?? API_KEY_ACTOR_ID,
      reason: args.reason,
    };
    const envelope = buildEnvelope<
      "payment.refund.issue",
      PaymentRefundIssuePayload
    >({
      kind: "payment.refund.issue",
      payload,
      nonce: args.nonce,
      actor: actorFor({
        principal: args.actorPrincipal,
        sessionId: args.sessionId,
        role: args.actorRole,
      }),
      taint: args.taint,
    });

    const outcome = await paymentCmdSvc.issueRefundFromEnvelope(envelope);
    if (
      outcome.decision.kind !== "EXECUTE" &&
      outcome.decision.kind !== "REWRITE"
    ) {
      return {
        kind: "refused" as const,
        decision: outcome.decision,
        intentHash: envelope.intentHash,
      };
    }
    const result = outcome.result!;

    // P1-I-TRUE — counter increment is performed ATOMICALLY at the cap
    // check (tryReserveDailyRefund) for sub-threshold refunds. The
    // step-2 receipt path enters here without a reservation, so we
    // increment defensively (with no cap check — step-2 is already
    // operator-gated). The pre-fix code incremented HERE for all paths,
    // which was the source of the TOCTOU race confirmed by audit 03 R4.

    await publishNatsEvent("payment.status_changed", {
      eventType: "payment.status_changed",
      orderId: args.orderId,
      paymentId: args.paymentId,
      previousStatus: args.previousStatus,
      newStatus: result.newStatus,
      method: args.method,
      version: result.version,
      timestamp: new Date().toISOString(),
    } satisfies PaymentStatusChangedEvent & { eventType: string });

    await eventLogSvc.append({
      orderId: args.orderId,
      eventType: "admin.refund.executed",
      discriminator: args.confirmationId ?? `direct:${args.nonce}`,
      payload: {
        confirmationId: args.confirmationId ?? null,
        staffId: args.staffId,
        paymentId: args.paymentId,
        refundAmountCentavos: result.refundAmountCentavos,
        totalRefunded: result.totalRefundedCentavos,
        newStatus: result.newStatus,
        intentHash: envelope.intentHash,
        decision: outcome.decision.kind,
        version: result.version,
      },
      timestamp: new Date(),
    });

    return {
      kind: "executed" as const,
      version: result.version,
      refundAmount: result.refundAmountCentavos,
      totalRefunded: result.totalRefundedCentavos,
      newStatus: result.newStatus,
      intentHash: envelope.intentHash,
    };
  }

  // ── Shared refusal-reply helpers ─────────────────────────────────────
  //
  // The refund step-1 / step-2 routes and the force-status step-2 route
  // each map a non-EXECUTE kernel decision onto an HTTP reply with the
  // same body shape. Extracting these keeps each route handler's
  // cognitive complexity bounded while preserving the exact responses.
  type RefundRefusedDecision = Extract<
    Awaited<ReturnType<typeof executeRefund>>,
    { kind: "refused" }
  >["decision"];

  function replyRefundRefused(
    reply: FastifyReply,
    decision: RefundRefusedDecision,
    opts: {
      readonly requestConfirmationError: string;
      readonly confirmationId?: string;
    },
  ) {
    const idPart =
      opts.confirmationId === undefined
        ? {}
        : { confirmationId: opts.confirmationId };
    if (decision.kind === "ESCALATE") {
      return reply.code(503).send({
        error: "Reembolso acima do limite — requer aprovação humana.",
        reason: decision.reason,
        ...idPart,
      });
    }
    if (decision.kind === "REQUEST_CONFIRMATION") {
      return reply.code(202).send({
        error: opts.requestConfirmationError,
        prompt: decision.prompt,
        code: "REQUEST_CONFIRMATION",
        ...idPart,
      });
    }
    return reply.code(403).send({ error: kernelRefusalText(decision) });
  }

  async function replyForceStatusConcurrency(
    err: unknown,
    reply: FastifyReply,
    ctx: {
      readonly orderId: string;
      readonly confirmationId: string;
      readonly staffId: string | null;
      readonly expectedVersion: number | null;
    },
  ) {
    if ((err as Error).name !== "PaymentConcurrencyError") throw err;
    return logStaleVersionRefusal({
      eventLogSvc,
      reply,
      orderId: ctx.orderId,
      confirmationId: ctx.confirmationId,
      staffId: ctx.staffId,
      eventType: "admin.force_status.stale_version_refused",
      expectedVersion: ctx.expectedVersion,
      message: (err as Error).message,
    });
  }

  // ── POST /api/admin/orders/:id/payment/refund (step 1) ────────────────────
  app.post(
    "/api/admin/orders/:id/payment/refund",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Emitir reembolso — etapa 1 (MANAGER+)",
        params: OrderIdParams,
        body: z.object({
          amountInCentavos: z.number().int().min(1).optional(), // omit for full refund
          reason: z.string().max(500).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const staffId = request.staffId ?? null;
      const staffRole = request.staffRole ?? null;

      const payment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!payment) {
        return reply.code(404).send({ error: "Nenhum pagamento ativo encontrado." });
      }

      const refundableStatuses = [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] as string[];
      if (!refundableStatuses.includes(payment.status)) {
        return reply.code(422).send({
          error: "Pagamento não está em estado que permite reembolso.",
          currentStatus: payment.status,
        });
      }

      const refundAmount = request.body.amountInCentavos ?? payment.amountInCentavos;
      const refundableAmount = payment.amountInCentavos - (payment.refundedAmountCentavos ?? 0);

      if (refundAmount > refundableAmount) {
        return reply.code(422).send({
          error: "Valor de reembolso excede o saldo reembolsável.",
          code: "OVER_REFUND",
          maxRefundable: refundableAmount,
        });
      }

      const reason = request.body.reason ?? "Reembolso emitido pelo admin";
      const { actorPrincipal, taint, sessionId } = principalFor(staffId);

      // ── P0-7 (audit-2026-05-24) + I10 (audit-2026-05-25) — explicit
      // Idempotency-Key required ─────────────────────────────────────────
      //
      // Refunds send money back to the customer — a retry without dedup
      // can double-pay. Pre-fix the route allowed a deterministic
      // fallback `${id}:refund:${refundAmount}:${staffId}` when no
      // header was supplied. PR #62 review found that fallback
      // collides for two LEGITIMATE sequential partial refunds of the
      // same amount on the same order by the same staff within the
      // Execution Ledger's 14-day default TTL: the second refund's
      // intentHash matches the first, the ledger SETNX returns
      // "exists", the kernel flips EXECUTE → REPLAY_SUPPRESSED, the
      // route returns 200 but no Stripe money movement happens. The
      // customer never receives the second refund.
      //
      // Fix: require the `Idempotency-Key` header on every refund.
      // Admin tooling should already be idempotency-aware; absence is
      // a client bug worth surfacing as 400 rather than masking with a
      // collision-prone fallback.
      const idempotencyHeader = request.headers["idempotency-key"];
      const normalizedHeader = normalizeIdempotencyKey(idempotencyHeader);
      if (normalizedHeader === null) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message:
            "Idempotency-Key header obrigatório no reembolso para garantir dedup seguro. Cada refund-click deve enviar um UUID estável (mesmo valor em retries automatizadas).",
        });
      }
      const refundIdempotencyKey = normalizedHeader;
      const refundNonce = deriveAdminNonce(refundIdempotencyKey);

      // ── Threshold branch ──────────────────────────────────────────
      if (refundAmount < REFUND_CONFIRMATION_THRESHOLD_CENTAVOS) {
        // P1-I-TRUE — atomic check-and-reserve for the daily drip cap.
        //
        // Pre-fix (P1-I, audit 03 R4): the daily counter was read, the
        // projected total computed, the refund executed, and THEN the
        // counter incremented. N concurrent refunds at cap-1 all read the
        // same starting value and all passed the check — cap bypassed by
        // ~N×. Confirmed exploitable in concurrent burst tests.
        //
        // Post-fix: tryReserveDailyRefund performs GET + check + INCRBY +
        // EXPIRE in a single Lua eval. Either the slot is reserved
        // (counter is already incremented; refund may execute) or the
        // cap-exceeded path runs (counter untouched; route to step-2).
        // No read-then-write window survives.
        const dailyCap = getRefundDailyNoConfirmCapCentavos();
        let reservation: RefundReservationResult;
        try {
          reservation = await tryReserveDailyRefund(
            staffId,
            refundAmount,
            dailyCap,
          );
        } catch (err) {
          // Fail-CLOSED on Lua/Redis errors. The two-step receipt path
          // already exists for high-value refunds; falling back to it on
          // counter unavailability is safe (operator-UX gate). Better
          // than the pre-fix behavior which defaulted to 0 and executed
          // unbounded refunds during a Redis outage.
          server.log.error(
            { err: (err as Error).message, staffId },
            "[refund-drip-cap] tryReserveDailyRefund failed — fail-CLOSED to step-2 receipt",
          );
          reservation = { kind: "cap_exceeded", currentTotal: 0 };
        }
        if (reservation.kind === "cap_exceeded") {
          // Drip cap exceeded — escalate to step-2 receipt protocol.
          // The counter is NOT incremented (atomic guarantee).
          const currentDailyTotal = reservation.currentTotal;
          const projectedTotal = currentDailyTotal + refundAmount;
          const pending: PendingAdminAction = {
            kind: "payment.status.transition",
            payload: {
              paymentId: payment.id,
              previousStatus: payment.status,
              method: payment.method,
              refundedAmountCentavos: payment.refundedAmountCentavos ?? 0,
              amountInCentavos: payment.amountInCentavos,
              refundAmount,
              reason,
            },
            // P0-7 — deterministic nonce, see route-level derivation above.
            nonce: refundNonce,
            staffId,
            staffRole,
            actorPrincipal,
            requestorIp: request.ip ?? null,
            prompt: `${REFUND_DRIP_CAP_PT_BR} Reembolso de R$ ${(refundAmount / 100).toFixed(2).replace(".", ",")}.`,
            route: "refund",
            createdAt: new Date().toISOString(),
            orderId: id,
            refundAmountCentavos: refundAmount,
            reason,
            // audit-2026-05-24 P2-5: snapshot at step 1. Refund uses its
            // own payload schema (PaymentRefundIssuePayload, no
            // expectedVersion field) — step 2 enforces this via a
            // route-level guard.
            expectedVersion: payment.version,
          };

          const { confirmationId, ttlSeconds } =
            await confirmationStore.create(pending);

          await eventLogSvc.append({
            orderId: id,
            eventType: "admin.refund.drip_cap_exceeded",
            discriminator: confirmationId,
            payload: {
              confirmationId,
              staffId,
              staffRole,
              paymentId: payment.id,
              refundAmountCentavos: refundAmount,
              currentDailyTotal,
              dailyCap,
              projectedTotal,
              intentNonce: pending.nonce,
            },
            timestamp: new Date(),
          });

          return reply.code(202).send({
            confirmationId,
            prompt: pending.prompt,
            ttlSeconds,
            kind: pending.kind,
            refundAmountCentavos: refundAmount,
            code: "REFUND_DRIP_CAP",
            cumulativeTodayCentavos: currentDailyTotal,
            dailyCapCentavos: dailyCap,
          });
        }

        // Slot reserved atomically. Direct execute — envelope path still
        // adjudicates. If the kernel REFUSEs the magnitude check, rollback
        // the atomic reservation so the bucket doesn't accumulate failed
        // reservations.
        const result = await executeRefund({
          orderId: id,
          paymentId: payment.id,
          previousStatus: payment.status,
          method: payment.method,
          version: payment.version,
          refundedAmountCentavos: payment.refundedAmountCentavos ?? 0,
          amountInCentavos: payment.amountInCentavos,
          refundAmount,
          reason,
          staffId,
          // P0-7 — deterministic nonce, see route-level derivation above.
          nonce: refundNonce,
          actorPrincipal,
          taint,
          sessionId,
          actorRole: resolveActorRole(request),
        });
        if (result.kind === "refused") {
          // Rollback the atomic reservation since the refund didn't
          // execute. Best-effort — failure here means the next refund
          // sees a slightly-inflated counter, which is the safe side.
          await rollbackDailyRefundReservation(staffId, refundAmount);
          // W3 P0-1 — surface the kernel's magnitude-decision distinctly.
          return replyRefundRefused(reply, result.decision, {
            requestConfirmationError:
              "Reembolso requer confirmação de segundo operador.",
          });
        }
        return reply.send({
          success: true,
          version: result.version,
          refundedAmount: result.refundAmount,
          totalRefunded: result.totalRefunded,
          newStatus: result.newStatus,
        });
      }

      // ── Above threshold — request confirmation ─────────────────────
      const pending: PendingAdminAction = {
        kind: "payment.status.transition",
        payload: {
          paymentId: payment.id,
          previousStatus: payment.status,
          method: payment.method,
          refundedAmountCentavos: payment.refundedAmountCentavos ?? 0,
          amountInCentavos: payment.amountInCentavos,
          refundAmount,
          reason,
        },
        // P0-7 — deterministic nonce, see route-level derivation above.
        nonce: refundNonce,
        staffId,
        staffRole,
        actorPrincipal,
        requestorIp: request.ip ?? null,
        prompt: `Reembolso de R$ ${(refundAmount / 100).toFixed(2).replace(".", ",")}. Esta ação envia dinheiro de volta ao cliente. Confirma?`,
        route: "refund",
        createdAt: new Date().toISOString(),
        orderId: id,
        refundAmountCentavos: refundAmount,
        reason,
        // audit-2026-05-24 P2-5: snapshot at step 1. Step 2 enforces this
        // via a route-level guard (refund's PaymentRefundIssuePayload
        // doesn't carry `expectedVersion`).
        expectedVersion: payment.version,
      };

      const { confirmationId, ttlSeconds } =
        await confirmationStore.create(pending);

      await eventLogSvc.append({
        orderId: id,
        eventType: "admin.refund.requested",
        discriminator: confirmationId,
        payload: {
          confirmationId,
          staffId,
          staffRole,
          paymentId: payment.id,
          refundAmountCentavos: refundAmount,
          reason,
          intentNonce: pending.nonce,
        },
        timestamp: new Date(),
      });

      return reply.code(202).send({
        confirmationId,
        prompt: pending.prompt,
        ttlSeconds,
        kind: pending.kind,
        refundAmountCentavos: refundAmount,
      });
    },
  );

  // ── POST /api/admin/orders/:id/payment/refund/confirm (step 2) ─────────────
  app.post(
    "/api/admin/orders/:id/payment/refund/confirm",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Emitir reembolso — etapa 2 (MANAGER+)",
        params: OrderIdParams,
        body: ConfirmationBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { confirmationId } = request.body;
      const staffId = request.staffId ?? null;

      // Two-person separation-of-duty + receipt validity gate. Each refusal
      // kind (missing / null_staff / actor_type_mismatch / same_actor /
      // wrong-route) emits its own audit entry inside the helper; P0-5 /
      // P0-5-TRUE rules are unchanged. P0-5: refund is a money path — a
      // different operator must confirm.
      const gate = await consumeAndGateAdminAction({
        confirmationStore,
        eventLogSvc,
        confirmationId,
        orderId: id,
        staffId,
        eventPrefix: "admin.refund",
        expectedRoute: "refund",
      });
      if (!gate.ok) {
        return reply.code(gate.code).send({ error: gate.error });
      }
      const pending = gate.pending;

      const loaded = await loadOrderAndActivePayment(id);
      if (!loaded.ok) {
        return reply.code(loaded.code).send(loaded.body);
      }
      const payment = loaded.payment;

      const stored = pending.payload as unknown as {
        readonly paymentId: string;
        readonly previousStatus: string;
        readonly method: string;
        readonly refundedAmountCentavos: number;
        readonly amountInCentavos: number;
        readonly refundAmount: number;
        readonly reason: string;
      };

      if (stored.paymentId !== payment.id) {
        return reply.code(409).send({
          error: "Pagamento ativo divergente. Reabra a operação.",
        });
      }
      // audit-2026-05-24 P2-5: optimistic-concurrency check.
      // PaymentRefundIssuePayload doesn't carry `expectedVersion`, so we
      // enforce it at the route boundary: if the payment.version has
      // advanced since step 1, REFUSE with 409. The operator must
      // restart from step 1 so the fresh snapshot of
      // refundedAmountCentavos / amountInCentavos / status is captured.
      // audit-2026-05-25 (I10): fail-CLOSED when expectedVersion is
      // undefined. Pre-fix this branch only fired when expectedVersion
      // was DEFINED — in-flight receipts created BEFORE the P2-5 deploy
      // lack the field, and any such stale receipt that survives a
      // rolling deploy could execute a stale-version refund (the exact
      // race P2-5 closes for fresh receipts). Now any receipt without
      // expectedVersion is rejected; the operator restarts from step 1.
      if (pending.expectedVersion === undefined) {
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.refund.missing_expected_version_refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            actualVersion: payment.version,
          },
          timestamp: new Date(),
        });
        return reply.code(409).send({
          error:
            "Aprovação inválida (criada antes da atualização de segurança). Reabra a operação para gerar uma nova aprovação.",
        });
      }
      if (payment.version !== pending.expectedVersion) {
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.refund.stale_version_refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            expectedVersion: pending.expectedVersion,
            actualVersion: payment.version,
          },
          timestamp: new Date(),
        });
        return reply.code(409).send({
          error: "Pagamento foi atualizado por outro atendente após a aprovação. Reabra a operação.",
        });
      }
      // Re-validate refundable amount (someone else may have refunded
      // partially between step 1 and step 2).
      const currentRefundable =
        payment.amountInCentavos - (payment.refundedAmountCentavos ?? 0);
      if (stored.refundAmount > currentRefundable) {
        return reply.code(422).send({
          error: "Valor de reembolso excede o saldo reembolsável.",
          code: "OVER_REFUND",
          maxRefundable: currentRefundable,
        });
      }

      const refundableStatuses = [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] as string[];
      if (!refundableStatuses.includes(payment.status)) {
        return reply.code(422).send({
          error: "Pagamento não está em estado que permite reembolso.",
          currentStatus: payment.status,
        });
      }

      const { actorPrincipal, taint, sessionId, actorRole } = principalFor(
        staffId,
        resolveActorRole(request),
      );
      const result = await executeRefund({
        orderId: id,
        paymentId: payment.id,
        previousStatus: payment.status,
        method: payment.method,
        version: payment.version,
        refundedAmountCentavos: payment.refundedAmountCentavos ?? 0,
        amountInCentavos: payment.amountInCentavos,
        refundAmount: stored.refundAmount,
        reason: stored.reason,
        staffId,
        nonce: pending.nonce,
        actorPrincipal,
        taint,
        sessionId,
        // Confirm-time role governs — the confirming operator's role at step 2.
        actorRole,
        confirmationId,
      });
      if (result.kind === "refused") {
        // W3 P0-1 — kernel magnitude ladder may bubble up here.
        // ESCALATE (>R$1000) is terminal; REQUEST_CONFIRMATION on the
        // step-2 path means the kernel still considers magnitude-confirm
        // unresolved (the route's operator-receipt is a separate gate
        // and doesn't satisfy the kernel's adjudicateAndAuditDeps
        // receipt slot — Wave 5 will bridge these). Surface both as
        // distinct status codes so the admin UI doesn't silently
        // execute on a wrong-shape decision.
        await eventLogSvc.append({
          orderId: id,
          eventType: "admin.refund.refused",
          discriminator: confirmationId,
          payload: {
            confirmationId,
            staffId,
            decision: result.decision.kind,
            intentHash: result.intentHash,
          },
          timestamp: new Date(),
        });
        return replyRefundRefused(reply, result.decision, {
          requestConfirmationError:
            "Reembolso requer confirmação adicional do kernel.",
          confirmationId,
        });
      }

      return reply.send({
        success: true,
        version: result.version,
        refundedAmount: result.refundAmount,
        totalRefunded: result.totalRefunded,
        newStatus: result.newStatus,
        confirmationId,
      });
    },
  );

  // ── PATCH /api/admin/orders/:id/payment/status (step 1) ────────────────────
  app.patch(
    "/api/admin/orders/:id/payment/status",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Forçar status de pagamento — etapa 1 (OWNER)",
        params: OrderIdParams,
        body: z.object({
          status: z.enum([
            "awaiting_payment",
            "payment_pending",
            "payment_expired",
            "payment_failed",
            "cash_pending",
            "paid",
            "switching_method",
            "partially_refunded",
            "refunded",
            "disputed",
            "canceled",
            "waived",
          ]),
          reason: z.string().max(500),
        }),
      },
    },
    async (request, reply) => {
      // OWNER-only gate — preserved.
      if (request.staffRole !== "OWNER") {
        return reply.code(403).send({ error: "Acesso restrito ao proprietário." });
      }

      const { id } = request.params;
      const staffId = request.staffId ?? null;
      const staffRole = request.staffRole ?? null;

      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }

      const payment = await paymentQuerySvc.getActiveByOrderId(id);
      if (!payment) {
        return reply.code(404).send({ error: "Nenhum pagamento ativo encontrado." });
      }

      const { actorPrincipal } = principalFor(staffId);
      // audit-2026-05-24 P2-5: snapshot `payment.version` at step 1.
      const expectedVersion = payment.version;
      const payload: PaymentStatusTransitionPayload = {
        paymentId: payment.id,
        newStatus: request.body.status,
        actor: "admin",
        ...(staffId ? { actorId: staffId } : {}),
        reason: request.body.reason,
      };
      const pending: PendingAdminAction = {
        kind: "payment.status.transition",
        payload: payload as unknown as Record<string, unknown>,
        nonce: randomUUID(),
        staffId,
        staffRole,
        actorPrincipal,
        requestorIp: request.ip ?? null,
        prompt: `Forçar status de pagamento para "${request.body.status}". Esta ação ignora a máquina de estados normal. Confirma?`,
        route: "force-status",
        createdAt: new Date().toISOString(),
        orderId: id,
        reason: request.body.reason,
        expectedVersion,
      };

      const { confirmationId, ttlSeconds } =
        await confirmationStore.create(pending);

      await eventLogSvc.append({
        orderId: id,
        eventType: "admin.force_status.requested",
        discriminator: confirmationId,
        payload: {
          confirmationId,
          staffId,
          staffRole,
          paymentId: payment.id,
          targetStatus: request.body.status,
          currentStatus: payment.status,
          reason: request.body.reason,
          intentNonce: pending.nonce,
        },
        timestamp: new Date(),
      });

      return reply.code(202).send({
        confirmationId,
        prompt: pending.prompt,
        ttlSeconds,
        kind: pending.kind,
        targetStatus: request.body.status,
      });
    },
  );

  // ── POST /api/admin/orders/:id/payment/status/confirm (step 2) ────────────
  app.post(
    "/api/admin/orders/:id/payment/status/confirm",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Forçar status de pagamento — etapa 2 (OWNER)",
        params: OrderIdParams,
        body: ConfirmationBody,
      },
    },
    async (request, reply) => {
      if (request.staffRole !== "OWNER") {
        return reply.code(403).send({ error: "Acesso restrito ao proprietário." });
      }

      const { id } = request.params;
      const { confirmationId } = request.body;
      const staffId = request.staffId ?? null;

      // Two-person separation-of-duty + receipt validity gate. Each refusal
      // kind emits its own audit entry inside the helper; P0-5 / P0-5-TRUE
      // rules are unchanged. P0-5: force-status is OWNER-only but still
      // requires a second operator to confirm step 2 — a single owner
      // double-clicking does not satisfy separation-of-duty.
      const gate = await consumeAndGateAdminAction({
        confirmationStore,
        eventLogSvc,
        confirmationId,
        orderId: id,
        staffId,
        eventPrefix: "admin.force_status",
        expectedRoute: "force-status",
      });
      if (!gate.ok) {
        return reply.code(gate.code).send({ error: gate.error });
      }
      const pending = gate.pending;

      const loaded = await loadOrderAndActivePayment(id);
      if (!loaded.ok) {
        return reply.code(loaded.code).send(loaded.body);
      }
      const payment = loaded.payment;

      const storedPayload = pending.payload as unknown as PaymentStatusTransitionPayload;
      if (storedPayload.paymentId !== payment.id) {
        return reply.code(409).send({
          error: "Pagamento ativo divergente. Reabra a operação.",
        });
      }

      // audit-2026-05-24 P2-5: the step-1 version is threaded into the
      // envelope payload (inside buildAdminTransitionEnvelope). The executor
      // REFUSEs (PaymentConcurrencyError) if the payment was mutated between
      // the two operator clicks.
      // Confirm-time role governs — the confirming operator's role at step 2.
      const { envelope } = buildAdminTransitionEnvelope<
        "payment.status.transition",
        PaymentStatusTransitionPayload
      >({
        pending,
        staffId,
        kind: "payment.status.transition",
        actorRole: resolveActorRole(request),
      });

      let outcome;
      try {
        outcome = await paymentCmdSvc.transitionStatusFromEnvelope(envelope);
      } catch (err) {
        // audit-2026-05-24 P2-5: optimistic-concurrency conflict — payment
        // advanced between step 1 and step 2.
        return await replyForceStatusConcurrency(err, reply, {
          orderId: id,
          confirmationId,
          staffId,
          expectedVersion: pending.expectedVersion ?? null,
        });
      }
      if (
        outcome.decision.kind !== "EXECUTE" &&
        outcome.decision.kind !== "REWRITE"
      ) {
        return refuseTransitionWithLog({
          eventLogSvc,
          reply,
          orderId: id,
          confirmationId,
          staffId,
          eventType: "admin.force_status.refused",
          decisionKind: outcome.decision.kind,
          intentHash: envelope.intentHash,
          refusalText: kernelRefusalText(outcome.decision),
        });
      }
      const result = outcome.result!;

      await publishNatsEvent("payment.status_changed", {
        eventType: "payment.status_changed",
        orderId: id,
        paymentId: payment.id,
        previousStatus: result.previousStatus,
        newStatus: result.newStatus,
        method: payment.method,
        version: result.version,
        timestamp: new Date().toISOString(),
      } satisfies PaymentStatusChangedEvent & { eventType: string });

      await eventLogSvc.append({
        orderId: id,
        eventType: "admin.force_status.executed",
        discriminator: confirmationId,
        payload: {
          confirmationId,
          staffId,
          staffRole: pending.staffRole,
          paymentId: payment.id,
          targetStatus: storedPayload.newStatus,
          intentHash: envelope.intentHash,
          decision: outcome.decision.kind,
          version: result.version,
        },
        timestamp: new Date(),
      });

      return reply.send({
        success: true,
        version: result.version,
        previousStatus: result.previousStatus,
        newStatus: result.newStatus,
        confirmationId,
      });
    },
  );

  // ── POST /api/admin/orders/:id/notes ──────────────────────────────────────
  app.post(
    "/api/admin/orders/:id/notes",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Adicionar nota administrativa",
        params: OrderIdParams,
        body: z.object({ content: z.string().min(1).max(500) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      // W7-P4: route the admin note through addNoteFromEnvelope so the
      // order.note.add intent is kernel-adjudicated and audit-emitted (see
      // adjudicateAdminNote in _shared-actions.ts).
      const order = await orderQuerySvc.getById(id);
      if (!order) {
        return reply.code(404).send({ error: "Pedido não encontrado." });
      }
      const staffId = request.staffId ?? null;
      const note = await adjudicateAdminNote({
        orderCmdSvc,
        order,
        orderId: id,
        staffId,
        content: request.body.content,
        actorRole: resolveActorRole(request),
      });

      if (note.kind === "refused") {
        const message = kernelRefusalText(
          note.decision,
          "Não foi possível adicionar a nota no momento.",
        );
        return reply.code(403).send({ error: message });
      }

      await publishNatsEvent("order.note_added", {
        eventType: "order.note_added",
        orderId: id,
        noteId: note.noteId,
        author: "admin",
        timestamp: new Date().toISOString(),
      });

      return reply.code(201).send({
        id: note.noteId,
        content: note.persisted?.content ?? request.body.content,
        createdAt:
          note.persisted?.createdAt?.toISOString() ?? new Date().toISOString(),
      });
    },
  );

  // ── GET /api/admin/orders/:id/notes ───────────────────────────────────────
  app.get(
    "/api/admin/orders/:id/notes",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Listar notas do pedido",
        params: OrderIdParams,
      },
    },
    async (request, reply) => {
      const notes = await prisma.orderNote.findMany({
        where: { orderId: request.params.id },
        orderBy: { createdAt: "asc" },
        take: 200,
      });

      return reply.send({
        notes: notes.map((n) => ({
          id: n.id,
          author: n.author,
          authorId: n.authorId,
          content: n.content,
          createdAt: n.createdAt.toISOString(),
        })),
      });
    },
  );

  // ── GET /api/admin/orders/:id/payments ────────────────────────────────────
  app.get(
    "/api/admin/orders/:id/payments",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Listar tentativas de pagamento",
        params: OrderIdParams,
      },
    },
    async (request, reply) => {
      const { payments, count } = await paymentQuerySvc.listByOrderId(request.params.id);

      return reply.send({
        payments: payments.map((p) => ({
          id: p.id,
          method: p.method,
          status: p.status,
          amountInCentavos: p.amountInCentavos,
          refundedAmountCentavos: p.refundedAmountCentavos,
          stripePaymentIntentId: p.stripePaymentIntentId,
          pixExpiresAt: p.pixExpiresAt?.toISOString() ?? null,
          regenerationCount: p.regenerationCount,
          version: p.version,
          createdAt: p.createdAt.toISOString(),
        })),
        count,
      });
    },
  );
}
