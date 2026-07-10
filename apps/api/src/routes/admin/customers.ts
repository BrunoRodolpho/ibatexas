// admin/customers.ts — manager-gated, READ-ONLY customer management (OPS-070).
//
// VIEW-FIRST: this route introduces NO model, NO migration and NO mutation. It
// exposes two reads, both behind `requireManagerRole` (customer PII is a
// manager-band view; the admin plugin's `onResponse` hook already audit-logs
// every admin request with the staff identity):
//
//   GET /api/admin/customers[?q=&limit=&offset=]  → paginated customer search
//   GET /api/admin/customers/:id                  → one composed customer view
//
// The list is a single compact projection (never CPF). The detail COMPOSES the
// existing @ibatexas/domain reads (customer + preferences, addresses, recent
// order projections, loyalty balance) plus the broadcast opt-out registry via
// `composeAdminCustomerDetail` — one implementation, `Promise.allSettled`
// resilient (one bad satellite read degrades that section, never 500s the view).
//
// No write path is added: the only governed customer-data write that exists
// today is broadcast opt-out/opt-in (admin/broadcast.ts), surfaced here as a
// READ-ONLY status flag; wiring it as a toggle is deferred to its own PR.

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createCustomerService,
  createOrderQueryService,
  createLoyaltyService,
} from "@ibatexas/domain";
import { buildAuditRecord, BASIS_CODES } from "@adjudicate/core";
import { getAuditSink } from "@ibatexas/audit-sink";
import { requireManagerRole, requireOwnerRole } from "../../middleware/staff-auth.js";
import { getBroadcastOptOutStore } from "../../broadcast/broadcast-optout.js";
import { composeAdminCustomerDetail } from "../../ops/admin-customer-compose.js";
import { buildSystemEnvelope } from "../../subscribers/__shared__/system-actor-envelope.js";

const ListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const IdParam = z.object({ id: z.string().min(1).max(256) });

export async function adminCustomerRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting
  // this route with a partial `@ibatexas/domain` mock doesn't trip over a
  // missing factory at register time (mirrors ops-snapshot.ts / kitchen.ts).
  let customerSvc: ReturnType<typeof createCustomerService> | undefined;
  let orderSvc: ReturnType<typeof createOrderQueryService> | undefined;
  let loyaltySvc: ReturnType<typeof createLoyaltyService> | undefined;
  const customers = () => (customerSvc ??= createCustomerService());
  const orders = () => (orderSvc ??= createOrderQueryService());
  const loyalty = () => (loyaltySvc ??= createLoyaltyService());

  // ── GET /api/admin/customers — paginated search (compact list projection) ──
  app.get(
    "/api/admin/customers",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Buscar clientes (nome, telefone ou e-mail) — somente leitura",
        querystring: ListQuery,
      },
    },
    async (request, reply) => {
      const { q, limit, offset } = request.query;
      const result = await customers().searchForAdmin({ q, limit, offset });
      return reply.send({
        customers: result.customers.map((c) => ({
          id: c.id,
          name: c.name ?? null,
          phone: c.phone,
          email: c.email ?? null,
          source: c.source ?? null,
          createdAt: c.createdAt.toISOString(),
        })),
        count: result.count,
      });
    },
  );

  // ── GET /api/admin/customers/:id — one composed customer view ──────────────
  app.get(
    "/api/admin/customers/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Ficha do cliente (perfil, endereços, pedidos, fidelidade)",
        params: IdParam,
      },
    },
    async (request, reply) => {
      const detail = await composeAdminCustomerDetail({
        customerId: request.params.id,
        customers,
        orders,
        loyalty,
        isOptedOut: async (recipient) => {
          const store = await getBroadcastOptOutStore();
          return store.isOptedOut(recipient);
        },
        log: request.log,
      });
      if (!detail) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: "Not Found", message: "Cliente não encontrado." });
      }
      return reply.send(detail);
    },
  );

  // ── GET /api/admin/customers/:id/cpf — OWNER-only, audited CPF reveal (X4) ──
  // The detail view above ships CPF masked. The full tax ID is disclosed ONLY
  // here, to an OWNER, and every reveal is audit-logged with the staff identity
  // (on top of the plugin-level onResponse audit). requireOwnerRole fail-closes
  // for MANAGER/ATTENDANT; the DOM-001 guard already blocks the shared API key
  // on this browser route, so only a real OWNER JWT reaches this handler.
  app.get(
    "/api/admin/customers/:id/cpf",
    {
      preHandler: [requireOwnerRole],
      schema: {
        tags: ["admin"],
        summary: "Revelar CPF completo do cliente (OWNER, auditado)",
        params: IdParam,
      },
    },
    async (request, reply) => {
      const customer = await customers().getByIdForAdmin(request.params.id);
      if (!customer) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: "Not Found", message: "Cliente não encontrado." });
      }
      request.log.warn(
        {
          event: "cpf_reveal",
          customerId: request.params.id,
          staffId: request.staffId,
          staffRole: request.staffRole,
        },
        "OWNER revealed a customer CPF",
      );

      // Durable audit of the sensitive-PII access — the pino warn above is
      // transient. Best-effort: an audit-sink failure / pre-boot state must NOT
      // break the reveal (the warn above is the fallback signal). NO raw CPF in
      // the record — only the customerId (UUID) + the acting staff identity.
      try {
        const auditEnvelope = buildSystemEnvelope({
          kind: "customer.cpf.reveal" as const,
          payload: {
            customerId: request.params.id,
            staffId: request.staffId ?? null,
            staffRole: request.staffRole ?? null,
          },
          sourceSubject: "admin.customers.cpf_reveal",
          eventId: `${request.params.id}:cpf_reveal:${Date.now()}`,
        });
        const record = buildAuditRecord({
          envelope: auditEnvelope,
          decision: {
            kind: "EXECUTE",
            basis: [
              {
                category: "business",
                code: BASIS_CODES.business.RULE_SATISFIED,
                detail: {
                  event: "cpf_reveal",
                  customerId: request.params.id,
                  staffId: request.staffId ?? null,
                  staffRole: request.staffRole ?? null,
                },
              },
            ],
          },
          durationMs: 0,
        });
        await getAuditSink().emit(record);
      } catch (err) {
        request.log.warn(
          {
            event: "cpf_reveal_audit_failed",
            customerId: request.params.id,
            err: (err as Error).message,
          },
          "durable CPF-reveal audit emit failed — reveal not blocked",
        );
      }

      return reply.send({ cpf: customer.cpf ?? null });
    },
  );
}
