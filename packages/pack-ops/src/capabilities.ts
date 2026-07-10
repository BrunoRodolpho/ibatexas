/**
 * @ibatexas/pack-ops — CapabilityPlanner + ToolClassification.
 *
 * Per-state tool/intent visibility for the ops plane. The LLM never sees
 * MUTATING tools (CLAUDE.md rule #9); MUTATING calls are captured as
 * `IntentEnvelope`s and adjudicated by the kernel.
 *
 * `product.availability.set` and `product.price.set` (NEW-004) are advertised as
 * `allowedIntent`s ONLY on a STAFF session (`ctx.staffId` present) — the ops
 * persona. Neither is EVER a customer/LLM chat verb, so both are deliberately
 * absent from `CHAT_DRIVABLE_TOOL_KINDS` and have no registered chat tool (they
 * show up as advertised-but-unregistered under the `staff` roster-drift probe,
 * which the `ADVERTISED_NOT_REGISTERED_WHITELIST` documents). `product.price.set`
 * is REVERSIBLE, so it stays IN the WhatsApp verb scope (NOT in
 * `WA_EXCLUDED_OPS_KINDS`); its UNTRUSTED-taint CONFIRM parks/resumes on both
 * ingresses.
 *
 * `order.note.add` (NEW-032 verbs-v2) and `order.status.transition` (BKL-090,
 * the kitchen-advance verb) are ALSO advertised on a staff session, but those
 * kinds are OWNED by `@ibatexas/pack-orders`, not this pack; `payment.refund.issue`
 * (BKL-085, the refunds-by-message verb) is likewise advertised here but OWNED by
 * `@ibatexas/pack-payments` — advertising them here only widens the ops-plane
 * allowlist so the ops persona can propose them; adjudication routes to the owning
 * pack's composed bundle (which carries the `staffRoleGuard` AND, for the
 * transition, the BKL-090 legality guard; for the refund, the magnitude ladder +
 * BKL-085 UNTRUSTED-taint CONFIRM overlay). Unlike `product.availability.set`, all
 * three are registered ops tools, so the ops-plane drift gate holds (advertised ⊆
 * registered); on the CHAT roster they are advertised-but-unregistered (no chat
 * tool), documented by `ADVERTISED_NOT_REGISTERED_WHITELIST` entries. See
 * {@link OPS_FOREIGN_ADVERTISED_KIND}, {@link OPS_FOREIGN_ADVERTISED_TRANSITION_KIND},
 * and {@link OPS_FOREIGN_ADVERTISED_REFUND_KIND}.
 *
 * `ops_snapshot` (NEW-032 slice B) and `ops_sales_analytics` (NEW-012) are the
 * LLM-visible READ tools — the situational snapshot (alerts + incidents +
 * kitchen + caixa) and today's sales analytics (orders/revenue/AOV + carts + new
 * customers + WA funnel). Both are advertised ONLY on a STAFF session
 * (`ctx.staffId` present); non-staff sessions get an empty `visibleReadTools`.
 * Each executor is registered on BOTH the ops conductor plane (where it is
 * reachable) AND the chat plane's read-tool map (never advertised there — the
 * chat planner pins `staffId:null` — but registered so the fail-closed
 * `readToolRosterDrift` boot gate's STAFF probe stays green). Reading sales is
 * reversible/read-only, so `ops_sales_analytics` stays in ALL ingress scopes
 * (incl. WhatsApp — reading sales over WA is desirable).
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

/** The sales-analytics READ tool name (NEW-012). */
export const OPS_SALES_ANALYTICS_READ_TOOL = "ops_sales_analytics"

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
 * ── `order.status.transition` ("avança o pedido X") — DEFERRAL RESOLVED (BKL-090) ─
 * The kitchen-advance verb was previously DEFERRED on a guard-parity finding:
 * neither this pack's composed pack-orders bundle NOR the domain-internal
 * `orderProjectionPolicyBundle` gated transition LEGALITY / TERMINAL state at the
 * KERNEL — BOTH deferred validity to the imperative executor `executeTransition`
 * (order-command.service.ts), which THROWS `InvalidTransitionError` INSIDE the DB
 * transaction (an exception, not a kernel Decision). Advertising the verb then
 * would have put an LLM-proposed kitchen-advance behind a kernel that returned
 * EXECUTE for an ILLEGAL transition (e.g. delivered→preparing).
 *
 * BKL-090 CLOSES that gap: pack-orders now carries a STATE-phase
 * `requireLegalStatusTransition` guard (packages/pack-orders/src/policies.ts)
 * that REFUSEs an illegal/terminal/unknown-status transition at the kernel on the
 * composed (ops/staff) path BEFORE EXECUTE, reusing the `canTransition` /
 * `isTerminalOrderStatus` table from `@ibatexas/types` (single source of truth;
 * the executor's `canTransition` throw REMAINS as the last transactional line for
 * concurrency/atomicity). So the verb is now SOUND to advertise — see
 * {@link OPS_FOREIGN_ADVERTISED_TRANSITION_KIND}. (The domain command-service
 * path keeps its executor-throw contract untouched; only the composed ops path is
 * gated at the kernel — the LLM-proposed surface this deferral was about.)
 */
export const OPS_FOREIGN_ADVERTISED_KIND = "order.note.add"

/**
 * The SECOND foreign-owned kind the ops plane advertises but pack-orders OWNS:
 * `order.status.transition` (the kitchen-advance verb "avança o pedido X"),
 * unblocked by BKL-090's kernel legality guard (see {@link OPS_FOREIGN_ADVERTISED_KIND}).
 *
 * Same decoupling as `order.note.add`: advertising it here only widens the
 * OPS-PLANE ALLOWLIST so the ops persona can propose it; adjudication routes to
 * pack-orders' composed bundle (carrying the prepended `staffRoleGuard` — matrix
 * row {OWNER,MANAGER,ATTENDANT} — AND the BKL-090 `requireLegalStatusTransition`
 * guard). The ops resolver projects the CURRENT `fulfillmentStatus` into the
 * pack-orders `OrderState` so the legality guard adjudicates real state; a missing
 * order yields `orderId:null` ⇒ `requireOrderIdForMutation` REFUSEs `no_order`.
 * The ops tool registry registers a `writeAdjudicatedStatusTransition`-backed
 * executor (the POST-adjudication write).
 */
export const OPS_FOREIGN_ADVERTISED_TRANSITION_KIND = "order.status.transition"

/**
 * The THIRD foreign-owned kind the ops plane advertises but `@ibatexas/pack-
 * payments` OWNS: `payment.refund.issue` (the refunds-by-message verb "reembolsa
 * 50 do pedido 4242"), unblocked by BKL-085's UNTRUSTED-taint refund CONFIRM
 * overlay + the ops confirm-resume driver.
 *
 * Same decoupling as `order.note.add` / `order.status.transition`: advertising it
 * here only widens the OPS-PLANE ALLOWLIST so the ops persona can propose it;
 * adjudication routes to pack-payments' composed bundle (carrying the prepended
 * `staffRoleGuard` — matrix row {OWNER,MANAGER} — AND the refund magnitude ladder
 * with the BKL-085 overlay: a model-parsed UNTRUSTED refund ALWAYS parks for
 * confirmation; a ≥R$1000 one ESCALATEs). The ops resolver STAMPS the balance
 * fields + paymentId from the DB payment row so the model controls only {order
 * ref, amount, reason}; the ops tool registry registers a
 * `writeAdjudicatedRefund`-backed executor (the POST-adjudication ledger write +
 * the `payment.status_changed` emission). Like the other two foreign kinds it is a
 * STAFF/OPS-plane verb with NO registered CHAT tool — an
 * `ADVERTISED_NOT_REGISTERED_WHITELIST` entry (`staff:payment.refund.issue`)
 * documents the expected chat-roster gap; the ops-plane drift parity gate
 * (`opsPlaneDriftProblems`) verifies it IS registered on the OPS registry.
 */
export const OPS_FOREIGN_ADVERTISED_REFUND_KIND = "payment.refund.issue"

/**
 * BKL-088 — the two OWNED staff-plane RESOLUTION verbs. Unlike the three
 * foreign-owned kinds above (owned by pack-orders / pack-payments, advertised
 * here only to widen the allowlist), these are OWNED by `@ibatexas/pack-ops`
 * (in `opsPack.intents`) and adjudicated by THIS pack's bundle. Their executors
 * then drive the SAME-named SYSTEM domain write layer
 * (`ops.alert.resolve` / `incident.ticket.close`) — the D10 two-layer posture,
 * hence the DISTINCT `*.staff` names (see types.ts header). Both are STAFF/OPS-
 * plane verbs with NO registered CHAT tool, so under the chat "staff" roster
 * probe they are advertised-but-unregistered — `ADVERTISED_NOT_REGISTERED_WHITELIST`
 * documents that (staff:ops.alert.resolve.staff / staff:incident.ticket.close.staff).
 */
export const OPS_ALERT_RESOLVE_STAFF_KIND = "ops.alert.resolve.staff"
export const OPS_INCIDENT_CLOSE_STAFF_KIND = "incident.ticket.close.staff"

/**
 * SCN-127 — the OWNED schedule-override verb ("fecha amanhã" / "amanhã abrimos só
 * às 18h"). OWNED by this pack (in `opsPack.intents`) and adjudicated by THIS
 * pack's bundle; its executor drives the SAME `scheduleService.upsertOverride` the
 * admin schedule route uses (a domain-service verb, like the BKL-088 resolution
 * verbs — NO Medusa egress). REVERSIBLE + non-money, so it stays IN the WhatsApp
 * verb scope (NOT in `WA_EXCLUDED_OPS_KINDS`). Like the other OWNED ops verbs it is
 * a STAFF/OPS-plane verb with NO registered CHAT tool — an
 * `ADVERTISED_NOT_REGISTERED_WHITELIST` entry (`staff:schedule.override.set`)
 * documents that; the ops-plane drift gate verifies it IS registered on the OPS
 * registry.
 */
export const OPS_SCHEDULE_OVERRIDE_SET_KIND = "schedule.override.set"

/**
 * Ops-domain tool classification. The OWNED mutating verbs
 * (`product.availability.set`, `product.price.set` (NEW-004),
 * `ops.alert.resolve.staff`, `incident.ticket.close.staff`) and the three
 * foreign-owned kinds (advertised to widen the ops allowlist) are MUTATING;
 * `ops_snapshot` + `ops_sales_analytics` are the LLM-visible READ tools (staff-
 * only advertisement). `safePlan` asserts no MUTATING name ever leaks into
 * `visibleReadTools`.
 */
export const OPS_TOOLS: ToolClassification = {
  READ_ONLY: new Set<string>([
    OPS_SNAPSHOT_READ_TOOL,
    OPS_SALES_ANALYTICS_READ_TOOL,
  ]),
  MUTATING: new Set<string>([
    "product.availability.set",
    "product.price.set",
    OPS_ALERT_RESOLVE_STAFF_KIND,
    OPS_INCIDENT_CLOSE_STAFF_KIND,
    OPS_SCHEDULE_OVERRIDE_SET_KIND,
    OPS_FOREIGN_ADVERTISED_KIND,
    OPS_FOREIGN_ADVERTISED_TRANSITION_KIND,
    OPS_FOREIGN_ADVERTISED_REFUND_KIND,
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
    // spans this pack's OWNED kinds (`product.availability.set` +
    // `ops.alert.resolve.staff` + `incident.ticket.close.staff`, BKL-088) AND
    // three foreign-owned ones (owned by pack-orders / pack-payments —
    // advertised here only to widen the ops-plane allowlist).
    const allowedIntents: string[] = isStaffSession
      ? [
          "product.availability.set",
          "product.price.set",
          OPS_ALERT_RESOLVE_STAFF_KIND,
          OPS_INCIDENT_CLOSE_STAFF_KIND,
          OPS_SCHEDULE_OVERRIDE_SET_KIND,
          OPS_FOREIGN_ADVERTISED_KIND,
          OPS_FOREIGN_ADVERTISED_TRANSITION_KIND,
          OPS_FOREIGN_ADVERTISED_REFUND_KIND,
        ]
      : []
    // The two READ tools (`ops_snapshot` + `ops_sales_analytics`) are advertised
    // ONLY to a staff session; `filterReadOnly` re-asserts each is a READ_ONLY
    // name (never a MUTATING leak). Non-staff → [].
    return {
      visibleReadTools: isStaffSession
        ? filterReadOnly(OPS_TOOLS, [
            OPS_SNAPSHOT_READ_TOOL,
            OPS_SALES_ANALYTICS_READ_TOOL,
          ])
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
