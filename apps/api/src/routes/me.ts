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

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getRedisClient, rk, withLock, submitReview } from "@ibatexas/tools";
import { Channel } from "@ibatexas/types";
// WS5: park guard now lives in apps/api (the `park-deferred-intent-nx` seam
// re-exports `apps/api/src/adapters/park-nx.ts`). me.ts's DEFER call sites
// (LGPD-grace / PIX-pending parks) and the quota-metric hook must share the
// same park-nx module instance — see kernel-bootstrap.ts.
import {
  parkDeferredIntentWithNxGuard,
  PARK_COLLISION_REFUSAL_PT_BR,
} from "../adapters/park-deferred-intent-nx.js";
import {
  createCustomerService,
  createOrderQueryService,
  createLoyaltyService,
  exportCustomerData,
  anonymizeCustomer,
  anonymizeCustomerFromEnvelope,
} from "@ibatexas/domain";
import {
  customerOnboardingPolicyBundle,
  portugueseRefusalMessages,
  CUSTOMER_PROFILE_RATE_LIMIT_HOURS,
  type CustomerAnonymizePayload,
  type CustomerPreferencesUpdatePayload,
  type CustomerProfileUpdatePayload,
  type CustomerAddressAddPayload,
  type CustomerAddressRemovePayload,
  type CustomerAnonymizeCancelPayload,
  type CustomerOnboardingState,
} from "@ibatexas/pack-customer-onboarding";
import { getAuditSink } from "@ibatexas/audit-sink";
import { requireAuth } from "../middleware/auth.js";
import { buildCustomerEnvelope, runCustomerIntent } from "./__shared__/customer-intent-gateway.js";
import { identityCtx } from "../claustrum/resolve-and-assemble.js";
import {
  ANONYMIZE_GRACE_TTL_SECONDS,
  ANONYMIZE_FAIL_THRESHOLD,
  ANONYMIZE_VERIFY_TTL_SECONDS,
  acquireOtpAttempt,
  consumeOtpMarker,
  consumeOtpVerifiedMarker,
  hasFreshOtp,
  hasFreshVerifiedOtp,
  hasCancelCooldown,
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
import {
  acquireAnonymizeActiveLock,
  releaseAnonymizeActiveLock,
} from "./me/anonymize-active-lock.js";

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

// ── P0-7 (audit-2026-05-24) — deterministic idempotency-key helpers ────────
//
// LGPD destructive operations (anonymize start / confirm) MUST dedupe on
// retry: a duplicate `initiate-deletion` within the same hour would park
// two `customer.anonymize` envelopes for the same customer, doubling the
// scheduled grace-period work and producing two audit records for one
// logical intent. Per CLAUDE.md rule #9, inputs are non-PII (customerId
// UUID + epoch-hour) — never the customer's name/phone/email.
//
// The fallback derivation uses `${customerId}:${step}:${epoch_hour}` so:
//   - Two clicks in the same hour produce identical `intentHash`.
//   - The next hour produces a fresh hash (customer can retry if needed).
function deriveMeNonce(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function resolveMeIdempotencyKey(
  headerValue: string | string[] | undefined,
  fallback: string,
): string {
  if (typeof headerValue === "string" && headerValue.length > 0) {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue[0]) {
    return headerValue[0];
  }
  return fallback;
}

/** UTC epoch-hour for the deterministic-key time bucket. */
function epochHour(): number {
  return Math.floor(Date.now() / (60 * 60 * 1000));
}

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
        response: {
          200: CustomerDataResponse,
          // 409 when a privacy operation (erase) holds the per-customer lock.
          409: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      // Coordinate with the erase route under the SAME per-customer lock
      // (withLock(`lgpd:${customerId}`)) so an export can't read a half-scrubbed
      // profile while anonymizeCustomer's transaction is in flight (P0-LGPD-1).
      // withLock returns null on contention → surface 409 rather than partial data.
      const data = await withLock(`lgpd:${customerId}`, () =>
        exportCustomerData(customerId),
      );
      if (!data) {
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message:
            "Uma operação de privacidade está em andamento. Tente novamente em instantes.",
        });
      }
      return reply.send(data);
    },
  );

  // ── GET /api/me/loyalty ────────────────────────────────────────────────────
  //
  // CUS-067 (web view) — the authenticated customer's punch-card stamp balance.
  // Read-only; scoped to request.customerId (set by requireAuth). Mirrors the
  // WhatsApp loyalty shortcut so the web account page can render the same balance.
  app.get(
    "/api/me/loyalty",
    {
      schema: {
        tags: ["me"],
        summary: "Saldo de fidelidade (selos)",
        response: {
          200: z.object({
            stamps: z.number(),
            stampsNeeded: z.number(),
            totalEarned: z.number(),
          }),
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const balance = await createLoyaltyService().getBalance(customerId);
      return reply.send({
        stamps: balance.stamps,
        stampsNeeded: balance.stampsNeeded,
        totalEarned: balance.totalEarned,
      });
    },
  );

  // ── POST /api/me/preferences ───────────────────────────────────────────────
  //
  // CUS-062 (web surface) — the authenticated customer sets dietary flags +
  // allergen exclusions. Routed through the conductor's customer-intent gateway:
  // a `customer.preferences.update` envelope is adjudicated against the
  // customer-onboarding pack (allergen-explicit-array guard, rate limit, audit),
  // then the bare service executor persists it. Mirrors the LLM `update_prefs`
  // path; same governed kind, HTTP entry point. Auth-gated by requireAuth.
  const PreferencesUpdateResponse = z.object({ success: z.boolean() });

  app.post(
    "/api/me/preferences",
    {
      schema: {
        tags: ["me"],
        summary: "Atualizar preferências (restrições alimentares / alérgenos)",
        body: z.object({
          allergenExclusions: z.array(z.string()).default([]),
          dietaryFlags: z.array(z.string()).optional(),
          favoriteCategories: z.array(z.string()).optional(),
        }),
        response: { 200: PreferencesUpdateResponse },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const body = request.body;
      const idempotencyKey = resolveMeIdempotencyKey(
        request.headers["idempotency-key"],
        `${customerId}:preferences:update:${epochHour()}`,
      );
      const payload: CustomerPreferencesUpdatePayload = {
        allergenExclusions: body.allergenExclusions,
        ...(body.dietaryFlags ? { dietaryFlags: body.dietaryFlags } : {}),
        ...(body.favoriteCategories ? { favoriteCategories: body.favoriteCategories } : {}),
      };
      const envelope = buildCustomerEnvelope<
        "customer.preferences.update",
        CustomerPreferencesUpdatePayload
      >({
        kind: "customer.preferences.update",
        payload,
        nonce: deriveMeNonce(idempotencyKey),
        customerId,
      });
      const state = {
        ctx: {
          ...identityCtx(customerId, "web"),
          customerExists: true,
          isAuthenticated: true,
          now: new Date(),
        },
      } as unknown as CustomerOnboardingState;

      const out = await runCustomerIntent({
        envelope,
        state,
        policy: customerOnboardingPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
        executor: async () => {
          // EXECUTE: persist via the bare service method (the sanctioned executor
          // for the envelope wrapper). Adjudication already ran in runCustomerIntent.
          await createCustomerService().updatePreferences(customerId, {
            allergenExclusions: [...body.allergenExclusions],
            ...(body.dietaryFlags ? { dietaryRestrictions: [...body.dietaryFlags] } : {}),
            ...(body.favoriteCategories ? { favoriteCategories: [...body.favoriteCategories] } : {}),
          });
          return { success: true };
        },
        ctx: {
          customerId,
          route: "me.preferences.update",
          log: request.log,
        },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
      });

      if (out.statusCode === 200) {
        return reply.code(200).send({ success: true });
      }
      void (reply as unknown as { status(code: number): typeof reply })
        .status(out.statusCode)
        .send(out.body as never);
      return reply;
    },
  );

  // ── POST /api/me/reviews ───────────────────────────────────────────────────
  //
  // CUS-049 (web surface) — the authenticated customer submits a product review
  // for a delivered order. The write itself is governed: `submitReview` builds
  // an `order.review.submit` IntentEnvelope adjudicated against the orders Pack
  // (rating-range 1–5, orderId presence, audit) before any Prisma write, and
  // scopes the row to the authenticated customerId (never the payload).
  //
  // Route-level ownership gate (defense in depth, closes IDOR): before we touch
  // the governed path we owner-scope the order via `getById(orderId, {customerId})`
  // — a non-owner or NULL-owner projection resolves to null (SDD §N P0-3, Inv 2),
  // so a customer can only review an order that is theirs. We also require the
  // order be DELIVERED and the product to appear in it, matching the "após a
  // entrega" contract of the review tool.
  const ReviewSubmitResponse = z.object({ success: z.boolean(), message: z.string() });

  app.post(
    "/api/me/reviews",
    {
      schema: {
        tags: ["me"],
        summary: "Enviar avaliação de um produto de um pedido entregue",
        body: z.object({
          orderId: z.string().min(1),
          productId: z.string().min(1),
          rating: z.number().int().min(1).max(5),
          comment: z.string().max(1000).optional(),
        }),
        response: {
          200: ReviewSubmitResponse,
          403: z.object({ statusCode: z.number(), error: z.string(), message: z.string() }),
          422: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const { orderId, productId, rating, comment } = request.body;

      const refuse403 = (message: string) =>
        reply.code(403).send({ statusCode: 403, error: "Forbidden", message });

      // Owner-scoped read: null for a non-owner / unattributed order (Inv 2).
      const order = await createOrderQueryService().getById(orderId, { customerId });
      if (!order) {
        return refuse403("Pedido não encontrado para esta conta.");
      }
      if (order.fulfillmentStatus !== "delivered") {
        return refuse403("Só é possível avaliar um pedido após a entrega.");
      }
      const items = Array.isArray(order.itemsJson) ? order.itemsJson : [];
      const productInOrder = items.some(
        (it) => (it as { productId?: string } | null)?.productId === productId,
      );
      if (!productInOrder) {
        return refuse403("Este produto não faz parte do pedido informado.");
      }

      // Governed write: submitReview adjudicates via the orders Pack and scopes
      // the review row to this customerId. Re-asserts rating-range + orderId.
      // A kernel REFUSE surfaces as NonRetryableError → 422 (repo idiom).
      try {
        const result = await submitReview(
          { productId, orderId, rating, ...(comment === undefined ? {} : { comment }) },
          {
            channel: Channel.Web,
            sessionId: request.id,
            customerId,
            userType: "customer",
          },
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof Error && err.name === "NonRetryableError") {
          return reply.code(422).send({ error: err.message });
        }
        request.log.error(err, "submitReview falhou");
        return reply.code(500).send({ error: "Erro ao enviar avaliação." });
      }
    },
  );

  // ── POST /api/me/profile ────────────────────────────────────────────────────
  //
  // CUS-061 (web surface) — the authenticated customer edits their name / email.
  // Routed through the customer-intent gateway: a `customer.profile.update`
  // envelope is adjudicated against the customer-onboarding Pack (auth guard,
  // PII/card-PAN scan on name+email, 1h rate-limit) before the bare service
  // executor persists it. The rate-limit guard reads `state.ctx.lastProfileUpdateAt`
  // — we keep it LIVE (not inert) via a per-customer Redis marker read before and
  // refreshed after a successful EXECUTE.
  const ProfileUpdateResponse = z.object({ success: z.boolean() });
  const profileLastUpdateKey = (customerId: string) =>
    rk(`customer:profile:last-update:${customerId}`);

  app.post(
    "/api/me/profile",
    {
      schema: {
        tags: ["me"],
        summary: "Editar perfil (nome / e-mail)",
        body: z
          .object({
            name: z.string().trim().min(1).max(120).optional(),
            email: z.string().trim().email().max(254).optional(),
          })
          .refine((b) => b.name !== undefined || b.email !== undefined, {
            message: "Informe nome ou e-mail.",
          }),
        response: {
          200: ProfileUpdateResponse,
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const body = request.body;
      const idempotencyKey = resolveMeIdempotencyKey(
        request.headers["idempotency-key"],
        `${customerId}:profile:update:${epochHour()}`,
      );

      // Keep the rate-limit guard live: project the last-update epoch from Redis.
      const redis = await getRedisClient();
      const lastRaw = await redis.get(profileLastUpdateKey(customerId));
      const lastProfileUpdateAt = lastRaw ? Number(lastRaw) : null;

      const payload: CustomerProfileUpdatePayload = {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.email === undefined ? {} : { email: body.email }),
      };
      const envelope = buildCustomerEnvelope<
        "customer.profile.update",
        CustomerProfileUpdatePayload
      >({
        kind: "customer.profile.update",
        payload,
        nonce: deriveMeNonce(idempotencyKey),
        customerId,
      });
      const state = {
        ctx: {
          ...identityCtx(customerId, "web"),
          customerExists: true,
          isAuthenticated: true,
          now: new Date(),
          lastProfileUpdateAt,
        },
      } as unknown as CustomerOnboardingState;

      const out = await runCustomerIntent({
        envelope,
        state,
        policy: customerOnboardingPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
        executor: async () => {
          await createCustomerService().updateProfile(customerId, {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.email === undefined ? {} : { email: body.email }),
          });
          // Refresh the rate-limit marker; TTL covers the cooldown window + margin.
          await redis.set(profileLastUpdateKey(customerId), String(Date.now()), {
            EX: Math.ceil(CUSTOMER_PROFILE_RATE_LIMIT_HOURS * 3600) + 300,
          });
          return { success: true };
        },
        ctx: {
          customerId,
          route: "me.profile.update",
          log: request.log,
        },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
      });

      if (out.statusCode === 200) {
        return reply.code(200).send({ success: true });
      }
      void (reply as unknown as { status(code: number): typeof reply })
        .status(out.statusCode)
        .send(out.body as never);
      return reply;
    },
  );

  // ── Saved addresses (CUS-063) ───────────────────────────────────────────────
  //
  // Address book over the existing Prisma `Address` model + the customer-
  // onboarding Pack's `customer.address.add` / `customer.address.remove` intents
  // (auth-gated). Writes are governed via runCustomerIntent; removal is
  // ownership-scoped in the executor (WHERE id AND customerId — IDOR-safe).
  const AddressSchema = z.object({
    id: z.string(),
    street: z.string(),
    number: z.string(),
    complement: z.string().nullable(),
    district: z.string(),
    city: z.string(),
    state: z.string(),
    cep: z.string(),
    isDefault: z.boolean(),
  });
  const buildCustomerAuthState = (customerId: string) =>
    ({
      ctx: {
        ...identityCtx(customerId, "web"),
        customerExists: true,
        isAuthenticated: true,
        now: new Date(),
      },
    }) as unknown as CustomerOnboardingState;

  app.get(
    "/api/me/addresses",
    {
      schema: {
        tags: ["me"],
        summary: "Listar endereços salvos",
        response: { 200: z.object({ addresses: z.array(AddressSchema) }) },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const addresses = await createCustomerService().listAddresses(customerId);
      return reply.send({ addresses });
    },
  );

  app.post(
    "/api/me/addresses",
    {
      schema: {
        tags: ["me"],
        summary: "Adicionar endereço",
        body: z.object({
          street: z.string().trim().min(1).max(200),
          number: z.string().trim().max(20).optional(),
          complement: z.string().trim().max(100).optional(),
          neighborhood: z.string().trim().max(120).optional(),
          city: z.string().trim().min(1).max(120),
          state: z.string().trim().length(2),
          zip: z.string().trim().regex(/^\d{5}-?\d{3}$/, "CEP inválido"),
          isDefault: z.boolean().optional(),
        }),
        response: { 200: z.object({ address: AddressSchema }) },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const b = request.body;
      const idempotencyKey = resolveMeIdempotencyKey(
        request.headers["idempotency-key"],
        `${customerId}:address:add:${epochHour()}`,
      );
      const payload: CustomerAddressAddPayload = {
        address: {
          street: b.street,
          city: b.city,
          state: b.state,
          zip: b.zip,
          ...(b.number === undefined ? {} : { number: b.number }),
          ...(b.complement === undefined ? {} : { complement: b.complement }),
          ...(b.neighborhood === undefined ? {} : { neighborhood: b.neighborhood }),
        },
      };
      const envelope = buildCustomerEnvelope<"customer.address.add", CustomerAddressAddPayload>({
        kind: "customer.address.add",
        payload,
        nonce: deriveMeNonce(idempotencyKey),
        customerId,
      });
      const svc = createCustomerService();
      let created: Awaited<ReturnType<typeof svc.addAddress>> | undefined;
      const out = await runCustomerIntent({
        envelope,
        state: buildCustomerAuthState(customerId),
        policy: customerOnboardingPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
        executor: async () => {
          created = await svc.addAddress(customerId, {
            street: b.street,
            city: b.city,
            state: b.state,
            cep: b.zip,
            ...(b.number === undefined ? {} : { number: b.number }),
            ...(b.complement === undefined ? {} : { complement: b.complement }),
            ...(b.neighborhood === undefined ? {} : { district: b.neighborhood }),
            ...(b.isDefault === undefined ? {} : { isDefault: b.isDefault }),
          });
          return created;
        },
        ctx: { customerId, route: "me.address.add", log: request.log },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
      });
      if (out.statusCode === 200 && created) {
        return reply.code(200).send({ address: created });
      }
      void (reply as unknown as { status(code: number): typeof reply })
        .status(out.statusCode)
        .send(out.body as never);
      return reply;
    },
  );

  app.delete(
    "/api/me/addresses/:addressId",
    {
      schema: {
        tags: ["me"],
        summary: "Remover endereço",
        params: z.object({ addressId: z.string().min(1) }),
        response: {
          200: z.object({ success: z.boolean() }),
          404: z.object({ statusCode: z.number(), error: z.string(), message: z.string() }),
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;
      const { addressId } = request.params;
      const idempotencyKey = resolveMeIdempotencyKey(
        request.headers["idempotency-key"],
        `${customerId}:address:remove:${addressId}`,
      );
      const payload: CustomerAddressRemovePayload = { addressId };
      const envelope = buildCustomerEnvelope<"customer.address.remove", CustomerAddressRemovePayload>({
        kind: "customer.address.remove",
        payload,
        nonce: deriveMeNonce(idempotencyKey),
        customerId,
      });
      let removedCount = 0;
      const out = await runCustomerIntent({
        envelope,
        state: buildCustomerAuthState(customerId),
        policy: customerOnboardingPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
        executor: async () => {
          const r = await createCustomerService().removeAddress(customerId, addressId);
          removedCount = r.count;
          return r;
        },
        ctx: { customerId, route: "me.address.remove", log: request.log },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
      });
      if (out.statusCode === 200) {
        // count 0 → the id was not the caller's (or does not exist): 404, never 200.
        if (removedCount === 0) {
          return reply.code(404).send({
            statusCode: 404,
            error: "Not Found",
            message: "Endereço não encontrado.",
          });
        }
        return reply.code(200).send({ success: true });
      }
      void (reply as unknown as { status(code: number): typeof reply })
        .status(out.statusCode)
        .send(out.body as never);
      return reply;
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

      // P0-X-OTP — Atomically acquire a brute-force attempt slot.
      //
      // Pre-fix (audit 03 R6): getOtpFailureCount → Twilio (~300ms) →
      // incrementOtpFailureCount on fail. N concurrent attempts in the
      // ~300ms Twilio window all read the same starting count, all
      // passed the threshold check, all proceeded. ~30 free attempts
      // per burst.
      //
      // Post-fix: acquireOtpAttempt performs INCR + threshold check +
      // lockout sentinel SET in a single Lua eval. N concurrent
      // attempts each see a distinct post-INCR count; the (THRESHOLD+1)
      // attempt onwards trip the lockout sentinel and refuse without
      // hitting Twilio at all. On success we reset the counter; the
      // reservation cost is one attempt slot per try.
      const attempt = await acquireOtpAttempt(customerId);
      if (attempt.kind === "locked_out") {
        request.log.warn(
          {
            customerId,
            attempts: attempt.count,
            fromSentinel: attempt.fromSentinel,
            action: "anonymize_otp_locked_out",
          },
          "Anonymize OTP locked out",
        );
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
        // Counter is already incremented (atomically) by
        // acquireOtpAttempt. Just log and refuse.
        request.log.warn(
          {
            customerId,
            attempts: attempt.count,
            action: "anonymize_otp_failed",
          },
          "Anonymize OTP verification failed",
        );
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
      //
      // ── P0-7 (audit-2026-05-24) — deterministic idempotency-key ───────
      //
      // Each customer can legitimately initiate one anonymize per hour
      // (re-initiating instantly is operator error or a retry). Prefer
      // the client's `Idempotency-Key` header; fall back to a derived
      // `${customerId}:anonymize:initiate:${epochHour}` so HTTP retries
      // within the hour produce the same `intentHash` and the kernel
      // ledger dedupes — no double-parked deletions.
      const initiateIdempotencyKey = resolveMeIdempotencyKey(
        request.headers["idempotency-key"],
        `${customerId}:anonymize:initiate:${epochHour()}`,
      );
      const payload: CustomerAnonymizePayload = {
        customerId,
        otpToken: "verified",
        scope: "lgpd_art_18",
      };
      const envelope = buildCustomerEnvelope<"customer.anonymize", CustomerAnonymizePayload>({
        kind: "customer.anonymize",
        payload,
        nonce: deriveMeNonce(initiateIdempotencyKey),
        customerId,
      });

      // Project state for the pack policy. `otpFresh` is true here because
      // /verify-otp succeeded within the last 60s. Unified state contract
      // (Phase 2): shared identity base + this route's deliberate flags.
      const state = {
        ctx: {
          ...identityCtx(customerId, "web"),
          customerExists: true,
          isAuthenticated: true,
          otpFresh: true,
          hasParkedAnonymize: false,
          now: new Date(),
        },
      } as unknown as CustomerOnboardingState;

      const parkedAt = Date.now();
      const intentHash = envelope.intentHash;
      const onDefer = async () => {
        // audit-2026-05-24 P0-1: route through the NX-guarded wrapper so a
        // second DEFER for the same customerId cannot silently overwrite the
        // first parked envelope (the framework's raw `parkDeferredIntent`
        // uses plain SET without NX).
        let parkRefusal:
          | { code: "quota_exceeded" | "collision"; message: string }
          | null = null;
        try {
          const redis = await getRedisClient();
          const ttlSeconds = ANONYMIZE_GRACE_TTL_SECONDS + 60;
          const parkResult = await parkDeferredIntentWithNxGuard({
            envelope: {
              intentHash: envelope.intentHash,
              kind: envelope.kind,
              actor: { sessionId: envelope.actor.sessionId },
              payload: envelope.payload,
              version: envelope.version,
              nonce: envelope.nonce,
              taint: envelope.taint,
              actorPrincipal: envelope.actor.principal,
              // 041: origin is part of the intentHash recipe — copy it up so the
              // parked blob stays hash-verifiable at resume (tamper-at-rest).
              origin: envelope.origin,
            },
            signal: "customer.anonymize.confirmed_after_grace",
            ttlSeconds,
            redis,
            rk,
          });
          if (!parkResult.parked) {
            if (parkResult.reason === "quota_exceeded") {
              parkRefusal = {
                code: "quota_exceeded",
                message:
                  "Muitas operações em espera. Aguarde uma concluir e tente novamente.",
              };
              request.log.warn(
                {
                  customerId,
                  reason: parkResult.reason,
                  observed: parkResult.observed,
                  limit: parkResult.limit,
                },
                "[me/anonymize] DEFER park quota exceeded",
              );
            } else {
              parkRefusal = {
                code: "collision",
                message: PARK_COLLISION_REFUSAL_PT_BR,
              };
              request.log.warn(
                { customerId, reason: parkResult.reason },
                "[me/anonymize] DEFER park collision — envelope already parked",
              );
            }
          }
        } catch (err) {
          // audit-2026-05-25 (I4): pre-fix this catch only logged and
          // fell through to persistPendingDeletion() + 202 'Pedido de
          // exclusão recebido. Você tem 24 horas para cancelar.' But
          // the throw means Redis did NOT accept the placeholder OR
          // envelope; no defer:pending:{customerId} key exists; the
          // anonymize-grace-resolver will never fire; the LGPD Art. 18
          // + ANPD 15-day deletion deadline silently passes. Customer
          // received a 202 confirming a deletion that will never run.
          // Fix: surface a distinct 503 + refusal so the customer
          // retries instead of waiting 24h+ for a deletion that won't
          // happen.
          request.log.error(
            { customerId, err: (err as Error).message },
            "[me/anonymize] DEFER park failed",
          );
          return {
            statusCode: 503,
            body: {
              status: "error",
              message:
                "Não foi possível registrar seu pedido de exclusão agora. Tente novamente em alguns instantes.",
              reason: "park_failed",
            },
            decision: {
              kind: "REFUSE" as const,
              refusal: {
                kind: "BUSINESS_RULE" as const,
                code: "park_failed",
                userFacing:
                  "Não foi possível registrar seu pedido de exclusão agora. Tente novamente em alguns instantes.",
              },
              basis: [],
            },
          };
        }

        if (parkRefusal) {
          return {
            statusCode: 429,
            body: {
              status: "refused",
              message: parkRefusal.message,
              reason: parkRefusal.code,
            },
            decision: {
              kind: "REFUSE" as const,
              refusal: {
                kind: "BUSINESS_RULE" as const,
                code: parkRefusal.code,
                userFacing: parkRefusal.message,
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

  // ── DELETE /api/me/data ─────────────────────────────────────────────────────
  //
  // RC-A1 Phase B (LGPD Option B, D-25) — IMMEDIATE erasure for the
  // authenticated HTTP DELETE. The whole locked anonymize (phone tombstone /
  // cpf+email null / review redact / conversation delete / erasedAt) runs NOW,
  // gated through the conductor's customer-intent gateway: a `customer.anonymize`
  // envelope is adjudicated against the customer-onboarding pack with
  // `state.ctx.immediateErasure: true`, which the pack (WS4) uses to skip BOTH
  // the fresh-OTP guard (`requireFreshOtp`) and the 24h-grace DEFER
  // (`deferAnonymizeForGrace`), falling through to `executeAnonymize` → EXECUTE.
  // No OTP, no 24h grace — auth-gated by `requireAuth` (the session JWT proves
  // identity), matching today's single-step erasure behavior.
  //
  // The multi-step OTP + 24h-grace flow stays intact for clients that want it:
  // /send-otp → /verify-otp → /initiate-deletion (which DEFERs because it leaves
  // `immediateErasure` absent) + /cancel-deletion.
  //
  // The destructive call runs through `runCustomerIntent` so the EXECUTE
  // decision is audited uniformly via `getAuditSink()` (one intent_audit row),
  // and under one per-customer lock (`lgpd:{customerId}`) shared with the export
  // route so an erase and an export cannot interleave.

  const DeleteDataResponse = z.object({
    success: z.boolean(),
    message: z.string(),
  });

  app.delete(
    "/api/me/data",
    {
      schema: {
        tags: ["me"],
        summary: "Anonimizar dados pessoais imediatamente (LGPD Art. 18 — eliminação)",
        response: { 200: DeleteDataResponse },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const customerId = request.customerId!;

      // Deterministic idempotency-key (P0-7): a retry within the same hour
      // produces the same `intentHash` so the audit pipeline dedups. Non-PII
      // (customerId UUID + epoch-hour) per CLAUDE.md rule #9.
      const idempotencyKey = resolveMeIdempotencyKey(
        request.headers["idempotency-key"],
        `${customerId}:anonymize:delete:immediate:${epochHour()}`,
      );
      const payload: CustomerAnonymizePayload = {
        customerId,
        // No OTP on the immediate path — the pack policy reads only
        // `state.otpFresh` / `state.immediateErasure`, never the payload token,
        // so an empty string is non-load-bearing and keeps the type satisfied.
        otpToken: "",
        scope: "lgpd_art_18",
      };
      const envelope = buildCustomerEnvelope<"customer.anonymize", CustomerAnonymizePayload>({
        kind: "customer.anonymize",
        payload,
        nonce: deriveMeNonce(idempotencyKey),
        customerId,
      });

      // Immediate-erasure state: requireAuthenticated (isAuthenticated) +
      // requireCustomerExists (customerExists) pass; immediateErasure skips
      // requireFreshOtp + deferAnonymizeForGrace → executeAnonymize EXECUTE.
      // Unified state contract (Phase 2): shared identity base + immediateErasure
      // PRESERVED (LGPD: immediate erasure must NOT degrade to a 24h defer).
      const state = {
        ctx: {
          ...identityCtx(customerId, "web"),
          customerExists: true,
          isAuthenticated: true,
          otpFresh: false,
          hasParkedAnonymize: false,
          immediateErasure: true,
          now: new Date(),
        },
      } as unknown as CustomerOnboardingState;

      const out = await runCustomerIntent({
        envelope,
        state,
        policy: customerOnboardingPolicyBundle as unknown as Parameters<typeof runCustomerIntent>[0]["policy"],
        executor: async () => {
          // EXECUTE: run the destructive anonymize NOW, under the per-customer
          // lock shared with the export route. `anonymizeCustomer` is idempotent
          // (stable tombstone) and throws if the customer row is missing — the
          // throw propagates (requireAuth means a valid customer normally exists).
          await withLock(`lgpd:${customerId}`, () => anonymizeCustomer(customerId));
          return { success: true };
        },
        ctx: {
          customerId,
          route: "me.anonymize.delete.immediate",
          log: request.log,
        },
        auditSink: getAuditSink(),
        refusalMessages: portugueseRefusalMessages,
      });

      // EXECUTE → 200 { success, message }. A REFUSE (e.g. a future policy that
      // blocks the immediate path) flows through as the gateway's localized
      // pt-BR error body + status — never a silent erase. The typed reply is
      // narrowed to the 200 schema, so the non-200 fallthrough uses the
      // `status()` cast (the legacy error-reply pattern used across this file).
      if (out.statusCode === 200) {
        return reply.code(200).send({
          success: true,
          message: "Seus dados foram anonimizados conforme a LGPD.",
        });
      }
      void (reply as unknown as { status(code: number): typeof reply })
        .status(out.statusCode)
        .send(out.body as never);
      return reply;
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

      // (a.1) audit-2026-05-24 P0-3 — acquire the anonymize-active mutex
      // BEFORE the kernel adjudication + receipt clear. The grace-resolver
      // subscriber races against this handler on the same Redis key. If
      // the resolver hit first (its lock value is `resolving:*`), SETNX
      // fails here and we return 409 Conflict with a pt-BR copy. The
      // customer sees the truth: their cancel arrived too late.
      //
      // The lock TTL (60s) auto-expires if THIS handler crashes mid-flight
      // so the customer is not permanently uncancellable.
      const cancelLock = await acquireAnonymizeActiveLock(customerId, "canceling");
      if (!cancelLock.acquired) {
        request.log.warn(
          {
            customerId,
            parkedIntentHash: receipt.intentHash,
            heldBy: cancelLock.heldBy,
          },
          "[me/anonymize] cancel-deletion refused — anonymize TX already in flight",
        );
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message:
            "Solicitação de anonimização já em andamento; não é possível cancelar.",
        });
      }

      // (a.2) audit-2026-05-25 (I8) — TOCTOU re-read of the receipt
      // INSIDE the lock. Pre-fix the receipt was read at the top of the
      // handler, then the lock was acquired ~ms later; between those two
      // steps the grace-resolver could acquire the lock first, anonymize
      // the customer, clear the receipt, and release the lock — leaving
      // a fresh-to-acquire lock and a now-empty receipt slot. The cancel
      // handler would then SETNX-acquire the freed lock, proceed against
      // an already-anonymized customer, and return 200 'cancelado.' The
      // customer saw explicit cancel-success while their data was gone.
      // LGPD Art. 18 silent denial.
      //
      // Fix: re-read inside the lock. If the receipt is gone, the
      // resolver won the race; surface 410 Gone with an audit-trail
      // log line (`lgpd.cancel.refused.race_lost`) and release the
      // lock immediately.
      const receiptStillPresent = await readPendingDeletion(customerId);
      if (!receiptStillPresent) {
        request.log.warn(
          {
            customerId,
            originalParkedIntentHash: receipt.intentHash,
          },
          "[me/anonymize] cancel-deletion race_lost — resolver completed between receipt-read and lock-acquire",
        );
        await releaseAnonymizeActiveLock(customerId, cancelLock.lockValue);
        return reply.code(410).send({
          statusCode: 410,
          error: "Gone",
          message:
            "A janela de cancelamento expirou. Sua solicitação de exclusão já foi processada.",
        });
      }

      // (b) Build the cancel envelope. Same actor / taint as the
      // anonymize envelope so the audit trail is consistent.
      //
      // ── P0-7 (audit-2026-05-24) — deterministic idempotency-key ───────
      //
      // The cancel maps 1:1 to the parked anonymize receipt — bind the
      // nonce to `receipt.intentHash` so retries of the same cancel
      // (browser double-click, network blip) collapse to one audit
      // entry. The Idempotency-Key header still wins for client-driven
      // dedup.
      const cancelIdempotencyKey = resolveMeIdempotencyKey(
        request.headers["idempotency-key"],
        `${customerId}:anonymize:cancel:${receipt.intentHash}`,
      );
      const payload: CustomerAnonymizeCancelPayload = { customerId };
      const envelope = buildCustomerEnvelope<
        "customer.anonymize.cancel",
        CustomerAnonymizeCancelPayload
      >({
        kind: "customer.anonymize.cancel",
        payload,
        nonce: deriveMeNonce(cancelIdempotencyKey),
        customerId,
      });

      const state = {
        ctx: {
          ...identityCtx(customerId, "web"),
          customerExists: true,
          isAuthenticated: true,
          // The pack reads `otpFresh` for cancel too — we treat the
          // existence of the pending receipt as the auth gate (cancel
          // is non-destructive; no OTP needed).
          otpFresh: true,
          hasParkedAnonymize: true,
          parkedAnonymizeAt: receipt.parkedAt,
          now: new Date(),
        } as unknown as CustomerOnboardingState["ctx"],
      };

      // (c) Adjudicate. The pack's policy is expected to REFUSE with
      // `customer.anonymize.cancel_supersedes_parked` — that's the
      // "supersedes-parked" semantics: the cancel itself doesn't execute
      // anything; it just REFUSEs in a way that signals the parked
      // deletion is now void.
      //
      // Wrap the entire adjudicate + cleanup + cooldown section in
      // try/finally so the anonymize-active mutex is always released
      // (CLAUDE.md rule #10 — ownership-checked Lua release).
      try {
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
      } finally {
        // (f) audit-2026-05-24 P0-3 — release the anonymize-active mutex.
        // Ownership-safe Lua DEL so we cannot inadvertently release a
        // freshly-acquired lock held by the resolver if our TX ran past
        // the 60s TTL.
        await releaseAnonymizeActiveLock(customerId, cancelLock.lockValue);
      }
    },
  );
}
