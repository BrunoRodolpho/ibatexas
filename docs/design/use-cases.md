# Use Cases

IbateXas has three distinct areas with different interaction models:

- **Restaurant** (menu, ordering, reservations) — agent is the preferred interface; full storefront UI also available
- **Shop** (`/loja`) — standard e-commerce for merchandise; storefront UI only in Phase 1
- **Admin** (`/admin`) — staff-only control panel; standard UI, no agent

In-Person capabilities are Phase 3.

---

## Catalog

| Use Case | Web | WhatsApp | In-Person |
|---|:---:|:---:|:---:|
| Browse by category | ✅ | ✅ | — |
| Search products by name or description | ✅ | ✅ | — |
| Filter by tag (vegetariano, sem glúten, disponível agora) | ✅ | ✅ | — |
| View product detail + image gallery | ✅ | ✅ | — |
| View nutritional info (ANVISA) | ✅ | ✅ | — |
| View allergen information | ✅ | ✅ | — |
| View ratings + customer reviews | ✅ | ✅ | — |
| View availability window (almoço / jantar / congelados) | ✅ | ✅ | — |
| View related products ("vai bem com") | ✅ | ✅ | — |

---

## Commerce

| Use Case | Web | WhatsApp | In-Person |
|---|:---:|:---:|:---:|
| Add item to cart (with optional special instructions) | ✅ | ✅ | — |
| View cart | ✅ | ✅ | — |
| Update item quantity | ✅ | ✅ | — |
| Update item special instructions | ✅ | ✅ | — |
| Remove item from cart | ✅ | ✅ | — |
| Apply coupon code | ✅ | ✅ | — |
| Choose delivery type: delivery / pickup / dine-in | ✅ | ✅ | ✅ |
| Select pickup time slot | ✅ | ✅ | ✅ |
| Checkout + pay via PIX | ✅ | ✅ | ✅ |
| Checkout + pay via credit card | ✅ | ✅ | ✅ |
| Checkout + pay via cash (on delivery or at pickup) | ✅ | ✅ | ✅ |
| Add tip (gorjeta) | ✅ | ✅ | ✅ |
| Track order status in real-time | ✅ | ✅ | — |
| Receive proactive status notifications | — | ✅ | — |
| Cancel order (while status is received or confirmed) | ✅ | ✅ | — |
| Reorder (last order or favourite order) | ✅ | ✅ | — |
| View order history | ✅ | ✅ | — |
| Download NF-e (tax invoice) | ✅ | ✅ | — |

---

## Logistics

| Use Case | Web | WhatsApp | In-Person |
|---|:---:|:---:|:---:|
| Validate delivery address via CEP | ✅ | ✅ | — |
| Get delivery fee + estimated time | ✅ | ✅ | — |
| Save delivery address to profile | ✅ | ✅ | — |
| Choose from saved addresses | ✅ | ✅ | — |

---

## Reservation

| Use Case | Web | WhatsApp | In-Person |
|---|:---:|:---:|:---:|
| Check table availability (date, time, party size) | ✅ | ✅ | ✅ |
| Make a reservation | ✅ | ✅ | ✅ |
| Add special requests (birthday, highchair, accessible, etc.) | ✅ | ✅ | ✅ |
| Receive reservation confirmation via WhatsApp | — | ✅ | — |
| View my reservations | ✅ | ✅ | — |
| Modify reservation (date / time / party size / requests) | ✅ | ✅ | ✅ |
| Cancel reservation | ✅ | ✅ | ✅ |
| Join waitlist when fully booked | ✅ | ✅ | — |
| Get notified when waitlist spot opens | — | ✅ | — |
| Check in on arrival | — | ✅ | ✅ |
| Order at table | — | — | ✅ Phase 3 |
| Request bill / split bill | — | — | ✅ Phase 3 |

---

## Intelligence

| Use Case | Web | WhatsApp | In-Person |
|---|:---:|:---:|:---:|
| Receive personalised product suggestions | ✅ | ✅ | — |
| Smart reorder ("seu pedido de sempre?") | ✅ | ✅ | — |
| Get cross-sell suggestions during cart ("vai bem com") | ✅ | ✅ | — |
| Update dietary preferences | ✅ | ✅ | — |
| Update allergen profile | ✅ | ✅ | — |
| Receive post-delivery review request (30min after delivery) | — | ✅ | — |
| Submit product review | ✅ | ✅ | — |
| Receive reservation reminder (Phase 2) | — | ✅ | — |

---

## Support

| Use Case | Web | WhatsApp | In-Person |
|---|:---:|:---:|:---:|
| Ask the agent any question about the menu or restaurant | ✅ | ✅ | — |
| Escalate to human staff | ✅ | ✅ | ✅ |
| Report a problem with an order | ✅ | ✅ | — |

---

## Shop (`/loja`)

Branded merchandise — camisetas, accessories, gift sets. Standard e-commerce, no agent.

| Use Case | Web | WhatsApp | In-Person |
|---|:---:|:---:|:---:|
| Browse merchandise by category | ✅ | — | — |
| Search merchandise | ✅ | — | — |
| View product detail + images | ✅ | — | — |
| View size guide / variants | ✅ | — | — |
| Add to cart | ✅ | — | — |
| Checkout via PIX | ✅ | — | — |
| Checkout via credit card | ✅ | — | — |
| Checkout via boleto | ✅ | — | — |
| Track shipping | ✅ | — | — |
| View order history (shop) | ✅ | — | — |
| Download NF-e | ✅ | — | — |
| WhatsApp shop browsing | — | Phase 2 | — |

---

## Admin (`/admin` — staff only)

| Capability | Phase |
|---|---|
| Dashboard: orders, revenue, reservations, active escalations | 1 |
| Manage food menu (create / edit / archive products, prices, images, tags) | 1 |
| Manage shop catalog (merchandise products, variants, stock) | 1 |
| Manage availability windows (almoço, jantar, especial) | 1 |
| View and manage all orders (restaurant + shop) | 1 |
| View and manage all reservations | 1 |
| Check in guests (transition reservation → seated) | 1 |
| Manage delivery zones + fees + estimated times | 1 |
| Manage table layout + time slot configuration | 1 |
| View customer reviews + handle escalations (rating ≤ 2) | 1 |
| Analytics dashboard (PostHog embed) | 1 |
| Manage staff accounts + roles | 2 |
| Proactive WhatsApp campaigns | 2 |
| Inventory alerts (low-stock) | 2 |

---

## Notes on Channel Behaviour

**Web (Restaurant):** The agent chat widget coexists with the full storefront UI. Customers can browse the menu, build a cart, and checkout without ever opening the chat. The chat widget is a floating button on mobile (full-screen overlay) and a side panel on desktop. The Shop (`/loja`) and Admin (`/admin`) sections have no chat widget.

**WhatsApp:** Pure conversation. The agent uses WhatsApp's native message types: list messages for menus, buttons for confirmations, image messages for product photos, and payment links for checkout. Always professional pt-BR.

**In-Person (Phase 3):** QR code on table opens a WhatsApp conversation pre-configured with the table number. Same agent, same tools, dine-in context.
