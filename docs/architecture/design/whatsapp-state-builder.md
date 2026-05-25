# WhatsApp `lastCustomerMessageAt` state-builder — design

> **Status:** design draft, awaiting stakeholder review. **Implementation NOT started.**
> **Authored:** 2026-05-24, post-H2 close (`654d337`). Base branch: `feat/kernel-always-on-cutover`.
> **Brief:** [`docs/adjudicate-migration/audit-2026-05-24/tasks/whatsapp-state-builder-design.md`](../../adjudicate-migration/audit-2026-05-24/tasks/whatsapp-state-builder-design.md).

---

## Context

`@ibatexas/pack-whatsapp` (the WhatsApp business-policy Pack) declares an
`WhatsAppState` whose `ctx.lastCustomerMessageAt` field drives the
Twilio-mandated **24-hour customer-initiated window** guard. Per
[`packages/pack-whatsapp/src/policies.ts:106-129`](../../../packages/pack-whatsapp/src/policies.ts):

```
const requireWindowOpen: WhatsAppGuard = (envelope, state) => {
  if (envelope.kind !== "whatsapp.message.send") return null
  ...
  const last = state.ctx.lastCustomerMessageAt
  if (!last) {
    return decisionRefuse(refuseWindowExpired(), [...]) // REFUSE: no_prior_customer_message
  }
  const ageMs = now.getTime() - last.getTime()
  if (ageMs <= WHATSAPP_24H_WINDOW_MS) return null
  return decisionRefuse(refuseWindowExpired(), [...])   // REFUSE: window_expired
}
```

The Pack's policy contract says: **the adopter (subscriber, job, route) is
responsible for projecting `lastCustomerMessageAt` into state at decision
time**. Today, NO adopter does so. As a result, every subscriber and job
that today calls `sendText(...)` directly (i.e., bypasses the
`whatsapp.message.send` envelope path) does so because they have no clean
way to read "when did this customer last message us?" from a stable
projection.

Post-H2 we now have the wrapper-meta and `auditSink` boot-time DI
contract settled (`@ibatexas/audit-sink` leaf, `654d337`). The
state-builder is the next-mile chokepoint helper that, together with
`buildSystemEnvelope()` (already-shipped at
[`apps/api/src/subscribers/__shared__/system-actor-envelope.ts`](../../../apps/api/src/subscribers/__shared__/system-actor-envelope.ts)),
lets ~7-9 deferred subscriber/job egress paths flip onto the kernel-gated
`whatsapp.message.send` path.

This doc proposes two alternatives, recommends one, and enumerates the
test fixtures + rollout sequencing required to land it.

---

## Deferred sites inventory (9 sites)

Enumerated via `grep -rn "sendText\|sendMedia" apps/api/src apps/api/src/jobs apps/api/src/subscribers` + cross-reference with [`docs/adjudicate-migration/open-blockers.md`](../../adjudicate-migration/open-blockers.md) §"Out-of-scope from task 16". Excludes the inbound `whatsapp-webhook.ts` egress (that's the LLM agent reply, fundamentally different — it's always inside the 24h window by definition because the customer just messaged in).

| # | Site | File:line | Envelope it would build | What state it needs | Behaviour gated today |
|---|---|---|---|---|---|
| 1 | `notification.send` subscriber (cart-intelligence) | [`apps/api/src/subscribers/cart-intelligence.ts:822-873`](../../../apps/api/src/subscribers/cart-intelligence.ts) | `whatsapp.message.send` (SYSTEM, customer recipient) | `lastCustomerMessageAt` for the customer's WhatsApp identity (E.164 phone → projection) | Delivers WhatsApp notifications (cart abandoned tier 1/2/3, order placed, status changes, dispute alerts, review prompts) **without** firing the 24h-window guard. Silent delivery failure (Twilio rejects out-of-window non-templated sends) is the production failure mode today. |
| 2 | `handoff-subscriber` | [`apps/api/src/subscribers/handoff-subscriber.ts:14-61`](../../../apps/api/src/subscribers/handoff-subscriber.ts) | `whatsapp.message.send` (SYSTEM, staff recipient) | `lastCustomerMessageAt` for the **customer's** phone (per `WhatsAppState.ctx.lastCustomerMessageAt` semantics — the customer-initiated window is what matters; the staff recipient is just the egress target). Plus `perCustomerHandoffCount` for rate-limit. | Sends customer→staff handoff alert when the LLM requests human review. Bypasses both the 24h-window guard AND the per-customer handoff rate-limit (3rd+ in 10min should REFUSE; today no rate-limit fires). |
| 3 | `cart.abandoned` tier-escalation (cart-intelligence handler) | [`apps/api/src/subscribers/cart-intelligence.ts:124-254`](../../../apps/api/src/subscribers/cart-intelligence.ts) | `whatsapp.message.send` (SYSTEM) via `notification.send` relay — see #1 | `lastCustomerMessageAt` | The cart-abandoned tier escalator publishes `notification.send` events at tier 1 (4h), tier 2 (4h+18h), tier 3 (4h+18h+24h). Each fan-out is currently un-governed. Tier-3 messages are by definition fired ≥ 46h after the last customer message — these ARE outside the 24h window and would be REFUSEd by the state-builder; this is the **correct** behaviour. Today the silent-Twilio-reject is the failure mode. |
| 4 | `review.prompt` subscriber (cart-intelligence) | [`apps/api/src/subscribers/cart-intelligence.ts:938-980`](../../../apps/api/src/subscribers/cart-intelligence.ts) | `whatsapp.message.send` (SYSTEM) | `lastCustomerMessageAt` | Sends a review-request WhatsApp message 30min after delivery. The customer received the order (so they're warm) but they may not have *messaged* in 24h. Same silent-Twilio-reject hazard. |
| 5 | `proactive-engagement` job | [`apps/api/src/jobs/proactive-engagement.ts:138`](../../../apps/api/src/jobs/proactive-engagement.ts) | `whatsapp.template.send` (SYSTEM) preferred — proactive outreach to dormant (≥7d inactive) customers is by-definition **outside** the 24h window | (For free-form) `lastCustomerMessageAt`. (For template path) only the SYSTEM taint check applies. | Sends outreach to dormant customers. These ARE the customers most likely to be outside the 24h window; the template-send path is the correct destination. The state-builder still needs to project `lastCustomerMessageAt` so the policy can choose between `message.send` REFUSE vs. `template.send` admit. |
| 6 | `hesitation-nudge` job | [`apps/api/src/jobs/hesitation-nudge.ts:52`](../../../apps/api/src/jobs/hesitation-nudge.ts) | `whatsapp.message.send` (SYSTEM) | `lastCustomerMessageAt` (should be < 45s old by construction — fires after first-contact debounce) | Sends a reinforcement nudge 45s after first contact. By construction inside the 24h window, but the policy needs the projection to confirm rather than assume. |
| 7 | `pix-expiry-monitor` job | [`apps/api/src/jobs/pix-expiry-monitor.ts:55,72,77`](../../../apps/api/src/jobs/pix-expiry-monitor.ts) | `whatsapp.message.send` (SYSTEM) | `lastCustomerMessageAt` (the customer just placed a PIX order — by construction inside the window) | Sends PIX reminder (25min) and expiry (30min) messages. The customer placed the order minutes ago so they're well inside the window, but the policy needs the projection. |
| 8 | `reservation-reminder` job | [`apps/api/src/jobs/reservation-reminder.ts:71`](../../../apps/api/src/jobs/reservation-reminder.ts) (via `sendReservationReminder` in [`packages/tools/src/reservation/notifications.ts:154`](../../../packages/tools/src/reservation/notifications.ts)) | `whatsapp.message.send` or `whatsapp.template.send` (SYSTEM) | `lastCustomerMessageAt` to choose path | Sends day-of reservation reminders. Customer made the reservation through some channel (web, WhatsApp, walk-in); may or may not be inside the 24h window. **Most likely outside**, so `template.send` is the right destination — and the state-builder is needed to make the policy choose. |
| 9 | `cart-recovery-messages` job-helper paths (called from #1 via `notification.send`) | [`apps/api/src/jobs/cart-recovery-messages.ts`](../../../apps/api/src/jobs/cart-recovery-messages.ts) | Same as #1 — relayed through `notification.send` | Same as #1 | Builds the per-tier recovery message body. Inherits #1's gating. |

**Total: 9 deferred sites** (the original brief said "~7+"; we found 9, comfortably within the "<15 = no scope explosion" hard-stop in the brief).

**Already-governed sites (no state-builder needed):**
- `apps/api/src/whatsapp/client.ts:sendText/sendMedia` — already kernel-gated via `twilioAdjudicated` (the **wrapper-level** intent `twilio.message.send`, distinct from the **business-level** `whatsapp.message.send`). Per `packages/tools/src/twilio/adjudicated.ts:43-52`, the wrapper governs HTTP egress; the Pack governs the channel-level business policy. The state-builder is for the **business-level** path that lives upstream of the wrapper.
- `apps/api/src/routes/whatsapp-webhook.ts` (all `sendText` sites — these are agent replies to a just-received customer message; the customer is by definition inside the 24h window at decision time. **No state-builder needed** here, but a cleaner future refactor could thread the projection through anyway for uniformity.)
- `cart-intelligence.ts:order.placed` 6 analytics-only mutations (copurchase, recently-viewed, etc.) — Redis-only, no WhatsApp egress.

---

## Existing state surface

### XState machine (LLM-agent state) — NOT involved

[`docs/architecture/design/hybrid-state-flow.md`](./hybrid-state-flow.md) describes the 10-layer pipeline driving the LLM agent. The XState machine's snapshot (`wa:machine:{sessionId}` per [`docs/ops/redis-memory.md:27`](../../ops/redis-memory.md)) tracks per-turn conversation flow (cart state, checkout step, last tool call). It does NOT track inbound-message timestamps as a first-class concept — the customer's last inbound IS the implicit anchor for "agent should run", but no field is exposed for downstream consumers.

The state-builder is OUT-of-band w.r.t. the XState machine. It serves the Pack-policy layer (which decides whether to ADMIT or REFUSE outbound Twilio sends), not the conversation-flow layer.

### Existing inbound-message provenance (the data sources)

Three places already know "when did this customer last message us":

1. **Redis hash** `wa:phone:{phoneHash}.lastMessageAt` ([`apps/api/src/whatsapp/session.ts:96,196,228`](../../../apps/api/src/whatsapp/session.ts)) — set on every WhatsApp webhook hit via `touchSession()`. Cleared after 24h via the hash's TTL. **Stores a millisecond epoch as string.** Closest existing projection but: (a) keyed by `phoneHash` not `customerId`, (b) includes outbound-agent activity too (the session rotates after 30min idle regardless of direction), and (c) the TTL is the same as the policy window — so reading "was there a customer message within the last 24h" via `EXISTS` is degenerate with reading the TTL.

2. **Redis list** `session:{sessionId}` ([`apps/api/src/session/store.ts:14-22`](../../../apps/api/src/session/store.ts)) — JSON-encoded `AgentMessage[]` ordered list, last 50 messages, 24h (auth)/48h (guest) TTL. Each message has `role: "user" | "assistant" | "system"`. The latest `role: "user"` entry's timestamp would be `lastCustomerMessageAt` — but the structure embeds no per-message timestamp by default (only the implicit `Date.now()` at insertion). The CDC publish path attaches `sentAt: new Date().toISOString()` to each message at archival ([`store.ts:69`](../../../apps/api/src/session/store.ts)). Reading this back to compute `lastCustomerMessageAt` requires LRANGE + JSON.parse + reverse-scan for the latest `role: "user"`.

3. **Postgres** `ibx_domain.conversation_messages` ([`packages/domain/prisma/schema.prisma:555-569`](../../../packages/domain/prisma/schema.prisma)) — the durable archive. One row per message with `role: MessageRole`, `sentAt: DateTime`, `conversationId` (FK to `Conversation.sessionId`). Already indexed on `(conversationId, sentAt)`. **This is the only source of truth that survives Redis eviction** and supports queries beyond 24h.

### Inbound-write path (where the projection write would hook)

The single inbound-message ingestion path is [`apps/api/src/routes/whatsapp-webhook.ts`](../../../apps/api/src/routes/whatsapp-webhook.ts). It already:

- calls `touchSession(hash)` at line 412 (updates `wa:phone:*.lastMessageAt`)
- calls `appendMessages(session.sessionId, [{ role: "user", content }], ...)` at lines 86, 400, 437, 517 — these append to Redis AND fan out a `conversation.message.appended` NATS event at line 62 of `store.ts`
- the [`conversation-archiver.ts` subscriber](../../../apps/api/src/subscribers/conversation-archiver.ts) consumes `conversation.message.appended` and writes to Postgres `conversation_messages`

So **for any inbound customer message, three writes already happen synchronously / via CDC**. The state-builder design choice is which of those three reads (or a fourth new write) to canonicalise.

### Redis key conventions (per CLAUDE.md rules #7 & #10)

- All keys via `rk()` from `@ibatexas/tools` — never raw strings.
- All locks via UUID-value Lua-conditional-release pattern (rule #10) — exemplified at `session.ts:241-313`.
- A new WhatsApp-state Redis key would be named `wa:last_customer_msg:{phoneHash}` or `wa:last_customer_msg:{customerId}` (see "join axis" question in §"Open questions"). Existing `wa:*` prefix groups it with the other WhatsApp session keys for ops visibility.

---

## Alternative A — Redis-backed projection (TTL'd)

### Shape

A new Redis string per customer:

- **Key:** `wa:last_customer_msg:{phoneHash}` (joining on `phoneHash` keeps the projection independent of `customerId` resolution; `phoneHash` is what the inbound webhook has immediately, and `WhatsAppState` already keys other fields on `phoneHash`).
- **Value:** millisecond epoch as string (matches existing `wa:phone:*.lastMessageAt` convention).
- **TTL:** 25h (24h policy window + 1h buffer to give the state-builder grace on the policy's `WHATSAPP_24H_WINDOW_GRACE_SECONDS` overshoot). After TTL expiry the key vanishes and the projection returns `null`, which the Pack interprets as "no prior customer message" → REFUSE (the **conservative** default per [`policies.ts:113`](../../../packages/pack-whatsapp/src/policies.ts)).

### Write path

Hook into the existing inbound webhook flow at `apps/api/src/routes/whatsapp-webhook.ts`. A new helper in `apps/api/src/whatsapp/session.ts`:

```typescript
// Pseudo-signature — DO NOT IMPLEMENT YET
export async function markCustomerInboundAt(
  phoneHash: string,
  whenMs: number,
): Promise<void> {
  const redis = await getRedisClient();
  const key = rk(`wa:last_customer_msg:${phoneHash}`);
  await redis.set(key, String(whenMs), { EX: 25 * 60 * 60 });
}
```

Called from every place the webhook handler currently calls `touchSession(hash)` (line 412). The `wa:phone:*` hash continues to track session rotation (different concern); this new key is **purely for the Pack policy projection**.

### Read path (the state-builder itself)

A new module — say, `apps/api/src/subscribers/__shared__/whatsapp-state-builder.ts` (sibling to `system-actor-envelope.ts`):

```typescript
// Pseudo-signature — DO NOT IMPLEMENT YET
export async function buildWhatsAppState(args: {
  customerPhone: string;                        // E.164, hashed inside
  recipientType: "customer" | "staff" | "system";
  staffId?: string | null;
  customerId: string | null;
}): Promise<WhatsAppState> {
  const phoneHash = hashPhone(args.customerPhone);
  const redis = await getRedisClient();
  const key = rk(`wa:last_customer_msg:${phoneHash}`);
  const lastMs = await redis.get(key);
  return {
    ctx: {
      channel: "whatsapp",
      customerId: args.customerId,
      staffId: args.staffId ?? null,
      now: new Date(),
      lastCustomerMessageAt: lastMs ? new Date(Number.parseInt(lastMs, 10)) : null,
      perCustomerHandoffCount: await readHandoffCount(phoneHash), // separate projection
      recipientType: args.recipientType,
    },
  };
}
```

Adopter (deferred site #1, etc.) flow:

```typescript
const state = await buildWhatsAppState({
  customerPhone: customer.phone,
  recipientType: "customer",
  customerId: customer.id,
});
const envelope = buildSystemEnvelope({
  kind: "whatsapp.message.send",
  payload: { to: customer.phone, body: text, senderRole: "system" },
  sourceSubject: "notification.send",
  eventId: `${customerId}:${type}`,
});
const outcome = await whatsappCmdSvc.sendMessageFromEnvelope(envelope, state);
```

(`whatsappCmdSvc` does not yet exist — its scope is implementation-time; see "Rollout sequencing".)

### Failure mode

Redis unreachable → `redis.get()` throws → the state-builder propagates → the adopter MUST **fail closed** (per CLAUDE.md rule #9, "always-on kernel posture"). The adopter catches and REFUSEs by skipping the Twilio send, logging, and pushing to DLQ. This mirrors how the execution-ledger handles Redis unreachability (always-on fail-closed).

The state-builder itself does NOT swallow the Redis error — it lets the adopter decide. Surfacing the error to the adopter (rather than returning a default state with `lastCustomerMessageAt: null`) is **important**: a `null` projection would REFUSE silently with the wrong basis code (`no_prior_customer_message`); a Redis error should fail with a distinct operational error so the dashboards bump `kernel_state_builder_redis_failure_total`.

### Replay implications — **CRITICAL TRADE-OFF**

Redis-based state is **NOT replayable from the audit trail alone**. The audit-postgres `intent_audit` row captures the envelope and the decision, but the state input (`lastCustomerMessageAt: 2026-05-24T11:00:00.000Z`) is only logged in the basis-metadata of the kernel's decision. Replaying a refusal months later (e.g., during a forensic investigation) requires either:

- (a) the original Redis state, long since evicted, or
- (b) reconstructing it from `conversation_messages` Postgres rows — which is just **the alternative B path** retrofitted as a forensic recovery.

This means: if regulators audit a "we refused to message X because window expired" decision 90 days later, with alt-A we cannot 100% prove the state at decision time — only that the policy fired and our (now-evicted) projection said `null` or some stale value. **The decision basis would carry the value; the data source would not.** For most decisions this is fine (the basis IS the audit), but for **escalated regulatory inquiries** the lack of source-of-truth permanence is a weakness.

### Trade-offs (Alt A)

**Pros:**
- Cheap reads (<1ms), no Prisma round-trip on the hot path.
- Naturally TTL-bounded — the projection's lifetime IS the policy window, so we don't accumulate stale state.
- Write hooks into existing `touchSession()` path — minimal new code surface.
- Failure mode is uniform with the existing always-on kernel posture.

**Cons:**
- Redis-as-source-of-truth for policy decisions is **not durably replayable** — the projection is gone by the time the audit row is queried.
- Adds a new `wa:*` key; ops dashboards need to learn it.
- Couples the state-builder to the WhatsApp-webhook path — if a customer interacts via another channel and later WhatsApp egress is fired, we don't have the projection.
- Doesn't extend cleanly to "did the customer message us via SMS or email in the last 24h" — Twilio rules are WhatsApp-specific, but future channels would need separate projections.

---

## Alternative B — Postgres-backed materialized view (Customer column)

### Shape

A new column on the existing `Customer` model:

```prisma
model Customer {
  ...
  lastCustomerMessageAt DateTime? @map("last_customer_message_at")
  ...
}
```

(Or a sibling table `WhatsAppCustomerState` with FK to `Customer.id` if we want to keep `Customer` lean. The single-column approach is simpler; the sibling-table approach scales better if we later add other channel-specific state fields. We can defer that subdivision until we have a 2nd field to colocate.)

### Write path

Hook into the **CDC consumer** (`conversation-archiver.ts`), NOT the webhook handler directly. The archiver already writes `conversation_messages` rows; extending it to also UPDATE `customers.last_customer_message_at` when the appended message has `role: "user"` and `channel: "whatsapp"` is a single Prisma `UPDATE` in the same transaction.

Pseudo-flow (for design illustration; not the actual code):

```
conversation.message.appended event
  → conversation-archiver subscriber
    → INSERT conversation_messages row (already happens)
    → IF role === "user" AND channel === "whatsapp":
        UPDATE customers SET last_customer_message_at = sentAt
        WHERE customers.id = (lookup by sessionId → conversationId → customerId)
```

This is **envelope-governed** because `conversation.message.append` is already kernel-gated (`packages/domain/src/services/__shared__/conversation-policy.ts`). The state-builder's WRITE side is implicit — it's a side-effect of an already-governed envelope.

### Read path

The state-builder is a simple Prisma query:

```typescript
// Pseudo-signature — DO NOT IMPLEMENT YET
export async function buildWhatsAppState(args: {
  customerId: string;                           // Postgres PK
  customerPhone: string;
  recipientType: "customer" | "staff" | "system";
  staffId?: string | null;
}): Promise<WhatsAppState> {
  const phoneHash = hashPhone(args.customerPhone);
  const customer = await prisma.customer.findUnique({
    where: { id: args.customerId },
    select: { lastCustomerMessageAt: true },
  });
  return {
    ctx: {
      channel: "whatsapp",
      customerId: args.customerId,
      staffId: args.staffId ?? null,
      now: new Date(),
      lastCustomerMessageAt: customer?.lastCustomerMessageAt ?? null,
      perCustomerHandoffCount: await readHandoffCount(phoneHash),  // STILL Redis — see below
      recipientType: args.recipientType,
    },
  };
}
```

Note: `perCustomerHandoffCount` STAYS Redis-backed in alt B too — it's a rolling-window counter, not a durable timestamp; Postgres is the wrong store for that. Alt B is **only** about `lastCustomerMessageAt` migrating; the rest of `WhatsAppState.ctx` stays where it is today.

### Failure mode

Postgres unreachable → Prisma throws → state-builder propagates → adopter fails closed. Same posture as alt A.

The kernel's audit-postgres preflight ([`kernel-bootstrap.ts:230`](../../../apps/api/src/plugins/kernel-bootstrap.ts)) already enforces that Postgres must be up for boot to succeed, so a runtime Postgres outage is the same severity event as an audit outage — the always-on posture already covers it.

### Replay implications — **CLEAN**

The audit-postgres trail PLUS the `customers.last_customer_message_at` row IS the durable source of truth. A regulator query 90 days later:

- Audit row says: decision was REFUSE at 2026-05-24T15:00Z with basis `window_expired age=27h`.
- We can independently query the historical `conversation_messages` rows for that customer to verify the state's value at decision time.
- Replay tooling can reconstruct `WhatsAppState` for any past moment by walking `conversation_messages` history (`SELECT MAX(sentAt) FROM conversation_messages WHERE conversationId = X AND role = 'user' AND sentAt < $decisionTime`).

This makes the state-builder **fully observable in retrospect** — the value at decision time is reproducible from durable storage.

### Schema migration

A net-new nullable column. Forward migration: `ADD COLUMN last_customer_message_at TIMESTAMP NULL`. Backfill: optional one-time job that walks `conversation_messages` for each customer, sets `last_customer_message_at = MAX(sentAt) WHERE role = 'user' AND conversation.channel = 'whatsapp'`. Without backfill, the first 24h post-deploy would see many `lastCustomerMessageAt: null` reads (→ REFUSE) on dormant customers — same behaviour as alt A on a cold Redis. Backfill is recommended but not blocking.

### Trade-offs (Alt B)

**Pros:**
- Durably replayable — the projection IS auditable from Postgres alone.
- Reuses the existing kernel-gated `conversation.message.append` write path — no new write surface to govern.
- Naturally extends to non-WhatsApp channels later (we could add `lastWebMessageAt`, `lastSmsMessageAt` as siblings, or generalise to a single `Customer.lastInboundAt` keyed by channel via a JSON or sibling table).
- Single Prisma query — predictable performance characteristic with the existing `Customer` PK index.

**Cons:**
- Adds a column to a hot table (`customers`). Every inbound customer message becomes an UPDATE to that row. Write contention is low (one customer = one writer at a time per phone, debounced by 2s), but it IS an additional write per inbound message vs. alt A's INCR-equivalent Redis SET.
- Prisma round-trip on the egress hot path (~5-15ms typical, vs. alt A's <1ms Redis read). For the 9 deferred sites the egress isn't time-critical (cart-abandoned nudges, review prompts, etc. all run on minute-scale cadences), so this overhead is acceptable.
- Migration ceremony: one new column + optional backfill + Prisma client regen.

---

## Recommendation

**Alternative B (Postgres-backed materialized view).**

Rationale:

1. **Durable replayability** is the right default for any kernel-state input. The whole point of the kernel + audit-postgres always-on architecture (per CLAUDE.md rule #9) is "every decision is audited". If our state input can't be reconstructed from durable storage, we have a forensic-replay gap that doesn't match the rest of the system's posture.

2. **Cost vs. benefit:** the 9 deferred sites all run on minute-or-slower cadences (cart-abandoned tiers at 4h/22h/46h, review prompts at 30min post-delivery, proactive engagement on a 4h tick, etc.). None are hot-path sub-millisecond — a 10-15ms Prisma query is irrelevant to their latency budget. Alt A's Redis-speed advantage is buying us nothing meaningful.

3. **Write-path elegance:** the CDC `conversation.message.appended` event is already firing for every inbound message. Extending the `conversation-archiver` subscriber to also bump `customers.last_customer_message_at` is one extra UPDATE in the same handler — no new NATS subject, no new write helper, no new failure mode to reason about. The write is **already envelope-governed** via the existing `conversation.message.append` kind.

4. **Schema future-proofing:** if we later need per-customer state for SMS or email channels (when Twilio adds an equivalent window rule, or we go multi-channel), the column-on-Customer pattern extends naturally. Alt A's per-phoneHash Redis key forks per channel.

5. **Replay obligation:** the design brief explicitly calls this out as a hard concern. Alt B closes the gap cleanly; alt A leaves it as a known weakness with a "reconstruct from Postgres if needed" escape hatch — which is just doing alt B's work twice.

**Where alt A wins** (and we discount):
- Read latency. Discounted: the 9 sites have wall-time budgets in minutes, not milliseconds.
- Simpler write hook. Discounted: alt B's write hook is in the already-governed CDC consumer, which is structurally simpler than adding a new direct-write path in the webhook handler.

---

## Audit-record obligations

**Recommendation: emit on WRITE only.**

Reasoning:

- **Reads** are NOT mutating; they project state into a kernel `adjudicate()` call whose audit record ALREADY captures the state value in its basis metadata. The audit for the `whatsapp.message.send` decision will include `basis("state", BASIS_CODES.state.TRANSITION_ILLEGAL, { reason: "window_expired", ageMs: 100_000_000 })` — the state value at decision time is observable via the existing audit row. **No second audit record needed**; reads are forensically traceable through the consumer envelope's audit trail.

- **Writes** are mutating the `customers.last_customer_message_at` column. Under alt B, this write happens inside the `conversation-archiver` subscriber's `conversation.message.append` envelope dispatch — which is **already kernel-gated** and **already emits an audit record** for that envelope. The state-builder write is a *side effect* of an already-governed envelope; no NEW audit record is required, but the existing `conversation.message.append` audit record needs to be aware that its EXECUTE side effect now includes the `lastCustomerMessageAt` UPDATE. The audit basis already says "EXECUTE conversation.message.append (sessionId=X, role=user)"; the new side effect is implicitly covered.

- **No new intent kind** is needed (e.g., `whatsapp.state.touch`). Adding one would inflate the taxonomy without adding analytic value — the `conversation.message.append` audit row already carries the timestamp, sessionId, customerId, and direction needed to reproduce the state mutation.

**Visibility in metrics:** add a counter `kernel_whatsapp_state_builder_invocations_total{outcome="ok"|"null_projection"|"redis_error"|"prisma_error"}` so the operator can see how often the state-builder is consulted and what fraction return `null` (would inform a "backfill is stale" alarm). Not an audit-trail concern — a metrics-trail concern.

---

## Test fixtures + conformance

### Unit tests (per state-builder module)

- `buildWhatsAppState` returns `lastCustomerMessageAt: Date` when Postgres row has the timestamp.
- Returns `lastCustomerMessageAt: null` when the column is `NULL` (cold customer, no archived inbound).
- Propagates `Error` on Prisma failure (does NOT swallow → caller fail-closes).
- `perCustomerHandoffCount` projection from Redis (separate sub-helper).
- `recipientType` defaults correctly (`"customer"` when `staffId === null`, etc.).

### Integration tests (per deferred site — 9 cases)

For each of the 9 sites, a `*-governance.test.ts` (matching the post-Task-16 pattern at `apps/api/src/__tests__/subscribers/*-governance.test.ts`):

- Mock the inbound message at `now - 23h` → state-builder returns 23h-old timestamp → kernel EXECUTE → `twilioAdjudicated.messages.create` called.
- Mock the inbound message at `now - 25h` → state-builder returns 25h-old timestamp → kernel REFUSE (`whatsapp_window_expired`) → Twilio not called, DLQ entry created.
- Mock missing customer row / null `lastCustomerMessageAt` → kernel REFUSE (`no_prior_customer_message`).
- Mock Postgres error → state-builder throws → site catches → DLQ entry, no Twilio call.

### Conformance suite extension

`packages/pack-whatsapp/src/__tests__/conformance.test.ts` already covers 25+ Decision-shape fixtures. The state-builder doesn't change the Pack's policies, so the existing fixture set continues to apply unchanged. The state-builder gets its OWN conformance file (a new `*-conformance.test.ts` for the adopter side), parallel to the existing Pack conformance.

### Replay determinism

Per the kernel's conformance contract, replaying the same envelope + state must produce a byte-identical decision. The state-builder must therefore be **deterministic given the same Postgres row** — no `Date.now()` injection inside the builder (the `now` field comes from outside the builder, supplied per-call). Asserted in a fixture.

---

## Rollout sequencing

The state-builder can land **before any consumer site migrates**. Recommended phasing:

### Phase 1 — Land the state-builder module + schema migration (single PR)

- Add `Customer.lastCustomerMessageAt` column (Prisma migration, idempotent).
- Optional one-shot backfill job (`ibx whatsapp-state backfill` CLI command) — walks `conversation_messages` and sets the column for every customer with an existing WhatsApp inbound.
- Wire the `conversation-archiver` subscriber to UPDATE the column on every `role: "user"`, `channel: "whatsapp"` append.
- Add `buildWhatsAppState()` helper at `apps/api/src/subscribers/__shared__/whatsapp-state-builder.ts` (sibling to `system-actor-envelope.ts`).
- Add `kernel_whatsapp_state_builder_*` metrics.
- **No consumer migrations yet.** This phase is dependency-free for all 9 sites.

### Phase 2 — Migrate the 9 sites one-by-one

Order by blast radius (lowest first), each as its own PR with the matching `*-governance.test.ts`:

1. `hesitation-nudge` (always inside window — lowest risk of behaviour change).
2. `pix-expiry-monitor` (reminders/expiry — always inside window).
3. `review.prompt` subscriber (mostly inside window for fresh deliveries; edge cases at the 24h boundary).
4. `notification.send` subscriber (the core relay — biggest fan-in; biggest unlock for cart-recovery #3 and dispute alerts #1.7).
5. `cart.abandoned` tier-escalation (tier 3 will now correctly REFUSE; document that this is the intended behaviour, not a regression — tier 3 must move to `whatsapp.template.send`).
6. `reservation-reminder` (most likely outside the window → must route via `template.send`).
7. `proactive-engagement` (always outside the window → route via `template.send` exclusively).
8. `cart-recovery-messages` (helper sites; inherits #4's migration).
9. `handoff-subscriber` (the staff alert — the customer's `lastCustomerMessageAt` IS relevant here too for the customer-side handoff request rate-limit; lowest-frequency site so last).

Each migration:
- Reads the state via `buildWhatsAppState(...)`.
- Builds the envelope via `buildSystemEnvelope(...)`.
- Calls `whatsappCmdSvc.sendMessageFromEnvelope(envelope, state)` (or the corresponding `*FromEnvelope` for template/handover).
- On REFUSE, logs and pushes to DLQ (same pattern as the post-Task-16 wrapped subscribers).

### Phase 3 — Tighten the Pack policy

After all 9 sites migrate, consider:
- Tightening the `WhatsAppMessageSendPayload` schema to require a `recipientType` payload field (today it's projected via state).
- Promoting `whatsapp.template.send` to a clearer "out-of-window" routing pattern in the adopter pattern (maybe an `egressMode: "free-form" | "template"` enum on the helper).

**These are speculative — out of scope for the state-builder design itself.**

### Sequencing dependencies

- The state-builder DOES NOT block any individual site by itself; each site can migrate at its own pace once Phase 1 lands.
- The state-builder DOES NOT need to land alongside the first consumer — Phase 1 is a no-op for currently-running code (just adds a column write and a helper module).
- **Recommendation:** Phase 1 in one PR. Phases 2.x in 9 small PRs (or 2-3 batches if reviewers prefer). No big-bang.

---

## Open questions for stakeholder

1. **Join axis: `phoneHash` or `customerId`?** The Pack's `WhatsAppState.ctx.lastCustomerMessageAt` field is recipient-keyed (a Date, not a map). The adopter chooses which customer to project per-call. Under alt B we naturally key on `customerId` (the row is in `customers`). Under alt A we'd key on `phoneHash` (matches existing `wa:*` convention). **Recommended: alt B → `customerId`.** No stakeholder input needed unless they want to lean toward alt A.

2. **Backfill or no?** Alt B can ship without a backfill — every customer's `lastCustomerMessageAt` starts `NULL` and gets populated on next inbound. The 24h post-deploy will see elevated `no_prior_customer_message` REFUSEs for customers who'd normally pass. **Acceptable** because: (a) those REFUSEs preserve audit truth; (b) WhatsApp's own 24h-window enforcement would have rejected those sends anyway (we'd been seeing them silently fail). Stakeholder confirmation that "elevated REFUSE during first 24h post-deploy" is acceptable.

3. **Does the `whatsapp-webhook.ts` agent reply path migrate too?** As noted in the inventory, the agent's reply (after the customer just messaged in) is always inside the window by construction — no policy benefit from forcing it through the state-builder. But for **uniformity** (and because the existing `twilioAdjudicated` HTTP-egress wrapper is a different audit, not the business-policy audit), we might want to thread the projection through anyway. **Recommended: defer.** Stakeholder gate before doing so.

4. **`proactive-engagement` and `reservation-reminder` → template-only?** Both of these by-definition fire outside the 24h window. Per Twilio business rules, they MUST be `whatsapp.template.send` not `whatsapp.message.send`. Today they call `sendText` directly (free-form). The migration should be paired with a Twilio Content Template registration ceremony (separate ops task). Stakeholder confirmation that this is acceptable scope creep, or alternatively that the template-send path is deferred and these sites stay on the legacy direct-send until the template registration lands.

5. **`handoff-subscriber` rate-limit projection:** the Pack expects `perCustomerHandoffCount` in state. Implementing that projection (a rolling-window counter) is **out of scope of THIS state-builder design** — we treat it as a separate sub-projection. But it shares the WhatsApp-state surface. **Recommended:** the state-builder helper has a hook for the handoff-counter projection (returning `{}` initially), and a sister design doc covers the counter projection. Stakeholder OK to split.

6. **Per-staff `lastCustomerMessageAt`?** The current `WhatsAppState` field is singular — one timestamp per state. But for the `handoff-subscriber` scenario, the "customer" whose window matters is the message recipient's *customer*, not the staff. This is already correct per the Pack's design (the policy keys on whoever the recipient's customer is). **Confirmation needed:** the state-builder always projects from the customer's `lastCustomerMessageAt`, never the staff's. (The Pack's `recipientType: "staff"` field already drives the sanitization path; the `lastCustomerMessageAt` semantics are unchanged.)

7. **Audit sink coverage for the column UPDATE itself:** under alt B, the `customers.last_customer_message_at` UPDATE happens inside the already-governed `conversation.message.append` envelope. The audit record for that envelope doesn't currently call out the column UPDATE as a side effect. Stakeholder: is implicit coverage (i.e., the audit row implies the projection update via subscriber semantics) sufficient, or do we need to explicit-log the projection update? **Recommended: implicit.** The kernel adjudicates intents, not side-effect-of-intent rows.

8. **Future channel extension:** if SMS or email channels later carry a similar window rule, do we generalise `Customer.lastCustomerMessageAt` to `Customer.lastInboundAt` (per-channel via JSON or sibling table), or keep `lastCustomerMessageAt` WhatsApp-specific and add new columns later? **Recommended: keep specific now, generalise later when a 2nd channel actually needs it.** Decision deferrable.

---

## Out of scope for THIS design

- Writing the actual state-builder code (per the brief — DESIGN ONLY).
- The `whatsappCmdSvc.sendMessageFromEnvelope` service-level entry point (depends on whether we want a per-Pack command service in `apps/api/src/whatsapp/`, or whether the state-builder + envelope-builder is sufficient and the adopter calls `adjudicate()` directly). Decision-point for Phase 1 of implementation.
- The `perCustomerHandoffCount` Redis-rolling-window-counter projection — its own design doc.
- The `whatsapp.template.send` operational ceremony (Twilio Content Template registration) — separate ops task.
- The `conversation-archiver` subscriber's UPDATE on the customer column — Phase 1 implementation work.
