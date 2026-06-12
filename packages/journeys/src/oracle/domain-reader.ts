// oracle/domain-reader.ts — read-only domain lookups + the audit-namespace
// hash, over the SELECT-only oracle role (T1a-13).
//
// Three things live here, all consumed by the `ibx journey run` harness:
//
//   hashedAuditSessionId  Byte-for-byte mirror of the audit sink's salted
//                         sessionId hash (`hashValue`, packages/audit-sink/
//                         src/audit-redactor.ts:1106-1111): `hashed:` +
//                         sha256(value || AUDIT_REDACT_SECRET).hex.slice(0,8).
//                         The redactor hashes EVERY envelope actor.sessionId
//                         before the intent_audit row lands (:847), so the
//                         run's audit namespace is the HASHED form of the
//                         chat sessionId / customerId — the binding T1a-5
//                         live finding (chat-client.live.test.ts).
//
//   createDomainReader    Read-only precondition/goal-state lookups over the
//                         ibx_domain schema via the oracle pg pool
//                         (requireOracleDatabaseUrl — structurally incapable
//                         of writes). Used to resolve the seeded customer
//                         (fixture acts) and the run's order projection
//                         (http-act path binding + order.goal-state).
//
//   projectionBarrierPrisma  Adapter satisfying the T1a-6 barrier's
//                         structural Prisma subset over the same pg pool, so
//                         `awaitProjection` (the projection barrier) runs on
//                         the oracle plane without a Prisma client. Supports
//                         exactly the where-shapes the harness composes
//                         (id / customerId [+ createdAt gte]) and fails
//                         loudly on anything else.

import { createHash } from "node:crypto"
import pg from "pg"
import { requireOracleDatabaseUrl } from "./oracle-database-url.js"
import type {
  OrderEventLogRow,
  OrderProjectionRow,
  ProjectionBarrierPrisma,
} from "./projection-barrier.js"

// ── Audit-namespace hash (T1a-5 live finding — binding for run scoping) ──────

/**
 * The audit sink's salted sessionId hash. `redactSecret` is the stack's
 * AUDIT_REDACT_SECRET (.env.test; "" tolerated exactly as the sink tolerates
 * it). NEVER log the secret — only the resulting `hashed:xxxxxxxx` token.
 */
export function hashedAuditSessionId(sessionId: string, redactSecret: string): string {
  const h = createHash("sha256")
  h.update(sessionId)
  h.update(redactSecret)
  return `hashed:${h.digest("hex").slice(0, 8)}`
}

// ── Read-only domain reader ──────────────────────────────────────────────────

export interface DomainCustomerRow {
  id: string
  phone: string
  name: string | null
}

export interface DomainOrderProjectionRow {
  id: string
  displayId: number
  customerId: string | null
  fulfillmentStatus: string
  paymentMethod: string | null
  deliveryType: string | null
  version: number
  createdAt: Date
}

export interface DomainVariantRow {
  id: string
  title: string | null
  productHandle: string
}

export interface DomainReader {
  /** Seeded-customer precondition lookup (fixture acts resolve, never write). */
  customerByPhone(phone: string): Promise<DomainCustomerRow | null>
  /**
   * Catalog-variant precondition lookup over the Medusa tables (public
   * schema — the oracle role has SELECT there). `variantTitle` (e.g. "1kg")
   * disambiguates multi-variant products; without it the first variant by
   * (created_at, id) is returned.
   */
  variantByHandle(handle: string, variantTitle?: string): Promise<DomainVariantRow | null>
  /**
   * The customer's most-recent order projection (the same "most recent"
   * ordering the SUT's auto-resolve uses — resolve-and-assemble.ts), optionally
   * restricted to projections created at/after `since` so a run only ever
   * binds to an order it created itself.
   */
  latestOrderForCustomer(
    customerId: string,
    since?: Date,
  ): Promise<DomainOrderProjectionRow | null>
  orderById(orderId: string): Promise<DomainOrderProjectionRow | null>
  /**
   * Product handles of the order's CURRENT Medusa line items (public-schema
   * Medusa order tables — the write-side commerce truth, so a post-checkout
   * amendment that went through the Medusa order-edit flow is visible here
   * even before any projection refresh). Joined variant→product because the
   * denormalized order_line_item columns vary across Medusa versions; rows
   * are deduplicated. Consumed by the `order.goal-state` binding's
   * `containsItemHandle` arg (T1b-0).
   */
  orderItemHandles(orderId: string): Promise<string[]>
  /** Ends the pool iff the reader created it. */
  close(): Promise<void>
}

export interface CreateDomainReaderOptions {
  /** Inject a pool/double (tests). Default: a pg Pool from requireOracleDatabaseUrl(env). */
  pool?: { query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> }
  /** Env source for ORACLE_DATABASE_URL (default process.env). */
  env?: Record<string, string | undefined>
}

const ORDER_PROJECTION_COLUMNS =
  `id, display_id AS "displayId", customer_id AS "customerId", ` +
  `fulfillment_status AS "fulfillmentStatus", payment_method AS "paymentMethod", ` +
  `delivery_type AS "deliveryType", version, created_at AS "createdAt"`

export function createDomainReader(opts: CreateDomainReaderOptions = {}): DomainReader {
  const ownedPool: pg.Pool | undefined =
    opts.pool === undefined
      ? new pg.Pool({ connectionString: requireOracleDatabaseUrl(opts.env), max: 4 })
      : undefined
  const pool = opts.pool ?? (ownedPool as NonNullable<CreateDomainReaderOptions["pool"]>)

  return {
    async customerByPhone(phone) {
      const result = await pool.query(
        `SELECT id, phone, name FROM ibx_domain.customers WHERE phone = $1 LIMIT 1`,
        [phone],
      )
      return (result.rows[0] as DomainCustomerRow | undefined) ?? null
    },

    async variantByHandle(handle, variantTitle) {
      const params: unknown[] = [handle]
      let where = `p.handle = $1 AND pv.deleted_at IS NULL AND p.deleted_at IS NULL`
      if (variantTitle !== undefined) {
        params.push(variantTitle)
        where += ` AND pv.title = $${params.length}`
      }
      const result = await pool.query(
        `SELECT pv.id, pv.title, p.handle AS "productHandle" FROM product_variant pv ` +
          `JOIN product p ON pv.product_id = p.id WHERE ${where} ` +
          `ORDER BY pv.created_at, pv.id LIMIT 1`,
        params,
      )
      return (result.rows[0] as DomainVariantRow | undefined) ?? null
    },

    async latestOrderForCustomer(customerId, since) {
      const params: unknown[] = [customerId]
      let where = `customer_id = $1`
      if (since !== undefined) {
        params.push(since.toISOString())
        where += ` AND created_at >= $${params.length}`
      }
      const result = await pool.query(
        `SELECT ${ORDER_PROJECTION_COLUMNS} FROM ibx_domain.order_projections ` +
          `WHERE ${where} ORDER BY medusa_created_at DESC, created_at DESC LIMIT 1`,
        params,
      )
      return (result.rows[0] as DomainOrderProjectionRow | undefined) ?? null
    },

    async orderById(orderId) {
      const result = await pool.query(
        `SELECT ${ORDER_PROJECTION_COLUMNS} FROM ibx_domain.order_projections WHERE id = $1`,
        [orderId],
      )
      return (result.rows[0] as DomainOrderProjectionRow | undefined) ?? null
    },

    async orderItemHandles(orderId) {
      // Medusa v2 order items: order_item links the order to its (versioned)
      // order_line_item rows; variant→product resolves the seed-stable
      // handle. Soft-deleted rows are excluded; an item REMOVED by an order
      // edit keeps its row with quantity 0, so zero-quantity links are
      // excluded too (this method answers "does the order CONTAIN x now?").
      const result = await pool.query(
        `SELECT DISTINCT p.handle FROM order_item oi ` +
          `JOIN order_line_item oli ON oli.id = oi.item_id ` +
          `JOIN product_variant pv ON pv.id = oli.variant_id ` +
          `JOIN product p ON p.id = pv.product_id ` +
          `WHERE oi.order_id = $1 AND oi.deleted_at IS NULL ` +
          `AND oli.deleted_at IS NULL AND oi.quantity > 0`,
        [orderId],
      )
      return (result.rows as Array<{ handle: string }>).map((r) => r.handle)
    },

    async close() {
      await ownedPool?.end()
    },
  }
}

// ── ProjectionBarrierPrisma over pg (oracle plane) ───────────────────────────

class UnsupportedBarrierWhereError extends Error {
  constructor(model: string, where: Record<string, unknown>) {
    super(
      `projectionBarrierPrisma: unsupported where-shape for ${model}: ` +
        `${JSON.stringify(Object.keys(where))} — the pg adapter supports exactly ` +
        `{id} | {customerId[, createdAt: {gte}]} (orderProjection) and {orderId} (orderEventLog)`,
    )
    this.name = "UnsupportedBarrierWhereError"
  }
}

/**
 * Adapt the oracle pg pool to the T1a-6 barrier's structural Prisma subset.
 * `findFirst` on a customerId filter returns the MOST-RECENT projection
 * (`medusa_created_at DESC`) — the same ordering the SUT's auto-resolve uses,
 * so the barrier and the kernel look at the same order.
 */
export function projectionBarrierPrisma(pool: {
  query(text: string, values: unknown[]): Promise<{ rows: unknown[] }>
}): ProjectionBarrierPrisma {
  return {
    orderProjection: {
      async findFirst(args): Promise<OrderProjectionRow | null> {
        const where = args.where
        const params: unknown[] = []
        const clauses: string[] = []
        for (const [key, value] of Object.entries(where)) {
          if (key === "id" && typeof value === "string") {
            params.push(value)
            clauses.push(`id = $${params.length}`)
          } else if (key === "customerId" && typeof value === "string") {
            params.push(value)
            clauses.push(`customer_id = $${params.length}`)
          } else if (
            key === "createdAt" &&
            typeof value === "object" &&
            value !== null &&
            "gte" in (value as Record<string, unknown>)
          ) {
            const gte = (value as { gte: Date | string }).gte
            params.push(gte instanceof Date ? gte.toISOString() : gte)
            clauses.push(`created_at >= $${params.length}`)
          } else {
            throw new UnsupportedBarrierWhereError("orderProjection", where)
          }
        }
        if (clauses.length === 0) throw new UnsupportedBarrierWhereError("orderProjection", where)
        const result = await pool.query(
          `SELECT id, version, display_id AS "displayId", customer_id AS "customerId", ` +
            `fulfillment_status AS "fulfillmentStatus", created_at AS "createdAt" ` +
            `FROM ibx_domain.order_projections WHERE ${clauses.join(" AND ")} ` +
            `ORDER BY medusa_created_at DESC, created_at DESC LIMIT 1`,
          params,
        )
        return (result.rows[0] as OrderProjectionRow | undefined) ?? null
      },
    },
    orderEventLog: {
      async findMany(args): Promise<OrderEventLogRow[]> {
        const where = args.where
        const orderId = where["orderId"]
        if (typeof orderId !== "string" || Object.keys(where).length !== 1) {
          throw new UnsupportedBarrierWhereError("orderEventLog", where)
        }
        const direction = args.orderBy?.["createdAt"] === "desc" ? "DESC" : "ASC"
        const result = await pool.query(
          `SELECT id, order_id AS "orderId", event_type AS "eventType", ` +
            `idempotency_key AS "idempotencyKey", payload, created_at AS "createdAt" ` +
            `FROM ibx_domain.order_event_log WHERE order_id = $1 ORDER BY created_at ${direction}`,
          [orderId],
        )
        return result.rows as OrderEventLogRow[]
      },
    },
  }
}
