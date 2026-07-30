// build-pack-kind-union-region.ts — R6 leg 1b: the LAST hand mirror of the
// intent-identity family, each pack's own kind TYPE UNION
// (`OrderIntentKind` et al. in `packages/pack-*/src/types.ts`), becomes a
// GENERATED region — same sentinel pair, same splice, same command as leg 1a's
// `intents[]` arrays and FE-T26's `intent-kinds/src/index.ts` region.
//
// ── Why this was the expensive mirror ────────────────────────────────────────
// The R6-S1 review of LE2-024 measured +14 hand-spelled `types.ts` lines per
// kind addition. That is the union member plus its doc-block row — and the
// union member is the load-bearing half: `intent-kinds/src/index.ts` closes its
// six generated arrays with `as const satisfies readonly OrderIntentKind[]`, so
// a union that has not been hand-updated fails the whole workspace build with
// TS2820. Adding a capability was a data edit in `definitions.ts` PLUS a
// hand edit in a second package to stop the build from breaking. Now it is the
// data edit and a regen.
//
// ── Derivability, CHECKED before writing a line of this module ──────────────
// A union could legitimately carry members the definitions no longer do —
// pack-payments' own BKL-176 note documents 5 RETIRED `payment.charge.*` kinds,
// so history was a live possibility, and a generator that quietly DELETED a
// still-referenced union member would be a type-level regression dressed up as
// codegen. Measured against the real catalog projection, all six unions are
// exactly `generatePackIntents(CAPABILITY_DEFINITIONS, pack)` — same members,
// same order, 62 total = `CAPABILITY_DEFINITIONS.length`, zero union-only
// members in any pack (the retired `payment.charge.*` kinds are absent from the
// union as well as from the definitions). Nothing was absorbed; the
// `regen-pack-unions-freshness.test.ts` "no union member is undeclared" case
// keeps that finding executable rather than a claim in this comment.
//
// ── The annotations table is PER FAMILY MEMBER, not per kind ────────────────
// Leg 1a discovered that "structurally identical data" is not "identical source
// text": five rationale blocks lived INSIDE the committed `intents[]` arrays.
// The unions carry rationale too — and it is DIFFERENT rationale, in a
// different pack:
//   • pack-whatsapp's union carries TWO interleaved blocks (W5-6 on
//     `conversation.message.append`, F5/L3/BKL-030 on
//     `whatsapp.handoff.request`) — 8 lines that exist in NEITHER
//     `CAPABILITY_DEFINITIONS` nor `pack-whatsapp/src/index.ts`.
//   • the packs whose `intents[]` arrays carry notes (payments' BKL-176, ops'
//     four) carry NONE inside their unions: that rationale sits in the
//     `/** … */` doc block ABOVE the type, which is outside the region and
//     stays hand-authored.
// So the note text is a property of the (FILE, kind) pair, not of the kind.
// One shared table keyed by kind alone would either duplicate ops' four notes
// into the union or hoist whatsapp's two into the array — inventing committed
// bytes in both directions. Two tables, one renderer
// (`annotated-member-region.ts`), is the honest shape; the per-kind rationale
// field on `CapabilityDefinition` that could someday feed BOTH is still
// deliberately out of scope, for leg 1a's reason (it would move the
// intent-kinds region's committed bytes too).
//
// ── Where the markers go, and what pins them ────────────────────────────────
// Immediately after `export type XIntentKind =`, so the region is EXACTLY the
// union's member lines. Unlike leg 1a's array this declaration has NO closing
// token — a union ends where its members stop — so the freshness gate cannot
// lean on a `],` and instead pins the region's tail two ways: the END marker is
// followed by a blank line, AND the first line after that blank does not
// continue the union with another `|`. Without the second assertion a
// hand-added member below the blank line would still be part of the type (blank
// lines are whitespace to TypeScript) and the gate would stay green.
//
// Cycle-free by construction, exactly like legs 1a and FE-T26: the six
// `types.ts` files are reached by a plain relative FILESYSTEM path, never a
// package import, so no pack gains a dependency on `@ibatexas/packs-composed`.

import {
  CAPABILITY_DEFINITIONS,
  generatePackIntents,
  type CapabilityPackId,
} from "@ibatexas/catalog"

import {
  renderAnnotatedMemberRegion,
  type KindAnnotations,
} from "./annotated-member-region.js"

/** Indentation of a union member — one level, this repo's 2-space width. */
const MEMBER_INDENT = "  "

interface PackKindUnionTarget {
  readonly packId: CapabilityPackId
  /** Directory name under `packages/` holding this pack — joined with
   *  `src/types.ts` by each caller against its OWN path to `packages/`, so
   *  this pure module stays free of `node:path`. */
  readonly packageDir: string
  /** The exported union whose members are the region — recorded so a failing
   *  freshness message can name the exact type, and so the gate can locate the
   *  declaration line the BEGIN marker must follow. */
  readonly typeName: string
  readonly annotations?: KindAnnotations
}

/** All six first-party packs. Order is presentational only (it mirrors
 *  `PACK_INTENTS_TARGETS`); each union is spliced into its own file
 *  independently. */
export const PACK_KIND_UNION_TARGETS: readonly PackKindUnionTarget[] = [
  {
    packId: "ibatexas/pack-orders",
    packageDir: "pack-orders",
    typeName: "OrderIntentKind",
  },
  {
    packId: "ibatexas/pack-reservations",
    packageDir: "pack-reservations",
    typeName: "ReservationIntentKind",
  },
  {
    packId: "ibatexas/pack-whatsapp",
    packageDir: "pack-whatsapp",
    typeName: "WhatsAppIntentKind",
    annotations: {
      "conversation.message.append": [
        "W5-6: persistence-side append (system-actor). The",
        "conversation-archiver subscriber emits this for archival; the LLM",
        "never proposes it.",
      ],
      "whatsapp.handoff.request": [
        "F5/L3 (BKL-030): customer-side escalation on-ramp. UNLIKE the",
        "system-only `whatsapp.session.handover` (staff-driven takeover), THIS is",
        "the LLM-proposable \"quero falar com um atendente\" request — UNTRUSTED, so",
        "the customer can trigger a governed handoff. Executor = handoffToHuman",
        "(publishes support.handoff_requested → the existing handoff spine).",
      ],
    },
  },
  {
    packId: "ibatexas/pack-payments",
    packageDir: "pack-payments",
    typeName: "PaymentIntentKind",
  },
  {
    packId: "ibatexas/pack-customer-onboarding",
    packageDir: "pack-customer-onboarding",
    typeName: "CustomerOnboardingIntentKind",
  },
  {
    packId: "ibatexas/pack-ops",
    packageDir: "pack-ops",
    typeName: "OpsIntentKind",
  },
]

/** The committed line the BEGIN marker must immediately follow — the union's
 *  own declaration. Shared by the write-side script's structural expectations
 *  and the freshness gate so there is ONE spelling of "the declaration line". */
export function unionDeclarationLine(target: PackKindUnionTarget): string {
  return `export type ${target.typeName} =`
}

/**
 * Build one pack's GENERATED union region — markers included — as the exact
 * TypeScript source text that belongs between its declaration line and the
 * blank line ending the declaration.
 *
 * The FIRST line is the bare `GENERATED_BEGIN` marker with no indentation: the
 * splice keeps whatever indentation the committed marker line already has.
 * Every subsequent line carries its own.
 *
 * Deterministic: two calls on the same `CAPABILITY_DEFINITIONS` produce
 * byte-identical output.
 */
export function buildPackKindUnionRegion(target: PackKindUnionTarget): string {
  return renderAnnotatedMemberRegion({
    kinds: generatePackIntents(CAPABILITY_DEFINITIONS, target.packId),
    indent: MEMBER_INDENT,
    renderMember: (kind) => `| "${kind}"`,
    annotations: target.annotations,
  })
}

/** Guidance the freshness gate and the write-side script both surface when a
 *  pack's union region has drifted — the single place that explains BOTH ways
 *  it legitimately changes. */
export const PACK_KIND_UNION_DRIFT_GUIDANCE =
  "Do not hand-edit a pack's kind union: change the kind list in " +
  "packages/catalog/src/capability-definitions/definitions.ts (or a per-kind " +
  "rationale comment in PACK_KIND_UNION_TARGETS' annotations table in " +
  "packages/packs-composed/src/codegen/build-pack-kind-union-region.ts), then run " +
  "`pnpm --filter @ibatexas/packs-composed run regen:intent-kinds`. Rationale " +
  "that belongs to the whole union goes in the /** … */ doc block ABOVE the " +
  "type, which is outside the region and stays hand-authored."
