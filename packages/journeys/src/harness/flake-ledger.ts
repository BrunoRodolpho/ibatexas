// harness/flake-ledger.ts — T1b-4 flake policy WITH OWNERSHIP.
//
// The committed ledger (packages/journeys/governance/flake-ledger.json) is
// the authoritative quarantine list for the nightly suite. Policy (plan §5
// T1b-4, executed by run-suite-cli's `--nightly` mode):
//
//   * retry-once = YELLOW: a journey that fails once and passes on the
//     single nightly retry counts as PASSING for the run, but the night is
//     recorded as a flaky night for that journey.
//   * QUARANTINE after 2 consecutive flaky nights: the entry flips to
//     `status: "quarantined"`; quarantined journeys are SKIPPED by the
//     nightly suite (reported, never silently dropped) and their coverage
//     cells become `waived-quarantined` via the T1a-3 seam
//     (`ibx journey coverage --quarantined <ids>` — the nightly workflow
//     feeds the ids from this ledger).
//   * DE-QUARANTINE = green twice on a MANUAL re-run. The documented manual
//     command sequence:
//         ibx journey run <id> --k 2 --json      # both attempts must pass
//         ibx journey flake --dequarantine <id>  # then clear the entry
//     The second command refuses unless the entry is quarantined; the human
//     running it is attesting to the green k=2 run (the ledger records who
//     should be attesting via `owner`).
//   * HARD (non-flaky) failure or a red run files a GH issue (the nightly
//     workflow step) with the assignable `owner` field from this ledger.
//     Red outcomes deliberately do NOT advance the flake streak — quarantine
//     is for flaky journeys; consistently-broken journeys get an issue with
//     an owner instead (recorded design choice).
//
// "Consecutive" is enforced by green-removal: a green night DELETES the
// flaky entry, so any surviving entry's streak is consecutive by
// construction. Same-night repeats (manual re-dispatch) are idempotent —
// `lastFlakyNight` guards the increment. The ledger therefore only ever
// contains entries for currently-flaky or quarantined journeys; an all-green
// night leaves the file byte-identical (no commit-back noise).
//
// All transition functions are PURE (ledger in → new ledger out) and
// unit-tested; only load/save touch the filesystem.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"

export const FLAKE_LEDGER_VERSION = 1 as const

/** Consecutive flaky nights that trigger quarantine (plan §5 T1b-4). */
export const QUARANTINE_THRESHOLD = 2

/**
 * The committed ledger path (binding):
 * `packages/journeys/governance/flake-ledger.json`. Resolved relative to
 * this module so it works from both `src/` and `dist/`.
 */
export const DEFAULT_FLAKE_LEDGER_PATH = fileURLToPath(
  new URL("../../governance/flake-ledger.json", import.meta.url),
)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const FlakeLedgerEntrySchema = z
  .object({
    journey: z.string().min(1),
    /** ISO date (YYYY-MM-DD) the current flake streak started. */
    firstSeen: z.string().regex(ISO_DATE),
    /** Assignable owner (GH handle) — "" until a human claims it. */
    owner: z.string(),
    status: z.enum(["flaky", "quarantined"]),
    consecutiveFlakyNights: z.number().int().min(1),
    /** ISO date of the most recent flaky night (idempotency guard). */
    lastFlakyNight: z.string().regex(ISO_DATE),
    /** Set when the entry flips to quarantined. */
    quarantinedAt: z.string().regex(ISO_DATE).optional(),
  })
  .strict()

export const FlakeLedgerSchema = z
  .object({
    version: z.literal(FLAKE_LEDGER_VERSION),
    journeys: z.record(z.string(), FlakeLedgerEntrySchema),
  })
  .strict()

export type FlakeLedgerEntry = z.infer<typeof FlakeLedgerEntrySchema>
export type FlakeLedger = z.infer<typeof FlakeLedgerSchema>

/** Per-journey nightly outcome fed into the ledger by the nightly suite. */
export type NightlyOutcome = "green" | "yellow" | "red"

export class FlakeLedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FlakeLedgerError"
  }
}

export function emptyFlakeLedger(): FlakeLedger {
  return { version: FLAKE_LEDGER_VERSION, journeys: {} }
}

/**
 * Load the ledger. A missing file is an empty ledger (fresh checkouts and
 * unit fixtures); a malformed file fails LOUDLY — the nightly must never
 * run with quarantine state it cannot read.
 */
export function loadFlakeLedger(path: string = DEFAULT_FLAKE_LEDGER_PATH): FlakeLedger {
  if (!existsSync(path)) return emptyFlakeLedger()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"))
  } catch (err) {
    throw new FlakeLedgerError(`flake ledger unreadable (${path}): ${(err as Error).message}`)
  }
  const parsed = FlakeLedgerSchema.safeParse(raw)
  if (!parsed.success) {
    throw new FlakeLedgerError(
      `flake ledger invalid (${path}): ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return parsed.data
}

/** Persist the ledger: stable journey-id key order + trailing newline. */
export function saveFlakeLedger(
  ledger: FlakeLedger,
  path: string = DEFAULT_FLAKE_LEDGER_PATH,
): void {
  const ordered: FlakeLedger = {
    version: ledger.version,
    journeys: Object.fromEntries(
      Object.keys(ledger.journeys)
        .sort()
        .map((id) => [id, ledger.journeys[id]!]),
    ),
  }
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`)
}

/** Journey ids currently quarantined (the nightly skips them). */
export function quarantinedJourneyIds(ledger: FlakeLedger): string[] {
  return Object.values(ledger.journeys)
    .filter((e) => e.status === "quarantined")
    .map((e) => e.journey)
    .sort()
}

/** The assignable owner for a journey — "" when unknown/unassigned. */
export function flakeOwner(ledger: FlakeLedger, journeyId: string): string {
  return ledger.journeys[journeyId]?.owner ?? ""
}

export interface RecordOutcomeResult {
  ledger: FlakeLedger
  /** True when the returned ledger differs from the input. */
  changed: boolean
  /** True when THIS outcome flipped the entry to quarantined. */
  newlyQuarantined: boolean
}

/**
 * Fold one journey's nightly outcome into the ledger (pure). See the module
 * header for the policy; in short: green deletes a flaky entry, yellow
 * starts/advances the streak (quarantining at QUARANTINE_THRESHOLD), red
 * leaves the ledger untouched (issues, not quarantine, own hard failures),
 * and quarantined entries are never touched by nightly outcomes (they do
 * not run; de-quarantine is manual).
 */
export function recordNightlyOutcome(
  ledger: FlakeLedger,
  journeyId: string,
  outcome: NightlyOutcome,
  date: string,
): RecordOutcomeResult {
  if (!ISO_DATE.test(date)) {
    throw new FlakeLedgerError(`recordNightlyOutcome: date must be YYYY-MM-DD (got "${date}")`)
  }
  const entry = ledger.journeys[journeyId]

  // Quarantined entries are immutable to nightly outcomes (defensive: the
  // nightly skips quarantined journeys, so this branch indicates a manual
  // nightly-mode run — never mutate quarantine state from it).
  if (entry?.status === "quarantined") {
    return { ledger, changed: false, newlyQuarantined: false }
  }

  if (outcome === "red") {
    return { ledger, changed: false, newlyQuarantined: false }
  }

  if (outcome === "green") {
    if (entry === undefined) return { ledger, changed: false, newlyQuarantined: false }
    const journeys = { ...ledger.journeys }
    delete journeys[journeyId]
    return {
      ledger: { ...ledger, journeys },
      changed: true,
      newlyQuarantined: false,
    }
  }

  // outcome === "yellow"
  if (entry === undefined) {
    return {
      ledger: {
        ...ledger,
        journeys: {
          ...ledger.journeys,
          [journeyId]: {
            journey: journeyId,
            firstSeen: date,
            owner: "",
            status: "flaky",
            consecutiveFlakyNights: 1,
            lastFlakyNight: date,
          },
        },
      },
      changed: true,
      newlyQuarantined: false,
    }
  }
  if (entry.lastFlakyNight === date) {
    // Same-night repeat (manual re-dispatch) — idempotent.
    return { ledger, changed: false, newlyQuarantined: false }
  }
  const streak = entry.consecutiveFlakyNights + 1
  const quarantine = streak >= QUARANTINE_THRESHOLD
  const next: FlakeLedgerEntry = {
    ...entry,
    consecutiveFlakyNights: streak,
    lastFlakyNight: date,
    ...(quarantine ? { status: "quarantined" as const, quarantinedAt: date } : {}),
  }
  return {
    ledger: { ...ledger, journeys: { ...ledger.journeys, [journeyId]: next } },
    changed: true,
    newlyQuarantined: quarantine,
  }
}

/**
 * Manual de-quarantine (pure) — the second step of the documented manual
 * flow (`ibx journey run <id> --k 2 --json` green, then
 * `ibx journey flake --dequarantine <id>`). Refuses unless the entry is
 * quarantined: flaky entries resolve themselves via green nights, and
 * unknown ids are operator typos.
 */
export function dequarantineJourney(ledger: FlakeLedger, journeyId: string): FlakeLedger {
  const entry = ledger.journeys[journeyId]
  if (entry === undefined) {
    throw new FlakeLedgerError(`flake ledger has no entry for ${journeyId}`)
  }
  if (entry.status !== "quarantined") {
    throw new FlakeLedgerError(
      `${journeyId} is "${entry.status}", not quarantined — flaky entries clear themselves on the next green night`,
    )
  }
  const journeys = { ...ledger.journeys }
  delete journeys[journeyId]
  return { ...ledger, journeys }
}
