# Domain Model

This document covers the **custom domain** — entities that Medusa does not own. Medusa handles Catalog and Commerce. Everything here lives in `packages/domain` (TypeScript interfaces) and is persisted either in Postgres (via Prisma) or Redis.

For Medusa's own entities (Product, Cart, Order, etc.) refer to the [Medusa v2 docs](https://docs.medusajs.com).

---

## Product Metadata Conventions

Medusa products use the `metadata` field to store IbateXas-specific attributes. These are not Medusa-native fields — they are set via the admin API or `ibx` CLI.

### metadata.visibility

Controls which channel(s) can see a product.

| Value | Meaning |
|---|---|
| `"all"` | Visible on all channels (default) |
| `"whatsapp"` | Exclusive to WhatsApp — "menu secreto" |
| `"web"` | Visible on web storefront only |
| `"staff"` | Internal/staff-facing only (never shown to customers) |

**Default:** products without a `visibility` field are treated as `"all"`.

**Filtering rules (enforced post-Typesense by `searchProducts`):**
- `channel === "whatsapp"`: keep products where visibility is `"all"` or `"whatsapp"`
- `channel === "web"`: keep products where visibility is `"all"` or `"web"`
- no channel: keep only `"all"` products

**Note:** The `visibility` field is indexed in Typesense to enable future native filtering, but the authoritative filter is the post-search step in `packages/tools/src/search/search-products.ts`.

---

## Entity Map

The Postgres entities below are defined authoritatively in
[`packages/domain/prisma/schema.prisma`](../../../packages/domain/prisma/schema.prisma)
(`ibx_domain` schema). The tree shows the conceptual shape and key fields; the schema file
is the source of truth for exact column types, `@map` names, indexes, and FK actions.

```
Customer (Twilio Verify + Medusa)
  │
  ├── phone: string (unique, primary identity)
  ├── name: string | null
  ├── email: string | null
  ├── cpf: string | null                 ← @db.VarChar(14), format 000.000.000-00
  ├── medusaId: string | null
  ├── source: string | null              ← origin channel: 'web' | 'whatsapp'
  ├── firstContactAt: Date | null        ← timestamp of first interaction
  │
  ├── Session (Redis) — two stores, both keyed by sessionId:
  │     ├── WhatsApp session map (apps/api/src/whatsapp/session.ts, TTL 24h)
  │     │     { phone, sessionId, customerId, isNew }
  │     └── Conversation history list (apps/api/src/session/store.ts)
  │           AgentMessage[] — TTL 48h guest / 24h authenticated
  │
  ├── CustomerProfileCache (Redis, TTL 30d — packages/tools/src/intelligence/types.ts)
  │     ├── recentlyViewed: { productId, viewedAt }[]   ← max 20
  │     ├── cartItems: string[]                          ← variant IDs currently in cart
  │     ├── orderCount: number
  │     ├── lastOrderAt: string | null
  │     ├── lastOrderedProductIds: string[]
  │     └── preferences: {                               ← null until set
  │           dietaryRestrictions: string[]
  │           allergenExclusions: string[]
  │           favoriteCategories: string[]
  │         } | null
  │     (orderedProductScore:{productId} stored as separate Hash fields)
  │
  ├── LoyaltyAccount (Postgres, one per customer, SetNull on delete)
  │     ├── stamps: number              ← current punch count, resets after reward
  │     ├── totalEarned: number         ← lifetime stamps, never decremented
  │     └── redeemed: number            ← rewards redeemed (++ when stamp 10 earned)
  │
  ├── Reservation[] (Postgres)
  │     ├── id: string
  │     ├── displayId: number           ← @default(autoincrement()), human-facing
  │     ├── customerId: string          ← FK to Customer.id, onDelete: Restrict
  │     ├── partySize: number
  │     ├── status: ReservationStatus
  │     ├── specialRequests: SpecialRequest[]
  │     ├── confirmedAt: Date | null
  │     ├── checkedInAt: Date | null
  │     ├── cancelledAt: Date | null
  │     │
  │     ├── TimeSlot                            ← FK onDelete: Restrict
  │     │     ├── id: string
  │     │     ├── date: Date
  │     │     ├── startTime: string            ← @db.VarChar(5), 'HH:MM', e.g. '19:30'
  │     │     ├── durationMinutes: number      ← default 90
  │     │     ├── maxCovers: number
  │     │     └── reservedCovers: number       ← atomic counter, updated on create/cancel
  │     │
  │     └── Table[] (via ReservationTable join)
  │           ├── id: string
  │           ├── number: string
  │           ├── capacity: number
  │           ├── location: TableLocation
  │           └── accessible: boolean
  │
  ├── Conversation[] (Postgres, CDC from Redis via NATS)
  │     ├── id: string (cuid)
  │     ├── sessionId: string (unique)         ← maps to Redis session:{sessionId}
  │     ├── customerId: string | null          ← FK to Customer, SetNull on delete
  │     ├── channel: 'whatsapp' | 'web'
  │     ├── startedAt: Date
  │     ├── endedAt: Date | null
  │     │
  │     └── ConversationMessage[]
  │           ├── id: string (cuid)
  │           ├── conversationId: string       ← FK to Conversation, Cascade on delete
  │           ├── role: 'user' | 'assistant' | 'system'
  │           ├── content: string
  │           ├── metadata: Json | null
  │           └── sentAt: Date
  │
  ├── OrderProjection[] (Postgres — CQRS read model)
  │     ├── id: string                         ← Medusa order ID (not cuid)
  │     ├── displayId: number
  │     ├── customerId: string | null
  │     ├── customerEmail / customerName / customerPhone: string | null
  │     ├── fulfillmentStatus: OrderFulfillmentStatus
  │     ├── paymentStatus: string | null
  │     ├── totalInCentavos / subtotalInCentavos / shippingInCentavos: number
  │     ├── itemCount: number
  │     ├── itemsJson: Json | null             ← OrderEventItem[], validated by itemsSchemaVersion
  │     ├── itemsSchemaVersion: number         ← currently 1
  │     ├── shippingAddressJson: Json | null
  │     ├── deliveryType: string | null        ← 'delivery' | 'pickup' | 'dine_in'
  │     ├── paymentMethod: string | null       ← 'cash' | 'pix' | 'card'
  │     ├── tipInCentavos: number              ← default 0
  │     ├── currentPaymentId: string | null    ← active Payment.id
  │     ├── version: number                    ← optimistic concurrency (incremented on each transition)
  │     ├── medusaCreatedAt: Date
  │     │
  │     └── OrderStatusHistory[]
  │           ├── id: string (cuid)
  │           ├── orderId: string              ← FK to OrderProjection
  │           ├── fromStatus / toStatus: OrderFulfillmentStatus
  │           ├── actor: OrderActor            ← admin | system | system_backfill | customer
  │           ├── actorId: string | null
  │           ├── reason: string | null
  │           ├── version: number              ← projection version AFTER this transition
  │           ├── backfillBatchId: string | null  ← set only by system_backfill
  │           └── createdAt: Date
  │
  ├── Payment[] (Postgres — Billing context, one active per order)
  │     ├── id: string (cuid)
  │     ├── orderId: string                    ← FK to OrderProjection
  │     ├── method: "pix" | "card" | "cash"
  │     ├── status: PaymentStatus              ← enum, validated transitions
  │     ├── amountInCentavos: number
  │     ├── stripePaymentIntentId: string | null (unique)
  │     ├── pixExpiresAt: Date | null
  │     ├── refundedAmountCentavos: number     ← default 0
  │     ├── regenerationCount: number          ← default 0
  │     ├── idempotencyKey: string | null (unique)
  │     ├── version: number                    ← optimistic concurrency
  │     ├── lastStripeEventTs: Date | null     ← out-of-order event guard
  │     │
  │     └── PaymentStatusHistory[]             ← mirrors OrderStatusHistory shape
  │
  │     INVARIANT: at most one active (non-terminal) payment per order, enforced by a
  │     manually-managed partial unique index `payment_active_per_order` (see schema
  │     comment + migration 20260412000000). Terminal set must stay in sync with
  │     TERMINAL_PAYMENT_STATUSES in @ibatexas/types.
  │
  ├── OrderNote[] (Postgres — customer/admin notes per order)
  │     ├── orderId: string                    ← FK to OrderProjection
  │     ├── author: OrderActor
  │     ├── content: string (max 500 chars)
  │     └── isInternal: boolean (default false) ← when true, staff-only (not in customer API)
  │
  ├── OrderEventLog[] (Postgres — append-only, observability/replay layer)
  │     ├── orderId: string
  │     ├── eventType: string                  ← e.g. "order.placed", "order.status_changed"
  │     ├── idempotencyKey: string (unique)    ← composite: orderId:eventType:discriminator
  │     ├── payload: Json                      ← verbatim; overwritten to {anonymized:true} on LGPD erasure
  │     └── timestamp: Date
  │
  └── Review[] (Postgres)
        ├── orderId: string                    ← Medusa order id
        ├── productIds: string[]               ← DEPRECATED, use productId
        ├── productId: string | null           ← primary product this review is for
        ├── customerId: string                 ← FK, SetNull on delete
        ├── rating: 1 | 2 | 3 | 4 | 5
        ├── comment: string | null
        └── channel: 'web' | 'whatsapp'
```

### Standalone entities (not Customer-rooted)

```
Staff (Postgres) — Twilio Verify OTP auth, same as customers
  ├── id: string
  ├── phone: string (unique)
  ├── name: string
  ├── role: StaffRole              ← OWNER | MANAGER | ATTENDANT (default ATTENDANT)
  └── active: boolean

Restaurant schedule (Postgres)
  ├── WeeklySchedule  ← one row per dayOfWeek (0=Sun..6=Sat); isOpen + lunch/dinner HH:MM windows
  ├── Holiday         ← unique date; label; allDay (or start/end HH:MM)
  └── ScheduleOverride← unique date; isOpen + blocks: { label, start, end }[]; Holiday wins over override
```

---

## Enums

Defined in the Prisma schema (`ibx_domain`) and mirrored in `@ibatexas/types`. Order/payment
status enums are kept in sync with the TS consts by a compile-time test.

```typescript
type ReservationStatus =
  | 'pending'        // created, awaiting confirmation
  | 'confirmed'      // confirmed, WhatsApp sent
  | 'seated'         // checked in
  | 'completed'      // left, table freed
  | 'cancelled'      // cancelled by customer or staff
  | 'no_show'        // grace passed, no check-in

type StaffRole = 'OWNER' | 'MANAGER' | 'ATTENDANT'   // access level: OWNER > MANAGER > ATTENDANT

type TableLocation = 'indoor' | 'outdoor' | 'bar' | 'terrace'

type SpecialRequestType =
  | 'birthday'
  | 'anniversary'
  | 'allergy_warning'  // extra kitchen attention, not a filter (use allergenExclusions for filtering)
  | 'highchair'
  | 'window_seat'
  | 'accessible'
  | 'other'

interface SpecialRequest {
  type: SpecialRequestType
  notes?: string           // free text, e.g. "aniversário da Maria, 50 anos"
}

type OrderFulfillmentStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'in_delivery'
  | 'delivered'
  | 'canceled'

type OrderActor = 'admin' | 'system' | 'system_backfill' | 'customer'

type PaymentStatus =
  | 'awaiting_payment'      // order created, no payment initiated
  | 'payment_pending'       // PI created, waiting (PIX QR shown, card processing)
  | 'payment_expired'       // PIX QR expired — terminal per-attempt, retry = new row
  | 'payment_failed'        // card declined — terminal per-attempt, retry = new row
  | 'cash_pending'          // cash order, payment expected at delivery/counter
  | 'paid'                  // confirmed/captured
  | 'switching_method'      // transitional: old PI being canceled, new being created
  | 'partially_refunded'    // partial refund issued
  | 'refunded'              // full refund — terminal
  | 'disputed'              // chargeback opened
  | 'canceled'              // PI canceled — terminal (DB value 'pay_canceled')
  | 'waived'                // admin waived — terminal

type PaymentMethod = 'pix' | 'card' | 'cash'

type ConversationChannel = 'whatsapp' | 'web'

type MessageRole = 'user' | 'assistant' | 'system'
```

### OrderType
| Value | Description |
|-------|-------------|
| `delivery` | Delivered to customer address |
| `pickup` | Customer picks up at restaurant |
| `dine_in` | Customer eats at restaurant |

---

## Waitlist

```
Waitlist (Postgres)
  ├── id: string
  ├── customerId: string        ← FK, Cascade on customer delete
  ├── timeSlotId: string        ← FK, Restrict on slot delete
  ├── partySize: number
  ├── notifiedAt: Date | null   ← when WhatsApp notification was sent
  ├── expiresAt: Date           ← claim window
  └── createdAt: Date           ← position derived from ORDER BY createdAt
```

`@@unique([customerId, timeSlotId])` — one waitlist entry per customer per slot.

---

## Delivery Zones

Zones are stored as a list of CEP prefixes (Phase 1). This covers most practical cases
without requiring PostGIS. The schema also carries optional `centerLat`/`centerLng`/`radiusKm`
for a circular-zone GPS-pin fallback.

```typescript
interface DeliveryZone {
  id: string
  name: string                // e.g. "Centro", "Zona Sul"
  cepPrefixes: string[]       // e.g. ["14800", "14801"] — first 5 digits of CEP
  feeInCentavos: number       // centavos BRL
  estimatedMinutes: number    // transit time (added to preparation time)
  active: boolean
  // optional circular fallback: centerLat, centerLng, radiusKm
}
```

**CEP matching:** strip non-digits from customer CEP, check if any `cepPrefix` is a prefix of it.
If no zone matches, delivery is unavailable to that address.

---

## Abandoned Cart

**Publisher:** `abandoned-cart-checker.ts` BullMQ repeatable job in `apps/api`, runs every 15 min.
HSCANs the `active:carts` Redis hash and publishes `cart.abandoned` for sessions idle > 2h with a
non-empty cart. Multi-tier nudges: re-arms `lastActivity` until the final tier (3), then drops the cart.

**Subscriber:** `cart-intelligence.ts` in `apps/api/src/subscribers` — sends a WhatsApp recovery nudge
when the phone is known.

```typescript
// cart.abandoned payload (apps/api/src/jobs/abandoned-cart-checker.ts)
{
  eventType: 'cart.abandoned'
  cartId: string
  sessionId: string
  sessionType: 'guest' | 'customer'
  idleMs: number
  phone?: string               // included only when resolvable
}
```

---

## Business Events (NATS)

All events share a common envelope:

```typescript
interface BusinessEvent<T = Record<string, unknown>> {
  eventType: string
  sessionId: string
  customerId: string | null    // null for guest events
  channel: 'web' | 'whatsapp'
  timestamp: string            // ISO 8601
  metadata: T
}
```

Order/payment events have typed contracts in `packages/types/src/order-events.ts` — that file is
the source of truth for their payload shapes; the table below summarizes publisher → consumer wiring.

### Event catalogue

| Event type | Published by | Metadata |
|---|---|---|
| `product.viewed` | agent `get_product_details` | `{ productId, source: 'search' \| 'browse' \| 'recommendation' }` |
| `product.added_to_cart` | _(deprecated — see `cart.item_added` below)_ | `{ productId, variantId, quantity }` |
| `cart.abandoned` | `abandoned-cart-checker.ts` job (idle > 2h) | `{ cartId, sessionId, sessionType, idleMs, phone? }` |
| `order.placed` | Commerce on order create | `OrderPlacedEvent` — `{ orderId, displayId, items[], totalInCentavos, subtotalInCentavos, shippingInCentavos, paymentMethod, deliveryType?, tipInCentavos?, version, ... }` |
| `order.confirmed` | Commerce on status change | `{ orderId }` |
| `order.cancelled` | Commerce on status change | `{ orderId, reason }` |
| `order.status_changed` | Admin updates order fulfillment status | `OrderStatusChangedEvent` — `{ orderId, displayId, previousStatus, newStatus, customerId, updatedBy, version, correlationId?, timestamp }` |
| `order.delivered` | Commerce on status change | `{ orderId, deliveryMinutes }` |
| `reservation.created` | Reservation on create | `{ reservationId, partySize, date, timeSlot, tableLocation }` |
| `reservation.modified` | Reservation on update | `{ reservationId, changes }` |
| `reservation.cancelled` | Reservation on cancel | `{ reservationId, reason }` |
| `reservation.no_show` | Reservation cron job | `{ reservationId }` |
| `review.submitted` | agent `submit_review` | `{ reviewId, productIds[], rating }` |
| `agent.tool_called` | agent on every tool call | `{ tool, durationMs, success, error? }` |
| `agent.question_unanswered` | agent on tool failure | `{ query, tool, error }` |
| `customer.first_order` | Commerce on order create | `{ orderId, customerId }` |
| `customer.returned` | Commerce on order create (2nd+) | `{ orderId, daysSinceLastOrder }` |
| `order.payment_failed` | Stripe webhook (`stripe-webhook.ts`) | `{ orderId, paymentIntentId, error }` |
| `order.refunded` | Stripe webhook (`stripe-webhook.ts`) | `{ orderId, chargeId, amountRefunded }` |
| `order.disputed` | Stripe webhook (`stripe-webhook.ts`) | `{ orderId, disputeId, amount, reason }` |
| `order.canceled` | Stripe webhook (`stripe-webhook.ts`) | `{ orderId, stripePaymentIntentId, cancellationReason }` |
| `cart.item_added` | agent `add_to_cart`, `reorder` | `{ cartId, productId, variantId, quantity, customerId }` |
| `notification.send` | `cart-intelligence.ts` subscriber | `{ type, customerId?, channel: 'whatsapp', body, targetType?: 'customer' \| 'staff' }` |
| `review.prompt.schedule` | Medusa `order-delivered` subscriber | `{ orderId, deliveredAt }` — `customerId` resolved by consumer |
| `review.prompt` | `review-prompt-poller.ts` job | `{ customerId, orderId }` |
| `whatsapp.message.received` | WhatsApp webhook (telemetry) | `{ phoneHash, sessionId, hasMedia }` |
| `whatsapp.message.sent` | WhatsApp webhook (telemetry) | `{ phoneHash, sessionId, toolsUsed, durationMs }` |
| `web.{eventType}` | Analytics endpoint (`analytics.ts`) | Dynamic — mirrors client PostHog event payload |
| `conversation.message.appended` | `appendMessages()` in session store (CDC) | `{ sessionId, customerId, channel, messages[{role, content, sentAt}] }` |

**Notes:**
- `notification.send` subscriber is stubbed — actual delivery not yet implemented
- `whatsapp.message.*` and `web.{eventType}` are telemetry-only (no subscribers in Phase 1)
- `order.payment_failed`, `order.refunded`, `order.disputed`, `order.canceled` have no subscribers yet
- `order.status_changed` events MUST include `version` (projection version after transition)
- `order.placed` events create an `OrderProjection` row via the `cart-intelligence.ts` subscriber

---

## Prisma Schema

The authoritative schema is [`packages/domain/prisma/schema.prisma`](../../../packages/domain/prisma/schema.prisma)
— the `ibx_domain` PostgreSQL schema, a separate namespace from Medusa. Read that file for exact
column types, `@map`/`@@map` names, indexes, FK actions, and the partial-unique-index notes.
Run `ibx db migrate:domain` to apply migrations.
