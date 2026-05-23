# 01 — Intent Taxonomy

> Companion to: [`02-capability-model.md`](./02-capability-model.md), [`03-trust-boundary-model.md`](./03-trust-boundary-model.md), [`04-decision-policy.md`](./04-decision-policy.md).
> Sources: investigations [01](../investigation/01-llm-tool-execution.md), [02](../investigation/02-api-webhook-mutations.md), [03](../investigation/03-db-commerce-mutations.md), [04](../investigation/04-background-jobs-nats.md), [05](../investigation/05-adjudicate-capabilities.md), [08](../investigation/08-security-trust-boundaries.md).

## Executive summary

- Every mutation in ibatexas (~150 entry points across LLM tools, HTTP routes, webhooks, NATS subscribers, jobs, command services) maps to **exactly one** `IntentEnvelope.kind` defined in this catalog. Unknown kinds **must** REFUSE by default (see [`04-decision-policy.md`](./04-decision-policy.md) §"Default refuse policy").
- Intent kinds use dotted snake_case with a domain prefix: `{domain}.{aggregate}.{verb}` (e.g. `order.item.add`, `payment.refund.issue`, `whatsapp.message.send`). This mirrors the wire vocabulary in `@adjudicate/pack-payments-pix` (`pix.charge.{create|confirm|refund}` per `/Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/types.ts`).
- Six domains: **order**, **payment**, **reservation**, **customer**, **whatsapp**, **system**. Each domain owns a future first-party Pack (`@ibatexas/pack-{orders,reservations,whatsapp,customer-onboarding}` per investigation 05 §"Packs ibatexas should write").
- Five actor types — `customer`, `staff`, `admin`, `system`, `webhook` — composable as `IntentActor.principal` and `IntentActor.taint` via `createSystemTaintPolicy({systemOnlyKinds})` from `@adjudicate/primitives`. `cron` is modeled as `system` with provenance `cron:{jobName}` in `IntentActor.sessionId`.
- PII flags here drive the `AuditRedactor` contract in [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md). Any intent flagged "PII high" requires schema-driven field masking before any sink emit.

## Naming convention

| Slot | Rule | Example |
|---|---|---|
| Domain | one of `order`, `payment`, `reservation`, `customer`, `whatsapp`, `system` | `order` |
| Aggregate | the noun the verb acts on, snake_case | `item`, `refund`, `address` |
| Verb | imperative or terminal state, snake_case | `add`, `issue`, `cancel` |
| Full kind | `{domain}.{aggregate}.{verb}` | `order.item.add` |

System-actor intents may add a `.system` discriminator when the same logical event also has a user-initiated variant: `order.cancel` (customer-initiated) vs `order.cancel.system` (cron auto-cancel). This mirrors the dual-publisher pattern seen at `apps/api/src/routes/order-actions.ts:228` (customer) vs `apps/api/src/jobs/stale-order-checker.ts:130` (cron).

## Actor types

| Principal | `IntentActor.principal` | `IntentActor.taint` default | `IntentActor.sessionId` shape | Notes |
|---|---|---|---|---|
| Anonymous public | `user` | `UNTRUSTED` | `web:{anonId}` or `wa:{phoneHash}` | No JWT cookie; no Customer row yet. |
| Authenticated customer | `user` | `UNTRUSTED` (default) | `cust:{customerId}` | JWT cookie present; phone-verified via OTP. |
| Staff (ATTENDANT/MANAGER/OWNER) | `user` | `TRUSTED` | `staff:{staffId}` | Twilio OTP staff JWT; role checked at envelope build. |
| Admin (API key) | `user` | `TRUSTED` | `apikey:{keyId}` | `x-admin-key` header path; same authority as staff OWNER. |
| System (cron / BullMQ worker) | `system` | `SYSTEM` | `cron:{jobName}` | Built by job code; provenance = job name. |
| System (NATS subscriber) | `system` | `SYSTEM` | `sub:{subjectName}` | Built by subscriber on event ingest. |
| Webhook (Stripe / Twilio) | `system` | `TRUSTED` | `webhook:{provider}:{eventId}` | Provider signature-verified before envelope build. |
| LLM (proposal only) | `llm` | `UNTRUSTED` | inherited from agent session | LLM never executes; proposes intents only. |

`Taint`, `TaintPolicy`, and `createSystemTaintPolicy` from `@adjudicate/primitives` (per investigation 05 §"primitives") enforce the system-only kind allowlist. The taint gate runs **after** state guards and **before** business guards in `adjudicate()` evaluation order (per `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/kernel/index.ts` — "evaluation order: kill → schema → state → taint → auth → business → default").

## Intent catalog — by domain

Notation:
- **Kind** — exact `IntentEnvelope.kind` string.
- **Actors** — allowed `principal` values (`c` = customer, `s` = staff, `a` = admin, `sys` = system, `wh` = webhook).
- **Payload** — TypeScript-shaped pseudo-type. Fields prefixed `#` are PII-redacted before sink.
- **Mutation surface** — concrete code path (file:line) the intent gates.
- **PII** — none / low / med / high. Drives `AuditRedactor` per [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md).
- **Default unmatched** — always REFUSE. Per master plan §"Governance principles" #4 and `04-decision-policy.md` §"Default refuse policy".

### Domain: `order` — cart + checkout + amendment

| Kind | Actors | Payload | Mutation surface | PII |
|---|---|---|---|---|
| `order.cart.ensure` | c, sys | `{cartId?: string}` | `kernel-executor.ts:282` (`ensureCart()`), `packages/tools/src/cart/get-or-create-cart.ts` | none |
| `order.item.add` | c | `{cartId, variantId, quantity, allergens: string[]}` | `kernel-executor.ts:282` (`addItemToCart`), `packages/tools/src/cart/add-to-cart.ts`, `POST /api/cart/:id/line-items` | none |
| `order.item.update` | c | `{cartId, itemId, quantity}` | `packages/tools/src/cart/update-cart.ts`, `PATCH /api/cart/:id/line-items/:itemId` | none |
| `order.item.remove` | c | `{cartId, itemId}` | `packages/tools/src/cart/remove-from-cart.ts`, `DELETE /api/cart/:id/line-items/:itemId` | none |
| `order.cart.sync` | c | `{cartId, items: LineItem[]}` | `POST /api/cart/:id/sync` | none |
| `order.coupon.apply` | c | `{cartId, code}` | `packages/tools/src/cart/apply-coupon.ts`, `POST /api/cart/:id/promotions` | none |
| `order.checkout.create` | c | `{cartId, paymentMethod, #pixDetails?: {name, email, cpf}}` | `kernel-executor.ts:366` (`processCheckout`), `packages/tools/src/cart/create-checkout.ts`, `POST /api/cart/checkout` | **high** |
| `order.pix.details.set` | c | `{cartId, #name, #email, #cpf}` | `packages/tools/src/cart/set-pix-details.ts` (validation-only; emits state-machine event) — reclassify per investigation 01 gap #2 | **high** |
| `order.cancel` | c, s | `{orderId, reason?}` | `kernel-executor.ts:425` (`cancelOrderAction`), `packages/tools/src/cart/cancel-order.ts`, `POST /api/orders/:id/cancel` | low (orderId) |
| `order.cancel.system` | sys | `{orderId, reason: "stale" \| "pix_expired"}` | `apps/api/src/jobs/stale-order-checker.ts:60-130`, `subscribers/payment-lifecycle.ts` auto-cancel | low |
| `order.cancel.force` | a | `{orderId, reason}` | `POST /api/admin/orders/:id/force-cancel` | low |
| `order.amend.request` | c | `{orderId, changes: AmendChange[]}` | `packages/tools/src/cart/amend-order.ts`, `POST /api/orders/:id/amend/batch` | none |
| `order.address.change` | c | `{orderId, #address}` | `packages/tools/src/cart/change-delivery-address.ts`, `PATCH /api/orders/:id/address` | **med** |
| `order.type.switch` | c | `{orderId, newType: "delivery"\|"takeout"}` | `packages/tools/src/cart/switch-order-type.ts`, `PATCH /api/orders/:id/type` | none |
| `order.note.add` | c, s | `{orderId, body, isInternal?}` | `packages/tools/src/cart/add-order-note.ts`, `POST /api/orders/:id/notes`, `POST /api/admin/orders/:id/notes`, `POST /api/admin/orders/:id/staff-notes` | low |
| `order.status.transition` | s, a, sys | `{orderId, newStatus, expectedVersion}` | `order-command.service.ts:153-203`, `PATCH /api/admin/orders/:id`, `POST /api/admin/orders/:id/advance`, `subscribers/payment-lifecycle.ts:34` | low |
| `order.status.reconcile` | sys | `{orderId, newStatus}` | `order-command.service.ts:244-256`, `subscribers/cart-intelligence.ts:573` | low |
| `order.review.submit` | c | `{orderId, productId, rating, #comment}` | `packages/tools/src/intelligence/submit-review.ts`, `customer.service.ts:76` | low |
| `order.reorder` | c | `{previousOrderId, paymentMethod}` | `packages/tools/src/cart/reorder.ts` | none |

### Domain: `payment` — Stripe + PIX + cash + refund

| Kind | Actors | Payload | Mutation surface | PII |
|---|---|---|---|---|
| `payment.charge.create` | c, sys | `{orderId, amountCentavos, method, currency}` | `payment-command.service.ts:135-180`, `create-checkout.ts` (Stripe PI creation), `subscribers/cart-intelligence.ts:446` (`paymentCmdSvc.create`) | none |
| `payment.charge.confirm` | wh, sys | `{orderId, paymentId, wireStatus, stripeEventId}` | `stripe-webhook.ts` `payment_intent.succeeded`, `payment-command.service.ts:188-260` | none |
| `payment.charge.fail` | wh, sys | `{orderId, paymentId, reason}` | `stripe-webhook.ts` `payment_intent.payment_failed` | none |
| `payment.charge.expire` | sys | `{paymentId, reason: "pix_expired"}` | `jobs/pix-expiry-checker.ts:35-100` | none |
| `payment.charge.cancel` | wh, sys | `{paymentId, reason}` | `stripe-webhook.ts` `payment_intent.canceled` | none |
| `payment.pix.regenerate` | c | `{orderId}` | `kernel-executor.ts:449` (`regeneratePixAction`), `packages/tools/src/cart/regenerate-pix.ts`, `POST /api/orders/:id/payment/regenerate-pix` | none |
| `payment.method.switch` | c | `{orderId, newMethod}` | `packages/tools/src/cart/amend-order.ts:326`, `PATCH /api/orders/:id/payment/method` | none |
| `payment.retry` | c | `{orderId}` | `POST /api/orders/:id/payment/retry` | none |
| `payment.refund.issue` | s, a | `{paymentId, amountCentavos, reason}` | `routes/admin/payments.ts:157` (`prisma.payment.update`) — requires REQUEST_CONFIRMATION above CONFIRM threshold, ESCALATE above ESCALATE threshold per `04-decision-policy.md` §"Escalation policy table" | low |
| `payment.refund.confirm` | wh, sys | `{paymentId, wireStatus, stripeEventId}` | `stripe-webhook.ts` `charge.refunded` | none |
| `payment.dispute.open` | wh | `{paymentId, stripeEventId}` | `stripe-webhook.ts` `charge.dispute.created` — always ESCALATE | none |
| `payment.cash.confirm` | s | `{orderId, paymentId, amountCentavos}` | `POST /api/admin/orders/:id/payment/confirm-cash` | none |
| `payment.waive` | a | `{paymentId, reason}` | `POST /api/admin/orders/:id/waive` — OWNER only; always REQUEST_CONFIRMATION | none |
| `payment.status.force` | a | `{paymentId, newStatus, reason}` | `PATCH /api/admin/orders/:id/payment/status` — OWNER only; always REQUEST_CONFIRMATION; logs ESCALATE on terminal states | none |

### Domain: `reservation` — tables + slots + waitlist

| Kind | Actors | Payload | Mutation surface | PII |
|---|---|---|---|---|
| `reservation.create` | c | `{timeSlotId, partySize, #specialRequests?}` | `reservation.service.ts:270`, `POST /api/reservations` | low |
| `reservation.modify` | c | `{reservationId, newTimeSlotId?, newPartySize?}` | `reservation.service.ts:336-345`, `PATCH /api/reservations/:id` | low |
| `reservation.cancel` | c, s | `{reservationId, reason?}` | `reservation.service.ts:371-376`, `DELETE /api/reservations/:id`, `POST /api/admin/reservations/:id/cancel` | low |
| `reservation.checkin` | s | `{reservationId}` | `POST /api/admin/reservations/:id/checkin` | none |
| `reservation.complete` | s | `{reservationId}` | `POST /api/admin/reservations/:id/complete` | none |
| `reservation.no_show.mark` | sys, s | `{reservationId}` | `apps/api/src/jobs/no-show-checker.ts`, `reservation.service.ts:400-405` | none |
| `reservation.waitlist.join` | c | `{timeSlotId}` | `reservation.service.ts:468`, `POST /api/reservations/:id/waitlist` | none |
| `reservation.waitlist.notify` | sys | `{waitlistId}` | `reservation.service.ts:428` (`promoteWaitlist` job) | none |

### Domain: `customer` — identity + LGPD + loyalty + preferences

| Kind | Actors | Payload | Mutation surface | PII |
|---|---|---|---|---|
| `customer.create` | sys | `{#phone, source: "otp"\|"wa-auto"}` | `customer.service.ts:18` (`upsertFromPhone`), `customer.service.ts:172` (`upsertFromWhatsApp`) | **high** |
| `customer.profile.update` | c | `{#name?, #email?}` | `POST /api/auth/verify-otp` body.name path | **high** |
| `customer.preferences.update` | c | `{allergenExclusions: string[], dietaryFlags?: string[]}` | `customer.service.ts:49`, `packages/tools/src/intelligence/update-preferences.ts` | low (allergen list itself is safety-critical, not PII) |
| `customer.pix.details.save` | c | `{#name, #email, #cpf}` | `customer.service.ts:148` (`updatePixDetails`) | **high** |
| `customer.address.add` | c | `{#address}` | `packages/domain/src/services/customer.service.ts` (address create paths) | **med** |
| `customer.address.remove` | c | `{addressId}` | same | low |
| `customer.anonymize` | c | `{customerId, otpToken, scope: "lgpd_art_18"}` | `customer.service.ts:233-251` (`anonymizeCustomer`), `DELETE /api/me/data?token=...` — **DEFER** with signal `customer.anonymize.confirmed_after_grace` and 24h timeout; fresh-OTP-gated (5min TTL) per investigation 08 P0 #2; pack home `@ibatexas/pack-customer-onboarding` (task 21) | **high** |
| `customer.anonymize.cancel` | c | `{customerId}` | `POST /api/me/data/cancel-deletion` — REFUSEs the parked `customer.anonymize` intent via `rk('anonymize:pending:{customerId}')` receipt check; clears receipt | none |
| `customer.session.issue` | sys | `{customerId, jti, ttlSec}` | `POST /api/auth/verify-otp` JWT issue | none |
| `customer.session.revoke` | c, sys | `{jti}` | `POST /api/auth/logout` | none |
| `customer.session.refresh` | c, sys | `{oldRefreshToken, newRefreshToken}` | `POST /api/auth/refresh` | none |
| `customer.loyalty.stamp.award` | sys | `{customerId, orderId, stampCount: 1}` | `loyalty.service.ts:25,32`, `subscribers/cart-intelligence.ts:244` order.placed handler | none |
| `customer.loyalty.redeem` | c | `{customerId, productSku}` | `loyalty.service.ts:12` redemption path | none |
| `customer.welcome_credit.grant` | sys | `{customerId, amountCentavos: 1500}` | `apps/api/src/whatsapp/session.ts` `setWelcomeCredit` (R$15 promo) | none |

### Domain: `whatsapp` — outbound channel intents

All outbound WhatsApp must produce an intent envelope. The `notification.send` subscriber (per investigation 04 P0 #6) accepts free-form `body` today — the migration replaces this with a `templateName + variables` contract gated by these intents.

| Kind | Actors | Payload | Mutation surface | PII |
|---|---|---|---|---|
| `whatsapp.message.send` | sys, s | `{toPhoneHash, templateName, variables: Record<string,string>}` | `subscribers/cart-intelligence.ts:665` (`notification.send` handler), every direct `sender.sendText` site in jobs + subscribers | low (phone-hash, not raw phone) |
| `whatsapp.template.send` | sys | `{toPhoneHash, templateId, params: string[]}` | structured template path; future migration target | low |
| `whatsapp.handoff.request` | c | `{customerId, sessionId, #reason}` | `packages/tools/src/support/handoff-to-human.ts`, `subscribers/handoff-subscriber.ts` — REQUEST_CONFIRMATION + per-customer rate limit per investigation 08 P1 #4 | low (reason is user text → high after audit redaction of free-form fields) |
| `whatsapp.followup.schedule` | c, sys | `{customerId, reason, deliverAt}` | `packages/tools/src/intelligence/schedule-follow-up.ts`, BullMQ delayed job | none |
| `whatsapp.outreach.send` | sys | `{toPhoneHash, campaign, templateName}` | `apps/api/src/jobs/proactive-engagement.ts` — most autonomous worker; needs explicit kernel gate | low |
| `whatsapp.session.handover` | sys | `{sessionId, fromActor, toActor}` | not yet implemented; reserves intent for future staff-bridge | none |

### Domain: `system` — operator + kernel + cron control

| Kind | Actors | Payload | Mutation surface | PII |
|---|---|---|---|---|
| `system.kernel.kill_switch.toggle` | a | `{active: bool, reason}` | `setKillSwitch(active, reason)` from `@adjudicate/core/kernel` — admin endpoint to add per `06-runtime-config-governance.md` P0-7 | none |
| `system.kernel.shadow.add` | a | `{intentKind}` | mutate `IBX_KERNEL_SHADOW` allowlist (operational, not via env var directly) | none |
| `system.kernel.enforce.add` | a | `{intentKind}` | mutate `IBX_KERNEL_ENFORCE` allowlist | none |
| `system.kernel.pack.register` | a | `{packId, version}` | `installPack(pack, ...)` from `@adjudicate/core` boot path | none |
| `system.replay.run` | a | `{since, until, intentKind?}` | future `ibx kernel replay` CLI (per `07-testing-observability.md` P1 #10) | none |
| `system.backfill.execute` | a | `{job, dryRun: bool}` | `packages/cli/src/commands/db.ts:550, 679` (`db backfill:projections`, `db backfill:payments`) | none |

## Intent kind union (knownIntents)

The `validateEnforceConfig(knownIntents, env)` call from `@adjudicate/core/kernel` (per investigation 06 §"Plumbing gaps" P0-3) requires a single `ReadonlySet<string>` of every kind in this catalog. Generated at boot from a `KNOWN_INTENT_KINDS` constant exported from `@ibatexas/llm-provider/intent-kinds.ts` (new file).

```ts
// @ibatexas/llm-provider/intent-kinds.ts
export const KNOWN_INTENT_KINDS = new Set<string>([
  // order
  "order.cart.ensure", "order.item.add", "order.item.update", "order.item.remove",
  "order.cart.sync", "order.coupon.apply", "order.checkout.create",
  "order.pix.details.set", "order.cancel", "order.cancel.system",
  "order.cancel.force", "order.amend.request", "order.address.change",
  "order.type.switch", "order.note.add", "order.status.transition",
  "order.status.reconcile", "order.review.submit", "order.reorder",
  // payment
  "payment.charge.create", "payment.charge.confirm", "payment.charge.fail",
  "payment.charge.expire", "payment.charge.cancel", "payment.pix.regenerate",
  "payment.method.switch", "payment.retry", "payment.refund.issue",
  "payment.refund.confirm", "payment.dispute.open", "payment.cash.confirm",
  "payment.waive", "payment.status.force",
  // reservation
  "reservation.create", "reservation.modify", "reservation.cancel",
  "reservation.checkin", "reservation.complete", "reservation.no_show.mark",
  "reservation.waitlist.join", "reservation.waitlist.notify",
  // customer
  "customer.create", "customer.profile.update", "customer.preferences.update",
  "customer.pix.details.save", "customer.address.add", "customer.address.remove",
  "customer.anonymize", "customer.anonymize.cancel",
  "customer.session.issue", "customer.session.revoke",
  "customer.session.refresh", "customer.loyalty.stamp.award",
  "customer.loyalty.redeem", "customer.welcome_credit.grant",
  // whatsapp
  "whatsapp.message.send", "whatsapp.template.send", "whatsapp.handoff.request",
  "whatsapp.followup.schedule", "whatsapp.outreach.send",
  "whatsapp.session.handover",
  // system
  "system.kernel.kill_switch.toggle", "system.kernel.shadow.add",
  "system.kernel.enforce.add", "system.kernel.pack.register",
  "system.replay.run", "system.backfill.execute",
] as const);
```

Total: **64 intent kinds** (adds `customer.anonymize.cancel` for the LGPD grace-period cancel flow per task 14). Per investigation 02 §"Totals", the mutation entrypoint count is ~150; the kind count is smaller because multiple entry points (LLM tool + HTTP route + subscriber for the same logical action) share one envelope kind.

## Default refuse policy

For each `PolicyBundle<K, P, S>`, the `default` slot **must** evaluate to `REFUSE` for unknown kinds. This is non-negotiable per master plan §"Governance principles" #4. Bundles compose:

```ts
{
  stateGuards: [...],
  authGuards: [...],
  taint: createSystemTaintPolicy({
    systemOnlyKinds: SYSTEM_ONLY_KINDS,
    userMinimum: "UNTRUSTED",
    systemMinimum: "SYSTEM",
  }),
  business: [...],
  default: constant(decisionRefuse(
    refuse("policy", "default_deny", "Essa ação não é permitida neste momento."),
    [basis("kernel", "default_deny" as any)]
  )),
}
```

`SYSTEM_ONLY_KINDS` = the subset of `KNOWN_INTENT_KINDS` where actors column contains only `sys` and/or `wh`:

```ts
const SYSTEM_ONLY_KINDS = new Set<string>([
  "order.cancel.system", "order.status.reconcile",
  "payment.charge.confirm", "payment.charge.fail", "payment.charge.expire",
  "payment.charge.cancel", "payment.refund.confirm", "payment.dispute.open",
  "reservation.no_show.mark", "reservation.waitlist.notify",
  "customer.create", "customer.session.issue", "customer.loyalty.stamp.award",
  "customer.welcome_credit.grant",
  "whatsapp.message.send", "whatsapp.template.send", "whatsapp.followup.schedule",
  "whatsapp.outreach.send", "whatsapp.session.handover",
]);
```

Customer-facing kinds like `order.cancel` accept both `c` (UNTRUSTED) and `s` (TRUSTED) actors; taint guard accepts either; auth guard refines per-role.

## PII categorization

Drives `AuditRedactor` per [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md). Field-level masking before any sink emit.

| PII level | Examples | Audit behavior |
|---|---|---|
| **high** | `cpf`, raw `email`, raw `phone`, `pixDetails`, `name` in standalone contexts | Replace with `"REDACTED:{sha256-prefix-8}"` in `envelope.payload`. Original value never leaves the kernel boundary into any sink. |
| **med** | `address` (street + complement), `geoCoordinates` | Replace street/complement with `"REDACTED"`; keep neighborhood + city + CEP-prefix for analytics. |
| **low** | `customerId`, `orderId`, `phoneHash`, free-form `reason` / `comment` strings | Keep IDs; truncate free-form to 64 chars; strip newlines/markdown. |
| **none** | `cartId`, `quantity`, `amountCentavos`, status enums, `intentHash` | Pass through unchanged. |

Investigation 08 P0 #1 identified that today every `set_pix_details` envelope publishes plaintext CPF to `ibatexas.audit.intent.decision.v1`. The redactor must run **before** `getAuditSink().emit(record)` is called at `llm-responder.ts:335-354`.

## Composed intents and multi-step plans

Some user-perceived actions are composed plans of multiple intents adjudicated independently. See [`02-capability-model.md`](./02-capability-model.md) §"Multi-step plans" for sequencing.

| User action | Plan steps | Per-step intent kinds |
|---|---|---|
| "Adicionar item e finalizar" | add → checkout | `order.item.add` → `order.checkout.create` |
| "Cancelar e pedir reembolso" | cancel → refund | `order.cancel` → `payment.refund.issue` |
| "Trocar para PIX e gerar QR" | switch + regen | `payment.method.switch` → `payment.pix.regenerate` |
| "Confirmar cash no balcão" | cash confirm → status transition | `payment.cash.confirm` → `order.status.transition` (to `CONFIRMED`) |
| LGPD: "Apagar minha conta" | confirm + anonymize | `customer.session.issue` (fresh OTP) → `customer.anonymize` |

Each step is its own envelope, its own kernel call, its own audit record, its own ledger entry. The plan-fingerprint links them via `AuditRecord.supersedes` for cross-step replay (see [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Supersession chains").

## Open extension points

Kinds reserved for future first-party Packs but not yet covered:

- `kyc.start`, `kyc.document.upload`, `kyc.vendor.callback` — when ibatexas adopts `@adjudicate/pack-identity-kyc` (per investigation 05 Tier 2).
- `deployment.approval.request`, `deployment.approval.resolve`, `deployment.rollback.execute` — when adopting `@adjudicate/pack-deployments-approval` for operator destructive actions (per `04-decision-policy.md` §"Confirmation policy table").

These are placeholder names from `@adjudicate/pack-{identity-kyc,deployments-approval}` and need no taxonomy invention.

## Cross-references

- Trust crossings per kind: [`03-trust-boundary-model.md`](./03-trust-boundary-model.md) §"Boundary inventory".
- Decision outcomes per kind: [`04-decision-policy.md`](./04-decision-policy.md) §"Decision-kind selection per intent".
- Audit redactor schema per kind: [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Redaction contract".
- Defer eligibility per kind: [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md) §"DEFER-eligible intent kinds".
- Kill switch granularity per kind: [`07-rollback-recovery.md`](./07-rollback-recovery.md) §"Per-intent kill switch model".
