/**
 * `CapabilityDefinition` — FE-4.1 EXPAND (FE-T19).
 *
 * A single per-capability, hand-authored DATA object describing an
 * IbateXas capability (== a Pack-owned `IntentEnvelope.kind`). This is the
 * EXPAND step of the FE-4 EXPAND → MIGRATE → CONTRACT consolidation
 * (`~/projects/IBX_LANGUAGE_ENGINE_SPEC.md` §"FE-4 — Capability metadata
 * consolidation"): the ~16 hand-maintained lists it will eventually
 * replace (`KNOWN_INTENT_KINDS`, `CHAT_DRIVABLE_TOOL_KINDS`,
 * `CLAIM_REGISTRY`, `SUCCESS_CLAIM_CLASSES`, per-pack `ToolClassification` /
 * `*_TOOL_TO_INTENT`, `ADVERTISED_NOT_REGISTERED_WHITELIST`, …) REMAIN
 * authoritative today. Nothing here is consumed by production code yet —
 * see `../index.ts` for the boot-time self-check and
 * `generate-chat-drivable-tool-kinds.ts` for the one exemplar projection
 * that proves the mechanism.
 *
 * Per FE-4.1/P5 (frozen principle — "guards IMPLEMENT policy, metadata
 * DESCRIBES capabilities"): every field here is DATA or a DECLARATIVE
 * reference to hand-authored code. Nothing here re-implements a guard
 * predicate, a planner gate, or a claim-validation rule.
 */

import type { GuardPhase } from "@adjudicate/core/kernel"

// Re-exported so consumers of this module never need their own import of
// `@adjudicate/core/kernel` just to spell the phase union.
export type { GuardPhase }

/**
 * The six first-party Pack ids, exactly as declared on each `PackV0.id`
 * (pinned by `packages/packs-composed/src/__tests__/composition.test.ts`).
 * A literal union (not `(typeof IBATEXAS_COMPOSED_PACKS)[number]["id"]`)
 * so this module has zero import-time dependency on the composed-pack
 * array — only `guard-resolution.ts` needs the live pack objects.
 */
export type CapabilityPackId =
  | "ibatexas/pack-orders"
  | "ibatexas/pack-payments"
  | "ibatexas/pack-reservations"
  | "ibatexas/pack-customer-onboarding"
  | "ibatexas/pack-whatsapp"
  | "ibatexas/pack-ops"

/**
 * The plane(s) a capability is reachable from. Modeled as DATA (FE-4.1 —
 * "surfaces … is modeled as data") rather than as separate hand-maintained
 * roster arrays per plane. `"chat"` mirrors `CHAT_DRIVABLE_TOOL_KINDS`;
 * `"staff"` / `"ops"` mirror the staff-chat and OPS-conductor planes probed
 * by `ROSTER_DRIFT_CONTEXTS` / `opsPlaneDriftProblems`; `"system"` mirrors
 * webhook/cron/subscriber-only kinds no interactive persona ever proposes.
 */
export type CapabilitySurface = "chat" | "staff" | "ops" | "system"

/**
 * Auth level, per `docs/architecture/design/agent-tools.md` §"Auth levels".
 * `"guest"` — no authentication required. `"customer"` — Twilio Verify
 * WhatsApp OTP (Hard Rule #5). `"staff"` — internal/admin only. `"system"` —
 * SYSTEM-actor-only (subscribers/cron/webhooks); never customer- or
 * staff-proposable.
 */
export type CapabilityAuthLevel = "guest" | "customer" | "staff" | "system"

/**
 * A declarative pointer at one hand-authored kernel guard, scoped to the
 * `PolicyBundle` phase it runs in. `name` MUST equal the guard's resolvable
 * identity per `guard-resolution.ts` (its attached `GuardMetadata.name` when
 * `nameGuard`-wrapped, else its `Function.name`) — never an invented label.
 * The boot assertion in `../index.ts` is the enforcement mechanism; this
 * type only carries the shape.
 *
 * Scope note: `phase` excludes `"taint"` in practice (the core `GuardPhase`
 * union includes it for `GuardFireStats` symmetry, but a Pack's `taint`
 * slot is a single `TaintPolicy` value, not a `Guard[]` array — there is
 * nothing here to reference by name). No authored instance below emits a
 * `"taint"` guard-ref.
 */
export interface CapabilityGuardRef {
  readonly phase: GuardPhase
  readonly name: string
}

/**
 * One capability's authored metadata. See the module doc for what "data
 * only" means and why every field either IS data or POINTS AT hand-authored
 * code rather than reimplementing it.
 */
export interface CapabilityDefinition {
  /** Canonical intent kind — `IntentEnvelope.kind`, e.g. `"order.cart.ensure"`. */
  readonly kind: string
  /** Owning first-party Pack id. */
  readonly pack: CapabilityPackId
  /**
   * Whether this capability mutates state. `true` for every instance
   * authored in this EXPAND pass — all 18 are drawn from
   * `CHAT_DRIVABLE_TOOL_KINDS`, which is itself the MUTATING roster
   * (`register-ibatexas-tool-packs.ts` module doc: "the full LLM-callable
   * MUTATING tool roster"). Kept as an explicit field (not inferred from
   * membership in this list) because a future non-mutating capability
   * (e.g. a promoted read-only tool) needs somewhere to say `false`.
   */
  readonly mutating: boolean
  /** Plane(s) this capability is reachable from. See {@link CapabilitySurface}. */
  readonly surfaces: readonly CapabilitySurface[]
  /** Minimum auth level required to propose this capability. */
  readonly auth: CapabilityAuthLevel
  /**
   * Historical/legacy tool name(s) this capability was or is still
   * addressed by outside the `capability === intentKind` convention (RC-A1
   * Phase A) — e.g. `"add_to_cart"` for `order.item.add`. Empty when the
   * capability has no legacy tool-name history.
   */
  readonly legacyNames: readonly string[]
  /** pt-BR description (Hard Rule #4). Single-sourced from
   *  `IBATEXAS_CAPABILITY_DESCRIPTIONS` where the capability has a
   *  registered chat tool. */
  readonly description: string
  /**
   * FORWARD-DECLARED (FE-1 track) — the per-capability extraction schema.
   * Left `undefined` for every instance authored in this EXPAND step; FE-1
   * populates it incrementally in a LATER ticket. MUST NOT gate anything —
   * see the freshness-gate test's explicit assertion that this field is
   * absent from and irrelevant to the exemplar projection.
   */
  readonly extractionSchema?: unknown
  /**
   * The `SUCCESS_CLAIM_CLASSES` ids (`apps/api/src/claustrum/
   * ibatexas-responder.ts`) this capability's EXECUTE can justify. Inverted
   * from that registry's own `justifiedBy` arrays — NOT invented, and NOT
   * lossy: reality is 1:many (e.g. `order.checkout.create` co-justifies
   * `"order-placed"`, `"purchase-completed"`, AND `"pix-generated"` — three
   * separate classes list it in `justifiedBy`), so this is the FULL set,
   * not a single "primary" pick. `undefined` is a normal, common, and
   * CORRECT value: the live claim registry covers only "a handful of
   * proposable types" (per FE-4 Out-of-Scope — growing it is a separate
   * claims-runtime workstream), so most capabilities legitimately have no
   * claim link yet.
   */
  readonly successClaimLinks?: readonly string[]
  /**
   * Declarative guard references — see {@link CapabilityGuardRef}. Per
   * capability, this is the OWNING PACK's full `stateGuards` /
   * `authGuards` / `business` guard-name list, in bundle order. This is
   * kernel-FAITHFUL, not a simplification: each `Guard` returns
   * `Decision | null` and the kernel evaluates every phase-array entry for
   * every kind the Pack owns — the guard's OWN body decides whether it has
   * an opinion on this particular `kind` (`PolicyBundle` doc: "`null` means
   * this guard has no opinion — continue evaluating"). Hand-picking a
   * PER-KIND subset here would require re-deriving each guard's internal
   * `envelope.kind` predicate into metadata — exactly the P5-forbidden
   * "generate guard bodies" move, and a second driftable source of "which
   * guards apply to which kind" that would itself need its own freshness
   * gate. The pack-wide list needs none: it is definitionally correct by
   * construction.
   */
  readonly guardRefs: readonly CapabilityGuardRef[]
  /**
   * The pack-level default-deny basis code this capability falls through
   * to when no guard in its chain reaches a terminal EXECUTE / CONFIRM /
   * ESCALATE / DEFER (each Pack's `PolicyBundle.default: "REFUSE"` +
   * its `basisCodes` roster, e.g. `"order.default.deny"`). This is the
   * FLOOR code, not an exhaustive enumeration of every refusal this
   * capability's guard chain can produce — per-guard refusal codes are
   * business logic (P5) and stay hand-authored in each pack's
   * `refusals.ts`, never re-derived into metadata.
   */
  readonly refusalCode: string
}
