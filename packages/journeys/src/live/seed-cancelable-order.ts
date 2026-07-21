// live/seed-cancelable-order.ts — FE-T12's order-seeding CLI/library for
// `order.cancel` money-boundary live calibration (team-lead ruling: "fix the
// cancel money-boundary seeding, don't defer" — mirrors seed-checkout-cart.ts
// exactly, one capability's precondition-seeding seam per file).
//
// WHY seed-refundable-order.ts (ALWAYS a PAID order) is the right tool for
// EVERY boundary case, including the ones the corpus's own SETUP notes
// describe as needing an UNPAID order: `gatePaidCancel`'s PAID-order bands
// (pack-orders/src/policies.ts) use the EXACT SAME `ESCALATE_REFUND_
// THRESHOLD_CENTAVOS` as `escalateLargeCancel`'s UNPAID-order threshold —
// "ESCALATE band + escalateLargeCancel's >= comparator/threshold" (the
// guard's own comment). `gatePaidCancel` runs FIRST in the guard chain and
// short-circuits for any PAID order, so a PAID order at the SAME total
// produces the IDENTICAL observable `decision.kind` (ESCALATE / REQUEST_
// CONFIRMATION) a genuinely-unpaid order would have — just via the sibling
// guard. Since this corpus only asserts `decision.kind` (never which SPECIFIC
// guard fired — see order.checkout.create.yaml's own "LIVE-CAUGHT DEAD-CODE
// FINDING" note for the identical class of observation), this substitution
// is exact-outcome-safe. A genuinely-unpaid seed path was considered and
// rejected as unnecessary extra surface for this ticket's scope.
//
// Shells out to seed-refundable-order.ts (the WS9 ops live suite's ALREADY-
// GOVERNED seed CLI — kernel-adjudicated, SYSTEM-actor envelopes, no raw
// money-table writes) via execFile rather than importing its internals
// directly: none of seed-refundable-order.ts's pieces (systemEnvelope,
// assertAuthorized, main) are exported — it is a CLI entry point, not a
// library, and duplicating its governed-write machinery here would be
// exactly the FE-D07 duplication-class hazard this session's rulings
// warned against. One child process per case (~1-2s) is negligible next to
// a ~15-20s live-model turn.

import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** This module's own directory (`packages/journeys/src/live/`) — used to locate the sibling seed-refundable-order.ts and resolve the package root for execFile's cwd. */
const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const JOURNEYS_PACKAGE_ROOT = join(THIS_DIR, "..", "..")

/**
 * Every order.cancel case id that needs a SPECIFIC "most-recent order"
 * total (centavos) to exercise its named guard band — the single source of
 * truth both the corpus's documented SETUP notes and this seeder read from
 * (kept in sync by hand). Every OTHER case in the corpus (bare-*, reason-*,
 * adversarial-*) has no total precondition — any order works, so those get
 * the modest default.
 */
const CANCEL_ORDER_CASE_TARGETS: ReadonlyMap<string, number> = new Map([
  // Exactly R$1000,00 — escalateLargeCancel's `>=` comparator ESCALATEs at
  // this exact boundary (mirrored here via gatePaidCancel's identical
  // threshold — see this module's header).
  ["escalate-exact-threshold-boundary", 100_000],
  // R$3000,00 — well above the R$1000 escalate threshold.
  ["escalate-well-above-threshold", 300_000],
  // R$1500,00 — gatePaidCancel's own high (PAID) band ESCALATEs directly;
  // this IS the corpus's documented PAID setup, seeded as-is.
  ["escalate-paid-large-with-reason", 150_000],
  // R$999,99 — one centavo below the escalate threshold; must
  // REQUEST_CONFIRMATION, never ESCALATE. (999_99 centavos is NOT a whole
  // number of reais — seed-refundable-order.ts accepts --amount-centavos
  // directly, so this one IS seedable exactly, unlike checkout's catalog-
  // price-constrained totals.)
  ["confirm-just-below-escalate-threshold", 99_999],
  // R$200,00 — gatePaidCancel's low (PAID) band REQUEST_CONFIRMATIONs; this
  // IS the corpus's documented PAID setup, seeded as-is.
  ["confirm-paid-below-threshold", 20_000],
])
const DEFAULT_CANCEL_ORDER_TARGET_CENTAVOS = 5_000

/** The target "most-recent order" total (centavos) for a given order.cancel case id — the modest default unless the case is one of the 5 named money-boundary cases. */
export function targetCentavosForCancelCase(caseId: string): number {
  return CANCEL_ORDER_CASE_TARGETS.get(caseId) ?? DEFAULT_CANCEL_ORDER_TARGET_CENTAVOS
}

export class SeedCancelableOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeedCancelableOrderError"
  }
}

export interface SeedCancelableOrderOptions {
  /** The domain customer id whose "most-recent order" auto-resolve will target this seed. */
  customerId: string
  /** Target order total in centavos. */
  targetCentavos: number
  onProgress?: (line: string) => void
}

export interface SeedCancelableOrderResult {
  readonly orderId: string
  readonly amountInCentavos: number
}

/**
 * Seeds a FRESH, PAID, cancelable order for `customerId` at EXACTLY
 * `targetCentavos` via seed-refundable-order.ts — the customer's
 * chronologically most-recent order the moment this resolves, which is
 * exactly what order.cancel's auto-resolve (`resolveOrderId`,
 * resolve-and-assemble.ts) targets. Called fresh before EVERY case (mirrors
 * seed-checkout-cart.ts's per-case cart) so each case's own target total is
 * the one in effect when its turn actually drives — never a stale order
 * from an earlier case.
 */
export async function seedCancelableOrder(
  opts: SeedCancelableOrderOptions,
): Promise<SeedCancelableOrderResult> {
  const onProgress = opts.onProgress ?? (() => undefined)
  // ALWAYS the SOURCE .ts file, never relative to THIS_DIR — the build only
  // compiles .ts -> .js into dist/, it never copies the original .ts source
  // there, so when THIS module itself runs from dist/live/ (the normal case
  // for a built CLI run), a THIS_DIR-relative path would 404. `tsx` needs
  // the real TypeScript source regardless of where the CALLING module runs
  // from — src/live/ is the one place it always exists.
  const scriptPath = join(JOURNEYS_PACKAGE_ROOT, "src", "live", "seed-refundable-order.ts")

  let stdout: string
  try {
    const result = await execFileAsync(
      "npx",
      [
        "tsx",
        scriptPath,
        "--amount-centavos",
        String(opts.targetCentavos),
        "--method",
        "cash",
        "--customer-id",
        opts.customerId,
      ],
      { cwd: JOURNEYS_PACKAGE_ROOT, env: process.env },
    )
    stdout = result.stdout
  } catch (err) {
    throw new SeedCancelableOrderError(
      `seed-refundable-order.ts failed for customer ${opts.customerId} at ${opts.targetCentavos} centavos: ${(err as Error).message}`,
    )
  }

  let parsed: { orderId?: unknown; amountInCentavos?: unknown }
  try {
    parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as typeof parsed
  } catch {
    throw new SeedCancelableOrderError(
      `seed-refundable-order.ts produced non-JSON stdout: ${stdout.slice(0, 200)}`,
    )
  }
  if (typeof parsed.orderId !== "string" || typeof parsed.amountInCentavos !== "number") {
    throw new SeedCancelableOrderError(
      `seed-refundable-order.ts's output is missing orderId/amountInCentavos: ${stdout.slice(0, 200)}`,
    )
  }
  if (parsed.amountInCentavos !== opts.targetCentavos) {
    throw new SeedCancelableOrderError(
      `seeded order ${parsed.orderId} totals ${parsed.amountInCentavos} centavos, expected EXACTLY ${opts.targetCentavos} — never silently proceeding with a wrong total.`,
    )
  }

  onProgress(
    `  ✓ seeded cancelable order ${parsed.orderId} (R$${(opts.targetCentavos / 100).toFixed(2)}) for customer ${opts.customerId}`,
  )
  return { orderId: parsed.orderId, amountInCentavos: parsed.amountInCentavos }
}
