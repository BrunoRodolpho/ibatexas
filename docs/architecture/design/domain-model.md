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

```
Customer (Twilio Verify + Medusa)
  │
  ├── phone: string (unique, primary identity)
  ├── name: string | null
  ├── email: string | null
  ├── medusaId: string | null
  ├── source: string | null              ← origin channel: 'web' | 'whatsapp'
  ├── firstContactAt: Date | null        ← timestamp of first interaction
  │
  ├── GuestSession (Redis, TTL 48h)
  │     ├── sessionId: string
  │     ├── cartId: string          ← Medusa cart
  │     └── channel: 'web' | 'whatsapp'
  │
  ├── CustomerProfile (Redis, TTL 30d, refreshed on activity)
  │     ├── dietaryRestrictions: string[]     e.g. ['vegetariano', 'sem_gluten']
  │     ├── allergens: string[]               e.g. ['lactose', 'nuts']
  │     ├── favouriteItems: string[]           ← productIds, top 5 by frequency
  │     ├── lastOrder: OrderSummary
  │     │     ├── orderId: string
  │     │     ├── items: { productId, name, quantity }[]
  │     │     └── placedAt: string
  │     ├── orderingPatterns:
  │     │     ├── preferredDays: number[]      ← 0=Sun … 6=Sat
  │     │     ├── preferredHour: number        ← 0–23
  │     │     └── avgSpend: number             ← centavos BRL
  │     ├── preferredPayment: 'pix' | 'card' | 'cash'
  │     └── preferredTableLocation: 'indoor' | 'outdoor' | 'bar' | 'terrace' | null
  │
  ├── Reservation[] (Postgres)
  │     ├── id: string
  │     ├── customerId: string       ← FK to Customer.id
  │     ├── partySize: number
  │     ├── status: ReservationStatus
  │     ├── specialRequests: SpecialRequest[]
  │     ├── confirmedAt: Date | null
  │     ├── checkedInAt: Date | null
  │     ├── cancelledAt: Date | null
  │     │
  │     ├── TimeSlot
  │     │     ├── id: string
  │     │     ├── date: Date
  │     │     ├── startTime: string            ← 'HH:MM' format, e.g. '19:30'
  │     │     ├── durationMinutes: number      ← default 90
  │     │     ├── maxCovers: number
  │     │     └── reservedCovers: number       ← atomic counter, updated on create/cancel
  │     │
  │     └── Table[]
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
  │     ├── customerEmail: string | null
  │     ├── customerName: string | null
  │     ├── customerPhone: string | null
  │     ├── fulfillmentStatus: OrderFulfillmentStatus
  │     ├── paymentStatus: string | null
  │     ├── totalInCentavos: number
  │     ├── subtotalInCentavos: number
  │     ├── shippingInCentavos: number
  │     ├── itemCount: number
  │     ├── itemsJson: Json | null             ← OrderEventItem[], validated by itemsSchemaVersion
  │     ├── itemsSchemaVersion: number         ← currently 1
  │     ├── shippingAddressJson: Json | null
  │     ├── version: number                    ← optimistic concurrency (incremented on each transition)
  │     ├── medusaCreatedAt: Date
  │     │
  │     └── OrderStatusHistory[]
  │           ├── id: string (cuid)
  │           ├── orderId: string              ← FK to OrderProjection
  │           ├── fromStatus: OrderFulfillmentStatus
  │           ├── toStatus: OrderFulfillmentStatus
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
  │     ├── regenerationCount: number          ← default 0, max 5 per order
  │     ├── idempotencyKey: string | null (unique)
  │     ├── version: number                    ← optimistic concurrency
  │     ├── lastStripeEventTs: Date | null     ← out-of-order event guard
  │     ├── createdAt: Date
  │     ├── updatedAt: Date
  │     │
  │     └── PaymentStatusHistory[]
  │           ├── id: string (cuid)
  │           ├── paymentId: string            ← FK to Payment
  │           ├── fromStatus: PaymentStatus
  │           ├── toStatus: PaymentStatus
  │           ├── actor: OrderActor
  │           ├── actorId: string | null
  │           ├── reason: string | null        ← e.g. "stripe:evt_xxx" for webhooks
  │           ├── version: number
  │           └── createdAt: Date
  │
  ├── OrderNote[] (Postgres — customer/admin notes per order)
  │     ├── id: string (cuid)
  │     ├── orderId: string                    ← FK to OrderProjection
  │     ├── author: OrderActor
  │     ├── authorId: string | null
  │     ├── content: string (max 500 chars)
  │     ├── isInternal: Boolean (default false) — when true, note is only visible to staff (not returned in customer-facing API)
  │     └── createdAt: Date
  │
  ├── OrderEventLog[] (Postgres — append-only, observability/replay layer)
  │     ├── id: string (cuid)
  │     ├── orderId: string                    ← FK to OrderProjection
  │     ├── eventType: string                  ← e.g. "order.placed", "order.status_changed"
  │     ├── idempotencyKey: string (unique)    ← composite: orderId:eventType:discriminator
  │     ├── payload: Json                      ← full event payload, stored verbatim
  │     ├── timestamp: Date                    ← event timestamp from source
  │     └── createdAt: Date
  │
  └── Review[] (Postgres)
        ├── id: string
        ├── orderId: string                    ← Medusa order id
        ├── productIds: string[]               ← DEPRECATED, use productId
        ├── productId: string | null           ← primary product this review is for
        ├── customerId: string
        ├── rating: 1 | 2 | 3 | 4 | 5
        ├── comment: string | null
        ├── channel: 'web' | 'whatsapp'
        └── createdAt: Date
```

---

## Enums

```typescript
type ReservationStatus =
  | 'pending'        // created, awaiting confirmation
  | 'confirmed'      // confirmed, WhatsApp sent
  | 'seated'         // checked in
  | 'completed'      // left, table freed
  | 'cancelled'      // cancelled by customer or staff
  | 'no_show'        // 15min grace passed, no check-in

type TableLocation =
  | 'indoor'
  | 'outdoor'
  | 'bar'
  | 'terrace'

type SpecialRequestType =
  | 'birthday'
  | 'anniversary'
  | 'allergy_warning'  // extra kitchen attention, not a filter (use allergens for filtering)
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
  | 'canceled'              // PI canceled — terminal
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
  ├── customerId: string
  ├── timeSlotId: string
  ├── partySize: number
  ├── notifiedAt: Date | null   ← when WhatsApp notification was sent
  ├── expiresAt: Date           ← auto-remove if customer doesn't claim spot in 30min
  └── createdAt: Date           ← position derived from ORDER BY createdAt
```

`@@unique([customerId, timeSlotId])` — one waitlist entry per customer per slot.

---

## Delivery Zones

Zones are stored as a list of CEP prefixes (Phase 1). This covers most practical cases
without requiring PostGIS. Upgrade to PostGIS polygon storage in Phase 2 if precise
geo-fencing becomes necessary.

```typescript
interface DeliveryZone {
  id: string
  name: string                // e.g. "Centro", "Zona Sul"
  cepPrefixes: string[]       // e.g. ["14800", "14801"] — first 5 digits of CEP
  feeInCentavos: number       // centavos BRL (schema field: fee_in_centavos)
  estimatedMinutes: number    // transit time (added to preparation time)
  active: boolean
}
```

**CEP matching:** strip non-digits from customer CEP, check if any `cepPrefix` is a prefix of it.
If no zone matches, delivery is unavailable to that address.

---

## Abandoned Cart

**Cart TTL:** 24 hours of inactivity (tracked in Redis alongside the guest session).

**Publisher:** Scheduled job in `apps/api` (cron every 1 hour).
Queries Redis for guest sessions with `lastActivityAt > 24h ago` and a non-empty cartId.
Publishes `cart.abandoned` to NATS for each matching session.

**Subscriber:** `packages/tools` event handler.
Sends WhatsApp reminder message (if phone is known) and updates `CustomerProfile` with abandonment signal.

```typescript
// cart.abandoned payload
{
  cartId: string
  sessionId: string
  customerId: string | null
  items: { productId: string; name: string; quantity: number }[]
  totalValue: number           // centavos
  lastActivityAt: string       // ISO 8601
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

### Event catalogue

| Event type | Published by | Metadata |
|---|---|---|
| `product.viewed` | agent `get_product_details` | `{ productId, source: 'search' \| 'browse' \| 'recommendation' }` |
| `product.added_to_cart` | _(deprecated — see `cart.item_added` below)_ | `{ productId, variantId, quantity }` |
| `cart.abandoned` | Redis TTL expiry job | `{ cartId, items[], totalValue, lastActivityAt }` |
| `order.placed` | Commerce on order create | `{ orderId, items[], totalValue, paymentMethod, deliveryType }` |
| `order.confirmed` | Commerce on status change | `{ orderId }` |
| `order.cancelled` | Commerce on status change | `{ orderId, reason }` |
| `order.status_changed` | Admin updates order fulfillment status | `{ orderId, displayId, previousStatus, newStatus, customerId, updatedBy: OrderActor, version, correlationId?, timestamp }` |
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
- `whatsapp.message.*` and `web.{eventType}` are telemetry-only (no subscribers in Phase 1; future JetStream consumers in Phase 3)
- `order.payment_failed`, `order.refunded`, `order.disputed`, `order.canceled` have no subscribers yet — future consumers will handle notifications and status updates
- `order.status_changed` events MUST include `version` (projection version after transition). Typed contract: `OrderStatusChangedEvent` in `packages/types/src/order-events.ts`
- `order.placed` events create an `OrderProjection` row via `cart-intelligence.ts` subscriber. Typed contract: `OrderPlacedEvent`

---

## Prisma Schema

Lives in `packages/domain/prisma/schema.prisma` — `ibx_domain` PostgreSQL schema.
Separate namespace from Medusa. Run `ibx db migrate:domain` to apply migrations.

```prisma
model Table {
  id         String        @id @default(cuid())
  number     String        @unique
  capacity   Int
  location   TableLocation
  accessible Boolean       @default(false)
  active     Boolean       @default(true)
  createdAt  DateTime      @default(now())
  updatedAt  DateTime      @updatedAt

  reservationTables ReservationTable[]
}

model TimeSlot {
  id              String   @id @default(cuid())
  date            DateTime @db.Date
  startTime       String   @db.VarChar(5)  // 'HH:MM' format, e.g. '19:30'
  durationMinutes Int      @default(90)
  maxCovers       Int
  reservedCovers  Int      @default(0)  // atomic counter, updated on create/cancel
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  reservations Reservation[]
  waitlist     Waitlist[]

  @@unique([date, startTime])
}

model Reservation {
  id              String            @id @default(cuid())
  customerId      String
  partySize       Int
  status          ReservationStatus @default(pending)
  specialRequests Json              @default("[]")  // SpecialRequest[] — see SpecialRequest type above
  confirmedAt     DateTime?
  checkedInAt     DateTime?
  cancelledAt     DateTime?
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt

  customer   Customer @relation(fields: [customerId], references: [id])
  timeSlot   TimeSlot @relation(fields: [timeSlotId], references: [id], onDelete: Restrict)
  timeSlotId String

  tables ReservationTable[]
}

model ReservationTable {
  reservation   Reservation @relation(fields: [reservationId], references: [id])
  reservationId String
  table         Table       @relation(fields: [tableId], references: [id])
  tableId       String

  @@id([reservationId, tableId])
}

model Waitlist {
  id         String    @id @default(cuid())
  customerId String
  partySize  Int
  // position is derived: ORDER BY createdAt among entries for the same slot
  notifiedAt DateTime?
  expiresAt  DateTime
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  timeSlot   TimeSlot @relation(fields: [timeSlotId], references: [id], onDelete: Restrict)
  timeSlotId String

  @@unique([customerId, timeSlotId])
}

model Review {
  id          String   @id @default(cuid())
  orderId     String
  productIds  String[]  // DEPRECATED — use productId
  productId   String?   // primary product this review is for
  customerId  String
  rating      Int       // 1–5
  comment     String?
  channel     String    // 'web' | 'whatsapp'
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  customer Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)

  @@unique([orderId, customerId])
}

model Customer {
  id             String    @id @default(cuid())
  phone          String    @unique
  name           String?
  email          String?
  medusaId       String?   @unique
  source         String?                            // origin channel: 'web' | 'whatsapp'
  firstContactAt DateTime?                          // timestamp of first interaction
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  addresses     Address[]
  preferences   CustomerPreferences?
  reviews       Review[]
  orderItems    CustomerOrderItem[]
  orderProjections OrderProjection[]
  reservations  Reservation[]
  conversations Conversation[]
}

model Address {
  id         String  @id @default(cuid())
  customerId String
  street     String
  number     String
  complement String?
  district   String
  city       String
  state      String  @db.Char(2)
  cep        String  @db.Char(8)
  isDefault  Boolean @default(false)

  customer Customer @relation(fields: [customerId], references: [id])
}

model CustomerPreferences {
  id                  String   @id @default(cuid())
  customerId          String   @unique
  dietaryRestrictions String[]
  allergenExclusions  String[] // always explicit array — never infer
  favoriteCategories  String[]
  updatedAt           DateTime @updatedAt

  customer Customer @relation(fields: [customerId], references: [id])
}

model CustomerOrderItem {
  id               String   @id @default(cuid())
  customerId       String?                        // nullable for LGPD compliance (SetNull on customer delete)
  medusaOrderId    String
  productId        String
  variantId        String
  quantity         Int
  priceInCentavos  Int
  orderedAt        DateTime

  customer Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)

  @@index([customerId, productId])
  @@index([medusaOrderId])
}

model DeliveryZone {
  id               String   @id @default(cuid())
  name             String
  cepPrefixes      String[]
  feeInCentavos    Int
  estimatedMinutes Int
  active           Boolean  @default(true)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}

enum TableLocation {
  indoor
  outdoor
  bar
  terrace
}

enum ReservationStatus {
  pending
  confirmed
  seated
  completed
  cancelled
  no_show
}

enum ConversationChannel {
  whatsapp
  web
}

enum MessageRole {
  user
  assistant
  system
}

model Conversation {
  id         String              @id @default(cuid())
  sessionId  String              @unique @map("session_id")
  customerId String?             @map("customer_id")
  channel    ConversationChannel
  startedAt  DateTime            @default(now()) @map("started_at")
  endedAt    DateTime?           @map("ended_at")
  createdAt  DateTime            @default(now()) @map("created_at")
  updatedAt  DateTime            @updatedAt @map("updated_at")

  customer Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)
  messages ConversationMessage[]

  @@index([customerId])
  @@index([channel])
  @@index([startedAt])
  @@map("conversations")
}

enum OrderFulfillmentStatus {
  pending
  confirmed
  preparing
  ready
  in_delivery
  delivered
  canceled
}

enum OrderActor {
  admin
  system
  system_backfill
  customer
}

model OrderProjection {
  id                  String                 @id               // = Medusa order ID
  displayId           Int                    @map("display_id")
  customerId          String?                @map("customer_id")
  customerEmail       String?                @map("customer_email")
  customerName        String?                @map("customer_name")
  customerPhone       String?                @map("customer_phone")
  fulfillmentStatus   OrderFulfillmentStatus @default(pending) @map("fulfillment_status")
  paymentStatus       String?                @map("payment_status")
  totalInCentavos     Int                    @default(0) @map("total_in_centavos")
  subtotalInCentavos  Int                    @default(0) @map("subtotal_in_centavos")
  shippingInCentavos  Int                    @default(0) @map("shipping_in_centavos")
  itemCount           Int                    @default(0) @map("item_count")
  itemsJson           Json?                  @map("items_json")
  itemsSchemaVersion  Int                    @default(1) @map("items_schema_version")
  shippingAddressJson Json?                  @map("shipping_address_json")
  version             Int                    @default(1)       // optimistic concurrency
  medusaCreatedAt     DateTime               @map("medusa_created_at")
  createdAt           DateTime               @default(now()) @map("created_at")
  updatedAt           DateTime               @updatedAt @map("updated_at")

  customer      Customer?          @relation(fields: [customerId], references: [id], onDelete: SetNull)
  statusHistory OrderStatusHistory[]

  @@index([customerId])
  @@index([fulfillmentStatus])
  @@index([displayId])
  @@index([medusaCreatedAt])
  @@index([fulfillmentStatus, medusaCreatedAt(sort: Desc)])
  @@map("order_projections")
}

model OrderStatusHistory {
  id         String                 @id @default(cuid())
  orderId    String                 @map("order_id")
  fromStatus OrderFulfillmentStatus @map("from_status")
  toStatus   OrderFulfillmentStatus @map("to_status")
  actor      OrderActor             @default(system)
  actorId    String?                @map("actor_id")
  reason     String?
  version    Int
  backfillBatchId String?           @map("backfill_batch_id")
  createdAt  DateTime               @default(now()) @map("created_at")

  order OrderProjection @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([orderId, createdAt])
  @@index([createdAt])
  @@map("order_status_history")
}

model ConversationMessage {
  id             String      @id @default(cuid())
  conversationId String      @map("conversation_id")
  role           MessageRole
  content        String
  metadata       Json?
  sentAt         DateTime    @default(now()) @map("sent_at")
  createdAt      DateTime    @default(now()) @map("created_at")

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, sentAt])
  @@map("conversation_messages")
}
```
