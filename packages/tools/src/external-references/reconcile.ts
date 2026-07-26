// BOOT RECONCILIATION — the runtime half of LE2-018.
//
// LE2 Implementation Decision 16, in the strict form the owner ratified:
//
//   Boot reconciliation REFUSES TO START on any miss. Blast radius accepted.
//   The mitigation is that the same check runs in CI/pre-deploy, so danglers
//   surface at change time rather than at restart time.
//
// So: no bypass flag, no "warn in dev", no allowlist. Those were considered
// and are exactly what turns a fail-closed gate into a log line people learn
// to scroll past — and the one this gate replaced (a `// must be created in
// Medusa admin before going live` comment) is proof of how that ends.
//
// # What counts as a miss
//
// Three things, and the distinction matters more than it looks:
//
//   config-unset       the declared env var is unset/blank — nothing to look up
//   not-found          the store answered, and the key is not there
//   store-unreachable  the store could not be asked at all
//
// The third is a miss on purpose. An unreachable store has not proved the
// reference exists, and "we could not check, so we assumed yes" is the single
// most common way a fail-closed gate silently inverts. It also cannot make the
// api less available than it already is: every store probed here is one the
// api needs anyway.
//
// A fourth case — a declaration naming a store with no registered probe — is
// also a miss (`store-unreachable`), which is the honest answer: an
// unprobeable store is one we cannot verify. The compiler rejects that
// statically, so reaching it at runtime means someone shipped a probe map that
// does not match the catalog.
//
// # Where this runs
//
//   1. apps/api boot        — `assertExternalReferencesReconcile`, beside
//                             `toolRosterDrift()`. Throws; the process dies.
//   2. `ibx catalog check --live`  — same function, exit 1, `--json`.
//   3. the staging deploy pipeline — (2), before the deploy job replaces
//                                    anything. This is the mitigation.
//
// One function, three entry points, nothing to drift.

import {
  EXTERNAL_REFERENCES,
  type ExternalReferenceDeclaration,
} from "@ibatexas/catalog"
import { externalReferenceKey, type EnvLike } from "./config.js"
import {
  DEFAULT_EXTERNAL_REFERENCE_PROBES,
  type ExternalReferenceProbes,
} from "./probes.js"

/** Why a declared reference did not reconcile. */
export type ExternalReferenceMissReason =
  | "config-unset"
  | "not-found"
  | "store-unreachable"

/** One declared reference that did not reconcile. */
export interface ExternalReferenceMiss {
  readonly id: string
  readonly store: string
  /** The configured key, or `null` when the config variable is unset. */
  readonly key: string | null
  /** The env var the key comes from — half of every fix. */
  readonly keyFrom: string
  readonly reason: ExternalReferenceMissReason
  /** The code sites that break, as `site` strings — the other half. */
  readonly consumers: readonly string[]
  /** One sentence: what was asked, what came back. */
  readonly detail: string
  /** The declaration's own `why` — what it costs to ship this broken. */
  readonly why: string
}

/** One declared reference that DID reconcile. */
export interface ExternalReferenceHit {
  readonly id: string
  readonly store: string
  readonly key: string
}

/** The verdict over the whole declaration table. */
export interface ExternalReferenceReconciliation {
  /** `true` when every declared reference resolved. */
  readonly ok: boolean
  /** How many declarations were probed. */
  readonly checked: number
  readonly resolved: readonly ExternalReferenceHit[]
  readonly misses: readonly ExternalReferenceMiss[]
}

export interface ReconcileOptions {
  /** Defaults to the authored `EXTERNAL_REFERENCES`. */
  readonly declarations?: readonly ExternalReferenceDeclaration[]
  /** Defaults to `process.env`. */
  readonly env?: EnvLike
  /** Defaults to the real probes — the seam every test injects at. */
  readonly probes?: ExternalReferenceProbes
}

function consumerSites(declaration: ExternalReferenceDeclaration): readonly string[] {
  return declaration.declaredBy.map((consumer) =>
    consumer.capability === null
      ? consumer.site
      : `${consumer.site} (${consumer.capability})`,
  )
}

/**
 * Probe every declared external reference against its live store.
 *
 * Total: it never throws. Every failure — an unset variable, a missing
 * promotion, a dead Medusa, a missing probe — comes back as a
 * {@link ExternalReferenceMiss}, because a gate that dies on the first problem
 * makes an operator fix them one restart at a time. The CALLERS decide what a
 * non-ok verdict costs: the boot gate turns it into a refusal to start, the
 * CLI into exit 1.
 *
 * Probes run CONCURRENTLY. The table is small and the stores are independent,
 * and boot latency is the one real cost of a gate like this.
 */
export async function reconcileExternalReferences(
  options: ReconcileOptions = {},
): Promise<ExternalReferenceReconciliation> {
  const declarations = options.declarations ?? EXTERNAL_REFERENCES
  const probes = options.probes ?? DEFAULT_EXTERNAL_REFERENCE_PROBES

  const outcomes = await Promise.all(
    declarations.map(
      async (
        declaration,
      ): Promise<
        { readonly hit: ExternalReferenceHit } | { readonly miss: ExternalReferenceMiss }
      > => {
        const base = {
          id: declaration.id,
          store: declaration.store,
          keyFrom: declaration.keyFrom,
          consumers: consumerSites(declaration),
          why: declaration.why,
        }

        const key = externalReferenceKey(declaration.id, {
          declarations,
          env: options.env,
        })
        if (key === null) {
          return {
            miss: {
              ...base,
              key: null,
              reason: "config-unset",
              detail: `${declaration.keyFrom} is unset or blank, so there is no key to look up.`,
            },
          }
        }

        const probe = probes[declaration.store]
        if (probe === undefined) {
          return {
            miss: {
              ...base,
              key,
              reason: "store-unreachable",
              detail:
                `no probe is registered for the "${declaration.store}" store, so its ` +
                "references cannot be verified. Add one in " +
                "packages/tools/src/external-references/probes.ts.",
            },
          }
        }

        const verdict = await probe(key)
        if (verdict.status === "present") {
          return { hit: { id: declaration.id, store: declaration.store, key } }
        }
        return {
          miss: {
            ...base,
            key,
            reason: verdict.status === "absent" ? "not-found" : "store-unreachable",
            detail:
              verdict.status === "absent"
                ? `the ${declaration.store} store has no "${key}".`
                : `the ${declaration.store} store could not be reached: ${verdict.detail}`,
          },
        }
      },
    ),
  )

  const resolved = outcomes.flatMap((o) => ("hit" in o ? [o.hit] : []))
  const misses = outcomes.flatMap((o) => ("miss" in o ? [o.miss] : []))
  return { ok: misses.length === 0, checked: declarations.length, resolved, misses }
}

/** One miss, as the multi-line block a refusing process prints. */
export function formatExternalReferenceMiss(miss: ExternalReferenceMiss): string {
  const lines = [
    `${miss.id} — ${miss.reason} in the ${miss.store} store`,
    `    key: ${miss.key === null ? `(unset — set ${miss.keyFrom})` : `"${miss.key}" (from ${miss.keyFrom})`}`,
    `    ${miss.detail}`,
    `    breaks: ${miss.consumers.join(", ")}`,
    `    why it matters: ${miss.why}`,
  ]
  return lines.join("\n")
}

/**
 * The whole verdict as a report — the text a refused boot leaves in the log.
 *
 * A refusal to start is expensive, so the report has to pay for itself on the
 * first screen: what is missing, where it must exist, what breaks without it,
 * and what to do next. Dev/CI English, matching every other boot gate in the
 * repo (the pt-BR rule governs customer-facing text, not operator diagnostics).
 */
export function formatExternalReferenceReport(
  result: ExternalReferenceReconciliation,
): string {
  if (result.ok) {
    return (
      `[external-references] reconciliation OK — ${result.checked} declared ` +
      `reference(s), all present.` +
      (result.resolved.length === 0
        ? ""
        : `\n${result.resolved
            .map((hit) => `  ✓ ${hit.id} — "${hit.key}" in ${hit.store}`)
            .join("\n")}`)
    )
  }

  return [
    `[external-references] reconciliation FAILED — ${result.misses.length} of ` +
      `${result.checked} declared reference(s) missing.`,
    ...result.misses.map((miss) => `  ✗ ${formatExternalReferenceMiss(miss)}`),
    "",
    "Every reference above is DECLARED in @ibatexas/catalog " +
      "(src/external-references.ts) and consumed by the code sites named. Create " +
      "it in its store, or point the declared config variable at one that exists. " +
      "There is no bypass: LE2 Implementation Decision 16 makes this gate strict " +
      "on purpose, and the way to find these before a restart does is " +
      "`ibx catalog check --live`.",
  ].join("\n")
}

/** Thrown by {@link assertExternalReferencesReconcile}. */
export class ExternalReferenceReconciliationError extends Error {
  readonly result: ExternalReferenceReconciliation

  constructor(result: ExternalReferenceReconciliation) {
    super(formatExternalReferenceReport(result))
    this.name = "ExternalReferenceReconciliationError"
    this.result = result
  }
}

/**
 * Fail-closed assertion: throws when ANY declared reference is missing.
 *
 * The api's boot gate calls this and does not catch it. That is the whole
 * feature.
 */
export async function assertExternalReferencesReconcile(
  options: ReconcileOptions = {},
): Promise<ExternalReferenceReconciliation> {
  const result = await reconcileExternalReferences(options)
  if (!result.ok) throw new ExternalReferenceReconciliationError(result)
  return result
}
