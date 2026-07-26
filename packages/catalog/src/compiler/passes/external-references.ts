// PASS 5 — EXTERNAL REFERENCES (LE2-018).
//
// The STATIC half of boot reconciliation. Ticket 18 asks for two things that
// are easy to confuse: references the catalog can DECLARE, and a runtime that
// REFUSES TO START when one of them is missing. This pass owns the first
// exclusively, and owns none of the second: it proves the declaration table in
// `src/external-references.ts` is well-formed and internally coherent, so that
// by the time anything does IO there is a table worth reconciling.
//
// # Why a fifth pass instead of two more referential-integrity rules
//
// The choice was live — a declaration's `declaredBy[i].capability` is an
// outbound edge and a duplicate `id` is an identity collision, which are
// exactly referential-integrity's two rule families. Three things decided it
// the other way:
//
//   1. `checked` is the anti-vacuous measure, and it only works per PASS.
//      Folding declarations into referential-integrity's count (already
//      edges + kinds + legacy names, in the hundreds) would hide "the
//      declaration table was never looked at" inside a large number that
//      moves for unrelated reasons. As its own pass, `checked: 0` on the real
//      catalog is visible on one line of `ibx catalog check`.
//   2. This pass reads a SECOND INPUT. Every other pass is a function of
//      `definitions` alone; this one needs the declaration table too, and
//      teaching the oldest, most-depended-on pass a second parameter to serve
//      one new rule family is how a coherent pass turns into a junk drawer.
//   3. The static and runtime halves should share a name. The boot refusal,
//      the `--live` report and the compiler diagnostics all say
//      `external-references`, so an operator who sees one can grep the others.
//
// # What it checks, and the one thing it cannot
//
// Shape (`id` present and unique, `store` known, `keyFrom` a plausible env var
// name), and coherence (every non-null consumer capability resolves; every
// declaration has at least one consumer). What it CANNOT check is whether the
// reference exists — that is a live-store question, answered by
// `@ibatexas/tools`' reconciler at boot and behind `ibx catalog check --live`.
// A clean run of this pass means "the table is answerable", never "the
// references are there".
//
// Pure: no clock, no RNG, no IO, no `process.env`.

import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import {
  EXTERNAL_REFERENCE_STORES,
  type ExternalReferenceDeclaration,
} from "../../external-references.js"
import {
  externalReferenceObjectName,
  type CatalogDiagnostic,
  type CatalogPassResult,
} from "../diagnostics.js"
import { asRecord } from "../slots.js"

const PASS = "external-references" as const

const STORE_SET: ReadonlySet<string> = new Set<string>(EXTERNAL_REFERENCE_STORES)

/**
 * A conventional environment-variable name: upper snake case, digits allowed
 * after the first character. Deliberately a SHAPE check and not a lookup — the
 * compiler must never read `process.env` (a catalog that compiled differently
 * on two machines would be worthless), so the strongest static statement
 * available is "this is spelled like a variable name someone can set".
 */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/

/**
 * Widen a declaration for inspection — fixtures carry deliberately bad data.
 *
 * A non-object row (a `null` left by a bad merge, a stray string) reads as an
 * EMPTY record rather than throwing, and is then reported by the shape rules as
 * the three separate faults it genuinely has. The compiler's contract is that
 * a malformed catalog comes back as diagnostics; a pass that threw on junk
 * would take the whole report down with it and hide every other pass's
 * findings behind one stack trace.
 */
function record(declaration: ExternalReferenceDeclaration): Record<string, unknown> {
  return typeof declaration === "object" && declaration !== null
    ? (declaration as unknown as Record<string, unknown>)
    : {}
}

/** Every consumer entry on a declaration, whatever the slot actually holds. */
function consumersOf(declaration: ExternalReferenceDeclaration): readonly unknown[] {
  const value = record(declaration)["declaredBy"]
  return Array.isArray(value) ? (value as readonly unknown[]) : []
}

function capabilityOf(consumer: unknown): unknown {
  return typeof consumer === "object" && consumer !== null
    ? (consumer as Record<string, unknown>)["capability"]
    : undefined
}

function shapeDiagnostics(
  declarations: readonly ExternalReferenceDeclaration[],
): readonly CatalogDiagnostic[] {
  const diagnostics: CatalogDiagnostic[] = []

  declarations.forEach((declaration, index) => {
    const slots = record(declaration)
    const object = externalReferenceObjectName(slots["id"], index)
    const store = slots["store"]
    const keyFrom = slots["keyFrom"]

    if (typeof store !== "string" || !STORE_SET.has(store)) {
      diagnostics.push({
        pass: PASS,
        rule: "external-reference-unknown-store",
        severity: "error",
        object,
        field: "store",
        message:
          `"${String(store)}" is not a live store this repo knows how to probe. ` +
          `Known stores: ${[...EXTERNAL_REFERENCE_STORES].join(", ")}. A store is a ` +
          "pair — the id in src/external-references.ts and a probe in " +
          "packages/tools/src/external-references/probes.ts — and a declaration " +
          "naming a store with no probe could never be reconciled, so it would " +
          "either fail every boot or (worse) be skipped silently.",
        reference: String(store),
      })
    }

    if (typeof keyFrom !== "string" || !ENV_VAR_NAME.test(keyFrom)) {
      diagnostics.push({
        pass: PASS,
        rule: "external-reference-malformed-key-source",
        severity: "error",
        object,
        field: "keyFrom",
        message:
          `"${String(keyFrom)}" is not an environment-variable name (expected ` +
          "UPPER_SNAKE_CASE). keyFrom names the variable the reference's key is " +
          "read from at reconciliation time; the catalog never holds the key " +
          "itself (CLAUDE.md rule 3 — config comes from process.env), so a " +
          "misspelled variable name is a reference nothing can ever resolve.",
        reference: String(keyFrom),
      })
    }

    if (consumersOf(declaration).length === 0) {
      diagnostics.push({
        pass: PASS,
        rule: "external-reference-no-consumer",
        severity: "error",
        object,
        field: "declaredBy",
        message:
          "no code site declares it consumes this reference. A declaration with " +
          "no consumer can still REFUSE THE BOOT, and the refusal would name " +
          "nothing an operator could act on — it is a hostage, not a gate. " +
          "Either name the consuming site(s) or delete the declaration.",
      })
    }
  })

  return diagnostics
}

function duplicateIdDiagnostics(
  declarations: readonly ExternalReferenceDeclaration[],
): readonly CatalogDiagnostic[] {
  const positionsById = new Map<string, number[]>()
  declarations.forEach((declaration, index) => {
    const id = record(declaration)["id"]
    if (typeof id !== "string") return
    positionsById.set(id, [...(positionsById.get(id) ?? []), index])
  })

  const diagnostics: CatalogDiagnostic[] = []
  for (const [id, positions] of positionsById) {
    if (positions.length < 2) continue
    for (const index of positions) {
      diagnostics.push({
        pass: PASS,
        rule: "external-reference-duplicate-id",
        severity: "error",
        object: externalReferenceObjectName(id, index),
        field: "id",
        message:
          `"${id}" is declared by ${positions.length} entries (array positions ` +
          `${positions.join(", ")}). The id is how the boot refusal, the ` +
          "--live report and every diagnostic address one reference; two rows " +
          "sharing it means an operator told to fix one has no way to know which.",
        reference: id,
      })
    }
  }
  return diagnostics
}

function consumerDanglerDiagnostics(
  declarations: readonly ExternalReferenceDeclaration[],
  definitions: readonly CapabilityDefinition[],
): readonly CatalogDiagnostic[] {
  const kinds = new Set<string>()
  for (const def of definitions) {
    const kind = asRecord(def)["kind"]
    if (typeof kind === "string") kinds.add(kind)
  }

  const diagnostics: CatalogDiagnostic[] = []
  declarations.forEach((declaration, index) => {
    const object = externalReferenceObjectName(record(declaration)["id"], index)
    consumersOf(declaration).forEach((consumer, position) => {
      const capability = capabilityOf(consumer)
      // `null` is the sanctioned "not a capability" consumer (a subscriber, a
      // session helper). Only a NAMED capability is an edge worth resolving.
      if (capability === null || capability === undefined) return
      if (typeof capability === "string" && kinds.has(capability)) return
      diagnostics.push({
        pass: PASS,
        rule: "external-reference-consumer-dangling",
        severity: "error",
        object,
        field: `declaredBy[${position}].capability`,
        message:
          `"${String(capability)}" is not a capability kind this catalog defines. ` +
          "A consumer names either a real capability or null (for a site that is " +
          "not a capability at all — a subscriber, a session helper). A stale kind " +
          "here means a renamed capability left the declaration pointing at " +
          "nothing, and the boot refusal would send an operator to a symbol that " +
          "no longer exists.",
        reference: String(capability),
      })
    })
  })
  return diagnostics
}

/**
 * Run the external-references pass.
 *
 * `checked` counts every declaration plus every consumer entry — the two units
 * this pass actually inspects. On the real catalog it is non-zero for as long
 * as a single reference is declared; the day the table empties, the count goes
 * to zero honestly rather than a pass pretending to have looked.
 */
export function runExternalReferencesPass(
  definitions: readonly CapabilityDefinition[],
  declarations: readonly ExternalReferenceDeclaration[] = [],
): CatalogPassResult {
  const consumerCount = declarations.reduce((n, d) => n + consumersOf(d).length, 0)
  return {
    pass: PASS,
    checked: declarations.length + consumerCount,
    diagnostics: [
      ...shapeDiagnostics(declarations),
      ...duplicateIdDiagnostics(declarations),
      ...consumerDanglerDiagnostics(declarations, definitions),
    ],
  }
}
