// Admin delivery zone CRUD
//
// GET    /api/admin/delivery-zones        — list all zones
// POST   /api/admin/delivery-zones        — create zone
// PUT    /api/admin/delivery-zones/:id    — update zone
// DELETE /api/admin/delivery-zones/:id   — delete zone

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createDeliveryZoneService } from "@ibatexas/domain";
import { getRedisClient, invalidateDeliveryCache, rk } from "@ibatexas/tools";
import { requireManagerRole } from "../../middleware/staff-auth.js";

const DeliveryZoneIdParams = z.object({ id: z.string().min(1) });

const CepEntry = z.string().regex(/^\d{5}(\d{3})?$/, "CEP deve ter 5 dígitos (prefixo) ou 8 dígitos (completo)");

const DeliveryZoneBody = z.object({
  name: z.string().min(1).max(100),
  cepPrefixes: z.array(CepEntry).min(1, "Informe ao menos um CEP"),
  feeInCentavos: z.number().int().min(0),
  estimatedMinutes: z.number().int().min(1).max(180),
  active: z.boolean().optional().default(true),
});

type DeliveryZoneService = ReturnType<typeof createDeliveryZoneService>;

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;

// ── R5 rollout, family 5 — this route's Redis client seam ───────────────────
//
// The ONE `getRedisClient()` call this module used to make directly now
// resolves through `DeliveryZoneRouteDeps.redis`.
//
// ── THE FAIL-CLOSED PICK ANALYSIS (the #539 / #543 / #548 rule) ─────────────
//
// The honest Pick is {issued} ∪ {optionally consumed downstream}. MEASURED for
// this module: the downstream half is EMPTY. Every `redis` occurrence in the
// file was read (not just the one call site): the client is bound to a
// function-local `const` and its single command is issued on it directly. No
// site passes `redis` to anything.
//
// ── The HAND-IT-TO read, and the one callee that ACCEPTS a client ──────────
//
// `invalidateDeliveryCache()` is called at all three mutating sites with ZERO
// arguments, so it resolves its OWN singleton and is not downstream of this
// Pick. It is worth naming because — unlike `withLock`, which takes no client
// at all (#548's negative measurement) — this one CAN take one:
// `invalidateDeliveryCache(options?: DeliveryCacheOptions)` accepts
// `options.client`, a `Pick<RedisClientType, "get"|"set"|"scan"|"del">`
// (`packages/tools/src/catalog/estimate-delivery.ts`).
//
// It is deliberately NOT collapsed into this seam, for two reasons that point
// the same way:
//
//   1. It already HAS its own client seam, with its own suite
//      (`packages/tools/src/catalog/__tests__/delivery-cache-seam.test.ts`).
//      Threading it from here would give one path two composition roots.
//   2. Its body is a bare `try { … } catch { /* Best-effort */ }`. That is
//      exactly the #539 swallowing shape: whoever DOES thread it must widen
//      this Pick to {set, scan, del}, because a Pick derived from what this
//      route issues would leave `scan` absent, the TypeError absorbed by that
//      catch, and the cache silently never invalidated — green.
//
// Threading it stays SAFE whenever someone wants it (its commands are
// `scan`/`del`, no Lua), so unlike `order-actions.ts`'s CONSUME store the
// boundary here is a scope call, not a classification one.
//
// ── Lua: NONE, in the module's text OR through a hand-off ──────────────────
//
// No `eval`/`multi`/`evalSha` in this file, and no callee is handed this
// client. `atomicIncr` — the `eval` that gated `auth.ts` / `analytics.ts` /
// `whatsapp-webhook.ts` in #548 — is not imported here.
//
// ── Feature detection: MEASURED, none ─────────────────────────────────────
//
// `typeof client.X === "function"` was swept over `apps/api/src/routes`,
// `apps/api/src/middleware` and `packages/tools/src`: zero live Redis probes
// (the hits are comments describing the F-22 rule, plus non-Redis timer /
// Prisma / thenable probes).

/**
 * The idempotency dedup gate shared by create / update / delete: one
 * `SET key "1" EX 300 NX`, whose null return IS the duplicate verdict.
 */
type ZoneDedupRedis = Pick<RedisClient, "set">;

/**
 * The EXHAUSTIVE union of Redis commands this route issues — the type
 * `DeliveryZoneRouteDeps.redis` resolves to.
 *
 * Hand-written on purpose rather than derived from the per-consumer type
 * above: a derived union can never disagree with its consumer, so it could
 * not catch a consumer that grew a command nobody declared (F-14).
 */
export type DeliveryZoneRouteRedisClient = Pick<RedisClient, "set">;

/** The collaborators `admin/delivery-zones.ts` resolves through the seam. */
export interface DeliveryZoneRouteDeps {
  /**
   * Resolves the Redis client the idempotency gate issues against.
   *
   * A FACTORY returning a promise, not an instance, so the `await` stays
   * exactly where it was — per REQUEST, inside the guard that needs it. An
   * instance would hoist the resolution to registration and change when a
   * Redis outage first surfaces (today: on the first mutating admin request,
   * as a 500 — never at boot).
   */
  readonly redis: () => Promise<DeliveryZoneRouteRedisClient>;
}

/**
 * Fastify plugin options. Overrides nest under `deps` so no member collides
 * with a Fastify-reserved register option (`prefix`, `logLevel`,
 * `logSerializers`); omitted or partial → the production default fills the
 * remainder, so the registration in routes/admin/index.ts is unchanged.
 */
export interface DeliveryZoneRoutesOptions {
  readonly deps?: Partial<DeliveryZoneRouteDeps>;
}

/** The production set — byte-for-byte the resolution this file did inline. */
function defaultDeliveryZoneRouteDeps(): DeliveryZoneRouteDeps {
  return { redis: () => getRedisClient() };
}

function resolveDeliveryZoneRouteDeps(
  options?: DeliveryZoneRoutesOptions,
): DeliveryZoneRouteDeps {
  return { ...defaultDeliveryZoneRouteDeps(), ...(options?.deps ?? {}) };
}

// Idempotency guard shared by the mutating zone routes (create/update/delete).
// Returns true when a duplicate request was detected and a 409 was already sent.
async function rejectIfDuplicateRequest(
  resolveRedis: () => Promise<ZoneDedupRedis>,
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
): Promise<boolean> {
  const requestId = request.headers["x-request-id"] as string | undefined;
  if (!requestId) return false;
  const redis: ZoneDedupRedis = await resolveRedis();
  const isNew = await redis.set(rk(`dz:${action}:dedup:${requestId}`), "1", { EX: 300, NX: true });
  if (!isNew) {
    reply.code(409).send({ error: "Requisicao duplicada." });
    return true;
  }
  return false;
}

// Reject CEP prefixes already assigned to another zone. Pass excludeZoneId on
// update to skip the zone being edited. Returns true when a conflict was
// detected and a 422 was already sent.
async function rejectOnCepConflict(
  deliveryZoneSvc: DeliveryZoneService,
  reply: FastifyReply,
  cepPrefixes: string[],
  excludeZoneId?: string,
): Promise<boolean> {
  const existing = await deliveryZoneSvc.listAll();
  const allUsedCeps = new Map<string, string>();
  for (const z of existing) {
    if (excludeZoneId !== undefined && z.id === excludeZoneId) continue;
    for (const c of z.cepPrefixes) allUsedCeps.set(c, z.name);
  }
  const dupes = cepPrefixes.filter((c) => allUsedCeps.has(c));
  if (dupes.length === 0) return false;
  const dupeList = dupes.map((c) => `${c} (${allUsedCeps.get(c)})`).join(", ");
  reply.code(422).send({
    error: "CEPs já atribuídos",
    message: `CEPs já usados em outras zonas: ${dupeList}`,
  });
  return true;
}

export async function deliveryZoneRoutes(
  server: FastifyInstance,
  options?: DeliveryZoneRoutesOptions,
): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  // Resolved ONCE per registration. The member is a factory, so NOTHING is
  // resolved here — the client is still awaited per request, inside the guard.
  const deps = resolveDeliveryZoneRouteDeps(options);

  // GET /api/admin/delivery-zones
  app.get(
    "/api/admin/delivery-zones",
    {
      schema: { tags: ["admin"], summary: "Listar zonas de entrega (admin)" },
    },
    async (_request, reply) => {
      const deliveryZoneSvc = createDeliveryZoneService();
      const zones = await deliveryZoneSvc.listAll();
      return reply.send({ zones });
    },
  );

  // POST /api/admin/delivery-zones
  app.post(
    "/api/admin/delivery-zones",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Criar zona de entrega (admin)",
        body: DeliveryZoneBody,
      },
    },
    async (request, reply) => {
      if (await rejectIfDuplicateRequest(deps.redis, request, reply, "create")) return reply;
      const deliveryZoneSvc = createDeliveryZoneService();
      // Check for duplicate CEPs across existing zones
      if (await rejectOnCepConflict(deliveryZoneSvc, reply, request.body.cepPrefixes)) return reply;
      const zone = await deliveryZoneSvc.create(request.body);
      void invalidateDeliveryCache();
      return reply.code(201).send({ zone });
    },
  );

  // PUT /api/admin/delivery-zones/:id
  app.put(
    "/api/admin/delivery-zones/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Atualizar zona de entrega (admin)",
        params: DeliveryZoneIdParams,
        body: DeliveryZoneBody,
      },
    },
    async (request, reply) => {
      if (await rejectIfDuplicateRequest(deps.redis, request, reply, "update")) return reply;
      const deliveryZoneSvc = createDeliveryZoneService();
      // Check for duplicate CEPs across OTHER zones (exclude the one being updated)
      if (await rejectOnCepConflict(deliveryZoneSvc, reply, request.body.cepPrefixes, request.params.id))
        return reply;
      const zone = await deliveryZoneSvc.update(request.params.id, request.body);
      void invalidateDeliveryCache();
      return reply.send({ zone });
    },
  );

  // DELETE /api/admin/delivery-zones/:id
  app.delete(
    "/api/admin/delivery-zones/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Remover zona de entrega (admin)",
        params: DeliveryZoneIdParams,
      },
    },
    async (request, reply) => {
      if (await rejectIfDuplicateRequest(deps.redis, request, reply, "delete")) return reply;
      const deliveryZoneSvc = createDeliveryZoneService();
      await deliveryZoneSvc.remove(request.params.id);
      void invalidateDeliveryCache();
      return reply.send({ ok: true });
    },
  );
}
