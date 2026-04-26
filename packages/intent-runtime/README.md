# @adjudicate/intent-runtime

Runtime + IbateXas adapter for IBX Intent-Gated Execution. `apps/api` depends
only on this package.

## Public surface

```ts
import {
  runOrchestrator,         // the stable contract apps/api consumes
  createDefaultContext,    // factory for the initial OrderContext
  isCheckoutState,
  orderPolicyBundle,       // PolicyBundle for the IbateXas order domain
  orderTaintPolicy,
  deferOnPendingPix,
  PIX_CONFIRMATION_SIGNAL,
  PIX_DEFER_TIMEOUT_MS,
} from "@adjudicate/intent-runtime";
```

Subpath exports organize the package for the v2.0 split:

| Subpath | v1.0 | v2.0 target |
|---|---|---|
| `@adjudicate/intent-runtime/engine` | `runOrchestrator`, `executeKernel` | stays here |
| `@adjudicate/intent-runtime/adapters/xstate` | XState binding | extracts to `@adjudicate/intent-runtime-xstate` |
| `@adjudicate/intent-runtime/policies/order` | IbateXas PolicyBundle | extracts to `@adjudicate/intent-domain-order` |

Adopter imports should use these subpaths — when the split lands, they are a
rename, not a redesign.

## Connecting a DEFER producer (PIX webhook example)

`DEFER` is the "valid but awaits an external signal" Decision kind. The
bundled `deferOnPendingPix` guard returns DEFER for `order.confirm` intents
whose `paymentMethod === "pix"` and `paymentStatus !== "confirmed"`.

To resolve a deferred intent in production:

1. Parse the incoming PIX webhook (Stripe / Mercado Pago).
2. Publish a NATS event on the subject `PIX_CONFIRMATION_SIGNAL` with
   `{ sessionId, orderId }`.
3. A subscriber at `apps/api/src/subscribers/payment-lifecycle.ts` listens
   for the signal, marks `paymentStatus = "confirmed"` in the machine
   snapshot, and triggers the parked intent through `runOrchestrator`.
4. The kernel re-adjudicates, finds `paymentStatus === "confirmed"`, and
   returns EXECUTE on the same intentHash — the Execution Ledger prevents a
   double submit.

Timeout: `PIX_DEFER_TIMEOUT_MS` defaults to 15 minutes.

## Building a second domain (clinic / salon / mechanic)

See [`examples/clinic/`](./examples/clinic/) for a minimal
second-domain scaffold against `@adjudicate/intent-kernel` — 3 tools, 4 state
transitions, 1 PolicyBundle.

The framework pieces you reuse unchanged:
- `@adjudicate/intent-core` — envelope, decision, taint, refusal, basis
- `@adjudicate/intent-kernel` — `adjudicate`, `PolicyBundle`, combinators
- `@adjudicate/intent-audit` — ledger, sinks, replay
- `@adjudicate/intent-llm` — `CapabilityPlanner`, `PromptRenderer`, `ToolClassification`

The pieces you write per domain:
- Domain types (`Appointment`, `Slot`, `Service`, …)
- Domain PolicyBundle (guards for your state machine)
- Domain `CapabilityPlanner` (which tools visible in which state)
- Domain `PromptRenderer` (your voice, your locale)
