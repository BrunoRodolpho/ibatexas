# PostHog Dashboard Setup Guide

Step-by-step guide for creating the three PostHog dashboards defined in [analytics-dashboards.md](analytics-dashboards.md). Each section lists the dashboard name, the insights to create, and the filters/breakdowns to apply.

> **Prerequisite:** Complete the [Pre-Baseline Checklist](analytics-dashboards.md#pre-baseline-checklist) before creating dashboards. All events must be flowing correctly in PostHog live events.

---

## Dashboard 1: Executive — Daily Health

**Purpose:** High-level business health for daily review. Pin Revenue Per Session at the top — it is the north star metric.

### Insight 1.1: Revenue Per Session (RPS) — North Star

| Field | Value |
|-------|-------|
| **Name** | Revenue Per Session (RPS) |
| **Type** | Trends |
| **Formula** | `sum(checkout_completed.orderTotal)` / `count(distinct ibx_session_id)` |
| **Display** | Line chart, daily granularity |
| **Date range** | Last 30 days |
| **Filters** | None |
| **Breakdowns** | None |

> Pin this insight at the top of the dashboard. **Do not** calculate as `checkout_completed count / session_started count` — users can have multiple sessions per day.

### Insight 1.2: Conversion Funnel

| Field | Value |
|-------|-------|
| **Name** | Full Conversion Funnel |
| **Type** | Funnel |
| **Steps** | `pdp_viewed` → `add_to_cart` → `checkout_started` → `checkout_completed` |
| **Conversion window** | 24 hours |
| **Date range** | Last 30 days |
| **Breakdowns** | `source` (pdp / listing / cross_sell), device type |

### Insight 1.3: AOV Trend

| Field | Value |
|-------|-------|
| **Name** | Average Order Value (AOV) |
| **Type** | Trends |
| **Event** | `checkout_completed` |
| **Aggregation** | Average of property `orderTotal` |
| **Display** | Line chart, daily granularity |
| **Date range** | Last 30 days |
| **Filters** | None |
| **Breakdowns** | None |

### Insight 1.4: Checkout Completion Rate by Payment Method

| Field | Value |
|-------|-------|
| **Name** | Checkout Completion by Payment Method |
| **Type** | Funnel |
| **Steps** | `checkout_started` → `checkout_completed` |
| **Conversion window** | 1 hour |
| **Date range** | Last 30 days |
| **Breakdowns** | `paymentMethod` (PIX / card / cash) |

> `checkout_abandoned` via `beforeunload` is supplementary only. Funnel drop-off is the primary abandonment metric.

---

## Dashboard 2: Product Behavior

**Purpose:** Understand how users interact with products, cross-sells, and conversion UX features.

### Insight 2.1: Add-to-Cart Rate

| Field | Value |
|-------|-------|
| **Name** | Add-to-Cart Rate |
| **Type** | Trends |
| **Formula** | `count(add_to_cart)` / `count(pdp_viewed)` |
| **Display** | Line chart, daily granularity |
| **Date range** | Last 30 days |
| **Breakdowns** | `source` (pdp / listing / cross_sell) |

### Insight 2.2: Quick-Add Usage

| Field | Value |
|-------|-------|
| **Name** | Quick-Add Adoption |
| **Type** | Trends |
| **Series A** | `quick_add_clicked` — count |
| **Series B** | `quick_add_clicked` / `add_to_cart` — percentage |
| **Display** | Line chart, daily granularity |
| **Date range** | Last 30 days |
| **Target** | >= 20% of total add_to_cart |

### Insight 2.3: PDP Engagement — Scroll Depth

| Field | Value |
|-------|-------|
| **Name** | PDP Scroll Depth Distribution |
| **Type** | Trends |
| **Event** | `pdp_scroll_depth` |
| **Aggregation** | Total count |
| **Display** | Bar chart |
| **Date range** | Last 30 days |
| **Breakdowns** | `depth` (25 / 50 / 75 / 100) |

### Insight 2.4: PDP Engagement — Storytelling Reach

| Field | Value |
|-------|-------|
| **Name** | Storytelling Section Reach |
| **Type** | Trends |
| **Formula** | `count(storytelling_section_viewed)` / `count(pdp_viewed)` |
| **Display** | Line chart |
| **Date range** | Last 30 days |
| **Target** | > 60% |

### Insight 2.5: Cross-Sell Performance

| Field | Value |
|-------|-------|
| **Name** | Cross-Sell Conversion Rate |
| **Type** | Funnel |
| **Steps** | `cross_sell_viewed` → `cross_sell_added` |
| **Conversion window** | 30 minutes |
| **Date range** | Last 30 days |
| **Target** | >= 5–10% of PDP views |
| **Breakdowns** | `productId` (top 10) |

### Insight 2.6: Upsell Toast Performance

| Field | Value |
|-------|-------|
| **Name** | Upsell Toast Conversion |
| **Type** | Funnel |
| **Steps** | `upsell_toast_shown` → `upsell_toast_added` |
| **Conversion window** | 5 minutes |
| **Date range** | Last 30 days |
| **Target** | >= 8–12% |

**Additional insight:**

| Field | Value |
|-------|-------|
| **Name** | Upsell Toast Dismiss Ratio |
| **Type** | Trends |
| **Event** | `upsell_toast_dismissed` |
| **Display** | Bar chart |
| **Breakdowns** | `auto` (true = auto-dismiss / false = manual dismiss) |

### Insight 2.7: Also-Added Performance

| Field | Value |
|-------|-------|
| **Name** | Also-Added Conversion |
| **Type** | Funnel |
| **Steps** | `also_added_viewed` → `also_added_cart` |
| **Conversion window** | 30 minutes |
| **Date range** | Last 30 days |
| **Target** | >= 3–8% |

> Gated behind `recommendation_engine` feature flag.

### Insight 2.8: People Also Ordered

| Field | Value |
|-------|-------|
| **Name** | People Also Ordered — Adds |
| **Type** | Trends |
| **Event** | `people_also_ordered_added` |
| **Aggregation** | Total count |
| **Display** | Line chart, daily granularity |
| **Date range** | Last 30 days |
| **Target** | >= 5% conversion from impressions |

---

## Dashboard 3: Checkout & Revenue

**Purpose:** Monitor revenue trends, payment method distribution, and checkout errors.

### Insight 3.1: Revenue Trend

| Field | Value |
|-------|-------|
| **Name** | Revenue Trend |
| **Type** | Trends |
| **Event** | `checkout_completed` |
| **Aggregation** | Sum of property `orderTotal` |
| **Display** | Line chart |
| **Date range** | Last 30 days |
| **Granularity** | Daily (toggle to weekly for long-term view) |

### Insight 3.2: Payment Method Split

| Field | Value |
|-------|-------|
| **Name** | Revenue by Payment Method |
| **Type** | Trends |
| **Event** | `checkout_completed` |
| **Aggregation** | Sum of property `orderTotal` |
| **Display** | Pie chart / stacked bar |
| **Date range** | Last 30 days |
| **Breakdowns** | `paymentMethod` (PIX / card / cash) |

### Insight 3.3: Checkout Errors by Type

| Field | Value |
|-------|-------|
| **Name** | Checkout Errors |
| **Type** | Trends |
| **Event** | `checkout_error` |
| **Aggregation** | Total count |
| **Display** | Table + bar chart |
| **Date range** | Last 30 days |
| **Breakdowns** | `errorType`, `paymentMethod` |

### Insight 3.4: Checkout Abandonment Rate

| Field | Value |
|-------|-------|
| **Name** | Checkout Abandonment Funnel |
| **Type** | Funnel |
| **Steps** | `checkout_started` → `checkout_step_completed` (step=delivery) → `checkout_completed` |
| **Conversion window** | 1 hour |
| **Date range** | Last 30 days |
| **Breakdowns** | `paymentMethod` |

> Drop-off between steps is the primary abandonment metric. `checkout_abandoned` from `beforeunload` is supplementary only.

---

## Event Verification Checklist

Before creating dashboards, verify each critical event is firing correctly in PostHog **Live Events**. The table below maps each event to its source file.

| Event | Trigger Location |
|-------|-----------------|
| `pdp_viewed` | `apps/web/src/app/[locale]/loja/produto/[id]/PDPContent.tsx` — fires on PDP page mount |
| `add_to_cart` | `apps/web/src/components/molecules/ProductCard.tsx` — fires when item is added to cart |
| `checkout_started` | `apps/web/src/app/[locale]/checkout/page.tsx` — fires on checkout page mount |
| `checkout_completed` | Checkout success handler — guarded by `checkoutCompletedRef` and `orderId` existence check |
| `quick_add_clicked` | `apps/web/src/components/molecules/ProductCard.tsx` — "+" quick-add button click |
| `cross_sell_viewed` | PeopleAlsoOrdered component — fires when cross-sell section enters viewport |
| `cross_sell_added` | PeopleAlsoOrdered component — fires when cross-sell item is added to cart |
| `upsell_toast_shown` | UpsellToast component — fires when cross-sell toast appears after add-to-cart |
| `upsell_toast_added` | UpsellToast component — fires when user adds the suggested product from toast |

### Verification steps

1. Open PostHog → **Live Events**
2. Trigger each event in the storefront (dev or staging environment)
3. Confirm the event appears in live stream with correct properties
4. Check that `ibx_session_id` and `distinct_id` are present on every event
5. Verify `checkout_completed` fires exactly once per order (no duplicates)
6. Verify `pdp_scroll_depth` fires at most 4 times per PDP visit (25/50/75/100)
7. Confirm `session_started` does NOT fire on bounce (home page only, no interaction)

Once all events are verified, proceed to create the dashboards in PostHog following the insight definitions above.
