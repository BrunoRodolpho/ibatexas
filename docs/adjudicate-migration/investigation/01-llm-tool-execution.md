# 01 — LLM Tool Execution Path

Scope: every file under `packages/llm-provider/src/` plus the API entrypoints that drive
the LLM (`apps/api/src/routes/chat.ts`, `apps/api/src/routes/whatsapp-webhook.ts`). This
investigation traces the actual runtime behaviour from "Claude emits a `tool_use`"
through to either (a) a real mutation, (b) a no-op, or (c) a refusal — and contrasts it
with the documented Zero-Trust / Intent-Gated Execution design (CLAUDE.md rule #9).

## Executive summary

- **The kernel is fully dormant.** `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` are unset in
  `.env` and `.env.example`. The responder's per-intent dispatch
  (`packages/llm-provider/src/llm-responder.ts:316-332`) falls through to
  `legacyDecisionAsKernelDecision({ kind: "EXECUTE" })` for every mutating tool the LLM
  proposes. Today nothing is adjudicated.
- **Even when the kernel says EXECUTE, the intent goes nowhere.** `runAgent` in
  `packages/llm-provider/src/agent.ts:329-338` calls `generateResponse({...})` **without
  passing `onToolIntent`**. The responder still adjudicates and replies "Solicitação
  registrada" to the LLM, but `onToolIntent?.(result.intent)` (line 365) is a no-op —
  there is no consumer wired to the framework's intent-execution path.
- **`onToolIntent` having no consumer is currently OK for cart/checkout/cancel** because
  the deterministic kernel (`executeKernel` in `kernel-executor.ts`) runs *before* the
  LLM does and performs those mutations directly from router-extracted events
  (`ADD_ITEM`, `CHECKOUT_START`, etc.). The LLM is essentially shaping language around an
  already-executed transaction. **It is NOT okay for `set_pix_details`,
  `handoff_to_human`, and `schedule_follow_up`** — these are classified MUTATING and
  visible to the LLM in some states, but their downstream effects are silently lost.
- **`capability-planner.ts` exports `orderCapabilityPlanner` but it is dead code.** The
  prompt synthesizer calls `resolveTools()` directly. The framework
  `CapabilityPlanner<S, C>` adapter is never read by anything except the package
  re-export.
- **Refusal taxonomy and validation layer are mature**, integrated, and the typed
  `ValidationOutcome` already produces real REWRITE/REFUSE audit records on the buffered
  text path (`llm-responder.ts:645-700`). This part of the system actually works.

Severity: **P0** for the dormant kernel + missing `onToolIntent` consumer
combination, because the LLM today can propose a mutating intent that produces a
plausible "registered" tool result without anything happening — that pattern is
exactly the silent-failure trap the migration is meant to prevent.

## Current flow (Claude tool_use → execution)

The flow below is what actually executes in production right now (kernel dormant).

1. **HTTP entry** — `apps/api/src/routes/chat.ts:169` or
   `apps/api/src/routes/whatsapp-webhook.ts:81 / 490` calls
   `runOrchestrator(message, history, context)`.
2. **Orchestrator** — `packages/llm-provider/src/orchestrator.ts:29-157` sets up the
   `LatencyEnvelope`, hard-deadline `AbortController`, and races
   `runAgent(...).next()` against `deadlinePromise(abort.signal)`.
3. **`runAgent`** — `packages/llm-provider/src/agent.ts:56-377`:
   1. Loads persisted XState snapshot (`loadMachineState`, line 62)
   2. Routes the message into `OrderEvent[]` (`routeMessage`, line 85)
   3. **Runs the kernel** (`executeKernel`, line 212) — this is the deterministic
      machine. It executes cart/delivery/checkout/cancel mutations *itself* via
      `machine/actions.ts` (e.g. `addItemToCart` at `kernel-executor.ts:282`,
      `processCheckout` at `kernel-executor.ts:366`, `cancelOrderAction` at
      `kernel-executor.ts:425`). These calls are NOT wrapped in IntentEnvelopes; they
      land in `@ibatexas/tools` handlers directly and write to Medusa, Stripe, Redis,
      NATS.
   4. Persists the resulting snapshot (`executeKernel` → `persistMachineState`,
      `kernel-executor.ts:484`)
   5. Phase 3 synthesizes the prompt (`synthesizePrompt`, line 310) — calls
      `resolveTools(stateValue, ctx)` from `capability-planner.ts` to compute the
      `availableTools` allowlist for this turn.
   6. Phase 4 yields from `generateResponse(...)` at `agent.ts:329` — **no
      `onToolIntent` callback is passed**.
4. **`generateResponse`** — `packages/llm-provider/src/llm-responder.ts:553-751`:
   1. Filters `TOOL_DEFINITIONS` to `synthesized.availableTools` (line 564-566) and
      builds the request.
   2. Streams from `client.messages.stream({ model, system, messages, tools, ... })`
      (line 576-584).
   3. On `stop_reason === "tool_use"` (line 724), calls `processToolCalls(...)` at
      line 728 with `opts.onToolEvent` and `opts.onToolIntent` (both forwarded as-is).
5. **`processToolCalls`** — `llm-responder.ts:209-503`:
   1. Caps at `MAX_TOOLS_PER_TURN = 5` (line 229).
   2. State-gate check (line 235): if a requested tool isn't in
      `synthesized.availableTools`, replies with an error tool_result. This is the
      hard allowlist; CapabilityPlanner runs here implicitly via `availableTools`.
   3. Calls `executeWithRetry(...)` (line 247) which delegates to `executeTool` from
      `tool-registry.ts:354`. Non-retryable tools (line 191-203) get one attempt.
6. **`executeTool`** — `tool-registry.ts:354-402`:
   1. Resolves handler from `handlers` map (line 360)
   2. Validates input against Zod schema (line 366)
   3. If `TOOL_CLASSIFICATION.READ_ONLY.has(name)` → invokes handler, returns
      `{ kind: "result", data }` (lines 372-375).
   4. Otherwise (MUTATING or unclassified) → **handler is NOT invoked**. Builds an
      `IntentEnvelope<"order.tool.propose", ToolProposePayload>` via `buildEnvelope`
      (line 385) and returns `{ kind: "intent", intent: { ... envelope } }` (lines
      393-401).
7. **Adjudicate branch** — `llm-responder.ts:251-457`:
   1. Optional ledger check (lines 256-299) — gated by `getIntentLedger()` which is
      `null` when `IBX_LEDGER_ENABLED` and `IBX_LEDGER_ENFORCE` are both unset
      (`intent-ledger.ts:94-98`).
   2. Per-intent decision (lines 311-332):
      - If `isEnforced(intentKind, env)` → call `adjudicate(envelope, orderState,
        orderPolicyBundle)`.
      - Else if `isShadowed(intentKind, env)` → call `adjudicateWithShadow(...)`,
        keep legacy `EXECUTE` as authoritative.
      - **Else** → `legacyDecisionAsKernelDecision({ kind: "EXECUTE" })`. **This is
        the production code path today.**
   3. Audit emit (lines 335-354) — fires for every adjudication, including legacy.
   4. Branch on `decision.kind`:
      - **`EXECUTE` / `REWRITE` (line 360-382)** — calls
        `onToolIntent?.(result.intent)` (line 365). **In `runAgent` this callback
        is undefined, so nothing happens.** Pushes a synthetic `intent_registered`
        tool_result back to the LLM so the conversation continues.
      - `DEFER` (lines 384-424) — parks intent in Redis at
        `defer:pending:${sessionId}` with TTL. The DEFER consumer
        (`apps/api/src/subscribers/defer-resolver.ts`) drains this later.
      - `REFUSE` / `REQUEST_CONFIRMATION` / `ESCALATE` (lines 426-457) — emits a
        refusal text tool_result; `onToolIntent` is intentionally NOT invoked.
8. **Buffered-text validation** — when `bufferMode` is true (`validation-layer.ts:77-83`,
   currently `post_order` and `reorder`), the LLM's text is collected and processed
   through `validateBufferedTextTyped(...)` at `llm-responder.ts:646`. This produces
   a real `Decision` (PASS / REWRITE / REFUSE), audits each REWRITE/REFUSE via
   `getAuditSink().emit(record)`, and only then yields `text_delta` chunks.

## Tool inventory

35 tools are registered. Classification per `TOOL_CLASSIFICATION` in
`packages/llm-provider/src/machine/types.ts:366-408`. "Adjudicated?" = whether the
current responder path *could* route the intent through `adjudicate()` (envelope is
built, but enforcement is off, and `onToolIntent` is unwired).

| Tool name | Classification | Adjudicated? | Implementation | Gap |
|---|---|---|---|---|
| `search_products` | READ_ONLY | n/a | `packages/tools/src/search/search-products.ts` | None (Typesense read) |
| `get_product_details` | READ_ONLY | n/a | `packages/tools/src/catalog/get-product-details.ts` | Publishes `product.viewed` NATS event — minor side effect, not state-mutating |
| `estimate_delivery` | READ_ONLY | n/a | `packages/tools/src/catalog/estimate-delivery.ts` | None |
| `check_inventory` | READ_ONLY | n/a | `packages/tools/src/catalog/check-inventory.ts` | None |
| `get_nutritional_info` | READ_ONLY | n/a | `packages/tools/src/catalog/get-nutritional-info.ts` | None |
| `check_table_availability` | READ_ONLY | n/a | `packages/tools/src/reservation/check-availability.ts` | None |
| `get_my_reservations` | READ_ONLY | n/a | `packages/tools/src/reservation/get-my-reservations.ts` | None |
| `get_cart` | READ_ONLY | n/a | `packages/tools/src/cart/get-cart.ts` | None |
| `get_order_history` | READ_ONLY | n/a | `packages/tools/src/cart/get-order-history.ts` | None |
| `check_order_status` | READ_ONLY | n/a | `packages/tools/src/cart/check-order-status.ts` | None |
| `get_customer_profile` | READ_ONLY | n/a | `packages/tools/src/intelligence/get-customer-profile.ts` | None |
| `get_recommendations` | READ_ONLY | n/a | `packages/tools/src/intelligence/get-recommendations.ts` | None |
| `get_also_added` | READ_ONLY | n/a | `packages/tools/src/intelligence/get-also-added.ts` | None |
| `get_ordered_together` | READ_ONLY | n/a | `packages/tools/src/intelligence/get-ordered-together.ts` | None |
| `get_loyalty_balance` | READ_ONLY | n/a | `packages/tools/src/intelligence/get-loyalty-balance.ts` | None |
| `check_payment_status` | READ_ONLY | n/a | `packages/tools/src/cart/check-payment-status.ts` | None |
| `get_or_create_cart` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/get-or-create-cart.ts` | LLM-callable path drops the intent. But the kernel calls `ensureCart()` directly (`kernel-executor.ts:282` / `agent.ts:194`) so carts still get created. |
| `add_to_cart` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/add-to-cart.ts` (Medusa POST + NATS `cart.item_added`) | Kernel calls `addItemToCart` directly from `ADD_ITEM` event in `kernel-executor.ts:282`. **The LLM is not in STATE_TOOLS for this so it shouldn't see it.** But the tool is in `TOOL_DEFINITIONS`, so a state misclassification or planner bug exposes it. |
| `update_cart` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/update-cart.ts` | Same — kernel covers the legitimate path. |
| `remove_from_cart` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/remove-from-cart.ts` | Same. |
| `apply_coupon` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/apply-coupon.ts` | No deterministic path covers this; would silently fail if LLM ever tried. |
| `create_checkout` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/create-checkout.ts` (Medusa orders + Stripe PIX + Redis pending-orders) | Kernel calls `processCheckout` from `CHECKOUT_RESULT` flow in `kernel-executor.ts:366`. |
| `cancel_order` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/cancel-order.ts` | Kernel calls `cancelOrderAction` (`kernel-executor.ts:425`) when state hits `post_order.cancelling`. |
| `amend_order` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/amend-order.ts` | Kernel state `post_order.amending` currently returns "must contact staff" (`kernel-executor.ts:438-444`) — amend is effectively disabled. |
| `reorder` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/reorder.ts` | No deterministic kernel path exists for reorder either; LLM is in `reorder` state which exposes `get_order_history` only — so it can't actually re-add items. |
| `create_reservation` | MUTATING | Envelope built, never dispatched | `packages/tools/src/reservation/create-reservation.ts` (DB insert + NATS `reservation.created`) | **No kernel coverage.** LLM is in `reservation` state which only exposes `check_table_availability` + `get_my_reservations`. So reservations cannot actually be created via the agent today. |
| `modify_reservation` | MUTATING | Envelope built, never dispatched | `packages/tools/src/reservation/modify-reservation.ts` | Same — not exposed and not deterministically covered. |
| `cancel_reservation` | MUTATING | Envelope built, never dispatched | `packages/tools/src/reservation/cancel-reservation.ts` | Same. |
| `join_waitlist` | MUTATING | Envelope built, never dispatched | `packages/tools/src/reservation/join-waitlist.ts` | Same. |
| `submit_review` | MUTATING | Envelope built, never dispatched | `packages/tools/src/intelligence/submit-review.ts` (NATS `review.submitted`) | Not in STATE_TOOLS so LLM cannot invoke it. |
| `update_preferences` | MUTATING | Envelope built, never dispatched | `packages/tools/src/intelligence/update-preferences.ts` | Not in STATE_TOOLS. |
| **`handoff_to_human`** | MUTATING | Envelope built, never dispatched | `packages/tools/src/support/handoff-to-human.ts` (NATS `support.handoff_requested`) | **LLM-callable via `support` state in `capability-planner.ts:41`. Intent dropped → handoff NEVER fires. P0.** |
| **`schedule_follow_up`** | MUTATING | Envelope built, never dispatched | `packages/tools/src/intelligence/schedule-follow-up.ts` (Redis `follow-up:scheduled`) | **LLM-callable via `objection` state in `capability-planner.ts:44`. Intent dropped → follow-up never scheduled when LLM proposes. The kernel also calls `scheduleFollowUpAction` directly at `kernel-executor.ts:462-464` for `OBJECTION subtype="thinking"`, so the deterministic path partially covers this — but other reasons (`cart_save`, `price_concern`) only flow through the LLM and never fire. P1.** |
| `regenerate_pix` | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/regenerate-pix.ts` | Not in STATE_TOOLS; kernel handles `post_order.regenerating_pix` via deterministic action at `kernel-executor.ts:449`. |
| **`set_pix_details`** | MUTATING | Envelope built, never dispatched | `packages/tools/src/cart/set-pix-details.ts` (validation-only, returns `{event: "PIX_DETAILS_COLLECTED", payload}`) | **LLM-callable in `checkout.collecting_pix_details` state. The tool returns a state-machine event the kernel needs to inject via `onToolEvent`. Because the tool is MUTATING, `executeTool` returns `{kind:"intent"}` and skips the `onToolEvent` extraction at `llm-responder.ts:467-469` (that code is in the `kind==="result"` branch only). The `PIX_DETAILS_COLLECTED` event is therefore never injected into the machine. This breaks PIX checkout for any path that depends on the LLM extracting customer details. P0.** |
| `add_order_note` | MUTATING (declared) | n/a — NOT REGISTERED | `packages/tools/src/cart/add-order-note.ts` exists | Tool is in `TOOL_CLASSIFICATION.MUTATING` (machine/types.ts:395) but NOT in `TOOL_DEFINITIONS` or `handlers` (`tool-registry.ts`). Dead declaration. |

## Bypass paths discovered

Every path below either skips the intent envelope by design (deterministic kernel) or
silently fails (intent dropped). Severity reflects production blast radius.

1. **P0 — Dormant kernel + missing intent consumer (`llm-responder.ts:316-365`, `agent.ts:329-338`).** Every LLM-proposed mutating tool builds an `IntentEnvelope`, runs through the legacy-EXECUTE branch, then evaporates because `onToolIntent` is undefined in the only call site. The LLM is told "Solicitação registrada" — false signal. Today this affects `set_pix_details`, `handoff_to_human`, `schedule_follow_up` (only ones surfaced by `STATE_TOOLS`), but the trap fires the moment any other mutating tool is exposed.
2. **P0 — `set_pix_details` event lost (`tool-registry.ts:372-401` + `llm-responder.ts:251-457`).** The tool returns a structured `{event:"PIX_DETAILS_COLLECTED"}` payload that the agent expects to inject into the machine via `onToolEvent`. But MUTATING tools never reach the `kind==="result"` branch where event extraction happens; the intent branch only emits a synthetic "intent_registered" message. PIX checkout depends on this event. Either the tool needs to be reclassified as READ_ONLY (it does no mutation, only validates), or the intent branch needs to extract events too.
3. **P0 — Deterministic kernel writes bypass `adjudicate()` entirely.** `executeKernel` calls `addItemToCart`, `processCheckout`, `cancelOrderAction`, `regeneratePixAction`, etc. directly from `machine/actions.ts` (e.g. `kernel-executor.ts:282, 366, 425, 449`). These are real mutations on Medusa / Stripe / Redis / NATS, but they are never wrapped in an envelope, never adjudicated, never audited via `@adjudicate/audit`. The `orderPolicyBundle` is therefore unenforced for the *primary* mutation path. This is by design today (the LLM is not the actor) but the migration intent is to put `adjudicate()` in front of these.
4. **P1 — `handoff_to_human` & `schedule_follow_up` silently dropped.** Same root cause as #1 — these are the two MUTATING tools in `STATE_TOOLS` that have NO deterministic kernel fallback. `support.handoff_requested` and `follow-up:scheduled` never get fired when the LLM proposes them. `schedule_follow_up` has a partial deterministic path for `OBJECTION subtype="thinking"` (`kernel-executor.ts:462`), but any other reason is lost.
5. **P2 — `executeToolDirect` ignores intent classification (`tool-registry.ts:414-431`).** This exists for "the kernel executor path" but the kernel never actually calls it; only tests do. Still, it is exported from the package index and any future caller will execute mutating tools without auditing. Should be marked `@internal` or moved into a non-exported subpath.
6. **P2 — `add_order_note` declared MUTATING but unregistered.** Dead classification; tool exists in `@ibatexas/tools` but no handler binding. Cleanup or wire up.
7. **P2 — Audit emit for legacy EXECUTE always fires (`llm-responder.ts:335-354`).** Useful, but with `decision.kind === "EXECUTE"` (legacy) and `onToolIntent` undefined, every LLM-proposed mutating tool currently emits an `EXECUTE` audit record while nothing happens. This pollutes the audit stream until either the consumer is wired or the audit is suppressed for the unconsumed-EXECUTE case.

## Capability planner status

`packages/llm-provider/src/capability-planner.ts` exports two things that matter:

- **`resolveTools(stateValue, ctx)`** — used by the prompt synthesizer
  (`prompt-synthesizer.ts:85`, imported and re-exported). This is the live capability
  gate.
- **`orderCapabilityPlanner`** — the framework-shaped adapter (`Plan` includes
  `visibleReadTools`, `allowedIntents`, `forbiddenConcepts`). Exported from
  `index.ts:78` but **never imported anywhere in the codebase**. The
  plan-then-execute contract is fully scaffolded but unused. `allowedIntentsFor`
  similarly is exported but no caller consumes it.

The only enforcement that actually happens at LLM call time is the implicit one in
`llm-responder.ts:564-566` (filter `TOOL_DEFINITIONS` to `synthesized.availableTools`)
and the state-gate at `llm-responder.ts:235-243` (reject tools not in the allowlist).
Neither uses the `Plan` shape — both work off raw string arrays from `resolveTools`.

Migration effort to make `orderCapabilityPlanner` authoritative is small: pass it
through `runAgent`/`generateResponse`, have the synthesizer call
`planner.plan(...)`, and consume `allowedIntents` in the intent dispatch branch.

## Refusal / validation status

Both are in good shape.

- `refusal-taxonomy.ts` produces typed `Refusal` objects with stable codes mapped to
  pt-BR user-facing text. `GUARD_REFUSAL_MAP` (line 149) is the authoritative
  guard→refusal lookup. Audit replays depend on the stability of `code` strings; the
  current set is consistent.
- `validation-layer.ts` exposes `validateBufferedTextTyped(text, stateValue)` which
  returns a discriminated union over `PASS | REWRITE | REFUSE`. The REWRITE producer
  is the live one — `llm-responder.ts:646-700` runs the typed validator, builds a
  synthetic `validation.text.rewrite` envelope, calls `decisionRewrite(...)`, and
  emits an `AuditRecord` to the configured sink. REFUSE goes through the same audit
  path with `decision: { kind:"REFUSE", refusal, basis }`.
- The two-phase buffered-text commit is gated by `shouldBufferText(stateValue,
  hasTools)` (line 77-83). Currently buffered states are `post_order` and `reorder`.
  All other states stream live with zero TTFB penalty and no validation.

Refusal surfacing to the user: REFUSE/REQUEST_CONFIRMATION/ESCALATE outcomes from
adjudication (lines 426-457) format a structured tool_result with status `refused` /
`confirmation_required` / `escalated`. Because nothing today enforces, this branch is
not exercised. When `IBX_KERNEL_ENFORCE` flips on, refusal text will reach the LLM
through the tool result — the LLM is then responsible for relaying it. There is no
fallback that emits the refusal text directly to the user when the LLM ignores it.

## Orchestrator entry points

Three entry points into the LLM conversation pipeline, all routed through
`runOrchestrator → runAgent → generateResponse`:

1. **Web chat** — `apps/api/src/routes/chat.ts:169` (`POST /api/chat/messages` →
   fire-and-forget agent loop, streamed via SSE on `/api/chat/stream/:sessionId`).
2. **WhatsApp webhook initial** — `apps/api/src/routes/whatsapp-webhook.ts:490`
   (Twilio webhook → debounce → agent lock → `runOrchestrator`).
3. **WhatsApp webhook retry-for-missed-messages** —
   `apps/api/src/routes/whatsapp-webhook.ts:81` (post-lock re-check when new user
   messages arrived during agent run).

All three go through the same `runOrchestrator` chokepoint. There is currently **no
admin-agent path** — `apps/admin` does not import `runAgent` / `runOrchestrator` /
`generateResponse`. There are no other `Anthropic` SDK call sites in the repo besides
`packages/llm-provider/src/llm-responder.ts:578`. The two `client.messages.create`
calls in `apps/api/src/whatsapp/client.ts:132,204` are Twilio's Messaging API, not
Anthropic.

This is a single chokepoint, which is good — once `onToolIntent` is wired and the
kernel is enforced, the migration only has one site to update for the LLM-driven
mutation path.

## Gaps and recommendations

Ordered by severity and migration effort.

1. **[P0, S] Wire `onToolIntent` through `runAgent` → `generateResponse`.** Today
   `agent.ts:329` calls `generateResponse({...})` without it. Until a consumer
   exists, every adjudicated EXECUTE result for an LLM-proposed mutating tool is a
   silent drop, and the audit stream is polluted with EXECUTE records that have no
   counterpart in the production tools layer. Minimum viable consumer is to call
   `executeToolDirect(intent.toolName, intent.input, ctx)` post-adjudication for
   intents where the kernel has no deterministic coverage (`handoff_to_human`,
   `schedule_follow_up`, `set_pix_details`). Blast radius: small (3 tools today).
2. **[P0, S] Reclassify `set_pix_details` as READ_ONLY OR extract events from
   intent branch.** The tool does no mutation — it validates and returns a
   structured event. Either move it to `TOOL_CLASSIFICATION.READ_ONLY` so the
   handler runs and `onToolEvent` extracts the event normally, or mirror the
   event-extraction logic (`llm-responder.ts:466-469`) into the intent branch
   (`llm-responder.ts:251-457`). Recommended: reclassify, because the tool's name
   implies mutation but the implementation is pure. Blast radius: PIX checkout
   path; this likely has been working only because the same details are also
   collected via deterministic routes (router fast-paths + cached PIX details). Run
   the PIX scenario tests under the new classification.
3. **[P0, M] Adopt `orderCapabilityPlanner` in the prompt synthesizer and
   responder.** Have `synthesizePrompt` build a `Plan` via
   `orderCapabilityPlanner.plan(stateValue, ctx)` and store it on
   `SynthesizedPrompt`. Have the responder consult `plan.allowedIntents` in the
   intent dispatch branch (`llm-responder.ts:251-457`). This makes the
   plan-then-execute contract authoritative and surfaces the planner as the single
   security-sensitive gate. Today the planner is dead code.
4. **[P0, L] Stage `IBX_KERNEL_SHADOW` for the read-mutation set, then financial
   intents, then PIX charges.** Followed by `IBX_KERNEL_ENFORCE` per the existing
   runbooks (`docs/ops/runbooks/01..05`). The pieces are in place — `adjudicate`,
   `adjudicateWithShadow`, the audit sink, the ledger. The blocker is that
   `onToolIntent` has no consumer (gap #1), so even shadow mode today produces no
   signal worth comparing.
5. **[P1, M] Wrap the deterministic kernel writes (`machine/actions.ts`) in
   adjudication.** Each call site in `kernel-executor.ts:282-460` constructs the
   inputs from XState context — the natural envelope to build is
   `IntentEnvelope<"order.cart.add", {...}>` etc. Migration is non-trivial because
   the existing flow assumes a synchronous side-effect; an inserted adjudicate
   gate that can REFUSE or DEFER requires the kernel to handle those outcomes
   (currently no such branch). Blast radius: every checkout that flows today.
   Stage behind shadow first.
6. **[P1, S] Restore `schedule_follow_up` for non-OBJECTION reasons.** Either the
   deterministic kernel path needs to cover `cart_save` and `price_concern`
   reasons, or the LLM path needs a real intent consumer (gap #1).
7. **[P2, S] Remove `add_order_note` from `TOOL_CLASSIFICATION.MUTATING` or
   register a handler.** Dead declaration today.
8. **[P2, S] Mark `executeToolDirect` `@internal` and remove from the public
   export.** It allows future callers to bypass the intent bridge without
   compile-time friction. Currently only tests use it.
9. **[P2, S] Suppress the legacy-EXECUTE audit record when `onToolIntent` is
   absent.** Reduces audit noise and makes shadow-mode divergence reports
   trustworthy. Alternatively: make `onToolIntent` required in
   `GenerateResponseOptions` to fail at compile time when callers forget.

---

Files cited:

- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/agent.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/orchestrator.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/tool-registry.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/capability-planner.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/refusal-taxonomy.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/validation-layer.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/order-policy-bundle.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/intent-ledger.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/intent-audit-wiring.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/kernel-executor.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/types.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/order-machine.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/actions.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/guards.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/prompt-synthesizer.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/index.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/chat.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/whatsapp-webhook.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/cart/set-pix-details.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/support/handoff-to-human.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/intelligence/schedule-follow-up.ts`
