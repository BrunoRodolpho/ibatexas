# @adjudicate/pack-payments-pix

> PIX (Brazilian instant-payment) charge lifecycle Pack for the Adjudicate kernel.

**Status:** `0.1.0-experimental` — first published Pack on the Adjudicate platform.
The shape is stable enough to ship; expect breaking changes until Phase 3 of the
[platform roadmap](../../docs/roadmap.md) extracts `PackV1` from three independent
Pack implementations.

## Why this Pack

PIX is Brazil's near-real-time payment rail. A charge has a small but real
lifecycle:

1. **Create** the charge (generate a QR + copy-paste code; the payer scans).
2. **Confirm** when the provider's webhook reports settlement.
3. **Refund** all or part of a captured charge.

Two of those mutations (`confirm`, `refund`) must originate from a trusted
actor — the payment provider's webhook, or staff — never the customer-facing
LLM. The third (`create`) accepts LLM-proposed payloads but is gated by amount
validation, taint, and rate-limits. The DEFER outcome falls naturally on the
confirm path: the LLM may tell the user "your PIX is processing," but the
kernel parks the actual mutation envelope until the webhook lands.

That's the whole shape this Pack expresses, condensed into one PolicyBundle and
a couple of helpers.

## Install

```bash
pnpm add @adjudicate/pack-payments-pix @adjudicate/core @adjudicate/runtime
```

## Quick start

```ts
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope } from "@adjudicate/core";
import {
  pixPaymentsPack,
  PIX_CONFIRMATION_SIGNAL,
  type PixChargeState,
} from "@adjudicate/pack-payments-pix";

const envelope = buildEnvelope({
  kind: "pix.charge.confirm",
  payload: { chargeId: "ch_abc" },
  actor: { principal: "system", sessionId: "session-1" },
  taint: "TRUSTED",
});

const state: PixChargeState = {
  charge: {
    id: "ch_abc",
    status: "pending",
    amountCentavos: 4500,
    capturedAt: null,
    refundedAmountCentavos: 0,
    expiresAt: null,
  },
};

const decision = adjudicate(envelope, state, pixPaymentsPack.policyBundle);
// decision.kind === "DEFER", decision.signal === PIX_CONFIRMATION_SIGNAL
```

When the provider's webhook lands, the adopter calls
`resumeDeferredIntent` from `@adjudicate/runtime` with `signal: PIX_CONFIRMATION_SIGNAL`
to re-enter adjudication; the now-captured state proceeds to EXECUTE.

## What's in the box

| Export | What it is |
|---|---|
| `pixPaymentsPack` | Default `PackV0` composition — drop into any Adjudicate runtime. |
| `pixPaymentsPolicyBundle` | The kernel rules covering all six Decision outcomes. |
| `pixPaymentsCapabilityPlanner` | State-driven LLM tool/intent visibility. |
| `PIX_PAYMENTS_TOOLS` | Tool classification (no READ_ONLY shipped; adopters add their own). |
| `pixPaymentsTaintPolicy` | Per-intent taint floor (`pix.charge.confirm/refund` → TRUSTED). |
| `createPixPendingDeferGuard` | Composable factory — see "Reusing the DEFER guard" below. |
| `refusePixChargeNotFound` and friends | pt-BR refusal builders with stable codes. |
| `PIX_CONFIRMATION_SIGNAL`, `PIX_DEFAULT_*` | Constants the adopter needs at the runtime boundary. |

### Decision outcomes the bundle emits

| Decision | When |
|---|---|
| **EXECUTE** (via default pass-through after taint gate) | Trusted confirm on a settled charge; valid refund below the high-value threshold. |
| **REFUSE** | Invalid amount, rate-limit hit, charge-not-found, refund-exceeds-capture, refund-before-capture, replay of an already-captured charge, taint violation. |
| **ESCALATE** (`to: "human"`) | Confirm event on a charge already marked `failed` — needs manual reconciliation. |
| **REQUEST_CONFIRMATION** | Refund at or above `PIX_REFUND_CONFIRMATION_THRESHOLD_CENTAVOS` (default R$ 500). |
| **DEFER** | `pix.charge.confirm` on a still-pending charge — awaits `PIX_CONFIRMATION_SIGNAL`. |
| **REWRITE** | `expiresInSeconds` outside `(0, 24h]` is clamped to the policy max or default. |

## Reusing the DEFER guard with your own intent kind

Adopters whose LLM proposes a higher-level intent than `pix.charge.confirm` (for
example `order.confirm` with `paymentMethod: "pix"`) can compose the same
DEFER semantics into their own bundle:

```ts
import { createPixPendingDeferGuard } from "@adjudicate/pack-payments-pix";

const orderConfirmDefer = createPixPendingDeferGuard<MyState>({
  readPaymentMethod: (s) => s.payment.method,
  readPaymentStatus: (s) => s.payment.status,
  matchesIntent: (kind) => kind === "order.confirm",
});

const myBundle = {
  stateGuards: [...otherGuards, orderConfirmDefer],
  // ...
};
```

The IbateXas reference deployment uses exactly this pattern; see
`packages/llm-provider/src/order-policy-bundle.ts`.

## Provider integration

This Pack is **provider-agnostic**. It does not import any PSP SDK (Stripe,
Mercado Pago, EFI, …) and does not perform network calls. The adopter wires:

1. A handler that receives `pix.charge.create` payloads, calls the PSP, and
   persists the resulting `PixChargeRecord`.
2. A webhook subscriber that, on settlement, builds a `pix.charge.confirm`
   envelope with `taint: "TRUSTED"` and calls `resumeDeferredIntent`.
3. A handler for `pix.charge.refund` that calls the PSP and updates state.

The Pack only adjudicates whether each of those mutations is allowed.

## License

MIT — see the platform [LICENSE](../../LICENSE).
