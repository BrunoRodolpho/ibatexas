# Agent Tools

The agent interacts with the Restaurant and Intelligence contexts through typed tools. It cannot hallucinate prices, stock, or availability — every fact comes from a tool response. Tools enforce authorization: a guest cannot checkout, a customer cannot see another customer's orders.

**Scope of the agent:** food ordering, reservations, customer intelligence, and support. The Shop (`/loja`) uses the standard storefront UI in Phase 1 — no agent tools for merchandise. The Admin (`/admin`) panel is staff-only and operates independently of the agent.

**Auth levels:**
- `guest` — available to anyone, including anonymous sessions
- `customer` — requires Twilio Verify WhatsApp OTP authentication (JWT cookie)
- `staff` — reserved for internal use (not exposed to customers)

**Tool access model:** the LLM has zero state-mutation authority. It reads facts via read-only tools and proposes mutations only through the single `express_intent` tool (`apps/api/src/claustrum/ibatexas-planner.ts`), which the kernel `adjudicate()`s. Per-tool classification (READ_ONLY vs MUTATING) and per-state visibility are owned by each Pack's `ToolClassification` + `*CapabilityPlanner` (`@adjudicate/core/llm`, e.g. `packages/pack-orders/src/capabilities.ts`); kernel `PolicyBundle` guards (`canCancelOrder`, `canAmendOrder`, `hasOrderId` in `packages/pack-orders/src/policies.ts`) gate invalid operations. The full rationale and contract is **ADR #9 — Intent-Gated Execution** in [docs/architecture/decisions.md](../decisions.md).

The roster below is the **20 LLM-callable mutating tools** plus the read-only tools, assembled by `apps/api/src/tools/register-ibatexas-tool-packs.ts` (`listIbatexasToolPacks()`). FE-T09 (D-a) replaced the grouped `amend_order` tool with three granular post-checkout amend tools (add item / update quantity / remove item on a placed order) — the model targets these directly now; the legacy grouped kind (`order.amend.request`) still exists at the kernel level but is reachable only via the deterministic legacy HTTP amend route, never through this tool roster.

**Model-facing payloads are narrowed.** For each mutating tool below the **Input** cell is what the LLM may actually produce through `express_intent`: a per-capability extraction schema (`apps/api/src/claustrum/language-engine/*.schema.ts`) strips every Identity-class identifier (`cartId`, `orderId`, `itemId`, …) and every safety-critical / PII field (`allergens`, `cpf`, `email`, …) from the model's reach — the runtime resolver fills those. A row whose Input reads *"(none model-facing)"* carries an empty schema: the utterance selects the capability and the runtime supplies the entire wire payload.

**Not every documented tool is LLM-callable.** A few customer-facing tools — `reorder`, `change_delivery_address`, and `switch_order_type` — are reachable only through the deterministic order-actions HTTP route (`apps/api/src/routes/order-actions.ts`), **not** through `express_intent`. They have no chat-tier capability and appear in no planner's `allowedIntents`, so the model never proposes them directly; they map to the identity-tier kernel kinds `order.reorder`, `order.address.change`, and `order.type.switch` (and therefore carry no `legacyNames` entry in the capability registry). Their rows below are marked accordingly — this is the same "real tool, not agent-proposable" status the retired grouped `amend_order` kind (`order.amend.request`) has.

---

## Catalog Tools

All catalog tools are available to `guest`.

### `search_products`
Search the product catalog with optional filters.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `query: string`, `tags?: string[]`, `availableNow?: boolean`, `excludeAllergens?: string[]`, `limit?: number` |
| **Output** | `{ products: { id, name, description, price, images, rating, tags, availableNow, preparationTime }[] }` |
| **Notes** | Queries Typesense. `availableNow` filters by current time against AvailabilityWindow. `excludeAllergens` applied from CustomerProfile if available |

### `get_product_details`
Retrieve full product information including gallery, variants, nutritional info, allergens, and related products.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `productId: string` |
| **Output** | `{ id, name, description, images[], variants[], nutritionalInfo, allergens[], tags[], preparationTime, availabilityWindow, relatedProducts[], rating, reviewCount }` |
| **Notes** | Publishes `product.viewed` NATS event |

### `check_inventory`Check real-time stock for a specific product variant.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `variantId: string` |
| **Output** | `{ available: boolean, quantity: number, nextAvailableAt?: string }` |
| **Notes** | `add_to_cart` validates stock internally; this tool is for explicit pre-check |

### `get_nutritional_info`Retrieve ANVISA-format nutritional data for a product.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `productId: string` |
| **Output** | `{ per100g: { calories, protein, fat, saturatedFat, carbohydrates, sugars, fiber, sodium }, servingSize, servingsPerPackage }` |
| **Notes** | `get_product_details` already returns `nutritionalInfo`; this tool provides the full ANVISA breakdown |

---

## Commerce Tools

### `get_cart`
Retrieve the current cart contents.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `sessionId: string` |
| **Output** | `{ cartId, items: { productId, variantId, name, quantity, unitPrice, specialInstructions }[], subtotal, couponDiscount, estimatedDeliveryFee, total }` |

### `get_or_create_cart`
Ensure an active cart exists for the session, creating one if none is open. Mutating tool — proposed as the `order.cart.ensure` intent.

| | |
|---|---|
| **Auth** | guest |
| **Input** | (none model-facing — the active cart is resolved from the session; the wire `cartId` is resolver-filled) |
| **Output** | `{ cartId, items[], subtotal, total }` |
| **Notes** | Registry: `order.cart.ensure`, tool id `ibatexas.cart.ensure.v1`, `riskLevel: low`. The LLM extracts no fields; the runtime resolves the session's active cart (BKL-028) |

### `add_to_cart`
Add a product variant to the cart. Validates stock before adding.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `sessionId: string`, `variantId: string`, `quantity: number`, `specialInstructions?: string` |
| **Output** | `{ success: boolean, cartId, item, updatedCart }` |
| **Notes** | Calls `check_inventory` internally. Publishes `cart.item_added` NATS event |

### `update_cart`
Update quantity or special instructions for an existing cart item.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `sessionId: string`, `variantId: string`, `quantity?: number`, `specialInstructions?: string` |
| **Output** | `{ success: boolean, updatedCart }` |

### `remove_from_cart`
Remove an item from the cart.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `sessionId: string`, `variantId: string` |
| **Output** | `{ success: boolean, updatedCart }` |

### `apply_coupon`
Apply a coupon code to the current cart.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `sessionId: string`, `couponCode: string` |
| **Output** | `{ valid: boolean, discount: number, message: string }` |

### `estimate_delivery`
Get delivery fee and estimated time for a CEP.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `cep: string`, `sessionId: string` |
| **Output** | `{ deliverable: boolean, zone?: string, fee?: number, estimatedMinutes?: number, reason?: string }` |
| **Notes** | Validates CEP via ViaCEP. Returns `deliverable: false` if CEP is outside all delivery zones |

### `create_checkout`
Initiate checkout and generate a payment. Requires authentication.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `sessionId: string`, `deliveryType: 'delivery' \| 'pickup' \| 'dine-in'`, `addressId?: string`, `paymentMethod: 'pix' \| 'card' \| 'cash'`, `tip?: number`, `pickupTime?: string` |
| **Output** | `{ orderId, paymentMethod, pixQrCode?: string, pixExpiry?: string, stripePaymentUrl?: string, estimatedTime: number }` |
| **Notes** | Migrates guest cart to authenticated customer cart in Medusa. Publishes `order.placed` NATS event |

### `check_order_status`
Get current status and estimated time for an order.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `orderId: string` |
| **Output** | `{ orderId, status, statusLabel: string, estimatedDeliveryAt?: string, deliveryPersonName?: string }` |
| **Notes** | Only returns order if `customerId` matches — no cross-customer access |

### `cancel_order`
Cancel an order. Only possible while status is `received` or `confirmed`.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `orderId: string`, `reason?: string` |
| **Output** | `{ success: boolean, refundStatus?: string, message: string }` |

### `amend_order_add_item`
Add an item to an already-placed order (post-checkout). Mutating tool — proposed as the `order.amend.add_item` intent. One of the three granular successors to the retired grouped `amend_order` tool.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `item: string` (natural-language item reference), `quantity?: number` |
| **Output** | `{ success: boolean, message: string }` |
| **Notes** | Registry: `order.amend.add_item`, tool id `ibatexas.order.amend.addItem.v1`, `riskLevel: high`. The runtime resolves `item` to a variant and the product's **explicit stored** `allergens` array (never inferred; the kernel `requireExplicitAllergens` guard REFUSEs otherwise). `orderId` is resolver-filled (auto-resolves to the most recent order) |

### `amend_order_update_qty`
Change the quantity of an item on an already-placed order (post-checkout). Mutating tool — proposed as the `order.amend.update_qty` intent.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `item: string` (natural-language item reference), `quantity: number` |
| **Output** | `{ success: boolean, message: string }` |
| **Notes** | Registry: `order.amend.update_qty`, tool id `ibatexas.order.amend.updateQty.v1`, `riskLevel: high`. `orderId`/`itemId` are resolver-filled from the live order; an ambiguous item reference surfaces an honest disambiguation reply |

### `amend_order_remove_item`
Remove an item from an already-placed order (post-checkout). Mutating tool — proposed as the `order.amend.remove_item` intent.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `item: string` (natural-language item reference) |
| **Output** | `{ success: boolean, message: string }` |
| **Notes** | Registry: `order.amend.remove_item`, tool id `ibatexas.order.amend.removeItem.v1`, `riskLevel: high`. `orderId`/`itemId` are resolver-filled from the live order |

### `reorder`
Recreate a previous order as a new cart.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `orderId?: string` (if omitted, uses `lastOrder` from CustomerProfile) |
| **Output** | `{ cartId, items[], unavailableItems: string[], message: string }` |
| **Notes** | Items no longer available or out of stock are excluded and reported |

### `get_order_history`
List past orders for the authenticated customer.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `limit?: number`, `offset?: number` |
| **Output** | `{ orders: { orderId, date, items[], total, status, deliveryType }[] }` |

### `change_delivery_address`
Update shipping address on a delivery order. **Not LLM-callable** — reachable only via the deterministic order-actions HTTP route (`apps/api/src/routes/order-actions.ts`), not through `express_intent`.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `orderId: string`, `addressId: string` |
| **Output** | `{ success: boolean, message: string }` |
| **Notes** | Handler `changeDeliveryAddress` (`packages/tools/src/cart/change-delivery-address.ts`); maps to the identity-tier kernel kind `order.address.change` (no chat-tier capability, so no `legacyNames` entry in the registry). Validates PONR (point of no return) and order type — only valid for `delivery` orders before `in_delivery` status |

### `switch_order_type`
Switch between delivery, pickup, and dine-in for an existing order. **Not LLM-callable** — reachable only via the deterministic order-actions HTTP route, not through `express_intent`.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `orderId: string`, `newType: 'delivery' \| 'pickup' \| 'dine_in'`, `addressId?: string` |
| **Output** | `{ success: boolean, message: string }` |
| **Notes** | Handler `switchOrderType` (`packages/tools/src/cart/switch-order-type.ts`); maps to the identity-tier kernel kind `order.type.switch` (no chat-tier capability, so no `legacyNames` entry in the registry). Handles cash method restrictions — cash is not available for delivery in some zones. Validates PONR |

### `add_order_note`
Add an observation or special instruction to an order.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `orderId: string`, `content: string` (max 500 chars) |
| **Output** | `{ success: boolean, noteId: string, message: string }` |
| **Notes** | WhatsApp channel only. Note is stored as customer-visible (`isInternal: false`). |

### `check_payment_status`
Query the current payment status for an order. READ_ONLY tool — no mutations.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `orderId: string` |
| **Output** | `{ hasPayment, paymentId, method, status, statusLabel, amountInCentavos, pixExpiresAt?, isTerminal, canRetry, canRegenPix, canSwitchMethod, attemptCount }` |
| **Notes** | Returns full eligibility flags for retry/regen/switch. Uses PaymentQueryService. |

### `regenerate_pix`
Generate a fresh PIX code for a pending payment whose code expired. Mutating tool — proposed as the `payment.pix.regenerate` intent.

| | |
|---|---|
| **Auth** | customer |
| **Input** | (none model-facing — the target order is resolver-filled and auto-resolves to the customer's most recent PIX-eligible order) |
| **Output** | `{ success: boolean, pixQrCode?: string, pixExpiry?: string, message: string }` |
| **Notes** | Registry: `payment.pix.regenerate`, tool id `ibatexas.payment.regeneratePix.v1`, `riskLevel: high`, `requiresConfirmation: true`. The only customer-driven `pack-payments` kind with a chat tool |

---

## Reservation Tools

### `check_table_availability`
Find available time slots for a given date and party size.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `date: string`, `partySize: number`, `preferredTime?: string` |
| **Output** | `{ slots: { timeSlotId, startTime, tableLocation, availableCovers }[] }` |

### `create_reservation`
Book a table. Requires authentication.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `timeSlotId: string`, `partySize: number`, `specialRequests?: SpecialRequest[]` |
| **Output** | `{ reservationId, confirmed: boolean, tableLocation, dateTime, confirmationMessage: string }` |
| **Notes** | Sends WhatsApp confirmation message. Publishes `reservation.created` NATS event |

### `modify_reservation`
Change date, time, party size, or special requests for an existing reservation.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `reservationId: string`, `newTimeSlotId?: string`, `newPartySize?: number`, `specialRequests?: SpecialRequest[]` |
| **Output** | `{ success: boolean, reservation, message: string }` |

### `cancel_reservation`
Cancel a reservation.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `reservationId: string`, `reason?: string` |
| **Output** | `{ success: boolean, message: string }` |
| **Notes** | Publishes `reservation.cancelled` NATS event. Notifies next person on waitlist if applicable |

### `get_my_reservations`
List the customer's upcoming and past reservations.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `status?: ReservationStatus`, `limit?: number` |
| **Output** | `{ reservations: { reservationId, dateTime, partySize, tableLocation, status, specialRequests }[] }` |

### `join_waitlist`
Join the waitlist for a fully-booked time slot.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `timeSlotId: string`, `partySize: number` |
| **Output** | `{ waitlistId, position: number, message: string }` |
| **Notes** | Customer notified via WhatsApp when a spot opens. Spot expires 30min after notification if not claimed |

---

## Intelligence Tools

### `get_recommendations`
Get a personalised ranked list of products for the current session context.

| | |
|---|---|
| **Auth** | guest (uses CustomerProfile if available, fallback to popular) |
| **Input** | `sessionId: string`, `context?: 'home' \| 'cart' \| 'post-order'`, `limit?: number` |
| **Output** | `{ products: { id, name, price, rating, reason: string }[] }` |
| **Notes** | Never returns: out-of-stock, outside availability window, or items matching allergens. `reason` is human-readable pt-BR ("porque você costuma pedir", "muito pedido agora") |

### `get_customer_profile`
Retrieve the customer's preference profile.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `customerId: string` |
| **Output** | `{ dietaryRestrictions, allergens, favouriteItems, orderingPatterns, preferredPayment, preferredTableLocation }` |

### `update_preferences`
Update the customer's dietary restrictions, allergens, or other preferences.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `customerId: string`, `dietaryRestrictions?: string[]`, `allergens?: string[]`, `preferredPayment?: string`, `preferredTableLocation?: string` |
| **Output** | `{ success: boolean, updatedProfile }` |
| **Notes** | Allergens are **always set explicitly** — never inferred. Writes to Redis CustomerProfile |

### `save_pix_details`
Save the customer's PIX billing details (name, email, CPF) for future refunds. Mutating tool — proposed as the `customer.pix.details.save` intent.

| | |
|---|---|
| **Auth** | customer |
| **Input** | (none model-facing — `name` / `email` / `cpf` are PII and are **never** LLM-extractable; they are collected through a dedicated explicit flow, e.g. a web-form deep link) |
| **Output** | `{ success: boolean, updatedProfile }` |
| **Notes** | Registry: `customer.pix.details.save`, tool id `ibatexas.customer.setPixDetails.v1`, `riskLevel: medium`. The empty extraction schema structurally blocks the model from smuggling PII into the payload; card PAN is refused and PII redacted at the kernel (`refuseCardPanInPix` / `redactPiiInPix`) |

### `submit_review`
Submit a review for a delivered order.

| | |
|---|---|
| **Auth** | customer |
| **Input** | `orderId: string`, `rating: 1 \| 2 \| 3 \| 4 \| 5`, `comment?: string` |
| **Output** | `{ reviewId, message: string }` |
| **Notes** | Only callable once per order. Rating ≤ 2 triggers staff escalation. Publishes `review.submitted` NATS event. Updates product rolling average rating |

### `get_also_added`
Return products frequently added to cart alongside a given product in the current session.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `productId: string`, `limit?: number` |
| **Output** | `{ products: { id, name, price, reason: string }[] }` |
| **Notes** | Uses Redis co-purchase sorted set (`copurchase:{productId}`). Falls back to global score if no co-purchase data. Respects allergen exclusions from CustomerProfile |

### `get_ordered_together`
Return products historically ordered together with the current cart contents.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `sessionId: string`, `limit?: number` |
| **Output** | `{ products: { id, name, price, reason: string }[] }` |
| **Notes** | Unions co-purchase sorted sets for all cart items; deduplicates against current cart |

---

## Support Tools

### `request_human_handoff`

Escalate the conversation to a human staff member. Mutating tool — proposed as the `whatsapp.handoff.request` intent.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `reason?: string` (free text; `sessionId` is runtime-injected from the turn context, never model-supplied) |
| **Output** | `{ success: boolean, estimatedWaitMinutes?: number, message: string }` |
| **Notes** | Registry: `whatsapp.handoff.request` (pack-whatsapp), tool id `ibatexas.support.handoffToHuman.v1`, `riskLevel: low` — the one guest-accessible verb in the 20-tool roster. Kernel-adjudicated; the free-text reason is audit-redacted; the executor publishes `support.handoff_requested` into the handoff spine, notifies staff via internal WhatsApp, and preserves full conversation context. **Name disambiguation:** the registry legacy (snake_case) tool name is `request_human_handoff` (this heading); the underlying executor function is `handoffToHuman` (`packages/tools/src/support/handoff-to-human.ts`) — two names, one path |
