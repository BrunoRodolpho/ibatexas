/**
 * BKL-251 — cross-pack `basisCodes` drift gate.
 *
 * Every first-party pack declares `basisCodes`: the refusal-code vocabulary
 * its policy may emit. That array is not decoration — it feeds the AI-BOM
 * (`@adjudicate/conformance.ai-bom` maps each code to a guardrail entry), the
 * config seal, and the coherence export. A code the policy emits but does not
 * declare is invisible to all three: the published governance artifacts
 * UNDER-REPORT the Pack's refusal surface.
 *
 * ## Why the pre-existing gate did not catch this
 *
 * `@adjudicate/conformance`'s AC-004 (basis-vocabulary-purity, run per-pack via
 * `runConformance()`) does compare emitted refusal codes against `basisCodes`
 * — but it does so by SAMPLING: it builds synthetic envelopes
 * (`payload: { __conformanceProbe: true, seed }`) across the declared intent
 * kinds and taint levels, adjudicates each against `emptyStateFor(pack)`
 * (= `pack.rehydrateState({})`), and inspects the Decisions that come back.
 * It can only observe a refusal code on a path the probe actually REACHES.
 *
 * Both codes BKL-251 found in `pack-orders` sit behind state preconditions the
 * empty probe state cannot satisfy:
 *
 *   - `order.ownership_denied` — emitted by the 034-F1 ownership/IDOR guard
 *     `enforceOrderOwnership`, whose first line is
 *     `if (authority === undefined) return null` (inert unless the HOST injects
 *     `state.authority`). The probe state never carries `authority`, so this
 *     guard is not merely unlikely to fire — it is structurally unreachable
 *     under AC-004, at any sample count or seed.
 *   - `order.past_ponr` — emitted by `requireCancellable` only when an order
 *     exists AND is past the point-of-no-return AND is not already cancelled.
 *     The probe state has `orderId: null`, so an earlier guard answers first.
 *
 * The same shape hid two codes in `pack-reservations`
 * (`reservation.ambiguous`, `reservation.slot.ambiguous`): both fire only after
 * a resolver has already found ≥2 candidates.
 *
 * So AC-004 is a REACHABILITY check, and this is its complement: a STRUCTURAL
 * one that needs no reachable path. It imports each pack's refusals module and
 * enumerates the codes actually constructed there, then asserts every one is
 * declared. A code becomes visible to this gate the moment someone writes the
 * builder — not if and when a probe happens to reach it.
 *
 * ## Extraction
 *
 * Structural, not a regex over source: each pack's refusals module is imported
 * and every exported function invoked, and the `Refusal.code` it returns is
 * read off the returned object. Three properties of the modules make this
 * complete, each verified rather than assumed:
 *
 *   1. Every builder contains exactly ONE `refuse(kind, code, msg)` call with a
 *      literal code, so one invocation per export yields its whole contribution
 *      (no builder branches on its arguments to pick between codes).
 *   2. Builders are not reliably named `refuse*` — `pack-payments` exports
 *      `refundStateDivergent`, `refundNotInRefundableState`,
 *      `refundAlreadyExhausted` and `refundStaleRead`. So EVERY exported
 *      function is probed, and a Refusal-shaped return is what identifies a
 *      builder, never its name.
 *   3. The builders take simple scalars/arrays and mostly interpolate them into
 *      a detail string, so a small candidate-argument ladder invokes them all.
 *      A builder the ladder cannot invoke is a HARNESS GAP, and the
 *      "every exported function is invocable" test below fails on it rather
 *      than skipping it silently — otherwise an exotic signature would
 *      reintroduce exactly the blind spot this gate exists to close.
 *
 * Imported via each pack's `./refusals` subpath export (added by BKL-251). The
 * pack INDEX is deliberately not used as the source: `pack-orders/index.ts`
 * re-exports only some of its builders — `refuseOwnershipDenied` is absent from
 * that list — so an index-driven gate would have missed the very code this
 * ticket is about and passed vacuously.
 */

import { describe, expect, it } from "vitest"

import { IBATEXAS_COMPOSED_PACKS } from "../index.js"

import * as ordersRefusals from "@ibatexas/pack-orders/refusals"
import * as paymentsRefusals from "@ibatexas/pack-payments/refusals"
import * as reservationsRefusals from "@ibatexas/pack-reservations/refusals"
import * as customerOnboardingRefusals from "@ibatexas/pack-customer-onboarding/refusals"
import * as whatsappRefusals from "@ibatexas/pack-whatsapp/refusals"
import * as opsRefusals from "@ibatexas/pack-ops/refusals"

/**
 * Each composed pack paired with its refusals module. Keyed by pack id so a
 * mispairing surfaces as a failed id assertion rather than a silently wrong
 * comparison.
 */
const PACK_REFUSAL_MODULES: ReadonlyArray<{
  readonly id: string
  readonly module: Record<string, unknown>
}> = [
  { id: "ibatexas/pack-orders", module: ordersRefusals },
  { id: "ibatexas/pack-payments", module: paymentsRefusals },
  { id: "ibatexas/pack-reservations", module: reservationsRefusals },
  { id: "ibatexas/pack-customer-onboarding", module: customerOnboardingRefusals },
  { id: "ibatexas/pack-whatsapp", module: whatsappRefusals },
  { id: "ibatexas/pack-ops", module: opsRefusals },
]

/**
 * Argument fills tried in order until one invokes the builder. `[]` means "call
 * with no arguments" (covers nullary builders and ones whose parameters are all
 * optional); the rest fill every parameter with a single value. The array
 * candidate covers builders that `.slice()`/`.map()` a candidate list
 * (`refuseAmbiguousOrderReference`, `refuseSlotAmbiguous`, …).
 */
const ARGUMENT_CANDIDATES: ReadonlyArray<ReadonlyArray<unknown>> = [
  [],
  [[]],
  ["x"],
  [0],
  [{}],
]

interface RefusalLike {
  readonly kind: string
  readonly code: string
}

function isRefusalLike(value: unknown): value is RefusalLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { kind?: unknown }).kind === "string"
  )
}

/** Invoke `fn` with the first candidate fill that yields a Refusal, else null. */
function invokeForRefusal(fn: (...args: never[]) => unknown): RefusalLike | null {
  for (const candidate of ARGUMENT_CANDIDATES) {
    const args =
      candidate.length === 0
        ? []
        : (new Array<unknown>(fn.length).fill(candidate[0]) as unknown[])
    try {
      const result = (fn as (...a: unknown[]) => unknown)(...args)
      if (isRefusalLike(result)) return result
    } catch {
      // Wrong argument shape for this builder — try the next candidate.
    }
  }
  return null
}

/** `{ code -> builder names }` for every Refusal-returning export of `module`. */
function constructedCodes(
  module: Record<string, unknown>,
): ReadonlyMap<string, readonly string[]> {
  const byCode = new Map<string, string[]>()
  for (const [name, value] of Object.entries(module)) {
    if (typeof value !== "function") continue
    const refusal = invokeForRefusal(value as (...args: never[]) => unknown)
    if (refusal === null) continue
    const existing = byCode.get(refusal.code)
    if (existing) existing.push(name)
    else byCode.set(refusal.code, [name])
  }
  return byCode
}

describe("cross-pack basisCodes drift gate (BKL-251)", () => {
  it("pairs every composed pack with a refusals module, in order", () => {
    // Guards the whole suite against a pack being added to the composition
    // without being added here — which would leave the new pack ungated.
    expect(PACK_REFUSAL_MODULES.map((p) => p.id)).toEqual(
      IBATEXAS_COMPOSED_PACKS.map((p) => p.id),
    )
  })

  for (const [index, { id, module }] of PACK_REFUSAL_MODULES.entries()) {
    describe(id, () => {
      const pack = IBATEXAS_COMPOSED_PACKS[index]
      const declared = new Set<string>(pack.basisCodes)

      it("every exported function in the refusals module is invocable by the harness", () => {
        // A builder the candidate ladder cannot invoke would be skipped by the
        // extraction below, so its code could drift unseen. Fail here instead:
        // the fix is to extend ARGUMENT_CANDIDATES, not to accept the gap.
        const exportedFunctions = Object.entries(module).filter(
          ([, v]) => typeof v === "function",
        )
        const notInvocable = exportedFunctions
          .filter(
            ([, v]) => invokeForRefusal(v as (...args: never[]) => unknown) === null,
          )
          .map(([name]) => name)
        expect(notInvocable, `${id}: refusal builders the harness could not invoke`).toEqual(
          [],
        )
        expect(exportedFunctions.length).toBeGreaterThan(0)
      })

      it("every refusal code constructed in refusals.ts is declared in basisCodes", () => {
        const constructed = constructedCodes(module)
        // Non-vacuity: extraction must actually have found codes. An empty or
        // near-empty map would make the subset assertion below pass trivially.
        expect(constructed.size).toBeGreaterThanOrEqual(declared.size)

        const undeclared = [...constructed.keys()]
          .filter((code) => !declared.has(code))
          .sort()
          .map((code) => `${code} (built by ${constructed.get(code)?.join(", ")})`)

        expect(
          undeclared,
          `${id} emits refusal codes absent from its basisCodes — the AI-BOM, ` +
            `config seal and coherence export under-report them. Add them to ` +
            `basisCodes and regenerate the governance artifacts.`,
        ).toEqual([])
      })

      it("basisCodes declares no code that no builder constructs", () => {
        // The converse direction. A declared-but-unbuilt code inflates the
        // AI-BOM with a guardrail the Pack cannot actually emit; it also
        // usually means a builder was deleted without its declaration.
        const constructed = constructedCodes(module)
        const unbuilt = [...declared].filter((code) => !constructed.has(code)).sort()
        expect(
          unbuilt,
          `${id} declares basisCodes with no constructing builder in refusals.ts`,
        ).toEqual([])
      })
    })
  }
})
