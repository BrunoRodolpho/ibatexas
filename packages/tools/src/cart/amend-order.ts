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
import { AmendOrderInputSchema, NonRetryableError, canPerformAction, type AmendOrderInput, type AmendOrderResult, type AgentContext, type CustomerAction, type OrderFulfillmentStatus } from "@ibatexas/types";
import { buildEnvelope } from "@adjudicate/core";
import { createOrderService, createOrderQueryService, createPaymentQueryService, createPaymentCommandService, type PaymentCreatePayload, type PaymentStatusTransitionPayload } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { medusaAdjudicated } from "../medusa/adjudicated.js";
import { medusaAdmin } from "../medusa/client.js";
import { withLock } from "../redis/distributed-lock.js";
import { stripeAdjudicated } from "../stripe/adjudicated.js";
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
  svc: ReturnType<typeof createOrderService>,
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
  });

  const pixData = newPi.next_action?.pix_display_qr_code;
  return {
    newPixQrCodeText: pixData?.data,
    newPixQrCodeUrl: pixData?.image_url_svg,
    newStripePaymentIntentId: newPi.id,
  };
}

/**
 * After an amendment changes the order total, sync the Payment table:
 * 1. Cancel the old Payment row via `transitionStatusFromEnvelope`
 * 2. Create a new Payment row via `createFromEnvelope`
 *
 * Both calls are kernel-adjudicated. REFUSE on either side stops the
 * sync (the executor's defensive throw becomes a kernel REFUSE).
 */
async function syncPaymentAfterAmendment(
  orderId: string,
  newStripePaymentIntentId: string | undefined,
  updatedTotal: number,
  customerId: string,
): Promise<void> {
  if (!newStripePaymentIntentId) return;

  const paymentQuerySvc = createPaymentQueryService();
  const paymentCmdSvc = createPaymentCommandService();

  const activePayment = await paymentQuerySvc.getActiveByOrderId(orderId).catch(() => null);
  if (!activePayment) return;

  // 1. Cancel old Payment row — kernel-adjudicated.
  const cancelPayload: PaymentStatusTransitionPayload = {
    paymentId: activePayment.id,
    newStatus: "canceled",
    actor: "system",
    actorId: "amendment",
    reason: "order_amended_total_changed",
    expectedVersion: activePayment.version,
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
  // Tolerate REFUSE (already terminal) — same semantics as the legacy
  // try/catch that swallowed concurrent-modification errors.
  await paymentCmdSvc.transitionStatusFromEnvelope(cancelEnv).catch(() => undefined);

  // 2. Create new Payment row — kernel-adjudicated.
  const createPayload: PaymentCreatePayload = {
    orderId,
    method: activePayment.method as "pix" | "card" | "cash",
    amountInCentavos: updatedTotal,
    stripePaymentIntentId: newStripePaymentIntentId,
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
    // Surface to the caller as a thrown error — preserves the legacy
    // crash-on-failure semantics that the swap was wrapped in
    // try/catch upstream.
    const msg =
      outcome.decision.kind === "REFUSE"
        ? outcome.decision.refusal.userFacing
        : "Não foi possível criar pagamento atualizado.";
    throw new NonRetryableError(msg);
  }
}

export async function amendOrder(
  input: AmendOrderInput,
  ctx: AgentContext,
): Promise<AmendOrderResult> {
  const parsed = AmendOrderInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para modificar pedido.");
  }

  // medusaAdmin used here only for GET (svc reads). All writes via
  // medusaAdjudicated().
  const svc = createOrderService(medusaAdmin);
  const { order, ownershipValid } = await svc.getOrder(parsed.orderId, ctx.customerId);

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
      return {
        success: false,
        message: check.reason,
        needsEscalation: check.escalate,
      };
    }
  }

  if (parsed.action === "add") {
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
        sourceSubject: `tool:amend-order:${ctx.customerId}`,
      });
      const editId = editData.order_edit.id;

      await medusaAdjudicated<{ variant_id: string; quantity: number }, unknown>({
        scope: "admin",
        method: "POST",
        path: `/admin/orders/${parsed.orderId}/edits/${editId}/items`,
        payload: { variant_id: parsed.variantId, quantity: parsed.quantity ?? 1 },
        sourceSubject: `tool:amend-order:${ctx.customerId}`,
      });

      await medusaAdjudicated<undefined, unknown>({
        scope: "admin",
        method: "POST",
        path: `/admin/orders/${parsed.orderId}/edits/${editId}/confirm`,
        sourceSubject: `tool:amend-order:${ctx.customerId}`,
      });

      const pixResult = await regeneratePixIfNeeded(
        parsed.orderId,
        order.metadata?.["stripePaymentIntentId"],
        svc,
        ctx.customerId,
      );
      if (pixResult?.newStripePaymentIntentId) {
        const { order: updated } = await svc.getOrder(parsed.orderId);
        await syncPaymentAfterAmendment(
          parsed.orderId,
          pixResult.newStripePaymentIntentId,
          updated.total ?? 0,
          ctx.customerId,
        );
      }
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

  if (parsed.action === "remove") {
    if (!parsed.itemTitle) {
      return { success: false, message: "Nome do item necessário para remover." };
    }
    const result = await svc.cancelItem(parsed.orderId, ctx.customerId, parsed.itemTitle);

    if (result.needsEscalation) {
      void publishNatsEvent("order.escalation_needed", {
        orderId: parsed.orderId,
        customerId: ctx.customerId,
        reason: "amend_remove_past_ponr",
        itemTitle: parsed.itemTitle,
        timestamp: new Date().toISOString(),
      });
    }

    // Regenerate PIX if item was removed successfully (total changed)
    if (result.success) {
      const pixResult = await regeneratePixIfNeeded(
        parsed.orderId,
        order.metadata?.["stripePaymentIntentId"],
        svc,
        ctx.customerId,
      );
      if (pixResult?.newStripePaymentIntentId) {
        const { order: updated } = await svc.getOrder(parsed.orderId);
        await syncPaymentAfterAmendment(
          parsed.orderId,
          pixResult.newStripePaymentIntentId,
          updated.total ?? 0,
          ctx.customerId,
        );
      }
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

  if (parsed.action === "update_qty") {
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
        void publishNatsEvent("order.escalation_needed", {
          orderId: parsed.orderId,
          customerId: ctx.customerId,
          reason: "amend_qty_past_ponr",
          itemTitle: parsed.itemTitle,
          timestamp: new Date().toISOString(),
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
        sourceSubject: `tool:amend-order:${ctx.customerId}`,
      });
      const editId = editData.order_edit.id;

      await medusaAdjudicated<{ quantity: number }, unknown>({
        scope: "admin",
        method: "POST",
        path: `/admin/orders/${parsed.orderId}/edits/${editId}/items/${item.id}`,
        payload: { quantity: parsed.quantity },
        sourceSubject: `tool:amend-order:${ctx.customerId}`,
      });

      await medusaAdjudicated<undefined, unknown>({
        scope: "admin",
        method: "POST",
        path: `/admin/orders/${parsed.orderId}/edits/${editId}/confirm`,
        sourceSubject: `tool:amend-order:${ctx.customerId}`,
      });

      const pixResult = await regeneratePixIfNeeded(
        parsed.orderId,
        order.metadata?.["stripePaymentIntentId"],
        svc,
        ctx.customerId,
      );
      if (pixResult?.newStripePaymentIntentId) {
        const { order: updated } = await svc.getOrder(parsed.orderId);
        await syncPaymentAfterAmendment(
          parsed.orderId,
          pixResult.newStripePaymentIntentId,
          updated.total ?? 0,
          ctx.customerId,
        );
      }
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

  if (parsed.action === "change_payment") {
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
      return { success: true, message: `Pagamento alterado para ${parsed.paymentMethod === "cash" ? "dinheiro" : parsed.paymentMethod === "pix" ? "PIX" : "cartão"}.` };
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

    const sessionTag = `tool:amend-order:${ctx.customerId}`;

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
          actorId: ctx.customerId,
          reason: `switch_to_${parsed.paymentMethod}`,
          expectedVersion: activePayment.version,
        },
        nonce: randomUUID(),
        actor: { principal: "user", sessionId: ctx.customerId! },
        taint: "TRUSTED",
      });
      const toSwitchOutcome = await paymentCmdSvc.transitionStatusFromEnvelope(toSwitchingEnv);
      if (
        toSwitchOutcome.decision.kind !== "EXECUTE" &&
        toSwitchOutcome.decision.kind !== "REWRITE"
      ) {
        const msg =
          toSwitchOutcome.decision.kind === "REFUSE"
            ? toSwitchOutcome.decision.refusal.userFacing
            : "Não foi possível iniciar a troca de método.";
        return { success: false, message: msg };
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
          actorId: ctx.customerId,
          reason: "method_switch_completed",
          expectedVersion: afterSwitch?.version ?? activePayment.version + 1,
        },
        nonce: randomUUID(),
        actor: { principal: "user", sessionId: ctx.customerId! },
        taint: "TRUSTED",
      });
      const cancelOutcome = await paymentCmdSvc.transitionStatusFromEnvelope(cancelEnv);
      if (
        cancelOutcome.decision.kind !== "EXECUTE" &&
        cancelOutcome.decision.kind !== "REWRITE"
      ) {
        const msg =
          cancelOutcome.decision.kind === "REFUSE"
            ? cancelOutcome.decision.refusal.userFacing
            : "Não foi possível cancelar o pagamento anterior.";
        return { success: false, message: msg };
      }

      // 4. Create new Payment row (kernel-adjudicated)
      let newStripePI: Stripe.PaymentIntent | null = null;
      let pixExpiresAt: Date | undefined;

      if (parsed.paymentMethod === "pix" || parsed.paymentMethod === "card") {
        // Stripe PI create for the new payment method — kernel-adjudicated.
        newStripePI = await stripeAdjudicated.paymentIntents.create(
          {
            amount: activePayment.amountInCentavos,
            currency: "brl",
            payment_method_types: [parsed.paymentMethod],
            metadata: { orderId: parsed.orderId },
          },
          {
            sourceSubject: `tool:amend-order:change_payment:${ctx.customerId}`,
            idempotencyKey: `amend:switch:${activePayment.id}:${parsed.paymentMethod}`,
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
      if (
        createOutcome.decision.kind !== "EXECUTE" &&
        createOutcome.decision.kind !== "REWRITE"
      ) {
        const msg =
          createOutcome.decision.kind === "REFUSE"
            ? createOutcome.decision.refusal.userFacing
            : "Não foi possível criar pagamento com novo método.";
        return { success: false, message: msg };
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

      // Build response
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
    });

    return switchResult ?? { success: false, message: "Operação em andamento. Tente novamente em instantes." };
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
