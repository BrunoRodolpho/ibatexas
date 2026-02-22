# Domain Model

This document covers the **custom domain** — entities that Medusa does not own. Medusa handles Catalog and Commerce. Everything here lives in `packages/domain` (TypeScript interfaces) and is persisted either in Postgres (via Prisma) or Redis.

For Medusa's own entities (Product, Cart, Order, etc.) refer to the [Medusa v2 docs](https://docs.medusajs.com).

---

## Entity Map

```
Customer (Clerk)
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
  │     ├── customerId: string
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
  │     │     ├── startTime: string            ← '19:30'
  │     │     ├── durationMinutes: number      ← default 90
  │     │     └── maxCovers: number
  │     │
  │     └── Table[]
  │           ├── id: string
  │           ├── number: string
  │           ├── capacity: number
  │           ├── location: TableLocation
  │           └── accessible: boolean
  │
  └── Review[] (Postgres)
        ├── id: string
        ├── orderId: string                    ← Medusa order id
        ├── productIds: string[]               ← products reviewed
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
```

---

## Waitlist

```
Waitlist (Postgres)
  ├── id: string
  ├── customerId: string
  ├── timeSlotId: string
  ├── partySize: number
  ├── position: number          ← 1 = next in line
  ├── notifiedAt: Date | null   ← when WhatsApp notification was sent
  └── expiresAt: Date           ← auto-remove if customer doesn't claim spot in 30min
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
| `product.added_to_cart` | agent `add_to_cart` | `{ productId, variantId, quantity }` |
| `cart.abandoned` | Redis TTL expiry job | `{ cartId, items[], totalValue, lastActivityAt }` |
| `order.placed` | Commerce on order create | `{ orderId, items[], totalValue, paymentMethod, deliveryType }` |
| `order.confirmed` | Commerce on status change | `{ orderId }` |
| `order.cancelled` | Commerce on status change | `{ orderId, reason }` |
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

---

## Prisma Schema (target — not yet created)

```prisma
model Table {
  id          String        @id @default(cuid())
  number      String        @unique
  capacity    Int
  location    TableLocation
  accessible  Boolean       @default(false)
  active      Boolean       @default(true)
  createdAt   DateTime      @default(now())
  timeSlots   TimeSlot[]
}

model TimeSlot {
  id              String        @id @default(cuid())
  date            DateTime      @db.Date
  startTime       String        // '19:30'
  durationMinutes Int           @default(90)
  maxCovers       Int
  table           Table         @relation(fields: [tableId], references: [id])
  tableId         String
  reservations    Reservation[]
  @@unique([tableId, date, startTime])
}

model Reservation {
  id              String            @id @default(cuid())
  customerId      String            // Clerk user id
  partySize       Int
  status          ReservationStatus @default(pending)
  specialRequests Json              // SpecialRequest[]
  confirmedAt     DateTime?
  checkedInAt     DateTime?
  cancelledAt     DateTime?
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt
  timeSlot        TimeSlot          @relation(fields: [timeSlotId], references: [id])
  timeSlotId      String
}

model Waitlist {
  id          String    @id @default(cuid())
  customerId  String
  timeSlotId  String
  partySize   Int
  position    Int
  notifiedAt  DateTime?
  expiresAt   DateTime
  createdAt   DateTime  @default(now())
}

model Review {
  id          String   @id @default(cuid())
  orderId     String   // Medusa order id
  productIds  String[] // Medusa product ids
  customerId  String
  rating      Int      // 1–5
  comment     String?
  channel     String   // 'web' | 'whatsapp'
  createdAt   DateTime @default(now())
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
```
