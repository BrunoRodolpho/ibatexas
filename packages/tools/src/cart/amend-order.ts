// amend_order tool — modify an existing order (add/remove/update items with PONR)
//
// Rules:
// - add: Always allowed unless order is in delivery
// - remove / update_qty: Subject to per-item AMEND_PONR window
// - Escalates to admin when PONR has expired
//
// ── W3 P0-3 (audit remediation) ────────────────────────────────────────
//
// The previous implementation chained five+ bypasses:
//   - Stripe PI create outside any envelope
//   - direct medusaAdmin POSTs to /admin/orders/:id, /edits, /edits/items,
//     /edits/confirm
//   - deprecated bare-arg `paymentCmdSvc.transitionStatus` + `.create`
//
// All writes now route through `medusaAdjudicated()` (Task 17 wrapper)
// or `paymentCmdSvc.*FromEnvelope` (Task 15 envelope surface). Stripe
// PI creation stays inside the IbateXas process but the resulting
// `stripePaymentIntentId` is now carried in the kernel-adjudicated
// `payment.create` envelope payload — the kernel signs off on the
// new Payment row and its association with the Stripe charge.
//
// Removed from `ALLOWED_MEDUSA_DIRECT` (bypass-detection.test.ts) in
// W3 P1-L. amend-order.ts no longer needs the carve-out.
//
// Wave 5 will fold the multi-envelope decomposition into a single
// composite `order.amend.batch` kind in pack-orders OR granular
// `order.amend.add_item` / `order.amend.update_qty` /
// `order.amend.remove_item` kinds. See
// `migration/remediation/W3-INTENT-GAPS.md`.

import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { AmendOrderInputSchema, NonRetryableError, canPerformAction, isTerminalPaymentStatus, type AmendOrderInput, type AmendOrderResult, type AgentContext, type CustomerAction, type OrderFulfillmentStatus, type PaymentStatus } from "@ibatexas/types";
import { buildEnvelope, type Decision } from "@adjudicate/core";
import { getAuditSink } from "@ibatexas/audit-sink";
import { createOrderQueryService, createPaymentQueryService, createPaymentCommandService, type OrderService, type PaymentCreatePayload, type PaymentStatusTransitionPayload } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { medusaAdjudicated } from "../medusa/adjudicated.js";
import { withLock } from "../redis/distributed-lock.js";
import { stripeAdjudicated } from "../stripe/adjudicated.js";
import { publishOrderEscalation } from "./_escalation.js";
import { createTooledOrderService } from "./_shared.js";
import { cancelStalePaymentIntent } from "./_stripe-helpers.js";

/**
 * After a successful amendment, cancel the old Stripe PI and create a new one
 * with the updated total. Returns PIX data for the customer if applicable.
 *
 * The Stripe PI create stays inline (Stripe SDK is not adjudicated — it's
 * an external egress). The PI ID is carried into the kernel-adjudicated
 * `payment.create` envelope by `syncPaymentAfterAmendment`.
 */
async function regeneratePixIfNeeded(
  orderId: string,
  oldPiId: string | undefined,
  svc: OrderService,
  sessionId: string,
): Promise<{ newPixQrCodeText?: string; newPixQrCodeUrl?: string; newStripePaymentIntentId?: string } | null> {
  if (!oldPiId) return null;

  await cancelStalePaymentIntent(oldPiId);

  // Fetch updated order total after amendment
  const { order: updatedOrder } = await svc.getOrder(orderId);
  const newTotal = updatedOrder.total ?? 0;
  if (newTotal <= 0) return null;

  // Stripe PI create — kernel-adjudicated egress.
  const newPi = await stripeAdjudicated.paymentIntents.create(
    {
      amount: newTotal,
      currency: "brl",
      payment_method_types: ["pix"],
      metadata: { medusaOrderId: orderId },
    },
    {
      sourceSubject: `tool:amend-order:regeneratePixIfNeeded:${sessionId}`,
      idempotencyKey: `amend:pix:${orderId}:${newTotal}`,
      auditSink: getAuditSink(),
    },
  ) as Stripe.PaymentIntent & {
    next_action?: { pix_display_qr_code?: { data?: string; image_url_svg?: string } };
  };

  // Update order metadata with new PI ID — kernel-adjudicated egress.
  await medusaAdjudicated<{ metadata: Record<string, string> }, unknown>({
    scope: "admin",
    method: "POST",
    path: `/admin/orders/${orderId}`,
    payload: { metadata: { stripePaymentIntentId: newPi.id } },
    sourceSubject: `tool:amend-order:${sessionId}`,
    auditSink: getAuditSink(),
  });

  const pixData = newPi.next_action?.pix_display_qr_code;
  return {
    newPixQrCodeText: pixData?.data,
    newPixQrCodeUrl: pixData?.image_url_svg,
    newStripePaymentIntentId: newPi.id,
  };
}

/**
 * Post-amendment payment sync, guarded by a distributed lock (P1-CONC-AMEND).
 *
 * `regeneratePixIfNeeded` (cancels + creates a Stripe PI) and the Payment-row
 * swap below MUST run atomically. Without a lock, two concurrent amendments
 * interleave — orphaning each other's active Payment row / Stripe PI and pointing
 * order metadata at a canceled intent. Invariant: exactly one active
 * (non-terminal) payment per order.
 *
 * Mirrors the `change_payment` path below: lock on `payment:<id>`, then RE-READ
 * the payment state INSIDE the lock before mutating, so a concurrent amendment
 * that already swapped this payment is observed and we skip (avoiding cancellation
 * of the other amendment's fresh payment). The PI regeneration + Payment-row swap
 * happen together inside the critical section.
 *
 * Returns the new PIX data for the customer, or null when there is nothing to do /
 * a concurrent amendment already swapped / the lock could not be acquired.
 * Both payment mutations are kernel-adjudicated; a create REFUSE throws (preserving
 * the legacy crash-on-failure semantics).
 */
async function syncPaymentAndPixAfterAmendment(
  orderId: string,
  oldPiId: string | undefined,
  svc: OrderService,
  customerId: string,
): Promise<{ newPixQrCodeText?: string; newPixQrCodeUrl?: string; newStripePaymentIntentId?: string } | null> {
  const paymentQuerySvc = createPaymentQueryService();
  const paymentCmdSvc = createPaymentCommandService();

  // Identify the payment to protect. The lock key is derived from its id — the
  // SAME `payment:<id>` convention used by change_payment.
  const activePayment = await paymentQuerySvc.getActiveByOrderId(orderId).catch(() => null);

  // No Payment row to protect (legacy orders pre-decoupled-billing): regenerate
  // the PI from Medusa metadata without a lock — there is no Payment-row invariant
  // at stake. Matches change_payment's no-active-payment fallback.
  if (!activePayment) {
    return regeneratePixIfNeeded(orderId, oldPiId, svc, customerId);
  }

  // withLock returns null if the lock could not be acquired — a concurrent
  // amendment holds it; skip the swap (the holder is performing it).
  return withLock<{ newPixQrCodeText?: string; newPixQrCodeUrl?: string; newStripePaymentIntentId?: string } | null>(
    `payment:${activePayment.id}`,
    async () => {
      // RE-READ inside the lock: a concurrent amendment may have already canceled
      // this payment (and minted a new active one) while we acquired the lock.
      const fresh = await paymentQuerySvc.getById(activePayment.id);
      if (!fresh || isTerminalPaymentStatus(fresh.status as PaymentStatus)) {
        // Already swapped by a concurrent amendment — do NOT cancel/recreate on
        // top of it (that would orphan the other amendment's fresh active payment).
        return null;
      }

      // 1. Cancel old Stripe PI + create the new one with the updated total,
      //    repoint order metadata (inside the lock — atomic with the row swap).
      const pixResult = await regeneratePixIfNeeded(orderId, oldPiId, svc, customerId);
      if (!pixResult?.newStripePaymentIntentId) return pixResult;

      // 2. Swap the Payment row to the new amount + PI, using the FRESH version
      //    read inside the lock (so a concurrent version bump is observed).
      const { order: updated } = await svc.getOrder(orderId);
      const updatedTotal = updated.total ?? 0;

      // Cancel old Payment row — kernel-adjudicated. Tolerate REFUSE (already
      // terminal) — same semantics as the legacy concurrent-modification swallow.
      const cancelPayload: PaymentStatusTransitionPayload = {
        paymentId: fresh.id,
        newStatus: "canceled",
        actor: "system",
        actorId: "amendment",
        reason: "order_amended_total_changed",
        expectedVersion: fresh.version,
      };
      const cancelEnv = buildEnvelope<
        "payment.status.transition",
        PaymentStatusTransitionPayload
      >({
        kind: "payment.status.transition",
        payload: cancelPayload,
        nonce: randomUUID(),
        actor: { principal: "system", sessionId: `tool:amend-order:${customerId}` },
        taint: "SYSTEM",
      });
      await paymentCmdSvc.transitionStatusFromEnvelope(cancelEnv).catch(() => undefined);

      // Create new Payment row — kernel-adjudicated.
      const createPayload: PaymentCreatePayload = {
        orderId,
        method: fresh.method as "pix" | "card" | "cash",
        amountInCentavos: updatedTotal,
        stripePaymentIntentId: pixResult.newStripePaymentIntentId,
      };
      const createEnv = buildEnvelope<"payment.create", PaymentCreatePayload>({
        kind: "payment.create",
        payload: createPayload,
        nonce: randomUUID(),
        actor: { principal: "system", sessionId: `tool:amend-order:${customerId}` },
        taint: "SYSTEM",
      });
      const outcome = await paymentCmdSvc.createFromEnvelope(createEnv);
      if (
        outcome.decision.kind !== "EXECUTE" &&
        outcome.decision.kind !== "REWRITE"
      ) {
        const msg =
          outcome.decision.kind === "REFUSE"
            ? outcome.decision.refusal.userFacing
            : "Não foi possível criar pagamento atualizado.";
        throw new NonRetryableError(msg);
      }

      return pixResult;
    },
  );
}

// ── Action-handler helpers ────────────────────────────────────────────────
//
// amendOrder dispatches each `action` to a dedicated handler below. The
// handlers were extracted verbatim from amendOrder's per-action `if` blocks to
// keep each unit's cognitive complexity bounded; behaviour is unchanged. The
// narrowed (non-null) `customerId` is threaded explicitly so the handlers do
// not re-derive the auth guard.

/** The Medusa order shape returned by OrderService.getOrder. */
type AmendedOrder = Awaited<ReturnType<OrderService["getOrder"]>>["order"];

/** pt-BR label for a payment method (cash → dinheiro, pix → PIX, else cartão). */
function paymentMethodLabelPtBr(method: string): string {
  if (method === "cash") return "dinheiro";
  if (method === "pix") return "PIX";
  return "cartão";
}

/**
 * Map a payment kernel decision to a user-facing failure message, or null when
 * the decision succeeded (EXECUTE / REWRITE). Mirrors the inline
 * `kind !== EXECUTE && kind !== REWRITE` guards: REFUSE surfaces its own
 * userFacing copy, any other non-success kind uses the provided fallback.
 */
function decisionFailureMessage(
  decision: Decision,
  fallback: string,
): string | null {
  if (decision.kind === "EXECUTE" || decision.kind === "REWRITE") return null;
  if (decision.kind === "REFUSE") return decision.refusal.userFacing;
  return fallback;
}

async function handleAddItem(
  parsed: AmendOrderInput,
  customerId: string,
  order: AmendedOrder,
  svc: OrderService,
): Promise<AmendOrderResult> {
  // Adding new items has no PONR restriction (unless in delivery, caught above)
  if (!parsed.variantId) {
    return { success: false, message: "ID da variante necessário para adicionar item." };
  }
  try {
    // Create order edit → add item → confirm — all kernel-adjudicated.
    const editData = await medusaAdjudicated<undefined, { order_edit: { id: string } }>({
      scope: "admin",
      method: "POST",
      path: `/admin/orders/${parsed.orderId}/edits`,
      sourceSubject: `tool:amend-order:${customerId}`,
      auditSink: getAuditSink(),
    });
    const editId = editData.order_edit.id;

    await medusaAdjudicated<{ variant_id: string; quantity: number }, unknown>({
      scope: "admin",
      method: "POST",
      path: `/admin/orders/${parsed.orderId}/edits/${editId}/items`,
      payload: { variant_id: parsed.variantId, quantity: parsed.quantity ?? 1 },
      sourceSubject: `tool:amend-order:${customerId}`,
      auditSink: getAuditSink(),
    });

    await medusaAdjudicated<undefined, unknown>({
      scope: "admin",
      method: "POST",
      path: `/admin/orders/${parsed.orderId}/edits/${editId}/confirm`,
      sourceSubject: `tool:amend-order:${customerId}`,
      auditSink: getAuditSink(),
    });

    const pixResult = await syncPaymentAndPixAfterAmendment(
      parsed.orderId,
      order.metadata?.["stripePaymentIntentId"],
      svc,
      customerId,
    );
    return {
      success: true,
      message: pixResult?.newPixQrCodeText
        ? "Item adicionado ao pedido. Novo código PIX gerado — use o código abaixo para pagar."
        : "Item adicionado ao pedido.",
      ...pixResult,
    };
  } catch (err) {
    return {
      success: false,
      message: `Erro ao adicionar item: ${(err as Error).message}`,
      needsEscalation: true,
    };
  }
}

async function handleRemoveItem(
  parsed: AmendOrderInput,
  customerId: string,
  order: AmendedOrder,
  svc: OrderService,
): Promise<AmendOrderResult> {
  if (!parsed.itemTitle) {
    return { success: false, message: "Nome do item necessário para remover." };
  }
  const result = await svc.cancelItem(parsed.orderId, customerId, parsed.itemTitle);

  // F-48 — `svc.cancelItem` sets needsEscalation on BOTH its past-PONR refusal
  // and its order-edit failure, and both tell the customer an attendant was
  // notified (order.service.ts). Reach the staff spine so that is TRUE.
  if (result.needsEscalation) {
    publishOrderEscalation({
      situation: "amend_remove_past_ponr",
      orderId: parsed.orderId,
      displayId: order.display_id,
    });
  }

  // Regenerate PIX if item was removed successfully (total changed)
  if (result.success) {
    const pixResult = await syncPaymentAndPixAfterAmendment(
      parsed.orderId,
      order.metadata?.["stripePaymentIntentId"],
      svc,
      customerId,
    );
    if (pixResult?.newPixQrCodeText) {
      return {
        ...result,
        message: result.message + " Novo código PIX gerado — use o código abaixo para pagar.",
        ...pixResult,
      };
    }
  }

  return result;
}

async function handleUpdateQty(
  parsed: AmendOrderInput,
  customerId: string,
  order: AmendedOrder,
  svc: OrderService,
): Promise<AmendOrderResult> {
  if (!parsed.itemTitle || !parsed.quantity) {
    return { success: false, message: "Nome do item e quantidade necessários." };
  }

  // Find the item
  const item = (order.items ?? []).find(
    (i) => i.title.toLowerCase() === parsed.itemTitle!.toLowerCase(),
  );
  if (!item) {
    return { success: false, message: `Item "${parsed.itemTitle}" não encontrado no pedido.` };
  }

  // PONR check for quantity change
  if (order.created_at) {
    const { getEffectivePonr, isWithinPonr } = await import("@ibatexas/domain");
    const metadata = (item as unknown as { metadata?: Record<string, unknown> }).metadata;
    const amendMinutes = typeof metadata?.amendPonrMinutes === "number"
      ? metadata.amendPonrMinutes
      : undefined;
    const ponr = getEffectivePonr({ amendMinutes });
    if (!isWithinPonr(new Date(order.created_at), ponr.amendMinutes)) {
      // F-48 — the message below promises an attendant was notified; this is
      // the publish that makes it true (staff spine, not the dead subject).
      publishOrderEscalation({
        situation: "amend_qty_past_ponr",
        orderId: parsed.orderId,
        displayId: order.display_id,
      });
      return {
        success: false,
        message: `Prazo para alterar "${parsed.itemTitle}" já passou. Um atendente foi notificado.`,
        needsEscalation: true,
      };
    }
  }

  // Update quantity via order edit — kernel-adjudicated.
  try {
    const editData = await medusaAdjudicated<undefined, { order_edit: { id: string } }>({
      scope: "admin",
      method: "POST",
      path: `/admin/orders/${parsed.orderId}/edits`,
      sourceSubject: `tool:amend-order:${customerId}`,
      auditSink: getAuditSink(),
    });
    const editId = editData.order_edit.id;

    await medusaAdjudicated<{ quantity: number }, unknown>({
      scope: "admin",
      method: "POST",
      path: `/admin/orders/${parsed.orderId}/edits/${editId}/items/${item.id}`,
      payload: { quantity: parsed.quantity },
      sourceSubject: `tool:amend-order:${customerId}`,
      auditSink: getAuditSink(),
    });

    await medusaAdjudicated<undefined, unknown>({
      scope: "admin",
      method: "POST",
      path: `/admin/orders/${parsed.orderId}/edits/${editId}/confirm`,
      sourceSubject: `tool:amend-order:${customerId}`,
      auditSink: getAuditSink(),
    });

    const pixResult = await syncPaymentAndPixAfterAmendment(
      parsed.orderId,
      order.metadata?.["stripePaymentIntentId"],
      svc,
      customerId,
    );
    return {
      success: true,
      message: pixResult?.newPixQrCodeText
        ? `Quantidade de "${parsed.itemTitle}" atualizada para ${parsed.quantity}. Novo código PIX gerado — use o código abaixo para pagar.`
        : `Quantidade de "${parsed.itemTitle}" atualizada para ${parsed.quantity}.`,
      ...pixResult,
    };
  } catch (err) {
    return {
      success: false,
      message: `Erro ao atualizar quantidade: ${(err as Error).message}`,
      needsEscalation: true,
    };
  }
}

/**
 * Create the Stripe PaymentIntent for the new method during a change_payment
 * switch (pix/card only — cash has no PI). Returns the PI and, for pix, the
 * QR-code expiry. Extracted from the switch critical section verbatim.
 */
async function createSwitchPaymentIntent(
  parsed: AmendOrderInput,
  customerId: string,
  activePaymentId: string,
  amountInCentavos: number,
): Promise<{ newStripePI: Stripe.PaymentIntent | null; pixExpiresAt: Date | undefined }> {
  let newStripePI: Stripe.PaymentIntent | null = null;
  let pixExpiresAt: Date | undefined;

  if (parsed.paymentMethod === "pix" || parsed.paymentMethod === "card") {
    // Stripe PI create for the new payment method — kernel-adjudicated.
    newStripePI = await stripeAdjudicated.paymentIntents.create(
      {
        amount: amountInCentavos,
        currency: "brl",
        payment_method_types: [parsed.paymentMethod],
        metadata: { orderId: parsed.orderId },
      },
      {
        sourceSubject: `tool:amend-order:change_payment:${customerId}`,
        idempotencyKey: `amend:switch:${activePaymentId}:${parsed.paymentMethod}`,
        auditSink: getAuditSink(),
      },
    ) as Stripe.PaymentIntent;

    if (parsed.paymentMethod === "pix") {
      const pixData = (newStripePI as Stripe.PaymentIntent & {
        next_action?: { pix_display_qr_code?: { expires_at?: number } };
      }).next_action?.pix_display_qr_code;
      if (pixData?.expires_at) {
        pixExpiresAt = new Date(pixData.expires_at * 1000);
      }
    }
  }

  return { newStripePI, pixExpiresAt };
}

/**
 * Build the success response for a completed payment-method switch. Extracted
 * verbatim from the tail of the switch critical section.
 */
function buildSwitchSuccessResponse(
  parsed: AmendOrderInput,
  newStripePI: Stripe.PaymentIntent | null,
): AmendOrderResult {
  if (parsed.paymentMethod === "cash") {
    return { success: true, message: "Pagamento alterado para dinheiro. Pague na retirada." };
  }

  if (parsed.paymentMethod === "pix" && newStripePI) {
    const pixData = (newStripePI as Stripe.PaymentIntent & {
      next_action?: { pix_display_qr_code?: { data?: string; image_url_svg?: string } };
    }).next_action?.pix_display_qr_code;
    return {
      success: true,
      message: "Pagamento alterado para PIX. Novo código gerado.",
      newPixQrCodeText: pixData?.data,
      newPixQrCodeUrl: pixData?.image_url_svg,
    };
  }

  if (parsed.paymentMethod === "card" && newStripePI) {
    return {
      success: true,
      message: "Pagamento alterado para cartão.",
      stripeClientSecret: newStripePI.client_secret ?? undefined,
    };
  }

  return { success: true, message: "Forma de pagamento alterada." };
}

async function handleChangePayment(
  parsed: AmendOrderInput,
  customerId: string,
  order: AmendedOrder,
): Promise<AmendOrderResult> {
  if (!parsed.paymentMethod) {
    return { success: false, message: "Método de pagamento necessário." };
  }

  const paymentQuerySvc = createPaymentQueryService();
  const paymentCmdSvc = createPaymentCommandService();
  const activePayment = await paymentQuerySvc.getActiveByOrderId(parsed.orderId).catch(() => null);

  // If no Payment row exists, fall back to legacy Medusa metadata path
  if (!activePayment) {
    const oldPiId = order.metadata?.["stripePaymentIntentId"] as string | undefined;
    if (oldPiId) await cancelStalePaymentIntent(oldPiId);
    return { success: true, message: `Pagamento alterado para ${paymentMethodLabelPtBr(parsed.paymentMethod)}.` };
  }

  // Block switch if already paid or terminal
  const terminalForSwitch = ["paid", "refunded", "canceled", "waived"];
  if (terminalForSwitch.includes(activePayment.status)) {
    return { success: false, message: "Pagamento já finalizado — não pode trocar." };
  }

  // Same method — no-op
  if (activePayment.method === parsed.paymentMethod) {
    return { success: false, message: "Já está usando este método de pagamento." };
  }

  const sessionTag = `tool:amend-order:${customerId}`;

  // Atomic switch via distributed lock on payment.
  // Every payment mutation now flows through *FromEnvelope.
  const switchResult = await withLock<AmendOrderResult>(`payment:${activePayment.id}`, async () => {
    // 1. Transition → switching_method (kernel-adjudicated)
    const toSwitchingEnv = buildEnvelope<
      "payment.status.transition",
      PaymentStatusTransitionPayload
    >({
      kind: "payment.status.transition",
      payload: {
        paymentId: activePayment.id,
        newStatus: "switching_method",
        actor: "customer",
        actorId: customerId,
        reason: `switch_to_${parsed.paymentMethod}`,
        expectedVersion: activePayment.version,
      },
      nonce: randomUUID(),
      actor: { principal: "user", sessionId: customerId },
      taint: "TRUSTED",
    });
    const toSwitchOutcome = await paymentCmdSvc.transitionStatusFromEnvelope(toSwitchingEnv);
    const toSwitchFail = decisionFailureMessage(
      toSwitchOutcome.decision,
      "Não foi possível iniciar a troca de método.",
    );
    if (toSwitchFail !== null) {
      return { success: false, message: toSwitchFail };
    }

    // 2. Cancel old Stripe PI
    if (activePayment.stripePaymentIntentId) {
      await cancelStalePaymentIntent(activePayment.stripePaymentIntentId);
    }

    // 3. Transition old payment → canceled (kernel-adjudicated)
    const afterSwitch = await paymentQuerySvc.getById(activePayment.id);
    const cancelEnv = buildEnvelope<
      "payment.status.transition",
      PaymentStatusTransitionPayload
    >({
      kind: "payment.status.transition",
      payload: {
        paymentId: activePayment.id,
        newStatus: "canceled",
        actor: "customer",
        actorId: customerId,
        reason: "method_switch_completed",
        expectedVersion: afterSwitch?.version ?? activePayment.version + 1,
      },
      nonce: randomUUID(),
      actor: { principal: "user", sessionId: customerId },
      taint: "TRUSTED",
    });
    const cancelOutcome = await paymentCmdSvc.transitionStatusFromEnvelope(cancelEnv);
    const cancelFail = decisionFailureMessage(
      cancelOutcome.decision,
      "Não foi possível cancelar o pagamento anterior.",
    );
    if (cancelFail !== null) {
      return { success: false, message: cancelFail };
    }

    // 4. Create new Payment row (kernel-adjudicated)
    const { newStripePI, pixExpiresAt } = await createSwitchPaymentIntent(
      parsed,
      customerId,
      activePayment.id,
      activePayment.amountInCentavos,
    );

    const createPayload: PaymentCreatePayload = {
      orderId: parsed.orderId,
      method: parsed.paymentMethod!,
      amountInCentavos: activePayment.amountInCentavos,
      ...(newStripePI?.id ? { stripePaymentIntentId: newStripePI.id } : {}),
      ...(pixExpiresAt ? { pixExpiresAt: pixExpiresAt.toISOString() } : {}),
    };
    const createEnv = buildEnvelope<"payment.create", PaymentCreatePayload>({
      kind: "payment.create",
      payload: createPayload,
      nonce: randomUUID(),
      actor: { principal: "system", sessionId: sessionTag },
      taint: "SYSTEM",
    });
    const createOutcome = await paymentCmdSvc.createFromEnvelope(createEnv);
    const createFail = decisionFailureMessage(
      createOutcome.decision,
      "Não foi possível criar pagamento com novo método.",
    );
    if (createFail !== null) {
      return { success: false, message: createFail };
    }
    const newPayment = createOutcome.result!;

    // 5. Publish events
    void publishNatsEvent("payment.method_changed", {
      orderId: parsed.orderId,
      paymentId: newPayment.id,
      previousMethod: activePayment.method,
      newMethod: parsed.paymentMethod,
      timestamp: new Date().toISOString(),
    });

    void publishNatsEvent("payment.status_changed", {
      orderId: parsed.orderId,
      paymentId: newPayment.id,
      previousStatus: "awaiting_payment",
      newStatus: parsed.paymentMethod === "cash" ? "cash_pending" : "payment_pending",
      method: parsed.paymentMethod,
      version: newPayment.version,
      timestamp: new Date().toISOString(),
    });

    // 6. Build response
    return buildSwitchSuccessResponse(parsed, newStripePI);
  });

  return switchResult ?? { success: false, message: "Operação em andamento. Tente novamente em instantes." };
}

export async function amendOrder(
  input: AmendOrderInput,
  ctx: AgentContext,
): Promise<AmendOrderResult> {
  const parsed = AmendOrderInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para modificar pedido.");
  }
  const customerId = ctx.customerId;

  // W8-V1: route order.service mutations through the kernel-gated wrapper
  // via the shared factory. svc.getOrder (GET) still bypasses the wrapper;
  // mutating helpers (svc.cancelItem) now go through medusaAdjudicated.
  const svc = createTooledOrderService("tool:amend_order");
  const { order, ownershipValid } = await svc.getOrder(parsed.orderId, customerId);

  if (!ownershipValid) {
    return { success: false, message: "Pedido não encontrado." };
  }

  // Validate action against domain fulfillment status (not Medusa status)
  const orderQuerySvc = createOrderQueryService();
  const projection = await orderQuerySvc.getById(parsed.orderId);
  const fulfillmentStatus = projection?.fulfillmentStatus ?? "pending";

  // Map action to validator action type
  const actionMap: Record<string, CustomerAction> = {
    add: "amend_add_item",
    remove: "amend_remove_item",
    update_qty: "amend_update_qty",
    change_payment: "change_payment_method",
  };
  const validatorAction = actionMap[parsed.action];

  if (validatorAction && parsed.action !== "change_payment") {
    const check = canPerformAction(validatorAction, {
      fulfillmentStatus: fulfillmentStatus as OrderFulfillmentStatus,
    });
    if (!check.allowed) {
      // F-48 (governor ruling) — BOTH escalating arms of the shared
      // remove/update_qty validator tell the customer "Um atendente foi
      // notificado": the routine 'preparing' denial (:77) and the PONR-expired
      // denial (:79). This is a PRE-KERNEL early return — no envelope is built
      // past this point — so the publish belongs here in the tools layer,
      // exactly like the two past-PONR sites, and carries the same
      // system-authored-reason posture. Keyed on the validator's own `escalate`
      // flag, so whichever arm denied is the one that reaches staff.
      if (check.escalate) {
        publishOrderEscalation({
          situation: "amend_denied_needs_staff",
          orderId: parsed.orderId,
          displayId: order.display_id,
          fulfillmentStatus: fulfillmentStatus as OrderFulfillmentStatus,
        });
      }
      return {
        success: false,
        message: check.reason,
        needsEscalation: check.escalate,
      };
    }
  }

  if (parsed.action === "add") {
    return handleAddItem(parsed, customerId, order, svc);
  }

  if (parsed.action === "remove") {
    return handleRemoveItem(parsed, customerId, order, svc);
  }

  if (parsed.action === "update_qty") {
    return handleUpdateQty(parsed, customerId, order, svc);
  }

  if (parsed.action === "change_payment") {
    return handleChangePayment(parsed, customerId, order);
  }

  return { success: false, message: "Ação não reconhecida." };
}

export const AmendOrderTool = {
  name: "amend_order",
  description: "Modifica um pedido existente: adicionar item, remover item, alterar quantidade ou trocar forma de pagamento. Verifica prazo de alteração (PONR). Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido" },
      action: { type: "string", enum: ["add", "remove", "update_qty", "change_payment"], description: "Ação: add, remove, update_qty, change_payment" },
      variantId: { type: "string", description: "ID da variante (para add)" },
      itemTitle: { type: "string", description: "Nome do item (para remove/update_qty)" },
      quantity: { type: "number", description: "Quantidade (para add e update_qty)" },
      paymentMethod: { type: "string", enum: ["pix", "card", "cash"], description: "Novo método de pagamento (para change_payment)" },
    },
    required: ["orderId", "action"],
  },
} as const;
