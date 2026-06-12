# Journey Registry — `packages/journeys/journeys/*.yaml`

This directory is the **journey YAML home** (binding contract pin, D-010).
One journey per file; the loader (`loadJourneys()` from
`@ibatexas/journeys`) reads every `*.yaml`/`*.yml` here, sorted by
filename. T1a-12 authors the real files (JOURNEY-001…009); until then this
README is the only content.

## Authoring rules

1. **One journey per file**, named `JOURNEY-NNN-<kebab-slug>.yaml`
   (e.g. `JOURNEY-001-place-and-cancel.yaml`). The `id` field must match
   `JOURNEY-NNN` and be unique across the registry.
2. **Variants are `params`, never new ids.** A new id means a new business
   case, not a new parameterization.
3. **Act kinds** (sequential, executed in order):
   - `chat` — public conversational surface only. Carries the persona's
     `utterance` (scripted turn) and/or `goal` (LLM-driver target); at
     least one is required.
   - `http` — public HTTP surface only (`method`, `path`, optional `body`,
     optional `asRole: anonymous|customer|staff`).
   - `fixture` — **PRECONDITIONS ONLY** via existing seed helpers
     (`seed` + `params`). A fixture may NEVER publish NATS, mint
     SYSTEM-taint envelopes, or write state that later appears in
     `expects`/`verify` — the Phase-1b reconciliation gate enforces it.
     Registered seeds: `seedCustomer`, `resolveProductVariant` (read-only
     resolves) and `paidState` (T2-1 — drives the run's order to
     payment=paid through the REAL signature-verified Stripe webhook
     route; the SUT mints the audited system-actor
     `payment.status.reconcile` envelope, which hashes OUTSIDE the run
     namespace, so reconciliation is unaffected and the paid state is
     audited, never forged. Declare it AFTER the storefront checkout
     acts — it never creates orders).
4. **Handles only.** Reference catalog entities by handle
   (`costela-bovina-defumada`), never raw Medusa ids (`prod_…`,
   `variant_…`, `cart_…`) — those are not seed-stable and the schema lint
   (`raw_medusa_id`) rejects them anywhere in `acts`/`params`.
5. **`expects`** — audited kernel decisions as `{intentKind, decision}`;
   `intentKind` must be in `KNOWN_INTENT_KINDS` (enforced by
   `ibx journey lint`, not the schema); `decision` is one of the kernel's
   `DecisionKind` values (`EXECUTE`, `REFUSE`, `ESCALATE`,
   `REQUEST_CONFIRMATION`, `DEFER`, `REWRITE`).
6. **`verify`** — invariant id + harness-bound args; ids must resolve in
   the harness registry (lint-checked).
7. **`status: blocked`** requires a non-empty `blocked_by` list naming the
   blocking gaps; `status: active` requires it empty.
8. **`source`** — provenance: the plan/spec section that authored the
   journey.
9. User-facing text inside utterances/goals is **pt-BR** (it is shown to
   the SUT's LLM as customer input); structural fields stay English.

## Example shape (schema v1)

```yaml
id: JOURNEY-000
title: Example (never commit a real journey with this id)
businessCase: Documents the file shape for authors.
persona: Cliente autenticado que quer jantar costela no sábado.
channel: web
status: active
blocked_by: []
source: docs/agents/plan-v2.md §5 T1a-12
params:
  productHandle: costela-bovina-defumada
acts:
  - kind: fixture
    seed: seedCustomer
    params: { phone: "+5511999990001" }
  - kind: chat
    goal: Montar um pedido com uma costela bovina defumada e finalizar o pagamento.
  - kind: http
    method: GET
    path: /api/me
    asRole: customer
expects:
  - intentKind: order.checkout.create
    decision: EXECUTE
verify:
  - invariant: order.goal-state
    args: { status: pending_payment }
```
