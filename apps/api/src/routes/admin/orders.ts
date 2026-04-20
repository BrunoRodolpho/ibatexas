import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { OrderFulfillmentStatus } from "@ibatexas/types";
import { reaisToCentavos, getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import {
  createOrderCommandService,
  createOrderQueryService,
  createPaymentQueryService,
  ConcurrencyError,
  ProjectionNotFoundError,
  InvalidTransitionError,
} from "@ibatexas/domain";

/** Returns true when the projection table has not been migrated yet (P2021). */
function isTableMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2021";
}
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { medusaAdmin } from "./_shared.js";

const OrdersAdminQuery = z.object({
  status: z.string().optional(),
  payment_status: z.string().optional(),
  fulfillment_status: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const OrderParams = z.object({ id: z.string().min(1) });

const FULFILLMENT_VALUES = Object.values(OrderFulfillmentStatus) as [string, ...string[]];

const OrderPatchBody = z.object({
  fulfillment_status: z.enum(FULFILLMENT_VALUES).optional(),
  version: z.number().int(), // optimistic concurrency — required
});

export async function orderRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const commandSvc = createOrderCommandService();
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
      const { fulfillment_status, payment_status, date_from, date_to, limit, offset } = request.query;

      try {
        // Primary: read from projection
        try {
          const { orders, count } = await querySvc.listAll({
            fulfillmentStatus: fulfillment_status,
            paymentStatus: payment_status,
            dateFrom: date_from ? new Date(date_from) : undefined,
            dateTo: date_to ? new Date(date_to) : undefined,
            limit,
            offset,
          });

          // Projection query succeeded — use results even if empty
          const orderIds = orders.map((o) => o.id);
          const payments = orderIds.length > 0
            ? await Promise.all(
                orderIds.map((oid) => paymentQuerySvc.getActiveByOrderId(oid).catch(() => null)),
              )
            : [];
          const paymentByOrder = new Map(orderIds.map((oid, i) => [oid, payments[i]]));

          const mapped = orders.map((o) => {
            const cp = paymentByOrder.get(o.id);
            return {
              id: o.id,
              display_id: o.displayId,
              email: o.customerEmail ?? "—",
              customer: o.customerName
                ? { first_name: o.customerName, email: o.customerEmail ?? undefined, phone: o.customerPhone ?? undefined }
                : undefined,
              items: Array.isArray(o.itemsJson)
                ? (o.itemsJson as Array<Record<string, unknown>>).map((i, idx) => ({
                    ...i,
                    id: (i as { variantId?: string }).variantId ?? `item-${idx}`,
                    unit_price: (i as { priceInCentavos?: number }).priceInCentavos ?? 0,
                  }))
                : [],
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

        const data = await medusaAdmin(`/admin/orders?${qs}`) as Record<string, unknown>;
        const rawOrders = (data.orders ?? []) as Array<Record<string, unknown>>;
        const fallbackOrders = rawOrders.map((o) => ({
          ...o,
          total: reaisToCentavos((o.total as number) ?? 0),
          subtotal: reaisToCentavos((o.subtotal as number) ?? 0),
          shipping_total: reaisToCentavos((o.shipping_total as number) ?? 0),
          items: Array.isArray(o.items)
            ? (o.items as Array<Record<string, unknown>>).map((i) => ({
                ...i,
                unit_price: reaisToCentavos((i.unit_price as number) ?? 0),
              }))
            : o.items,
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
            return reply.send({
              order: {
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
                items: Array.isArray(projection.itemsJson)
                  ? (projection.itemsJson as Array<Record<string, unknown>>).map((i, idx) => ({
                      ...i,
                      id: (i as { variantId?: string }).variantId ?? `item-${idx}`,
                      unit_price: (i as { priceInCentavos?: number }).priceInCentavos ?? 0,
                    }))
                  : [],
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
              },
            });
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
        // Normalize status: if Medusa says "canceled", ensure both fields agree
        const canonicalStatus = (order.status === "canceled")
          ? "canceled"
          : ((order.fulfillment_status as string) ?? (order.status as string) ?? "pending");
        const orderResponse = {
          ...order,
          status: canonicalStatus,
          fulfillment_status: canonicalStatus,
          total: reaisToCentavos((order.total as number) ?? 0),
          subtotal: reaisToCentavos((order.subtotal as number) ?? 0),
          shipping_total: reaisToCentavos((order.shipping_total as number) ?? 0),
          items: Array.isArray(order.items)
            ? (order.items as Array<Record<string, unknown>>).map((i) => ({
                ...i,
                unit_price: reaisToCentavos((i.unit_price as number) ?? 0),
              }))
            : order.items,
          source: "medusa_fallback" as const,
        };
        return reply.send({ order: orderResponse });
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
        if (requestId) {
          const redis = await getRedisClient();
          const dedupKey = rk(`order:status:dedup:${requestId}`);
          const isNew = await redis.set(dedupKey, "1", { EX: 300, NX: true });
          if (!isNew) {
            return reply.code(409).send({ error: "Requisicao duplicada." });
          }
        }

        let transitionResult: { version: number; previousStatus: string; newStatus: string } | null = null;
        let displayId: number | undefined;
        let customerId: string | null = null;
        let usedProjection = true;

        if (fulfillment_status) {
          try {
            // Primary: transition via projection (validates, updates, audits in one transaction)
            transitionResult = await commandSvc.transitionStatus(id, {
              newStatus: fulfillment_status as OrderFulfillmentStatus,
              actor: "admin",
              expectedVersion: clientVersion,
            });

            // Fetch displayId + customerId from projection for the event
            const projection = await querySvc.getById(id);
            displayId = projection?.displayId;
            customerId = projection?.customerId ?? null;
          } catch (err) {
            if (err instanceof ConcurrencyError) {
              return reply.code(409).send({ error: "Pedido foi atualizado por outro atendente." });
            }
            if (err instanceof InvalidTransitionError) {
              return reply.code(422).send({
                error: "Transicao de status invalida.",
                from: err.from,
                to: err.to,
              });
            }
            if (err instanceof ProjectionNotFoundError || isTableMissing(err)) {
              // Grace period fallback: projection not populated yet or table missing, use Medusa
              usedProjection = false;
              server.log.warn({ orderId: id }, "projection_fallback_used — PATCH order");
            } else {
              throw err;
            }
          }
        }

        // Fallback: if projection not found, use Medusa path (backward compat during backfill)
        if (!usedProjection || !fulfillment_status) {
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
            return reply.code(404).send({ error: "Pedido nao encontrado." });
          }

          if (fulfillment_status) {
            const from = currentOrder.fulfillment_status as OrderFulfillmentStatus;
            const to = fulfillment_status as OrderFulfillmentStatus;
            const { canTransition } = await import("@ibatexas/types");
            if (!canTransition(from, to)) {
              return reply.code(422).send({ error: "Transicao de status invalida.", from, to });
            }
            transitionResult = { version: 1, previousStatus: from, newStatus: to };
          }

          displayId = currentData.order?.display_id;
          customerId = currentData.order?.metadata?.["customerId"] ?? currentData.order?.customer?.id ?? null;
        }

        // Publish NATS event (fire-and-forget, outbox-backed for durability)
        if (transitionResult && fulfillment_status) {
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
            server.log.error(err, "Failed to publish order.status_changed event");
          });

          // Structured log for observability
          server.log.info(
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

        // Return the updated projection (or Medusa data as fallback)
        try {
          const updatedProjection = await querySvc.getById(id);
          if (updatedProjection) {
            return reply.send({
              order: {
                id: updatedProjection.id,
                display_id: updatedProjection.displayId,
                fulfillment_status: updatedProjection.fulfillmentStatus,
                payment_status: updatedProjection.paymentStatus,
                version: updatedProjection.version,
                source: "projection" as const,
              },
            });
          }
        } catch (projErr) {
          if (!isTableMissing(projErr)) throw projErr;
        }

        return reply.send({ order: { id, fulfillment_status, payment_status: "unknown", source: "medusa_fallback" as const } });
      } catch (err) {
        server.log.error(err, "Failed to update order");
        reply.code(502).send({ error: "Falha ao atualizar pedido." });
      }
    },
  );
}
