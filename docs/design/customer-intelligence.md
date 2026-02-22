# Customer Intelligence

The intelligence layer is what separates IbateXas from a basic ordering app. Every conversation is data. Every tool call is a signal. The system gets smarter with every interaction — for both the customer and the business owner.

---

## Customer-Facing Intelligence

### CustomerProfile

Stored in Redis per authenticated customer. Key: `profile:{customerId}`. TTL: 30 days, refreshed on every meaningful activity.

```
{
  dietaryRestrictions: string[]    // e.g. ['vegetariano', 'sem_gluten']
  allergens: string[]              // e.g. ['lactose', 'castanhas']
  favouriteItems: string[]         // top 5 productIds by order frequency (last 90 days)
  lastOrder: {
    orderId: string
    items: { productId, name, quantity }[]
    placedAt: string
  }
  orderingPatterns: {
    preferredDays: number[]        // 0 = Sunday, 6 = Saturday
    preferredHour: number          // 0–23, based on last 10 orders
    avgSpend: number               // centavos BRL, rolling average
  }
  preferredPayment: 'pix' | 'card' | 'cash'
  preferredTableLocation: 'indoor' | 'outdoor' | 'bar' | 'terrace' | null
}
```

**How it's populated:**
- `dietaryRestrictions` — set by customer via `update_preferences` OR suggested by agent after detecting a pattern ("notei que você prefere pratos vegetarianos — posso filtrar o cardápio?"). Customer must confirm.
- `allergens` — **only set explicitly** by the customer. Never inferred. Safety rule: a false negative (missing allergen) is dangerous.
- `favouriteItems` — computed from Medusa order history on first login, updated after each order
- `lastOrder` — written after every `order.placed` event
- `orderingPatterns` — rolling computation from last 10 orders
- `preferredPayment` — most-used payment method from last 5 orders
- `preferredTableLocation` — most common table location from reservation history

**How the agent uses it:**
- Read at session start — silently applies dietary filters to `search_products` and `get_recommendations`
- Used in `get_recommendations` to personalise suggestions
- Used to pre-fill preferences during checkout ("pagar com PIX como de costume?")
- Used to surface reservation preference ("mesa interna como sempre?")

---

### Recommendations

The `get_recommendations` tool returns a ranked list for the current session context. Phase 1 uses rule-based logic — no ML required.

**Ranking rules (in order of priority):**

1. **Favourites available now** — CustomerProfile `favouriteItems` that are in stock and within their availability window
2. **Smart reorder** — if current time matches `orderingPatterns.preferredHour` ± 1h, offer "seu pedido de sempre?" with `lastOrder` items (if all available)
3. **Cross-sell** — items from Medusa product metadata `RelatedProduct` relationships matching current cart contents
4. **Trending** — top-sold items in the last 2 hours (from NATS `order.placed` events aggregated in Redis)
5. **Top-rated** — products with highest rating, filtered by availability

**Hard filters (always applied):**
- Out of stock → excluded
- Outside availability window → excluded
- Matches customer allergens → excluded
- Already in cart → excluded from recommendations

**`reason` field** (shown to customer in pt-BR):
- Favourites: "porque você costuma pedir"
- Reorder: "seu pedido de toda [dia]"
- Cross-sell: "vai muito bem com o que está no seu carrinho"
- Trending: "muito pedido agora"
- Top-rated: "avaliado com 4.8 ⭐ pelos clientes"

---

### Review Lifecycle

Reviews are collected post-delivery, not at order time. Customers are not asked while they're hungry and waiting — they're asked after they've eaten.

**Flow:**

```
1. order.delivered event published (NATS)
        ↓
2. Wait 30 minutes
   (NATS delayed message or Redis scheduled job)
        ↓
3. Agent sends WhatsApp message:
   "Olá [nome]! 😊 Como foi seu [produto principal]?
    Avalie de 1 a 5: basta responder com o número.
    1 ⭐ = ruim   5 ⭐ = perfeito"
        ↓
4. Customer replies: "4" (or "muito bom!", "5 estrelas", etc.)
   Agent interprets and extracts rating
        ↓
5. submit_review tool called:
   - Review stored in Postgres
   - Product rolling average rating updated
   - review.submitted NATS event published
        ↓
6. Agent responds:
   rating ≥ 4: "Ótimo! Ficamos felizes. 💚 Até o próximo pedido!"
   rating = 3: "Obrigado pelo feedback! Vamos melhorar."
   rating ≤ 2: "Lamentamos! Vou acionar nossa equipe para resolver. [handoff_to_human]"
```

**Rules:**
- One review request per order, maximum
- If customer doesn't respond within 48h, no retry
- Review is optional — ignoring it is fine
- Web: review prompt also shown on order history page after delivery

---

## Business Owner Intelligence

### NATS Event Bus

All significant actions publish events to NATS JetStream. Consumers:
- **PostHog** (real-time product analytics, Phase 1)
- **ClickHouse** (historical BI queries, Phase 3)

Every event follows this envelope:
```typescript
{
  eventType: string
  sessionId: string
  customerId: string | null  // null for guest events
  channel: 'web' | 'whatsapp'
  timestamp: string          // ISO 8601 UTC
  metadata: { ... }          // event-specific
}
```

### Event catalogue

| Event | When | Key metadata |
|---|---|---|
| `product.viewed` | `get_product_details` called | productId, source |
| `product.added_to_cart` | `add_to_cart` success | productId, variantId, quantity |
| `cart.abandoned` | Redis TTL expiry on guest session | cartId, items[], totalValue |
| `order.placed` | checkout success | orderId, items[], totalValue, paymentMethod, deliveryType |
| `order.confirmed` | kitchen confirms | orderId |
| `order.cancelled` | `cancel_order` success | orderId, reason |
| `order.delivered` | status update | orderId, deliveryMinutes |
| `reservation.created` | `create_reservation` success | reservationId, partySize, date, tableLocation |
| `reservation.modified` | `modify_reservation` success | reservationId, changes |
| `reservation.cancelled` | `cancel_reservation` success | reservationId, reason |
| `reservation.no_show` | 15min grace elapsed | reservationId |
| `review.submitted` | `submit_review` success | reviewId, productIds[], rating |
| `agent.tool_called` | every tool call | tool, durationMs, success, error? |
| `agent.question_unanswered` | tool fails with "not found" | query, tool |
| `customer.first_order` | first `order.placed` for customerId | orderId, customerId |
| `customer.returned` | 2nd+ `order.placed` for customerId | orderId, daysSinceLastOrder |

---

### Key Business Metrics (PostHog Dashboards)

**Sales**
- Orders today: count, total revenue, avg ticket
- Orders by hour (heatmap) — staffing decisions
- Payment method breakdown: PIX % / card % / cash %
- Delivery vs pickup vs dine-in split

**Products**
- Top sellers by revenue and units
- Most abandoned cart items (added but not purchased)
- Conversion rate: viewed → added → purchased per product
- Products with most `agent.question_unanswered` events → catalog gaps

**Reservations**
- Occupancy by day and time slot
- No-show rate
- Average party size
- Most-requested special requests

**Agent Performance**
- Tool call success rate per tool
- Average tool response time
- `agent.question_unanswered` topics — what the agent can't answer
- Sessions by channel (web vs WhatsApp)

**Customers**
- New vs returning customer ratio
- Customer lifetime value (LTV) — avg total spend per customer
- Churn signal: customers with no order in 60+ days
- Most common dietary restrictions and allergens

---

### Owner Dashboard (Phase 2)

A simple `/admin` page in `apps/web` (protected by Clerk staff role) showing:

- Today at a glance: orders, revenue, avg ticket, reservations
- Active orders: live list with current status
- Today's reservations: timeline view
- Agent health: tool success rate, unanswered questions
- Top products this week

This is distinct from the Medusa admin (`/app`) which handles product/inventory management. The owner dashboard is operational — real-time visibility for running the restaurant day to day.
