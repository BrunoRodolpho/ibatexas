# Net-new findings — 2026-05-23

**Branch:** feat/kernel-always-on-cutover (HEAD `f3bea43`)
**Methodology:** adversarial sweep across 10 axes against the W1-W8 baseline. The W9 backlog (`WAVE9-CART-EGRESS-BACKLOG.md`) was used as the known-gap anchor; this report enumerates gaps NOT yet enumerated there.

## TL;DR

**Net-new findings:** 7 (P0: 0, P1: 4, P2: 3)

- **No new P0** — all P0 bypasses surfaced in W1-W8 remain remediated.
- **4 P1 LLM-callable tool bypasses** previously missed: `update_preferences`, `submit_review`, `schedule_follow_up`, and the documentation mislabels `loyalty.addStamp` as "Redis analytics" when it actually mutates Postgres.
- **3 P2 documentation/scan-coverage hygiene gaps**: scanner allowlist names a non-existent `sender.ts`; `conversation.create` row creation in conversation-archiver subscriber has no envelope; Twilio scan dir set explicitly excludes `apps/api/src/whatsapp/` (intentional, but worth re-verifying).

The W6 governance-coverage verifier line — "Audits are not done; they're sampled" — proved correct again: widening the lens from "where the W8-V4 scanner pointed" to "every LLM-callable MUTATING tool" surfaces three more tool sites that bypass the kernel, on top of the 10 cart sites already in `DEFERRED_MEDUSA_MIGRATIONS`.

---

## Section 1 — Wave 9 scope verification

All 10 W9 cart-egress sites still present at the documented line numbers (verified by grep at 2026-05-23):

| File | Documented line | Current location | Status |
|---|---|---|---|
| `packages/tools/src/cart/add-to-cart.ts` | 54 | line 54 | present |
| `packages/tools/src/cart/apply-coupon.ts` | 14 | line 14 | present |
| `packages/tools/src/cart/create-checkout.ts` | 194 | line 194 | present |
| `packages/tools/src/cart/create-checkout.ts` | 229 | line 229 | present |
| `packages/tools/src/cart/create-checkout.ts` | 250 | line 250 | present |
| `packages/tools/src/cart/create-checkout.ts` | 291 | line 291–292 | present |
| `packages/tools/src/cart/create-checkout.ts` | 331 | line 331 | present |
| `packages/tools/src/cart/get-or-create-cart.ts` | 136 | line 136 | present |
| `packages/tools/src/cart/remove-from-cart.ts` | 14 | line 14 | present |
| `packages/tools/src/cart/update-cart.ts` | 14 | line 14 | present |

**Additional STORE-scope sites in `packages/tools/src/cart/` not in the W9 backlog:**

- `packages/tools/src/cart/create-checkout.ts:179` — `medusaStoreFetch(/store/carts/:id)` GET (read-only). Not a bypass.
- `packages/tools/src/cart/create-checkout.ts:235` — `medusaStoreFetch(/store/carts/:id)` GET (read-only). Not a bypass.
- `packages/tools/src/cart/create-checkout.ts:275` — `medusaStoreFetch(/store/payment-providers...)` GET (read-only). Not a bypass.
- `packages/tools/src/cart/get-or-create-cart.ts:79` — `medusaStoreFetch(/store/carts/:id)` GET (read-only). Not a bypass.
- `packages/tools/src/cart/get-cart.ts:13`, `assert-cart-ownership.ts:24` — GET-only, already in `ALLOWED_MEDUSA_DIRECT`.

**Cart-related Medusa STORE mutation calls outside `packages/tools/src/cart/`:**

- `apps/api/src/routes/cart.ts` — 8 mutation sites; all already routed through `medusaAdjudicated` (verified at lines 215, 275, etc.).
- `apps/api/src/routes/stripe-webhook.ts:290–303` — cart-complete via `medusaAdjudicated`. OK.
- `packages/tools/src/cart/reorder.ts:42,60` — uses `medusaAdjudicated`. OK.
- `apps/api/src/subscribers/cart-intelligence.ts:225` — `medusaStore(/store/carts/:id)` GET (read-only) inside a staff-alert helper. Not a bypass.

**Verdict:** W9 inventory is accurate; no additional STORE-scope mutating sites uncovered.

---

## Section 2 — New-since-W8 entrypoints

`git log --since="2026-05-15" --name-only` and pretty inspection of the latest 50 commits:

- No new HTTP route files in `apps/api/src/routes/`.
- No new subscriber files in `apps/api/src/subscribers/`.
- No new BullMQ jobs in `apps/api/src/jobs/`.
- No new LLM tools added to `packages/llm-provider/src/tool-registry.ts` (`TOOL_DEFINITIONS` array) or to `TOOL_CLASSIFICATION` since W6.
- No new external SDK imports (`fetch(`, axios, twilio, stripe) since W7-V1.
- No new Prisma schema additions since the W6 baseline (no `schema.prisma` modifications since 2026-04-15).

The latest commit `f3bea43` ("IBX-IGE v3.0 — always-on cutover") **removed** staged-rollout machinery rather than adding any new bypass surface.

**Verdict:** no findings.

---

## Section 3 — External egress sweep

| Egress | Wrapped | Bypasses found |
|---|---|---|
| Medusa STORE mutating (`medusaStore`/`medusaStoreFetch` POST/PUT/DELETE/PATCH) | `medusaAdjudicated()` | 10 sites — already in `DEFERRED_MEDUSA_MIGRATIONS` (W9 backlog). No NEW bypasses. |
| Medusa ADMIN mutating | `medusaAdjudicated()` | 0 — all migrated by W8-V1/W7-P6. |
| Stripe SDK mutating (`stripe.paymentIntents`, `stripe.refunds`, `stripe.customers`, etc.) | `stripeAdjudicated.*` | 0 — only wrapper internals call `stripe.*` directly. |
| Twilio WhatsApp (`twilio.messages.create`) | (centralized in `apps/api/src/whatsapp/client.ts`) | 0 direct calls outside the wrapper; **but** the higher-level `sendText` is invoked unwrapped from many subscribers/jobs — see Section 6 + Section 10. |
| Twilio Verify OTP (`verifications.create`, `verificationChecks.create`) | (intentional carve-out — auth surface only) | 0 — used only in `auth.ts` / `me.ts` for OTP. |
| Open-Meteo weather API (`apps/api/src/jobs/weather-helper.ts:50`) | (read-only) | 0 — read-only with caching; not a state mutation. No finding. |
| ViaCEP API (`packages/tools/src/catalog/estimate-delivery.ts:101`) | (read-only) | 0 — read-only address lookup. |
| Reverse-geocode (`packages/tools/src/catalog/reverse-geocode.ts:16`) | (read-only) | 0 — read-only. |
| Embedding API (`packages/tools/src/embeddings/client.ts:19`) | (read-only) | 0 — read-only. |
| Typesense `documents.update` (`packages/tools/src/intelligence/submit-review.ts:38`) | NOT wrapped | **NEW-W9-V2** — see findings table. |

**Verdict:** 1 NEW (Typesense write inside `submit_review`), but it's an aggregate cache-layer write of derived data. P2 hygiene; the substantive bypass is the `customerService.submitReview` Prisma write upstream.

---

## Section 4 — LLM tool registry coverage

`packages/llm-provider/src/machine/types.ts` `TOOL_CLASSIFICATION.MUTATING` contains 18 tools. Cross-referenced each against envelope-built paths in `packages/tools/src/`:

| Tool | Path | Envelope-gated? | Notes |
|---|---|---|---|
| `add_to_cart` | cart/add-to-cart.ts | NO | W9 backlog |
| `remove_from_cart` | cart/remove-from-cart.ts | NO | W9 backlog |
| `update_cart` | cart/update-cart.ts | NO | W9 backlog |
| `apply_coupon` | cart/apply-coupon.ts | NO | W9 backlog |
| `get_or_create_cart` | cart/get-or-create-cart.ts | NO | W9 backlog |
| `create_checkout` | cart/create-checkout.ts | NO | W9 backlog |
| `cancel_order` | cart/cancel-order.ts | YES — `transitionStatusFromEnvelope` | OK |
| `amend_order` | cart/amend-order.ts | YES — `*FromEnvelope` + `medusaAdjudicated` | OK |
| `reorder` | cart/reorder.ts | YES — `medusaAdjudicated` | OK |
| `create_reservation` | reservation/create-reservation.ts | YES — `createFromEnvelope` | OK |
| `modify_reservation` | reservation/modify-reservation.ts | YES — `modifyFromEnvelope` | OK |
| `cancel_reservation` | reservation/cancel-reservation.ts | YES — `cancelFromEnvelope` | OK |
| `join_waitlist` | reservation/* | unverified — open-blockers task 15 notes joinWaitlist not migrated | minor |
| `submit_review` | intelligence/submit-review.ts | **NO** — direct `customerSvc.submitReview` → `prisma.review.upsert` | **NEW-W9-V1** |
| `update_preferences` | intelligence/update-preferences.ts | **NO** — direct `customerSvc.updatePreferences` (envelope-path exists but unused) | **NEW-W9-V1** |
| `handoff_to_human` | support/handoff-to-human.ts | NO (publishes NATS only; staff WhatsApp send downstream is the documented `WhatsAppState` blocker) | aligns with task 16 deferral |
| `schedule_follow_up` | intelligence/schedule-follow-up.ts | **NO** — direct `redis.zAdd` | **NEW-W9-V3** |
| `regenerate_pix` | cart/regenerate-pix.ts | YES — `*FromEnvelope` + `stripeAdjudicated` | OK |

**Findings:**

- **NEW-W9-V1** (`update_preferences` + `submit_review`) — `pack-customer-onboarding` already declares `customer.preferences.update` with policies (`packages/pack-customer-onboarding/src/policies.ts:78`) and `customer.service.ts:309` exposes `updatePreferencesFromEnvelope`. The tool path at `packages/tools/src/intelligence/update-preferences.ts:22` ignores all of that and calls `svc.updatePreferences(...)` directly. `submit_review` is worse — no pack intent kind exists for it, no envelope path exists; the tool writes `prisma.review.upsert` straight through.
- **NEW-W9-V3** (`schedule_follow_up`) — writes `redis.zAdd(rk("follow-up:scheduled"), ...)` directly. No envelope, no audit, no intent kind. This is LLM-callable Redis state mutation that downstream drives `follow-up.due` NATS publishes and eventual WhatsApp messages.

`CapabilityPlanner` partitioning is structurally sound (`safePlan` asserts no MUTATING leak into `visibleReadTools`); the gap is post-planner: the EXECUTE path of the tool dispatcher does not enforce envelope construction at the per-tool level. The `customer_intent_gateway` is the route-level enforcement, but tools called from the LLM intent-bridge do not pass through it.

---

## Section 5 — NATS publish sites

19 publish sites across `apps/api/src` and 5 in `packages/tools/src`. Subject inventory:

`analytics.event`, `cart.abandoned`, `cart.item_added`, `conversation.message.appended`, `follow-up.due`, `intent.defer.timeout`, `notification.send` (×2 in cart-intelligence, ×2 in payment-lifecycle), `order.canceled` (×3), `order.disputed`, `order.escalation_needed`, `order.note_added` (×2), `order.payment_failed`, `order.placed`, `order.refunded`, `order.status_changed` (×3), `outreach.sent`, `payment.method_changed`, `payment.status_changed` (×5), `product.viewed`, `reservation.cancelled`, `reservation.created`, `reservation.modified`, `reservation.no_show`, `review.prompt`, `review.submitted`, `search.results_viewed`, `support.handoff_requested`.

**Wrapping audit:**

- `*.status_changed` / `order.placed` / `order.canceled` publishes from admin routes and stripe-webhook follow `*FromEnvelope` mutations (kernel-adjudicated upstream).
- `notification.send` from cart-intelligence / payment-lifecycle is the documented **`WhatsAppState` blocker** (Section 10).
- `intent.defer.timeout` is from the defer-timeout-sweeper, which is part of the kernel runtime (legitimate orchestrator publish).
- `analytics.event` is the kernel-metrics-sink wire (legitimate).

**No findings net-new beyond what is already documented in `open-blockers.md` Task 16 §"Out-of-scope":** the listed NATS publishes are either (a) downstream of an adjudicated mutation or (b) blocked on `WhatsAppState`.

---

## Section 6 — Webhook coverage

| Receiver | File | Adjudicated? |
|---|---|---|
| Stripe webhook | `apps/api/src/routes/stripe-webhook.ts` | YES — `reconcileFromWebhookFromEnvelope` (payment), `stripeAdjudicated.paymentIntents.update` (metadata persist W8-V2), `medusaAdjudicated` (cart-complete). |
| Twilio inbound (WhatsApp) | `apps/api/src/routes/whatsapp-webhook.ts` | partial — inbound payload triggers customer-intent gateway and LLM responder, which then routes mutations through envelopes. The webhook itself does not mutate state directly; the LLM-tool calls it triggers do. |

No other webhook receivers found (no Mercado Pago, no PIX issuer callbacks, no inbound from any payment processor beyond Stripe). **No findings.**

---

## Section 7 — Scheduled work

`apps/api/src/jobs/register-workers.ts` registers 12 BullMQ workers. State-mutating side effects per worker:

| Worker | Side effect | Wrapped? |
|---|---|---|
| `abandoned-cart-checker` | NATS `cart.abandoned` | downstream `cart-intelligence` analytics + `notification.send` — `WhatsAppState` blocker |
| `no-show-checker` | `reservation.transitionFromEnvelope` (kind `reservation.no_show.mark`) | YES — task 16 |
| `outbox-retry` | NATS re-publish | retry transport only |
| `review-prompt-poller` | NATS `review.prompt` | downstream WhatsApp send — `WhatsAppState` blocker |
| `reservation-reminder` | WhatsApp send via `sendText` | NO — `WhatsAppState` blocker |
| `pix-expiry-checker` | `paymentSvc.transitionStatusFromEnvelope` | YES — task 16 |
| `proactive-engagement` | `sendText` + `outreach.sent` NATS | NO — `WhatsAppState` blocker |
| `follow-up-poller` | NATS `follow-up.due` | downstream WhatsApp send — `WhatsAppState` blocker |
| `hesitation-nudge` | `sendText` | NO — `WhatsAppState` blocker |
| `pix-expiry-monitor` | `sendText` (PIX reminder messages) | NO — `WhatsAppState` blocker |
| `stale-order-checker` | `orderCmdSvc.transitionStatusFromEnvelope` + `paymentCmdSvc.transitionStatusFromEnvelope` | YES — task 16 |
| `defer-timeout-sweeper` | NATS `intent.defer.timeout` | YES — kernel runtime |

`setInterval` sites in production code: `apps/api/src/plugins/kernel-bootstrap.ts:359` (defer-pending gauge poll — read-only), `apps/api/src/streaming/execution-queue.ts:66` (heartbeat), `apps/api/src/whatsapp/session.ts:279` (session heartbeat). None mutate state.

**Verdict:** every scheduled mutation that touches a known state machine is wrapped. The remaining unwrapped scheduled WhatsApp sends are the `WhatsAppState` blocker. No NEW findings.

---

## Section 8 — Operator scripts

`scripts/` contains:

- `audit-overrides.ts` — read-only pnpm overrides check.
- `check-bundle-size.mjs` — read-only size assertion.
- `check-bypass.sh` — runs `bypass-detection.test.ts`.
- `check-overrides-change.ts` — read-only git diff check.
- `upgrade-radar.ts` — read-only npm registry check.

**No operator-runnable scripts mutate production state directly.** No prod-touching maintenance scripts surfaced. Database seeding (`packages/domain/src/seed-*.ts`) is dev-only — seed-orders.ts, seed-homepage.ts, etc. do issue direct `prisma.*.upsert` writes but only via the CLI `ibx db seed` command on a fresh local DB.

**Policy question for the orchestrator:** if production data-fix runbooks ever need to issue corrective DB writes (e.g. backfill an `intent_audit` row, hand-cancel a deferred intent), the operator-side path should go through `ibx kernel <command>` (which is wired to envelopes) and never through raw `prisma` from a one-off script. **No current violation; flagging as policy.**

---

## Section 9 — Test-only escape hatches

Searched for production code that imports test-only mocks, `vi.fn()`, or test-only adjudicate stubs:

- `packages/tools/src/cart/__tests__/`, `apps/api/src/__tests__/`, etc. — all isolated.
- No production import of `vitest` / `@vitest/*` outside `__tests__/` directories.
- The W6 `wave6-red-team` tests do exercise bypass attempts but only against mocked surfaces.

The `customer-intent-gateway.ts` has an `IBX_KERNEL_ENFORCE` env-list and an `ALWAYS_ENFORCE` set for `customer.anonymize` / `customer.anonymize.cancel`. With the W8 cutover (`f3bea43` "IBX-IGE v3.0 — always-on cutover, delete staged-rollout machinery") the env-var gating was removed from the kernel itself; CLAUDE.md rule #9 now says "the kernel is always authoritative — no env-var gating, no shadow mode, no kill switch." Verified by grep — the gateway code no longer consults `IBX_KERNEL_ENFORCE` for `customer.anonymize` (it always enforces) but the env-var still influences other kinds via `customer-intent-gateway.ts` if they appear in the env list. **This is consistent with the documented design** (gateway is the per-intent enforce switch; kernel itself is always authoritative when an envelope IS adjudicated).

**No findings.**

---

## Section 10 — WhatsApp state-machine blocker status

The `pack-whatsapp` `WhatsAppState` (per `packages/pack-whatsapp/dist/types.d.ts:196`) requires:

- `ctx.now` (wall clock — easy)
- `ctx.lastCustomerMessageAt` (timestamp of most-recent customer-initiated inbound)
- `ctx.perCustomerHandoffCount` (Redis projection)
- `ctx.recipientType` (`customer` | `staff` | `null`)

Current state per `apps/api/src/whatsapp/session.ts:228`: only `lastMessageAt` is tracked (combined inbound + outbound). The `lastCustomerMessageAt` distinct field is NOT tracked anywhere in the codebase (verified by grep — only matches are in pack-whatsapp itself).

**Confirmed: still a real blocker.** Effort estimate per open-blockers.md ~1-2d:
1. Add `lastCustomerMessageAt` HSET on inbound-only message paths (whatsapp-webhook.ts).
2. Resolve via a session-store helper (`getWhatsAppState(phone) → WhatsAppState`).
3. Wire `notification.send` subscriber (`cart-intelligence.ts:790`) + `handoff-subscriber.ts:52` + 4 unwrapped scheduled jobs (`proactive-engagement`, `pix-expiry-monitor`, `hesitation-nudge`, `reservation-reminder`) to build a `whatsapp.message.send` / `whatsapp.template.send` / `whatsapp.session.handover` envelope and call the pack's adjudicate path.

The blocker has NOT been silently closed — no commits in the last 50 mention `lastCustomerMessageAt`, no Pack `*FromEnvelope` adopter exists yet in `apps/api/src/whatsapp/`.

---

## Net-new findings table

| ID | Severity | Surface | File:line | Description | Effort |
|---|---|---|---|---|---|
| **NEW-W9-V1a** | P1 | LLM tool — `update_preferences` | `packages/tools/src/intelligence/update-preferences.ts:22` | Calls `customerSvc.updatePreferences()` directly; `pack-customer-onboarding` already has `customer.preferences.update` intent kind + policy, and `customer.service.ts:309` exposes `updatePreferencesFromEnvelope`, but the tool path doesn't use them. LLM-proposed allergen list bypasses the pack's allergen-array policy enforcement. | ~1h (build envelope, call existing `*FromEnvelope`, add governance test) |
| **NEW-W9-V1b** | P1 | LLM tool — `submit_review` | `packages/tools/src/intelligence/submit-review.ts:23–38` | Calls `customerSvc.submitReview()` → `prisma.review.upsert` directly. No `review.submit` intent kind exists in any pack; no envelope path on `customerService`. LLM-proposed rating+comment bypasses any policy gating (rate limit, content policy, ownership check). | ~2-3h (add intent kind to a new or existing pack, add `submitReviewFromEnvelope`, wire tool, add governance test) |
| **NEW-W9-V2** | P2 | LLM tool — `submit_review` Typesense write | `packages/tools/src/intelligence/submit-review.ts:38` | Aggregate `documents.update` after the Prisma upsert. Cache-layer write; not a primary state mutation, but compounded by the V1b bypass — the LLM can directly influence search-rank cache without adjudication. | bundle with V1b |
| **NEW-W9-V3** | P1 | LLM tool — `schedule_follow_up` | `packages/tools/src/intelligence/schedule-follow-up.ts:32` | `redis.zAdd(rk("follow-up:scheduled"), ...)` directly. LLM-callable; drives `follow-up.due` NATS publishes 1–72h later that fan out to WhatsApp via the (already-deferred) `WhatsAppState` blocker. Without an envelope, an LLM can schedule arbitrary future outreach without audit trail. | ~1h (define `followup.schedule` intent kind, build envelope path, basic policy with delayHours bounds + reason allowlist) |
| **NEW-W9-V4** | P1 | Domain service — `LoyaltyService.addStamp` | `packages/domain/src/services/loyalty.service.ts:25–35` | Called from `cart-intelligence.ts:352` on `order.placed`. Documentation in `open-blockers.md:42` says it's a "pure Redis analytics counter" — **it is actually a Postgres `loyaltyAccount.update` mutating row-level fields (stamps, totalEarned, redeemed)**. The doc-vs-code drift is itself the finding. Whether to wrap depends on policy decision (is loyalty a "state machine"?). | docs ~30min; if to wrap, ~1-2h with new pack intent kind |
| **NEW-W9-V5** | P2 | Subscriber — `conversation-archiver` | `packages/domain/src/services/conversation.service.ts:63,79` | `appendMessageFromEnvelope` is correctly wrapped, but the upstream `findOrCreateBySessionId` (called by `conversation-archiver.ts:53`) issues a raw `prisma.conversation.create` for first-message-of-session. No `conversation.create` intent kind, no envelope. Same wrapping argument as message-append. | ~1h |
| **NEW-W9-V6** | P2 | Bypass-detection allowlist hygiene | `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:846–850` `ALLOWED_TWILIO_MESSAGES` | The allowlist names `apps/api/src/whatsapp/sender.ts` and `apps/api/src/whatsapp/init.ts`. `sender.ts` does NOT exist — the actual `twilio.messages.create` lives at `apps/api/src/whatsapp/client.ts:132,204` (which is OUTSIDE the `TWILIO_SCAN_DIRS` set so the scan doesn't fire anyway). The allowlist entry is stale and the scan-dir omission of `apps/api/src/whatsapp/` is implicit, not deliberate-with-rationale. | ~15min (update allowlist comment + scan-dir comment, OR add `apps/api/src/whatsapp/` to scan dirs + allowlist `client.ts`) |

---

## What the orchestrator should know

1. **W9 backlog is correct but incomplete.** Closing the 10 cart-egress sites still leaves three LLM-callable MUTATING tools (`update_preferences`, `submit_review`, `schedule_follow_up`) bypassing the kernel. Recommend folding NEW-W9-V1a/V1b/V3 into the W9 epic OR creating a sibling "intelligence-tool-egress" mini-epic. The `update_preferences` fix is the lowest-hanging fruit (~1h, all infrastructure exists already).

2. **`submit_review` has no intent kind anywhere.** Unlike the cart-tool sites (which can adopt `pack-orders` policies) and `update_preferences` (which can adopt `pack-customer-onboarding`), there is no `review.submit` intent kind in any pack. Decision required: extend an existing pack vs. create `pack-reviews` vs. inline policy per D10 precedent.

3. **WhatsApp `WhatsAppState` blocker has at least 7 unwrapped call sites** (notification.send subscriber, handoff-subscriber, and 4 BullMQ jobs: proactive-engagement, pix-expiry-monitor, hesitation-nudge, reservation-reminder; plus 4+ inline `sendText` calls in cart-intelligence). All depend on the same `lastCustomerMessageAt` projection from session state. ~1-2d to unblock the entire family. This compounds with NEW-W9-V3 (schedule_follow_up → follow-up.due → WhatsApp).

4. **Documentation drift on loyalty stamp** is small but corrosive. `open-blockers.md:42` says "pure Redis analytics counters" for the order.placed handler's loyalty stamp; in reality `LoyaltyService.addStamp` is a Postgres `loyaltyAccount.update`. The 6 other items listed in that line (copurchase sorted sets, global score, profile counters, daily WA metrics, recently-viewed) ARE pure Redis. Recommend updating the doc OR adding `loyalty.stamp.add` to a pack and wrapping. Either way, fixing the false claim raises auditor trust.

5. **No P0 surprises.** The 8-wave correctness cycle did its job for the highest-blast-radius surfaces. The remaining gaps are P1 LLM-callable tools (modest blast — preferences/reviews/follow-up) plus the long-pole WhatsApp state-machine wiring.
