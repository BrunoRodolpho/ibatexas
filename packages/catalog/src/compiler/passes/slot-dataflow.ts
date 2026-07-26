// PASS 2 — SLOT DATAFLOW (LE2-016).
//
// Every slot a catalog object declares is WELL-FORMED: its value has the type
// its contract states, its required/optional status is coherent with what it
// actually carries, and no slot is declared that its object's contract has no
// place for. Ticket 16's second rejection class ("slot use-before-def"), read
// against the schema the catalog actually has today.
//
// # What a "slot" is here
//
// A slot is a declared field on a catalog object — `types.ts`'s per-tier
// contract, restated as data in `../slots.ts`. `types.ts` already makes a
// malformed AUTHORED literal a compile error, and this pass does not
// re-litigate that: it enforces the same contract for any catalog VALUE, which
// is the only form a pass ever sees, plus the four things a string-literal
// union provably cannot see:
//
//   1. TYPE CONSISTENCY beyond the union — a blank `description`, a
//      `surfaces` entry outside the closed plane vocabulary, a `guardRefs`
//      entry that is not a `{phase, name}` pair.
//   2. REQUIRED/OPTIONAL COHERENCE — an optional slot declared EMPTY says "I
//      have none of these" in a second, redundant way that no consumer reads;
//      `undefined` is how the contract spells it (`successClaimLinks:
//      undefined` is authored explicitly throughout `definitions.ts`). The one
//      slot where empty is real data — chat-tier `legacyNames: []`, FE-T09's
//      three `order.amend.*` kinds — is marked `emptyIsMeaningful` and exempt.
//   3. ORPHAN SLOTS — a chat-only slot on an identity-tier object. `types.ts`
//      makes this structurally impossible to WRITE ("no `surfaces`/`auth`/…
//      property exists on this variant at all"), which is exactly why a value
//      that carries one anyway must be rejected rather than half-read.
//   4. UNKNOWN SLOTS — `refusalCodes`, `guardRef`, `adminLabels`. A typo'd
//      OPTIONAL slot is the silent one: it type-checks nowhere, it is read
//      nowhere, and the capability quietly behaves as if the author never
//      wrote it.
//
// # Slot dataflow, and the part of it that is not here yet
//
// The ticket's phrase is "slot use-before-def", whose full form needs slot
// PRODUCERS and CONSUMERS — a template or journey activity naming a slot some
// earlier step fills. The catalog holds no templates and no journeys today
// (Decision 13: "nothing new is added until what exists is unified"; journeys
// are tickets 20/22). Inventing a template grammar to have something to
// use-before-def against would be authoring business definition under cover of
// a compiler ticket. What EXISTS is the definition's own slot table, and its
// well-formedness is checked here in full; `extractionSchema` — the
// forward-declared per-capability slot schema FE-1 populates later — is held
// to the optional-slot coherence rule and nothing more, so this pass does not
// bind FE-1 to a shape it has not designed.
//
// Pure: no clock, no RNG, no IO.

import {
  CAPABILITY_AUTH_LEVELS,
  CAPABILITY_SURFACES,
  CAPABILITY_TIERS,
  GUARD_PHASES,
} from "../../capability-definitions/vocabularies.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import {
  capabilityObjectName,
  type CatalogDiagnostic,
  type CatalogPassResult,
} from "../diagnostics.js"
import {
  ALL_SLOT_NAMES,
  asRecord,
  isEmptyValue,
  isNonBlankString,
  SLOT_SPECS,
  slotAppliesToTier,
  slotRequiredOnTier,
  type SlotSpec,
} from "../slots.js"

const PASS = "slot-dataflow" as const

/** Closed-enum slots: slot (or slot element) -> the vocabulary it draws from. */
const ENUM_SLOTS: readonly {
  readonly field: string
  readonly vocabulary: string
  readonly values: readonly string[]
  readonly perElement: boolean
}[] = [
  { field: "tier", vocabulary: "CAPABILITY_TIERS", values: CAPABILITY_TIERS, perElement: false },
  { field: "auth", vocabulary: "CAPABILITY_AUTH_LEVELS", values: CAPABILITY_AUTH_LEVELS, perElement: false },
  { field: "surfaces", vocabulary: "CAPABILITY_SURFACES", values: CAPABILITY_SURFACES, perElement: true },
]

interface SlotContext {
  readonly object: string
  readonly record: Readonly<Record<string, unknown>>
  readonly tier: unknown
}

function diag(
  ctx: SlotContext,
  rule: string,
  field: string,
  message: string,
): CatalogDiagnostic {
  return { pass: PASS, rule, severity: "error", object: ctx.object, field, message }
}

/** Does `value` match the slot's declared shape? */
function typeMismatch(spec: SlotSpec, value: unknown): string | undefined {
  switch (spec.kind) {
    case "string":
      return typeof value === "string" ? undefined : "a string"
    case "boolean":
      return typeof value === "boolean" ? undefined : "a boolean"
    case "string-array":
      if (!Array.isArray(value)) return "an array of strings"
      return value.every((v) => typeof v === "string") ? undefined : "an array of strings"
    case "object-array":
      if (!Array.isArray(value)) return "an array of objects"
      return value.every((v) => typeof v === "object" && v !== null && !Array.isArray(v))
        ? undefined
        : "an array of objects"
    case "true-literal":
      return value === true ? undefined : "the literal `true` (or absent)"
    case "opaque":
      return undefined
  }
}

function checkPresenceAndType(ctx: SlotContext, spec: SlotSpec): CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const declared = spec.name in ctx.record && ctx.record[spec.name] !== undefined
  const applies = slotAppliesToTier(spec, ctx.tier)
  const value = ctx.record[spec.name]

  if (!applies) {
    // An orphan is a DECLARED slot the object's contract has no place for.
    // `undefined` is not a declaration — an identity-tier object spelling
    // `refusalCode: undefined` carries no value and misleads no consumer.
    if (declared) {
      out.push(
        diag(
          ctx,
          "orphan-slot",
          spec.name,
          `slot is chat-tier-only but this capability is tier "${String(ctx.tier)}". ` +
            "types.ts gives IdentityCapabilityDefinition no such property at all — a " +
            "value here describes a surface the capability does not have.",
        ),
      )
    }
    return out
  }

  if (!declared) {
    if (slotRequiredOnTier(spec, ctx.tier)) {
      out.push(
        diag(
          ctx,
          "missing-required-slot",
          spec.name,
          `required slot is absent on tier "${String(ctx.tier)}". ` +
            "types.ts requires it; a consumer reading it gets `undefined` and has no " +
            "honest fallback.",
        ),
      )
    }
    return out
  }

  const expected = typeMismatch(spec, value)
  if (expected !== undefined) {
    out.push(
      diag(
        ctx,
        "slot-type-mismatch",
        spec.name,
        `slot must be ${expected}; got ${describe(value)}.`,
      ),
    )
    return out
  }

  if (isEmptyValue(value) && spec.emptyIsMeaningful !== true) {
    if (slotRequiredOnTier(spec, ctx.tier)) {
      out.push(
        diag(
          ctx,
          "blank-required-slot",
          spec.name,
          "required slot is declared but empty. An empty required slot is a hole " +
            "wearing a value's clothes — a consumer cannot tell it from authored data.",
        ),
      )
    } else {
      out.push(
        diag(
          ctx,
          "empty-optional-slot",
          spec.name,
          "optional slot is declared but empty. The contract spells 'none' as " +
            "`undefined` (or omission), not as an empty value — an empty one asserts " +
            "the slot was authored when it was not.",
        ),
      )
    }
    return out
  }

  // Per-element blanks in a string array: one blank entry is a hole even when
  // the array itself is non-empty.
  if (spec.kind === "string-array" && Array.isArray(value)) {
    value.forEach((entry, i) => {
      if (typeof entry === "string" && entry.trim() === "") {
        out.push(
          diag(
            ctx,
            "blank-slot-entry",
            `${spec.name}[${i}]`,
            "array slot carries a blank entry; every entry must name something.",
          ),
        )
      }
    })
    const seen = new Map<string, number>()
    value.forEach((entry, i) => {
      if (typeof entry !== "string") return
      const first = seen.get(entry)
      if (first !== undefined) {
        out.push(
          diag(
            ctx,
            "duplicate-slot-entry",
            `${spec.name}[${i}]`,
            `"${entry}" is already declared at ${spec.name}[${first}]. Slot arrays are ` +
              "read as sets; a repeat carries no information and skews every count " +
              "derived from them.",
          ),
        )
      } else {
        seen.set(entry, i)
      }
    })
  }

  return out
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `an array (${JSON.stringify(value).slice(0, 60)})`
  if (typeof value === "object") return "an object"
  return `${typeof value} (${JSON.stringify(value)})`
}

function checkEnums(ctx: SlotContext): CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  for (const enumSlot of ENUM_SLOTS) {
    const value = ctx.record[enumSlot.field]
    if (value === undefined) continue
    const entries: readonly { value: unknown; field: string }[] = enumSlot.perElement
      ? Array.isArray(value)
        ? value.map((v, i) => ({ value: v, field: `${enumSlot.field}[${i}]` }))
        : []
      : [{ value, field: enumSlot.field }]
    for (const entry of entries) {
      if (typeof entry.value === "string" && enumSlot.values.includes(entry.value)) continue
      if (typeof entry.value !== "string") continue // a type mismatch, already reported
      out.push(
        diag(
          ctx,
          "slot-enum-violation",
          entry.field,
          `"${entry.value}" is not a member of ${enumSlot.vocabulary} ` +
            `(${enumSlot.values.join(" | ")}).`,
        ),
      )
    }
  }
  return out
}

/**
 * `guardRefs` entries are `{phase, name}` pairs. The element SHAPE is checked
 * here (a malformed pair is a malformed slot); whether a phase can actually
 * carry a terminal is the terminal-coverage pass's question.
 */
function checkGuardRefShape(ctx: SlotContext): CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const refs = ctx.record["guardRefs"]
  if (!Array.isArray(refs)) return out
  const seen = new Map<string, number>()
  refs.forEach((ref, i) => {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) return
    const pair = ref as Record<string, unknown>
    const phase = pair["phase"]
    const name = pair["name"]
    if (!isNonBlankString(phase)) {
      out.push(
        diag(
          ctx,
          "malformed-guard-ref",
          `guardRefs[${i}].phase`,
          `guard ref must carry a non-blank phase; got ${describe(phase)}.`,
        ),
      )
    } else if (!(GUARD_PHASES as readonly string[]).includes(phase)) {
      out.push(
        diag(
          ctx,
          "slot-enum-violation",
          `guardRefs[${i}].phase`,
          `"${phase}" is not a member of GUARD_PHASES (${GUARD_PHASES.join(" | ")}).`,
        ),
      )
    }
    if (!isNonBlankString(name)) {
      out.push(
        diag(
          ctx,
          "malformed-guard-ref",
          `guardRefs[${i}].name`,
          `guard ref must name a guard; got ${describe(name)}. The name must equal the ` +
            "guard's resolvable identity (its GuardMetadata.name, else its Function.name).",
        ),
      )
      return
    }
    const key = `${String(phase)}|${name}`
    const first = seen.get(key)
    if (first !== undefined) {
      out.push(
        diag(
          ctx,
          "duplicate-slot-entry",
          `guardRefs[${i}]`,
          `guard "${name}" is already declared for phase "${String(phase)}" at ` +
            `guardRefs[${first}]. The chain mirrors a Pack's PolicyBundle arrays, where ` +
            "each guard appears once.",
        ),
      )
    } else {
      seen.set(key, i)
    }
  })
  return out
}

function checkUnknownSlots(ctx: SlotContext): CatalogDiagnostic[] {
  return Object.keys(ctx.record)
    .filter((key) => !ALL_SLOT_NAMES.has(key))
    .map((key) =>
      diag(
        ctx,
        "unknown-slot",
        key,
        "no such slot in the capability-definition contract (types.ts). A misspelled " +
          "slot is read by nothing and silently behaves as if it were never authored.",
      ),
    )
}

/**
 * Run the slot-dataflow pass.
 *
 * `checked` counts slot INSPECTIONS: every contract slot considered on every
 * capability, plus every key actually present (so an unknown slot counts as
 * looked-at too).
 */
export function runSlotDataflowPass(
  definitions: readonly CapabilityDefinition[],
): CatalogPassResult {
  const diagnostics: CatalogDiagnostic[] = []
  let checked = 0
  definitions.forEach((def, index) => {
    const record = asRecord(def)
    const ctx: SlotContext = {
      object: capabilityObjectName(record["kind"], index),
      record,
      tier: record["tier"],
    }
    for (const spec of SLOT_SPECS) {
      checked += 1
      diagnostics.push(...checkPresenceAndType(ctx, spec))
    }
    checked += Object.keys(record).length
    diagnostics.push(...checkEnums(ctx))
    diagnostics.push(...checkGuardRefShape(ctx))
    diagnostics.push(...checkUnknownSlots(ctx))
  })
  return { pass: PASS, checked, diagnostics }
}
