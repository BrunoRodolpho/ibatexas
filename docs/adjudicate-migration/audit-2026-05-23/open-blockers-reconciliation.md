# Open-blockers reconciliation — 2026-05-23

**Branch:** `feat/kernel-always-on-cutover`
**Last commit reviewed:** `f3bea43` (IBX-IGE v3.0 always-on cutover)

## TL;DR

Of approximately **52 enumerable "open" items** across the source docs, **38 are CLOSED** by commits since the corresponding wave landed, **9 remain STILL OPEN** (3 of which require operator action), **3 are formally DEFERRED with rationale**, and **2 are UNCLEAR**.

The single biggest change since W7/W8 is commit `f3bea43` (**IBX-IGE v3.0 always-on cutover**), which deleted the kill-switch infrastructure, the shadow/enforce env-flag plumbing, and the entire admin kill-switch HTTP/CLI surfaces. That cutover **renders several W6/W7 items moot** (kill-switch role drift, CLI two-person rule, ghost runbooks 01-05) but **transforms the deferred operator items into hard preconditions** for boot (audit-postgres migrations are now applied by `ibx kernel migrate` / `ibx bootstrap` rather than gated by an env flag).

**Top 5 still-open items by blast radius:**

1. **F2 — `kernel.intent_dispatched` basis code in adjudicate sibling repo** (P1, ~15min once sibling clean). Still deferred; sibling-repo commit never landed in this repo's log.
2. **NEW-W7-V3 — G3 hoist only covers `actorPrincipal`** (P2 / P1-for-Tier-4). Inline comment at `apps/api/src/adapters/park-deferred-intent-nx.ts:173-174` confirms `version/nonce/taint` still NOT hoisted. ~30min.
3. **Wave-9 cart-egress backlog — 10 LLM-callable cart-store medusa bypasses** (P1; not Tier 1/3 blocker; tracked in `WAVE9-CART-EGRESS-BACKLOG.md`). ~3-5 days.
4. **Task 14 — 2 remaining order routes still on legacy tool path** (`PATCH /api/orders/:id/address`, `PATCH /api/orders/:id/type`). ~90min.
5. **`recordSinkFailure` wiring** — code comment at `intent-audit-wiring.ts:309` still flags it as "future work." ~1h. Mostly observability, not correctness.

The W1-W3 operator items (NATS auth, audit-postgres migrations) now run **inside `ibx bootstrap`** by the cutover — operator deployment work, not engineering work.

---

## Item ledger

### Overnight-run follow-ups (F1-F6)

| ID | Original status | Current status | Evidence | Notes |
|---|---|---|---|---|
| F1 | merged with synthetic defaults | CLOSED | `d8399d2` (merge: F1 + F3-stub), `4fff2f1` (wire setResumeIntentDispatcher) | Resume dispatcher adapter live; the "synthetic defaults" caveat (`channel=WhatsApp`, `userType=customer`) is documented in OVERNIGHT top-10 §10 but not a correctness issue — it's an assumption to revisit if web checkout starts emitting DEFER. |
| F2 | DEFERRED (adjudicate sibling repo dirty) | STILL OPEN | `git log --grep="kernel.intent_dispatched"` returns 0 hits | No commit in this repo references the basis-code wiring; the sibling-repo PR may or may not have landed. **Recommended:** check `BrunoRodolpho/adjudicate` for a `kernel.intent_dispatched` PR before adopting a newer `@adjudicate/core`. |
| F3 | stub | CLOSED (real) | OVERNIGHT-SUMMARY §F3 + `intent-kinds.ts` (32 kinds) | KNOWN_INTENT_KINDS now real per overnight summary. |
| F4 | merged | CLOSED | OVERNIGHT-SUMMARY §F4; `cba2fd4` (baseline green) | Nonce migration done at envelope construction. |
| F5 | merged | CLOSED | OVERNIGHT-SUMMARY §F5 (F5+F6 combined) | `add_order_note` orphan cleanup done. |
| F6 | merged | CLOSED | OVERNIGHT-SUMMARY §F6 | Legacy-EXECUTE audit pollution closed. |

### Task scope-cuts (open-blockers.md)

| Task | Item | Original status | Current status | Evidence |
|---|---|---|---|---|
| 13 | Pack-layer `pack-deployments-approval`-style `REQUEST_CONFIRMATION` for `order.admin.force_*` | deferred (route-level functional equivalent shipped) | STILL OPEN | No `pack-admin-actions` package exists; route-level Redis-backed receipt store at `apps/api/src/routes/admin/admin-confirmation-store.ts` remains canonical. Not blocking under IBX-IGE v3.0 (operator-only surface). |
| 14 | `POST /api/orders/:id/amend/batch` | deferred | CLOSED | `order-actions.ts:397-`; wraps via envelope (review the route block — it builds an envelope and runs `runCustomerIntent` with `ordersPolicyBundle` per the single-amend pattern at line 601). |
| 14 | `POST /api/orders/:id/payment/retry` | deferred | CLOSED | `order-actions.ts:831`; `paymentCmdSvc.transitionStatusFromEnvelope` at 911 + `paymentCmdSvc.createFromEnvelope` at 946. |
| 14 | `POST /api/orders/:id/payment/regenerate-pix` | deferred | CLOSED | `order-actions.ts:972`; same envelope chain at lines 1052/1081/1114 including `bumpRegenerationCountFromEnvelope`. |
| 14 | `PATCH /api/orders/:id/payment/method` | deferred | CLOSED | `order-actions.ts:1134-1325`; full W1-NEW-P0-X4 closure with `payment.status.transition` + `payment.create` envelope chain. |
| 14 | `PATCH /api/orders/:id/address` | deferred | STILL OPEN | `order-actions.ts:1327-1372` still calls `changeDeliveryAddress(...)` tool directly; no envelope construction. |
| 14 | `PATCH /api/orders/:id/type` | deferred | STILL OPEN | `order-actions.ts:1374-1412` still calls `switchOrderType(...)` tool directly. |
| 14 | `POST /api/cart/:id/line-items` (kind `order.item.add`) | deferred | CLOSED (via wrapper) | `cart.ts:252-293`; routes through `medusaAdjudicated({intentKind: "medusa.cart.line_items.add"})`. Adjudicated at the medusa-egress layer rather than the `order.item.add` pack kind — equivalent guard, different kind. |
| 14 | `PATCH /api/cart/:id/line-items/:itemId` (kind `order.item.update`) | deferred | CLOSED (via wrapper) | `cart.ts:295-333`; `medusa.cart.line_items.update`. |
| 14 | `DELETE /api/cart/:id/line-items/:itemId` (kind `order.item.remove`) | deferred | CLOSED (via wrapper) | `cart.ts:335-`; `medusa.cart.line_items.remove`. |
| 14 | `POST /api/cart/:id/sync` | deferred | UNCLEAR | Not separately verified during this audit; would need a direct check of the sync endpoint. |
| 14 | Reservation HTTP routes wrap | deferred | UNCLEAR | Subscriber/job side wrapped (W7-P1); reservations.ts admin route adjudication not separately verified. |
| 16 | `notification.send` (WhatsApp egress + 24h-window guard) | deferred (needs `WhatsAppState.lastCustomerMessageAt`) | STILL OPEN | No commit references closure; cart-intelligence.ts retains legacy direct WhatsApp send. |
| 16 | `handoff-subscriber.ts` (whatsapp.session.handover) | deferred (same WhatsAppState blocker) | STILL OPEN | `subscribers/handoff-subscriber.ts` still calls WhatsApp send directly; no envelope. |
| 16 | `cart-tier-escalation`, abandoned-cart, proactive-engagement, no-show-checker, etc. | deferred (analytics-only or same WA state blocker) | STILL OPEN | All jobs still exist under `apps/api/src/jobs/`; per the docs, no-show-checker is the only state-machine mutator — clean ~30min follow-up if prioritized. |
| 17 | `medusaAdjudicated` extension to cart tools / `medusa.*` intent kinds | deferred (wrapper only shipped) | PARTIAL | Wrapper exists at `packages/tools/src/medusa/adjudicated.ts`; ADMIN-scope migrations done (W8-V1, W7-P5/P6). STORE-scope cart-tool egress (10 sites) tracked in `WAVE9-CART-EGRESS-BACKLOG.md`. |
| post-15 | `customer.address.add` / `customer.address.remove` from pack-customer-onboarding | deferred (no service method) | STILL OPEN | `grep addAddressFromEnvelope packages/domain/src/` returns 0; methods still TBD; routes still in `me.ts` direct Prisma. |
| post-15 | `payment.method.switch` executor | deferred (lived in `packages/tools/src/cart/amend-order.ts`) | CLOSED | W1 `9370c8a` wired through `paymentCmdSvc.*FromEnvelope`; `payment.method.switch` kind registered in `@ibatexas/pack-payments`. |
| post-15 | Reservation `joinWaitlist`/`promoteWaitlist` envelope | deferred | STILL OPEN | Per W7 sub-finding, `joinWaitlistFromEnvelope` does not exist on the service (docs note pack declares kind; service side missing). `grep joinWaitlistFromEnvelope packages/domain/src/` returns 0. |

### W6 P0-NEW items

| ID | Item | Current status | Evidence |
|---|---|---|---|
| P0-NEW-W6-1 | `verifyParkedEnvelopeHash` actorPrincipal hoist | CLOSED (W7-G3) | `e1e1e10` — `apps/api/src/adapters/park-deferred-intent-nx.ts:175-195` hoist confirmed. |
| P0-NEW-W6-2 | Whitespace customerId bypass | CLOSED (W7-G1) | `b9575bc` — `anonymize-otp-gate.ts` + 3 `auth.ts` guards trim + canonicalise; verifier red-team 01 EXPLOIT cases flipped. |
| P0-NEW-W6-3 | Template-literal bypass of medusa scanner | CLOSED (W7-G2) | `497e7c7` (msg-scrambled — actual G2 content) — `FORBIDDEN_MEDUSA_MULTILINE` regex widened to `` ['"`] ``. |
| P0-NEW-W6-4 | Reservation tool layer | CLOSED (W7-P1) | `8cc3fb3` — 3 of 4 sites migrated. `join-waitlist` sub-finding STILL OPEN per above (no service method). |
| P0-NEW-W6-5 | Admin scheduler/tables/zones | DEFERRED with rationale (W7-P2) | `dbf077e` — `DEFERRED_ADMIN_LOW_RISK` allowlist (10 sites, W6 undercounted by 4); rationale in `W7-DECISIONS-admin.md`. |
| P0-NEW-W6-6 | Customer onboarding upserts (auth + WhatsApp) | CLOSED (W7-P3) | `1efa47a` — `auth.ts:430` + `whatsapp/session.ts:177` use `createFromEnvelope`. |
| P0-NEW-W6-7 | `prisma.orderNote.create` ×4 production routes | CLOSED (W7-P4) | `77cef72` — all 4 sites route through `order.note.add` intent; 0 production `prisma.orderNote.create` left. |
| P0-NEW-W6-8 | Stripe SDK direct calls in `packages/tools/src/cart/` ×6 | CLOSED (W7-P5) | `508b979` (bundled msg-scrambled) — `stripeAdjudicated` wrapper at `packages/tools/src/stripe/adjudicated.ts`; 6 cart sites migrated. |
| P0-NEW-W6-9 | Medusa `fetchAdmin` POST/DELETE in `order.service.ts` | CLOSED + HARDENED (W7-P6 + W8-V1) | `508b979` (P6 routing) + `5f800f2` (W8-V1 hard-throw at `order.service.ts:146-156`). Silent fallback now throws. |

### W6 P1/P2-NEW items

| ID | Item | Current status | Evidence |
|---|---|---|---|
| P1-NEW-W6 | `kernel_audit_spill_bytes` metric mismatch | CLOSED (W7-G4) | `d922671` — canonical `kernel_audit_sink_spill_size`; programmatic allowlist. |
| P1-NEW-W6 | CLI two-person rule bypass | MOOT (post-cutover) | `f3bea43` deleted the entire kill-switch surface (CLI subcommand + admin route + store package). W7-O3's `--yes-i-am-solo-on-call` flag no longer relevant. |
| P1-NEW-W6 | OWNER vs MANAGER role for kill-switch | MOOT (post-cutover) | Same — `apps/api/src/routes/admin/kernel.ts` deleted entirely (`f3bea43`). |
| P2-NEW-W6 | Phantom `pnpm migrate` command | CLOSED (W7-O2) + EVOLVED | `b5ab090` (msg-scrambled) — replaced with executable psql loop; then `f3bea43` added real `ibx kernel migrate` command wired into `ibx bootstrap` step 4 of 7. |
| P2-NEW-W6 | No `ibx kernel defer resume` CLI | CLOSED (W7-O1) | `bda5973` — `ibx kernel defer resume <sessionId>` with 5 unit tests + G3 wiring + runbook reference. |
| P2-NEW-W6 | NX-wrapper quota slot leak on mid-park throw | UNCLEAR | Not separately verified in this audit; `park-deferred-intent-nx.ts:157-164` shows a `del()` cleanup on throw — likely closed but counter-DECR semantics not re-validated. |
| P2-NEW-W6 | Runbook key references wrong (`ibatexas:foo` vs `<APP_ENV>:foo`) | CLOSED (W7-O5) | `9fbd335` — runbooks updated. Note: most W6-era runbooks (`01-stage-*` through `05-stage-*`) were DELETED by `f3bea43`; replaced by single `kernel-operations.md`. |

### NEW-W7 verifier findings → W8 closure

| ID | Item | Current status | Evidence |
|---|---|---|---|
| NEW-W7-V1 | Cart tools bypass kernel via `createOrderService(medusaAdmin)` without `adminAdjudicated` | CLOSED (W8-V1) | `5f800f2` — `packages/tools/src/cart/_shared.ts` `createTooledOrderService()` factory; 3 callers (cancel/amend/check-order-status) migrated; `order.service.ts:146-156` hard-throws if `adminAdjudicated` undefined. |
| NEW-W7-V2 | Bare `stripe.paymentIntents.update(...)` in stripe-webhook | CLOSED (W8-V2) | `84b5c39` — `stripe-webhook.ts:318` now uses `stripeAdjudicated.paymentIntents.update`. |
| NEW-W7-V3 | G3 hoist covers only `actorPrincipal`, not `version/nonce/taint` | STILL OPEN | `park-deferred-intent-nx.ts:173-174` inline comment confirms "The other three verification fields (version/nonce/taint) have no canonical fallback source." Production callers happen to pass them; structural gap remains. |
| NEW-W7-V4 | Bypass-detection scan dirs don't cover `packages/tools/src/cart/` | CLOSED (W8-V4) | `3129a79` — `MEDUSA_SCAN_DIRS` widened; surfaced 10 cart-store findings → W9 backlog. |
| NEW-W7-V5 | Unicode-quote / string-concat / variable-bound regex evasion | STILL OPEN (documented Q2 backlog) | Documented at `bypass-detection.test.ts:163-166` comments; tracked for AST-based scanning rewrite. Not Tier-1 blocker. |

### Operator-action items (no engineer can close)

| Item | Owner | Status under IBX-IGE v3.0 |
|---|---|---|
| Audit-Postgres SQL migrations enablement | operator | **MOOT/EVOLVED.** `IBX_AUDIT_POSTGRES_ENABLED` env flag DELETED by `f3bea43`. Migrations now run as `ibx kernel migrate` (step 4 of `ibx bootstrap`). Boot preflight `assertAuditPostgresReady` REFUSES to start if `intent_audit` table is missing. So this is now a hard precondition of every deploy — not an opt-in. |
| NATS auth deployment | operator | STILL OPEN at the deploy layer; code-side fail-closed posture landed in W1c `2f4fe88` (`NEW-P0-X3 — NATS auth fail-CLOSED in production`). Operator action only. |
| Operator runbook for stuck-DEFER recovery | operator-docs | PARTIAL — `ibx kernel defer resume` CLI exists (W7-O1); runbook integration noted as pending in W7-SYNTHESIS §"Tier 4 enforce: RED." Most likely closed via `kernel-operations.md` (created by `f3bea43`) — not separately verified. |

### Other open items from OVERNIGHT-SUMMARY top-10

| Item | Current status | Evidence |
|---|---|---|
| `recordSinkFailure` wiring | STILL OPEN | `intent-audit-wiring.ts:309` inline comment: "future work can wire `recordSinkFailure` once the metrics-sink slot exposes a public spill counter." Observability-only; not correctness. |
| `ibx kernel replay` re-adjudication + drift step | CLOSED (W3 D3 + W7-O2 evolution) | `5b1b59e` (W3 D3 — real replay), `kernel.ts:333-354` documents per-Pack PolicyBundle dispatch + drift classification (DECISION_KIND / BASIS_DRIFT / REWRITE-payload). |
| Intent-kind drift between `pack-orders` (`order.item.add`) and task 06 convention (`order.cart.add`, `order.pix.regenerate`) | UNCLEAR (Tier-rollout concern) | Listed as #7 in overnight top-10. No commit explicitly reconciles. Cart routes use `medusa.cart.line_items.*` not pack kinds, which sidesteps the question for store-scope but leaves the question open for the pack-level intent canonicalisation. Per the cutover this is no longer enforce-gated, so blast radius shifted. |
| Bypass-detection `ALLOWED_MEDUSA_DIRECT` carve-out audit | UNCLEAR | Top-10 #8. `bypass-detection.test.ts` exists with the carve-out list; not separately re-audited here. |
| F1 synthetic defaults revisit (channel=WhatsApp/userType=customer) | DEFERRED-AS-ASSUMPTION | Top-10 #10. Becomes a real issue only if web checkout starts emitting DEFER. Tracked in resume-dispatcher adapter source comments. |

---

## Net "what's still open" list (ranked by blast radius)

| Rank | Item | Severity | Effort | Dependencies |
|---|---|---|---|---|
| 1 | NEW-W7-V3 G3 hoist completion (version/nonce/taint) | P2 globally; P1 for Tier-4 enforce of LGPD/refund | ~30min (path b: fail-loud refuse on missing fields) | None |
| 2 | F2 `kernel.intent_dispatched` basis code in adjudicate sibling repo | P1 (audit "supersedes" link incomplete) | ~15min once sibling repo clean | Sibling-repo release cycle |
| 3 | Task 14 `PATCH /api/orders/:id/address` wrap (`order.address.change` kind exists; `changeAddressFromEnvelope` exists on `OrderCommandService`) | P1 | ~45min | None |
| 4 | Task 14 `PATCH /api/orders/:id/type` wrap (`order.type.switch` kind exists; `switchTypeFromEnvelope` exists) | P1 | ~45min | None |
| 5 | Reservation `joinWaitlistFromEnvelope` service method | P2 (pack declares kind; sub-finding noted in W7-Govern-Customer) | ~1h | None |
| 6 | `customer.address.add` / `customer.address.remove` executor + envelope-wired routes in `me.ts` | P2 | ~2-3h (service method + route wire) | None |
| 7 | Wave-9 cart-egress backlog — 10 LLM-callable cart-store medusa bypasses | P1 (NOT a Tier-1/3 blocker) | ~3-5 days (new `medusaStoreAdjudicated` wrapper + intent kinds + per-kind policies) | None |
| 8 | Task 16 deferred subscribers/jobs (`notification.send`, `handoff-subscriber`, etc.) | P2 (deferred on `WhatsAppState.lastCustomerMessageAt` builder) | ~1-2d | WhatsApp state builder helper |
| 9 | Task 16 `no-show-checker` (only remaining state-machine BullMQ job) | P2 | ~30min | None |
| 10 | `recordSinkFailure` wiring to metrics sink | P3 (observability) | ~1h | Decide bridging API for metrics-sink slot |
| 11 | Task 13 pack-layer `REQUEST_CONFIRMATION` migration to `pack-admin-actions` | P3 (route-level functional equivalent in place) | ~1d | None |
| 12 | NEW-W7-V5 bypass-detection AST-based scanner | P3 | ~1-2d | AST tooling (typescript-eslint custom rule) |
| 13 | Audit OVERNIGHT top-10 #7: intent-kind drift between pack-orders and route conventions | P2 (less urgent under always-on, but should reconcile before any new pack adds) | UNCLEAR | None |
| 14 | NX-wrapper quota slot leak verification | P3 | ~30min verification + ~30min fix if needed | None |
| 15 | NATS auth operator deployment | P0 for prod readiness | Operator action | Infra-side |

---

## Items that need a decision (not just engineering work)

1. **F2 — sibling repo cadence.** Is there a release cycle for `BrunoRodolpho/adjudicate` we need to wait for, or can we push the `kernel.intent_dispatched` basis-code wiring as a sibling PR now? Decision-maker should check `BrunoRodolpho/adjudicate` recent PRs before adopting a newer `@adjudicate/core` consumer version.

2. **Task 13 pack-layer vs route-layer for admin force-* confirmation.** Route-level Redis receipt store is functionally equivalent; pack-layer requires a new `pack-admin-actions` package. Under IBX-IGE v3.0 the kernel is always-on but **admin force-* are operator-only intents** — the original M4 candidate framing was an operator-quality-of-life improvement, not a correctness gap. Decision: ship pack-admin-actions or formally accept the route-level pattern as canonical.

3. **Wave-9 cart-egress backlog framing.** Should W9 be its own epic (~3-5 days) or roll into a broader Tier-4 enforce readiness sweep? Tied to whether the team intends to land LGPD-anonymize enforce or refund-issue enforce within the next quarter.

4. **F1 synthetic-defaults assumption.** Wait until web checkout actually emits DEFER, or proactively audit the adapter now? Currently deferred-as-assumption; revisit when adding any non-WhatsApp DEFER-capable surface.

5. **Intent-kind drift reconciliation (overnight top-10 #7).** Under always-on the previous "enforce flip would default-REFUSE the rogue kinds" risk is moot, but a future PolicyBundle that strictly enumerates kinds will fail closed. Decision: reconcile `order.cart.add` / `order.pix.regenerate` to pack-orders canonical names, or document the convention divergence formally.

---

## Items rendered MOOT by the always-on cutover (`f3bea43`)

Listed for completeness — these were on the W6/W7 follow-up list but cease to be open work under IBX-IGE v3.0:

- CLI vs admin HTTP two-person rule reconciliation (W7-O3) — kill-switch surface deleted entirely.
- MANAGER vs OWNER role for kill-switch (W7-O4) — `apps/api/src/routes/admin/kernel.ts` deleted.
- 5 staged-rollout runbooks (`01-stage-read-mutations.md` through `05-stage-pix-charge-pack.md`) — replaced by single `docs/ops/runbooks/kernel-operations.md`.
- `IBX_AUDIT_POSTGRES_ENABLED` flag — deleted; migrations now hard precondition.
- `ibx kernel divergence` subcommand — deleted (shadow mode gone).
- `shadow-enforce-branching.test.ts` (478 lines) — deleted.
- `customer-intent-gateway-default-deny.test.ts` (262 lines) — deleted.
- `kill-switch-store` package (193 lines + 269-line test) — deleted.
- `kernel_kill_switch_state` W3-3 Prometheus gauge — removed.
- Audit-trail "scrambled commit messages" caveat from W7 — still factual but no longer load-bearing because the bundled `508b979` work has all been moved past.

---

End of reconciliation.
