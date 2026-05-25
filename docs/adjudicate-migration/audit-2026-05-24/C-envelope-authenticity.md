# Envelope authenticity audit — 2026-05-24

Branch `feat/kernel-always-on-cutover` @ c5c839c. Read-only audit, no code edits.

## TL;DR

- **3 concrete bugs found** (1 P1 audit-PII leak, 2 P2 trust-labeling issues).
- **No P0 forgery / spoofing / nonce-strength bugs found** in the actor.principal,
  nonce-generation, or webhook-signature surfaces. The principal type is constrained
  by TypeScript to `"llm" | "user" | "system"` (no `"admin"` literal exists in the
  envelope schema, so direct admin-principal injection is structurally impossible).
  Nonce generation uses `crypto.randomUUID()` everywhere on the live path; the
  `Math.random` fallbacks in `stripe/twilio/medusa` wrappers are dead code on
  Node ≥ 22 (engines pin). Stripe and Twilio webhook signatures are verified
  BEFORE lift-to-envelope. The two-person rule on admin force-* routes is enforced
  with null-staff + actor-type-mismatch fail-closed gates (P0-5-TRUE remediation
  appears intact). Customer / staff JWTs are HMAC-signed by `JWT_SECRET` and the
  middleware refuses empty-`sub` defense-in-depth (NEW-P0-X8).

### By severity

| # | Sev | Title                                                                                    |
|---|-----|------------------------------------------------------------------------------------------|
| 1 | P1  | AuditRedactor never walks `decision.rewritten.payload` — REWRITE leaks unredacted PII    |
| 2 | P2  | Customer-driven HTTP routes mint `actor.principal: "system"` + `taint: "SYSTEM"`         |
| 3 | P2  | Customer-driven HTTP routes set `taint: "TRUSTED"` while `actor.principal: "user"`       |

### Top 3 by attacker leverage

1. **Bug 1** — a customer who routes their CPF/email/phone through a `handoff_to_human`
   reason or any WhatsApp message body that triggers a sanitize-REWRITE has their
   plaintext PII published to the NATS `ibatexas.audit.intent.decision.v1` topic
   and persisted to the `intent_audit` Postgres table. The Task 18 redactor reads
   the wrong half of the AuditRecord. Internal NATS subscriber compromise = total
   PII exfil. **Customer-controllable trigger, low effort, immediate impact.**
2. **Bug 2** — when (not if) `paymentsTaintPolicy.systemOnlyKinds` is extended to
   cover a new kind that customer routes ALSO call via the `"system" + SYSTEM`
   path, the existing customer route would unintentionally satisfy the gate.
   Today the harm is latent (the routes happen to call kinds where the policy
   accepts it). Future kind additions are foot-guns.
3. **Bug 3** — same flavor as #2 for `TRUSTED`. Today no pack uses TRUSTED-minimum;
   if any future pack adds a staff-only kind at TRUSTED, customer routes
   already hold a forged TRUSTED-tainted envelope shape that would pass.

---

## Bug 1 — AuditRedactor never walks `decision.rewritten.payload`

**Severity:** P1
**File:** `packages/llm-provider/src/audit-redactor.ts:394-450`
**Class:** PII smuggle through audit record

**Attack.** A customer authenticates over WhatsApp and types a message containing
their CPF, email, or phone (any free-form field that survives Pack-level REWRITE).
For example, the customer's last conversational message becomes
`payload.body` on a `whatsapp.message.send` envelope where `senderRole = "customer"`
and `recipientType = "staff"`. The kernel runs the `sanitizeCustomerToStaff`
guard at `packages/pack-whatsapp/src/policies.ts:321-353`, which calls
`sanitizeCustomerString()` (`packages/pack-whatsapp/src/sanitize.ts:117-124`).
That sanitizer explicitly states it does NOT do PII detection — it strips
newlines, markdown, and zero-width chars only. The guard emits
`decisionRewrite(rewrittenEnvelope, ...)` where `rewrittenEnvelope.payload.body`
still contains the customer's CPF / email / phone.

The kernel builds an `AuditRecord` via `buildAuditRecord({envelope, decision, ...})`
(`node_modules/@adjudicate/core/dist/audit.js:22-62`). The record's
`decision.rewritten.payload` is the sanitized-but-still-PII-bearing envelope.

The IbateXas `AuditRedactor.redact(record)` walks ONLY `record.envelope.payload`
and `record.envelope.actor.sessionId` (`audit-redactor.ts:403-437`). It NEVER
touches `record.decision` — the spread on line 431 (`{ ...record, envelope: ... }`)
copies `decision` through unmodified. Confirm by grep:
`grep -n "decision\\." packages/llm-provider/src/audit-redactor.ts` returns
only one hit (a comment).

The `recomputeAuditHash` then re-derives `auditHash` over the half-redacted
record — so `verifyAuditRecord` reports `verified: true` for a record whose
`decision.rewritten.payload.body` contains plaintext PII.

The record fans out via `intent-audit-wiring.ts:471-499` to:
- console sink (developer-visible),
- NATS `ibatexas.audit.intent.decision.v1` (any subscriber with permission),
- `intent_audit` Postgres table (long-term durable).

**Trust model violated.** Audit-redactor invariant #4
(`audit-redactor.ts:67-72`) explicitly lists what is "untouched" and what is
"transformed." Per that invariant `decision` is in the untouched set —
documenting the bug as intentional. But the threat model in the file header
(`audit-redactor.ts:13-18`) says "any subscriber with permission reads CPF in
cleartext" describing the exact scenario this bug enables via the `decision`
field. The redactor closes the bypass on `envelope.payload` and leaves the
identical bypass open on `decision.rewritten.payload`.

Same shape applies to any other Pack that emits `decisionRewrite` carrying
customer-controlled payload fields:
- `pack-orders` clamps `quantity` (no PII) — safe.
- `pack-payments-pix` clamps `refundCentavos` (no PII) — safe.
- `pack-whatsapp` sanitizes `body` (PII-bearing) — UNSAFE.
- Any future REWRITE that preserves free-form text — UNSAFE by default.

**Suggested fix.** In `audit-redactor.ts:redact()`, when the decision kind is
`REWRITE`, also walk `decision.rewritten.payload` with the same `walk()` and
`redactActorSessionId` plumbing. Rebuild `decision.rewritten` as a deep clone
with the redacted payload and a hashed `actor.sessionId`. Then proceed to
`recomputeAuditHash`. Add a contract test that builds a REWRITE decision with
a CPF in `rewritten.payload.body` and asserts the emitted record's
`decision.rewritten.payload.body` is the `[REDACTED]` sentinel.

While there, audit `decision.basis[i].details` — that's an open
`Record<string, unknown>` and at least one Pack (`pack-payments/policies.ts:122`)
puts `payload.method` into a basis. Today no Pack puts PII into a basis;
defense-in-depth is to scrub recognized PII keys here too.

---

## Bug 2 — Customer HTTP routes mint `actor.principal: "system"` + `taint: "SYSTEM"`

**Severity:** P2
**Files:**
- `apps/api/src/routes/order-actions.ts:944` (`/api/orders/:id/payment/retry`)
- `apps/api/src/routes/order-actions.ts:1079` (`/api/orders/:id/payment/regenerate-pix`)
- `apps/api/src/routes/order-actions.ts:1112` (regen counter bump)
- `apps/api/src/routes/order-actions.ts:1277` (`PATCH /api/orders/:id/payment/method`)

**Class:** Trust-boundary mislabel (latent forgery)

**Attack.** A logged-in customer hits `/api/orders/:id/payment/retry` (or
`/regenerate-pix`, or `/payment/method`). The route handler is invoked
inside `requireAuth` (so customer JWT verified, `customerId` populated),
verifies ownership, then constructs a `payment.create` envelope with
`actor.principal: "system"`, `actor.sessionId: "customer:${customerId}"`,
`taint: "SYSTEM"`. The `paymentsTaintPolicy` at
`packages/pack-payments/src/types.ts:398-411` lists `payment.create` in
`systemOnlyKinds` — i.e., the minimum taint is SYSTEM. The customer's HTTP
request has fully satisfied the SYSTEM gate.

**Trust model violated.** Per CLAUDE.md rule #9: *"System-driven mutations
(subscribers, jobs, webhooks) MUST build a system-actor envelope
(`actor.principal = "system"`) via `buildSystemEnvelope()` from
`apps/api/src/subscribers/__shared__/`."* The convention is "system" =
not user-driven. These HTTP routes ARE user-driven (a customer hit the
endpoint). The route bypasses the helper and inlines the system-actor
shape directly.

Today's harm is bounded because the payload itself is server-derived
(orderId from URL params, method/amount from DB after ownership check)
and the only SYSTEM-only kinds the routes target — `payment.create` —
do legitimately need system-actor creation. The kernel accepts the
envelope without complaint.

The latent forgery: the moment any future code adds a SYSTEM-only kind
or guard that branches on `actor.principal === "system"` (e.g., "skip
audit for system" or "auto-approve refunds initiated by system"), the
customer route already mints that shape and the customer gains the
elevated path.

The audit record carries `actor.principal: "system"`, which makes audit
correlation lie: the operator dashboard cannot tell "system did X" apart
from "a customer-driven flow that LABELED itself as system did X."

**Suggested fix.** Two-stage:

1. Introduce a third allowed actor principal (e.g., `"user-system"` or
   keep `"user"` and let the route call a `*FromEnvelope` variant that
   bypasses the taint gate for the legitimate cases). The path through
   `paymentCmdSvc.createFromEnvelope` could accept an envelope whose
   `actor.principal === "user"` AND a side-channel "this is a system-
   initiated create" flag emitted by a route-side wrapper — but that
   reintroduces a trust side-channel.
2. The cleaner shape: customer-initiated payment retries should not be
   `payment.create` kinds at all. Migrate to a dedicated `payment.retry`
   intent kind already declared in `pack-payments` (the policy bundle
   lists it at policies.ts:443) with `taint: "UNTRUSTED"` and the route's
   guard ladder doing the auth + state check inside the kernel. The
   create-new-row side effect lives inside the executor.

Until that migration, document in the route header that this is a
trust-label foot-gun and add a contract test that fails CI if any
NEW route adds an inline `actor.principal: "system"` outside the
explicit allowlist.

---

## Bug 3 — Customer HTTP routes set `taint: "TRUSTED"` with `actor.principal: "user"`

**Severity:** P2
**Files:**
- `apps/api/src/routes/order-actions.ts:355` (inner payment-cancel during order.cancel)
- `apps/api/src/routes/order-actions.ts:910` (payment retry — cancel-old)
- `apps/api/src/routes/order-actions.ts:1051` (PIX regen — cancel-old)
- `apps/api/src/routes/order-actions.ts:1226` (method switch — to-switching transition)
- `apps/api/src/routes/order-actions.ts:1253` (method switch — cancel)

**Class:** Trust-boundary mislabel (latent forgery)

**Attack.** A logged-in customer hits any of the routes above. The route
handler builds a `payment.status.transition` envelope with
`actor.principal: "user"` and `taint: "TRUSTED"`. The customer's HTTP
request has labeled itself as TRUSTED-grade.

`paymentsTaintPolicy.userMinimum = "UNTRUSTED"`
(`packages/pack-payments/src/types.ts:410`), so today the gate is
satisfied by either UNTRUSTED or TRUSTED — making TRUSTED a no-op
upgrade. The other guards in `paymentsPolicyBundle` (state, business)
do the work.

**Trust model violated.** Per the taint lattice docs in
`@adjudicate/core/taint.js:1-10`: *"the envelope carries one Taint
representing the worst-trust field anywhere in its payload."* The
customer's HTTP body (e.g., the optional `reason` text in `cancelPayload`
at order-actions.ts:351) is UNTRUSTED by construction. Labeling the
envelope as TRUSTED misrepresents what the upstream auth did.

Risk amplifies if:
- A future Pack adds a TRUSTED-minimum kind (e.g., `payment.refund.issue`
  is currently SYSTEM-only; the staff routes use TRUSTED through
  `principalFor(staffId)`. If pack-payments later lowers a kind to
  TRUSTED-minimum, the customer routes already hold the shape that
  satisfies it).
- A new guard branches on `envelope.taint === "TRUSTED"` to skip some
  expensive check.

**Suggested fix.** Customer-driven routes should set `taint: "UNTRUSTED"`
unconditionally. The kernel's `paymentsTaintPolicy.userMinimum` already
accepts UNTRUSTED for these kinds. Search-and-replace at the five sites
above. Add a lint or contract test that enforces "any envelope built
inside `apps/api/src/routes/{order-actions,cart,me}.ts` with
`actor.principal === "user"` MUST have `taint === "UNTRUSTED"`."

The exception is `actor.principal: "system"` paths inside the same
routes (Bug 2's surface), which legitimately need `taint: "SYSTEM"` to
clear SYSTEM-only kinds today.

---

## Methodology / clean surfaces

### Methodology

1. Inventoried every `buildEnvelope` / `buildSystemEnvelope` site in apps/api
   and packages (~118 production sites). For each, traced the actor / taint
   / nonce arguments upward to identify the trust source.
2. Read `@adjudicate/core/envelope.{js,d.ts}`, `taint.js`, `audit.js`,
   `hash.js` to confirm the contract — `intentHash` covers
   (version, kind, payload, nonce, actor, taint); `Taint` is rank-ordered
   SYSTEM > TRUSTED > UNTRUSTED; the `IntentActor.principal` type literal
   is `"llm" | "user" | "system"` (no `"admin"` exists, structurally
   blocking admin-principal injection).
3. Confirmed nonce-source determinism:
   - LLM intent-bridge: `crypto.randomUUID()` (tool-registry.ts:118, 396).
   - HTTP routes: `crypto.randomUUID()` (every call site).
   - System actor (subscribers, jobs): deterministic `eventId` argument
     (system-actor-envelope.ts:97), pinned to upstream NATS event id or
     `jobName:tickId` shape. Every observed `eventId` is server-generated
     and not attacker-controllable.
   - Stripe webhook reconcile: `event.id` (stripe-webhook.ts:112) — Stripe-
     signed.
   - Twilio inbound: signature verified BEFORE lift-to-envelope
     (whatsapp-webhook.ts:244).
4. Read AuditRedactor in full — confirmed `record.decision` is not walked.
   Cross-checked with Decision type (`decision.rewritten` only present
   on REWRITE) and pack-whatsapp REWRITE (preserves PII-bearing body).
5. Spot-checked admin two-person rule (`admin-confirmation-store.ts`) —
   fail-closed gates for null-staff + actor-type-mismatch + same-actor are
   intact; pending records use UUID-namespace key + Lua atomic consume.
6. Searched for `Math.random` in security paths — found dead fallback in
   stripe/twilio/medusa wrappers (Node ≥ 22 makes them unreachable).

### Clean surfaces

- **Actor-principal forgery — no concrete bug.** The TypeScript constraint
  on `IntentActor.principal` (`"llm" | "user" | "system"`) blocks
  injection of an `"admin"` literal. The only sites that set
  `"system"` from a non-system trigger are the customer-routes flagged
  in Bug 2 — a labeling issue, not a hash forgery (the hash matches what
  the route claimed).
- **Nonce predictability — no concrete bug.** All live-path nonces use
  `crypto.randomUUID()` (Node 22+) or a deterministic upstream-event ID
  (system actor). The `Math.random` paths in
  `packages/tools/src/{stripe,twilio,medusa}/...` are guarded by a
  `globalThis.crypto.randomUUID` presence check and never trigger in
  production. Worth cleaning up for clarity but not exploitable today.
- **Nonce collision (system actor) — no concrete bug.** System-actor
  `eventId`s are `paymentId:newStatus`, `orderId:displayId`,
  `${sessionId}:${msg.sentAt}:${idx}`. None observed to be
  attacker-controllable. The intentHash includes payload + actor + kind,
  so even if an attacker forced a collision on `eventId` alone, payload
  divergence would still produce a distinct hash. The ledger uses
  `SET NX` (`ledger-redis.js:43`) so first-writer-wins.
- **Hash includes kind — confirmed.** `buildEnvelope` hashes
  (version, kind, payload, nonce, actor, taint). A same-nonce-different-kind
  shape produces distinct hashes.
- **Direct `adjudicate()` calls — no concrete bug.** Searched for direct
  `adjudicate(envelope, ...)` invocations; every production caller routes
  through a wrapper (`runCustomerIntent`, `medusaAdjudicated`,
  `stripeAdjudicated`, `twilioAdjudicated`, `*CmdSvc.*FromEnvelope`).
  `executeToolDirect` was removed (task 06) and the removal comment forbids
  reintroduction (tool-registry.ts:409-428).
- **Stripe webhook signature verify — gated correctly.**
  `stripeWebhookRoutes` calls `stripe.webhooks.constructEvent` BEFORE
  any envelope construction (stripe-webhook.ts:630). Signature failure
  returns 400 before `reconcilePaymentFromStripe` runs.
- **Twilio inbound signature — gated correctly.** `verifyTwilioSignature`
  runs as step 1 of the handler (whatsapp-webhook.ts:244), gating the
  body parse + envelope lift.
- **Admin two-person rule — fail-closed.** `consumeWithSameActorCheck`
  refuses on null staffId either side AND on actor-type mismatch
  (admin-confirmation-store.ts:222-286). P0-5-TRUE remediation intact.
  Receipts use UUID id + Lua atomic GET+DEL consume.
- **JWT trust — separated by cookie name, not by JWT secret.** Customer
  and staff tokens both signed by `JWT_SECRET`. The `userType` claim
  routes them. Empty-`sub` defense (NEW-P0-X8) blocks the
  `customerId = ""` collapse. No JWT-issuance code path mints a
  `userType: "staff"` token to a non-staff identity.
- **Admin receipt `redis.set` lacks `NX`** — not a real bug because
  the receipt id is `randomUUID()` (collision-negligible) and a collision
  would only cause the latest write to overwrite an unconsumed older one.
- **`actor.principal === "system"` from customer routes** — listed under
  Bug 2 (labeling); the principal value matches the kernel expectation
  for system-only kinds, so no spoofing per se.

## Open questions

- Should the routes in Bug 2 use a new `actor.principal: "user"` shape
  with route-side privilege-elevation metadata recorded out-of-band, or
  should pack-payments grow customer-initiated retry/regen/method kinds
  to keep the actor honest? CLAUDE.md "Hard Rules" doesn't pick a side.
- `decision.basis[i].details` is `Record<string, unknown>` — open-ended.
  Today no Pack puts PII into a basis, but the analyzer-friendly shape
  invites it. Should the redactor walk basis details too? My read says
  defense-in-depth says yes; the AuditRedactor invariant #4 is silent
  on whether `decision.basis` is part of the "untouched" set or simply
  forgotten.
- The audit-record's `auditHash` covers everything except `auditHash` and
  `signature`. Re-deriving on the redacted record means a downstream
  verifier needs the SAME redaction config (salt + rule set) to reproduce
  the hash. Replay tools must snapshot `AUDIT_REDACT_SECRET`. The Bug 1
  fix preserves this invariant — the recomputation already happens on
  the redacted record.
- `outbox-retry.ts:113` uses `Math.random()` for jitter — not a security
  path (just retry-backoff dispersion), but worth verifying it doesn't
  feed any envelope.
- The kernel returns `decision.kind === "REWRITE"` to the customer-intent-
  gateway, which then calls `executor(rewritten.payload)`. The REWRITE
  is applied. If the audit-emit fails (best-effort, fail-open per
  customer-intent-gateway.ts:170-188), the rewrite still runs. The
  in-flight rewrite shape never leaks to the customer (the route returns
  the executor's result, not the decision). Confirmed.
