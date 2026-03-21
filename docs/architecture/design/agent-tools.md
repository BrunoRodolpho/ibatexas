# Agent Tools

The agent interacts with the Restaurant and Intelligence contexts through typed tools. It cannot hallucinate prices, stock, or availability — every fact comes from a tool response. Tools enforce authorization: a guest cannot checkout, a customer cannot see another customer's orders.

**Scope of the agent:** food ordering, reservations, customer intelligence, and support. The Shop (`/loja`) uses the standard storefront UI in Phase 1 — no agent tools for merchandise. The Admin (`/admin`) panel is staff-only and operates independently of the agent.

**Auth levels:**
- `guest` — available to anyone, including anonymous sessions
- `customer` — requires Twilio Verify WhatsApp OTP authentication (JWT cookie)
- `staff` — reserved for internal use (not exposed to customers)

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

### `check_inventory` _(not yet implemented)_
Check real-time stock for a specific product variant.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `variantId: string` |
| **Output** | `{ available: boolean, quantity: number, nextAvailableAt?: string }` |
| **Notes** | `add_to_cart` validates stock internally; this tool is for explicit pre-check |

### `get_nutritional_info` _(not yet implemented)_
Retrieve ANVISA-format nutritional data for a product.

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

### `handoff_to_human` _(not yet implemented)_
Escalate the conversation to a human staff member.

| | |
|---|---|
| **Auth** | guest |
| **Input** | `sessionId: string`, `reason?: string` |
| **Output** | `{ success: boolean, estimatedWaitMinutes?: number, message: string }` |
| **Notes** | Notifies staff via internal WhatsApp. Preserves full conversation context for the staff member |
