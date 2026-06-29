/**
 * The CLAIM-REGISTRY-AWARE constrained-generation seam (SDD §H · §P3 · §P4 ·
 * §O#9; v1.1 §8; claim-registry v0.1 §1). This is the ibatexas half of SDD §Q.6
 * — the claim-aware planner port's deterministic walls — kept OUT of the
 * model-call body of `ibatexas-planner.ts` so each wall is a small, pure,
 * independently-testable function (the §H "planner is bounded, not trusted"
 * shape: the model proposes; these deterministic checks dispose).
 *
 * The planner SELECTS-and-PARAMETERIZES claim types from a closed REGISTRY enum
 * (claim-registry v0.1 §1: "the Claim Planner is constrained to the registry
 * enum, selects-and-parameterizes, never free-generates"). The three walls,
 * mirroring the EXISTING `allowedIntents` enum guard in the planner:
 *
 *   1. PRE-planning (§H/§P3 — constrained generation): `selectCandidateClaim`
 *      builds a typed `@adjudicate/core` `CandidateClaim` ONLY for a registry
 *      type. A model-proposed type outside the enum is DROPPED (defense in
 *      depth — exactly like a hallucinated `express_intent.capability`). The
 *      planner can never free-generate a claim type.
 *   2. POST-planning (§P4/Inv 8 — completeness): `checkCompleteness` maps every
 *      interrogative/imperative span of the request to a claim, `UNKNOWN`,
 *      `ESCALATE`, or `CLARIFY`. An UNMAPPED span → `CLARIFY` (SDD §J.8: "no
 *      silent drop"), never dropped.
 *   3. SAFETY routing (§O#9/Inv 8 — closed taxonomy): `routeSafety` is
 *      closed-by-construction — an UNRECOGNIZED health/safety marker defaults
 *      to `ESCALATE` (the generic safe terminal). `harassment` /
 *      `medical-emergency` have NO typed terminal yet → `ESCALATE`. It NEVER
 *      passes an unrecognized safety framing through as ordinary text.
 *
 * SCOPE (SDD §Q scope guard): this proves the MACHINERY + the two deterministic
 * walls + §O#9 with a REPRESENTATIVE typed claim-type set. The full 37-row
 * registry population (registry §6) is the deferred follow-on — do NOT read
 * this representative set as the complete vocabulary.
 *
 * Consumes the LINKED `@adjudicate/core` (1.5.0) `CandidateClaim` /
 * `EvidenceRequirement` / `TurnTerminal` shapes verbatim — NOT a stub — so the
 * produced candidates are exactly what the claustrum CLAIMS-VALIDATE stage's
 * `runClaimsKernel` (Q6a/Q5) consumes downstream (SDD §F topology:
 * Read+Action → Ledger → Claims → Renderer). Pure: no clock/RNG/IO; the
 * `now`/ledger/soundness `deps` the kernel needs are injected DOWNSTREAM, not
 * here. No kernel-downstream import (SDD §R: adjudicate → claustrum → ibatexas,
 * never backward).
 */

import type {
  CandidateClaim,
  EvidenceRequirement,
  TurnTerminal,
} from "@adjudicate/core";

/**
 * The REGISTRY enum — the closed, representative set of claim TYPE names the
 * planner may select (claim-registry v0.1 §1; SDD §K "nothing outside the
 * registry may be asserted"). UPPER_CASE registry type names (the registry
 * namespace — distinct from the lowercase `SUCCESS_CLAIM_CLASSES` guard ids;
 * SDD §K "map, do not equate"). REPRESENTATIVE, not the full 37-row vocabulary
 * (SDD §Q scope guard) — one type per claim posture the walls must exercise:
 *
 *   - `MENU_ITEM_ALLERGENS` — a public, safety-critical INFORM read
 *     (floor `structured`; a free-text "sem alérgenos" must FAIL → UNKNOWN —
 *     SDD §E worked types).
 *   - `STORE_HOURS`         — a public, cacheable INFORM read.
 *   - `STORE_OPEN_NOW`      — the OVERRIDE-AWARE "is it open right now" read
 *     (public; W6-falsified by a present ScheduleOverride — Triad slice).
 *   - `ORDER_FULFILLMENT_STAGE` — a customer-scoped, live STATUS read
 *     (owner-scoped, `must_read_this_turn` — SDD §E / §N P1).
 *   - `PAYMENT_STATUS`      — a customer-scoped, live, first-party money read
 *     (ownership required, `first_party_only` — SDD §E / §N P0).
 *   - `PURCHASE_COMPLETED`  — an ACTION claim (`action_outcome`; does NOT imply
 *     settlement — SDD §E / §K Cluster F).
 *
 * The membership tuple is the single source of truth; `isRegistryClaimType`
 * narrows an `unknown` against it (mirrors the `decision.ts`/`verdict.ts` idiom).
 */
export const CLAIM_REGISTRY = [
  "MENU_ITEM_ALLERGENS",
  "STORE_HOURS",
  "STORE_OPEN_NOW",
  "ORDER_FULFILLMENT_STAGE",
  "PAYMENT_STATUS",
  "PURCHASE_COMPLETED",
] as const;

/** A claim TYPE name the planner may select (a member of {@link CLAIM_REGISTRY}). */
export type RegistryClaimType = (typeof CLAIM_REGISTRY)[number];

/** The closed registry-type set, for O(1) membership in the constrained-gen guard. */
const REGISTRY_SET: ReadonlySet<string> = new Set<string>(CLAIM_REGISTRY);

/**
 * Type guard: is `value` an in-enum registry claim type (SDD §H/§P3 — the
 * constrained-generation membership predicate)? Pure. A `false` here is what
 * DROPS a model-proposed out-of-enum type (defense in depth) — the planner can
 * never free-generate a type past this gate.
 */
export function isRegistryClaimType(value: unknown): value is RegistryClaimType {
  return typeof value === "string" && REGISTRY_SET.has(value);
}

/**
 * The per-registry-type evidence + claim SCHEMA the planner parameterizes into a
 * `CandidateClaim.soundness` (`MinimalClaim`). Transcribed from the SDD §E
 * worked types (the §5 conjuncts each field feeds): ownership, freshness,
 * source-integrity floor, provenance, and (for actions) the `action_claim`
 * kind. The planner only SELECTS the type + binds runtime params (subject,
 * resources, value); the evidence SHAPE is fixed here — the model never authors
 * it (SDD §O#3 "no model-authored …"; the soundness predicate quantifies over
 * THIS typed structure, never prose — §R topology condition 2).
 */
interface RegistryClaimSpec {
  /** The §5 claim kind — drives C4 (`action_claim` ⟹ outcome-confirmed). */
  readonly kind: "read_claim" | "action_claim";
  /** The C2 source-integrity FLOOR this type's evidence must meet-or-exceed. */
  readonly minSourceIntegrity: EvidenceRequirement["sourceIntegrity"];
  /** The `∀ e ∈ requiredEvidence` set (C0 demands it be non-empty). */
  readonly requiredEvidence: readonly EvidenceRequirement[];
  /** The Q4 consistency partition key derivation: is this claim customer-scoped? */
  readonly customerScoped: boolean;
  /**
   * W6 falsifier-completeness (Plan 1 Phase 3; `@adjudicate/core` >= 1.8.0). When
   * `true`, this type has ENUMERATED every evidence that — if PRESENT this turn —
   * FALSIFIES the claim (the `falsifiers[]`), so the kernel's eligibility cap lets
   * it reach VALIDATED and the runtime arm (`resolveAgainstFalsifiers`) demotes it
   * to UNKNOWN when a falsifier actually fires. A type that cannot HONESTLY
   * enumerate its falsifiers MUST omit this (defaults to `false` → UNKNOWN-only);
   * declaring completeness without real falsifiers is the §R lying case (the kernel
   * hard-throws). Omitted ⟹ the type stays UNKNOWN-only under the pipeline (the
   * fail-safe default the SDD §Q scope guard prescribes for un-upgraded types).
   */
  readonly falsifierComplete?: boolean;
  /**
   * The W6 falsifiers (each an `EvidenceRequirement`): a DIFFERENT key whose
   * PRESENCE this turn contradicts the claim (e.g. STORE_OPEN_NOW ← a present
   * ScheduleOverride; PAYMENT_STATUS=paid ← a present refund/chargeback). Declared
   * iff `falsifierComplete` is `true`.
   */
  readonly falsifiers?: readonly EvidenceRequirement[];
  /**
   * The W6 C6 value-binding: bind the RENDERED `value` to a specific evidence
   * entry's value so the customer-visible number/string is LEDGER-SOURCED, never a
   * model confabulation that rode the surplus channel. `key` MUST be one of
   * {@link requiredEvidence} keys (the kernel hard-throws otherwise); `path`
   * projects the bound field on BOTH sides before the canonical `sameValue`
   * compare. Omitted ⟹ §5 stays value-agnostic for this type (no-op).
   */
  readonly valueBinding?: {
    readonly key: string;
    readonly path?: readonly (string | number)[];
  };
}

/**
 * The representative per-type registry schema (SDD §E worked types). Keyed by
 * the closed {@link RegistryClaimType}, so adding a type without its schema is a
 * compile error (`satisfies Record<RegistryClaimType, …>`) — the registry and
 * its evidence schema can never silently diverge.
 */
const REGISTRY_SPECS = {
  MENU_ITEM_ALLERGENS: {
    kind: "read_claim",
    // SDD §E: free-text "sem alérgenos" must fail → the floor is `structured`.
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "allergens",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "static",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
  },
  STORE_HOURS: {
    kind: "read_claim",
    minSourceIntegrity: "trusted_service",
    requiredEvidence: [
      {
        key: "store_hours",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: { kind: "cacheable", ttl: 3600 },
        sourceIntegrity: "trusted_service",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
  },
  // Triad slice (Plan 1 Phase 3) — STORE_OPEN_NOW is OVERRIDE-AWARE: the schedule
  // signal is the backing read, and a present ScheduleOverride FALSIFIES it (the
  // W6 cross-key runtime arm). The evidence key is aligned VERBATIM with the
  // investigator's `SCHEDULE_KEY` ("schedule:store_open_now", ibatexas-investigator.ts)
  // so the candidate validates against the actual recorded ledger entry.
  STORE_OPEN_NOW: {
    kind: "read_claim",
    minSourceIntegrity: "trusted_service",
    requiredEvidence: [
      {
        key: "schedule:store_open_now",
        ownershipPolicy: "not_applicable",
        // The schedule signal is read this turn from first-party config + cache;
        // a short cacheable ttl bounds staleness (mirrors STORE_HOURS posture).
        freshnessPolicy: { kind: "cacheable", ttl: 3600 },
        sourceIntegrity: "trusted_service",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
    // W6 — a present ScheduleOverride contradicts the computed open/closed signal.
    falsifierComplete: true,
    falsifiers: [
      {
        key: "schedule:schedule_override",
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "trusted_service",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — the rendered open/closed proposition is bound to the schedule signal's
    // `mealPeriod` field (the ScheduleSignal shape from @ibatexas/tools), so the
    // value is ledger-sourced, never model-authored.
    valueBinding: { key: "schedule:store_open_now", path: ["mealPeriod"] },
  },
  ORDER_FULFILLMENT_STAGE: {
    kind: "read_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "fulfillment_stage",
        // Customer-scoped — owner-scoped `getById` (SDD §E / §N P1).
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: true,
    // W6 — a present order CANCELLATION falsifies any in-progress fulfillment stage.
    falsifierComplete: true,
    falsifiers: [
      {
        key: "order_cancelled",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    // C6 — bind the rendered stage to the read's `stage` field (ledger-sourced).
    valueBinding: { key: "fulfillment_stage", path: ["stage"] },
  },
  PAYMENT_STATUS: {
    kind: "read_claim",
    minSourceIntegrity: "first_party_verified",
    requiredEvidence: [
      {
        key: "payment_status",
        // Ownership required via OrderProjection-join; first-party only money read.
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "first_party_verified",
        provenancePolicy: "first_party_only",
      },
    ],
    customerScoped: true,
    // W6 — a `paid` payment status is falsified by a present refund OR chargeback
    // (opposite money direction). BOTH are enumerated (honest completeness).
    falsifierComplete: true,
    falsifiers: [
      {
        key: "payment_refund",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "first_party_verified",
        provenancePolicy: "first_party_only",
      },
      {
        key: "payment_chargeback",
        ownershipPolicy: "required",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "first_party_verified",
        provenancePolicy: "first_party_only",
      },
    ],
    // C6 — bind the rendered status to the read's `status` field (ledger-sourced).
    valueBinding: { key: "payment_status", path: ["status"] },
  },
  PURCHASE_COMPLETED: {
    kind: "action_claim",
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key: "purchase_outcome",
        ownershipPolicy: "required",
        // Evidence = this turn's Action verdict + dispatch, not a read.
        freshnessPolicy: "action_outcome",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: true,
  },
} as const satisfies Record<RegistryClaimType, RegistryClaimSpec>;

/**
 * A model PROPOSAL of a claim, BEFORE the constrained-generation wall (SDD §H).
 * The model proposes a `type` (a free string — it may hallucinate one outside
 * the registry) plus runtime parameters. `selectCandidateClaim` is what
 * constrains it: only an in-enum `type` becomes a typed `CandidateClaim`.
 */
export interface ProposedClaim {
  /** The model-proposed claim type name — UNVALIDATED (may be out-of-enum). */
  readonly type: string;
  /** The same-subject partition key (e.g. an order id, a menu-item handle). */
  readonly subject: string;
  /** The kernel-abstract actor the §5 `owns(actor, resource)` check is about. */
  readonly actor: unknown;
  /** Per-evidence-`key` → resource bindings for the C1 ownership check. */
  readonly resources?: Readonly<Record<string, unknown>>;
  /** The domain proposition the renderer would fill from this claim. */
  readonly value: unknown;
}

/**
 * The PRE-planning constrained-generation wall (SDD §H · §P3; claim-registry
 * v0.1 §1). Select-and-parameterize: a model `ProposedClaim` becomes a typed
 * `@adjudicate/core` `CandidateClaim` IFF its `type` is in the registry enum;
 * otherwise `undefined` (the proposal is DROPPED — the model can never
 * free-generate a type, exactly as a hallucinated `express_intent.capability`
 * is dropped by the planner's `allowedIntents` guard).
 *
 * Parameterization binds the model's runtime params (subject/actor/resources/
 * value) into the registry type's FIXED evidence schema — the model authors the
 * params, NEVER the evidence/soundness shape (SDD §E; §O#3). The produced
 * `CandidateClaim` matches the linked kernel input verbatim, so the downstream
 * `runClaimsKernel` (Q6a) consumes it. Pure.
 */
export function selectCandidateClaim(
  proposed: ProposedClaim,
): CandidateClaim | undefined {
  if (!isRegistryClaimType(proposed.type)) {
    // Defense in depth: a type outside the closed registry is NOT emitted as a
    // candidate. This is the constrained-generation guard (SDD §H/§P3) — drop,
    // never free-generate.
    return undefined;
  }
  // Widen the `as const` literal member to the interface so the OPTIONAL W6
  // fields (falsifierComplete / falsifiers / valueBinding) are readable on every
  // member (a member that omits them is `undefined`, not a missing property).
  const spec: RegistryClaimSpec = REGISTRY_SPECS[proposed.type];
  return {
    soundness: {
      requiredEvidence: spec.requiredEvidence,
      minSourceIntegrity: spec.minSourceIntegrity,
      kind: spec.kind,
      actor: proposed.actor,
      ...(proposed.resources === undefined
        ? {}
        : { resources: proposed.resources }),
      // W6 falsifier-completeness (Plan 1 Phase 3) — threaded from the type's
      // FIXED spec, NEVER model-authored: the eligibility cap + the runtime arm
      // (resolveAgainstFalsifiers) live in the kernel. A type with no declared
      // falsifiers stays UNKNOWN-only (the fail-safe default).
      ...(spec.falsifierComplete === true
        ? { falsifierComplete: true, falsifiers: spec.falsifiers ?? [] }
        : {}),
      // W6 C6 value-binding — bind the rendered value to its licensing ledger
      // entry (also FIXED per type; the model never authors the binding).
      ...(spec.valueBinding === undefined
        ? {}
        : { valueBinding: spec.valueBinding }),
    },
    // Customer-scoped types partition by their owner-bound subject; the subject
    // is the Q4 same-subject consistency key (SDD §D).
    subject: proposed.subject,
    type: proposed.type,
    value: proposed.value,
  };
}

/**
 * Run the constrained-generation wall over a batch of model proposals (SDD §H).
 * Returns the typed candidates that PASSED the enum constraint plus the names
 * of the proposals that were DROPPED (recorded for the planner rationale +
 * telemetry, mirroring the planner's `dropped` list for out-of-plan
 * capabilities). Pure.
 */
export function constrainClaimGeneration(
  proposals: readonly ProposedClaim[],
): { readonly candidates: CandidateClaim[]; readonly dropped: string[] } {
  const candidates: CandidateClaim[] = [];
  const dropped: string[] = [];
  for (const p of proposals) {
    const candidate = selectCandidateClaim(p);
    if (candidate === undefined) {
      dropped.push(p.type);
    } else {
      candidates.push(candidate);
    }
  }
  return { candidates, dropped };
}

/**
 * One meaningful component of the request the P4 completeness post-check
 * quantifies over (SDD §C P4; §J.8). The span-segmenter (SDD §O#8 — itself a
 * bounded probabilistic input) yields these; `checkCompleteness` is the
 * DETERMINISTIC net that guarantees none silently disappears.
 */
export interface RequestSpan {
  /** The raw request fragment (an interrogative or imperative component). */
  readonly text: string;
  /**
   * The registry claim type the planner MAPPED this span to — or `undefined`
   * for an UNMAPPED span (the model proposed nothing for it). An unmapped span
   * must surface, never drop (SDD §J.8).
   */
  readonly mappedClaimType?: string;
}

/**
 * The P4 disposition of one request span (SDD §C P4; §I). Every span gets
 * exactly one — none silently disappears:
 *
 *   - a typed `RegistryClaimType` — the span MAPPED to an in-enum claim;
 *   - `"UNKNOWN"`  — mapped but honest-ignorance (the §I claim/turn outcome);
 *   - `"ESCALATE"` — routed to a human (a first-class terminal);
 *   - `"CLARIFY"`  — an UNMAPPED span (SDD §J.8: never a silent drop) OR an
 *                    out-of-enum mapping (defense in depth — an unrecognized
 *                    mapped type is not silently honored).
 */
export type SpanDisposition =
  | RegistryClaimType
  | Extract<TurnTerminal, "UNKNOWN" | "ESCALATE" | "CLARIFY">;

/** One span paired with its deterministic P4 disposition (SDD §C P4 / §J.8). */
export interface SpanCompleteness {
  readonly text: string;
  readonly disposition: SpanDisposition;
}

/**
 * The POST-planning completeness wall (SDD §C P4 · Inv 8; §J.8). Maps EVERY
 * request span to a disposition so no meaningful component silently disappears.
 * An UNMAPPED span (`mappedClaimType === undefined`) → `CLARIFY` (SDD §J.8:
 * "an unmapped span forces CLARIFY, never a silent drop"). A span mapped to a
 * type OUTSIDE the registry enum also → `CLARIFY` (defense in depth — a
 * hallucinated mapped type is not silently honored as a claim).
 *
 * This is one of the two genuinely data-independent nets (SDD §H honesty
 * correction): it is structural over the candidate SET, not a probabilistic
 * re-classification. Pure.
 */
export function checkCompleteness(
  spans: readonly RequestSpan[],
): SpanCompleteness[] {
  return spans.map((span) => {
    if (span.mappedClaimType === undefined) {
      // SDD §J.8 — an unmapped span is surfaced as CLARIFY, never dropped.
      return { text: span.text, disposition: "CLARIFY" };
    }
    if (!isRegistryClaimType(span.mappedClaimType)) {
      // Defense in depth: a mapped-but-out-of-enum type is not silently honored.
      return { text: span.text, disposition: "CLARIFY" };
    }
    return { text: span.text, disposition: span.mappedClaimType };
  });
}

/**
 * Has the P4 check left any span UNRESOLVED in a way the turn must surface
 * (SDD §C P4)? `true` iff some span's disposition is `CLARIFY` — i.e. the turn
 * cannot silently render only the mapped claims; it must ask the customer to
 * disambiguate (a first-class terminal — SDD §I). Pure.
 */
export function hasUnmappedSpan(completeness: readonly SpanCompleteness[]): boolean {
  return completeness.some((s) => s.disposition === "CLARIFY");
}

/**
 * The CLOSED safety-marker taxonomy (SDD §O#9; §O#8; Inv 8). The set of
 * health/safety markers that have a RECOGNIZED, modeled routing. Closed by
 * construction — anything NOT in this set is, by definition, unrecognized and
 * routes to the generic safe terminal (`ESCALATE`). REPRESENTATIVE (SDD §Q
 * scope guard); the full adversarial marker taxonomy is the deferred follow-on.
 *
 * NOTE (SDD §O#9): `harassment` and `medical-emergency` have NO typed terminal
 * yet, so they are DELIBERATELY ABSENT from this recognized set — they fall
 * through to the `ESCALATE` default, which is exactly the spec's instruction
 * ("route to ESCALATE"). A recognized NON-safety request (no marker) is not
 * over-escalated.
 */
const RECOGNIZED_SAFETY_MARKERS: ReadonlySet<string> = new Set<string>([
  // Recognized, modeled safety markers with a known conservative routing. Kept
  // representative; each still routes to ESCALATE here (no non-escalate typed
  // terminal exists yet), but membership documents that the taxonomy KNOWS them
  // — the point of §O#9 is that an UNKNOWN marker is not treated as ordinary.
  "allergen-severe-reaction",
  "foodborne-illness",
]);

/** A claim a safety request may carry past routing (when no marker fires). */
export interface SafetyRoutingInput {
  /**
   * The safety markers the detector (SDD §O#8 — a bounded probabilistic input)
   * flagged on the request. EMPTY for an ordinary, non-safety request.
   */
  readonly markers: readonly string[];
}

/**
 * The §O#9 closed-taxonomy safety router (SDD §O#9 · Inv 8; §8). Closed by
 * construction: if ANY flagged marker is unrecognized (not in the closed
 * {@link RECOGNIZED_SAFETY_MARKERS}), or any recognized marker fired, the turn
 * routes to `ESCALATE` — the generic safe terminal. It NEVER passes an
 * unrecognized health/safety framing through as ordinary text (the §O#9
 * NEW_HOLE: "default-to-safe on any unrecognized health/safety marker").
 *
 *   - markers `[]`                      → `undefined` (NOT over-escalated — an
 *                                          ordinary request proceeds normally).
 *   - any recognized OR unrecognized marker present → `"ESCALATE"`.
 *
 * Because the taxonomy is closed, an attacker-crafted novel marker string is
 * unrecognized → `ESCALATE` by default — there is no pass-through escape. Pure;
 * returns the forced turn terminal (or `undefined` when nothing is flagged).
 */
export function routeSafety(
  input: SafetyRoutingInput,
): Extract<TurnTerminal, "ESCALATE"> | undefined {
  if (input.markers.length === 0) {
    // Ordinary, non-safety request — no marker flagged → not over-escalated.
    return undefined;
  }
  // Any flagged marker — recognized or not — routes to the safe terminal. The
  // closed-by-construction default: an UNRECOGNIZED marker is ESCALATE, never
  // pass-through. (Recognized markers also ESCALATE today — there is no
  // non-escalate typed terminal yet; SDD §O#9 harassment/medical-emergency.)
  for (const marker of input.markers) {
    if (!RECOGNIZED_SAFETY_MARKERS.has(marker)) {
      // The unrecognized-marker default — the §O#9 NEW_HOLE close.
      return "ESCALATE";
    }
  }
  // All flagged markers are recognized safety markers — still ESCALATE (the
  // conservative safe terminal; no typed non-escalate terminal exists yet).
  return "ESCALATE";
}
