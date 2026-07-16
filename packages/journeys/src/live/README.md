# WS9 ops-plane live suite (layer 2)

The **opt-in, live-model** half of the WS9 ops verification. It turns the two
hand-driven 2026-07-04 ops-plane proofs (the `86`/restore cycle + the refund
ledger) into a committed, repeatable command that drives the **real planner**
through `POST /api/admin/ops/chat` against an **already-running** dev stack and a
**real model**, then asserts the outcome in Postgres + Redis.

> The **token-free CI half** lives at `apps/api/src/ops/__tests__/` —
> `ws9-ops-scn.e2e.test.ts` (SCN-112/113 + snapshot read, kernel-fact asserted)
> and `ops-refunds/price-confirm-resume.e2e.test.ts` (the confirm loops). Those
> use a **fake** model and run on every PR. This live suite proves that a **real**
> model actually parses the pt-BR command into the same governed intent. It is
> **never** on the CI gate (it spends tokens + mutates dev rows).

## Pieces

| File | What it is |
|------|------------|
| `staff-jwt.ts` | Pure staff-JWT claim builder + HS256 signer (the exact shape `issueStaffJwtToken` in `apps/api/src/routes/auth.ts` produces). |
| `mint-staff-jwt.ts` | CLI: mint a `staff_token` cookie for an **active** staff row. Dev-guarded (`NODE_ENV!=production`, `STAFF_JWT_SECRET`). |
| `seed-input.ts` | Pure builder for the governed refundable-order seed plan. |
| `seed-refundable-order.ts` | CLI: drive a fresh order → **paid, refundable** payment through the domain command services' `*FromEnvelope` entry points (SYSTEM-actor envelopes — **no raw money-table SQL**; a non-EXECUTE decision aborts the seed). |
| `../../../../scripts/ws9-ops-suite.sh` | The orchestrator that ties mint + seed + drive + assert into one command. |

## Run it

### 1. Bring a dev stack up with a real model

The suite **does not** boot the stack. Start it with your usual launcher (e.g.
`ibx dev`), with the api on `:3001` and `LLM_PROVIDER` pointing at a real model:

- **Local 4B** (free, slower): `LLM_PROVIDER=ollama` — the Nemotron box.
- **Frontier** (spends tokens): `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=…`.

Prove both models where a row is model-dependent (the WS9 bar).

### 2. Run the suite

```bash
# needs on PATH: curl, jq, psql, docker, node (+ the repo's tsx)
# sources WS9_ENV_FILE (default ~/projects/ibatexas/.env) for
# DATABASE_URL / STAFF_JWT_SECRET / REDIS_PASSWORD
scripts/ws9-ops-suite.sh              # run every scenario
scripts/ws9-ops-suite.sh --list       # print the scenario → tracker-row map
```

Useful knobs (all defaulted, see the script header): `IBX_API`,
`WS9_ENV_FILE`, `WS9_OWNER_PHONE`, `WS9_ATTENDANT_PHONE`, `WS9_86_PRODUCT`,
`WS9_RETRIES`, `WS9_JSON` (machine-readable summary path).

### 3. Read the result

- **FLAKE vs FAIL** — the suite drives the real planner, which can wobble. If the
  planner never emits a scenario's capability after `WS9_RETRIES` distinct
  phrasings, that scenario is a **FLAKE** (loudly marked, exit 0 — a model mood is
  not a regression). If the capability **is** emitted but the kernel decision or
  the DB/Redis state is wrong, that is an **ASSERT-FAIL** (exit 1) — a money /
  governance regression is never a "flake". This is what lets `passes_live` be
  **machine-set, not hand-claimed** without holding CI hostage to a 4B mood.
- **SKIP** — an env-dependent turn couldn't run (e.g. Medusa `:9000` down, so the
  availability egress is unreachable). Not a failure of the ops plane.

## Scenarios → tracker rows

`scripts/ws9-ops-suite.sh --list` prints the authoritative map. In brief:

| Scenario | Proves |
|----------|--------|
| `OPS-86` | SCN-112 (86 an item) + SCN-113 (restore): `product.availability.set` EXECUTE + medusa egress, then revert. |
| `OPS-ROLE` | SCN-125: an ATTENDANT staff command → REFUSE `staff_role_violation` (kernel AUTH), zero egress. |
| `OPS-REFUND-PARK` | SCN-120 / OPS-009: refund → REQUEST_CONFIRMATION + DB-stamped park, then "não" clears it (nothing written). |
| `OPS-REFUND-CONFIRM` | SCN-120 / OPS-009: a **partial** refund → park → "sim" → EXECUTE, `refunded_amount` written, `paid→partially_refunded` status-history row. (A partial refund keeps the payment `partially_refunded`, so the payment-lifecycle subscriber logs only — it does **not** exercise OPS-054; see the full-refund row below.) |
| `OPS-REFUND-FULL-CANCEL` | SCN-120 / OPS-009 / **OPS-054** (BKL-132): a **full** refund → "sim" → EXECUTE, payment `paid→refunded`, `payment.status_changed(refunded)` → the payment-lifecycle subscriber AUTO-CANCELs the still-pending order (`order.status.transition` EXECUTE, order `fulfillment_status=canceled`, `pending→canceled` history). Closes the OPS-054 suite blind spot the partial-refund `CONFIRM` scenario left open. |
| `OPS-REFUND-ESCALATE` | SCN-120 (≥R$1000 band): refund > R$1000 → ESCALATE, nothing parked/written. |
| `OPS-PARTIAL` | BKL-094: "reembolsa 10 reais" threads to R$ 10,00 (not the full balance) and "sim" writes exactly 1000 centavos. |
