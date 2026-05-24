> ⚠️ **SUPERSEDED on 2026-05-24.** Phase-1 pre-cutover investigation (2026-05-22). The ~50 Prisma mutation site inventory and "0% adjudication coverage" finding drove the migration. For current state, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# 03 — Database & Commerce Mutation Surfaces

Scope: every persistence-layer mutation in the IbateXas monorepo — Prisma writes
against the `ibx_domain` schema plus all Medusa v2 commerce mutations (workflows,
subscribers, custom services, store/admin API hops). The goal is to enumerate
each mutation site, attribute it to a caller chain, and flag whether the
Zero-Trust kernel (`@adjudicate/core`) sees it before it lands on the database.

## Executive summary

- **Inventory size.** Excluding generated Prisma client code, test mocks, seeds,
  and CLI maintenance commands, there are **~50 production-runtime Prisma
  mutation sites** spread across `packages/domain/src/services/`,
  `packages/tools/src/`, and `apps/api/src/`. Including seeds, CLI commands, and
  cleanup utilities the count is 88.
- **Adjudication coverage today: zero.** The kernel
  (`adjudicate()` from `@adjudicate/core/kernel`) is only invoked at one site —
  `packages/llm-provider/src/llm-responder.ts:317` — and `.env` ships with
  `IBX_KERNEL_ENFORCE` / `IBX_KERNEL_SHADOW` unset. Even when the responder
  picks a kernel decision, the downstream `onToolIntent` consumer is never
  wired (see Investigation 01). The actual writes to Postgres happen on a
  *different* path — the deterministic kernel-executor (XState) calls cart/cancel
  tools, and those tools call `prisma.*` and `medusaStore`/`medusaAdmin` HTTP
  hops directly. **No Prisma mutation in this repo currently passes through
  `adjudicate()` before hitting the DB.**
- **Bypass shape #1 — `packages/tools` cart utilities.** Three "post-order"
  mutation tools (`add-order-note.ts`, `switch-order-type.ts`,
  `change-delivery-address.ts`) write directly to `prisma.orderNote` and
  `prisma.orderProjection` with no kernel envelope. `add_order_note` is not even
  registered in the LLM tool registry (line 137 of `tool-registry.ts`) yet exists
  as a callable function — meaning the LLM cannot propose it, but `apps/api`
  routes can and do invoke it.
- **Bypass shape #2 — direct API routes.** `apps/api/src/routes/order-actions.ts`
  (`POST /api/orders/:id/notes`, `POST /api/orders/:id/payment/regenerate-pix`,
  `PATCH /api/orders/:id/payment/method`) mutate Prisma and call domain command
  services without any intent envelope. These are reachable by any
  customer-authenticated session — including those originated by the WhatsApp
  agent indirectly via its own HTTP path.
- **Bypass shape #3 — admin routes.** Every mutation in
  `apps/api/src/routes/admin/*.ts` is gated only by staff role middleware
  (`requireStaff`, `requireManagerRole`). There is no audit envelope, no intent
  hash, no shadow log.
- **Bypass shape #4 — background jobs.** `pix-expiry-checker` and
  `stale-order-checker` mutate Payment and OrderProjection state under Redis
  locks but with no adjudication record. Locks alone do not produce an audit
  trail.
- **Bypass shape #5 — subscribers.** `apps/api/src/subscribers/cart-intelligence.ts`
  (handles `order.placed` and `cart.abandoned`) invokes
  `createCustomerService().recordOrderItems`, `createOrderCommandService()`,
  `createPaymentCommandService()`, and `createLoyaltyService().addStamp` —
  every one a Prisma mutation, none envelope-wrapped. NATS redelivery
  idempotence is enforced by the event log, not the kernel.
- **Bypass shape #6 — Medusa workflows.** There are **no custom Medusa
  workflows**. `apps/commerce/src/workflows/` is empty. Cart/order mutations go
  through Medusa's HTTP store API via `medusaStore`/`medusaAdmin` from
  `packages/tools/src/cart/` — that surface is the de-facto commerce mutation
  surface and is wholly outside the adjudicate boundary today.
- **Raw SQL escape hatches.** Two production sites: `reservation.service.ts:252`
  (`tx.$queryRaw\`SELECT ... FOR UPDATE\``), `customer.service.ts:187`
  (dormant-customer GROUP BY query), plus `apps/api/src/routes/health.ts:56`
  (`prisma.$queryRawUnsafe("SELECT 1")` health probe). These are read-only or
  read-modify-write inside `$transaction`. No DML `$executeRaw` exists.
- **Seeds and dev fixtures.** `pnpm db:seed` calls Medusa seed and the four
  `packages/domain/src/seed-*.ts` scripts. `db reset` and `db clean` invoke
  `guardDestructive` (blocks if `NODE_ENV === "production"`); **seeds and
  backfill jobs do NOT call `guardDestructive`** — `runBackfillOrderProjections`
  / `runBackfillPayments` (`packages/cli/src/commands/db.ts:550, 679`) can run
  in prod and contain `upsert` + `create` against `OrderProjection`,
  `OrderStatusHistory`, and `Payment`.
- **Redis locks vs. adjudication.** Four production withLock() call sites:
  `pix-expiry-checker.ts`, `stale-order-checker.ts`, `stripe-webhook.ts`,
  `order-actions.ts:795` (PATCH payment method). All use the
  UUID + Lua release pattern correctly (CLAUDE.md rule #10). Locks **do not**
  imply adjudication — the kernel never sees these mutations.

Severity overall: **P0 for the unadjudicated persistence layer.** Migration plan
must treat every domain service mutation site as in-scope, not just the
LLM-visible tool surface.

## Prisma schema overview

Schema: `packages/domain/prisma/schema.prisma` (single file, 638 lines), all
models in the `ibx_domain` Postgres schema (Medusa lives elsewhere in the same
database).

Generated client output: `packages/domain/src/generated/prisma-client/` (Prisma 7
client, uses `@prisma/adapter-pg` driver — Rust-free).

Singleton: `packages/domain/src/client.ts:37` (lazy Proxy + `globalForPrisma`).
All call sites import `{ prisma }` from `@ibatexas/domain`.

### Models (21 + 8 enums)

**Reservations / capacity:**
- `Table` — physical tables (`tables`)
- `TimeSlot` — bookable slots (`time_slots`), `reservedCovers` is the atomic
  counter
- `Reservation` — bookings (`reservations`), FK to Customer + TimeSlot
- `ReservationTable` — join table (`reservation_tables`)
- `Waitlist` — slot-full overflow (`waitlist`)

**Customer / auth (sensitive):**
- `Customer` — phone-keyed customer profile (`customers`), nullable `medusaId`
  linking to Medusa's customer record
- `Address` — delivery addresses (`addresses`)
- `CustomerPreferences` — allergens / dietary (`customer_preferences`)
- `CustomerOrderItem` — per-item order log (`customer_order_items`), preserved
  on customer deletion via `SetNull` for analytics
- `Staff` — restaurant staff (OWNER/MANAGER/ATTENDANT) — phone-keyed,
  Twilio-OTP-authenticated
- `LoyaltyAccount` — punch-card stamps (`loyalty_accounts`)

**Orders / payments (highly sensitive):**
- `OrderProjection` — read-side projection of Medusa order, source of truth for
  fulfillment status (`order_projections`)
- `OrderStatusHistory` — append-only transitions (`order_status_history`)
- `OrderEventLog` — append-only event log w/ `idempotencyKey` unique constraint
  (`order_event_log`)
- `Payment` — payment attempts, partial unique index on active payment
  (`payments`)
- `PaymentStatusHistory` — append-only payment transitions
  (`payment_status_history`)
- `OrderNote` — customer + admin notes on orders (`order_notes`), `isInternal`
  flag

**Conversations / content:**
- `Review` — product reviews (`reviews`), unique on `(orderId, customerId)`
- `Conversation` — chat sessions (`conversations`)
- `ConversationMessage` — chat transcript (`conversation_messages`)

**Operational config:**
- `DeliveryZone` — CEP-prefix delivery rules (`delivery_zones`)
- `WeeklySchedule` — restaurant opening hours (`weekly_schedules`)
- `Holiday` — closed days (`holidays`)
- `ScheduleOverride` — per-date override (`schedule_overrides`)

**Enums:** `TableLocation`, `ReservationStatus`, `StaffRole`, `PaymentStatus`,
`OrderFulfillmentStatus`, `OrderActor`, `ConversationChannel`, `MessageRole`.

Sensitive tables for adjudication priority:
- **Payment lifecycle:** `Payment`, `PaymentStatusHistory`, `OrderProjection`
  (paymentStatus/currentPaymentId fields).
- **Order lifecycle:** `OrderProjection`, `OrderStatusHistory`, `OrderNote`.
- **Identity:** `Customer`, `Staff`, `CustomerPreferences`.
- **Reservation capacity:** `TimeSlot.reservedCovers` (atomic increment under
  `FOR UPDATE` lock).

## Prisma mutation inventory

Column "Adjud?": `N` = bypasses kernel (today: all of them), `N (rdo)` = call
is read-only and listed for completeness, `N (build)` = seed/CLI gated by
`guardDestructive` or dev-only.

### `packages/domain/src/services/` (the canonical command surface)

| File:line | Model | Operation | Adjud? | Caller chain |
|---|---|---|---|---|
| reservation.service.ts:270 | Reservation | create (in tx) | N | tool `create_reservation` (LLM) + API `/api/reservations` |
| reservation.service.ts:284 | TimeSlot | update reservedCovers ++ | N | same as above |
| reservation.service.ts:331 | TimeSlot | update reservedCovers -- | N | tool `modify_reservation` |
| reservation.service.ts:336 | ReservationTable | deleteMany | N | tool `modify_reservation` |
| reservation.service.ts:340 | TimeSlot | update reservedCovers ++ | N | tool `modify_reservation` |
| reservation.service.ts:345 | Reservation | update (relink slot) | N | tool `modify_reservation` |
| reservation.service.ts:371 | Reservation | update status=cancelled | N | tool `cancel_reservation` |
| reservation.service.ts:375 | ReservationTable | deleteMany | N | tool `cancel_reservation` |
| reservation.service.ts:376 | TimeSlot | update reservedCovers -- | N | tool `cancel_reservation` |
| reservation.service.ts:400 | Reservation | update no_show | N | admin `transition` (no-show job + admin route) |
| reservation.service.ts:401 | TimeSlot | update reservedCovers -- | N | same |
| reservation.service.ts:405 | ReservationTable | deleteMany | N | same |
| reservation.service.ts:410 | Reservation | update generic | N | `svc.transition` (admin checkin/complete) |
| reservation.service.ts:428 | Waitlist | update notifiedAt+expiresAt | N | `promoteWaitlist` job |
| reservation.service.ts:468 | Waitlist | create | N | tool `join_waitlist` |
| order-command.service.ts:108-146 | OrderProjection, OrderStatusHistory | create (in tx) | N | subscriber `cart-intelligence` (order.placed), stripe-webhook |
| order-command.service.ts:153-203 | OrderProjection, OrderStatusHistory | transitionStatus (in tx) | N | admin `/api/admin/orders/:id/status`, jobs |
| order-command.service.ts:244-256 | OrderProjection, OrderStatusHistory | reconcileStatus (in tx) | N | NATS subscriber safety net |
| payment-command.service.ts:135-180 | Payment, PaymentStatusHistory | create (in tx, partial unique) | N | stripe-webhook, order-actions, regenerate-pix |
| payment-command.service.ts:188-260 | Payment, PaymentStatusHistory | transitionStatus | N | stripe-webhook, jobs, admin routes |
| payment-command.service.ts:306-340 | Payment | switchMethod (in tx) | N | tools, order-actions PATCH method |
| order-event-log.service.ts:51 | OrderEventLog | upsert (idempotencyKey-keyed) | N | subscribers, stripe-webhook |
| customer.service.ts:18 | Customer | upsert (phone-keyed) | N | `findOrCreate` (chat + WhatsApp init) |
| customer.service.ts:49 | CustomerPreferences | upsert | N | tool `update_preferences` (LLM-MUTATING) |
| customer.service.ts:76 | Review | upsert | N | tool `submit_review` (LLM-MUTATING) |
| customer.service.ts:129 | CustomerOrderItem | createMany | N | subscriber `cart-intelligence` (order.placed) |
| customer.service.ts:148 | Customer | update pix details | N | `updatePixDetails` after PIX checkout |
| customer.service.ts:172 | Customer | upsert | N | `upsertFromWhatsApp` (WhatsApp init) |
| customer.service.ts:233-251 | Customer, Address, CustomerPreferences, CustomerOrderItem | update/deleteMany/updateMany (in tx) | N | `anonymizeCustomer` — LGPD Art. 18 deletion (`/api/me/delete`) |
| conversation.service.ts:33 / 49 | Conversation | create (FK retry) | N | subscriber `conversation-archiver` |
| conversation.service.ts:72 | ConversationMessage | create | N | same |
| conversation.service.ts:123 | Conversation | delete (sessionId) | N | admin / chat clear |
| conversation.service.ts:132 | Conversation | deleteMany | N | admin clear-all |
| schedule.service.ts:38 | WeeklySchedule | upsert | N | admin `/api/admin/schedule/weekly` |
| schedule.service.ts:66 | Holiday | create | N | admin `/api/admin/schedule/holidays` |
| schedule.service.ts:86 | Holiday | delete | N | same |
| schedule.service.ts:115 | ScheduleOverride | upsert | N | admin `/api/admin/schedule/overrides` |
| schedule.service.ts:131 | ScheduleOverride | delete (catch) | N | same |
| schedule.service.ts:167 | WeeklySchedule | createMany | N | seed/init only |
| table.service.ts:26 | Table | upsert | N | admin `/api/admin/tables` |
| table.service.ts:71 | TimeSlot | createMany skipDuplicates | N | admin schedule generation |
| delivery-zone.service.ts:25 | DeliveryZone | create | N | admin `/api/admin/delivery-zones` |
| delivery-zone.service.ts:39 | DeliveryZone | update | N | same |
| delivery-zone.service.ts:44 | DeliveryZone | delete | N | same |
| loyalty.service.ts:12 | LoyaltyAccount | upsert | N | subscriber + tool `get_loyalty_balance` |
| loyalty.service.ts:25, 32 | LoyaltyAccount | update stamps | N | subscriber `cart-intelligence` (addStamp on order.placed) |
| review.service.ts (curate ops) | Review | various | N | admin reviews routes |

### `packages/tools/src/` (LLM-visible tools that bypass services and write directly)

| File:line | Model | Operation | Adjud? | Caller chain |
|---|---|---|---|---|
| cart/add-order-note.ts:49 | OrderNote | create | N | `add_order_note` tool — NOT registered in `TOOL_DEFINITIONS` but exported and callable; reachable from API routes that import the function |
| cart/switch-order-type.ts:70 | OrderProjection | update deliveryType + shipping | N | `switch_order_type` function — exported, called from `apps/api/src/routes/order-actions.ts:34` (amendOrder uses changeDeliveryAddress + switchOrderType internally) |
| cart/change-delivery-address.ts:61 | OrderProjection | update shippingAddressJson | N | `change_delivery_address` function — exported and reachable via API |

These three are particularly notable because they **side-step the
OrderCommandService entirely** — they write OrderProjection rows that the
service's optimistic-concurrency `version` field doesn't see. A concurrent
`transitionStatus` could lose data.

### `apps/api/src/` (HTTP routes mutating directly)

| File:line | Model | Operation | Adjud? | Caller chain |
|---|---|---|---|---|
| routes/order-actions.ts:478 | OrderNote | create | N | `POST /api/orders/:id/notes` (authenticated customer) |
| routes/order-actions.ts:725 | Payment | update regenerationCount ++ | N | `POST /api/orders/:id/payment/regenerate-pix` |
| routes/cart.ts:618 | OrderNote | create | N | `POST /api/cart/checkout` (best-effort note persist) |
| routes/admin/reservations.ts:155 (tx) | Reservation, ReservationTable, TimeSlot | update/deleteMany/update | N | `POST /api/admin/reservations/:id/cancel` (MANAGER) |
| routes/admin/payments.ts:157 | Payment | update refundedAmountCentavos | N | `POST /api/admin/orders/:id/payment/refund` (MANAGER) |
| routes/admin/payments.ts:273 | OrderNote | create | N | `POST /api/admin/orders/:id/notes` (STAFF) |
| routes/admin/order-actions.ts:262 | OrderNote | create | N | `POST /api/admin/orders/:id/staff-notes` (STAFF, `isInternal=true`) |

### Jobs

| File:line | Caller | Mutation surface | Adjud? | Notes |
|---|---|---|---|---|
| jobs/pix-expiry-checker.ts:35-100 | BullMQ repeat 5min | `paymentSvc.transitionStatus(PAYMENT_EXPIRED)` + Stripe PI cancel | N | Under `withLock(\`payment:${id}\`)`. No envelope. |
| jobs/stale-order-checker.ts:60-130 | BullMQ repeat 30min | `orderCmdSvc.transitionStatus(canceled)` + `paymentCmdSvc.transitionStatus` | N | Under `withLock(\`order:${id}\`)`. Dry-run gate. |
| jobs/no-show-checker.ts | BullMQ | `reservationSvc.transition('no_show')` | N | Mutates TimeSlot.reservedCovers |
| jobs/abandoned-cart-checker.ts, cart-recovery-messages.ts, follow-up-poller.ts | BullMQ | NATS publish + Redis writes (no Prisma mutation directly) | N | Effect lands via cart-intelligence subscriber |
| jobs/review-prompt-poller.ts | BullMQ | NATS publish | N | Indirect mutation via downstream |
| jobs/outbox-retry.ts | BullMQ | NATS replay | N | No DB write |

### Subscribers

| File | Caller | Mutation surface | Adjud? |
|---|---|---|---|
| apps/api/src/subscribers/cart-intelligence.ts | NATS `order.placed`, `cart.abandoned` | customerSvc.recordOrderItems, orderCmdSvc, paymentCmdSvc.create, loyaltySvc.addStamp | N |
| apps/api/src/subscribers/conversation-archiver.ts | NATS `conversation.message.appended` | conversationSvc.findOrCreate + appendMessage | N |
| apps/api/src/subscribers/payment-lifecycle.ts | NATS `payment.status_changed` | orderCmdSvc.transitionStatus, eventLogSvc.append | N |
| apps/api/src/subscribers/defer-resolver.ts | NATS | (pure Redis state) | N/A |
| apps/api/src/subscribers/handoff-subscriber.ts | NATS | (notification only) | N/A |
| apps/commerce/src/subscribers/order-delivered.ts | Medusa event bus | NATS publish only | N/A |
| apps/commerce/src/subscribers/product-{created,updated,deleted}.ts, variant-updated.ts, price-updated.ts | Medusa event bus | Typesense + Redis cache (no Prisma mutation) | N/A |

### CLI / seeds (gating differs)

| File:line | Operation | Gating | Notes |
|---|---|---|---|
| packages/cli/src/lib/clean.ts:9-19 | deleteMany over 11 models | `db clean` → `guardDestructive` blocks NODE_ENV=production | Used by `db reset` |
| packages/cli/src/lib/scenario-engine.ts:132, 159 | Review, CustomerOrderItem deleteMany | `simulate` cmds → `guardDestructive` | Dev only |
| packages/cli/src/lib/simulator.ts:277, 399, 426 | Customer upsert, CustomerOrderItem create, Review create | `simulate` cmds → `guardDestructive` | Dev only |
| packages/cli/src/commands/orders.ts:146 | OrderProjection update | `orders rebuild` | **Not gated** — manual prod operator override |
| packages/cli/src/commands/auth.ts:198, 206 | Staff update/create | `auth staff:create` | **Not gated** — must be allowed in prod |
| packages/cli/src/commands/db.ts:607, 622 | OrderProjection upsert, OrderStatusHistory create | `db backfill:projections` | **Not gated** — runnable in prod |
| packages/cli/src/commands/db.ts:718 | Payment create in tx | `db backfill:payments` | **Not gated** |
| packages/cli/src/matrices/index.ts:172, 186, 227, 281, 330 | Review, CustomerOrderItem deleteMany | `matrix` simulation | Dev tool |
| packages/domain/src/seed-tables.ts:51, 84 | Table upsert, TimeSlot createMany | `db:seed:tables` | **Not gated** — relies on operator discipline |
| packages/domain/src/seed-homepage.ts:195, 257 | Customer + Review upsert | `db:seed:homepage` | **Not gated** |
| packages/domain/src/seed-delivery.ts:147, 152, 173, 175, 194 | DeliveryZone, Address, CustomerPreferences | `db:seed:delivery` | **Not gated** |
| packages/domain/src/seed-orders.ts:397, 475, 493 | CustomerOrderItem create, Reservation create, TimeSlot update | `db:seed:orders` | **Not gated** |

## Medusa mutation surfaces

### Workflows

`apps/commerce/src/workflows/` is **empty**. There are no custom Medusa
workflows. All commerce mutations either use Medusa's stock workflows (invoked
via REST) or bypass them via the seed/admin client.

### Services / Modules

`apps/commerce/medusa-config.ts` registers only the **Stripe Payment provider**
under `@medusajs/medusa/payment` with `paymentMethodTypes: ["card", "pix"]`. No
custom Medusa modules, no extended product/cart services. The PIX lifecycle is
handled domain-side via `Payment` rows + Stripe PaymentIntent state, not in
Medusa's payment module.

### Subscribers

Seven Medusa-side subscribers, all in `apps/commerce/src/subscribers/`:

- **Indexing only:** `_product-indexing.ts` (helper), `product-created.ts`,
  `product-updated.ts`, `variant-updated.ts`, `price-updated.ts` — all push to
  Typesense, no Postgres writes.
- **Cache invalidation:** `product-deleted.ts` — Typesense delete + NATS purge.
- **NATS bridge:** `order-delivered.ts` — publishes `review.prompt.schedule` for
  the API-side review-prompt-poller.

None of these mutate Postgres directly. The indexing subscribers do mutate
Typesense (search index) — that's a separate consistency surface not in scope
for adjudicate.

### API extensions

`apps/commerce/src/api/` directory does NOT exist. Medusa runs in stock
configuration with only the Stripe module. All custom commerce endpoints live
in `apps/api/` (Fastify) and call Medusa over HTTP via `medusaStore` /
`medusaAdmin` from `packages/tools/src/medusa/client.ts`.

### Medusa HTTP mutation surface (used by `packages/tools/src/cart/`)

This is the actual commerce-mutation surface today. Auth: admin JWT
(emailpass) cached in-memory, store publishable key resolved at runtime.

- `POST /store/carts` — create cart (`get-or-create-cart.ts`, `reorder.ts`,
  `create-checkout.ts`)
- `POST /store/carts/:id/line-items` — add line items (`add-to-cart.ts`,
  `reorder.ts`)
- `POST /store/carts/:id/line-items/:itemId` — update line items
  (`update-cart.ts`)
- `DELETE /store/carts/:id/line-items/:itemId` — remove
  (`remove-from-cart.ts`)
- `POST /store/carts/:id/promotions` — coupon apply (`apply-coupon.ts`,
  `create-checkout.ts`)
- `POST /store/carts/:id` (update) + `POST /store/carts/:id/complete` —
  checkout (`create-checkout.ts`)
- `POST /store/payment-collections` + payment sessions —
  (`create-checkout.ts`)
- `POST /admin/orders/:id` — admin metadata (`amend-order.ts`)
- `POST /admin/orders/:id/edits[/items][/confirm]` — order edits
  (`amend-order.ts`)
- `POST /admin/orders/:id/cancel` — admin cancel (via `OrderService` in
  `cancel-order.ts`)

**Every one of these is unadjudicated.** The kernel-executor
(`packages/llm-provider/src/kernel-executor.ts`) calls `cancelOrder`,
`regeneratePix`, `addItemToCart`, `processCheckout`, etc. directly — bypassing
both the LLM responder's `adjudicate()` call and any intent envelope.

The LLM/intent flow interacts with Medusa exclusively through these HTTP
hops — there is no Medusa SDK usage, no direct Medusa module resolution from
the API process. `packages/tools/src/cart/_shared.ts` re-exports
`medusaStore`/`medusaAdmin` from `packages/tools/src/medusa/client.ts` for cart
tools; admin tooling uses `medusaAdmin` directly.

## Raw SQL / escape hatches

Three production sites use raw SQL. None do DML directly.

1. `packages/domain/src/services/reservation.service.ts:252`
   ```
   const locked = await tx.$queryRaw<TimeSlotRow[]>(
     Prisma.sql`SELECT * FROM ibx_domain.time_slots WHERE id = ${input.timeSlotId} FOR UPDATE`
   )
   ```
   Read-with-lock inside `$transaction`. The subsequent updates are normal
   Prisma calls.

2. `packages/domain/src/services/customer.service.ts:187`
   ```
   const dormant = await prisma.$queryRaw`
     SELECT c.id, c.phone, c.name FROM ibx_domain.customers c
     INNER JOIN ibx_domain.customer_order_items coi ON coi.customer_id = c.id
     ...
   ` as Array<...>
   ```
   Read-only dormancy report.

3. `apps/api/src/routes/health.ts:56`
   ```
   await prisma.$queryRawUnsafe("SELECT 1");
   ```
   Liveness probe. The `Unsafe` variant is used because the literal `"SELECT 1"`
   is constant (no interpolation). Still: it's the only `Unsafe` raw call in
   the codebase.

No `$executeRaw` / `$executeRawUnsafe` mutation sites exist.

Prisma migrations live at `packages/domain/prisma/migrations/` and run only
via `prisma migrate deploy` (CLI). No application code triggers migrations at
runtime.

## Scripts and seeds

`pnpm db:seed` is wired in `packages/cli/src/commands/db.ts:50` and runs
`pnpm --filter @ibatexas/commerce db:seed` → `apps/commerce/src/seed.ts`
(Medusa side: creates store, channels, region, categories, products, variants,
prices via Medusa modules — pure Medusa workflow, not Prisma).

Domain seeds are separate (`db:seed:tables`, `db:seed:homepage`,
`db:seed:delivery`, `db:seed:orders` — see CLI section above). **None call
`guardDestructive`.** A `pnpm db:seed:*` invocation against a production
`DATABASE_URL` will silently mutate or create records.

`db reset` and `db clean` correctly call `guardDestructive` and abort if
`NODE_ENV === "production"` or `APP_ENV === "production"`. The `simulate` and
`test e2e` commands also gate. Backfill commands (`db backfill:projections`,
`db backfill:payments`) and `auth staff:create` and `orders rebuild` **do not
gate**. They are intended for prod use; that's appropriate for staff bootstrap
but means the `OrderProjection.upsert`/`OrderStatusHistory.create` calls in
`db.ts:607-633` can run against prod without any envelope.

`scripts/` at repo root contains shell deploy/bootstrap scripts; none execute
DB mutations directly outside of invoking `pnpm` commands.

## Lock vs. adjudication coverage

Redis lock is a **mutual-exclusion mechanism**, not an audit/decision
mechanism. CLAUDE.md rule #10 requires UUID-value Lua-conditional release; the
codebase complies via `packages/tools/src/redis/distributed-lock.ts`
(`acquireLock` + `withLock`).

### Lock coverage (4 production sites + tool-side internal locks)

| Site | Resource | Purpose |
|---|---|---|
| apps/api/src/jobs/pix-expiry-checker.ts:53 | `payment:${id}` | Serialize payment expiry |
| apps/api/src/jobs/stale-order-checker.ts:106 | `order:${id}` | Serialize stale-order cancellation |
| apps/api/src/routes/stripe-webhook.ts:61 | `payment:${id}` | Serialize Stripe event processing |
| apps/api/src/routes/order-actions.ts:795 | `payment:${id}` | Serialize PATCH payment method |
| packages/tools/src/cart/amend-order.ts:326 | `payment:${id}` | Serialize amend → payment switch |
| packages/tools/src/cart/regenerate-pix.ts:76 | `payment:${id}` | Serialize PIX regeneration |
| packages/tools/src/cart/get-or-create-cart.ts:115 | bare `redis.set NX` (no Lua release) | Cart bootstrap dedup — **does NOT use withLock** |
| apps/api/src/whatsapp/session.ts | UUID + Lua per CLAUDE.md note | Agent session lock (reference impl) |

### Adjudication coverage

**Zero.** No mutation site in the inventory above flows through `adjudicate()`.
The one call site (`llm-responder.ts:317`) currently feeds an `onToolIntent`
hook that has no consumer (see Investigation 01).

### Lock-without-adjudication gaps

Every locked mutation is unadjudicated, but the most pressing ones (Payment
state transitions, Order projection writes) are also the highest-value targets
for the kernel because they cross the customer-facing trust boundary
(PIX/Stripe/refund flows). Adding the kernel here gives a complete audit trail
without changing the existing concurrency model.

## Highest-risk unadjudicated mutations

Ranked by combined factors of (a) impact of an unintended write, (b) reachability
from LLM/untrusted input, (c) absence of compensating controls.

### P0 — Customer-reachable, money-touching, no adjudication

1. **Payment state transitions via `PaymentCommandService`**
   (`packages/domain/src/services/payment-command.service.ts`). Called from
   `stripe-webhook.ts`, `order-actions.ts` (PATCH method, regenerate PIX, retry,
   cash confirm), `admin/payments.ts` (refund, force-status), jobs.
   Each call is locked and recorded in `PaymentStatusHistory`, but the kernel
   never validates the transition. A buggy webhook or admin override can shift
   a paid order back to `awaiting_payment` and the only record is the history
   row — there is no envelope hash, no intent shadow log, no replay path.
2. **`OrderProjection.update` from `packages/tools/src/cart/switch-order-type.ts`
   and `change-delivery-address.ts`.** These bypass `OrderCommandService`
   entirely and write directly to the projection. The projection's
   `version` counter (optimistic concurrency) is not bumped — a concurrent
   `transitionStatus` won't see this write. Reachable via API
   `/api/orders/:id/...` and via the LLM through `amend_order` →
   `changeDeliveryAddress`/`switchOrderType` calls.
3. **`add_order_note` tool** (`packages/tools/src/cart/add-order-note.ts`).
   Writes to `OrderNote`. Not in the LLM registry but the function is exported
   and called from API routes. A misuse path: LLM cancellation flows could in
   future register this tool; today the API path lets any authenticated
   customer write up to 500-char notes — no rate limit, no envelope.
4. **`anonymizeCustomer`** (`packages/domain/src/services/customer.service.ts:232`).
   Single endpoint `DELETE /api/me` (`apps/api/src/routes/me.ts:107`). Updates
   Customer + delete Address/CustomerPreferences + nullify CustomerOrderItem.
   No envelope, no audit beyond Customer.updatedAt. LGPD-relevant, irrevocable.
5. **`pix-expiry-checker` + `stale-order-checker` background jobs.** Both can
   silently move orders to `canceled` / payments to `payment_expired` without
   any intent record. If the cron misfires or the thresholds are misconfigured,
   the only forensic trace is the status-history rows.

### P1 — High-volume or analytics-tainting

6. **`cart-intelligence` subscriber** (`apps/api/src/subscribers/cart-intelligence.ts`).
   Mutates `CustomerOrderItem` (createMany), `LoyaltyAccount` (addStamp),
   `OrderProjection` (transitions on cart.abandoned tiers), `Payment` (create
   on retry). Driven by NATS — payload integrity is the only gate.
7. **`order-event-log.service` upsert** — idempotency key is the only check.
   A bug that produces a colliding `idempotencyKey` silently overwrites payload
   history. Append-only invariant is structural, not adjudicated.
8. **`update_preferences` (LLM tool) and `submit_review` (LLM tool)** — both
   are MUTATING in `TOOL_CLASSIFICATION` (`machine/types.ts:386-407`), both
   travel through `tool-registry.ts` capture-as-intent, but the kernel decision
   that follows (`llm-responder.ts:316`) defaults to legacy EXECUTE, then
   `onToolIntent` is a no-op (per Investigation 01). Net effect: the LLM emits
   `tool_use`, the user sees "Solicitação registrada", and **the write never
   happens**. (This is a silent-failure pattern, opposite of an over-permissive
   one — but it's still an adjudication gap.)
9. **CLI `db backfill:projections`** (`packages/cli/src/commands/db.ts:550`).
   Pages through Medusa orders, upserts OrderProjection rows with `version=1`,
   creates `OrderStatusHistory` with `actor='system_backfill'`. Runnable in
   prod, no envelope. The `actor='system_backfill'` value is the audit
   convention but is application-enforced, not kernel-enforced.

### P2 — Admin / staff scope, slower attack surface

10. Admin routes (`apps/api/src/routes/admin/*.ts`) — staff role gate is the
    only check. `requireStaff`/`requireManagerRole` runs ahead of any mutation.
11. Seed scripts running in non-prod environments — risk is dev-data
    contamination of shared environments.
12. `conversation-archiver` writes — high write volume, but limited to
    Conversation/ConversationMessage append-only.

## Gaps and recommendations

### Persistence-layer governance gaps

1. **No envelope coverage for Prisma mutations.** The kernel adjudicates the
   LLM's *proposal* via `tool-registry.ts:385` (build envelope), but no
   envelope ever reaches `prisma.*.create/update/...`. The migration needs to
   produce an envelope at the domain-service entry point (e.g.
   `OrderCommandService.transitionStatus`) OR wrap the Prisma call at a lower
   layer.

2. **Three privileged write paths bypass the OrderCommandService.** The
   `packages/tools/src/cart/{add-order-note,switch-order-type,change-delivery-address}.ts`
   files write to `OrderNote` / `OrderProjection` directly. They must move
   under `OrderCommandService` (or a sibling "OrderProjectionService") so
   adjudication has a single chokepoint per model.

3. **No prod gate on seeds and backfill scripts.** `guardDestructive` is
   selectively applied. Backfill commands (`db backfill:*`) and seeds
   (`db:seed:*`) need either (a) explicit `--prod-confirm` flag, (b)
   `guardDestructive` with an "operational" allowlist, or (c) refusal of
   `DATABASE_URL` pointing at prod by default.

4. **Subscribers are wholly unadjudicated.** Every NATS subscriber that writes
   should produce a kernel envelope keyed on `eventId` so replay is
   auditable. Today only the `OrderEventLog.idempotencyKey` constraint
   prevents duplicate state mutation.

5. **Medusa side: zero adjudication, zero auditing.** Cart, checkout,
   line-item, payment-collection, order-edit and order-cancel calls all leave
   the IbateXas process and hit Medusa's HTTP API via cached admin JWT. The
   only forensic record is Medusa's internal event bus and our NATS bridge.
   Recommendation: introduce a `medusaAdjudicated()` wrapper around
   `medusaStore`/`medusaAdmin` that emits an envelope before the HTTP call.

6. **Locks ≠ audit.** Every `withLock(...)` site is correct per CLAUDE.md
   rule #10 but does not write to an audit sink. The kernel's
   `Decision`/`buildAuditRecord` path needs to fire from within lock-protected
   sections so the audit ordering matches the actual mutation ordering.

### Recommended adjudication entry points (single chokepoint per model)

| Model | Proposed entry point | Rationale |
|---|---|---|
| OrderProjection | `OrderCommandService` (all writers) | Already centralized for transitions; consolidate the 3 `packages/tools/src/cart/` writers |
| Payment, PaymentStatusHistory | `PaymentCommandService` | Already centralized; add envelope at method boundary |
| Reservation, TimeSlot, ReservationTable | `ReservationService` | Already centralized; envelope at create/modify/cancel/transition |
| OrderNote | New `OrderNoteService` (TODO) | Currently scattered across 4 sites |
| OrderEventLog | `OrderEventLogService` | Idempotency key + envelope hash |
| Customer | `CustomerService` | Already centralized; LGPD `anonymizeCustomer` is highest priority |
| LoyaltyAccount | `LoyaltyService` | Already centralized |
| Conversation / ConversationMessage | `ConversationService` | Already centralized; envelope at append |
| WeeklySchedule / Holiday / ScheduleOverride / Table / DeliveryZone | their respective services | All admin-only |
| Staff | New `StaffMutationService` | Currently only CLI writes; add envelope when admin UI lands |

### Estimated effort to govern the persistence layer

| Phase | Scope | Effort |
|---|---|---|
| Phase 0 — Inventory & ADRs | Write per-model PolicyBundle scaffolds; map every entry point to an envelope kind; capture mappings here | 2-3 days |
| Phase 1 — Shadow on order/payment services | Wrap `OrderCommandService` and `PaymentCommandService` method calls with envelope + `adjudicateWithShadow` + audit emit | 3-5 days |
| Phase 2 — Consolidate `packages/tools/src/cart/` rogue writers under OrderCommandService | Move `switch-order-type`, `change-delivery-address`, `add-order-note` to use the service | 2-3 days |
| Phase 3 — Shadow on reservation + customer (incl. LGPD) | Same wrap pattern for `ReservationService` and `CustomerService.anonymizeCustomer` | 2-3 days |
| Phase 4 — Subscribers | Envelope on `cart-intelligence`, `payment-lifecycle`, `conversation-archiver` (event-driven keys) | 3-4 days |
| Phase 5 — Background jobs | Envelope on `pix-expiry-checker`, `stale-order-checker`, `no-show-checker` | 2 days |
| Phase 6 — Medusa wrapper | `medusaAdjudicated()` boundary; choose payload taxonomy for HTTP hops | 4-5 days |
| Phase 7 — Admin routes | All 7 admin route files wrapped; staff-role + envelope dual check | 3 days |
| Phase 8 — Seed / CLI guard hardening | Extend `guardDestructive`, add `--prod-confirm` to backfills | 1 day |
| Phase 9 — Enforce flip | Set `IBX_KERNEL_ENFORCE` per-intent class after shadow data stabilizes | 1 day per intent class |

**Total estimate: ~25-30 engineer-days** to bring every Prisma + Medusa
mutation under shadow adjudication, plus a per-intent-class enforce ramp
following the 4-stage rollout in `docs/ops/runbooks/`.

The single highest-leverage change is **Phase 1+2 together**: consolidating
the 3 tool-side OrderProjection writers under `OrderCommandService` and then
adding an envelope at that service's method boundary brings ~25 of the
highest-risk mutation sites under one chokepoint.
