import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getRedisClient,
  rk,
  medusaAdjudicated,
  MedusaAdjudicateRefusedError,
  MedusaAdjudicateDeferredError,
  MedusaAdjudicateNeedsReviewError,
} from "@ibatexas/tools";
import { getAuditSink } from "@ibatexas/audit-sink";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { medusaAdmin } from "./_shared.js";

const ProductsAdminQuery = z.object({
  q: z.string().optional(),
  category_id: z.string().optional(),
  productType: z.enum(["food", "frozen", "merchandise"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ProductParams = z.object({ id: z.string().min(1) });

const ProductPatchBody = z.object({
  status: z.enum(["published", "draft"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;

// ── R5 rollout, family 5 — this route's Redis client seam ───────────────────
//
// The ONE `getRedisClient()` call this module used to make directly now
// resolves through `AdminProductRouteDeps.redis`. This file had no composition
// root before; the one below is `redis`-only by design — the two Medusa
// collaborators (`medusaAdmin`, `medusaAdjudicated`) are a separate seam
// question and are untouched here.
//
// ── THE FAIL-CLOSED PICK ANALYSIS (the #539 / #543 / #548 rule) ─────────────
//
// The honest Pick is {issued} ∪ {optionally consumed downstream}. MEASURED for
// this module: the downstream half is EMPTY. Every `redis` occurrence in the
// file was read (not just the one call site): the client is bound to a
// handler-local `const` and its single command is issued on it directly. No
// site passes `redis` to anything.
//
// ── The HAND-IT-TO read (#548's rule, and its negative half) ───────────────
//
// `medusaAdjudicated({...})` is the one collaborator that LOOKS like it could
// carry a client — it is the kernel-gated egress, and the execution ledger is
// Redis-backed. It does NOT: `MedusaAdjudicatedArgs` has no Redis member
// (scope / method / path / payload / intentKind / idempotencyKey /
// sourceSubject / auditSink / log), and `packages/tools/src/medusa/
// adjudicated.ts` issues no Redis command at all — `adjudicate()` is pure, and
// its three mentions of "Redis"/"ledger" are comments. `medusaAdmin` is HTTP
// and `getAuditSink()` takes no arguments.
//
// So there is no `atomicIncr`-shaped hand-off here, and no `eval`/`multi` in
// the module's own text.
//
// ── Feature detection: MEASURED, none ─────────────────────────────────────
//
// `typeof client.X === "function"` was swept over `apps/api/src/routes`,
// `apps/api/src/middleware` and `packages/tools/src`: zero live Redis probes.

/**
 * The PATCH idempotency dedup gate: one `SET key "1" EX 300 NX`, whose null
 * return IS the duplicate verdict.
 */
type ProductDedupRedis = Pick<RedisClient, "set">;

/**
 * The EXHAUSTIVE union of Redis commands this route issues — the type
 * `AdminProductRouteDeps.redis` resolves to.
 *
 * Hand-written on purpose rather than derived from the per-consumer type
 * above: a derived union can never disagree with its consumer, so it could
 * not catch a consumer that grew a command nobody declared (F-14).
 */
export type AdminProductRouteRedisClient = Pick<RedisClient, "set">;

/** The collaborators `admin/products.ts` resolves through the seam. */
export interface AdminProductRouteDeps {
  /**
   * Resolves the Redis client the PATCH idempotency gate issues against.
   *
   * A FACTORY returning a promise, not an instance, so the `await` stays
   * exactly where it was — per REQUEST, inside the guard. An instance would
   * hoist the resolution to registration and change when a Redis outage first
   * surfaces (today: on the first PATCH carrying an `x-request-id` — never at
   * boot).
   */
  readonly redis: () => Promise<AdminProductRouteRedisClient>;
}

/**
 * Fastify plugin options. Overrides nest under `deps` so no member collides
 * with a Fastify-reserved register option (`prefix`, `logLevel`,
 * `logSerializers`); omitted or partial → the production default fills the
 * remainder, so the registration in routes/admin/index.ts is unchanged.
 */
export interface AdminProductRoutesOptions {
  readonly deps?: Partial<AdminProductRouteDeps>;
}

/** The production set — byte-for-byte the resolution this file did inline. */
function defaultAdminProductRouteDeps(): AdminProductRouteDeps {
  return { redis: () => getRedisClient() };
}

function resolveAdminProductRouteDeps(
  options?: AdminProductRoutesOptions,
): AdminProductRouteDeps {
  return { ...defaultAdminProductRouteDeps(), ...(options?.deps ?? {}) };
}

export async function productRoutes(
  server: FastifyInstance,
  options?: AdminProductRoutesOptions,
): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  // Resolved ONCE per registration. The member is a factory, so NOTHING is
  // resolved here — the client is still awaited per request, inside the guard.
  const deps = resolveAdminProductRouteDeps(options);

  // ── GET /api/admin/products ────────────────────────────────────────────────
  app.get(
    "/api/admin/products",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar produtos (admin)",
        querystring: ProductsAdminQuery,
      },
    },
    async (request, reply) => {
      const { q, category_id, productType, limit, offset } = request.query;

      const qs = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        fields: "id,title,handle,thumbnail,status,metadata,variants,categories",
        expand: "variants,variants.prices,categories,tags",
      });
      if (q) qs.set("q", q);
      if (category_id) qs.set("category_id[]", category_id);

      try {
        const data = await medusaAdmin(`/admin/products?${qs}`) as Record<string, unknown>;
        const products = (data.products ?? []) as {
          id: string;
          title: string;
          handle: string;
          thumbnail: string | null;
          status: string;
          metadata: Record<string, unknown> | null;
          variants: { id: string; prices?: { amount: number; currency_code: string }[] }[];
          categories: { handle: string; name: string }[];
        }[];

        const rows = products
          .filter((p) => {
            if (!productType) return true;
            return (
              (p.metadata?.productType ?? "food") === productType
            );
          })
          .map((p) => {
            // Extract the lowest BRL price from all variants
            // Medusa v2 stores in reais — convert to centavos (our convention)
            const brlPrices = (p.variants ?? [])
              .flatMap((v) => v.prices ?? [])
              .filter((pr) => pr.currency_code === "brl")
              .map((pr) => Math.round(pr.amount * 100));
            const price = brlPrices.length > 0 ? Math.min(...brlPrices) : 0;

            return {
              id: p.id,
              title: p.title,
              handle: p.handle,
              imageUrl: p.thumbnail,
              category: p.categories?.[0]?.name ?? "—",
              price,
              status: p.status,
              productType: (p.metadata?.productType ?? "food") as string,
              variantCount: p.variants?.length ?? 0,
              inStock: p.metadata?.inStock !== false,
            };
          });

        return reply.send({ products: rows, count: rows.length });
      } catch (err) {
        server.log.error(err, "Failed to fetch products from Medusa");
        reply.code(502).send({ error: "Failed to fetch products from Medusa" });
      }
    },
  );

  // ── PATCH /api/admin/products/:id ─────────────────────────────────────────
  app.patch(
    "/api/admin/products/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Atualizar produto (admin)",
        params: ProductParams,
        body: ProductPatchBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const requestId = request.headers["x-request-id"] as string | undefined;

      // Idempotency guard via x-request-id (catches double-clicks)
      if (requestId) {
        const redis: ProductDedupRedis = await deps.redis();
        const dedupKey = rk(`product:update:dedup:${requestId}`);
        const isNew = await redis.set(dedupKey, "1", { EX: 300, NX: true });
        if (!isNew) {
          return reply.code(409).send({ error: "Requisicao duplicada." });
        }
      }

      try {
        // Kernel-gated egress (P0-X9): admin product PATCH is a mutating
        // Medusa write — must route through medusaAdjudicated for audit +
        // governance. The wrapper enforces SYSTEM taint internally; the
        // outer route handler already enforces requireManagerRole.
        const staffId = request.staffId ?? "unknown";
        const idempotencyKey = requestId ?? randomUUID();
        const data = await medusaAdjudicated<typeof body, Record<string, unknown>>({
          scope: "admin",
          method: "POST",
          path: `/admin/products/${id}`,
          payload: body,
          intentKind: "medusa.admin.product.update",
          idempotencyKey,
          sourceSubject: `route:PATCH /api/admin/products/:id:admin:${staffId}`,
          auditSink: getAuditSink(),
          log: server.log,
        });
        return reply.send({ product: data.product });
      } catch (err) {
        if (err instanceof MedusaAdjudicateRefusedError) {
          return reply.code(403).send({ error: err.userFacing, code: err.code });
        }
        if (err instanceof MedusaAdjudicateDeferredError) {
          return reply.code(202).send({
            status: "deferred",
            signal: err.signal,
            message: "Operação aguardando confirmação.",
          });
        }
        if (err instanceof MedusaAdjudicateNeedsReviewError) {
          return reply.code(503).send({
            error: "Operação requer atendimento humano.",
          });
        }
        server.log.error(err, "Failed to update product");
        reply.code(502).send({ error: "Failed to update product" });
      }
    },
  );

  // ── GET /api/admin/products/:id ─────────────────────────────────────────
  app.get(
    "/api/admin/products/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Detalhe do produto com variantes (admin)",
        params: ProductParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const data = await medusaAdmin(
          `/admin/products/${id}?expand=variants,variants.prices,categories,tags`,
        ) as Record<string, unknown>;
        const p = data.product as {
          id: string;
          title: string;
          handle: string;
          description: string | null;
          thumbnail: string | null;
          status: string;
          metadata: Record<string, unknown> | null;
          categories: { name: string }[];
          tags: { value: string }[];
          variants: {
            id: string;
            title: string;
            sku: string | null;
            inventory_quantity: number;
            allow_backorder: boolean;
            manage_inventory: boolean;
            prices: { amount: number; currency_code: string }[];
          }[];
        };

        const variantRows = (p.variants ?? []).map((v) => ({
              id: v.id,
              title: v.title,
              sku: v.sku,
              // Medusa v2 stores in reais — convert to centavos (our convention)
              price: Math.round(
                (v.prices?.find((pr) => pr.currency_code === "brl")?.amount ?? 0) * 100
              ),
              inventoryQuantity: v.inventory_quantity,
              allowBackorder: v.allow_backorder,
              manageInventory: v.manage_inventory,
            }));

        // Product-level price: lowest BRL variant price (already in centavos)
        const brlPrices = variantRows.map((v) => v.price).filter((p) => p > 0);
        const productPrice = brlPrices.length > 0 ? Math.min(...brlPrices) : 0;

        return reply.send({
          product: {
            id: p.id,
            title: p.title,
            handle: p.handle,
            description: p.description,
            imageUrl: p.thumbnail,
            category: p.categories?.[0]?.name ?? "—",
            price: productPrice,
            status: p.status,
            productType: (p.metadata?.productType ?? "food") as string,
            variantCount: p.variants?.length ?? 0,
            inStock: p.metadata?.inStock !== false,
            tags: (p.tags ?? []).map((t) => t.value),
            variants: variantRows,
          },
        });
      } catch (err) {
        server.log.error(err, "Failed to fetch product detail");
        reply.code(502).send({ error: "Failed to fetch product detail" });
      }
    },
  );
}
