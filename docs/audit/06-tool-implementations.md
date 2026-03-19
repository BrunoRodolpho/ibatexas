# 06 Audit: Tool Implementation Quality

## Executive Summary

Audited all 26 AI agent tool implementations plus shared clients (Medusa, Typesense) and the tool-registry dispatch layer. The codebase is well-structured with consistent patterns, but several findings require attention:

**Critical (2):**
1. **C-01: `withCustomerId` allows LLM-supplied customerId to bypass context identity** — if the LLM fabricates a customerId in the tool input, it is passed through without comparison to `ctx.customerId`, enabling cross-user impersonation on 5 reservation tools.
2. **C-02: Cart tools (get_cart, add_to_cart, update_cart, remove_from_cart, apply_coupon) accept cartId without any ownership verification** — any session can manipulate any cart if the LLM supplies an arbitrary cartId.

**High (3):**
3. **H-01: `reorder` fetches any order via admin API without ownership check** — the tool validates `ctx.customerId` is present but does not verify the requested orderId belongs to that customer before cloning its items.
4. **H-02: `create_checkout` has no minimum-total guard** — a cart with $0 total can proceed to checkout (cash flow completes immediately with `order.placed` event).
5. **H-03: Tool inputs are not Zod-validated at runtime in tool-registry** — the registry casts `input as T` (type-only, no runtime check); Zod `.parse()` happens inside each tool, but the `withCustomerId` HOF processes input *before* Zod runs, meaning malformed input shapes reach the injection logic unchecked.

**Medium (3):**
6. **M-01: `estimate_delivery` makes external HTTP call to ViaCEP with 5s timeout but continues on failure** — not a bug per se, but a ViaCEP outage silently skips validation, potentially accepting invalid CEPs.
7. **M-02: `search_products` swallows Typesense errors and returns empty results** — no error surfaced to user or monitoring.
8. **M-03: No test for `estimate_delivery`** — the only tool without a corresponding test file.

Overall: 25 of 26 tools have tests. Auth patterns are split between `withCustomerId` (reservation tools) and inline `ctx.customerId` checks (cart/intelligence tools). NATS events consistently use short-form subjects. Medusa client has proper 10s timeout via `AbortSignal.timeout`. Redis keys consistently use `rk()`. Prices are integer centavos throughout.

---

## Scope

Audit of all 26 AI agent tool implementations in `packages/tools/src/`, the tool-registry dispatch layer in `packages/llm-provider/src/tool-registry.ts`, and shared clients (Medusa HTTP client, Typesense client). Coverage: error handling, auth checks, price handling, allergen safety, NATS events, timeouts, idempotency, test coverage, and AI safety guarantees.

---

## System Invariants (Must Always Be True)

1. No tool can create a $0 order
2. No tool can access another customer's data
3. No tool can bypass payment
4. Allergens are NEVER inferred (always explicit `[]`)
5. Prices are ALWAYS integer centavos
6. Redis keys always use `rk()` from `@ibatexas/tools`
7. NATS events use short-form subjects (no `ibatexas.` prefix)

**Invariant Status:**

| # | Invariant | Status | Evidence |
|---|-----------|--------|----------|
| 1 | No $0 order | **VIOLATED** (H-02) | `create_checkout` has no minimum-total guard; cash checkout completes immediately |
| 2 | No cross-customer data access | **VIOLATED** (C-01, C-02) | `withCustomerId` passes LLM-supplied customerId; cart tools have no ownership check |
| 3 | No payment bypass | OK | Stripe PIX/card confirmed via webhook; cash completes via Medusa `cart/complete` which should enforce payment |
| 4 | Allergens never inferred | OK | `allergens` field is `string[]` in Typesense schema; `passesAllergenFilter` uses explicit array comparison; `update_preferences` Zod schema requires explicit arrays |
| 5 | Prices always integer centavos | OK | Typesense schema uses `int64` for price; `feeInCentavos` in estimate_delivery; `tipInCentavos` in create_checkout |
| 6 | Redis keys use `rk()` | OK | All Redis key construction uses `rk()` from `@ibatexas/tools` |
| 7 | NATS short-form subjects | OK | All `publishNatsEvent` calls use short-form: `"product.viewed"`, `"cart.item_added"`, `"order.placed"`, `"reservation.created"`, etc. |

---

## Assumptions That May Be False

| # | Assumption | Where Assumed | What If False? | Status |
|---|-----------|---------------|---------------|--------|
| 1 | Medusa enforces cart ownership via session/token | All cart tools pass cartId without auth | Any session can read/modify any cart by guessing/fabricating cartId | **UNVERIFIED** — depends on Medusa Store API session binding |
| 2 | Medusa `cart/complete` rejects $0 carts | `create_checkout` has no total guard | $0 orders created, financial loss | **UNVERIFIED** — needs Medusa config audit |
| 3 | LLM will not fabricate customerId in tool input | `withCustomerId` trusts LLM-supplied customerId when present | Cross-user impersonation on reservation tools | **FALSE** — LLM can supply any string |
| 4 | ViaCEP is always reachable | `estimate_delivery` continues on fetch error | Invalid CEPs accepted for delivery | Degraded but acceptable |
| 5 | Typesense is always reachable | `search_products` swallows errors | Empty results with no user-facing error | Degraded, no monitoring |
| 6 | Medusa Store API validates variant_id existence | `add_to_cart` passes LLM-supplied variantId | Non-existent variants could cause cart corruption | Likely OK — Medusa validates, but unverified |
| 7 | Stripe webhook always fires | PIX/card checkout relies on webhook for order confirmation | Orders stuck in pending state forever | Needs timeout/sweep job verification |

---

## Tool Inventory

| # | Tool | Has Tests | Auth Required | Auth Pattern | Events Published | Timeouts | Error Pattern |
|---|------|-----------|---------------|-------------|-----------------|----------|---------------|
| 1 | search_products | Yes | No (guest) | N/A | product.viewed (per result) | Typesense 10s (client-level) | Swallows Typesense errors, returns empty |
| 2 | get_product_details | Yes | No (guest) | N/A | product.viewed | Typesense 10s | 404 -> null; others rethrow |
| 3 | estimate_delivery | **No** | No (guest) | N/A | None | ViaCEP 5s AbortSignal | Swallows ViaCEP errors |
| 4 | get_cart | Yes | No (guest) | None — cartId only | None | Medusa 10s | Rethrows MedusaRequestError |
| 5 | add_to_cart | Yes | No (guest) | None — cartId only | cart.item_added | Medusa 10s | Catches -> `{success:false}` |
| 6 | update_cart | Yes | No (guest) | None — cartId only | None | Medusa 10s | Catches -> `{success:false}` |
| 7 | remove_from_cart | Yes | No (guest) | None — cartId only | None | Medusa 10s | Catches -> `{success:false}` |
| 8 | apply_coupon | Yes | No (guest) | None — cartId only | None | Medusa 10s | Catches -> `{success:false}` |
| 9 | create_checkout | Yes | Implicit (customerId in metadata) | ctx.customerId in metadata | order.placed (cash only) | Medusa 10s; Stripe default | No minimum total guard |
| 10 | get_order_history | Yes | Yes | `ctx.customerId` inline check | None | Medusa 10s | NonRetryableError for auth |
| 11 | check_order_status | Yes | Yes | `ctx.customerId` inline check | None | Medusa 10s | Ownership via OrderService |
| 12 | cancel_order | Yes | Yes | `ctx.customerId` inline check | None | Medusa 10s | Ownership via OrderService |
| 13 | reorder | Yes | Yes | `ctx.customerId` inline check | cart.item_added | Medusa 10s | **No ownership check on orderId** |
| 14 | check_table_availability | Yes | No (guest) | N/A | None | Prisma (no explicit timeout) | Rethrows |
| 15 | create_reservation | Yes | Yes | `withCustomerId` HOF | reservation.created | Prisma (no explicit timeout) | Rethrows from domain service |
| 16 | modify_reservation | Yes | Yes | `withCustomerId` HOF | reservation.modified | Prisma (no explicit timeout) | Catches -> `{success:false}` |
| 17 | cancel_reservation | Yes | Yes | `withCustomerId` HOF | reservation.cancelled | Prisma (no explicit timeout) | Catches -> `{success:false}` |
| 18 | get_my_reservations | Yes | Yes | `withCustomerId` HOF | None | Prisma (no explicit timeout) | Rethrows |
| 19 | join_waitlist | Yes | Yes | `withCustomerId` HOF | None | Prisma (no explicit timeout) | Rethrows |
| 20 | get_customer_profile | Yes | Yes | `ctx.customerId` inline check | None | Redis + Prisma (no explicit timeout) | NonRetryableError for auth |
| 21 | get_recommendations | Yes | No (guest fallback) | Optional ctx.customerId | None | Typesense 10s + Redis | Rethrows |
| 22 | update_preferences | Yes | Yes | `ctx.customerId` inline check | None | Redis + Prisma (no explicit timeout) | NonRetryableError for auth |
| 23 | submit_review | Yes | Yes | `ctx.customerId` inline check | review.submitted | Typesense 10s + Prisma | NonRetryableError for auth |
| 24 | get_also_added | Yes | No (guest) | N/A | None | Redis + Typesense 10s | Returns empty on miss |
| 25 | get_ordered_together | Yes | No (guest fallback) | Optional ctx.customerId | None | Prisma + Typesense 10s | Returns empty for guests |
| 26 | sync_review_stats | Yes | N/A (internal) | N/A | None | Prisma + Typesense | Non-fatal Typesense errors swallowed |

---

## Findings

### Search & Catalog

#### M-02: search_products swallows Typesense errors, returns empty results [Medium]

**Evidence:** `packages/tools/src/search/search-products.ts:412-414`
```typescript
} catch (error) {
  console.error("[Search] Typesense search failed:", error)
}
```
**Blast Radius:** User sees "no results" instead of an error when Typesense is down. No monitoring/alerting surface.
**Exploitability:** Not exploitable, but causes silent degradation.
**Time to Failure:** Immediate when Typesense is unreachable.
**Recommendation:** Return a structured error or throw so the agent can inform the user that search is temporarily unavailable.

#### M-03: estimate_delivery has no test file [Medium]

**Evidence:** No file at `packages/tools/src/catalog/__tests__/estimate-delivery.test.ts`. All other 25 tools have test files.
**Blast Radius:** CEP validation and delivery zone matching are untested at the tool layer.
**Recommendation:** Add tests covering valid CEP, invalid CEP, ViaCEP timeout, and out-of-zone scenarios.

#### L-01: estimate_delivery continues on ViaCEP failure [Low]

**Evidence:** `packages/tools/src/catalog/estimate-delivery.ts:41-43`
```typescript
} catch {
  // ViaCEP unavailable -- continue with prefix matching anyway
}
```
**Blast Radius:** Non-existent CEPs could pass validation if ViaCEP is down, leading to delivery attempts to invalid addresses.
**Recommendation:** Acceptable as-is (graceful degradation), but consider logging a warning for monitoring.

#### OK: search_products Zod-validates input

**Evidence:** `packages/tools/src/search/search-products.ts:605` — `SearchProductsInputSchema.parse(input)` is called first. Input is validated before any processing.

#### OK: NATS events use short-form subjects

**Evidence:** `publishNatsEvent("product.viewed", ...)` at lines 523 and 20 of get-product-details.ts. All correct.

---

### Cart / Commerce

#### C-02: Cart tools accept cartId without ownership verification [Critical]

**Evidence:** `packages/tools/src/cart/get-cart.ts:11`, `add-to-cart.ts:15`, `update-cart.ts:12`, `remove-from-cart.ts:12`, `apply-coupon.ts:12`

All 5 guest cart tools pass `cartId` directly to Medusa Store API without verifying the cart belongs to the current session:
```typescript
// get-cart.ts:11
return medusaStoreFetch(`/store/carts/${parsed.cartId}`);
```

**Blast Radius:** If the LLM fabricates or leaks a cartId from another user, any session can read, add items to, modify, or apply coupons to any cart.
**Exploitability:** Depends on whether Medusa Store API enforces session-based cart ownership. If Medusa uses publishable API key only (no session cookie), any cart is accessible. The `medusaStoreFetch` function at `packages/tools/src/medusa/client.ts:47-64` sends only `x-publishable-api-key` — no session token or customer authentication header.
**Time to Failure:** Immediate if an attacker can guess/enumerate cart IDs (Medusa uses predictable format `cart_*`).
**Production Simulation:** LLM passes `cartId: "cart_01TARGETID"` to `add_to_cart` with arbitrary `variantId` and `quantity` -> items added to victim's cart.
**Recommendation:** Either (a) bind cart to session via Medusa auth headers, or (b) verify cart ownership at the tool layer by checking `cart.customer_id` matches `ctx.customerId`.

#### H-02: create_checkout has no minimum-total guard [High]

**Evidence:** `packages/tools/src/cart/create-checkout.ts:75-171`

The `createCheckout` function proceeds directly to payment session initialization and cart completion without checking the cart total. For `paymentMethod: "cash"`, the cart is completed immediately at line 101:
```typescript
const completedData = await medusaStoreFetch(`/store/carts/${cartId}/complete`, {
  method: "POST",
  body: JSON.stringify({ payment_provider_id: "cash" }),
});
```

**Blast Radius:** A $0 cart (empty or with 100% discount coupon) can be "ordered" via cash, generating an `order.placed` event and consuming system resources.
**Exploitability:** Moderate — requires an empty cart or a coupon that reduces to $0.
**Time to Failure:** Depends on coupon configuration and whether Medusa's cart/complete endpoint validates total > 0.
**Recommendation:** Add a total check before completing: fetch the cart, verify `cart.total > 0`, throw `NonRetryableError` if zero.

#### H-01: reorder fetches any order without ownership verification [High]

**Evidence:** `packages/tools/src/cart/reorder.ts:17`
```typescript
const data = await medusaAdminFetch(`/admin/orders/${parsed.orderId}`) as { ... };
```

The tool checks `ctx.customerId` exists (line 14) but then fetches the order via the **admin** API (bypassing any Medusa session restrictions) and clones its items into a new cart — without checking if the order belongs to `ctx.customerId`.

Compare with `check_order_status` and `cancel_order`, which both use `OrderService.getOrder(orderId, ctx.customerId)` with ownership validation.

**Blast Radius:** An attacker can view another customer's order contents (product names, quantities, variant IDs) by having the LLM call reorder with a fabricated orderId.
**Exploitability:** Requires knowing or guessing an orderId. Medusa uses format `order_*`.
**Production Simulation:** LLM calls `reorder` with `orderId: "order_01TARGETID"` -> tool clones items into a new cart and returns item titles including unavailable items.
**Recommendation:** Use `OrderService.getOrder(parsed.orderId, ctx.customerId)` to verify ownership before cloning.

#### L-02: Inconsistent error patterns across cart tools [Low]

**Evidence:** Comparing cart tools:
- `get_cart` (line 11): Rethrows `MedusaRequestError` directly (no catch).
- `add_to_cart` (line 19-22): Catches and returns `{success: false, message: "..."}`.
- `create_checkout` (lines 75-171): Mixed — some paths throw, some return `{success: false}`.

**Recommendation:** Standardize: either all cart tools catch and return structured error, or all rethrow and let the agent framework handle it. Current inconsistency means the LLM gets different error shapes.

---

### Reservation

#### C-01: withCustomerId allows LLM-supplied customerId to bypass context identity [Critical]

**Evidence:** `packages/llm-provider/src/tool-registry.ts:112-125`
```typescript
function withCustomerId<T extends { customerId?: string }>(
  fn: (input: T) => Promise<unknown>,
): ToolHandler {
  return (input, ctx) => {
    const i = input as T
    if (!i.customerId && ctx.customerId) {
      return fn({ ...i, customerId: ctx.customerId })
    }
    if (!i.customerId && !ctx.customerId) {
      throw new Error("Autenticacao necessaria...")
    }
    return fn(i)  // <-- LLM-supplied customerId passes through unchecked
  }
}
```

When the LLM provides `customerId` in the tool input (line 123: `return fn(i)`), it is **never compared** to `ctx.customerId`. The function only injects from context when input.customerId is absent.

**Affected tools (5):** `create_reservation`, `modify_reservation`, `cancel_reservation`, `get_my_reservations`, `join_waitlist`

**Blast Radius:** The LLM can create reservations, modify reservations, cancel reservations, view reservations, and join waitlists **as any customer** by supplying a fabricated customerId.

The domain service (`reservation.service.ts`) does enforce ownership on modify (line 286: `assertOwnership`) and cancel (line 339: `assertOwnership`), using the customerId **passed by the tool** — which is the LLM-fabricated one. So:
- `modify_reservation`: LLM supplies `customerId: "victim_id"` and `reservationId: "victim_reservation"` -> domain service sees matching customerId -> modification succeeds.
- `create_reservation`: LLM supplies `customerId: "victim_id"` -> reservation created under victim's account.
- `get_my_reservations`: LLM supplies `customerId: "victim_id"` -> victim's reservations returned.

**Exploitability:** High — the LLM tool schema explicitly exposes `customerId` as an input parameter in the tool definitions (e.g., `CreateReservationTool.inputSchema` includes `customerId: {type: "string"}`).
**Time to Failure:** Immediate — no rate limiting or anomaly detection on tool calls.
**Production Simulation:** User A is authenticated. LLM decides to call `cancel_reservation` with `{customerId: "user_B_id", reservationId: "user_B_reservation"}`. `withCustomerId` sees input has `customerId` -> passes through. Domain `cancel()` checks `assertOwnership(reservation.customerId, "user_B_id")` -> matches -> cancellation succeeds.

**Recommendation:** The fix is one line — always prefer `ctx.customerId` over LLM-supplied input:
```typescript
function withCustomerId<T extends { customerId?: string }>(
  fn: (input: T) => Promise<unknown>,
): ToolHandler {
  return (input, ctx) => {
    const i = input as T
    if (!ctx.customerId) {
      throw new Error("Autenticacao necessaria...")
    }
    return fn({ ...i, customerId: ctx.customerId })  // ALWAYS use ctx
  }
}
```

#### OK: Domain service enforces ownership on modify/cancel

**Evidence:** `packages/domain/src/services/reservation.service.ts:286` — `assertOwnership(existing.customerId, customerId, "esta reserva")` in both `modify()` and `cancel()`. However, this is only effective if the customerId parameter is trustworthy, which C-01 demonstrates it is not.

#### OK: Reservation tools publish correct short-form NATS events

**Evidence:** `reservation.created`, `reservation.modified`, `reservation.cancelled` — all short-form.

---

### Intelligence

#### OK: get_customer_profile uses ctx.customerId correctly

**Evidence:** `packages/tools/src/intelligence/get-customer-profile.ts:33-35` — checks `ctx.customerId` presence, then uses `ctx.customerId` (not input) for all Redis/Prisma queries. This is the correct pattern.

#### OK: update_preferences uses ctx.customerId correctly

**Evidence:** `packages/tools/src/intelligence/update-preferences.ts:17-19` — same correct pattern as get_customer_profile.

#### OK: submit_review uses ctx.customerId correctly

**Evidence:** `packages/tools/src/intelligence/submit-review.ts:17-19` — checks ctx, passes ctx.customerId to domain service.

#### L-03: get_recommendations filter_by uses wrong field name for Typesense [Low]

**Evidence:** `packages/tools/src/intelligence/get-recommendations.ts:34`
```typescript
const filters: string[] = ["inStock:=true", "published:=true"];
```
The Typesense schema field is `status` (with values "published"/"draft"), not a boolean `published` field. The search_products tool correctly uses `status:published` in `buildFilterBy()`. This filter would silently fail in Typesense (no field named `published`), returning unfiltered results including draft products.

**Blast Radius:** Draft/unpublished products could appear in recommendations.
**Recommendation:** Change to `"status:=published"` to match the Typesense schema.

#### OK: Allergen handling

Allergens are always explicit arrays throughout:
- `update_preferences`: Zod schema enforces `allergenExclusions: string[]`
- `search_products`: `excludeAllergens` is `string[]`, `passesAllergenFilter` uses explicit array comparison
- `get_recommendations.buildPersonalizedQuery`: reads from Redis profile (stored by `update_preferences`)
- Typesense schema: `allergens: string[]` with `facet: true`

---

## AI Safety Guarantees

### Per-Tool Analysis

| # | Tool | Can Be Weaponized? | Hard Programmatic Guards | Fabricated ID Risk | Cross-User Risk | Financial Risk |
|---|------|--------------------|--------------------------|-------------------|-----------------|----------------|
| 1 | search_products | No — read-only | Zod input validation | N/A — no user IDs | No | No |
| 2 | get_product_details | No — read-only | 404 handling | productId — returns null on miss | No | No |
| 3 | estimate_delivery | No — read-only | CEP regex + ViaCEP | N/A | No | No |
| 4 | get_cart | **Yes** — leaks cart contents | **None** — no ownership check | cartId — any cart readable | **YES** (C-02) | No |
| 5 | add_to_cart | **Yes** — pollutes carts | **None** — no ownership check | cartId + variantId | **YES** (C-02) | Indirect — unwanted items |
| 6 | update_cart | **Yes** — modifies quantities | **None** — no ownership check | cartId + itemId | **YES** (C-02) | Indirect — quantity manipulation |
| 7 | remove_from_cart | **Yes** — removes items | **None** — no ownership check | cartId + itemId | **YES** (C-02) | Indirect — item removal |
| 8 | apply_coupon | **Yes** — applies discounts | **None** — no ownership check | cartId + code | **YES** (C-02) | **YES** — unauthorized discounts |
| 9 | create_checkout | **Yes** — initiates payment | ctx.customerId for metadata only | cartId — any cart checkable | Depends on cart ownership | **YES** (H-02) — $0 orders |
| 10 | get_order_history | No — read-only, own data | NonRetryableError + ctx.customerId | N/A — uses ctx | No | No |
| 11 | check_order_status | No — read-only | OrderService.getOrder ownership | orderId — ownership checked | No | No |
| 12 | cancel_order | Yes — cancels orders | OrderService.cancelOrder ownership | orderId — ownership checked | No | Prevented by ownership |
| 13 | reorder | **Yes** — leaks order contents | ctx.customerId presence only | **orderId — NO ownership check** | **YES** (H-01) | No — just creates cart |
| 14 | check_availability | No — read-only | N/A | N/A | No | No |
| 15 | create_reservation | **Yes** — books tables | `withCustomerId` (but C-01) | customerId — **LLM can impersonate** | **YES** (C-01) | No — reservations are free |
| 16 | modify_reservation | **Yes** — changes reservations | Domain assertOwnership (but C-01) | customerId + reservationId | **YES** (C-01) | No |
| 17 | cancel_reservation | **Yes** — cancels reservations | Domain assertOwnership (but C-01) | customerId + reservationId | **YES** (C-01) | No |
| 18 | get_my_reservations | **Yes** — leaks reservation data | `withCustomerId` (but C-01) | customerId — **LLM can impersonate** | **YES** (C-01) | No |
| 19 | join_waitlist | **Yes** — pollutes waitlist | `withCustomerId` (but C-01) | customerId — **LLM can impersonate** | **YES** (C-01) | No |
| 20 | get_customer_profile | No — read-only, own data | NonRetryableError + ctx.customerId | N/A — uses ctx | No | No |
| 21 | get_recommendations | No — read-only | Optional auth | N/A — uses ctx | No | No |
| 22 | update_preferences | No — own data only | NonRetryableError + ctx.customerId | N/A — uses ctx | No | No |
| 23 | submit_review | Mild — fake reviews | NonRetryableError + ctx.customerId | productId/orderId — ctx-bound | No | No (reputation only) |
| 24 | get_also_added | No — read-only | N/A | productId — returns empty on miss | No | No |
| 25 | get_ordered_together | No — read-only, own data | Optional ctx.customerId | N/A — uses ctx | No | No |
| 26 | sync_review_stats | No — internal batch | N/A (not in tool registry) | N/A | No | No |

### Summary of AI Safety Issues

**Cross-user impersonation vectors:**
1. **5 reservation tools** via `withCustomerId` HOF (C-01) — LLM supplies fabricated customerId
2. **5 cart tools** via unverified cartId (C-02) — LLM supplies fabricated cartId
3. **reorder** via unverified orderId (H-01) — LLM supplies fabricated orderId

**Financial risk vectors:**
1. `create_checkout` with $0 total (H-02)
2. `apply_coupon` to any cart (C-02) — unauthorized discount application

**Data leakage vectors:**
1. `get_cart` with fabricated cartId leaks cart contents
2. `get_my_reservations` with fabricated customerId leaks reservation data
3. `reorder` with fabricated orderId leaks order item details

### Tools With Correct Auth Patterns (Safe)

The following tools correctly use `ctx.customerId` from the server-controlled context and never trust LLM input for identity:
- `get_order_history`, `check_order_status`, `cancel_order` (inline ctx check + OrderService ownership)
- `get_customer_profile`, `update_preferences`, `submit_review` (inline ctx check)
- `get_recommendations`, `get_ordered_together` (optional ctx, degrades gracefully for guests)

---

## H-03: Tool inputs not Zod-validated before withCustomerId processing [High]

**Evidence:** `packages/llm-provider/src/tool-registry.ts:115-124`

The `withCustomerId` HOF processes `input as T` before the wrapped tool function calls Zod `.parse()`. This means:
1. `input` could be any shape (null, undefined, array, string)
2. `input as T` is a type assertion with no runtime effect
3. The check `!i.customerId` on a non-object input would evaluate to truthy (property access on non-object) potentially throwing a confusing error

While not directly exploitable (Zod would catch it inside the tool), it means the auth bypass logic in `withCustomerId` operates on unvalidated data. A malicious input like `{customerId: 123}` (number instead of string) would pass the `!i.customerId` check (123 is truthy) and propagate to the domain service.

**Recommendation:** Validate at least `typeof input.customerId === 'string'` in `withCustomerId`, or move Zod validation before the HOF.

---

## Cross-Agent Findings

### From ai-agent-auditor (Wave 2)
- **Confirmed:** `withCustomerId` passes LLM-supplied customerId without verifying `ctx.customerId` — our C-01 independently verifies this finding with full exploit chain analysis.
- **Confirmed:** Tool inputs not Zod-validated at runtime in tool-registry — our H-03 covers this.

### From security-auditor (Wave 2)
- **Related:** `requireAuth` calling `done()` after 401 but route handler still executing — this is a separate layer (API routes), but reinforces the pattern of auth checks that don't actually block execution.

### From data-layer-auditor (Wave 2)
- **Related:** TOCTOU race in reservation creation — we note that `reservation.service.ts:228-233` checks `availableCovers` then creates in a transaction, but the check is outside the transaction, confirming the data-layer finding.

### For redis-auditor
- `copurchase:{productId}` sorted sets (used by `get_also_added`) — no TTL visible in tool code. Redis auditor should verify if TTL is set at write time (write happens in NATS event handler, not in tools).
- `product:global:score` sorted set (used by `get_recommendations`) — same concern.

### For events-auditor
- `search_products` publishes one `product.viewed` event per product in results (line 511) — could generate high event volume for searches returning many results (up to 100 per `limit` param).
