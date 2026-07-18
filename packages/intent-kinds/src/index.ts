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
// `@ibatexas/llm-provider` brain (claustrum-on-dev WS8). Its only RUNTIME
// deps are the six Pack packages it type-mirrors below; nothing depends on
// it but those two consumers, so it cannot introduce a cycle.
//
// # FE-4 CONTRACT (FE-T26) — this file is now GENERATED, in part
//
// The six `*_INTENT_KINDS` arrays + `KNOWN_INTENT_KINDS` below the
// GENERATED_BEGIN marker are machine-written from `CapabilityDefinition`
// by `packages/packs-composed/scripts/regenerate-intent-kinds.ts` — see
// that file + `packages/packs-composed/src/codegen/build-generated-
// region.ts` for the codegen, and `packages/packs-composed/src/__tests__/
// regen-intent-kinds-freshness.test.ts` for the CI gate that fails if this file
// drifts from a fresh regeneration. (The tooling lives in packs-composed,
// not here, deliberately — it needs `CAPABILITY_DEFINITIONS` and reaches
// this file by a plain relative filesystem path, never a package import,
// so `@ibatexas/intent-kinds` itself gains NO new dependency and cannot
// form a build-graph cycle with packs-composed, which already depends on
// this package the other way for its own freshness tests.) Adding,
// removing, or reordering a capability is now a ONE-PLACE edit to
// `definitions.ts` + `pnpm --filter @ibatexas/packs-composed run
// regen:intent-kinds` — hand-editing the region below is a wasted edit the
// next regen silently overwrites, and the freshness gate catches a
// hand-edit that ISN'T followed by a regen (the committed file would no
// longer match a fresh regeneration).
//
// `PIX_INTENT_KINDS` and `LOYALTY_INTENT_KINDS` (declared BELOW, ABOVE the
// generated region) are the two deliberate exceptions — genuine EXTERNAL
// inputs `CapabilityDefinition` does not (and per FE-4.1 should not) model:
// `PIX_INTENT_KINDS` mirrors the FROZEN external `@adjudicate/pack-
// payments-pix`, not one of the six first-party Packs; `LOYALTY_
// INTENT_KINDS` is a real kernel-gated mutation with no Pack at all (see
// each constant's own doc for the full rationale, preserved from the
// pre-CONTRACT file). Both stay hand-authored forever — the codegen
// mandate (FE-4.3) never claimed to eliminate genuinely external data, only
// the ~16 lists that duplicated `CapabilityDefinition`'s own first-party
// scope.
//
// # Why `satisfies` clauses survive regeneration
//
// Type-only imports can't be enumerated at runtime — a `Set<OrderIntentKind>`
// has no values until we list them. Each generated array still carries its
// own `... satisfies readonly OrderIntentKind[]` expression (emitted by the
// regen script, not hand-typed) so TypeScript fails the build if a Pack's
// own type union ever admits a kind `CAPABILITY_DEFINITIONS` doesn't cover
// — the same typo-guard the pre-CONTRACT hand file carried, now compiler-
// checked against GENERATED content instead of hand-typed content.
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

// ── Pack-payments-pix intent surface (hand-authored EXTERNAL input) ─────────
//
// Mirrors `PixIntentKind` in `@adjudicate/pack-payments-pix`. The PIX kinds
// are a separate namespace (`pix.charge.*`) from the IbateXas-native
// `payment.pix.*` kinds in `@ibatexas/pack-payments`. Both ship in
// `KNOWN_INTENT_KINDS` — pix.* for the wire-PSP contract,
// payment.pix.regenerate for the customer-driven composite kind in
// pack-payments. NOT part of the generated region below (`@adjudicate/
// pack-payments-pix` is a platform adopter Pack, not one of the six
// first-party packs `CapabilityDefinition` covers) — cross-checked by
// packs-composed's freshness test against `paymentsPixPack.intents` (a
// runtime materialization of the same FROZEN external package), never
// silently re-derived here.
export const PIX_INTENT_KINDS = [
  "pix.charge.create",
  "pix.charge.confirm",
  "pix.charge.refund",
] as const satisfies readonly PixIntentKind[]

// ── Loyalty (hand-authored EXTERNAL input) ───────────────────────────────────
//
// audit-2026-05-25 (I13): loyalty.stamp.add is a real kernel-gated
// domain mutation (cart-intelligence.ts, loyalty.service.ts,
// loyalty-policy.ts) but is NOT Pack-registered at all (dispatched with a
// domain-internal PolicyBundle straight to adjudicate()/withAdjudicate,
// bypassing the Pack registry entirely) — there is no Pack to own it, so
// no CapabilityDefinition.pack value could be honest here either. NOT part
// of the generated region below — a real, permanent exception, not a
// migration debt.
export const LOYALTY_INTENT_KINDS: ReadonlySet<string> = new Set<string>([
  "loyalty.stamp.add",
])

// ═══ GENERATED — regenerate via `pnpm --filter @ibatexas/packs-composed run regen:intent-kinds` after editing packages/packs-composed/src/capability-definitions/definitions.ts. DO NOT HAND-EDIT BELOW THIS LINE. ═══

// ── Pack-orders intent surface ────────────────────────────────────────────────
//
// Mirrors OrderIntentKind (packages/pack-orders/src/types.ts),
// projected from CAPABILITY_DEFINITIONS — see definitions.ts for per-kind rationale.
export const ORDER_INTENT_KINDS = [
  "order.cart.ensure",
  "order.item.add",
  "order.item.update",
  "order.item.remove",
  "order.cart.sync",
  "order.coupon.apply",
  "order.checkout.create",
  "order.pix.details.set",
  "order.cancel",
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

// ── Pack-reservations intent surface ──────────────────────────────────────────
//
// Mirrors ReservationIntentKind (packages/pack-reservations/src/types.ts),
// projected from CAPABILITY_DEFINITIONS — see definitions.ts for per-kind rationale.
export const RESERVATION_INTENT_KINDS = [
  "reservation.create",
  "reservation.modify",
  "reservation.cancel",
  "reservation.checkin",
  "reservation.complete",
  "reservation.no_show.mark",
  "reservation.waitlist.join",
] as const satisfies readonly ReservationIntentKind[]

// ── Pack-whatsapp intent surface ──────────────────────────────────────────────
//
// Mirrors WhatsAppIntentKind (packages/pack-whatsapp/src/types.ts),
// projected from CAPABILITY_DEFINITIONS — see definitions.ts for per-kind rationale.
export const WHATSAPP_INTENT_KINDS = [
  "whatsapp.message.send",
  "whatsapp.template.send",
  "whatsapp.session.handover",
  "conversation.message.append",
  "whatsapp.handoff.request",
] as const satisfies readonly WhatsAppIntentKind[]

// ── Pack-payments intent surface ──────────────────────────────────────────────
//
// Mirrors PaymentIntentKind (packages/pack-payments/src/types.ts),
// projected from CAPABILITY_DEFINITIONS — see definitions.ts for per-kind rationale.
export const PAYMENT_INTENT_KINDS = [
  "payment.create",
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

// ── Pack-customer-onboarding intent surface ───────────────────────────────────
//
// Mirrors CustomerOnboardingIntentKind (packages/pack-customer-onboarding/src/types.ts),
// projected from CAPABILITY_DEFINITIONS — see definitions.ts for per-kind rationale.
export const CUSTOMER_ONBOARDING_INTENT_KINDS = [
  "customer.create",
  "customer.profile.update",
  "customer.preferences.update",
  "customer.pix.details.save",
  "customer.address.add",
  "customer.address.remove",
  "customer.anonymize",
  "customer.anonymize.cancel",
] as const satisfies readonly CustomerOnboardingIntentKind[]

// ── Pack-ops intent surface ───────────────────────────────────────────────────
//
// Mirrors OpsIntentKind (packages/pack-ops/src/types.ts),
// projected from CAPABILITY_DEFINITIONS — see definitions.ts for per-kind rationale.
export const OPS_INTENT_KINDS = [
  "product.availability.set",
  "product.price.set",
  "menu.special.set",
  "ops.alert.resolve.staff",
  "incident.ticket.close.staff",
  "schedule.override.set",
] as const satisfies readonly OpsIntentKind[]

// ── Combined set ────────────────────────────────────────────────────────────
//
// PIX_INTENT_KINDS + LOYALTY_INTENT_KINDS are the two hand-authored EXTERNAL
// inputs (declared ABOVE, outside this generated region) — see their own doc
// comments for why neither is CapabilityDefinition-derivable.
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

// ═══ END GENERATED REGION ═══
