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
import {
  getRedisClient,
  invalidateDeliveryCache,
  rk,
  type DeliveryCacheInvalidationClient,
} from "@ibatexas/tools";
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
// this module by reading every `redis` occurrence in the file, not just the
// command sites:
//   • ISSUED here: `set`, once, in the dedup gate — bound to a function-local
//     `const` and issued on it directly.
//   • HANDED TO downstream: `invalidateDeliveryCache`, at the three mutating
//     sites. This half used to be EMPTY and is no longer; see below.
//
// ── The HAND-IT-TO read: the callee that ACCEPTS a client, now THREADED ────
//
// `invalidateDeliveryCache()` used to be called at all three mutating sites
// with ZERO arguments, so it resolved its OWN singleton — a LATENT hand-off,
// neither a hand-off nor a non-hand-off. F-42 closed it: all three sites now
// pass this route's threaded client, so the callee IS downstream of this Pick
// and the Pick below absorbs its commands.
//
// The hazard that made closing it worth a slice is the #539 swallowing shape.
// `invalidateDeliveryCache`'s body is a bare try/catch with an empty handler,
// so a Pick derived from what this route ISSUES (`{set}` alone) would leave
// `scan` absent, the TypeError would be absorbed by that catch, and the cache
// would silently never be invalidated — every suite green while a zone edit
// stops showing up in chat. The Pick is therefore widened by UNION with the
// callee's own honest Pick, not derived from this file's command usage:
//
//     {set}  ∪  DeliveryCacheInvalidationClient ({scan, del})  =  {set, scan, del}
//
// `DeliveryCacheInvalidationClient` (`@ibatexas/tools`) is the invalidation
// path's re-derived Pick — `scan` + `del` and nothing else. It is NOT the
// wider `DeliveryCacheClient` (`{get, set, scan, del}`), which is the union
// across BOTH of that module's entry points; `get`/`set` belong to
// `estimateDelivery`'s read-through cache, which this route never enters, so
// naming them here would falsify the EXHAUSTIVE claim below to buy nothing.
//
// Its own suite (`packages/tools/src/catalog/__tests__/delivery-cache-seam.test.ts`)
// still drives the seam directly; that is a second DRIVER of one seam, not a
// second composition root — the production client is resolved here and only
// here, and the tools-side default stays the singleton for un-threaded callers.
//
// ── Lua: NONE, in the module's text OR through the ONE hand-off ────────────
//
// No `eval`/`multi`/`evalSha` in this file. The one callee now handed this
// client — `invalidateDeliveryCache` — was read line by line and issues only
// `scan` (the manual cursor loop, not `scanIterator`) and `del`, hands the
// client to nothing further, and runs no feature detection, so no Lua reaches
// the client through it and the in-memory adapter can serve the whole path.
// `atomicIncr` — the `eval` that gated `auth.ts` / `analytics.ts` /
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
 * The EXHAUSTIVE union of Redis commands this route issues DIRECTLY or through
 * a callee it hands the client to — the type `DeliveryZoneRouteDeps.redis`
 * resolves to.
 *
 * Hand-written on purpose rather than derived from the per-consumer types
 * above: a derived union can never disagree with its consumers, so it could
 * not catch a consumer that grew a command nobody declared (F-14). Concretely
 * that means this literal is NOT written as
 * `ZoneDedupRedis & DeliveryCacheInvalidationClient` — spelling out
 * `"set" | "scan" | "del"` is what keeps the F-42 assertion below a real claim
 * rather than a restatement of the callee's own type.
 */
export type DeliveryZoneRouteRedisClient = Pick<RedisClient, "set" | "scan" | "del">;

/**
 * The invalidation consumer's slice — what `invalidateDeliveryCache` receives.
 *
 * Declared as the callee's own exported Pick rather than re-spelled here, so
 * that if the callee ever grows a command this alias widens with it and
 * `invalidateZoneCache` below stops accepting `deps.redis` — a `tsc` failure,
 * which is the ONLY signal available given the callee's empty catch turns a
 * missing command into silence at runtime.
 */
type ZoneCacheInvalidationRedis = DeliveryCacheInvalidationClient;

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

/**
 * Fire-and-forget the delivery cache invalidation on THIS route's client.
 *
 * Shaped to preserve, exactly, what `void invalidateDeliveryCache()` did:
 *
 *   • Nothing is awaited on the response path. `deps.redis` is a factory, and
 *     awaiting it here would put a Redis round trip in front of the reply on
 *     mutations that today never resolve a client at all (the dedup guard only
 *     resolves one when an `x-request-id` header is present).
 *   • A Redis outage still degrades silently rather than throwing later.
 *     `getRedisClient()` used to reject INSIDE the callee's own catch; the
 *     rejection handler below is that catch, moved to where the resolution now
 *     happens. Without it a rejected factory would surface as an unhandled
 *     rejection — a NEW failure mode this slice must not introduce.
 *
 * The cache stays warm until its 1h TTL in that case, which is the behaviour
 * the singleton path already had.
 */
function invalidateZoneCache(
  resolveRedis: () => Promise<ZoneCacheInvalidationRedis>,
): void {
  void resolveRedis().then(
    (client) => invalidateDeliveryCache({ client }),
    () => {
      // Redis unreachable — best-effort invalidation, same as before.
    },
  );
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
      invalidateZoneCache(deps.redis);
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
      invalidateZoneCache(deps.redis);
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
      invalidateZoneCache(deps.redis);
      return reply.send({ ok: true });
    },
  );
}
