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

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getRedisClient, rk, withLock } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createOrderCommandService,
  createOrderQueryService,
  createPaymentCommandService,
  createPaymentQueryService,
  prisma,
  InvalidTransitionError,
} from "@ibatexas/domain";
import {
  OrderFulfillmentStatus,
  PaymentStatus,
  canPerformAction,
  canTransitionPayment,
  isTerminalPaymentStatus,
} from "@ibatexas/types";
import { getEffectivePonr } from "@ibatexas/domain";
import { amendOrder, changeDeliveryAddress, switchOrderType, medusaAdmin } from "@ibatexas/tools";
import { type AgentContext, Channel } from "@ibatexas/types";
import type {
  OrderAddressChangePayload,
  OrderCancelPayload,
  OrderNoteAddPayload,
  OrderTypeSwitchPayload,
} from "@ibatexas/pack-orders";
import type {
  PaymentMethodSwitchPayload,
  PaymentPixRegeneratePayload,
  PaymentRetryPayload,
} from "@ibatexas/pack-payments";
import { requireAuth } from "../middleware/auth.js";
import {
  adjudicateCustomerMutation,
  replyForIntent,
} from "./__shared__/customer-intent-gateway.js";

/** Build a minimal AgentContext for API-originated tool calls. */
function apiContext(customerId: string): AgentContext {
  return { customerId, channel: Channel.Web, sessionId: "api", userType: "customer" };
}

type PaymentMethodLiteral = "pix" | "card" | "cash";

/**
 * Result of {@link replaceActivePayment}.
 * - `ok`        — the old payment was canceled and the replacement created.
 * - `compensated` — `create()` of the replacement failed, but we re-created an
 *   active payment with the ORIGINAL method, so the order is left in a usable
 *   payment state (the customer's prior method is restored).
 * - `orphaned`  — `create()` failed AND the compensating re-create also failed;
 *   the order may have no active payment. Caller must surface an actionable
 *   error (never an opaque 500).
 */
type ReplacePaymentResult =
  | { kind: "ok"; payment: { id: string; version: number } }
  | { kind: "compensated"; payment: { id: string; version: number }; error: unknown }
  | { kind: "orphaned"; error: unknown; compensationError: unknown };

/**
 * Compensating cancel→create for the payment method-switch / retry / regenerate
 * paths (P1-ERR-PAYSWITCH).
 *
 * The single-active-payment invariant (enforced inside `create()` as a DB
 * transaction) means the OLD payment MUST be terminal before a replacement can
 * be created — so create-before-cancel is impossible, and `canceled` is terminal
 * in the forward-only state machine so the canceled row cannot be resurrected.
 * `create()` is atomic, so a thrown `create()` rolls back its own row insert and
 * leaves the order with NO active payment.
 *
 * Therefore: if `create(newMethod)` throws, we compensate by re-creating an
 * active payment with the ORIGINAL method, restoring the customer's prior usable
 * state. Only if that compensating create ALSO fails do we report an orphaned
 * state, which the caller maps to an actionable (non-500) error.
 *
 * `cancelReason` is pt-BR (Hard Rule #4). Amounts are integer centavos
 * (Hard Rule #2) and carried verbatim from the original payment.
 *
 * NOTE: any `transitionStatus`/`create` calls passed in MUST already be the
 * domain command-service methods so this stays inside existing kernel contracts
 * (no adjudicate/conductor wiring — deferred this cycle).
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
  /** Optional pre-cancel transition (e.g. switching_method) run before cancel. */
  preCancel?: () => Promise<void>;
  log: FastifyInstance["log"];
}): Promise<ReplacePaymentResult> {
  const {
    paymentCmdSvc, orderId, currentPaymentId, currentMethod, newMethod,
    amountInCentavos, customerId, cancelReason, preCancel, log,
  } = args;

  // Optional intermediate transition (switch path: → switching_method).
  if (preCancel) await preCancel();

  // Cancel the old payment. A pre-existing terminal state is benign (the old
  // attempt is already dead), so swallow only the transition error here.
  try {
    await paymentCmdSvc.transitionStatus(currentPaymentId, {
      newStatus: PaymentStatus.CANCELED,
      actor: "customer",
      actorId: customerId,
      reason: cancelReason,
    });
  } catch {
    // May already be terminal — non-critical; create() below still enforces
    // the single-active invariant.
  }

  // Create the replacement. On failure, compensate by restoring an active
  // payment with the ORIGINAL method so the order is never left payment-less.
  try {
    const payment = await paymentCmdSvc.create({ orderId, method: newMethod, amountInCentavos });
    return { kind: "ok", payment };
  } catch (error) {
    log.error(
      { orderId, paymentId: currentPaymentId, newMethod, error: String(error) },
      "payment replacement create() failed — attempting compensation (restore original method)",
    );
    try {
      const restored = await paymentCmdSvc.create({ orderId, method: currentMethod, amountInCentavos });
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

const OrderIdParams = z.object({ id: z.string().min(1) });

export async function orderActionRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const orderCmdSvc = createOrderCommandService();
  const orderQuerySvc = createOrderQueryService();
  const paymentCmdSvc = createPaymentCommandService(server.log);
  const paymentQuerySvc = createPaymentQueryService();

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

      await orderCmdSvc.create({
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
      });
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
      const redis = await getRedisClient();
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

      // Validate cancel action via centralized validator
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

      // RC-A1 Phase B — gate the cancel through the conductor when active;
      // byte-equivalent legacy path while inert. The whole cancel (status
      // transition + active-payment cancellation + conditional order.canceled
      // emit) is the adjudicated mutation; the HTTP-layer pre-checks above (rate
      // limit, ownership, PONR) stay outside it. The mutation returns a typed
      // result so the 409 (payment-not-terminal) outcome survives the wrapper.
      const doCancel = async (): Promise<
        | { readonly ok: true; readonly version: number; readonly fulfillmentStatus: string }
        | { readonly ok: false; readonly code: "PAYMENT_CANCEL_FAILED" }
      > => {
        const result = await orderCmdSvc.transitionStatus(id, {
          newStatus: OrderFulfillmentStatus.CANCELED,
          actor: "customer",
          actorId: customerId,
          reason: request.body.reason ?? "Cancelado pelo cliente",
        });

        // Cancel the active payment so a canceled order never retains a LIVE
        // payment that could later reconcile to `paid` (P2-LOGIC-CANCELPAY).
        // We must NOT emit `order.canceled` unless the payment is actually
        // terminal afterward — otherwise a swallowed cancel failure would leave
        // a billable payment behind an order the customer believes is canceled.
        const activePayment = await paymentCmdSvc.findActiveByOrderId(id);
        let paymentTerminal = true; // no active payment ⇒ nothing left to settle
        if (activePayment && !isTerminalPaymentStatus(activePayment.status as PaymentStatus)) {
          paymentTerminal = false;
          try {
            await paymentCmdSvc.transitionStatus(activePayment.id, {
              newStatus: PaymentStatus.CANCELED,
              actor: "customer",
              actorId: customerId,
              reason: "Pedido cancelado pelo cliente",
              // P2-CONC-CONFIRMVER: pin the version we validated against so a
              // concurrent transition (e.g. a webhook flipping the payment to
              // `paid`) can't be silently clobbered — it surfaces as a
              // concurrency error and we re-check terminality below.
              expectedVersion: activePayment.version,
            });
            paymentTerminal = true;
          } catch {
            // The cancel may have failed because the payment is already terminal
            // (benign) OR because it concurrently moved to a live state such as
            // `paid` (NOT benign). Re-read the authoritative state instead of
            // assuming success: only a terminal payment lets us emit the event.
            const after = await paymentCmdSvc.findActiveByOrderId(id);
            // No active (non-terminal) payment now ⇒ it settled to a terminal
            // state ⇒ safe to proceed. A still-active payment ⇒ unsafe.
            paymentTerminal = after === null;
          }
        }

        if (!paymentTerminal) {
          // The order row is CANCELED but the payment is still live. Do NOT emit
          // `order.canceled` (downstream treats it as fully settled). Surface an
          // actionable error so the cancel is retried / escalated rather than
          // leaving a canceled order with a billable payment.
          server.log.error(
            { orderId: id, paymentId: activePayment?.id },
            "order canceled but active payment is not terminal — withholding order.canceled (P2-LOGIC-CANCELPAY)",
          );
          return { ok: false, code: "PAYMENT_CANCEL_FAILED" };
        }

        await publishNatsEvent("order.canceled", {
          eventType: "order.canceled",
          orderId: id,
          displayId: order.displayId,
          customerId,
          reason: request.body.reason ?? "Cancelado pelo cliente",
          canceledBy: "customer",
          timestamp: new Date().toISOString(),
        });

        return { ok: true, version: result.version, fulfillmentStatus: result.newStatus };
      };

      try {
        const outcome = await adjudicateCustomerMutation({
          kind: "order.cancel",
          payload: {
            orderId: id,
            reason: request.body.reason ?? "Cancelado pelo cliente",
          } satisfies OrderCancelPayload,
          customerId,
          // OrderState the orders PolicyBundle inspects for order.cancel:
          // requireAuthenticated (customerId non-null) + canCancelOrder
          // (hasOrderId && lastAction !== "cancelled"). lastAction omitted
          // (undefined ⇒ not "cancelled" ⇒ allowed). PONR is enforced above at
          // the HTTP layer (canPerformAction), not in the pack state.
          state: { ctx: { channel: "web", customerId, cartId: null, orderId: id } },
          legacy: doCancel,
        });
        if (!outcome.ran) return replyForIntent(reply, outcome.intent);

        const result = outcome.result;
        if (!result.ok) {
          return reply.code(409).send({
            error: "Não foi possível cancelar o pagamento do pedido. Tente novamente em instantes.",
            code: "PAYMENT_CANCEL_FAILED",
          });
        }

        return reply.send({
          success: true,
          version: result.version,
          fulfillmentStatus: result.fulfillmentStatus,
        });
      } catch (err) {
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
      const redis = await getRedisClient();
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
      let fulfillmentStatus: OrderFulfillmentStatus = OrderFulfillmentStatus.PENDING;
      let itemProductTypeMap = new Map<string, string | undefined>();

      const projection = await orderQuerySvc.getById(id);
      if (projection) {
        fulfillmentStatus = projection.fulfillmentStatus as OrderFulfillmentStatus;
        const projectionItems = (projection.itemsJson as Array<{ title: string; productType?: string }>) ?? [];
        itemProductTypeMap = new Map(projectionItems.map(i => [i.title.toLowerCase(), i.productType]));
      } else {
        // Fallback: projection not populated — read from Medusa
        try {
          const data = await medusaAdmin(
            `/admin/orders/${id}?fields=id,fulfillment_status,*items`,
          ) as { order?: { fulfillment_status?: string; items?: Array<{ title?: string; metadata?: Record<string, string> }> } };
          if (!data.order) {
            return reply.code(404).send({ error: "Pedido não encontrado." });
          }
          fulfillmentStatus = (data.order.fulfillment_status ?? "pending") as OrderFulfillmentStatus;
          if (Array.isArray(data.order.items)) {
            itemProductTypeMap = new Map(
              data.order.items.map(i => [(i.title ?? "").toLowerCase(), i.metadata?.["productType"]]),
            );
          }
        } catch {
          return reply.code(404).send({ error: "Pedido não encontrado." });
        }
      }

      const isPreparing = fulfillmentStatus === "preparing";

      // ── Pre-validate ALL changes before applying any ──────────────────
      const lockedItems: string[] = [];
      for (const change of request.body.changes) {
        // Check if action is allowed for current fulfillment status
        const actionType = change.type === "remove" ? "amend_remove_item" : "amend_update_qty";
        const check = canPerformAction(actionType as Parameters<typeof canPerformAction>[0], {
          fulfillmentStatus,
        });
        if (!check.allowed) {
          return reply.code(422).send({
            error: check.reason,
            code: "ACTION_NOT_ALLOWED",
          });
        }

        // During preparing: food items are locked
        if (isPreparing) {
          const productType = itemProductTypeMap.get(change.itemTitle.toLowerCase());
          if (productType === "food") {
            lockedItems.push(change.itemTitle);
          }
        }
      }

      if (lockedItems.length > 0) {
        return reply.code(422).send({
          error: "Alguns itens estão em preparo e não podem ser alterados.",
          code: "ITEM_NOW_LOCKED",
          lockedItems,
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
      const results: Array<{ itemTitle: string; success: boolean; message?: string }> = [];
      let hasFailure = false;

      for (const change of request.body.changes) {
        try {
          const result = await amendOrder(
            {
              orderId: id,
              action: change.type,
              itemTitle: change.itemTitle,
              quantity: change.quantity,
            },
            apiContext(customerId),
          );
          results.push({ itemTitle: change.itemTitle, success: result.success, message: result.message });
          if (!result.success) hasFailure = true;
        } catch (err) {
          results.push({ itemTitle: change.itemTitle, success: false, message: (err as Error).message });
          hasFailure = true;
          break; // Stop on first failure to prevent partial state
        }
      }

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
      const redis = await getRedisClient();
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

      try {
        const result = await amendOrder(
          {
            orderId: id,
            action: request.body.action,
            variantId: request.body.variantId,
            itemTitle: request.body.itemTitle,
            quantity: request.body.quantity,
          },
          apiContext(customerId),
        );
        return reply.send(result);
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

      // Legacy direct mutation — preserved verbatim. Gated by adjudication when
      // the conductor is active (RC-A1 Phase B lazy-conductor); byte-equivalent
      // to pre-cutover while inert.
      const addNote = async () => {
        const note = await prisma.orderNote.create({
          data: {
            orderId: id,
            author: "customer",
            authorId: customerId,
            content: request.body.content,
          },
        });

        await publishNatsEvent("order.note_added", {
          eventType: "order.note_added",
          orderId: id,
          noteId: note.id,
          author: "customer",
          timestamp: new Date().toISOString(),
        });

        return note;
      };

      const outcome = await adjudicateCustomerMutation({
        kind: "order.note.add",
        payload: {
          orderId: id,
          body: request.body.content,
        } satisfies OrderNoteAddPayload,
        customerId,
        // OrderState the orders PolicyBundle inspects for order.note.add: auth
        // (customerId non-null) + order presence; lastAction omitted (undefined
        // ⇒ not "cancelled" ⇒ allowed, matching legacy "note on any owned order").
        state: { ctx: { channel: "web", customerId, cartId: null, orderId: id } },
        legacy: addNote,
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);

      const note = outcome.result;
      return reply.code(201).send({ id: note.id, content: note.content, createdAt: note.createdAt.toISOString() });
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

      // RC-A1 Phase B — gate the retry (cancel-old + create-new compensating
      // sequence, P1-ERR-PAYSWITCH) through the conductor; byte-equivalent legacy
      // path while inert. The HTTP-layer guards above (order retryable, 10/order
      // attempt cap, active-payment status) stay OUTSIDE the adjudicated mutation.
      // Retry uses the SAME method, so replacement and compensation target match.
      const method = currentPayment.method as PaymentMethodLiteral;
      const outcome = await adjudicateCustomerMutation({
        kind: "payment.retry",
        payload: {
          orderId: id,
          previousPaymentId: currentPayment.id,
          newMethod: method,
        } satisfies PaymentRetryPayload,
        customerId,
        // PaymentState the payments PolicyBundle inspects for payment.retry:
        // requirePaymentExists (exists) + retryDailyCapGuard (dailyRetryCount).
        // exists:true — the active payment was just fetched + status-checked above.
        // dailyRetryCount omitted (⇒ 0): the kernel's per-day cap stays dormant so
        // post-flip behaviour matches the legacy per-order 10-attempt cap (HTTP,
        // above). Wiring the real per-day counter is a Phase-C follow-up — a
        // NET-NEW guard the legacy route never had, so dormant ≠ regression.
        state: { ctx: { actor: { principal: "user", id: customerId }, exists: true } },
        legacy: () =>
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
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);

      const result = outcome.result;
      if (result.kind === "orphaned") {
        // Both create and compensation failed — actionable error, not a 500.
        return reply.code(503).send({
          error: "Não foi possível criar a nova tentativa de pagamento. Tente novamente em instantes.",
          code: "PAYMENT_RETRY_FAILED",
        });
      }

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
      const redis = await getRedisClient();
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

      // Per-order limit: 5 total regenerations
      if (currentPayment.regenerationCount >= 5) {
        return reply.code(429).send({
          error: "Limite de regenerações para este pedido atingido.",
          code: "ORDER_REGEN_LIMIT",
        });
      }

      // RC-A1 Phase B — gate the PIX regeneration (cancel-old + create-new
      // compensating sequence, P1-ERR-PAYSWITCH) through the conductor;
      // byte-equivalent legacy path while inert. HTTP-layer guards above (3/hr +
      // 5/order regen caps, PIX method, expired status) stay OUTSIDE the
      // adjudicated mutation. Method is always pix, so replacement == compensation.
      const outcome = await adjudicateCustomerMutation({
        kind: "payment.pix.regenerate",
        payload: {
          orderId: id,
          paymentId: currentPayment.id,
          currentRegenerationCount: currentPayment.regenerationCount,
        } satisfies PaymentPixRegeneratePayload,
        customerId,
        // PaymentState for payment.pix.regenerate: requirePaymentExists (exists)
        // + regenerationCountCapGuard (state.regenerationCount vs payload snapshot,
        // cap 5). State count === payload snapshot ⇒ no divergence refuse; the cap
        // boundary (refuse at count ≥ 5) matches the legacy 5/order HTTP guard.
        state: {
          ctx: {
            actor: { principal: "user", id: customerId },
            exists: true,
            regenerationCount: currentPayment.regenerationCount,
          },
        },
        legacy: () =>
          replaceActivePayment({
            paymentCmdSvc,
            orderId: id,
            currentPaymentId: currentPayment.id,
            currentMethod: "pix",
            newMethod: "pix",
            amountInCentavos: currentPayment.amountInCentavos,
            customerId,
            cancelReason: "Regeneração de PIX",
            log: server.log,
          }),
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);

      const result = outcome.result;
      if (result.kind === "orphaned") {
        // Both create and compensation failed — actionable error, not a 500.
        return reply.code(503).send({
          error: "Não foi possível gerar um novo QR code PIX. Tente novamente em instantes.",
          code: "PIX_REGEN_FAILED",
        });
      }

      // Increment regeneration count on whichever payment is now active.
      await prisma.payment.update({
        where: { id: result.payment.id },
        data: { regenerationCount: currentPayment.regenerationCount + 1 },
      });

      return reply.send({
        success: true,
        paymentId: result.payment.id,
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

      // Atomic switch via switching_method → cancel old → create new, with a
      // compensating re-create of the ORIGINAL method on create() failure so the
      // customer is never left with no active payment (P1-ERR-PAYSWITCH).
      // Held under the per-payment lock (cycle-2 invariant) so the whole
      // cancel→create→compensate sequence is serialized.
      const currentMethod = currentPayment.method as PaymentMethodLiteral;
      const doSwitch = () => withLock(`payment:${currentPayment.id}`, async () => {
        const replaced = await replaceActivePayment({
          paymentCmdSvc,
          orderId: id,
          currentPaymentId: currentPayment.id,
          currentMethod,
          newMethod,
          amountInCentavos: currentPayment.amountInCentavos,
          customerId,
          cancelReason: `Troca de método: ${currentMethod} → ${newMethod}`,
          // Transition old payment → switching_method before canceling.
          preCancel: canTransitionPayment(currentPayment.status as PaymentStatus, PaymentStatus.SWITCHING_METHOD)
            ? async () => {
                await paymentCmdSvc.transitionStatus(currentPayment.id, {
                  newStatus: PaymentStatus.SWITCHING_METHOD,
                  actor: "customer",
                  actorId: customerId,
                  reason: `Troca de ${currentMethod} para ${newMethod}`,
                });
              }
            : undefined,
          log: server.log,
        });

        // Only emit method_changed when the NEW method actually became active.
        // On compensation the original method is restored, so the method did
        // NOT change and no event is published.
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
      }, 15);

      // RC-A1 Phase B — authorize-then-mutate: adjudicate the switch, then run the
      // locked compensating sequence (doSwitch) ONLY on EXECUTE. Byte-equivalent
      // legacy path while inert.
      const outcome = await adjudicateCustomerMutation({
        kind: "payment.method.switch",
        payload: {
          orderId: id,
          fromMethod: currentMethod,
          toMethod: newMethod,
          customerId,
        } satisfies PaymentMethodSwitchPayload,
        customerId,
        // PaymentState for payment.method.switch: NOT in requirePaymentExists (the
        // kind can run before the new method's row exists); only validateMethodSwitch
        // fires (methods valid + different) — a strict subset of the HTTP guards above.
        state: {
          ctx: {
            actor: { principal: "user", id: customerId },
            exists: true,
            currentStatus: currentPayment.status,
            currentMethod,
          },
        },
        legacy: doSwitch,
      });
      if (!outcome.ran) return replyForIntent(reply, outcome.intent);

      const result = outcome.result;
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

      // RC-A1 Phase B — single-call order mutation through the lazy-conductor;
      // byte-equivalent legacy path while inert.
      try {
        const a = request.body.address;
        const outcome = await adjudicateCustomerMutation({
          kind: "order.address.change",
          // Map the HTTP address shape onto the canonical pack payload (the
          // envelope is the adjudicated/audited representation; the legacy
          // closure performs the mutation with the original HTTP shape).
          payload: {
            orderId: id,
            address: {
              street: a.address1,
              complement: a.address2,
              neighborhood: a.neighborhood,
              city: a.city,
              state: a.state,
              zip: a.postalCode,
            },
          } satisfies OrderAddressChangePayload,
          customerId,
          state: { ctx: { channel: "web", customerId, cartId: null, orderId: id } },
          legacy: () =>
            changeDeliveryAddress({ orderId: id, address: request.body.address }, apiContext(customerId)),
        });
        if (!outcome.ran) return replyForIntent(reply, outcome.intent);
        const result = outcome.result;
        if (!result.success) {
          return reply.code(422).send({ error: result.message, needsEscalation: result.needsEscalation });
        }
        return reply.send(result);
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

      // RC-A1 Phase B — single-call order mutation through the lazy-conductor;
      // byte-equivalent legacy path while inert.
      try {
        const outcome = await adjudicateCustomerMutation({
          kind: "order.type.switch",
          // HTTP vocab (delivery|pickup|dine_in) collapses to the pack's binary
          // newType (delivery|takeout); httpVocab preserves the original for audit.
          payload: {
            orderId: id,
            newType: request.body.type === "delivery" ? "delivery" : "takeout",
            httpVocab: request.body.type,
          } satisfies OrderTypeSwitchPayload,
          customerId,
          state: { ctx: { channel: "web", customerId, cartId: null, orderId: id } },
          legacy: () =>
            switchOrderType({ orderId: id, newType: request.body.type }, apiContext(customerId)),
        });
        if (!outcome.ran) return replyForIntent(reply, outcome.intent);
        const result = outcome.result;
        if (!result.success) {
          return reply.code(422).send({ error: result.message, needsEscalation: result.needsEscalation });
        }
        return reply.send(result);
      } catch (err) {
        if (err instanceof Error && err.name === "NonRetryableError") {
          return reply.code(422).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
