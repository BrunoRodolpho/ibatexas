# Audit pipeline PII + integrity audit — 2026-05-24

Adversarial audit of `adjudicate → buildAuditRecord → getAuditSink().emit → AuditRedactor → persistentBufferedSink → multiSink (console+NATS+Postgres)` at branch `feat/kernel-always-on-cutover` @ c5c839c. Six concrete bugs in the audit pipeline, ranked by severity.

## TL;DR

- **P0 PII leak** — Twilio / Stripe / Medusa-Store wrappers in `packages/tools/` and `apps/api/src/whatsapp/client.ts` build envelopes carrying customer name + email + CPF + phone but DO NOT pass `auditSink` to the wrapper meta — every wrapper invocation silently skips audit emit. The redactor never runs because no record reaches a sink. Stripe PI confirm with PIX `billing_details` { name, email, tax_id } is the worst offender (`packages/tools/src/cart/create-checkout.ts:68`). The wrappers' "fail-open" comment masks a 17-site coverage gap.
- **P1 audit integrity** — `apps/api/src/subscribers/anonymize-grace-resolver.ts:113-126` performs the destructive `anonymizeCustomer(customerId)` LGPD anonymization with NO audit record emitted. The header comment claims the record "carries `supersedes: [parked.intentHash]`" but no `buildAuditRecord` / `getAuditSink().emit()` call exists in the file.
- **P1 audit integrity** — `apps/api/src/subscribers/defer-resolver.ts:589-593` builds the resume-time audit record without the `supersedes` field. The chain link back to the parked envelope is missing on every PIX-deferred-resume + LGPD-grace-resume.
- **P1 integrity** — Every successful adjudication writes the same audit row to Postgres TWICE (in-process Postgres sink + audit-consumer subscriber). The in-process sink writes the row; it then publishes to NATS; the audit-consumer SETNXs a Redis dedup key (different key from the in-process path) → INSERT proceeds → no schema-level `(intent_hash, recorded_at)` unique constraint exists (P0-14 confirms `ON CONFLICT DO NOTHING` is a no-op) → second row lands with a fresh BIGSERIAL `id`.
- **P0 PII leak** — `INTENT_KIND_FIELD_RULES` in `packages/llm-provider/src/audit-redactor.ts:348-358` uses the key `"whatsapp.handoff.request"` but the actual emitted kind is `"whatsapp.session.handover"` (`packages/pack-whatsapp/src/types.ts:140`). The misspelled rule never fires. The `body`/`text`/`variables` redactor key for `whatsapp.message.send` also misses `templateVariables` (the real payload field name), so positional WhatsApp template values can ship unredacted to NATS+Postgres.
- **P0 PII leak** — Multiple free-form `reason`/`comment`/`body`/`specialRequests` fields across pack-payments, pack-orders, and pack-reservations are NOT in `INTENT_KIND_FIELD_RULES` and NOT name-matched by `REDACT_FIELDS`/`HASH_FIELDS`. Only the regex defense fires — CPF/email/phone/card patterns are caught, customer NAMES and address mentions are NOT. The walker length-caps at 500 chars but doesn't scrub free-form prose.

Top 3 by blast radius: Bug 1 (missing auditSink at 17 wrapper sites) > Bug 5 (redactor rule key typo + templateVariables miss) > Bug 4 (audit row duplication).

## Bug 1 — Wrapper egress emits zero audit records (auditSink never wired through callers)

**Severity:** P0 (PII leak via correctness gap — every PIX confirm with name/email/tax_id is invisible to the audit trail and is therefore also unguarded against future redactor regression, since the redactor is bypassed entirely)
**File:** `packages/tools/src/twilio/adjudicated.ts:433`, `packages/tools/src/stripe/adjudicated.ts:393`, `packages/tools/src/medusa/store-adjudicated.ts:640`, plus 17 call sites
**Class:** Sink failure / Coverage gap / PII leak (via absence of redaction)
**Path:**

1. Caller invokes `stripeAdjudicated.paymentIntents.confirm(piId, { payment_method_data: { billing_details: { name, email, tax_id } } }, { sourceSubject: "tool:create-checkout:...:..." })` — no `auditSink` field in meta.
2. Wrapper runs `adjudicate(envelope, wrapperState, stripeWrapperPolicyBundle)` → Decision EXECUTE.
3. `runKernelAndAudit` gates on `if (args.auditSink) { ... }` — `args.auditSink` is `undefined` → audit block is SKIPPED.
4. SDK dispatch fires → Stripe receives the PIX PII → adjudication never produced a NATS/Postgres audit row.

Concrete sites (no `auditSink` passed):

| Wrapper | File:line | PII in payload |
|---|---|---|
| twilio | `apps/api/src/whatsapp/client.ts:145` | `to` = customer E.164 phone, `body` = WhatsApp prose (may name customer) |
| twilio | `apps/api/src/whatsapp/client.ts:222` | same + `mediaUrl` |
| stripe | `packages/tools/src/cart/create-checkout.ts:68` | `payment_method_data.billing_details.{name,email,tax_id}` — CPF in plaintext |
| stripe | `packages/tools/src/cart/create-checkout.ts:119` | `metadata.cartId` |
| stripe | `packages/tools/src/cart/amend-order.ts:68,525` | `metadata.medusaOrderId / orderId` |
| stripe | `packages/tools/src/cart/regenerate-pix.ts:135` | `metadata.orderId` |
| stripe | `packages/tools/src/cart/_stripe-helpers.ts:32` | PI id only |
| medusa-store | `packages/tools/src/cart/get-or-create-cart.ts:137`, `update-cart.ts:14`, `add-to-cart.ts:54`, `remove-from-cart.ts:14`, `apply-coupon.ts:14`, `create-checkout.ts:{195,235,261,307,349}` | `cartId`, `customerId` via meta, plus the cart `email`/`metadata` body for `carts.update` (line 235) |

`packages/tools/src/cart/_shared.ts:18-26` documents the omission as intentional: "Audit sink is intentionally omitted because `@ibatexas/tools` cannot depend on `@ibatexas/llm-provider` (which owns `getAuditSink`) without creating a cycle". The "fail-open" claim is technically true (the kernel still adjudicates) but operationally it means: of every PIX checkout, refund, cart mutation, and outbound WhatsApp message, the `medusa.store.*` / `stripe.*` / `twilio.*` egress decisions never enter the durable audit trail. There is no row in Postgres `intent_audit` with `kind = 'stripe.payment_intent.confirm'`.

Operator impact:
- CLAUDE.md rule #9 ("Every decision is audited") is violated.
- The redactor cannot redact what it never sees — but per-kind redaction rules for `stripe.*` / `twilio.*` / `medusa.store.*` would also need to land if/when the auditSink is wired through (see Bug 5).
- Coverage gap is invisible to `recordSinkFailure` (no record → no failure event).

**Suggested fix:** Either (a) move `getAuditSink` to a leaf package that `@ibatexas/tools` can import without a cycle, OR (b) require callers to pass `getAuditSink()` and add a `default-deny` posture in the wrapper that REFUSEs the egress when `auditSink` is null in production (NODE_ENV=production). Option (a) is the durable fix; the current "intentional omission" comment makes the gap silent.

## Bug 2 — LGPD anonymize-grace-resolver runs destructive `anonymizeCustomer` without emitting an audit record

**Severity:** P1 (integrity — LGPD Art. 18 destructive action is silent in audit)
**File:** `apps/api/src/subscribers/anonymize-grace-resolver.ts:111-133`
**Class:** Integrity / Supersession
**Path:**

1. Customer requests LGPD anonymize → `me.ts` builds envelope → kernel DEFERs for 24h.
2. `defer-timeout-sweeper` publishes `intent.defer.timeout` after the TTL.
3. `anonymize-grace-resolver.ts:handleAnonymizeGraceTimeout` consumes the event.
4. Line 114: `await anonymizeCustomer(customerId)` — irreversibly anonymizes the Prisma row.
5. Lines 115-118: only a `log?.info(...)` is emitted — no `buildAuditRecord` / no `getAuditSink().emit(...)` anywhere in the file (`grep -n "buildAuditRecord\|emit" anonymize-grace-resolver.ts` returns zero results).

The comment at lines 108-112 explicitly says "The audit record carries `supersedes: [parked.intentHash]` for the log bridge". This is aspirational documentation — the code does not produce the record. Replaying `ibx kernel replay --kind=customer.anonymize` would miss every successfully-anonymized customer.

**Suggested fix:** After line 114's `anonymizeCustomer(customerId)`, build a `customer.anonymize.confirmed_after_grace` audit record with `supersedes: { predecessorIntentHash: event.intentHash, predecessorAt: receipt.parkedAt, reason: "defer_resumed" }` and emit via `getAuditSink()`.

## Bug 3 — defer-resolver emits audit record without `supersedes` linkage

**Severity:** P1 (integrity — supersession chain breaks on every PIX-confirm resume)
**File:** `apps/api/src/subscribers/defer-resolver.ts:589-593`
**Class:** Supersession
**Path:**

The file's comment block lines 20-21 describes the contract: "An audit record is emitted with `supersedes` linking the resume back to the original park." The actual call:

```ts
const record = buildAuditRecord({
  envelope,
  decision,
  durationMs: Date.now() - startedAt,
})
```

`supersedes` is absent. `buildAuditRecord` accepts it as an optional `BuildAuditInput.supersedes` (see `@adjudicate/core/dist/audit.d.ts:118-132`); when omitted, the resulting `AuditRecord.supersedes` is undefined and the Postgres `supersedes_jsonb` column stores NULL (see `packages/llm-provider/src/postgres-audit-writer.ts:88,141`).

`order-policy-bundle` PIX-deferred-then-resumed envelopes therefore have no audit-row pointer back to the original DEFER record. `ibx kernel replay` walking the supersession chain hits a dead end. The W6 supersession-chain audit and the durability redundancy via the audit-consumer both inherit the gap (the consumer just stores whatever NATS payload arrives — no synthesis).

**Suggested fix:** Pass `supersedes: { predecessorIntentHash: intentHash /* original park */, predecessorAt: parkedEnvelope.parkedAt, reason: "defer_resumed", token: signal }` into `buildAuditRecord(...)`.

## Bug 4 — Every audit record persists twice in `intent_audit` (in-process sink + NATS audit-consumer; no schema-level dedup)

**Severity:** P1 (integrity — observable as 2× row count, broken aggregates)
**File:** `packages/llm-provider/src/intent-audit-wiring.ts:301-377` (in-process sink composes Postgres alongside NATS) + `apps/api/src/subscribers/audit-consumer.ts:90-163` (NATS consumer also writes Postgres) + `packages/llm-provider/src/postgres-audit-writer.ts:94` (`ON CONFLICT DO NOTHING` is a no-op)
**Class:** Dedup race
**Path:**

1. `adjudicate()` → `getAuditSink().emit(record)` (intent-audit-wiring.ts:472).
2. `buffered.emit(redacted)` invokes the multiSink: `console`, `nats`, `postgresSinkWithReset`.
3. **First Postgres INSERT** lands via the in-process sink — `id = N` (BIGSERIAL).
4. The NATS publish step (`createNatsSink` → `publishNatsEvent("audit.intent.decision.v1", payload)`) ships the same payload.
5. `audit-consumer.ts` receives the NATS message; Redis SETNX is keyed `nats:processed:audit.intent.decision.v1:<intentHash>:<at>` — never used by the in-process path, so it returns NEW.
6. Consumer calls `sink.emit(record)` → **Second Postgres INSERT** — `id = N+k`. `ON CONFLICT DO NOTHING` (no column list) requires an existing unique constraint; the schema has only `PRIMARY KEY (id, recorded_at)`. The duplicate sails through.

`packages/llm-provider/src/postgres-audit-writer.ts:42-52` documents the no-op: "Layer-2 dedup at the Postgres level is currently a no-op; the assumption that it caught duplicates was wishful." The W6 audit recognized this as P0-14 and left it as a follow-up against `@adjudicate/audit-postgres`. With A1 (env guard removed), the audit-consumer is now ALWAYS-ON — so the doubling now fires on every decision in every environment, not only when the operator opted into the consumer.

Operator impact:
- Every COUNT(*) / aggregate of `intent_audit` reports 2× the real volume.
- Per-customer audit timelines show duplicated rows at the same timestamp.
- Replay tools that deduplicate on `(intent_hash, recorded_at)` see two ledger paths.
- Storage growth is 2× the planned monthly partition footprint.

**Suggested fix (preferred):** Add a unique constraint upstream — `UNIQUE (intent_hash, recorded_at)` on `intent_audit` so the existing `ON CONFLICT DO NOTHING` engages. Until that ships, change `audit-consumer.ts` to skip the INSERT when the in-process sink succeeded (e.g., observe a per-record "already persisted" marker on a separate Redis key written by the in-process Postgres sink on successful insert). The cheaper interim is to make the in-process sink itself SETNX the dedup key (`nats:processed:audit.intent.decision.v1:<intentHash>:<at>`) on successful write so the consumer's SETNX returns "already" for in-process-handled records.

## Bug 5 — Redactor rule keys mismatch the actual emitted intent kinds + payload field names

**Severity:** P0 (PII leak via stale schema map)
**File:** `packages/llm-provider/src/audit-redactor.ts:348-358`
**Class:** PII leak (per-intent-kind redactor)
**Path:**

```ts
const INTENT_KIND_FIELD_RULES: Record<string, ReadonlyArray<string>> = {
  "whatsapp.message.send": ["body", "text", "variables"],
  "whatsapp.template.send": ["variables"],
  "whatsapp.handoff.request": ["reason", "lastMessage"],
  "validation.text.rewrite": ["originalText", "rewritten"],
  "validation.text.refuse": ["originalText", "rewritten"],
}
```

Two concrete misalignments with the live Pack surface:

1. **Wrong kind**: `"whatsapp.handoff.request"` doesn't exist. The pack-whatsapp `WhatsAppIntentKind` (intent-kinds.ts:102-107) lists `"whatsapp.session.handover"`. The rule key never matches an emitted envelope. The `WhatsAppSessionHandoverPayload` (pack-whatsapp/src/types.ts:140) carries `sessionId`, `fromActor`, `toActor`, `customerPhoneHash` — currently no `reason`/`lastMessage` fields, so the gap is dormant in practice; but the rule entry suggests a stale payload schema and indicates a coverage-test that did not catch the rename.

2. **Wrong field name**: `WhatsAppMessageSendPayload.templateVariables` and `WhatsAppTemplateSendPayload.templateVariables` (pack-whatsapp/src/types.ts:120, 131) — the actual field is `templateVariables`, the rule says `"variables"`. `pathMatchesKindRule` (audit-redactor.ts:792-809) checks exact path equality, ancestor rules with `.split(".")`, and trailing `[N]` strip. None of these match `templateVariables` against rule `variables` (string prefix doesn't count). Positional Meta WhatsApp template variables typically have child keys `"1"`, `"2"`, `"3"` — keys that do NOT match `REDACT_FIELDS`/`HASH_FIELDS`. The values are arbitrary strings inserted at template-render time and routinely include customer name / order number / address. Names ESCAPE the regex defense (no anchored shape).

Operator impact: Outbound WhatsApp template sends ship every positional template variable to NATS subject `ibatexas.audit.intent.decision.v1` and to Postgres `intent_audit.envelope_jsonb` unredacted.

**Suggested fix:**

```ts
"whatsapp.message.send": ["body", "text", "variables", "templateVariables"],
"whatsapp.template.send": ["variables", "templateVariables"],
"whatsapp.session.handover": [],  // delete or migrate rule
"conversation.message.append": ["body"],  // see Bug 6 — body is the message text
```

Plus: add a contract test that walks every `KNOWN_INTENT_KINDS` entry and asserts that any free-form text field (`body`, `reason`, `comment`, `note`, `specialRequests`, `text`, `description`) is covered by EITHER `INTENT_KIND_FIELD_RULES` or `REDACT_FIELDS`. The W6 test asserted bypass-detection but did not validate per-kind redactor map currency against the Pack surface.

## Bug 6 — Free-form text fields (`reason`, `comment`, `body`, `note`, `specialRequests`) escape per-intent-kind redactor coverage

**Severity:** P0 (PII leak — customer NAME mentions in prose ship to NATS + Postgres)
**File:** Multiple Pack payloads, missing from `audit-redactor.ts:INTENT_KIND_FIELD_RULES`
**Class:** PII leak
**Path:**

The redactor's three lines of defense are: (1) `REDACT_FIELDS` name match (exact key), (2) `HASH_FIELDS` name match, (3) regex defense (CPF, email, phone, card). All three FAIL on free-form prose: a customer-typed `comment: "Loved the dish, Maria Silva here"` has:
- key `comment` not in REDACT/HASH;
- value content `"...Maria Silva..."` has no CPF/email/phone shape, only a name.

The walker length-caps at 500 chars, but everything within the cap streams through as-is.

Affected payloads (NOT covered by `INTENT_KIND_FIELD_RULES`):

| Intent kind | File:line | Free-form field |
|---|---|---|
| `order.cancel` | `packages/pack-orders/src/types.ts:146` | `reason?: string` |
| `order.note.add` | `packages/pack-orders/src/types.ts:164-167` | `body: string` |
| `order.review.submit` | `packages/pack-orders/src/types.ts:211-216` | `comment?: string` |
| `order.status.transition` | `packages/pack-orders/src/types.ts:230-237` | `reason?: string` |
| `reservation.create` | `packages/pack-reservations/src/types.ts:67-71` | `specialRequests?: ReadonlyArray<string>` |
| `reservation.modify` | `packages/pack-reservations/src/types.ts:73-78` | `specialRequests?: ReadonlyArray<string>` |
| `reservation.cancel` | `packages/pack-reservations/src/types.ts:80-83` | `reason?: string` |
| `payment.charge.fail` | `packages/pack-payments/src/types.ts:134-138` | `reason: string` |
| `payment.charge.cancel` | `packages/pack-payments/src/types.ts:145-148` | `reason: string` |
| `payment.refund.issue` | `packages/pack-payments/src/types.ts:184-197` | `reason?: string` |
| `payment.waive` | `packages/pack-payments/src/types.ts:219-223` | `reason: string` |
| `payment.status.force` | `packages/pack-payments/src/types.ts:225-230` | `reason: string` |
| `payment.status.transition` | `packages/pack-payments/src/types.ts:232-238` | `reason?: string` |
| `conversation.message.append` | `packages/pack-whatsapp/src/types.ts:159-166` | `body: string` (literal customer message text) |

`conversation.message.append.body` is the most acute: customer WhatsApp messages get persisted as audit envelope payload. The literal customer message ("Quero falar com Maria Silva, ela é minha esposa, telefone 11999999999") flows in. Phone gets regex-scrubbed; name does not.

**Suggested fix:** Extend `INTENT_KIND_FIELD_RULES` to cover every free-form field above. For `conversation.message.append`, redact `body` outright (the message Sid + direction are sufficient for audit replay).

```ts
"order.cancel": ["reason"],
"order.note.add": ["body"],
"order.review.submit": ["comment"],
"order.status.transition": ["reason"],
"reservation.create": ["specialRequests"],
"reservation.modify": ["specialRequests"],
"reservation.cancel": ["reason"],
"payment.charge.fail": ["reason"],
"payment.charge.cancel": ["reason"],
"payment.refund.issue": ["reason"],
"payment.waive": ["reason"],
"payment.status.force": ["reason"],
"payment.status.transition": ["reason"],
"conversation.message.append": ["body"],
```

## Per-intent-kind redactor coverage table

Legend: ✅ rule fires; ❌ no rule + payload contains free-form / PII-bearing field; ➖ rule fires but no PII-bearing fields in current payload.

| Intent kind | Schema in redactor? | PII fields it should redact | Verdict |
|---|---|---|---|
| `customer.create` | ❌ (none) | `phoneHash` is already hashed; `source` is enum | ➖ safe (no PII) |
| `customer.profile.update` | ❌ (none) | `name` (HASH), `email` (REDACT) — both caught by name match | ✅ |
| `customer.preferences.update` | ❌ | `allergenExclusions`, `dietaryFlags`, `favoriteCategories` — category handles, not PII | ➖ safe |
| `customer.pix.details.save` | ❌ | `name` (HASH), `email` (REDACT), `cpf` (REDACT) | ✅ via name match |
| `customer.address.add` | ❌ | `address: {street, number, complement, neighborhood, city, state, zip}` — outer `address` key matches HASH_FIELDS → entire object JSON-hashed | ✅ |
| `customer.address.remove` | ❌ | `addressId` — opaque | ➖ safe |
| `customer.anonymize` | ❌ | `customerId` (HASH), `otpToken`, `scope` enum | ✅ |
| `customer.anonymize.cancel` | ❌ | `customerId` (HASH) | ✅ |
| `order.cart.ensure`, `.item.*`, `.cart.sync` | ❌ | `cartId`, `variantId`, `itemId`, `allergens` (handles), `quantity` | ➖ safe |
| `order.coupon.apply` | ❌ | `code` — coupon code, low sensitivity | ➖ |
| `order.checkout.create` | ❌ | `pixDetails: {name, email, cpf}` — name match catches all three; outer key `pixDetails` doesn't match HASH but inner keys do | ✅ |
| `order.pix.details.set` | ❌ | `name`, `email`, `cpf` at top level — name match catches | ✅ |
| `order.cancel` | ❌ | **`reason?: string` free-form** | ❌ Bug 6 |
| `order.cancel.system` | ❌ | `reason` is enum | ➖ |
| `order.amend.*` | ❌ | itemIds, quantities | ➖ |
| `order.address.change` | ❌ | `address: {street, ...}` — outer `address` HASH-matches → entire object hashed | ✅ |
| `order.type.switch` | ❌ | `newType` enum | ➖ |
| `order.note.add` | ❌ | **`body: string` free-form** | ❌ Bug 6 |
| `order.review.submit` | ❌ | **`comment?: string` free-form** | ❌ Bug 6 |
| `order.reorder` | ❌ | `previousOrderId`, `paymentMethod` enum | ➖ |
| `order.projection.create` | ❌ | `customerId` (HASH), `totalCentavos` | ✅ |
| `order.status.transition` | ❌ | **`reason?: string` free-form** | ❌ Bug 6 |
| `order.status.reconcile` | ❌ | `source` enum | ➖ |
| `reservation.create` | ❌ | **`specialRequests?: ReadonlyArray<string>` free-form** | ❌ Bug 6 |
| `reservation.modify` | ❌ | **`specialRequests?` free-form** | ❌ Bug 6 |
| `reservation.cancel` | ❌ | **`reason?: string` free-form** | ❌ Bug 6 |
| `reservation.checkin/.complete/.no_show.mark/.waitlist.*` | ❌ | reservationId, timeSlotId, partySize | ➖ |
| `whatsapp.message.send` | ✅ partial | `body`, `text`, `variables` covered; **`templateVariables` MISSED** (Bug 5) | ❌ |
| `whatsapp.template.send` | ✅ partial | `templateName`, **`templateVariables` MISSED** (Bug 5) | ❌ |
| `whatsapp.session.handover` | **mis-keyed** as `whatsapp.handoff.request` (Bug 5) | `customerPhoneHash` already hashed | ➖ in practice, but stale rule |
| `conversation.message.append` | ❌ | **`body: string` literal customer message text** | ❌ Bug 6 (severe — verbatim PII surface) |
| `pix.charge.create/.confirm/.refund` (from `@adjudicate/pack-payments-pix`) | ❌ | payload shape opaque from outside; depends on platform repo | ⚠️ untested |
| `payment.create / .charge.create` | ❌ | `orderId`, `amountInCentavos`, `paymentMethod` | ➖ |
| `payment.charge.confirm` | ❌ | `wireStatus`, `stripeEventId` | ➖ |
| `payment.charge.fail` | ❌ | **`reason: string` free-form (often Stripe failure message — may contain PII)** | ❌ Bug 6 |
| `payment.charge.expire` | ❌ | `reason: "pix_expired"` enum | ➖ |
| `payment.charge.cancel` | ❌ | **`reason: string` free-form** | ❌ Bug 6 |
| `payment.pix.regenerate` | ❌ | `orderId`, `paymentId`, count | ➖ |
| `payment.method.switch` | ❌ | `customerId` (HASH), `fromMethod`/`toMethod` enum | ✅ |
| `payment.retry` | ❌ | `orderId`, `previousPaymentId`, `newMethod` enum | ➖ |
| `payment.refund.issue` | ❌ | **`reason?: string` free-form + amounts** | ❌ Bug 6 |
| `payment.refund.confirm` | ❌ | `wireStatus`, `stripeEventId` | ➖ |
| `payment.dispute.open` | ❌ | `stripeEventId`, dispute amount | ➖ |
| `payment.cash.confirm` | ❌ | `orderId`, `staffId`, amount | ➖ |
| `payment.waive` | ❌ | **`reason: string` + `adminId`** | ❌ Bug 6 |
| `payment.status.force` | ❌ | **`reason: string` + `adminId`** | ❌ Bug 6 |
| `payment.status.transition` | ❌ | **`reason?: string` free-form** | ❌ Bug 6 |
| `payment.status.reconcile` | ❌ | `stripeEventId`, `stripeEventTimestamp` | ➖ |
| `twilio.message.send` (wrapper-local; EXCLUDED from `KNOWN_INTENT_KINDS` per D10) | ❌ | `from`, `to` (phone), `body`, `mediaUrl` — regex catches phone; body is free-form | ⚠️ but Bug 1: never emitted because no auditSink |
| `stripe.payment_intent.create/.confirm/.update/.cancel` | ❌ | `payment_method_data.billing_details.{name,email,tax_id,phone,address}`; `receipt_email`, `customer_email` (snake_case Stripe fields) | ⚠️ but Bug 1: never emitted |
| `stripe.refund.create / .customer.create / .checkout_session.create` | ❌ | `email`, `name`, `phone`, `billing_details.*` | ⚠️ Bug 1 |
| `medusa.store.cart.create / .line_item.* / .email.update / .promotion.add / .complete` | ❌ | `body` may carry `email` for cart.email.update | ⚠️ Bug 1 |

## Methodology / clean surfaces

What I verified is clean:

- **Console sink output is PII-free**: `@adjudicate/audit/dist/sink-console.js` `serialize()` whitelists v/at/durationMs/intentHash/intentKind/sessionId/principal/taint/decision/basis — never emits `envelope.payload`. Running in prod is safe by construction.
- **Redactor recomputes `auditHash` post-redaction** so `verifyAuditRecord` is meaningful on downstream sinks (`audit-redactor.ts:547-554`).
- **Redis spill stores REDACTED records** (redactor wraps OUTSIDE the buffered sink — `intent-audit-wiring.ts:471-498`). Spill TTL is 7 days; restart-safe.
- **`recordSinkFailure` wiring is correct**: `apps/api/src/plugins/kernel-bootstrap.ts:137-139` calls `recordSinkFailure(event)`; `apps/api/src/plugins/kernel-metrics-sink.ts:546-571` bumps `kernel_audit_sink_failure_total{sink,reason}` + PostHog `nats_sink_failed` + Sentry breadcrumb (warning at <10 consecutive, error at ≥10). The hook is null-safe (`reportSinkFailure` in `intent-audit-wiring.ts:226-233` guards `if (!_sinkFailureHook) return`).
- **`errorClass` is safe**: `intent-audit-wiring.ts:236-241` uses `err.constructor.name`, never `err.message`.
- **Audit-postgres preflight fail-closes**: `kernel-bootstrap.ts:222-241` + `index.ts:138` → process.exit(1) when `intent_audit` table missing.
- **NATS subject is static** (`audit.intent.decision.v1`); payload carries the (redacted) record but the subject itself is low-cardinality.
- **Actor `sessionId` is hashed via `redactActorSessionId`** (`audit-redactor.ts:511-529`) — `me.ts`/`cart.ts` setting `sessionId = customerId` (raw) is OK because the redactor hashes it before any sink sees it.
- **The walker uses `Object.create(null)` containers + rejects `__proto__`/`constructor`/`prototype` own-keys** (`audit-redactor.ts:613-628`) — prototype pollution path is closed.
- **`createSystemTaintPolicy` wrapper-local taint policies fail-closed** for `stripe.*` and `twilio.*` egress — REFUSE on UNTRUSTED.
- **A1 fix verified**: audit-consumer no longer gates on `IBX_AUDIT_POSTGRES_ENABLED` (`grep -n IBX_AUDIT_POSTGRES_ENABLED audit-consumer.ts` returns zero results).

## Open questions

- **Pre-W2 records on disk?** The 2026-05-23 audit noted that pre-W2 redactor preserved the unredacted-payload `auditHash` verbatim. Are there historical rows in `intent_audit` with mismatched `auditHash` that `verifyAuditRecord` will report as `tampered`? Replay tooling needs to branch on `record_version` to avoid noisy false positives.
- **`pack-payments-pix` payload shape** (from the platform repo) is opaque from this audit's vantage. The three kinds `pix.charge.create/.confirm/.refund` may carry PIX taxId / billing payloads — recommend a cross-repo audit of the payload schemas against the redactor's REDACT_FIELDS/HASH_FIELDS coverage.
- **`/admin/orders/:id` PATCH** via `medusaAdjudicated` (admin-scope, NOT store-scope) — does it pass `auditSink`? The `_shared.ts` factory at line 49-65 explicitly skips it via the cycle-avoidance comment.
- **`replayEnvelopeFromAudit` correctness** on rows where `supersedes_jsonb` is NULL but the decision was DEFER → resume (Bug 3) — does the replay harness silently treat each as a fresh adjudication, losing the dedup-against-original-park check?
- **`classifyReplayDrift` stub** — confirmed deferred per the 2026-05-23 audit; no source code observed in this audit. Recommend an integration test that asserts the stub returns at least one drift class on a known-divergent replay (else "no drift" return is silent failure).
