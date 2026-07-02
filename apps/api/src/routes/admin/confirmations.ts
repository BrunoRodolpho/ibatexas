// Pending admin-confirmation queue (OPS-071 / review B2).
//
// The four destructive force-* routes (force-cancel / waive / refund /
// force-status) run a two-person protocol: step 1 parks a receipt in the
// admin-confirmation store and returns 202; a DIFFERENT operator must
// confirm within the TTL. Until now the receipt id lived only in the
// step-1 response — a second operator had no way to discover what was
// awaiting confirmation. This route surfaces the queue:
//
//   GET /api/admin/confirmations — pending receipts awaiting a second
//   operator (confirmationId, action kind/route, orderId, params,
//   requestedBy, createdAt/expiresAt, prompt).
//
// Manager-gated (requireManagerRole) on top of the parent adminRoutes
// DOM-001 guard — same posture as the escalation queue: the receipts
// reference money operations and staff identities. The payload `params`
// carry only what step 1 stored for display/dispatch (orderId, target
// status, amounts) — never credentials; the `nonce` is deliberately NOT
// exposed (it feeds the audit intentHash reconstruction, and the queue
// only needs the confirmationId).

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import {
  ADMIN_CONFIRMATION_TTL_SECONDS,
  createAdminConfirmationStore,
} from "./admin-confirmation-store.js";

const PendingConfirmationSchema = z.object({
  confirmationId: z.string(),
  /** The intent kind step 2 will dispatch (e.g. "order.status.transition"). */
  kind: z.string(),
  /** The route key, e.g. "force-cancel" — which confirm endpoint to hit. */
  route: z.string(),
  orderId: z.string(),
  /** The stored envelope payload (display params — no secrets, no nonce). */
  params: z.record(z.string(), z.unknown()),
  /** Step-1 operator (staffId) — the confirmer must be someone ELSE. */
  requestedBy: z.string().nullable(),
  prompt: z.string(),
  createdAt: z.string(),
  /** createdAt + TTL — the receipt Redis key expires at this instant. */
  expiresAt: z.string().nullable(),
  refundAmountCentavos: z.number().int().optional(),
  reason: z.string().optional(),
});

/** createdAt + TTL; null when createdAt is unparseable (defensive). */
function expiresAtFrom(createdAt: string): string | null {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return null;
  return new Date(createdMs + ADMIN_CONFIRMATION_TTL_SECONDS * 1000).toISOString();
}

export async function adminConfirmationRoutes(
  server: FastifyInstance,
): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const store = createAdminConfirmationStore();

  app.get(
    "/api/admin/confirmations",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Confirmações pendentes (regra de dois operadores)",
        response: {
          200: z.object({
            confirmations: z.array(PendingConfirmationSchema),
          }),
        },
      },
    },
    async (_request, reply) => {
      const pending = await store.listPending();
      return reply.send({
        confirmations: pending.map(({ confirmationId, pending: p }) => ({
          confirmationId,
          kind: p.kind,
          route: p.route,
          orderId: p.orderId,
          params: p.payload,
          requestedBy: p.staffId,
          prompt: p.prompt,
          createdAt: p.createdAt,
          expiresAt: expiresAtFrom(p.createdAt),
          ...(p.refundAmountCentavos === undefined
            ? {}
            : { refundAmountCentavos: p.refundAmountCentavos }),
          ...(p.reason === undefined ? {} : { reason: p.reason }),
        })),
      });
    },
  );
}
