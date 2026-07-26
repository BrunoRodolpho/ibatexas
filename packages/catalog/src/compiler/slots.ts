// The SLOT CONTRACT — what a capability definition's slots are, per tier
// (LE2-016, shared by the slot-dataflow and terminal-coverage passes).
//
// `types.ts` states this contract in the type system: `CapabilityDefinition` is
// a union discriminated on `tier`, a `ChatCapabilityDefinition` REQUIRES six
// chat-facing slots, and an `IdentityCapabilityDefinition` does not declare
// them at all. That is a genuine structural guarantee — for the AUTHORED
// literal, and only there. The compiler's job starts where the type system's
// ends:
//
//   - `readonly CapabilityDefinition[]` is what a pass receives; a widened
//     cast, a fixture, or a future generated catalog can hold anything;
//   - the type system cannot see that `""` is not a usable `description`,
//     that `successClaimLinks: []` says something different from `undefined`,
//     that `["reorder", "reorder"]` is a duplicate, or that a slot named
//     `refusalCodes` is a typo for a slot nothing will ever read.
//
// So this file restates the contract as DATA the passes can iterate. It is
// deliberately a mirror of `types.ts` and nothing more — it adds no slot, and
// {@link ALL_SLOT_NAMES} is proved to enumerate exactly the union's keys at
// compile time, so a slot added to `types.ts` without an entry here is a
// compile error rather than a slot no pass ever looks at.
//
// Pure: no clock, no RNG, no IO.

import type { CapabilityDefinition } from "../capability-definitions/types.js"

/** A definition read structurally — the shape a pass can safely index. */
export type CapabilityRecord = Readonly<Record<string, unknown>>

/** Read any definition as an indexable record (never throws). */
export function asRecord(def: CapabilityDefinition): CapabilityRecord {
  return def as unknown as CapabilityRecord
}

/** How a slot's value is shaped, for the type-consistency check. */
export type SlotKind =
  | "string"
  | "boolean"
  | "string-array"
  | "object-array"
  | "true-literal"
  | "opaque"

/** Which tiers may declare a slot. */
export type SlotTierScope = "both" | "chat-only"

/** One slot in the capability-definition contract. */
export interface SlotSpec {
  readonly name: string
  readonly kind: SlotKind
  /** Tier(s) allowed to declare it. `"chat-only"` slots are ORPHANS elsewhere. */
  readonly scope: SlotTierScope
  /**
   * `true` when the tier that may declare it MUST declare it. A required slot
   * that is absent is a hole; an OPTIONAL slot that is present-but-empty is an
   * incoherence (say `undefined`, not `[]`) — the two halves of "required /
   * optional coherent".
   */
  readonly required: boolean
  /**
   * `true` when an empty value (`[]`, `""`) is a legitimate authored state
   * rather than an incoherence. Exactly one slot sets it: `legacyNames` on the
   * chat tier, where `[]` is DELIBERATE authored data — FE-T09's three
   * `order.amend.*` kinds are newly-registered tools with no legacy name, and
   * `definitions.ts` says so verbatim ("`legacyNames: []`, not fabricated").
   */
  readonly emptyIsMeaningful?: true
}

/**
 * The full slot contract, mirroring `types.ts`.
 *
 * `extractionSchema` is `"opaque"` on purpose. It is FORWARD-DECLARED (`FE-1`
 * populates it in a later ticket) and typed `unknown`, so there is no authored
 * shape to validate against yet — inventing one here would bind FE-1 to a
 * schema this ticket has no authority to design. What the compiler CAN say
 * today without fabricating is the optional-slot coherence rule every other
 * optional slot obeys: declared means non-empty. A `null` / `""` / `{}`
 * `extractionSchema` is a slot that says "I have an extraction schema" and
 * carries none.
 */
export const SLOT_SPECS = [
  { name: "kind", kind: "string", scope: "both", required: true },
  { name: "pack", kind: "string", scope: "both", required: true },
  { name: "mutating", kind: "boolean", scope: "both", required: true },
  { name: "tier", kind: "string", scope: "both", required: true },
  { name: "plannerAdvertisedBy", kind: "string-array", scope: "both", required: false },
  { name: "extractionSchema", kind: "opaque", scope: "both", required: false },
  { name: "successClaimLinks", kind: "string-array", scope: "both", required: false },
  { name: "adminLabel", kind: "string", scope: "both", required: false },
  { name: "opsForbiddenDestructive", kind: "true-literal", scope: "both", required: false },
  // `legacyNames` is REQUIRED on the chat tier (`ChatCapabilityDefinition`
  // narrows it) and optional on the identity tier (FE-T21's two structurally
  // grounded exceptions). The contract is expressed per-tier below.
  //
  // `emptyIsMeaningful` — the one slot in the whole contract where `[]` is
  // authored DATA rather than an unfilled hole: FE-T09's three
  // `order.amend.{add_item,update_qty,remove_item}` kinds are newly-registered
  // tools with no historical name, and `definitions.ts` says so verbatim
  // ("`legacyNames: []`, not fabricated"). Rejecting them would be the pass
  // demanding the fabrication the authoring rules forbid.
  {
    name: "legacyNames",
    kind: "string-array",
    scope: "both",
    required: false,
    emptyIsMeaningful: true,
  },
  { name: "surfaces", kind: "string-array", scope: "chat-only", required: true },
  { name: "auth", kind: "string", scope: "chat-only", required: true },
  { name: "description", kind: "string", scope: "chat-only", required: true },
  // LE2-033 — the conversation projection. `scope: "chat-only"` + `required`
  // mirrors `description` exactly, and for the same reason: it is half of a
  // chat capability's authored identity (the ADMIN register and the CUSTOMER
  // register), so a chat-tier capability without one is a hole and an
  // identity-tier capability with one is an orphan. Note `emptyIsMeaningful`
  // is deliberately ABSENT: unlike `legacyNames`, there is no capability for
  // which "no customer ever says this" is a true authored statement — if the
  // planner can emit it, a customer can ask for it. The per-capability FLOOR
  // (well above 1) lives in the `conversation-projection` pass, which is also
  // where the content rules this table cannot express are enforced.
  { name: "conversationTriggers", kind: "string-array", scope: "chat-only", required: true },
  { name: "guardRefs", kind: "object-array", scope: "chat-only", required: true },
  { name: "refusalCode", kind: "string", scope: "chat-only", required: true },
] as const satisfies readonly SlotSpec[]

/**
 * Slots the CHAT tier additionally requires beyond `scope: "chat-only"`:
 * `legacyNames`, which `ChatCapabilityDefinition` narrows from optional to
 * required (and where `[]` is meaningful — see {@link SlotSpec.emptyIsMeaningful}).
 */
export const CHAT_TIER_EXTRA_REQUIRED: readonly string[] = ["legacyNames"]

/** Every slot name the contract knows. Anything else on an object is unknown. */
export const ALL_SLOT_NAMES: ReadonlySet<string> = new Set(
  SLOT_SPECS.map((s) => s.name),
)

/**
 * Every key of EITHER variant of the union. A bare `keyof CapabilityDefinition`
 * would give only the keys COMMON to both (TypeScript's rule for `keyof` on a
 * union), silently exempting all five chat-only slots from the proof below —
 * exactly the slots most worth proving. Distributing over the union first is
 * what makes the check real.
 */
type AnyCapabilityKey<T> = T extends unknown ? keyof T : never

// Compile-time proof that the table above enumerates EVERY slot of EITHER
// variant. A slot added to `types.ts` with no `SLOT_SPECS` entry makes
// `MissingSlot` a non-`never` union and this assignment stops compiling — so a
// new slot cannot arrive unvalidated by every pass that iterates this table.
// (`satisfies` on the array covers the other direction: no invented slot.)
type MissingSlot = Exclude<
  AnyCapabilityKey<CapabilityDefinition>,
  (typeof SLOT_SPECS)[number]["name"]
>
const _SLOTS_COMPLETE: MissingSlot extends never ? true : MissingSlot = true
void _SLOTS_COMPLETE

/** Is `spec` declarable on `tier`? */
export function slotAppliesToTier(spec: SlotSpec, tier: unknown): boolean {
  return spec.scope === "both" || tier === "chat"
}

/** Is `spec` REQUIRED on `tier`? */
export function slotRequiredOnTier(spec: SlotSpec, tier: unknown): boolean {
  if (!slotAppliesToTier(spec, tier)) return false
  if (spec.required) return true
  return tier === "chat" && CHAT_TIER_EXTRA_REQUIRED.includes(spec.name)
}

/** Is `value` a non-blank string? (A blank required string slot is a hole.) */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/** Is `value` empty in the "declared but carries nothing" sense? */
export function isEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  if (value === null) return true
  if (typeof value === "object") return Object.keys(value).length === 0
  return false
}
