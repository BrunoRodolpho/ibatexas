/**
 * Database cleanup helpers, driven by the `db-tables` registry so they can never
 * drift from the schema. Covers all three layers in the shared DATABASE_URL:
 *   - domain / reference  → Prisma `deleteMany` (FK-safe, children first)
 *   - kernel / memory      → raw-SQL `TRUNCATE` (partitioned parents cascade)
 */
import type { prisma as prismaInstance } from "@ibatexas/domain"
import {
  DOMAIN_DELETE_ORDER,
  DOMAIN_REFERENCE,
} from "./db-tables.js"
import type { PgClientLike } from "./sql-migrate.js"

type PrismaInstance = typeof prismaInstance

/** Structural view of the Prisma delegates the registry references. */
type DelegateMap = Record<
  string,
  { deleteMany: () => Promise<unknown>; count: () => Promise<number> }
>

async function deleteDelegates(
  prisma: PrismaInstance,
  delegates: readonly string[],
): Promise<void> {
  const map = prisma as unknown as DelegateMap
  for (const name of delegates) {
    await map[name].deleteMany()
  }
}

/** Delete all rows from business/observability domain tables (children first). */
export async function cleanDomainTables(prisma: PrismaInstance): Promise<void> {
  await deleteDelegates(prisma, DOMAIN_DELETE_ORDER)
}

/** Delete all rows from operational config/reference tables (children first). */
export async function cleanReferenceTables(prisma: PrismaInstance): Promise<void> {
  await deleteDelegates(prisma, DOMAIN_REFERENCE)
}

export interface TableCount {
  readonly name: string
  readonly count: number
}

/** Row counts for the given Prisma delegates — used by `db clean --dry-run`. */
export async function countDomainTables(
  prisma: PrismaInstance,
  delegates: readonly string[],
): Promise<TableCount[]> {
  const map = prisma as unknown as DelegateMap
  return Promise.all(
    delegates.map(async (name) => ({ name, count: await map[name].count() })),
  )
}

/**
 * TRUNCATE raw-SQL tables (kernel / claustrum) in a single statement. Partitioned
 * parents (intent_audit, claustrum_memory_episodic) cascade to their partitions
 * automatically; RESTART IDENTITY resets owned sequences. Tables that don't exist
 * yet are skipped (via to_regclass) so a clean works even before provisioning.
 * Returns the names actually truncated.
 */
export async function truncateRawTables(
  client: PgClientLike,
  tables: readonly string[],
): Promise<string[]> {
  const existing = await filterExistingTables(client, tables)
  if (existing.length === 0) return []
  const list = existing.map((t) => `"${t}"`).join(", ")
  await client.query(`TRUNCATE ${list} RESTART IDENTITY`)
  return existing
}

/** Row counts for raw-SQL tables; `exists: false` when not yet provisioned. */
export async function countRawTables(
  client: PgClientLike,
  tables: readonly string[],
): Promise<Array<TableCount & { exists: boolean }>> {
  const out: Array<TableCount & { exists: boolean }> = []
  for (const name of tables) {
    if (!(await tableExists(client, name))) {
      out.push({ name, count: 0, exists: false })
      continue
    }
    const res = await client.query(`SELECT count(*)::int AS n FROM "${name}"`)
    out.push({ name, count: Number(res.rows[0]?.n ?? 0), exists: true })
  }
  return out
}

async function tableExists(client: PgClientLike, name: string): Promise<boolean> {
  const res = await client.query("SELECT to_regclass($1) AS reg", [name])
  return Boolean(res.rows[0]?.reg)
}

async function filterExistingTables(
  client: PgClientLike,
  tables: readonly string[],
): Promise<string[]> {
  const existing: string[] = []
  for (const t of tables) {
    if (await tableExists(client, t)) existing.push(t)
  }
  return existing
}
