/**
 * @ibatexas/pack-ops — CapabilityPlanner + ToolClassification.
 *
 * Per-state tool/intent visibility for the ops plane. The LLM never sees
 * MUTATING tools (CLAUDE.md rule #9); MUTATING calls are captured as
 * `IntentEnvelope`s and adjudicated by the kernel.
 *
 * `product.availability.set` is advertised as an `allowedIntent` ONLY on a
 * STAFF session (`ctx.staffId` present) — the ops persona. It is NEVER a
 * customer/LLM chat verb, so it is deliberately absent from
 * `CHAT_DRIVABLE_TOOL_KINDS` and has no registered chat tool (it shows up as
 * advertised-but-unregistered under the `staff` roster-drift probe, which the
 * `ADVERTISED_NOT_REGISTERED_WHITELIST` documents).
 *
 * `order.note.add` (NEW-032 verbs-v2) is ALSO advertised on a staff session,
 * but the kind is OWNED by `@ibatexas/pack-orders`, not this pack — advertising
 * it here only widens the ops-plane allowlist so the ops persona can propose it;
 * adjudication routes to pack-orders' composed bundle. Unlike
 * `product.availability.set`, `order.note.add` IS a registered chat tool, so it
 * needs no `ADVERTISED_NOT_REGISTERED_WHITELIST` entry (advertised ⊆ registered
 * holds). See {@link OPS_FOREIGN_ADVERTISED_KIND}.
 *
 * `ops_snapshot` (NEW-032 slice B) is the ONE LLM-visible READ tool — the
 * situational snapshot (alerts + incidents + kitchen + caixa). It is advertised
 * ONLY on a STAFF session (`ctx.staffId` present); non-staff sessions get an
 * empty `visibleReadTools`. Its executor is registered on BOTH the ops conductor
 * plane (where it is reachable) AND the chat plane's read-tool map (never
 * advertised there — the chat planner pins `staffId:null` — but registered so
 * the fail-closed `readToolRosterDrift` boot gate's STAFF probe stays green).
 */

import {
  filterReadOnly,
  safePlan,
  type CapabilityPlanner,
  type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm"
import type { OpsContext, OpsState } from "./types.js"

/** The situational-snapshot READ tool name (NEW-032 slice B). */
export const OPS_SNAPSHOT_READ_TOOL = "ops_snapshot"

/**
 * The foreign-owned kind the ops plane ADVERTISES but pack-orders OWNS.
 *
 * `order.note.add` is declared by `@ibatexas/pack-orders` (its `intents`), NOT
 * by this pack — advertising it here only widens the OPS-PLANE ALLOWLIST so the
 * ops persona can propose "adiciona uma nota no pedido X". Adjudication still
 * routes to the composed pack-orders bundle (carrying the prepended
 * `staffRoleGuard`; matrix row {OWNER,MANAGER,ATTENDANT}) because
 * `composePolicyRouter`'s `indexByKind` keys on `pack.intents` (OWNERSHIP), and
 * this pack does NOT own the kind — so no composition collision. The ops tool
 * registry already registers its `writeAdjudicatedNote`-backed executor.
 *
 * Advertisement is a PLANNER concern, ownership is a PACK-`intents` concern —
 * they are deliberately decoupled here (see NEW-032 ops-actor-surface.md §4).
 *
 * ── Why `order.status.transition` ("avança o pedido X") is NOT advertised here ─
 * NEW-032 verbs-v2 also considered the kitchen-advance verb. It is DEFERRED on a
 * guard-parity finding: neither the composed pack-orders bundle NOR the
 * domain-internal `orderProjectionPolicyBundle` gates transition LEGALITY, PONR,
 * optimistic-concurrency, or TERMINAL states at the KERNEL. For
 * `order.status.transition`, pack-orders' bundle engages only
 * `requireOrderIdForMutation` (state) + `staffRoleGuard` (auth) + `executeW5Kinds`
 * (business EXECUTE) — packages/pack-orders/src/policies.ts:377,889,893 — and the
 * projection bundle engages only `requireProjectionExists` + `executeAll`
 * (packages/domain/src/services/__shared__/order-projection-policy.ts:179,264).
 * BOTH defer transition validity to the imperative executor `executeTransition`
 * (packages/domain/src/services/order-command.service.ts:398-410), which THROWS
 * `ProjectionNotFoundError` / `ConcurrencyError` / `InvalidTransitionError` INSIDE
 * the DB transaction — NOT via a kernel Decision. Advertising the verb would put
 * an LLM-proposed kitchen-advance behind a kernel that returns EXECUTE for an
 * ILLEGAL transition (e.g. delivered→preparing) and relies on an executor
 * exception for safety. Closing this gap needs a NEW kernel-level
 * transition-legality guard in pack-orders (net-new authorship on a
 * security-critical verb), which belongs in its own focused PR — see the PR body
 * parity table + the NEW-032 tracker row for the deferral.
 */
export const OPS_FOREIGN_ADVERTISED_KIND = "order.note.add"

/**
 * Ops-domain tool classification. `product.availability.set` (owned) and
 * `order.note.add` (foreign-owned; advertised to widen the ops allowlist) are
 * MUTATING; `ops_snapshot` is the LLM-visible READ tool (staff-only
 * advertisement). `safePlan` asserts no MUTATING name ever leaks into
 * `visibleReadTools`.
 */
export const OPS_TOOLS: ToolClassification = {
  READ_ONLY: new Set<string>([OPS_SNAPSHOT_READ_TOOL]),
  MUTATING: new Set<string>([
    "product.availability.set",
    OPS_FOREIGN_ADVERTISED_KIND,
  ]),
}

// ── Planner implementation ──────────────────────────────────────────────────

/**
 * Default planner the Pack ships. Advertises the ops verb ONLY on a staff
 * session; every non-staff (customer / LLM / unauthenticated) session gets an
 * empty `allowedIntents`. Mirrors `pack-reservations`' staff-gated planner.
 */
const rawOpsCapabilityPlanner: CapabilityPlanner<OpsState, OpsContext> = {
  plan(state, context): Plan {
    // `context` is required by the contract but not inspected — the staff
    // gate reads the projected session state, like the other packs.
    void context
    // Collapse an absent (undefined) staffId to null so BOTH null and
    // undefined mean "not a staff session".
    const staffId = state.ctx.staffId ?? null
    const isStaffSession = staffId !== null
    // `string[]` (not `OpsIntentKind[]`) because the allowlist deliberately
    // spans this pack's OWNED kind (`product.availability.set`) AND a
    // foreign-owned one (`order.note.add`, owned by pack-orders — advertised
    // here only to widen the ops-plane allowlist; see OPS_FOREIGN_ADVERTISED_KIND).
    const allowedIntents: string[] = isStaffSession
      ? ["product.availability.set", OPS_FOREIGN_ADVERTISED_KIND]
      : []
    // `ops_snapshot` is advertised ONLY to a staff session; `filterReadOnly`
    // re-asserts it is a READ_ONLY name (never a MUTATING leak). Non-staff → [].
    return {
      visibleReadTools: isStaffSession
        ? filterReadOnly(OPS_TOOLS, [OPS_SNAPSHOT_READ_TOOL])
        : filterReadOnly(OPS_TOOLS, []),
      allowedIntents,
    }
  },
}

/**
 * Wrapped via `safePlan` — every `plan()` invocation is asserted against
 * `OPS_TOOLS` so a future regression that adds a MUTATING tool name to
 * `visibleReadTools` throws `PlanConformanceError` at boot. Mirrors
 * `pack-orders` (`ORDER_TOOLS`) / `pack-reservations` (`RESERVATION_TOOLS`).
 */
export const opsCapabilityPlanner: CapabilityPlanner<OpsState, OpsContext> =
  safePlan(rawOpsCapabilityPlanner, OPS_TOOLS)
