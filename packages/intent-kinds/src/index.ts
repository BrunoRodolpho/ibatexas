// @ibatexas/intent-kinds — Intent kind union (`KNOWN_INTENT_KINDS`).
//
// Source-of-truth for which intent kinds the kernel knows about. Used by
// the boot-time Pack-coverage validator (apps/api kernel-bootstrap.ts):
// every known kind MUST resolve to a Pack policy at boot or the api
// refuses to start. This catches the "added an intent kind but forgot to
// add a Pack policy" regression case. Also surfaced by `ibx kernel status`.
//
// This tiny leaf package is the assembly point. It composes the intent
// surfaces of every first-party Pack plus first-party adopter Packs
// (currently only `@adjudicate/pack-payments-pix` from the platform repo)
// into one Set. It lives in its own package — rather than inside any
// consumer — so both apps/api and packages/cli can import it without a
// dependency cycle, and so it outlived the deletion of the legacy
// `@ibatexas/llm-provider` brain (claustrum-on-dev WS8). Its only deps are
// the six Pack packages it type-mirrors below; nothing depends on it but
// those two consumers, so it cannot introduce a cycle.
//
// # Scope (post W5)
//
// Six intent unions are imported:
//   - `OrderIntentKind`             from `@ibatexas/pack-orders`
//   - `ReservationIntentKind`       from `@ibatexas/pack-reservations`
//   - `WhatsAppIntentKind`          from `@ibatexas/pack-whatsapp`
//   - `CustomerOnboardingIntentKind` from `@ibatexas/pack-customer-onboarding`
//   - `PaymentIntentKind`           from `@ibatexas/pack-payments`  (NEW W5-1)
//   - `PixIntentKind`               from `@adjudicate/pack-payments-pix`
//
// # Why explicit literal lists?
//
// Type-only imports can't be enumerated at runtime — a `Set<OrderIntentKind>`
// has no values until we list them. We pin a `... satisfies readonly OrderIntentKind[]`
// expression so TypeScript fails the build if the Pack adds a new kind to
// its union without also updating this list. That's the typo-guard guard.
//
// # W5-7 policy decision: `medusa.*` namespace is EXCLUDED.
//
// The 13 `medusa.admin.order.*`, `medusa.cart.*`, `medusa.payment_collection.*`
// kinds emitted by `packages/tools/src/medusa/adjudicated.ts` are an internal
// egress wrapper around the Medusa REST proxy — they operate one layer
// below the user-facing intent taxonomy. They are governed by their own
// inline policy in `adjudicated.ts` independent of the user-facing Pack
// surface tracked here. See `docs/adjudicate-migration/migration/decisions-log.md`
// D10 for rationale.

import type { CustomerOnboardingIntentKind } from "@ibatexas/pack-customer-onboarding"
import type { OpsIntentKind } from "@ibatexas/pack-ops"
import type { OrderIntentKind } from "@ibatexas/pack-orders"
import type { PaymentIntentKind } from "@ibatexas/pack-payments"
import type { ReservationIntentKind } from "@ibatexas/pack-reservations"
import type { WhatsAppIntentKind } from "@ibatexas/pack-whatsapp"
import type { PixIntentKind } from "@adjudicate/pack-payments-pix"

// ── Pack-orders intent surface (post W5-2 expansion) ────────────────────────
//
// Mirrors the `OrderIntentKind` union in
// `packages/pack-orders/src/types.ts`. If you add a kind there, add it here
// too — `satisfies` will fail the build otherwise. W5-2 added 12 kinds:
// granular amends, lifecycle (projection/status), and the order-extension
// kinds the taxonomy lists.

const ORDER_INTENT_KINDS = [
  "order.cart.ensure",
  "order.item.add",
  "order.item.update",
  "order.item.remove",
  "order.cart.sync",
  "order.coupon.apply",
  "order.checkout.create",
  "order.pix.details.set",
  "order.cancel",
  "order.cancel.system",
  "order.amend.request",
  "order.amend.add_item",
  "order.amend.update_qty",
  "order.amend.remove_item",
  "order.address.change",
  "order.type.switch",
  "order.note.add",
  "order.review.submit",
  "order.reorder",
  "order.projection.create",
  "order.status.transition",
  "order.status.reconcile",
] as const satisfies readonly OrderIntentKind[]

// ── Pack-reservations intent surface ─────────────────────────────────────────
//
// Mirrors `ReservationIntentKind` in `packages/pack-reservations/src/types.ts`.
// Source: governance §"Domain: reservation".

const RESERVATION_INTENT_KINDS = [
  "reservation.create",
  "reservation.modify",
  "reservation.cancel",
  "reservation.checkin",
  "reservation.complete",
  "reservation.no_show.mark",
  "reservation.waitlist.join",
  "reservation.waitlist.notify",
] as const satisfies readonly ReservationIntentKind[]

// ── Pack-whatsapp intent surface (post W5-6) ────────────────────────────────
//
// Mirrors `WhatsAppIntentKind` in `packages/pack-whatsapp/src/types.ts`.
// W5-6 added `conversation.message.append` (persistence-side; distinct
// from the wire-egress `whatsapp.message.send`).

const WHATSAPP_INTENT_KINDS = [
  "whatsapp.message.send",
  "whatsapp.template.send",
  "whatsapp.session.handover",
  "conversation.message.append",
  // BKL-030: customer-side escalation on-ramp (LLM-proposable).
  "whatsapp.handoff.request",
] as const satisfies readonly WhatsAppIntentKind[]

// ── Pack-payments-pix intent surface ─────────────────────────────────────────
//
// Mirrors `PixIntentKind` in `@adjudicate/pack-payments-pix`. The PIX kinds
// are a separate namespace (`pix.charge.*`) from the IbateXas-native
// `payment.pix.*` kinds in `@ibatexas/pack-payments`. Both ship in
// `KNOWN_INTENT_KINDS` — pix.* for the wire-PSP contract,
// payment.pix.regenerate for the customer-driven composite kind in
// pack-payments.

const PIX_INTENT_KINDS = [
  "pix.charge.create",
  "pix.charge.confirm",
  "pix.charge.refund",
] as const satisfies readonly PixIntentKind[]

// ── Pack-payments intent surface (NEW — W5-1) ───────────────────────────────
//
// Mirrors `PaymentIntentKind` in `packages/pack-payments/src/types.ts`. 17
// payment-domain kinds covering charge / refund / dispute / cash / waive /
// status lifecycle. The legacy `paymentProjectionPolicyBundle` now re-exports
// a subset of pack-payments' bundle for backwards compatibility (D8).

const PAYMENT_INTENT_KINDS = [
  "payment.create",
  "payment.charge.create",
  "payment.charge.confirm",
  "payment.charge.fail",
  "payment.charge.expire",
  "payment.charge.cancel",
  "payment.pix.regenerate",
  "payment.method.switch",
  "payment.retry",
  "payment.refund.issue",
  "payment.refund.confirm",
  "payment.dispute.open",
  "payment.cash.confirm",
  "payment.waive",
  "payment.status.force",
  "payment.status.transition",
  "payment.status.reconcile",
] as const satisfies readonly PaymentIntentKind[]

// ── Pack-customer-onboarding intent surface ──────────────────────────────────
//
// Mirrors `CustomerOnboardingIntentKind`. The taxonomy enumerates more
// customer.* kinds; this Pack covers the 8 identity-lifecycle kinds. The
// remaining kinds (`customer.session.*`, `customer.loyalty.*`,
// `customer.welcome_credit.*`) belong to future Packs.

const CUSTOMER_ONBOARDING_INTENT_KINDS = [
  "customer.create",
  "customer.profile.update",
  "customer.preferences.update",
  "customer.pix.details.save",
  "customer.address.add",
  "customer.address.remove",
  "customer.anonymize",
  "customer.anonymize.cancel",
] as const satisfies readonly CustomerOnboardingIntentKind[]

// ── Pack-ops intent surface (NEW — NEW-032 slice C1) ────────────────────────
//
// Mirrors `OpsIntentKind` in `packages/pack-ops/src/types.ts`. First-party
// staff-plane ops verb — belongs in KNOWN_INTENT_KINDS (unlike the `medusa.*`
// egress kinds deliberately excluded above). Chat-INVISIBLE by construction
// (advertised only to a staff session; never in CHAT_DRIVABLE_TOOL_KINDS).

const OPS_INTENT_KINDS = [
  "product.availability.set",
  // BKL-088 — the two OWNED staff-plane RESOLUTION verbs. DISTINCT from the
  // SYSTEM-only `ops.alert.resolve` / `incident.ticket.close` domain kinds
  // (which stay ABSENT from KNOWN_INTENT_KINDS by design); these `*.staff`
  // pack verbs are the composed-router-adjudicated STAFF layer whose executors
  // then drive that SYSTEM write layer (the D10 two-layer posture).
  "ops.alert.resolve.staff",
  "incident.ticket.close.staff",
] as const satisfies readonly OpsIntentKind[]

// ── Combined set ─────────────────────────────────────────────────────────────
//
// `validateEnforceConfig` accepts any `ReadonlySet<string>` — widening to
// `string` here is intentional. The `satisfies` clauses above are the
// load-bearing type-safety net.
//
// W5-4 target: ≥60 kinds total. Current count:
//   22 (orders, post W5-2)
//  + 8 (reservations)
//  + 5 (whatsapp, post W5-6 + BKL-030 whatsapp.handoff.request)
//  + 3 (pix-payments)
//  + 17 (pack-payments, new W5-1)
//  + 8 (customer-onboarding)
//  + 3 (pack-ops — product.availability.set NEW-032 C1;
//       ops.alert.resolve.staff + incident.ticket.close.staff BKL-088)
//  = 66 distinct kinds, ≥60 target met.
//
// Future Pack growth (`@ibatexas/pack-auth`, `@ibatexas/pack-loyalty`,
// `@ibatexas/pack-ops`) extends this set from inside their own modules.

// audit-2026-05-25 (I13): loyalty.stamp.add is a real kernel-gated
// domain mutation (introduced this PR — cart-intelligence.ts:362,
// loyalty.service.ts:93, loyalty-policy.ts:28) but was absent from
// KNOWN_INTENT_KINDS. Absence excluded it from assertPackCoverage
// boot-time check, the per-intent redactor conformance test, and the
// kernel-metrics sink's knownIntentKinds list. Add it explicitly so
// the existing T3 conformance test gates redaction rules for it
// (covered by the global HASH_FIELDS rule on `customerId`) and
// future loyalty kinds follow the same registration convention.
export const LOYALTY_INTENT_KINDS: ReadonlySet<string> = new Set<string>([
  "loyalty.stamp.add",
])

export const KNOWN_INTENT_KINDS: ReadonlySet<string> = new Set<string>([
  ...ORDER_INTENT_KINDS,
  ...RESERVATION_INTENT_KINDS,
  ...WHATSAPP_INTENT_KINDS,
  ...PIX_INTENT_KINDS,
  ...PAYMENT_INTENT_KINDS,
  ...CUSTOMER_ONBOARDING_INTENT_KINDS,
  ...OPS_INTENT_KINDS,
  ...LOYALTY_INTENT_KINDS,
])
