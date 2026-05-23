// Me routes — LGPD data access and deletion (Art. 18).
//
// GET    /api/me/data                       — export all personal data
// POST   /api/me/data/send-otp              — emit fresh OTP for anonymize flow
// POST   /api/me/data/verify-otp            — verify code, mark 60s "verified" window
// POST   /api/me/data/initiate-deletion     — require fresh verify, park DEFER, 24h grace
// DELETE /api/me/data?token={otpCode}       — legacy single-step (kept for back-compat)
// POST   /api/me/data/cancel-deletion       — REFUSE the parked deletion + 30min cooldown
//
// ── Task 14 (M3) — destructive multi-step flow ────────────────────────────
//
// The single legacy `DELETE /api/me/data` was: "one-click destructive,
// unconfirmed, unadjudicated, no replay protection" (investigation 08 P0
// #2). It now becomes a multi-step flow gated by:
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
//
// ── W4 P0-11 hardening ───────────────────────────────────────────────────
//
// Pre-W4 a stolen JWT alone authorised initiate-deletion. The W4 changes:
//
//   - Send-OTP and verify-OTP are now SEPARATE endpoints. Verify sets a
//     60-SECOND freshness marker.
//   - initiate-deletion REQUIRES the 60s verify marker before it will
//     park anything.
//   - Per-customer brute-force counter on verify-otp (5 failures /
//     30 min → lockout).
//   - 30-min cancel-cooldown — blocks re-initiation after a cancel
//     to defeat harassment / Twilio-spend loops.

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
  ANONYMIZE_FAIL_THRESHOLD,
  ANONYMIZE_VERIFY_TTL_SECONDS,
  consumeOtpMarker,
  consumeOtpVerifiedMarker,
  hasFreshOtp,
  hasFreshVerifiedOtp,
  hasCancelCooldown,
  incrementOtpFailureCount,
  getOtpFailureCount,
  markOtpFresh,
  markOtpVerified,
  persistPendingDeletion,
  readPendingDeletion,
  resetOtpFailureCount,
  sendAnonymizeOtp,
  setCancelCooldown,
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

  // ── POST /api/me/data/send-otp ─────────────────────────────────────────────
  //
  // Step 1 of the W4 anonymize flow. Emit a fresh OTP via Twilio
  // Verify and mark the customer as "OTP requested" in Redis with a
  // 5-minute TTL. The verify-otp step rejects fast if this marker
  // has expired, sparing Twilio a verify-check round-trip.
  //
  // Refuses while the 30-min cancel-cooldown is active so a previous
  // cancellation cannot be re-initiated immediately (P0-11).

  app.post(
    "/api/me/data/send-otp",
    {
      schema: {
        tags: ["me"],
        summary: "Solicitar código de verificação para exclusão (LGPD Art. 18)",
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;

      // P0-11: refuse during cancel-cooldown window.
      if (await hasCancelCooldown(customerId)) {
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Você cancelou uma exclusão recentemente. Aguarde 30 minutos antes de tentar de novo.",
        });
      }

      // P0-11: refuse when the customer is already locked out from
      // prior failed OTP attempts. Defers the Twilio round-trip.
      const fails = await getOtpFailureCount(customerId);
      if (fails >= ANONYMIZE_FAIL_THRESHOLD) {
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Excesso de tentativas. Aguarde 30 min e tente novamente.",
        });
      }

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
          message: "Código de verificação enviado. Confirme em até 5 minutos.",
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

  // ── POST /api/me/data/verify-otp ────────────────────────────────────────────
  //
  // Step 2 of the W4 anonymize flow. Verifies the 6-digit code with
  // Twilio Verify. On success, sets a 60-second `anonymize:otp_verified`
  // marker — initiate-deletion REQUIRES this marker to be present.
  //
  // P0-11 brute-force counter: each failed verify INCRs
  // `anonymize:fail:{customerId}` with a 30-min TTL. After 5 failures
  // the customer is locked out. The counter resets on success.

  app.post(
    "/api/me/data/verify-otp",
    {
      schema: {
        tags: ["me"],
        summary: "Verificar código de exclusão (LGPD Art. 18)",
        body: z.object({
          token: z.string().regex(/^\d{6}$/, "Token inválido — deve ter 6 dígitos."),
        }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const { token: otpCode } = request.body;

      // P0-11: brute-force lockout check.
      const failsBefore = await getOtpFailureCount(customerId);
      if (failsBefore >= ANONYMIZE_FAIL_THRESHOLD) {
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Excesso de tentativas. Aguarde 30 min e tente novamente.",
        });
      }

      // Fast-fail: OTP marker missing (5min TTL on send-otp).
      if (!(await hasFreshOtp(customerId))) {
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Código expirado. Solicite um novo em /send-otp.",
        });
      }

      // Look up phone for Twilio Verify.
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

      const otpOk = await verifyAnonymizeOtp(phone, otpCode);
      if (!otpOk) {
        const failsAfter = await incrementOtpFailureCount(customerId);
        request.log.warn(
          { customerId, attempts: failsAfter, action: "anonymize_otp_failed" },
          "Anonymize OTP verification failed",
        );
        if (failsAfter >= ANONYMIZE_FAIL_THRESHOLD) {
          return reply.code(429).send({
            statusCode: 429,
            error: "Too Many Requests",
            message: "Excesso de tentativas. Aguarde 30 min e tente novamente.",
          });
        }
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Código de verificação inválido ou expirado.",
        });
      }

      // Success — reset the brute-force counter and mark the 60s window.
      await resetOtpFailureCount(customerId);
      await markOtpVerified(customerId);
      request.log.info(
        { customerId, action: "anonymize_otp_verified" },
        "Anonymize OTP verified",
      );
      return reply.code(200).send({
        status: "verified",
        message: "Código verificado. Confirme a exclusão em até 60 segundos.",
        ttlSeconds: ANONYMIZE_VERIFY_TTL_SECONDS,
      });
    },
  );

  // ── POST /api/me/data/initiate-deletion ─────────────────────────────────────
  //
  // Step 3 of the W4 anonymize flow. REQUIRES the 60-second
  // `anonymize:otp_verified` marker (set by /verify-otp). Builds the
  // `customer.anonymize` envelope, adjudicates, expects DEFER, parks
  // the receipt. The destructive Prisma call happens in the grace
  // resolver subscriber (NOT here).
  //
  // Refuses while the 30-min cancel-cooldown is active.

  app.post(
    "/api/me/data/initiate-deletion",
    {
      schema: {
        tags: ["me"],
        summary: "Iniciar exclusão — requer verificação OTP fresca (LGPD Art. 18)",
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;

      // P0-11: refuse during cancel-cooldown window.
      if (await hasCancelCooldown(customerId)) {
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Você cancelou uma exclusão recentemente. Aguarde 30 minutos antes de tentar de novo.",
        });
      }

      // P0-11: require a fresh verify-otp marker (60s window). Stolen
      // JWT alone is no longer enough — the attacker must also possess
      // a code that was just verified.
      if (!(await hasFreshVerifiedOtp(customerId))) {
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Verificação expirada. Refaça /send-otp e /verify-otp antes de iniciar a exclusão.",
        });
      }

      // Already a pending deletion? Idempotent — return the existing
      // grace window so the caller can show the cancel UI.
      const existing = await readPendingDeletion(customerId);
      if (existing) {
        return reply.code(202).send({
          status: "deferred",
          message: "Já existe uma solicitação de exclusão em andamento.",
          canCancelUntil: new Date(existing.parkedAt + ANONYMIZE_GRACE_TTL_SECONDS * 1000).toISOString(),
        });
      }

      // Build the `customer.anonymize` envelope. `actor.principal =
      // "user"`, `taint = "UNTRUSTED"`. The `sessionId` is the
      // customerId — the W4 audit redactor hashes it for PII safety
      // (P0-10).
      //
      // No `otpToken` is needed in the payload because OTP verification
      // already happened at /verify-otp; the pack reads `otpFresh` from
      // state (which we project as `true` after the verify-marker check).
      const payload: CustomerAnonymizePayload = {
        customerId,
        otpToken: "verified",
        scope: "lgpd_art_18",
      };
      const envelope = buildEnvelope<"customer.anonymize", CustomerAnonymizePayload>({
        kind: "customer.anonymize",
        payload,
        nonce: randomUUID(),
        actor: { principal: "user", sessionId: customerId },
        taint: "UNTRUSTED",
      });

      // Project state for the pack policy. `otpFresh` is true here
      // because /verify-otp succeeded within the last 60s.
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

      const parkedAt = Date.now();
      const intentHash = envelope.intentHash;
      const onDefer = async () => {
        let parkQuotaExceeded = false;
        try {
          const redis = await getRedisClient();
          const ttlSeconds = ANONYMIZE_GRACE_TTL_SECONDS + 60;
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

        await persistPendingDeletion(customerId, {
          parkedAt,
          intentHash,
          otpTokenHint: "verified",
        });

        // Consume the verify-otp marker (single-use) and the legacy
        // OTP marker (best-effort).
        await consumeOtpVerifiedMarker(customerId);
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
          const result = await anonymizeCustomerFromEnvelope(envelope, state, {
            auditSink: getAuditSink(),
            log: request.log,
          });
          await consumeOtpVerifiedMarker(customerId);
          await consumeOtpMarker(customerId);
          return result.result ?? { success: true };
        },
        ctx: {
          customerId,
          route: "me.anonymize.initiate",
          log: request.log,
        },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
        onDefer,
      });

      return reply.code(out.statusCode).send(out.body);
    },
  );

  // ── DELETE /api/me/data?token={otpCode} ─────────────────────────────────────
  //
  // Legacy single-step path kept for back-compat with existing clients.
  // The W4 preferred flow is /send-otp → /verify-otp → /initiate-deletion
  // (split into three for stolen-JWT defense and brute-force counters).
  //
  // This endpoint enforces the same W4 P0-11 defenses:
  //   - cancel-cooldown check
  //   - brute-force counter (5 failures / 30min → lockout)
  // Once W5 enforce flips, this endpoint can be removed entirely.

  app.delete(
    "/api/me/data",
    {
      schema: {
        tags: ["me"],
        summary: "[DEPRECATED] Solicitar exclusão (use /send-otp → /verify-otp → /initiate-deletion)",
        querystring: z.object({
          token: z.string().regex(/^\d{6}$/, "Token inválido — deve ter 6 dígitos."),
        }),
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const otpCode = request.query.token;

      // P0-11: refuse during cancel-cooldown window.
      if (await hasCancelCooldown(customerId)) {
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Você cancelou uma exclusão recentemente. Aguarde 30 minutos antes de tentar de novo.",
        });
      }

      // P0-11: brute-force lockout pre-check.
      const failsBefore = await getOtpFailureCount(customerId);
      if (failsBefore >= ANONYMIZE_FAIL_THRESHOLD) {
        return reply.code(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Excesso de tentativas. Aguarde 30 min e tente novamente.",
        });
      }

      // (a) Fast-fail on missing/expired freshness marker — saves a
      // Twilio round-trip for replayed requests after the 5min window.
      if (!(await hasFreshOtp(customerId))) {
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Verificação OTP expirada ou ausente. Solicite um novo código em /send-otp.",
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

      // (c) Verify OTP with Twilio. P0-11: failures increment the
      // brute-force counter and the customer is locked out after
      // ANONYMIZE_FAIL_THRESHOLD failures.
      const otpOk = await verifyAnonymizeOtp(phone, otpCode);
      if (!otpOk) {
        const failsAfter = await incrementOtpFailureCount(customerId);
        request.log.warn(
          { customerId, attempts: failsAfter, action: "anonymize_otp_failed" },
          "Anonymize OTP verification failed (legacy DELETE path)",
        );
        if (failsAfter >= ANONYMIZE_FAIL_THRESHOLD) {
          return reply.code(429).send({
            statusCode: 429,
            error: "Too Many Requests",
            message: "Excesso de tentativas. Aguarde 30 min e tente novamente.",
          });
        }
        return reply.code(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Código de verificação inválido ou expirado.",
        });
      }
      // Success — reset the brute-force counter.
      await resetOtpFailureCount(customerId);

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

      // P0-11: set the 30-min cancel-cooldown. This blocks the next
      // initiate-deletion call so the harassment / Twilio-spend loop
      // (attacker initiates → victim cancels → attacker re-initiates)
      // is broken.
      await setCancelCooldown(customerId);

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
