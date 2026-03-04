# Bounded Contexts

IbateXas is organised into eight bounded contexts. Each context has a clear owner, a defined set of entities, and explicit rules about what it does and does not handle. No context reaches into another's data directly — all cross-context communication goes through the agent's tool registry or NATS events.

---

## 1. Catalog

**Owner:** Medusa.js v2 (product module)
**Read path:** Typesense (agent always queries Typesense, never Medusa directly)
**Write path:** Custom `/admin` panel (which calls Medusa API)

The catalog covers two distinct product types — food and merchandise — both managed through Medusa but with different rules.

### Entities

| Entity | Key fields |
|---|---|
| Product | id, name, description, images[], tags[], **productType: food \| frozen \| merchandise**, preparationTime?, availabilityWindow? |
| Category | id, name, parentCategory, type: restaurant \| shop |
| Variant | id, productId, size (individual/família/congelado for food; S/M/L/XL for merch), price, sku |
| Price | amount (centavos BRL), currency |
| Stock | variantId, quantity, reserved |
| Image | url, position, alt |
| Tag (food) | vegetariano, vegano, sem_gluten, sem_lactose, popular, novo, chef_choice, congelado |
| Tag (merch) | exclusivo, edição_limitada, kit |
| NutritionalInfo | per100g: calories, protein, fat, carbs, sodium (ANVISA format) — food only |
| Allergen | gluten, lactose, nuts, eggs, soy, fish, shellfish — food only |
| AvailabilityWindow | type: almoco (11h–15h) / jantar (18h–23h) / congelados (always) / especial — food only |
| RelatedProduct | productId, relatedProductId, relation: goes_well_with / customers_also_ordered |

### Rules

- All catalog reads by the agent go through Typesense — never query Medusa directly
- Stock is checked in real-time via `check_inventory` tool before `add_to_cart` — never trust cached stock for perishables
- `AvailabilityWindow` gates which food products the agent offers — merchandise has no availability window (always available)
- Catalog writes (new products, prices, images) happen only through the custom `/admin` panel — not through the agent

### Out of scope

- Cart, orders, payments — Commerce context
- Delivery estimates — Logistics context
- Reviews and ratings — Intelligence context (ratings displayed on catalog items but stored elsewhere)

---

## 2. Commerce

**Owner:** Medusa.js v2 (cart, order, payment modules)

### Entities

| Entity | Key fields |
|---|---|
| Cart | id, sessionId, customerId (nullable), items[], deliveryType, couponCode, status |
| CartItem | productId, variantId, quantity, specialInstructions, unitPrice |
| Order | id, customerId, items[], deliveryType, address, payment, tip, status, nfeId |
| OrderItem | variantId, quantity, specialInstructions, unitPrice |
| Payment | method: pix / card / cash, status, pixQrCode, stripePaymentIntentId |
| Tip | amount (centavos), percentage |
| Coupon | code, discountType: percent / fixed, value, minOrderValue, expiresAt |
| Invoice | nfeId, url, issuedAt (via Focus NFe API) |
| OrderStatus | received → confirmed → in_preparation → ready → out_for_delivery → delivered / cancelled |

### Rules

- Guest carts are allowed — anonymous session in Redis, TTL 48h
- Auth is required at checkout — guest session promoted to customer, cart migrated
- Boleto is **not** available for hot food delivery (next-day bank settlement incompatible with immediate fulfilment) — boleto only for congelados with pickup and for merchandise orders (Shop context)
- Every completed order generates an NF-e via Focus NFe API — required by Brazilian tax law
- Order status transitions publish NATS events (e.g. `order.delivered` triggers the review prompt)
- `specialInstructions` per CartItem are free-text, max 200 chars ("sem cebola", "bem passado", "molho separado")

### Out of scope

- CEP validation and delivery fees — Logistics context
- Payment link generation for WhatsApp — handled by agent composing message with Stripe/PIX link

---

## 3. Logistics

**Owner:** Custom (lightweight, lives in `apps/api` routes + `packages/domain`)

### Entities

| Entity | Key fields |
|---|---|
| Address | customerId, street, number, complement, neighbourhood, city, state, cep, validated |
| CEP | cep, street, neighbourhood, city, state (from ViaCEP) |
| DeliveryZone | id, name, neighbourhoods[], deliveryFee (centavos), estimatedMinutes |
| DeliveryEstimate | zone, fee, prepMinutes, transitMinutes, totalMinutes, queueDelayMinutes |
| Carrier | own_delivery (Phase 1) / ifood / rappi (Phase 2) |

### Rules

- CEP is validated via ViaCEP API before any delivery order is confirmed
- Delivery fee is zone-based (restaurant defines zones + fees) — not distance-calculated
- Delivery estimate = `preparationTime` + `zoneTransitTime` + `currentQueueDelay`
  - `currentQueueDelay` is estimated from number of active orders in `in_preparation` status
- Delivery type options: `delivery` / `pickup` / `dine-in`
  - `dine-in` skips all logistics — customer is already at the table
  - `pickup` requires a pickup time selection (15-min slots)
  - `delivery` requires address + CEP validation

### Out of scope

- Table reservations — Reservation context
- Payment processing — Commerce context

---

## 4. Reservation

**Owner:** Custom (Prisma schema in `packages/domain`, API routes in `apps/api`)

### Entities

| Entity | Key fields |
|---|---|
| Table | id, number, capacity, location: indoor/outdoor/bar/terrace, accessible: bool, active: bool |
| TimeSlot | id, date, startTime, duration (default 90min), maxCovers, reservedCovers |
| Reservation | id, customerId, tableIds[], timeSlotId, partySize, status, specialRequests[], confirmedAt, checkedInAt |
| ReservationStatus | pending → confirmed → seated → completed / cancelled / no_show |
| SpecialRequest | type: birthday/anniversary/allergyWarning/highchair/windowSeat/accessible, notes |
| Waitlist | id, customerId, timeSlotId, partySize, position, notifiedAt |

### Rules

- Reservations require auth — no anonymous bookings (identity needed for confirmation + WhatsApp notification)
- No-show policy: table released 15 minutes after reserved time if no check-in — status → `no_show`
- Waitlist: if `timeSlot.reservedCovers >= maxCovers`, customer is offered waitlist position; notified via WhatsApp if a cancellation opens a spot
- Confirmation triggers a WhatsApp message: date, time, party size, table location, + link to modify or cancel
- Check-in transitions reservation → `seated` and table → occupied
- A reservation can span multiple tables (large party)

### Out of scope

- In-person table ordering (Phase 3)
- Payment for reserved tables (deposits — Phase 2)

---

## 5. Identity

**Owner:** Twilio Verify (auth) + Redis (sessions) + Medusa (customer record)

### Entities

| Entity | Key fields |
|---|---|
| GuestSession | sessionId (UUID), cartId, channel: web/whatsapp, createdAt, TTL 48h (Redis) |
| Customer | phone (primary key, verified via Twilio), medusaCustomerId, name, email (optional), createdAt |
| CustomerProfile | customerId, dietaryRestrictions[], allergens[], favouriteItems[], lastOrder, orderingPatterns, preferredPayment, preferredTableLocation, type: customer/staff (Redis, TTL 30d) |
| Address | customerId, label, street, number, complement, neighbourhood, city, state, cep, isDefault |
| Staff | phone, role: manager/kitchen/cashier/delivery, active |

### Rules

- Auth is via WhatsApp OTP (Twilio Verify) — no passwords. Phone number is the primary identifier. **This applies to both customers and staff — there is no separate auth provider.**
- Staff roles are differentiated by `CustomerProfile.type` field (`customer` vs `staff`) and `Staff.role` — not by auth provider
- Guest session → Customer promotion happens at first checkout: cart migrated, sessionId linked to customerId
- A customer's WhatsApp phone number IS their identity on the WhatsApp channel — Twilio webhook maps phone to customerId
- Staff members authenticated via the same OTP flow are restricted to `/admin` routes; they cannot place orders through the customer agent
- CustomerProfile is read at session start to personalise every interaction; written back after orders, explicit preference statements, and reviews

### Out of scope

- Staff scheduling — not in scope
- Multi-tenant (multiple restaurants) — Phase 4+

---

## 6. Intelligence

**Owner:** Custom (`packages/domain` types, Redis for profiles, NATS for events, Postgres for reviews)

### Entities

| Entity | Key fields |
|---|---|
| CustomerProfile | (see Identity context — shared entity, Intelligence context reads and writes it) |
| Review | id, orderId, productIds[], customerId, rating: 1–5, comment, channel, createdAt |
| Recommendation | customerId, products[], reason: favourite/trending/pairing/seasonal, generatedAt |
| BusinessEvent | eventType, customerId?, sessionId, channel, timestamp, metadata (see customer-intelligence.md) |

### Rules

- Recommendations **never** surface: out-of-stock items, items outside their availability window, items matching customer allergens
- Reviews are requested **once per order**, 30 minutes after `order.delivered` status — never during ordering
- If a review rating is ≤ 2, the case is automatically escalated to staff + the agent offers a resolution ("posso ajudar a resolver?")
- Allergens are **only** set explicitly by the customer — never inferred (safety rule)
- Dietary restrictions may be inferred from order history after 10+ consistent orders, but only as a suggestion ("notei que você prefere pratos vegetarianos — posso filtrar o cardápio?")
- All significant business events are published to NATS — PostHog consumes in real-time, ClickHouse consumes in Phase 3 for BI

### Out of scope

- ML/embedding-based recommendations — Phase 3 (rule-based is sufficient for Phase 1)
- A/B testing — Phase 2
- Predictive inventory — Phase 3

---

## 7. Shop

**Owner:** Medusa.js v2 (same product module as Catalog — `productType: merchandise`)
**Interface:** Standard storefront UI at `/loja` — no agent tools in Phase 1

The Shop is a standard e-commerce section for branded merchandise (camisetas, accessories, kits). It runs on the same Medusa backend and cart system as the restaurant but is a completely separate customer-facing area.

### Entities

Same Commerce entities (Cart, Order, Payment) shared with the restaurant. Products distinguished by `productType: merchandise`.

### Rules

- Merchandise is always available — no availability windows, no preparation time
- No special instructions per item (merchandise is shipped, not prepared)
- Shipping for merchandise uses Correios/EasyPost (CEP-based standard shipping rates) — not the restaurant's delivery zones
- Boleto **is** available for merchandise (standard e-commerce — no same-day fulfilment constraint)
- The agent can answer questions about merchandise but does not process shop orders — storefront UI is the primary interface for `/loja` in Phase 1
- Shop orders generate NF-e via Focus NFe API (same as restaurant orders — Brazilian tax law)

### Out of scope

- Agent-driven merchandise ordering — Phase 2
- WhatsApp shop browsing — Phase 2

---

## 8. Admin

**Owner:** Custom — `/admin` routes in `apps/web` + dedicated API endpoints in `apps/api`
**Access:** All `/api/admin/*` routes require `x-admin-key` header — no customer can access this area

The Admin panel is the owner's control center. It replaces the raw Medusa admin as the primary management interface and adds reservation management, delivery zone config, and analytics in one place.

### Entities

| Entity | Key fields |
|---|---|
| AdminUser | phone, role: manager/kitchen/cashier, active |
| MenuConfig | featuredProducts[], categoryOrder[], activeAvailabilityWindows |
| TableLayout | tables[], activeSlots[], defaultSlotDuration |
| DeliveryZoneConfig | zones[], fees[], estimatedTransitTimes[] |
| StaffNotification | type: low_rating/unanswered_question/handoff_request, payload, resolvedAt |

### Rules

- All `/api/admin/*` routes require a valid `x-admin-key` header — 401 for missing/invalid key
- Admin manages **both** the food menu and the shop catalog through one interface — no need to switch systems
- Admin can view, filter, and update all orders (restaurant + shop) and all reservations
- Analytics pulls from PostHog (real-time) — no raw database queries in Phase 1
- Table layout changes and delivery zone changes take effect immediately
- StaffNotifications are generated by: reviews ≤ 2 stars, agent `handoff_to_human` calls, agent questions that went unanswered

### Out of scope

- Staff scheduling — not in scope
- Multi-location management — Phase 4+
- Raw SQL / BI queries — Phase 3 (ClickHouse)
