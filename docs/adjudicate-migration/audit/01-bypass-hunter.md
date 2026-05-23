# Bypass Hunter Audit

Adversarial review of every mutation path against the claim "everything flows through `adjudicate()`."
Scope: `apps/api/src/`, `packages/{domain,tools,llm-provider,pack-*}/src/`.
Methodology: grep + manual read of every `prisma.*.{mutate}`, `medusaStore/Admin`, `stripe.*`, Twilio,
`publishNatsEvent`, deprecated bare-arg command-service method, and the boot sequence. Not trusting the
bypass-detection CI gate — testing what it MISSES.

---

## Executive summary (top risks)

1. **The bypass-detection grep is line-based; multi-line medusa writes invisible.** The forbidden-pattern regex
   `medusaStore\([^)]*['"]POST` requires the `method: "POST"` literal on the SAME line as `medusaStore(`. Every
   real medusa write call in the codebase is multi-line. The CI gate is green by construction, not by
   correctness. At least 18 medusa POST/DELETE call sites in `apps/api/src/routes/cart.ts`,
   `routes/order-actions.ts`, and `routes/admin/products.ts` are unscanned writes outside the
   `medusaAdjudicated()` wrapper.
2. **`ALLOWED_MEDUSA_DIRECT` carve-out includes two files that DO write** —
   `packages/tools/src/cart/reorder.ts` and `packages/tools/src/cart/amend-order.ts`. The carve-out comment says
   "read-only fetches" but both POST to medusa, and `amend-order.ts` additionally creates Stripe PaymentIntents
   and calls deprecated `paymentCmdSvc.transitionStatus` + `paymentCmdSvc.create`. The amendment money path is
   completely unadjudicated end-to-end.
3. **`admin/payments.ts:251` updates `refundedAmountCentavos` with a direct `prisma.payment.update` AFTER the
   kernel approves only the status transition.** The refund amount is never in the envelope payload, so the
   kernel cannot REWRITE-cap or REFUSE on it. This is a P0 money path that the kernel signs off on the
   shape of (status=refunded) but not the magnitude (centavos).
4. **Admin force-* "two-person rule" is one-person-double-click protection.** Step 1 and Step 2 both gate on
   `requireManager` only; step 2 reads the receipt's `staffId` for audit but never checks
   `request.staffId !== pending.staffId`. The same operator can issue both calls. The route comment claims
   "two-person rule" but the implementation enforces single-operator-with-receipt.
5. **Customer-route scope-cuts from task 14 are documented as deferred but still serve traffic on the legacy
   bypass path.** `payment/retry`, `payment/regenerate-pix`, `notes` endpoints chain three bypasses (deprecated
   `paymentCmdSvc.transitionStatus` → deprecated `paymentCmdSvc.create` → direct `prisma.payment.update`) with
   zero kernel review. Same for cart line-item POST/PATCH/DELETE (Medusa direct).

---

## Confirmed bypasses

Severity = blast radius × likelihood of misuse. P0 = money, LGPD, terminal-state, or admin force.
P1 = customer-visible mutation that should be governed. P2 = analytics/observability gap or stylistic.

| File:line | Mutation | Severity | Fix sketch |
|---|---|:-:|---|
| `apps/api/src/routes/admin/payments.ts:251` | Direct `prisma.payment.update` on `refundedAmountCentavos` after kernel approves status only | **P0** | Extend `payment.status.transition` payload with `refundAmountCentavos`; kernel rewrites/refuses on amount caps. Move write inside `transitionStatusFromEnvelope`'s executor. |
| `apps/api/src/routes/order-actions.ts:836` | Direct `prisma.payment.update` on `regenerationCount` in regenerate-pix; chained with deprecated `paymentCmdSvc.transitionStatus` (819) + `paymentCmdSvc.create` (829) | **P0** | Wrap whole regen flow in a new `order.pix.regenerate` intent envelope dispatched via `runCustomerIntent`. Executor performs the atomic cancel→create→incr inside `paymentCmdSvc.transitionStatusFromEnvelope` + `createFromEnvelope`. |
| `apps/api/src/routes/order-actions.ts:734,745` | `payment/retry` calls deprecated `paymentCmdSvc.transitionStatus`+`create` directly; no kernel | **P0** | New `payment.retry` intent kind on payment policy bundle; wrap endpoint via `runCustomerIntent`. |
| `apps/api/src/routes/admin/reservations.ts:270-280` | Admin reservation cancel via direct `prisma.$transaction([reservation.update + reservationTable.deleteMany + timeSlot.update])` | **P0** | Use `reservationCmdSvc.cancelFromEnvelope(envelope)` (exists per task 15). |
| `packages/tools/src/cart/amend-order.ts:35,357` | Direct `stripe.paymentIntents.create` + `medusaAdmin(POST /admin/orders/$id, edits, edits/items, edits/confirm)` + deprecated `paymentCmdSvc.transitionStatus/create` — entire amend pipeline | **P0** | File is in `ALLOWED_MEDUSA_DIRECT` but is NOT read-only. Either remove from allow-list and route Stripe/Medusa/payment mutations through respective kernel intents, or document that the upstream `order.amend.request` envelope IS the only governance and add `forbiddenPaymentDelta` invariants there. |
| `packages/tools/src/cart/regenerate-pix.ts:99` | `stripe.paymentIntents.create` outside any envelope | **P0** | Same as `payment/regenerate-pix` HTTP endpoint — extend `order.pix.regenerate` kind; tool only fires inside executor. |
| `apps/api/src/routes/cart.ts:706` | `prisma.orderNote.create` direct write for customer checkout notes after successful checkout | **P1** | Use `orderCmdSvc.addNoteFromEnvelope` with `actor=customer` envelope. Best-effort persistence semantics preserved. |
| `apps/api/src/routes/order-actions.ts:589` | Customer POST /api/orders/:id/notes → direct `prisma.orderNote.create`. No kernel review of LLM-influenced text. | **P1** | Use `orderCmdSvc.addNoteFromEnvelope` (envelope-typed entry exists). |
| `apps/api/src/routes/admin/order-actions.ts:692` | Admin staff-notes → direct `prisma.orderNote.create` | **P1** | Same fix as above with `actor=staff`. |
| `apps/api/src/routes/admin/payments.ts:798` | Admin order-notes (third copy of the same anti-pattern) | **P1** | Same fix. |
| `apps/api/src/routes/order-actions.ts:134` | Lazy projection-create fallback path uses deprecated `orderCmdSvc.create` bare-arg | **P1** | Build `order.projection.create` system-actor envelope and call `createFromEnvelope`. |
| `apps/api/src/routes/cart.ts:214-275, 312-316, 511-555` | All cart line-item POST/PATCH/DELETE + sync use direct `medusaStore` writes; never reach kernel | **P1** | Documented scope-cut in task-14 follow-ups. Currently invisible to bypass-detection grep because writes are multi-line. |
| `apps/api/src/routes/cart.ts:166-170, 540-544` | Direct `medusaStore("/store/carts", {method:"POST"})` cart creates | **P1** | Same as above. |
| `apps/api/src/routes/cart.ts:341-345` | Apply-coupon `medusaStore promotions POST` | **P1** | Cart promotions outside kernel — no `order.coupon.apply` intent kind. |
| `apps/api/src/routes/cart.ts:368-383` | Payment-collection + payment-session creates direct to Medusa | **P1** | Money-adjacent path bypasses kernel. |
| `apps/api/src/routes/admin/products.ts:127-130` | `medusaAdmin /admin/products/:id POST` — admin product update | **P1** | Wrap via `medusaAdjudicated()` (no current admin product policy bundle though). |
| `apps/api/src/jobs/no-show-checker.ts:63` | `svc.transition(reservation.id, "no_show")` — deprecated bare-arg reservation transition; mutates state machine | **P1** | Documented as 30-min follow-up. Build `reservation.no_show.mark` system-actor envelope, call `transitionFromEnvelope`. |
| `apps/api/src/routes/order-actions.ts:264` | `paymentCmdSvc.transitionStatus` for active-payment cancel as side-effect of customer order cancel (inside `runCustomerIntent.executor` but the kernel only sees the order cancel intent, not the payment cancel) | **P1** | Build a parallel `payment.status.transition` envelope inside the executor and call `transitionStatusFromEnvelope`. |
| `apps/api/src/routes/auth.ts:390` | `customerSvc.upsertFromPhone` bare-arg in OTP verify | **P2** | Customer create after OTP isn't strictly LLM-driven, but the kernel would still log the audit record. Worth wrapping for uniformity. |
| `apps/api/src/whatsapp/session.ts:134` | `customerSvc` mutation surface within WhatsApp session bootstrap | **P2** | Same reasoning. |

---

## Suspicious carve-outs

### `ALLOWED_MEDUSA_DIRECT` set in `bypass-detection.test.ts:102-115`

| Entry | Claim | Reality |
|---|---|---|
| `packages/tools/src/medusa/adjudicated.ts` | "wrapper itself" | OK |
| `packages/tools/src/medusa/client.ts` | "wrapper itself" | OK |
| `packages/tools/src/cart/get-cart.ts` | read-only | OK — only `medusaStoreFetch GET` |
| `packages/tools/src/cart/assert-cart-ownership.ts` | read-only | OK |
| `packages/tools/src/cart/_shared.ts` | re-export | OK (just re-exports) |
| `packages/tools/src/cart/reorder.ts` | "read-only fetches" | **FALSE** — POSTs to `/store/carts` and `/store/carts/$id/line-items` |
| `packages/tools/src/cart/amend-order.ts` | "read-only fetches" | **FALSE** — POSTs to `/admin/orders/$id`, `/admin/orders/$id/edits`, `edits/items`, `edits/confirm`. Also creates Stripe PaymentIntents and writes Payment rows. |
| `packages/tools/src/catalog/get-nutritional-info.ts` | read-only | OK (only `medusaAdmin GET`) |
| `packages/tools/src/catalog/check-inventory.ts` | read-only | OK |

**Recommendation**: remove `reorder.ts` and `amend-order.ts` from the allow-list; either fix them to go through
`medusaAdjudicated()` for writes, or add a separate `KNOWN_MULTI_HOP_WRITERS` category in the bypass test with
explicit envelope-coverage attestation.

### Bypass-detection regex blind spots

- `FORBIDDEN_MEDUSA` patterns are line-scoped. All real call sites are multi-line.
- `FORBIDDEN_PRISMA` only lists 4 specific patterns (`prisma.orderNote.create`, `prisma.orderProjection.update`,
  `prisma.payment.update`, `prisma.reservation.create`). It misses `prisma.reservationTable.deleteMany`,
  `prisma.timeSlot.update`, `prisma.payment.update` (the regen path), `prisma.$transaction([...])`, and any
  newly-introduced kernel-owned table.
- `PRISMA_SCAN_DIRS` explicitly excludes `apps/api/src/routes`/`jobs`/`subscribers` ("the dynamic smoke test is
  the load-bearing guard"). The dynamic smoke is a single dispatcher-returns-failed test — it cannot detect a
  bypass introduced in a route handler.

### Deprecated bare-arg callers on P0 surfaces (per D8)

| Surface | Callers using bare-arg | Risk |
|---|---|---|
| `paymentCmdSvc.transitionStatus` | `routes/order-actions.ts:264,734,819,909,917`; `tools/cart/amend-order.ts:80,328,343`; `tools/cart/cancel-order.ts:41` | All money-state transitions. Most are inside `runCustomerIntent.executor` (kernel saw the outer envelope) but the payment-state change itself was never separately reviewed by the payment policy. |
| `paymentCmdSvc.create` | `routes/order-actions.ts:745,829,925`; `tools/cart/amend-order.ts:92,374` | Each is a new Payment row (money). |
| `orderCmdSvc.create` | `routes/order-actions.ts:134` | Lazy projection-create fallback path. |
| `reservationSvc.transition` | `jobs/no-show-checker.ts:63` | State-machine mutation outside kernel. |
| `customerSvc.upsertFromPhone` | `routes/auth.ts:390` | New customer row outside kernel (post-OTP). |

The "kernel saw the outer envelope, so it's fine" reasoning only holds if every downstream policy invariant is
encoded into the outer envelope's payload. For order-cancel→payment-cancel and order-amend→payment-replace, the
payment policy's invariants (terminal-state floor, version-vector contention, idempotency on duplicate cancels)
are NOT mirrored in the outer policy. So the deprecated calls form a quiet trust-the-caller surface.

---

## Boot-window race analysis

### Sequence (per `apps/api/src/index.ts` + `server.ts` + `plugins/kernel-bootstrap.ts`)

```
1. process bootstrap (Sentry init)
2. buildServer()
   ├─ Fastify constructed
   ├─ installKernelMetricsSink()  ← MetricsSink installed BEFORE routes
   ├─ Helmet/CORS/JWT/etc.
   ├─ metricsRoutes registered
   └─ registerRoutes()   ← All route handlers attached (no calls yet)
3. bootstrapKernel(server)
   ├─ installFirstPartyPacks()    ← Packs installed here (post-buildServer)
   └─ validateEnforceConfig()     ← Env-var validation
4. server.listen(...)              ← Traffic begins
5. registerWorkers(), startNatsSubscribers(...) start AFTER listen
```

### Race windows

- **Step 2 → 3 window** (between `buildServer()` returning and `bootstrapKernel()` starting): Packs NOT
  installed. If any route handler executed during this window, an `adjudicate()` call would hit a kernel with no
  packs and default-REFUSE per master plan. **But** `server.listen()` happens AFTER `bootstrapKernel`, so no
  HTTP traffic can enter this window. NATS subscribers and BullMQ workers also start later. No race in
  practice.
- **Module-load-time side effects** in any of the imported route files: scanned `apps/api/src/routes/` — no
  top-level mutation calls; all route files define handler closures that don't fire at import. Safe.
- **Step 3 → 4 window**: `bootstrapKernel` is awaited synchronously before `listen()`. Safe.
- **F2 deferred** — `kernel.intent_dispatched` basis code not added to adjudicate sibling repo. Per overnight
  summary, this is required for task 02's audit "supersedes" link. Today, every audit record from a
  resume-path dispatch lacks the predecessor link, so replay-determinism (audit 02 territory) is weakened —
  not a bypass per se but reduces audit-chain integrity.

### Subscriber idempotency

Each subscriber (`payment-lifecycle`, `cart-intelligence`, `conversation-archiver`) does NATS-event dedup via
`isNewEvent()` + envelope dispatch with deterministic `nonce = ${paymentId}:${newStatus}` etc. Replay-safe per
overnight summary. No race introduced.

---

## Scope-cut verification (task 14 / 16 cuts)

### Task 14 (customer mutation routes)

**Documented deferred (not BLOCKED, scope-cut)**:

| Endpoint | File:line | Status | Verification |
|---|---|---|---|
| `POST /api/orders/:id/amend/batch` | `order-actions.ts:310+` | Deferred | Confirmed not wrapped. No `runCustomerIntent` call. |
| `POST /api/orders/:id/payment/retry` | `order-actions.ts:680+` | Deferred — but P0 chain bypass | Three bypasses chained: bare-arg cancel + bare-arg create + no envelope. |
| `POST /api/orders/:id/payment/regenerate-pix` | `order-actions.ts:761+` | Deferred — but P0 chain bypass | Same as above plus a direct `prisma.payment.update`. |
| `PATCH /api/orders/:id/payment/method` | `order-actions.ts:849+` | Deferred | Confirmed not wrapped. |
| `PATCH /api/orders/:id/address` | search | Not present in routes | The route may live in apps/web or not exist yet. Not a current bypass. |
| `PATCH /api/orders/:id/type` | search | Not present in routes | Same. |
| Cart line-item POST/PATCH/DELETE | `cart.ts:192-278, 280-326` | Deferred | Confirmed direct `medusaStore` writes. Bypass-detection grep misses these (multi-line). |
| `POST /api/cart/:id/sync` | `cart.ts:281+` | Deferred | Multi-step direct `medusaStore` writes. |

**Verdict**: scope-cuts are real (not falsely claimed governed) and the routes still bypass. Open-blockers
documentation matches reality. The hidden risk is the bypass-detection grep covering for them by not detecting
the multi-line writes.

### Task 16 (NATS subscribers + BullMQ jobs)

**Wrapped (verified by `*FromEnvelope` calls)**:
- `payment-lifecycle.ts`: `transitionStatusFromEnvelope` confirmed at L122,205.
- `cart-intelligence.ts:order.placed` → `payment.createFromEnvelope` confirmed at L522.
- `conversation-archiver.ts`: `appendMessageFromEnvelope` (claimed; not re-verified).
- `stale-order-checker.ts`: `*FromEnvelope` at L146, L184.
- `pix-expiry-checker.ts`: `transitionStatusFromEnvelope` (claimed; not re-verified).

**Documented deferred (verified analytics-only or egress-only)**:
- `cart-intelligence.ts` Redis analytics writes (profile counters, sorted sets) — confirmed pure Redis, no
  state-machine mutations. ✓
- `notification.send` egress paths — confirmed Twilio sends, no state mutation. ✓
- `handoff-subscriber.ts` — confirmed pure Twilio send via `sender.sendText`, no state mutation. ✓
- `no-show-checker.ts` — **CLAIMED analytics-only is WRONG**. Open-blockers says "30min follow-up" but this
  job actively transitions reservation status to `no_show` via deprecated `svc.transition(id, "no_show")` —
  a state-machine mutation. P1 — not catastrophic (no money), but the documented "30min follow-up" status
  understates the current bypass.
- Other BullMQ jobs (`abandoned-cart`, `proactive-engagement`, etc.) — confirmed WhatsApp egress only.

---

## The 4 admin force-routes (task 13)

| Route | File:line | Two-step receipt | Same-staff allowed? |
|---|---|:-:|:-:|
| `force-cancel` | `admin/order-actions.ts:127, 217` | ✓ | **Yes** — both steps gate on `requireManager` only |
| `waive` | `admin/order-actions.ts:441, ~565` | ✓ | **Yes** |
| `payment/refund` | `admin/payments.ts:299, 441` | ✓ | **Yes** |
| `payment/status/force` | `admin/payments.ts:559, 660` | ✓ | **Yes** (also has OWNER-only check) |

**Lua atomic GET+DEL script** in `admin-confirmation-store.ts:62-70`: correct. `GET` then if-truthy `DEL` then
return. Single-use semantics enforced atomically by Redis. UUID-shape gate before lookup. No race.

**Race against TTL**: 600s TTL on receipt. If the operator's confirmation arrives after expiry, `consume()`
returns nil → 410 Gone. No silent success. ✓

**Same-staff-id loophole**: the route never compares `request.staffId !== pending.staffId`. The comment "two-
person rule" is aspirational, not implemented. Open-blockers acknowledges this obliquely ("functionally
equivalent today") but doesn't call out the gap.

**Nonce-stability**: `pending.nonce = randomUUID()` captured at step 1, reused at step 2 → identical
`intentHash`. Audit dedup safe. ✓

---

## Findings ranked by remediation effort vs blast radius

| # | Finding | Effort | Blast radius | Priority |
|:-:|---|:-:|:-:|:-:|
| 1 | `admin/payments.ts:251` refund amount unaudited | M (extend payload schema + executor) | $$$ | P0 |
| 2 | Two-person rule not enforced (4 admin routes) | XS (3-line check) | High (insider risk) | P0 |
| 3 | `ALLOWED_MEDUSA_DIRECT` carve-outs are FALSE (reorder, amend-order) | S (remove + wrap) | $$$ | P0 |
| 4 | Bypass-detection grep is line-based; misses multi-line writes | M (rewrite scanner with multi-line context) | High (CI sign-off is performative) | P0 |
| 5 | `payment/retry` + `payment/regenerate-pix` 3-bypass chain | L (new intent kinds + payload schemas) | $$$ | P0 |
| 6 | `admin/reservations.ts:270` direct `$transaction` cancel | S (use existing `cancelFromEnvelope`) | Medium | P0 |
| 7 | `amend-order.ts` Stripe + Medusa + payment-svc bypasses inside one tool | XL (decompose into 5-6 envelopes) | $$$ | P0 |
| 8 | `orderNote.create` direct writes (4 sites) | S (use `addNoteFromEnvelope`) | Low ($) | P1 |
| 9 | Cart line-item route bypasses | M (build `order.item.*` envelopes per task-14 follow-up) | Medium | P1 |
| 10 | `no-show-checker` reservation transition bare-arg | XS (build envelope + call `*FromEnvelope`) | Medium | P1 |
| 11 | Lazy projection-create at `order-actions.ts:134` | S | Medium | P1 |
| 12 | `customerSvc.upsertFromPhone` post-OTP not governed | XS (build customer.create envelope at auth-success) | Low | P2 |

**Pattern observation**: The bypasses cluster in three places — (a) the cart/order-amendment toolset
(`packages/tools/src/cart/`), (b) the customer-route layer that didn't make it into task 14's wrap, and (c)
the admin route layer where the two-person rule was claimed but not enforced. Investments #2 + #3 + #4 cost
hours and close systemic gaps; #5 + #7 cost days but close the largest dollar exposure.
