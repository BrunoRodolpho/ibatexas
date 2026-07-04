/**
 * @ibatexas/pack-ops — domain types.
 *
 * IbateXas's SIXTH first-party Pack: the governed OPS (owner/staff
 * operations) plane — NEW-032 slice C1 + BKL-088. Where `pack-orders` /
 * `pack-reservations` / `pack-whatsapp` govern CUSTOMER-facing and egress
 * mutations, this Pack governs STAFF-plane operational mutations proposed by
 * the ops-actor persona (the restaurant owner/manager talking to the agent).
 *
 * # Security posture (read before touching a guard)
 *
 * The ops plane's envelopes are model-parsed payloads carried on an
 * `admin:${staffId}` session with `actor.role ∈ {OWNER,MANAGER,ATTENDANT}`
 * (stamped by the planner seam). Authority is NOT the taint level — it is the
 * composition of THREE independent gates:
 *
 *   1. the pack's own `adminSessionOnlyGuard` (AUTH) — REFUSE unless the
 *      session is `admin:`-namespaced, so every kind this pack OWNS is
 *      staff-plane-only at the KERNEL regardless of surface (mandatory: the
 *      adopter `staffRoleGuard` is INERT for non-`admin:` sessions);
 *   2. the adopter `staffRoleGuard` + the staff-role matrix (AUTH, prepended
 *      by `buildIbatexasPolicyPacks`) — REFUSE unless `actor.role` is
 *      permitted for the kind;
 *   3. the pack's business guards (strict payload validation + entity
 *      existence / actionability).
 *
 * Because authority rides on (2)+(1)+the matrix, the taint FLOOR is
 * `UNTRUSTED` — the model-parsed payload is allowed to be untrusted; it is the
 * `admin:` namespace + role that authorize, never the taint. See
 * {@link opsTaintPolicy}.
 *
 * # Intent surface (this Pack)
 *
 *   - product.availability.set — staff. Toggle a product's availability
 *     (86 / un-86 an item). Matrix row {OWNER,MANAGER}. NEVER chat-drivable.
 *   - product.price.set        — staff (NEW-004). Change a product's price by
 *     message ("aumenta o preço da picanha pra 95 reais"). Matrix row
 *     {OWNER,MANAGER}. NEVER chat-drivable. A model-parsed (UNTRUSTED) price
 *     ALWAYS REQUEST_CONFIRMATIONs (a misparse sends the wrong price live); the
 *     confirm prompt states the product name + old→new BRL. Reversible ⇒ no
 *     ESCALATE band; a sanity REFUSE caps absurd values.
 *   - ops.alert.resolve.staff  — staff (BKL-088). Resolve an operational alert
 *     by message ("resolve o alerta X"). Matrix row {OWNER,MANAGER}.
 *   - incident.ticket.close.staff — staff (BKL-088). Close a no-reply incident
 *     by message ("fecha o incidente Y"). Matrix row {OWNER,MANAGER}.
 *
 * # BKL-088 — the LAYERED (D10) posture, and why the pack names are DISTINCT
 *
 * The domain `ops.alert.resolve` / `incident.ticket.close` kinds stay
 * SYSTEM-only (`buildSystemEnvelope`, staff identity on the payload as
 * `resolvedBy: "staff:<id>"` + `resolutionType: STAFF`; they are DELIBERATELY
 * absent from `KNOWN_INTENT_KINDS` and are NOT installed as Packs — see
 * ops-alert-policy.ts / incident-policy.ts). This pack's verbs are the
 * STAFF-PLANE half of a TWO-LAYER governed path (exactly the D10 posture
 * `product.availability.set` → `medusa.admin.product.update` already ships):
 *
 *   ops.alert.resolve.staff  (composed router, admin:+role, UNTRUSTED taint)
 *        └── executor → opsAlertService.resolveAlertFromEnvelope(
 *                          buildSystemEnvelope({kind:"ops.alert.resolve", …}))
 *                        (SYSTEM router, system:, SYSTEM taint)
 *
 * The names MUST be DISTINCT (`*.staff`, not the bare system kind) so the two
 * adjudications a single staff turn produces never CONFLATE: reusing the bare
 * name would (a) double-count the two seams in `intent_audit` (both rows carry
 * the same `kind`), and (b) inject the deliberately-off-`KNOWN` system kind
 * INTO `KNOWN_INTENT_KINDS`/`PACK_REGISTERED` via `pack.intents`, breaking the
 * documented "absent from KNOWN" invariant. Distinct names keep the STAFF verb
 * (composed/known/matrixed/BOM'd) cleanly separable from the SYSTEM write
 * (off-KNOWN, domain-internal) everywhere.
 */

import { createSystemTaintPolicy } from "@adjudicate/primitives"

/**
 * The Pack's intent-kind surface. `product.availability.set` (NEW-032 slice C1)
 * plus the two BKL-088 staff-plane resolution verbs. All three are OWNED by
 * this pack (composed-router routable, matrixed) — the `*.staff` suffix marks
 * the two whose EXECUTOR then drives the same-named SYSTEM domain write layer.
 */
export type OpsIntentKind =
  | "product.availability.set"
  | "product.price.set"
  | "ops.alert.resolve.staff"
  | "incident.ticket.close.staff"

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

/**
 * `product.price.set` payload (NEW-004). Strict CLOSED contract — the
 * business-phase `validatePricePayload` guard REFUSEs anything that is not
 * EXACTLY `{ productId: <non-empty string>, priceCentavos: <integer > 0>,
 * reason?: <string> }` (unknown keys rejected). `productId` is the Medusa
 * product id the ops executor re-prices (the resolver rewrites a NAME to it,
 * BKL-089); `priceCentavos` is the target price in INTEGER centavos (Hard Rule
 * #2 — never floats/reais on the wire; the executor converts to reais at the
 * Medusa egress); `reason` is an optional operator note carried into audit.
 */
export interface ProductPriceSetPayload {
  readonly productId: string
  readonly priceCentavos: number
  readonly reason?: string
}

/**
 * `ops.alert.resolve.staff` payload (BKL-088). The model controls ONLY the
 * alert reference + an optional free-form reason note. The executor stamps the
 * SYSTEM-write payload's `resolvedBy` from the authenticated Capsule staffId
 * (`staff:<id>`) and FORCES `resolutionType: STAFF` — a message-driven resolve
 * is always a manual STAFF action, never AUTO — so neither is ever
 * model-controlled. `reason` is an operator note carried into the audit trail
 * only (the SYSTEM `OpsAlertResolvePayload` has no reason slot to persist).
 */
export interface OpsAlertResolveStaffPayload {
  readonly alertId: string
  readonly reason?: string
}

/**
 * `incident.ticket.close.staff` payload (BKL-088). Same posture as
 * {@link OpsAlertResolveStaffPayload}: the model controls only the incident
 * reference + an optional reason note; the executor forces
 * `resolvedBy: "staff:<id>"` + `resolutionType: STAFF` (never AUTO/HANDED_OFF,
 * which are system-driven). `reason` is audit-only.
 */
export interface IncidentCloseStaffPayload {
  readonly incidentId: string
  readonly reason?: string
}

/** The Pack's payload union. */
export type OpsPayload =
  | ProductAvailabilitySetPayload
  | ProductPriceSetPayload
  | OpsAlertResolveStaffPayload
  | IncidentCloseStaffPayload

/** The keys the strict `product.availability.set` validator admits. */
export const PRODUCT_AVAILABILITY_SET_KEYS: ReadonlySet<string> = new Set([
  "productId",
  "available",
  "reason",
])

/** The keys the strict `product.price.set` validator admits (NEW-004). */
export const PRODUCT_PRICE_SET_KEYS: ReadonlySet<string> = new Set([
  "productId",
  "priceCentavos",
  "reason",
])

/** The keys the strict `ops.alert.resolve.staff` validator admits (BKL-088). */
export const OPS_ALERT_RESOLVE_STAFF_KEYS: ReadonlySet<string> = new Set([
  "alertId",
  "reason",
])

/** The keys the strict `incident.ticket.close.staff` validator admits (BKL-088). */
export const INCIDENT_CLOSE_STAFF_KEYS: ReadonlySet<string> = new Set([
  "incidentId",
  "reason",
])

// ── Context (per-turn caller identity / channel surface) ────────────────────

/**
 * Per-turn context the planner consumes. Structurally independent from the
 * `OrderContext` / `WhatsAppContext` so the ops planner does not accidentally
 * couple to those domains. `staffId` gates the planner's `allowedIntents`:
 * the ops verbs are advertised ONLY on a staff session.
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
 * ops-conductor resolver projects this from the products read-model BEFORE
 * adjudication; the Pack never reads a store directly.
 */
export interface OpsProductSnapshot {
  readonly id: string
  readonly status: string
}

/**
 * The product-pricing snapshot the pack's `product.price.set` guards read
 * (NEW-004). Projected by the ops resolver from the admin catalog read (variant
 * BRL prices) BEFORE adjudication:
 *
 *   - `id` / `status` prove existence (a null snapshot ⇒ REFUSE product_not_found);
 *   - `name` is the product display title — the CONFIRM prompt states it so the
 *     staff confirms WHICH product ("Confirmar novo preço de Picanha…");
 *   - `currentPriceCentavos` is the CURRENT displayed price (the uniform BRL
 *     variant price = min == max) so the prompt can show old→new;
 *   - `divergentVariantPrices` is TRUE when the product's BRL-priced variants are
 *     NOT all the same price (per-variation pricing, e.g. 500g vs 1kg) — the
 *     `requireUniformVariantPricing` guard REFUSEs those (v1 does not disambiguate
 *     which variation the owner meant; see `refusePricePerVariantUnsupported`).
 *
 * The resolver considers ONLY variants that carry a BRL price; a product with no
 * BRL-priced variant is not priceable by message and projects `null`.
 */
export interface OpsPriceProductSnapshot {
  readonly id: string
  readonly status: string
  readonly name: string
  readonly currentPriceCentavos: number
  readonly divergentVariantPrices: boolean
}

/**
 * The alert snapshot the pack's `requireAlertActionable` guard reads (BKL-088).
 * `id` proves existence and `status` lets the guard fail closed on a terminal
 * (already-resolved) alert. Projected by the ops resolver from the OpsAlert
 * read-model; `null` ⇒ the alert id does not exist ⇒ REFUSE.
 */
export interface OpsAlertSnapshot {
  readonly id: string
  readonly status: string
}

/**
 * The incident snapshot the pack's `requireIncidentActionable` guard reads
 * (BKL-088). Same shape/semantics as {@link OpsAlertSnapshot} over the
 * ConversationIncident read-model.
 */
export interface OpsIncidentSnapshot {
  readonly id: string
  readonly status: string
}

/**
 * Per-kind SystemState the ops pack's guards adjudicate against. THE CONTRACT
 * THE OPS RESOLVER MUST BUILD (one branch per kind):
 *
 *   product.availability.set  → { ctx, product:  {id,status} | null }
 *   product.price.set         → { ctx, priceProduct: {id,status,name,…} | null }
 *   ops.alert.resolve.staff   → { ctx, alert:    {id,status} | null }
 *   incident.ticket.close.staff → { ctx, incident: {id,status} | null }
 *
 * Each entity field is `null` when no row matches the payload reference — the
 * corresponding business guard turns that into a REFUSE (fail-closed; an
 * unprojected `undefined` is treated as not-found too).
 */
export interface OpsState {
  readonly ctx: OpsContext & {
    /** Tenant this request operates on (single-tenant today). */
    readonly tenantId?: string
  }
  /** The product the in-flight `product.availability.set` targets. */
  readonly product?: OpsProductSnapshot | null
  /** The product-pricing snapshot the in-flight `product.price.set` targets. */
  readonly priceProduct?: OpsPriceProductSnapshot | null
  /** The alert the in-flight `ops.alert.resolve.staff` targets (BKL-088). */
  readonly alert?: OpsAlertSnapshot | null
  /** The incident the in-flight `incident.ticket.close.staff` targets (BKL-088). */
  readonly incident?: OpsIncidentSnapshot | null
}

// ── Entity lifecycle ────────────────────────────────────────────────────────

/**
 * The NON-TERMINAL statuses shared by the OpsAlert + ConversationIncident
 * lifecycles (both Prisma enums are OPEN | ACKNOWLEDGED | AUTO_RESOLVED |
 * RESOLVED; the first two are non-terminal). A staff resolve/close is
 * actionable ONLY against a non-terminal row — a terminal one is already
 * resolved. Kept as plain string literals so the leaf pack takes no Prisma
 * dependency (the resolver projects `status` as a plain string).
 */
export const OPS_ENTITY_NON_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "OPEN",
  "ACKNOWLEDGED",
])

/** True when an alert/incident status is non-terminal (actionable). */
export function isOpsEntityActionable(status: string): boolean {
  return OPS_ENTITY_NON_TERMINAL_STATUSES.has(status)
}

// ── Taint policy ────────────────────────────────────────────────────────────

/**
 * The ops taint floor is `UNTRUSTED` for every kind (no system-only kinds).
 *
 * This is deliberate and load-bearing: the ops persona's payloads are
 * model-parsed (an LLM extracted the reference / fields from the owner's
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

// ── NEW-004 — price sanity bound (centavos — Hard Rule #2 / #3) ──────────────

/**
 * Read a non-negative integer centavos value from `process.env[name]`, falling
 * back to `fallback` when unset / non-numeric / negative (Hard Rule #3: config
 * from env, never hardcode). Mirrors pack-payments' `readEnvCentavos`.
 */
function readEnvCentavos(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n < 0) return fallback
  return n
}

/**
 * The absurd-price sanity ceiling for `product.price.set`, in centavos. A
 * parsed price ABOVE this REFUSEs (`refusePriceOutOfRange`) — a defensive cap
 * against a gross misparse ("95 mil" → 9_500_000, or an extra zero) sending a
 * nonsensical price live. Default R$100.000,00 (10_000_000 centavos), per the
 * NEW-004 design; env-overridable via `OPS_PRICE_MAX_CENTAVOS`. Price is
 * reversible, so this is a sanity floor/ceiling, NOT a money-governance band
 * (there is no ESCALATE band for price v1); `priceCentavos <= 0` is already
 * REFUSEd structurally by `validatePricePayload` (integer > 0).
 */
export function getPriceSanityMaxCentavos(): number {
  return readEnvCentavos("OPS_PRICE_MAX_CENTAVOS", 10_000_000)
}
