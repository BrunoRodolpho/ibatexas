// Conformance fixtures for the SLOT-DATAFLOW pass (LE2-017).
//
// Ten rule ids, ten fixture catalogs — each one capability, each deviating
// from a well-formed base in exactly one slot. The base objects below are the
// CONTROL: `clean.minimal-identity` and `clean.minimal-chat` compile silent,
// so every diagnostic a fixture here produces is attributable to its one
// deviation.
//
// The two fixtures that OMIT a required slot are spelled out in full rather
// than spread from a base — you cannot subtract a key with a spread, and a
// fixture whose fault is an absence should show the absence.

import { CHAT_BASE, FIXTURE_PACK, IDENTITY_BASE } from "./base.js"
import { fixtureCatalog, type ConformanceFixture } from "../types.js"

export const SLOT_DATAFLOW_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "slot-dataflow.orphan-slot",
    targets: "slot-dataflow/orphan-slot",
    why:
      "`surfaces` is chat-tier-only — types.ts gives IdentityCapabilityDefinition " +
      "no such property at all, so a value here describes a surface the capability " +
      "does not have. (`surfaces` is the orphan chosen deliberately: it is the one " +
      "chat-only slot no OTHER pass reads, so the fixture stays single-purpose.)",
    definitions: fixtureCatalog({
      ...IDENTITY_BASE,
      kind: "conformance.slot.orphan",
      surfaces: ["chat"],
    }),
  },
  {
    name: "slot-dataflow.missing-required-slot",
    targets: "slot-dataflow/missing-required-slot",
    why:
      "a chat-tier capability with no `description`. types.ts requires it; a " +
      "consumer reading it gets `undefined` and has no honest fallback.",
    definitions: fixtureCatalog({
      kind: "conformance.slot.missing-required",
      pack: FIXTURE_PACK,
      mutating: true,
      tier: "chat",
      surfaces: ["chat"],
      auth: "guest",
      legacyNames: ["conformance_tool"],
      guardRefs: [{ phase: "business", name: "conformanceBusinessGuard" }],
      refusalCode: "order.default.deny",
    }),
  },
  {
    name: "slot-dataflow.slot-type-mismatch",
    targets: "slot-dataflow/slot-type-mismatch",
    why: "`mutating` is declared `boolean` and carries the STRING \"true\".",
    definitions: fixtureCatalog({
      ...IDENTITY_BASE,
      kind: "conformance.slot.type-mismatch",
      mutating: "true",
    }),
  },
  {
    name: "slot-dataflow.blank-required-slot",
    targets: "slot-dataflow/blank-required-slot",
    why:
      "a whitespace-only `description` on the chat tier — a hole wearing a " +
      "value's clothes, which no consumer can tell from authored data.",
    definitions: fixtureCatalog({
      ...CHAT_BASE,
      kind: "conformance.slot.blank-required",
      description: "   ",
    }),
  },
  {
    name: "slot-dataflow.empty-optional-slot",
    targets: "slot-dataflow/empty-optional-slot",
    why:
      "`successClaimLinks: []` says 'I have none of these' in a second, redundant " +
      "way no consumer reads. The contract spells none as `undefined` — " +
      "definitions.ts authors it that way throughout.",
    definitions: fixtureCatalog({
      ...IDENTITY_BASE,
      kind: "conformance.slot.empty-optional",
      successClaimLinks: [],
    }),
  },
  {
    name: "slot-dataflow.blank-slot-entry",
    targets: "slot-dataflow/blank-slot-entry",
    why:
      "one blank entry inside an otherwise meaningful `legacyNames` array — a " +
      "per-element hole the array-level emptiness check cannot see.",
    definitions: fixtureCatalog({
      ...IDENTITY_BASE,
      kind: "conformance.slot.blank-entry",
      legacyNames: ["conformance_tool", ""],
    }),
  },
  {
    name: "slot-dataflow.duplicate-slot-entry",
    targets: "slot-dataflow/duplicate-slot-entry",
    why:
      "slot arrays are read as sets; a repeated `legacyNames` entry carries no " +
      "information and skews every count derived from them. (The rule's other " +
      "call site — a guard repeated in `guardRefs` — is the same rule id and is " +
      "covered by the pass's unit tests.)",
    definitions: fixtureCatalog({
      ...IDENTITY_BASE,
      kind: "conformance.slot.duplicate-entry",
      legacyNames: ["conformance_tool", "conformance_tool"],
    }),
  },
  {
    name: "slot-dataflow.slot-enum-violation",
    targets: "slot-dataflow/slot-enum-violation",
    why:
      '`auth: "root"` is outside the closed CAPABILITY_AUTH_LEVELS vocabulary. ' +
      "(The rule's other call site — an out-of-vocabulary `guardRefs[i].phase` — " +
      "is the same rule id and is covered by the pass's unit tests.)",
    definitions: fixtureCatalog({
      ...CHAT_BASE,
      kind: "conformance.slot.enum-violation",
      auth: "root",
    }),
  },
  {
    name: "slot-dataflow.malformed-guard-ref",
    targets: "slot-dataflow/malformed-guard-ref",
    why:
      "a guard ref with a blank `name` names no resolvable guard identity. The " +
      "phase stays valid so the fault is the pair's shape and nothing else.",
    definitions: fixtureCatalog({
      ...CHAT_BASE,
      kind: "conformance.slot.malformed-guard-ref",
      guardRefs: [{ phase: "business", name: "" }],
    }),
  },
  {
    name: "slot-dataflow.unknown-slot",
    targets: "slot-dataflow/unknown-slot",
    why:
      "`refusalCodes` is a typo for `refusalCode`: it type-checks nowhere, is read " +
      "nowhere, and the capability quietly behaves as if the author never wrote it. " +
      "The typo'd slot is deliberately NOT one terminal-coverage reads, so the " +
      "fixture proves the unknown-slot rule alone.",
    definitions: fixtureCatalog({
      ...IDENTITY_BASE,
      kind: "conformance.slot.unknown",
      refusalCodes: "order.default.deny",
    }),
  },
]
