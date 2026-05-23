// Intent kind union — `KNOWN_INTENT_KINDS`.
//
// Per `docs/adjudicate-migration/governance/01-intent-taxonomy.md`
// §"Intent kind union (knownIntents)", `validateEnforceConfig` from
// `@adjudicate/core/kernel` needs a single `ReadonlySet<string>` of every
// valid intent kind so that typos in `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE`
// can be flagged at boot.
//
// This module is the assembly point. It composes the intent surfaces of
// every first-party Pack plus first-party adopter Packs (currently only
// `@adjudicate/pack-payments-pix` from the platform repo) into one Set.
//
// # Scope today
//
// Four intent unions are imported:
//   - `OrderIntentKind`       from `@ibatexas/pack-orders`
//   - `ReservationIntentKind` from `@ibatexas/pack-reservations`
//   - `WhatsAppIntentKind`    from `@ibatexas/pack-whatsapp`
//   - `PixIntentKind`         from `@adjudicate/pack-payments-pix`
//
// # TODO — future Packs
//
// As task 21 lands, extend this union with:
//   - `CustomerOnboardingIntentKind`  from `@ibatexas/pack-customer-onboarding` (task 21)
//
// Each follow-up should:
//   1. Add the import line below.
//   2. Add a `const ${pack}_INTENT_KINDS = [...] as const satisfies readonly NewIntentKind[]`
//      block listing every kind that union admits.
//   3. Spread it into the final `Set` constructor below.
//
// # Why explicit literal lists?
//
// Type-only imports can't be enumerated at runtime — a `Set<OrderIntentKind>`
// has no values until we list them. We pin a `... satisfies readonly OrderIntentKind[]`
// expression so TypeScript fails the build if the Pack adds a new kind to
// its union without also updating this list. That's the typo-guard guard.

import type { OrderIntentKind } from "@ibatexas/pack-orders"
import type { ReservationIntentKind } from "@ibatexas/pack-reservations"
import type { WhatsAppIntentKind } from "@ibatexas/pack-whatsapp"
import type { PixIntentKind } from "@adjudicate/pack-payments-pix"

// ── Pack-orders intent surface ───────────────────────────────────────────────
//
// Mirrors the `OrderIntentKind` union in
// `packages/pack-orders/src/types.ts`. If you add a kind there, add it here
// too — `satisfies` will fail the build otherwise.

const ORDER_INTENT_KINDS = [
  "order.cart.ensure",
  "order.item.add",
  "order.item.update",
  "order.item.remove",
  "order.coupon.apply",
  "order.checkout.create",
  "order.cancel",
  "order.cancel.system",
  "order.amend.request",
  "order.note.add",
] as const satisfies readonly OrderIntentKind[]

// ── Pack-reservations intent surface ─────────────────────────────────────────
//
// Mirrors the `ReservationIntentKind` union in
// `packages/pack-reservations/src/types.ts`. If you add a kind there, add it
// here too — `satisfies` will fail the build otherwise.
//
// Source: `docs/adjudicate-migration/governance/01-intent-taxonomy.md`
// §"Domain: reservation".

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

// ── Pack-whatsapp intent surface ─────────────────────────────────────────────
//
// Mirrors the `WhatsAppIntentKind` union in
// `packages/pack-whatsapp/src/types.ts`. If you add a kind there, add it
// here too — `satisfies` will fail the build otherwise.
//
// Source: `docs/adjudicate-migration/governance/01-intent-taxonomy.md`
// §"Domain: whatsapp". The taxonomy enumerates six whatsapp kinds; this
// Pack covers three (`whatsapp.message.send`, `whatsapp.template.send`,
// `whatsapp.session.handover`). The remaining three
// (`whatsapp.handoff.request`, `whatsapp.followup.schedule`,
// `whatsapp.outreach.send`) land in subsequent tasks.

const WHATSAPP_INTENT_KINDS = [
  "whatsapp.message.send",
  "whatsapp.template.send",
  "whatsapp.session.handover",
] as const satisfies readonly WhatsAppIntentKind[]

// ── Pack-payments-pix intent surface ─────────────────────────────────────────
//
// Mirrors the `PixIntentKind` union in
// `@adjudicate/pack-payments-pix/src/types.ts`. PIX kinds are a separate
// domain (`payment.pix.*` would be the IbateXas-native naming once
// `@ibatexas/pack-payments` lands; today we surface the Pack's literal
// `pix.charge.*` kinds because that is what the wire schema enforces).

const PIX_INTENT_KINDS = [
  "pix.charge.create",
  "pix.charge.confirm",
  "pix.charge.refund",
] as const satisfies readonly PixIntentKind[]

// ── Combined set ─────────────────────────────────────────────────────────────
//
// `validateEnforceConfig` accepts any `ReadonlySet<string>` — widening to
// `string` here is intentional. The `satisfies` clauses above are the
// load-bearing type-safety net.

export const KNOWN_INTENT_KINDS: ReadonlySet<string> = new Set<string>([
  ...ORDER_INTENT_KINDS,
  ...RESERVATION_INTENT_KINDS,
  ...WHATSAPP_INTENT_KINDS,
  ...PIX_INTENT_KINDS,
  // TODO(task-21): ...CUSTOMER_ONBOARDING_INTENT_KINDS,
])
