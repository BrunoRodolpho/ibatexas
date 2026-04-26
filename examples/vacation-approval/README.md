# @example/vacation-approval

Neutral hello-world for the `@adjudicate/*` framework — exercises every
`Decision` the kernel can produce in one small approvals workflow.

## What it shows

Three intent kinds (`vacation.request`, `vacation.approve`, `vacation.cancel`)
plus one `PolicyBundle` produce all six Decision outcomes:

| Outcome | Scenario |
|---|---|
| **`EXECUTE`** | Manager files a 3-day request within their PTO balance. |
| **`REFUSE`** | Request exceeds the employee's remaining PTO balance. `BUSINESS_RULE` refusal with `pto.insufficient_balance`. |
| **`ESCALATE`** | Manager attempts to approve their own request. Routed to `supervisor`. |
| **`REQUEST_CONFIRMATION`** | Cancellation submitted within 24h of the leave start. The kernel asks the user to re-confirm. |
| **`DEFER`** | Employee request parks on signal `manager.approval` (24h timeout). A manager's later approval flows through `resumeDeferredIntent` from `@adjudicate/runtime`. |
| **`REWRITE`** | Request for 30 days is clamped to the policy maximum of 14 days. Original payload is replaced with the safe variant; `BASIS_CODES.business.QUANTITY_CAPPED` is on the basis. |

Every outcome is asserted in [`tests/all-six-outcomes.test.ts`](./tests/all-six-outcomes.test.ts).

## Lifecycle

```
            user / LLM proposal
                    │
                    ▼
       ┌────────────────────────────┐
       │  CapabilityPlanner (./llm) │  hides MUTATING tools per role
       └─────────────┬──────────────┘
                     │  IntentEnvelope<VacationIntentKind, Payload>
                     ▼
       ┌────────────────────────────┐
       │  adjudicate(env, state, p) │  ./kernel
       │  state → auth → taint → biz│
       └─────────────┬──────────────┘
                     │
       ┌─────────────┴──────────────┬──────────────┐
       ▼             ▼              ▼              ▼
   EXECUTE       REFUSE        ESCALATE      REQUEST_CONFIRMATION
                                                    │
       ┌─────────────────────┬──────────────────────┘
       ▼                     ▼
     DEFER (park,        REWRITE (sanitized
     resume on signal)   envelope replaces input)
```

## Run it

```bash
pnpm --filter @example/vacation-approval test
```

Reads as the README claims it does — six tests, six outcomes, ~3ms total.

## Read it

- [`src/types.ts`](./src/types.ts) — domain shape (3 intent kinds, state, taint policy)
- [`src/policies.ts`](./src/policies.ts) — six guards, one per Decision outcome, ordered state → auth → business
- [`src/capabilities.ts`](./src/capabilities.ts) — `CapabilityPlanner` that hides MUTATING tools per role
- [`tests/all-six-outcomes.test.ts`](./tests/all-six-outcomes.test.ts) — proof the README is honest

## Imports used

```ts
import {
  buildEnvelope,
  decisionDefer, decisionEscalate, decisionRefuse,
  decisionRequestConfirmation, decisionRewrite,
  refuse, basis, BASIS_CODES,
} from "@adjudicate/core";

import {
  adjudicate,
  type Guard, type PolicyBundle,
} from "@adjudicate/core/kernel";

import {
  type CapabilityPlanner, type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm";
```

That's the whole framework surface. No runtime adapter needed for the
adjudicator alone — the runtime package is for the `DEFER` consumer
side, demonstrated separately in
[`packages/runtime/examples/clinic/`](../../packages/runtime/examples/clinic/).
