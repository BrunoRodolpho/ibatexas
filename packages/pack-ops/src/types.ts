/**
 * @ibatexas/pack-ops — domain types.
 *
 * IbateXas's SIXTH first-party Pack: the governed OPS (owner/staff
 * operations) plane — NEW-032 slice C1. Where `pack-orders` /
 * `pack-reservations` / `pack-whatsapp` govern CUSTOMER-facing and egress
 * mutations, this Pack governs STAFF-plane operational mutations proposed by
 * the ops-actor persona (the restaurant owner/manager talking to the agent).
 *
 * # Security posture (read before touching a guard)
 *
 * The ops plane's envelopes are model-parsed payloads carried on an
 * `admin:${staffId}` session with `actor.role ∈ {OWNER,MANAGER,ATTENDANT}`
 * (stamped by the planner seam in a sibling PR). Authority is NOT the taint
 * level — it is the composition of THREE independent gates:
 *
 *   1. the pack's own `adminSessionOnlyGuard` (AUTH) — REFUSE unless the
 *      session is `admin:`-namespaced, so the kind is staff-plane-only at the
 *      KERNEL regardless of surface (mandatory: the adopter `staffRoleGuard`
 *      is INERT for non-`admin:` sessions, so without this a customer/LLM
 *      session could otherwise reach the pack's business guards);
 *   2. the adopter `staffRoleGuard` + the staff-role matrix (AUTH, prepended
 *      by `buildIbatexasPolicyPacks`) — REFUSE unless `actor.role` is
 *      permitted for the kind (`product.availability.set` → {OWNER,MANAGER});
 *   3. the pack's business guards (strict payload validation + product
 *      existence).
 *
 * Because authority rides on (2)+(1)+the matrix, the taint FLOOR is
 * `UNTRUSTED` — the model-parsed payload is allowed to be untrusted; it is the
 * `admin:` namespace + role that authorize, never the taint. See
 * {@link opsTaintPolicy}.
 *
 * # Intent surface (this Pack)
 *
 *   - product.availability.set — staff. Toggle a product's availability
 *     (86 / un-86 an item). Mirrors the admin products PATCH route's
 *     `requireManagerRole` band → matrix row {OWNER,MANAGER}. NEVER
 *     chat-drivable (no customer/LLM surface proposes it).
 */

import { createSystemTaintPolicy } from "@adjudicate/primitives"

/** The Pack's intent-kind surface — one governed staff-plane verb for now. */
export type OpsIntentKind = "product.availability.set"

// ── Payloads ────────────────────────────────────────────────────────────────

/**
 * `product.availability.set` payload. Strict contract — the business-phase
 * `validateAvailabilityPayload` guard REFUSEs anything that is not EXACTLY
 * `{ productId: <non-empty string>, available: <boolean>, reason?: <string> }`
 * (unknown keys rejected). `productId` is the Medusa product id the later ops
 * executor toggles; `available` is the target state; `reason` is an optional
 * operator note carried into audit.
 */
export interface ProductAvailabilitySetPayload {
  readonly productId: string
  readonly available: boolean
  readonly reason?: string
}

/** The Pack's payload union (single member today). */
export type OpsPayload = ProductAvailabilitySetPayload

/** The keys the strict payload validator admits — anything else is rejected. */
export const PRODUCT_AVAILABILITY_SET_KEYS: ReadonlySet<string> = new Set([
  "productId",
  "available",
  "reason",
])

// ── Context (per-turn caller identity / channel surface) ────────────────────

/**
 * Per-turn context the planner consumes. Structurally independent from the
 * `OrderContext` / `WhatsAppContext` so the ops planner does not accidentally
 * couple to those domains. `staffId` gates the planner's `allowedIntents`:
 * the ops verb is advertised ONLY on a staff session.
 */
export interface OpsContext {
  readonly channel: "web" | "whatsapp" | "staff"
  readonly customerId: string | null
  /** Staff principal — present only for the staff/ops plane; null otherwise. */
  readonly staffId: string | null
}

// ── State (per-session snapshot the kernel adjudicates against) ─────────────

/**
 * The product snapshot the pack's `requireProductExists` guard reads. The
 * later ops-conductor resolver (a subsequent PR) projects this from the
 * products read-model BEFORE adjudication; the Pack never reads a store
 * directly (same adopter-projects-state convention as `pack-whatsapp`).
 *
 * Minimal on purpose — `id` proves existence and `status` lets a later
 * business rule reason about the current lifecycle state (e.g. refuse
 * toggling a discontinued product) without a schema break.
 */
export interface OpsProductSnapshot {
  readonly id: string
  readonly status: string
}

/**
 * Per-kind SystemState the ops pack's guards adjudicate against. THE CONTRACT
 * THE LATER OPS RESOLVER MUST BUILD:
 *
 *   {
 *     ctx: { channel, customerId, staffId, tenantId? },
 *     product: { id, status } | null   // null ⇒ product-not-found REFUSE
 *   }
 *
 * `product` is `null` when no product matches `payload.productId` — the
 * business-phase `requireProductExists` guard turns that into a REFUSE. When
 * the resolver has not projected a product at all (`undefined`), the guard
 * treats it as not-found too (fail-closed).
 */
export interface OpsState {
  readonly ctx: OpsContext & {
    /** Tenant this request operates on (single-tenant today). Carried for
     *  symmetry with the other packs' state; not gated here. */
    readonly tenantId?: string
  }
  /** The product the in-flight `product.availability.set` targets. */
  readonly product?: OpsProductSnapshot | null
}

// ── Taint policy ────────────────────────────────────────────────────────────

/**
 * The ops taint floor is `UNTRUSTED` for every kind (no system-only kinds).
 *
 * This is deliberate and load-bearing: the ops persona's payloads are
 * model-parsed (an LLM extracted `productId` / `available` from the owner's
 * message), so they arrive UNTRUSTED. Authority is NOT the taint — it is the
 * `admin:` session (`adminSessionOnlyGuard`) + `actor.role` (the adopter
 * `staffRoleGuard` + matrix). A `TRUSTED`/`SYSTEM` envelope also clears an
 * `UNTRUSTED` floor, so the floor never blocks a legitimately-stamped staff
 * envelope; it simply refuses to make taint the authorization axis.
 */
export const opsTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: [],
  userMinimum: "UNTRUSTED",
})
