# Turn Pipeline — perceive → plan → adjudicate → dispatch → reply

IbateXas is the **application** in a three-repo system. A customer/staff turn is
driven by the **claustrum Conductor**; every state mutation is decided by the
**`@adjudicate/*` kernel**. The LLM is a semantic parser with **zero** mutation
authority (Hard Rule #9).

```
inbound (WhatsApp webhook / web chat / commerce route)
   │
   ▼
claustrum Conductor — handleTurn(capsule, message)
   perceive → understand → plan → submit → act/dispatch → synthesize → observe
   │                              │
   │                              ▼
   │                    @adjudicate kernel — adjudicate(envelope, state, policy)
   │                      guards: state → taint → auth → business
   │                      decision: EXECUTE | REFUSE | REQUEST_CONFIRMATION | …
   │                              │
   │              EXECUTE ────────┘ runs the mutation (onExecute callback)
   │              non-EXECUTE ───── no mutation; typed IntentResult → reply
   ▼
reply (rendered per channel)
```

## The three repos

| repo | role | key surface |
|------|------|-------------|
| **adjudicate** | the **kernel** — pure, deterministic decision engine + audit | `adjudicate()` is pure; `adjudicateAndAudit()` adds the side-effecting seams (ledger dedup, MetricsSink, audit emit). Six Decision kinds; canonical `intentHash` content-addresses every envelope; taint lattice SYSTEM>TRUSTED>UNTRUSTED; PolicyBundles live in `packages/pack-*`. |
| **claustrum** | the **conductor** — orchestrates a turn | `handleTurn` (perceive→…→observe) mints a `turnId` (the correlation id); channel drivers (`@claustrum/channel-whatsapp`, `@claustrum/channel-web`); the Adjudicator port. |
| **ibatexas** | the **app** — composition root + domain | `claustrum-bootstrap.ts` wires the planner, the Postgres audit sink, the pack roster, and the MetricsSink; routes/subscribers/jobs over the domain. |

## Where a turn enters

- **WhatsApp:** `apps/api/src/routes/whatsapp-webhook.ts` — verifies the Twilio
  signature, claims idempotency, then `handleTurn` (fire-and-forget after the 200).
- **Web chat:** `apps/api/src/routes/chat.ts` — `openCapsule → handleTurn →
  closeCapsule`, streamed to the SSE consumer.
- **Commerce mutations** (cart/orders/payments/reservations/admin): the shared
  gateway `apps/api/src/routes/__shared__/customer-intent-gateway.ts` —
  `adjudicateCustomerMutation` / `adjudicateStaffMutation` /
  `adjudicateSystemMutation` build a `principal`-shaped IntentEnvelope, adjudicate
  through the kernel, and run the mutation **only on EXECUTE** (the `onExecute`
  callback).

## Principles

1. **Zero-Trust LLM** — the LLM proposes intents; the kernel decides and only an
   EXECUTE runs the mutation. Mutating authority is the kernel's, never the LLM's.
2. **Every confirmation is verified** — a reply can't claim success unless the
   mutation actually ran (EXECUTE).
3. **One audit row per adjudication** — written before the side-effect; the log
   `intentHash` joins 1:1 to its `intent_audit` row (see
   [OBSERVABILITY-DESIGN](../../../../audit-work/remediation-run/OBSERVABILITY-DESIGN.md)).
4. **Sessions are zero-trust** — signed HMAC tokens, distributed Redis locks with
   ownership-checked Lua release (`apps/api/src/streaming/execution-queue.ts`).

## Authoritative references

- Kernel semantics, Decision kinds, taint lattice, audit record → the **adjudicate** repo.
- Conductor turn lifecycle, channel drivers → the **claustrum** repo.
- Live decision/turn observability → [OBSERVABILITY-DESIGN](../../../../audit-work/remediation-run/OBSERVABILITY-DESIGN.md).
