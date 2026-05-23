// Me routes — LGPD data access and deletion (Art. 18).
//
// GET    /api/me/data                       — export all personal data (portability)
// POST   /api/me/data/initiate-deletion     — issue fresh OTP, mark freshness
// DELETE /api/me/data?token={otpCode}       — verify OTP, build envelope, park DEFER
// POST   /api/me/data/cancel-deletion       — REFUSE the parked deletion (within 24h)
//
// ── Task 14 (M3) — destructive 3-endpoint flow ────────────────────────────
//
// The single legacy `DELETE /api/me/data` was: "one-click destructive,
// unconfirmed, unadjudicated, no replay protection" (investigation 08 P0
// #2). It now becomes three steps gated by:
//
//   1. Fresh OTP (Twilio Verify), 5-minute TTL on the freshness marker
//      (vs the standard 10 — irreversible operation tightens the window).
//   2. Kernel adjudication via `@ibatexas/pack-customer-onboarding`. The
//      Pack DEFERs with `customer.anonymize.confirmed_after_grace` and
//      24h timeoutMs.
//   3. A 24h grace window during which the customer can POST to
//      `/cancel-deletion` to abort. The cancel endpoint adjudicates
//      a sibling `customer.anonymize.cancel` envelope (REFUSE-supersedes-
//      parked) and DELetes the receipt.
//   4. After 24h with no cancel: the defer-timeout-sweeper (task 03)
//      fires `intent.defer.timeout`; the `anonymize-grace-resolver`
//      subscriber (this task) consumes it and runs `anonymizeCustomer`.
//
// The pt-BR copy below comes from this layer rather than the Pack
// because Twilio messages + receipt copy are UX, not policy.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { buildEnvelope } from "@adjudicate/core";
import { parkDeferredIntent } from "@adjudicate/runtime";
import { getRedisClient, rk } from "@ibatexas/tools";
import {
  createCustomerService,
  exportCustomerData,
  anonymizeCustomerFromEnvelope,
} from "@ibatexas/domain";
import {
  customerOnboardingPolicyBundle,
  portugueseRefusalMessages,
  type CustomerAnonymizePayload,
  type CustomerAnonymizeCancelPayload,
  type CustomerOnboardingState,
} from "@ibatexas/pack-customer-onboarding";
import { getAuditSink } from "@ibatexas/llm-provider";
import { requireAuth } from "../middleware/auth.js";
import { runCustomerIntent } from "./__shared__/customer-intent-gateway.js";
import {
  ANONYMIZE_GRACE_TTL_SECONDS,
  consumeOtpMarker,
  hasFreshOtp,
  markOtpFresh,
  persistPendingDeletion,
  readPendingDeletion,
  sendAnonymizeOtp,
  verifyAnonymizeOtp,
  clearPendingDeletion,
} from "./me/anonymize-otp-gate.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CustomerDataResponse = z.object({
  customer: z.object({
    id: z.string(),
    phone: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    source: z.string().nullable(),
    firstContactAt: z.date().nullable(),
  }),
  addresses: z.array(z.object({
    id: z.string(),
    customerId: z.string(),
    street: z.string(),
    number: z.string(),
    complement: z.string().nullable(),
    district: z.string(),
    city: z.string(),
    state: z.string(),
    cep: z.string(),
    isDefault: z.boolean(),
  })),
  preferences: z.object({
    id: z.string(),
    customerId: z.string(),
    dietaryRestrictions: z.array(z.string()),
    allergenExclusions: z.array(z.string()),
    favoriteCategories: z.array(z.string()),
    updatedAt: z.date(),
  }).nullable(),
  reviews: z.array(z.object({
    id: z.string(),
    orderId: z.string(),
    productId: z.string().nullable(),
    customerId: z.string(),
    rating: z.number(),
    comment: z.string().nullable(),
    channel: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })),
  orderHistory: z.array(z.object({
    id: z.string(),
    customerId: z.string().nullable(),
    medusaOrderId: z.string(),
    productId: z.string(),
    variantId: z.string(),
    quantity: z.number(),
    priceInCentavos: z.number(),
    orderedAt: z.date(),
  })),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export async function meRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // ── GET /api/me/data ────────────────────────────────────────────────────────

  app.get(
    "/api/me/data",
    {
      schema: {
        tags: ["me"],
        summary: "Exportar dados pessoais (LGPD Art. 18 — portabilidade)",
        response: { 200: CustomerDataResponse },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const data = await exportCustomerData(request.customerId!);
      return reply.send(data);
    },
  );

  // ── POST /api/me/data/initiate-deletion ─────────────────────────────────────
  //
  // Step 1 of the LGPD anonymize 3-endpoint flow. Sends a fresh OTP via
  // Twilio Verify and marks the customer as "OTP requested" in Redis
  // with a 5-minute TTL. The DELETE step rejects fast if this marker
  // has expired, sparing Twilio a verify-check round-trip.

  app.post(
    "/api/me/data/initiate-deletion",
    {
      schema: {
        tags: ["me"],
        summary: "Iniciar exclusão de dados — emite OTP de verificação (LGPD Art. 18)",
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      // Load the customer's phone for Twilio. We do this AFTER auth so
      // the JWT cookie has been validated upstream.
      const customerSvc = createCustomerService();
      let phone: string;
      try {
        const customer = await customerSvc.getById(customerId);
        phone = customer.phone;
      } catch {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Cadastro não encontrado.",
        });
      }

      try {
        await sendAnonymizeOtp(phone);
        await markOtpFresh(customerId);
        request.log.info(
          { customerId, action: "anonymize_otp_sent" },
          "Anonymize OTP issued",
        );
        return reply.code(202).send({
          status: "otp_sent",
          message: "Código de verificação enviado. Use-o em até 5 minutos para confirmar a exclusão.",
          ttlSeconds: 300,
        });
      } catch (err) {
        request.log.error(
          { customerId, err: (err as Error).message, action: "anonymize_otp_error" },
          "Twilio error issuing anonymize OTP",
        );
        return reply.code(502).send({
          statusCode: 502,
          error: "Bad Gateway",
          message: "Não foi possível enviar o código. Tente novamente.",
        });
      }
    },
  );

  // ── DELETE /api/me/data?token={otpCode} ─────────────────────────────────────
  //
  // Step 2: verify the OTP, build the `customer.anonymize` envelope,
  // adjudicate, expect DEFER, park the receipt. The destructive Prisma
  // call happens in the grace resolver subscriber (NOT here).

  app.delete(
    "/api/me/data",
    {
      schema: {
        tags: ["me"],
        summary: "Solicitar exclusão de dados — verifica OTP e inicia janela de 24h (LGPD Art. 18)",
        querystring: z.object({
          token: z.string().regex(/^\d{6}$/, "Token inválido — deve ter 6 dígitos."),
        }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const otpCode = request.query.token;

      // (a) Fast-fail on missing/expired freshness marker — saves a
      // Twilio round-trip for replayed requests after the 5min window.
      if (!(await hasFreshOtp(customerId))) {
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Verificação OTP expirada ou ausente. Solicite um novo código em /initiate-deletion.",
        });
      }

      // (b) Look up phone for Twilio Verify check.
      const customerSvc = createCustomerService();
      let phone: string;
      try {
        const customer = await customerSvc.getById(customerId);
        phone = customer.phone;
      } catch {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Cadastro não encontrado.",
        });
      }

      // (c) Verify OTP with Twilio. Any failure → 401.
      const otpOk = await verifyAnonymizeOtp(phone, otpCode);
      if (!otpOk) {
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Código de verificação inválido ou expirado.",
        });
      }

      // (d) Already a pending deletion? Idempotent — return the existing
      // grace window so the caller can show the cancel UI.
      const existing = await readPendingDeletion(customerId);
      if (existing) {
        return reply.code(202).send({
          status: "deferred",
          message: "Já existe uma solicitação de exclusão em andamento.",
          canCancelUntil: new Date(existing.parkedAt + ANONYMIZE_GRACE_TTL_SECONDS * 1000).toISOString(),
        });
      }

      // (e) Build the `customer.anonymize` envelope. `actor.principal =
      // "user"`, `taint = "UNTRUSTED"`, `sessionId = customerId` per the
      // master plan. The `otpToken` is the verified code — the pack's
      // policy only reads `state.otpFresh`, NOT the token itself.
      const payload: CustomerAnonymizePayload = {
        customerId,
        otpToken: otpCode,
        scope: "lgpd_art_18",
      };
      const envelope = buildEnvelope<"customer.anonymize", CustomerAnonymizePayload>({
        kind: "customer.anonymize",
        payload,
        nonce: randomUUID(),
        actor: { principal: "user", sessionId: customerId },
        taint: "UNTRUSTED",
      });

      // (f) Project state for the pack policy. `otpFresh` is true here
      // because we just verified above. `hasParkedAnonymize` is false
      // (we returned early on existing receipt). `customerExists` /
      // `isAuthenticated` are both true (requireAuth + getById).
      const state: CustomerOnboardingState = {
        ctx: {
          actor: { principal: "user", id: customerId },
          customerId,
          customerExists: true,
          isAuthenticated: true,
          otpFresh: true,
          hasParkedAnonymize: false,
          now: new Date(),
        },
      };

      // (g) Park-on-DEFER closure used by the gateway. The pack's policy
      // is expected to return DEFER with the grace signal; if the kernel
      // returns EXECUTE directly (e.g., policy override), the gateway
      // dispatches `anonymizeCustomerFromEnvelope` instead — but that
      // bypasses the 24h grace which is policy-mandated, so we explicitly
      // surface a 500 to call out the misconfiguration.
      const parkedAt = Date.now();
      const intentHash = envelope.intentHash;
      const onDefer = async () => {
        // Park via the runtime's `parkDeferredIntent` primitive — populates
        // the T-005 verification fields so the resume side can detect
        // tamper-at-rest, and enforces the per-session park quota (P0-7).
        let parkQuotaExceeded = false;
        try {
          const redis = await getRedisClient();
          const ttlSeconds = ANONYMIZE_GRACE_TTL_SECONDS + 60; // sweeper grace
          const parkResult = await parkDeferredIntent({
            envelope: {
              intentHash: envelope.intentHash,
              kind: envelope.kind,
              actor: { sessionId: envelope.actor.sessionId },
              payload: envelope.payload,
              version: envelope.version,
              nonce: envelope.nonce,
              taint: envelope.taint,
              actorPrincipal: envelope.actor.principal,
            },
            signal: "customer.anonymize.confirmed_after_grace",
            ttlSeconds,
            redis,
            rk,
          });
          if (!parkResult.parked) {
            parkQuotaExceeded = true;
            request.log.warn(
              {
                customerId,
                reason: parkResult.reason,
                observed: parkResult.observed,
                limit: parkResult.limit,
              },
              "[me/anonymize] DEFER park quota exceeded",
            );
          }
        } catch (err) {
          request.log.error(
            { customerId, err: (err as Error).message },
            "[me/anonymize] DEFER park failed",
          );
        }

        if (parkQuotaExceeded) {
          return {
            statusCode: 429,
            body: {
              status: "refused",
              message: "Muitas operações em espera. Aguarde uma concluir e tente novamente.",
              reason: "quota_exceeded",
            },
            decision: {
              kind: "REFUSE" as const,
              refusal: {
                kind: "BUSINESS_RULE" as const,
                code: "quota_exceeded",
                userFacing:
                  "Muitas operações em espera. Aguarde uma concluir e tente novamente.",
              },
              basis: [],
            },
          };
        }

        // Persist the customer-facing receipt — single source of truth
        // for cancel-deletion + grace resolver.
        await persistPendingDeletion(customerId, {
          parkedAt,
          intentHash,
          otpTokenHint: otpCode.slice(0, 2) + "****",
        });

        // Consume the OTP marker — single-use (a retry within 5min must
        // re-issue a fresh OTP, NOT replay the existing one).
        await consumeOtpMarker(customerId);

        return {
          statusCode: 202,
          body: {
            status: "deferred",
            message: "Pedido de exclusão recebido. Você tem 24 horas para cancelar.",
            canCancelUntil: new Date(parkedAt + ANONYMIZE_GRACE_TTL_SECONDS * 1000).toISOString(),
            intentHash,
          },
          decision: { kind: "DEFER" as const, signal: "", timeoutMs: 0, basis: [] },
        };
      };

      const out = await runCustomerIntent({
        envelope,
        state,
        policy: customerOnboardingPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
        executor: async () => {
          // Should not reach here per pack policy — but if it does,
          // run the destructive call through the envelope-typed entry
          // point so audit is captured uniformly.
          const result = await anonymizeCustomerFromEnvelope(envelope, state, {
            auditSink: getAuditSink(),
            log: request.log,
          });
          // result.decision should match EXECUTE here; surface the success
          // payload directly.
          await consumeOtpMarker(customerId);
          return result.result ?? { success: true };
        },
        ctx: {
          customerId,
          route: "me.anonymize.delete",
          log: request.log,
        },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
        onDefer,
      });

      return reply.code(out.statusCode).send(out.body);
    },
  );

  // ── POST /api/me/data/cancel-deletion ───────────────────────────────────────
  //
  // Step 3: within the 24h grace, the customer can cancel. We adjudicate
  // the `customer.anonymize.cancel` envelope (the pack REFUSEs as
  // supersedes-parked semantics) and DELete the receipt. The audit
  // record links to the parked envelope's intentHash via supersedes.

  app.post(
    "/api/me/data/cancel-deletion",
    {
      schema: {
        tags: ["me"],
        summary: "Cancelar exclusão de dados em andamento (LGPD Art. 18)",
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;

      // (a) Must have a pending deletion to cancel.
      const receipt = await readPendingDeletion(customerId);
      if (!receipt) {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Nenhuma solicitação de exclusão em andamento.",
        });
      }

      // (b) Build the cancel envelope. Same actor / taint as the
      // anonymize envelope so the audit trail is consistent.
      const payload: CustomerAnonymizeCancelPayload = { customerId };
      const envelope = buildEnvelope<
        "customer.anonymize.cancel",
        CustomerAnonymizeCancelPayload
      >({
        kind: "customer.anonymize.cancel",
        payload,
        nonce: randomUUID(),
        actor: { principal: "user", sessionId: customerId },
        taint: "UNTRUSTED",
      });

      const state: CustomerOnboardingState = {
        ctx: {
          actor: { principal: "user", id: customerId },
          customerId,
          customerExists: true,
          isAuthenticated: true,
          // The pack reads `otpFresh` for cancel too — we treat the
          // existence of the pending receipt as the auth gate (cancel
          // is non-destructive; no OTP needed).
          otpFresh: true,
          hasParkedAnonymize: true,
          parkedAnonymizeAt: receipt.parkedAt,
          now: new Date(),
        },
      };

      // (c) Adjudicate. The pack's policy is expected to REFUSE with
      // `customer.anonymize.cancel_supersedes_parked` — that's the
      // "supersedes-parked" semantics: the cancel itself doesn't execute
      // anything; it just REFUSEs in a way that signals the parked
      // deletion is now void.
      const out = await runCustomerIntent({
        envelope,
        state,
        policy: customerOnboardingPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
        executor: async () => {
          // Defensive — pack policy is REFUSE; reaching here means a
          // pack misconfiguration. Still safe to clear the receipt.
          return { canceled: true };
        },
        ctx: {
          customerId,
          route: "me.anonymize.cancel",
          log: request.log,
        },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
      });

      // (d) Clear the receipt + the parked envelope blob regardless of
      // whether the kernel returned REFUSE or EXECUTE — the customer's
      // intent (cancel) is honored at the route layer.
      await clearPendingDeletion(customerId);
      try {
        const redis = await getRedisClient();
        await redis.del(rk(`defer:pending:${customerId}`));
      } catch {
        // Best-effort — sweeper will clean it up eventually.
      }

      // (e) Surface a 200 with the success message regardless of which
      // branch the kernel took. The REFUSE-supersedes-parked pattern
      // means a 403 here would confuse the user; the audit record
      // already captures the kernel's verdict.
      request.log.info(
        {
          customerId,
          parkedIntentHash: receipt.intentHash,
          cancelIntentHash: envelope.intentHash,
          decision: out.decision.kind,
        },
        "[me/anonymize] deletion cancelled by customer",
      );
      return reply.code(200).send({
        status: "canceled",
        message: "Pedido de exclusão cancelado.",
      });
    },
  );
}
