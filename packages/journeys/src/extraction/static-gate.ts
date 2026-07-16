// extraction/static-gate.ts — FE-T08: the CERTIFYING, per-commit, MODEL-FREE
// extraction gate. Every check here is pure and content-based (plain
// strings/objects in, a verdict out) — no live model, no HTTP, no DB, no
// filesystem access of its own (the CLI composition layer, packages/cli,
// does all file I/O — see the cross-package note below). Runnable on ANY
// CI runner, GitHub-hosted included: no network beyond npm install.
//
// Two independent, complementary checks, both wired into the certifying
// gate (FE-T08 AC1 — "regresses an extraction schema -> the gate fails"):
//
//   1. checkBaselineAgainstCorpus — catches CORPUS-AUTHORING drift: every
//      case key the committed baseline claims `passing` must still exist in
//      the committed corpus. A case renamed/removed/typo'd without updating
//      the baseline is an orphaned claim. `verifyAccuracyBaseline` (accuracy.ts)
//      already reports this as an "absent" regression, but only at LIVE-RUN
//      time (it needs a driven `results` set) — this lets the identical
//      structural check run at COMMIT time, before any live drive exists.
//
//   2. checkSchemaBinding — catches SCHEMA-CHANGE drift. The FE-T06 golden
//      byte-identity gate (apps/api's extraction-prompt-golden.test.ts,
//      already wired into `pnpm test`) fails if the LIVE composed
//      extraction-prompt bytes drift from the COMMITTED golden fixture — but
//      says nothing about whether the corpus/baseline were REVIEWED for
//      accuracy impact once an author correctly regenerates that golden
//      fixture to match an intentional schema change (in which case the
//      golden gate itself goes green again, silently). This binds a hash of
//      the golden fixture's OWN committed bytes to the last time the
//      corpus/baseline were reviewed (a committed
//      `extraction-schema-binding.json`): if the golden fixture's bytes
//      changed since, the recorded hash no longer matches, and THIS check
//      fails until an author explicitly re-commits the binding — the
//      acknowledgment step an extraction-schema change must not be able to
//      skip silently, even when the golden gate itself is green.
//
// Cross-package note: packages/journeys is TEST-PLANE ONLY (check-bypass
// leg 7 — never reaches into apps/api). The golden fixture's bytes live in
// apps/api's test tree; THIS module never reads them — it only hashes
// strings its caller (packages/cli, leg 6's sanctioned cross-package
// exception) already read from disk.

import { createHash } from "node:crypto"
import { z } from "zod"
import { accuracyCaseKey, type AccuracyBaseline } from "./accuracy.js"
import type { ExtractionCorpusFile } from "./schema.js"

// ── 1. Baseline ⊆ corpus consistency ────────────────────────────────────────

export interface BaselineCorpusConsistencyResult {
  ok: boolean
  /** Baseline-claimed case keys with no matching corpus case. */
  orphanedBaselineClaims: string[]
}

/** Every `baseline.passing` key must correspond to an ACTUAL corpus case. */
export function checkBaselineAgainstCorpus(
  baseline: AccuracyBaseline,
  corpus: readonly ExtractionCorpusFile[],
): BaselineCorpusConsistencyResult {
  const corpusKeys = new Set(
    corpus.flatMap((file) => file.cases.map((kase) => accuracyCaseKey(file.capability, kase.id))),
  )
  const orphanedBaselineClaims = baseline.passing.filter((key) => !corpusKeys.has(key))
  return { ok: orphanedBaselineClaims.length === 0, orphanedBaselineClaims }
}

// ── 2. Schema-binding (golden-fragment hash) consistency ────────────────────

const ExtractionSchemaBindingEntrySchema = z
  .object({
    capability: z.string().min(1),
    /**
     * Repo-root-relative path to the committed golden extraction-prompt
     * fragment (apps/api — never imported by this package; only its BYTES
     * are hashed, by the caller).
     */
    goldenFragmentPath: z.string().min(1),
    /**
     * sha256 hex digest of that file's bytes, AS OF the last time the
     * corpus/baseline were reviewed for accuracy impact.
     */
    goldenFragmentSha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"),
  })
  .strict()

export const ExtractionSchemaBindingSchema = z
  .object({
    bindings: z.array(ExtractionSchemaBindingEntrySchema),
  })
  .strict()

export type ExtractionSchemaBinding = z.infer<typeof ExtractionSchemaBindingSchema>
export type ExtractionSchemaBindingEntry = z.infer<typeof ExtractionSchemaBindingEntrySchema>

/** sha256 hex digest of a file's raw text content — the caller reads the bytes; this never touches the filesystem. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export interface SchemaBindingDrift {
  capability: string
  goldenFragmentPath: string
  expectedSha256: string
  actualSha256: string
}

export interface SchemaBindingCheckResult {
  ok: boolean
  drift: SchemaBindingDrift[]
}

/**
 * Compare the committed binding's recorded hash against the ACTUAL current
 * bytes of each golden fragment (`goldenFragmentContents`, keyed by
 * `goldenFragmentPath` — the caller reads these; this function does no file
 * I/O). A mismatch means the golden fixture's bytes changed (an extraction
 * schema/persona edit was correctly regenerated) since the binding was last
 * reviewed — the certifying signal FE-T08 AC1 calls for.
 */
export function checkSchemaBinding(
  binding: ExtractionSchemaBinding,
  goldenFragmentContents: ReadonlyMap<string, string>,
): SchemaBindingCheckResult {
  const drift: SchemaBindingDrift[] = []
  for (const entry of binding.bindings) {
    const content = goldenFragmentContents.get(entry.goldenFragmentPath)
    // A missing entry (the caller failed to read the file) is a DIFFERENT,
    // harder failure the CLI surfaces on its own (a missing golden fragment
    // is not "drift", it's a broken binding) — this function stays
    // defensive rather than crashing on an incomplete map.
    if (content === undefined) continue
    const actualSha256 = sha256Hex(content)
    if (actualSha256 !== entry.goldenFragmentSha256) {
      drift.push({
        capability: entry.capability,
        goldenFragmentPath: entry.goldenFragmentPath,
        expectedSha256: entry.goldenFragmentSha256,
        actualSha256,
      })
    }
  }
  return { ok: drift.length === 0, drift }
}

/** Recompute the binding's hashes from the CURRENT golden fragment contents — the `--update-binding` capture path. */
export function recomputeSchemaBinding(
  binding: ExtractionSchemaBinding,
  goldenFragmentContents: ReadonlyMap<string, string>,
): ExtractionSchemaBinding {
  return {
    bindings: binding.bindings.map((entry) => {
      const content = goldenFragmentContents.get(entry.goldenFragmentPath)
      if (content === undefined) return entry
      return { ...entry, goldenFragmentSha256: sha256Hex(content) }
    }),
  }
}
