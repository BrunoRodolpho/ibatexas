// live/backfill-lineitem-ids.ts — BKL-167's line-item-id backfill (CLI + library).
// Populates the stable Medusa line-item id (`OrderEventItem.id`, threaded through the
// order projection ADDITIVELY since FE-D15 / PR #295) onto PRE-FE-D15
// `order_projections.itemsJson` rows, so amend hydration + the admin plane
// (routes/admin/orders.ts mapProjectionItems) get precise, stable line references
// instead of the synthetic variantId/index fallback.
//
// RE-DERIVATION (not fragile field-matching): each needing-backfill order is re-fetched
// from Medusa (GET /admin/orders/:id — the sanctioned admin API, NEVER raw Medusa SQL)
// and its itemsJson is regenerated via the SAME `toOrderProjectionData` mapper
// production order-sync uses, so the ids are byte-consistent with the source of truth.
//
// GOVERNANCE POSTURE (identical to the sibling seeders — seed-owned-order.ts):
//   • The domain projection write is a RAW Prisma update — dev/ops tooling seeds/
//     repairs projection state directly. journeys is OUTSIDE the
//     no-direct-prisma-bypass scan (packages/domain guards the PRODUCTION mutation
//     surface; a backfill is not a customer-authored mutation the kernel adjudicates),
//     the same documented posture the seeders rely on.
//   • Only `itemsJson` + `itemCount` are rewritten. fulfillmentStatus / totals are
//     NOT re-derived (they may have advanced via domain transitions after the
//     projection was created; re-deriving would clobber them). `version` is NOT
//     bumped: this is DATA ENRICHMENT (adding stable ids), never a state transition.
//
// IDEMPOTENT: a row whose items ALREADY all carry an id is skipped; a re-run touches
// nothing once backfilled (classifyItemsJson).
//
// DRY-RUN: `--dry-run` reads + classifies the sweep window and reports the plan, but
// performs NO writes and NO Medusa fetch (a read-only PREVIEW). NOTE: unlike a
// deterministic seed's IO-free dry-run, a backfill's plan depends on DB state, so the
// dry-run DOES read prisma (hence still needs DATABASE_URL) — but never mutates.
//
//   tsx packages/journeys/src/live/backfill-lineitem-ids.ts [--limit 200] [--dry-run]
//     -> {"scanned":N,"dryRun":false,"updated":[...],"skippedAlreadyId":[...],
//         "skippedNoItems":[...],"medusa404Skipped":[...]}
//
// DEV-ONLY: refuses when NODE_ENV=production (it writes real projection rows).
// The LIVE run is deferred (owner skip-live) — dry-run + unit coverage is the bar.

import { fileURLToPath } from "node:url";
import {
  buildBackfillPlan,
  DEFAULT_BACKFILL_LIMIT,
  type BackfillCandidateRow,
  type BackfillPlan,
} from "./backfill-lineitem-ids-input.js";

export class BackfillLineItemIdsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackfillLineItemIdsError";
  }
}

/** The injectable IO surface (tests pass stubs; production uses dynamic imports). */
export interface BackfillDeps {
  readonly prisma: typeof import("@ibatexas/domain").prisma;
  readonly toOrderProjectionData: typeof import("@ibatexas/domain").toOrderProjectionData;
  readonly medusaAdmin: typeof import("@ibatexas/tools").medusaAdmin;
}

export interface BackfillOptions {
  /** Sweep bound (rows fetched + classified per run). Default {@link DEFAULT_BACKFILL_LIMIT}. */
  readonly limit?: number;
  /** Read-only preview: classify + report the plan, write nothing, fetch no Medusa. */
  readonly dryRun?: boolean;
  readonly onProgress?: (line: string) => void;
  /** Injected IO deps (tests). Default: dynamic imports of @ibatexas/domain + tools. */
  readonly deps?: BackfillDeps;
}

export interface BackfillResult {
  /** Rows fetched in the (bounded) sweep window. */
  readonly scanned: number;
  readonly dryRun: boolean;
  /** Order ids whose itemsJson was re-derived + written (empty on dry-run). */
  readonly updated: readonly string[];
  /** Order ids skipped because every item already carried a stable id. */
  readonly skippedAlreadyId: readonly string[];
  /** Order ids skipped because itemsJson was empty / non-array. */
  readonly skippedNoItems: readonly string[];
  /** Order ids skipped because Medusa no longer has the order (404). */
  readonly medusa404Skipped: readonly string[];
  /** The deterministic IO-free plan (present on BOTH paths for auditability). */
  readonly plan: BackfillPlan;
}

type MedusaOrder = Parameters<
  typeof import("@ibatexas/domain").toOrderProjectionData
>[0];

/** Fetch one order from Medusa's admin API; `null` on a 404 (order gone). Other
 *  transport errors propagate (a real failure must abort, not silently skip). */
async function fetchMedusaOrder(
  medusaAdmin: BackfillDeps["medusaAdmin"],
  orderId: string,
): Promise<MedusaOrder | null> {
  try {
    const res = (await medusaAdmin(`/admin/orders/${orderId}`)) as { order?: MedusaOrder };
    return res.order ?? null;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/**
 * Backfill stable line-item ids onto pre-FE-D15 projection rows. On `dryRun`,
 * reads + classifies + reports the plan with NO writes / NO Medusa fetch.
 */
export async function backfillLineItemIds(
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const onProgress = opts.onProgress ?? (() => undefined);
  const limit = opts.limit ?? DEFAULT_BACKFILL_LIMIT;
  const dryRun = opts.dryRun === true;

  // prisma + the mapper are needed on BOTH paths (the plan depends on DB state).
  // medusaAdmin is resolved LAZILY on the live path only. Injected deps (tests)
  // bypass the dynamic imports.
  const domain = opts.deps ?? (await import("@ibatexas/domain"));
  const prisma = domain.prisma;
  const toOrderProjectionData = domain.toOrderProjectionData;

  // Bounded sweep window, deterministic order (oldest first). Only id + itemsJson —
  // the classification never needs the rest of the row.
  const rows = await prisma.orderProjection.findMany({
    take: limit,
    orderBy: { medusaCreatedAt: "asc" },
    select: { id: true, itemsJson: true },
  });
  const candidates: BackfillCandidateRow[] = rows.map((r) => ({
    id: r.id,
    itemsJson: r.itemsJson,
  }));
  const plan = buildBackfillPlan(candidates);
  onProgress(
    `  scanned ${rows.length} row(s): ${plan.toBackfill.length} need backfill, ` +
      `${plan.alreadyComplete.length} already complete, ${plan.noItems.length} no items`,
  );

  if (dryRun) {
    onProgress(
      `  ✓ [dry-run] no writes — would backfill ${plan.toBackfill.length} order(s)`,
    );
    return {
      scanned: rows.length,
      dryRun: true,
      updated: [],
      skippedAlreadyId: plan.alreadyComplete,
      skippedNoItems: plan.noItems,
      medusa404Skipped: [],
      plan,
    };
  }

  const medusaAdmin =
    opts.deps?.medusaAdmin ?? (await import("@ibatexas/tools")).medusaAdmin;

  const updated: string[] = [];
  const medusa404Skipped: string[] = [];
  for (const orderId of plan.toBackfill) {
    const order = await fetchMedusaOrder(medusaAdmin, orderId);
    if (order === null) {
      medusa404Skipped.push(orderId);
      onProgress(`  · skipped ${orderId} — not found in Medusa (404)`);
      continue;
    }
    // Re-derive from the source of truth; write ONLY the id-bearing itemsJson +
    // itemCount. NOT version (data enrichment, not a state transition — see header).
    const derived = toOrderProjectionData(order);
    await prisma.orderProjection.update({
      where: { id: orderId },
      data: {
        itemsJson: derived.itemsJson as never,
        itemCount: derived.itemCount,
      },
    });
    updated.push(orderId);
    onProgress(`  ✓ backfilled ${orderId} (${derived.itemCount} item(s))`);
  }

  return {
    scanned: rows.length,
    dryRun: false,
    updated,
    skippedAlreadyId: plan.alreadyComplete,
    skippedNoItems: plan.noItems,
    medusa404Skipped,
    plan,
  };
}

// ── CLI entry point (ad-hoc/manual backfill, mirrors seed-owned-order.ts) ──────

interface CliArgs {
  limit: number;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let limit = DEFAULT_BACKFILL_LIMIT;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--limit": {
        const v = argv[i + 1];
        if (v === undefined) throw new Error("missing value for --limit");
        i++;
        const n = Number.parseInt(v, 10);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--limit must be a positive integer (got "${v}")`);
        }
        limit = n;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return { limit, dryRun };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new BackfillLineItemIdsError(
      "backfill-lineitem-ids refuses to run with NODE_ENV=production (it writes real projection rows)",
    );
  }
  // Both paths READ prisma (the plan depends on DB state), so DATABASE_URL is
  // required even for --dry-run.
  if (!process.env.DATABASE_URL) {
    throw new BackfillLineItemIdsError(
      "backfill-lineitem-ids: DATABASE_URL is not set (source the dev .env first)",
    );
  }
  const args = parseArgs(process.argv.slice(2));
  const result = await backfillLineItemIds({
    limit: args.limit,
    dryRun: args.dryRun,
    onProgress: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath !== "" && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    await main();
    process.exit(0);
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
