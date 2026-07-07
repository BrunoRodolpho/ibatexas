import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { OrderFulfillmentStatus } from "@ibatexas/types";
import { reaisToCentavos, getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { buildEnvelope } from "@adjudicate/core";
import {
  createOrderCommandService,
  createOrderQueryService,
  createPaymentQueryService,
  ConcurrencyError,
  ProjectionNotFoundError,
  InvalidTransitionError,
  prisma,
  type OrderStatusTransitionPayload,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { staffRoleGuard } from "../../claustrum/staff-role-guard.js";
import { medusaAdmin } from "./_shared.js";
import {
  actorFor,
  resolveActorRole,
  type StaffActorRole,
} from "./_shared-actions.js";

/** Returns true when the projection table has not been migrated yet (P2021). */
function isTableMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2021";
}

const OrdersAdminQuery = z.object({
  status: z.string().optional(),
  payment_status: z.string().optional(),
  fulfillment_status: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  customer_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const OrderParams = z.object({ id: z.string().min(1) });

const FULFILLMENT_VALUES = Object.values(OrderFulfillmentStatus) as [string, ...string[]];

const OrderPatchBody = z.object({
  fulfillment_status: z.enum(FULFILLMENT_VALUES).optional(),
  version: z.number().int(), // optimistic concurrency — required
});

// ── Shared mappers / service-derived types ──────────────────────────────────

type OrderQuerySvc = ReturnType<typeof createOrderQueryService>;
type OrderCommandSvc = ReturnType<typeof createOrderCommandService>;
type OrderDetailProjection = NonNullable<Awaited<ReturnType<OrderQuerySvc["getById"]>>>;
type ActivePaymentRow = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createPaymentQueryService>["getActiveByOrderId"]>>
>;
type TransitionOutcome = Awaited<ReturnType<OrderCommandSvc["transitionStatusFromEnvelope"]>>;
type TransitionDecision = TransitionOutcome["decision"];
type TransitionSummary = { version: number; previousStatus: string; newStatus: string };

/** Map projection itemsJson to the admin API item shape. */
function mapProjectionItems(itemsJson: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(itemsJson)) return [];
  return (itemsJson as Array<Record<string, unknown>>).map((i, idx) => ({
    ...i,
    id: (i as { variantId?: string }).variantId ?? `item-${idx}`,
    unit_price: (i as { priceInCentavos?: number }).priceInCentavos ?? 0,
  }));
}

/** Convert Medusa fallback item prices (reais) to centavos; passthrough non-arrays. */
function mapFallbackItems(items: unknown): unknown {
  if (!Array.isArray(items)) return items;
  return (items as Array<Record<string, unknown>>).map((i) => ({
    ...i,
    unit_price: reaisToCentavos((i.unit_price as number) ?? 0),
  }));
}

/** Build the admin order-detail response from a projection row. */
function buildProjectionOrderDetail(projection: OrderDetailProjection, cp: ActivePaymentRow | null) {
  return {
    id: projection.id,
    display_id: projection.displayId,
    email: projection.customerEmail,
    customer: projection.customerName
      ? { first_name: projection.customerName, email: projection.customerEmail ?? undefined, phone: projection.customerPhone ?? undefined }
      : undefined,
    total: projection.totalInCentavos,
    subtotal: projection.subtotalInCentavos,
    shipping_total: projection.shippingInCentavos,
    status: projection.fulfillmentStatus,
    payment_status: cp ? cp.status : (projection.paymentStatus ?? null),
    fulfillment_status: projection.fulfillmentStatus,
    created_at: projection.medusaCreatedAt.toISOString(),
    items: mapProjectionItems(projection.itemsJson),
    shipping_address: projection.shippingAddressJson,
    delivery_type: projection.deliveryType ?? null,
    payment_method: cp ? cp.method : (projection.paymentMethod ?? null),
    tip_in_centavos: projection.tipInCentavos ?? 0,
    version: projection.version,
    currentPayment: cp ? {
      id: cp.id,
      method: cp.method,
      status: cp.status,
      amountInCentavos: cp.amountInCentavos,
      pixExpiresAt: cp.pixExpiresAt?.toISOString() ?? null,
      version: cp.version,
    } : null,
    statusHistory: projection.statusHistory.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      actor: h.actor,
      actorId: h.actorId,
      reason: h.reason,
      createdAt: h.createdAt.toISOString(),
    })),
    source: "projection" as const,
  };
}

/** Build the admin order-detail response from a Medusa fallback order. */
function buildFallbackOrderDetail(order: Record<string, unknown>) {
  // Normalize status: if Medusa says "canceled", ensure both fields agree
  const canonicalStatus = (order.status === "canceled")
    ? "canceled"
    : ((order.fulfillment_status as string) ?? (order.status as string) ?? "pending");
  return {
    ...order,
    status: canonicalStatus,
    fulfillment_status: canonicalStatus,
    total: reaisToCentavos((order.total as number) ?? 0),
    subtotal: reaisToCentavos((order.subtotal as number) ?? 0),
    shipping_total: reaisToCentavos((order.shipping_total as number) ?? 0),
    items: mapFallbackItems(order.items),
    source: "medusa_fallback" as const,
  };
}

// ── PATCH helpers ───────────────────────────────────────────────────────────

type PatchRespond = { kind: "respond"; code: number; body: Record<string, unknown> };
type KernelAttemptResult =
  | PatchRespond
  | {
      kind: "state";
      state: {
        usedProjection: boolean;
        transitionResult: TransitionSummary | null;
        displayId: number | undefined;
        customerId: string | null;
      };
    };
type FallbackResult =
  | PatchRespond
  | {
      kind: "state";
      state: {
        transitionResult: TransitionSummary | null;
        displayId: number | undefined;
        customerId: string | null;
      };
    };

/** Reserve the x-request-id dedup key; returns true when the request is a duplicate. */
async function isDuplicateStatusRequest(requestId: string | undefined): Promise<boolean> {
  if (!requestId) return false;
  const redis = await getRedisClient();
  const dedupKey = rk(`order:status:dedup:${requestId}`);
  const isNew = await redis.set(dedupKey, "1", { EX: 300, NX: true });
  return !isNew;
}

/** Translate a kernel decision into the refusal text, or null when execution is allowed. */
function getKernelRefusalText(decision: TransitionDecision): string | null {
  if (decision.kind === "EXECUTE" || decision.kind === "REWRITE") return null;
  if (decision.kind === "REFUSE") return decision.refusal.userFacing;
  return "Operação não permitida pela política do kernel.";
}

/** Attempt the kernel-gated status transition; returns a reply directive or state delta. */
async function attemptKernelTransition(args: {
  id: string;
  newStatus: string;
  clientVersion: number;
  requestId: string | undefined;
  staffId: string | null;
  /** WS7 / BKL-069 — authenticated staff role threaded onto actor.role. */
  staffRole: StaffActorRole | undefined;
  commandSvc: OrderCommandSvc;
  querySvc: OrderQuerySvc;
  log: FastifyInstance["log"];
}): Promise<KernelAttemptResult> {
  const { id, newStatus, clientVersion, requestId, staffId, staffRole, commandSvc, querySvc, log } = args;
  try {
    // ── Task 13/15 — kernel-gated transition via envelope ───────
    // Staff-authenticated path: principal=user, taint=TRUSTED.
    // API-key path: principal=system, taint=SYSTEM.
    const principal: "user" | "system" = staffId ? "user" : "system";
    const taint: "TRUSTED" | "SYSTEM" = staffId ? "TRUSTED" : "SYSTEM";
    const sessionId = staffId ? `admin:${staffId}` : "admin:api-key";

    const payload: OrderStatusTransitionPayload = {
      orderId: id,
      newStatus,
      actor: "admin",
      ...(staffId ? { actorId: staffId } : {}),
      expectedVersion: clientVersion,
    };
    const envelope = buildEnvelope({
      kind: "order.status.transition" as const,
      payload,
      nonce: requestId ?? randomUUID(),
      actor: actorFor({ principal, sessionId, role: staffRole }),
      taint,
    });

    const outcome = await commandSvc.transitionStatusFromEnvelope(envelope);
    const refusalText = getKernelRefusalText(outcome.decision);
    if (refusalText !== null) {
      return { kind: "respond", code: 403, body: { error: refusalText } };
    }

    // Fetch displayId + customerId from projection for the event
    const projection = await querySvc.getById(id);
    return {
      kind: "state",
      state: {
        usedProjection: true,
        transitionResult: outcome.result!,
        displayId: projection?.displayId,
        customerId: projection?.customerId ?? null,
      },
    };
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      return { kind: "respond", code: 409, body: { error: "Pedido foi atualizado por outro atendente." } };
    }
    if (err instanceof InvalidTransitionError) {
      return { kind: "respond", code: 422, body: { error: "Transicao de status invalida.", from: err.from, to: err.to } };
    }
    if (err instanceof ProjectionNotFoundError || isTableMissing(err)) {
      // Grace period fallback: projection not populated yet or table missing, use Medusa
      log.warn({ orderId: id }, "projection_fallback_used — PATCH order");
      return { kind: "state", state: { usedProjection: false, transitionResult: null, displayId: undefined, customerId: null } };
    }
    throw err;
  }
}

/** Backward-compat Medusa fallback for the PATCH path (during projection backfill). */
async function applyMedusaFallback(args: { id: string; fulfillmentStatus: string | undefined }): Promise<FallbackResult> {
  const { id, fulfillmentStatus } = args;
  const currentData = await medusaAdmin(
    `/admin/orders/${id}?fields=id,display_id,fulfillment_status,customer,metadata`,
  ) as {
    order?: {
      id: string;
      display_id: number;
      fulfillment_status: string;
      customer?: { id: string };
      metadata?: Record<string, string>;
    };
  };
  const currentOrder = currentData.order;
  if (!currentOrder) {
    return { kind: "respond", code: 404, body: { error: "Pedido nao encontrado." } };
  }

  let transitionResult: TransitionSummary | null = null;
  if (fulfillmentStatus) {
    const from = currentOrder.fulfillment_status as OrderFulfillmentStatus;
    const to = fulfillmentStatus as OrderFulfillmentStatus;
    const { canTransition } = await import("@ibatexas/types");
    if (!canTransition(from, to)) {
      return { kind: "respond", code: 422, body: { error: "Transicao de status invalida.", from, to } };
    }
    transitionResult = { version: 1, previousStatus: from, newStatus: to };
  }

  const displayId = currentData.order?.display_id;
  const customerId = currentData.order?.metadata?.["customerId"] ?? currentData.order?.customer?.id ?? null;
  return { kind: "state", state: { transitionResult, displayId, customerId } };
}

/** Fire-and-forget NATS publish + structured log for a completed transition. */
function publishOrderStatusChanged(args: {
  log: FastifyInstance["log"];
  id: string;
  displayId: number | undefined;
  customerId: string | null;
  requestId: string | undefined;
  transitionResult: TransitionSummary;
}): void {
  const { log, id, displayId, customerId, requestId, transitionResult } = args;
  publishNatsEvent("order.status_changed", {
    orderId: id,
    displayId: displayId ?? 0,
    previousStatus: transitionResult.previousStatus as OrderFulfillmentStatus,
    newStatus: transitionResult.newStatus as OrderFulfillmentStatus,
    customerId,
    updatedBy: "admin",
    version: transitionResult.version,
    correlationId: requestId,
    timestamp: new Date().toISOString(),
  }).catch((err) => {
    log.error(err, "Failed to publish order.status_changed event");
  });

  // Structured log for observability
  log.info(
    {
      event: "order.status_transition",
      orderId: id,
      from: transitionResult.previousStatus,
      to: transitionResult.newStatus,
      version: transitionResult.version,
      actor: "admin",
      correlationId: requestId,
    },
    "Order status transitioned",
  );
}

/** Load the updated order response from the projection, or null to use the fallback. */
async function loadUpdatedOrderResponse(querySvc: OrderQuerySvc, id: string) {
  try {
    const updatedProjection = await querySvc.getById(id);
    if (updatedProjection) {
      return {
        id: updatedProjection.id,
        display_id: updatedProjection.displayId,
        fulfillment_status: updatedProjection.fulfillmentStatus,
        payment_status: updatedProjection.paymentStatus,
        version: updatedProjection.version,
        source: "projection" as const,
      };
    }
    return null;
  } catch (projErr) {
    if (!isTableMissing(projErr)) throw projErr;
    return null;
  }
}

export async function orderRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  // Defer audit-sink resolution to onReady (see adminPaymentRoutes for
  // the full rationale — boot-order race between plugin-body execution
  // during buildServer() and bootstrapAuditSinkDI() in index.ts).
  let commandSvc!: ReturnType<typeof createOrderCommandService>;
  server.addHook("onReady", async () => {
    commandSvc = createOrderCommandService(server.log, {
      auditSink: getAuditSink(),
      // BKL-074 — kernel role backstop: staffRoleGuard gates the admin
      // order.status.transition path (inert unless an `admin:` envelope).
      authGuards: [staffRoleGuard],
    });
  });
  const querySvc = createOrderQueryService();
  const paymentQuerySvc = createPaymentQueryService();

  // ── GET /api/admin/orders ──────────────────────────────────────────────────
  app.get(
    "/api/admin/orders",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar pedidos (admin)",
        querystring: OrdersAdminQuery,
      },
    },
    async (request, reply) => {
      const { fulfillment_status, payment_status, date_from, date_to, customer_id, limit, offset } = request.query;

      try {
        // Primary: read from projection
        try {
          const { orders, count } = await querySvc.listAll({
            fulfillmentStatus: fulfillment_status,
            paymentStatus: payment_status,
            dateFrom: date_from ? new Date(date_from) : undefined,
            dateTo: date_to ? new Date(date_to) : undefined,
            customerId: customer_id,
            limit,
            offset,
          });

          // Projection query succeeded — use results even if empty.
          // N1PAY: resolve the active payment for every listed order in ONE batched
          // query (getActiveByOrderIds) instead of N getActiveByOrderId calls. A
          // lookup failure degrades gracefully — the list still renders and
          // currentPayment is null, so payment_status falls back to the projection
          // (matching the prior per-order `.catch(() => null)` resilience).
          const orderIds = orders.map((o) => o.id);
          let paymentByOrder: Awaited<ReturnType<typeof paymentQuerySvc.getActiveByOrderIds>> = new Map();
          if (orderIds.length > 0) {
            try {
              paymentByOrder = await paymentQuerySvc.getActiveByOrderIds(orderIds);
            } catch (err) {
              server.log.warn({ err }, "active-payment batch lookup failed — orders list renders without currentPayment");
            }
          }

          const mapped = orders.map((o) => {
            const cp = paymentByOrder.get(o.id);
            return {
              id: o.id,
              display_id: o.displayId,
              email: o.customerEmail ?? "—",
              customer: o.customerName
                ? { first_name: o.customerName, email: o.customerEmail ?? undefined, phone: o.customerPhone ?? undefined }
                : undefined,
              items: mapProjectionItems(o.itemsJson),
              total: o.totalInCentavos,
              subtotal: o.subtotalInCentavos,
              shipping_total: o.shippingInCentavos,
              status: o.fulfillmentStatus,
              payment_status: cp ? cp.status : (o.paymentStatus ?? "—"),
              fulfillment_status: o.fulfillmentStatus,
              created_at: o.medusaCreatedAt.toISOString(),
              delivery_type: o.deliveryType ?? null,
              payment_method: cp ? cp.method : (o.paymentMethod ?? null),
              tip_in_centavos: o.tipInCentavos ?? 0,
              version: o.version,
              currentPayment: cp ? {
                id: cp.id,
                method: cp.method,
                status: cp.status,
                amountInCentavos: cp.amountInCentavos,
                version: cp.version,
              } : null,
              source: "projection" as const,
            };
          });
          return reply.send({ orders: mapped, count });
        } catch (projErr) {
          if (!isTableMissing(projErr)) throw projErr;
          server.log.warn("projection_table_missing — falling back to Medusa for orders list");
        }

        // Fallback: projection table missing — read from Medusa
        server.log.warn({ offset, limit }, "projection_fallback_used — admin orders list");
        const qs = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
          fields:
            "id,display_id,email,customer,items,total,status,payment_status,fulfillment_status,created_at",
          expand: "items,customer",
        });
        if (fulfillment_status) qs.set("fulfillment_status[]", fulfillment_status);
        if (payment_status) qs.set("payment_status[]", payment_status);
        if (date_from) qs.set("created_at[gte]", date_from);
        if (date_to) qs.set("created_at[lte]", date_to);
        // S11 — the incoming customer_id is a DOMAIN Customer.id (cuid), but Medusa's
        // ?customer_id expects the Medusa customer id (cus_*). Forwarding the cuid
        // verbatim matched nothing (silent wrong-empty). Translate via
        // Customer.medusaId; a customer with no Medusa mapping (or none at all) can
        // have no Medusa orders, so return an empty page honestly rather than
        // forwarding an id from the wrong space.
        if (customer_id) {
          const customer = await prisma.customer.findUnique({
            where: { id: customer_id },
            select: { medusaId: true },
          });
          if (!customer?.medusaId) {
            return reply.send({ orders: [], count: 0 });
          }
          qs.set("customer_id", customer.medusaId);
        }

        const data = await medusaAdmin(`/admin/orders?${qs}`) as Record<string, unknown>;
        const rawOrders = (data.orders ?? []) as Array<Record<string, unknown>>;
        const fallbackOrders = rawOrders.map((o) => ({
          ...o,
          total: reaisToCentavos((o.total as number) ?? 0),
          subtotal: reaisToCentavos((o.subtotal as number) ?? 0),
          shipping_total: reaisToCentavos((o.shipping_total as number) ?? 0),
          items: mapFallbackItems(o.items),
          source: "medusa_fallback" as const,
        }));
        return reply.send({ orders: fallbackOrders, count: data.count ?? 0 });
      } catch (err) {
        server.log.error(err, "Failed to fetch orders");
        reply.code(502).send({ error: "Falha ao buscar pedidos." });
      }
    },
  );

  // ── GET /api/admin/orders/:id ─────────────────────────────────────────────
  app.get(
    "/api/admin/orders/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Detalhes do pedido (admin)",
        params: OrderParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        // Primary: read from projection
        try {
          const projection = await querySvc.getById(id);

          if (projection) {
            const cp = await paymentQuerySvc.getActiveByOrderId(id).catch(() => null);
            return reply.send({ order: buildProjectionOrderDetail(projection, cp) });
          }
        } catch (projErr) {
          if (!isTableMissing(projErr)) throw projErr;
          server.log.warn({ orderId: id }, "projection_table_missing — falling back to Medusa for order detail");
        }

        // Fallback: projection not found or table missing — read from Medusa
        server.log.warn({ orderId: id }, "projection_fallback_used — order detail");
        const data = await medusaAdmin(
          `/admin/orders/${id}?fields=id,display_id,email,total,subtotal,shipping_total,status,payment_status,fulfillment_status,created_at,metadata&expand=items,customer,shipping_address`,
        ) as Record<string, unknown>;
        const order = data.order as Record<string, unknown> | undefined;
        if (!order) {
          return reply.code(404).send({ error: "Pedido nao encontrado." });
        }
        return reply.send({ order: buildFallbackOrderDetail(order) });
      } catch (err) {
        server.log.error(err, "Failed to fetch order detail");
        reply.code(502).send({ error: "Falha ao buscar detalhes do pedido." });
      }
    },
  );

  // ── PATCH /api/admin/orders/:id ───────────────────────────────────────────
  app.patch(
    "/api/admin/orders/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Atualizar pedido (admin)",
        params: OrderParams,
        body: OrderPatchBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { fulfillment_status, version: clientVersion } = request.body;
      const requestId = request.headers["x-request-id"] as string | undefined;

      try {
        // Idempotency guard via x-request-id (catches double-clicks)
        if (await isDuplicateStatusRequest(requestId)) {
          return reply.code(409).send({ error: "Requisicao duplicada." });
        }

        let transitionResult: TransitionSummary | null = null;
        let displayId: number | undefined;
        let customerId: string | null = null;
        let usedProjection = true;

        if (fulfillment_status) {
          const attempt = await attemptKernelTransition({
            id,
            newStatus: fulfillment_status,
            clientVersion,
            requestId,
            staffId: request.staffId ?? null,
            staffRole: resolveActorRole(request),
            commandSvc,
            querySvc,
            log: server.log,
          });
          if (attempt.kind === "respond") {
            return reply.code(attempt.code).send(attempt.body);
          }
          ({ usedProjection, transitionResult, displayId, customerId } = attempt.state);
        }

        // Fallback: if projection not found, use Medusa path (backward compat during backfill)
        if (!usedProjection || !fulfillment_status) {
          const fallback = await applyMedusaFallback({ id, fulfillmentStatus: fulfillment_status });
          if (fallback.kind === "respond") {
            return reply.code(fallback.code).send(fallback.body);
          }
          ({ transitionResult, displayId, customerId } = fallback.state);
        }

        // Publish NATS event (fire-and-forget, outbox-backed for durability)
        if (transitionResult && fulfillment_status) {
          publishOrderStatusChanged({ log: server.log, id, displayId, customerId, requestId, transitionResult });
        }

        // Return the updated projection (or Medusa data as fallback)
        const updated = await loadUpdatedOrderResponse(querySvc, id);
        if (updated) {
          return reply.send({ order: updated });
        }

        return reply.send({ order: { id, fulfillment_status, payment_status: "unknown", source: "medusa_fallback" as const } });
      } catch (err) {
        server.log.error(err, "Failed to update order");
        reply.code(502).send({ error: "Falha ao atualizar pedido." });
      }
    },
  );
}
