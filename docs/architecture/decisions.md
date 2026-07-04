# Architecture Decisions — index

> **This file is an INDEX, not a monolith.** The old single `decisions.md` ADR log
> was retired (D-008); architecture decisions now live as focused **topic docs**
> (see the convention at the bottom). This page maps the ADR numbers still cited
> across the codebase to where their authoritative rationale now lives, and lists
> the standing contract docs. It exists so those references resolve to a real
> starting point instead of a dangling link (BKL-076).

## Numbered ADRs (cited from code, CLAUDE.md, and docs)

The distilled, load-bearing rationale for these decisions lives in the files
below. `CLAUDE.md` rule #9 is the canonical distillation of the execution model;
the topic docs carry the detail.

| ADR | Decision | Authoritative rationale now lives in |
|-----|----------|--------------------------------------|
| **#9** | **Intent-Gated Execution** — the LLM is a semantic parser with zero state-mutation authority; every mutating tool call is captured as an `IntentEnvelope` and adjudicated by the always-on kernel (`adjudicate()` from `@adjudicate/core/kernel`); every decision is audited. | [`CLAUDE.md` rule #9](../../CLAUDE.md) · [`design/agent-tools.md`](design/agent-tools.md) · [`README.md` §Kernel](README.md) · [`ops/runbooks/kernel-operations.md`](../ops/runbooks/kernel-operations.md) |
| **#13** | **PIX charge lifecycle Pack** — the PIX charge/confirm/expiry lifecycle lives in the lighthouse Pack `@adjudicate/pack-payments-pix`; new PIX-pending consumers import its constants + the `createPixPendingDeferGuard` factory rather than re-declaring them. | [`@adjudicate/pack-payments-pix` README](https://github.com/BrunoRodolpho/adjudicate/blob/main/packages/pack-payments-pix/README.md) · [`CLAUDE.md` rule #9](../../CLAUDE.md) |
| **#14** | **Provisioning topology** — `ibx bootstrap` provisions every schema layer (Medusa, domain/Prisma, kernel audit-postgres, and the claustrum memory + grounding/pgvector schema); `ibx db provision` re-applies the kernel + claustrum layers idempotently. | [`ops/runbooks/kernel-operations.md`](../ops/runbooks/kernel-operations.md) · [`CLAUDE.md` rule #9 (setup)](../../CLAUDE.md) |

> Older numbered ADRs (#1–#8, #10–#12) were part of the retired monolith and are
> not independently cited by the current code or docs. If you need one, recover it
> from git history (`git log --diff-filter=D -- docs/architecture/decisions.md`)
> and, if it is still load-bearing, promote it to a topic doc per the convention
> below.

## Standing contract / topic docs

Decisions that carry an ongoing invariant live as their own file so they can be
maintained (and drift-guarded by tests) next to the code they govern:

- [`defer-resume-role-contract.md`](defer-resume-role-contract.md) — the WS7
  DEFER-resume × staff-role contract (BKL-069, Option 1: resume stays
  system-elevated / role-free at the kernel; role authority is re-established
  adopter-side). Pinned by `apps/api/src/__tests__/defer-resume-staff-role-contract.test.ts`.
- [`ops-actor-surface.md`](ops-actor-surface.md) — the NEW-032 ops-actor surface
  (the LLM ops surface IS the claustrum Conductor; `createIbatexasPlanner` gains a
  composition-time `staffEnvelopeActor` that stamps `admin:`+role envelopes, arming
  the dormant staff-role guards on the LLM path; the customer plane stays byte-
  identical with the seam absent). Slice A (the envelope-actor stamping seam) is
  pinned by the staff-actor stamping tests in `apps/api/src/__tests__/ibatexas-planner.test.ts`.
- [`design/bounded-contexts.md`](design/bounded-contexts.md) — bounded contexts +
  entity ownership.
- [`design/domain-model.md`](design/domain-model.md) — Prisma schema, entities,
  NATS events.
- [`design/agent-tools.md`](design/agent-tools.md) — the 18 LLM-callable tools,
  auth level, inputs/outputs (realizes ADR #9 at the tool layer).
- [`design/order-billing-decision-matrix.md`](design/order-billing-decision-matrix.md) —
  order/billing state decisions.

The **claims-runtime** decisions (claims-not-prose topology, the SDD invariants)
are governed by [`CLAUDE.SDD.md`](../../CLAUDE.SDD.md) — the compilation authority
for that subsystem.

## Convention — where a NEW architecture decision goes

1. **A decision with an ongoing invariant** (a contract other code/tests must
   uphold) → a **topic doc** under `docs/architecture/` (e.g.
   `defer-resume-role-contract.md`), and add a row to **Standing contract docs**
   above. Back it with a drift-guard test where feasible.
2. **A decision that is a one-time rationale** (why we chose X over Y, no ongoing
   invariant) → record it inline in the closest doc (or `docs/agents/decisions.md`
   for agent-workflow choices) and, if it earns an ADR number cited from code,
   add a row to **Numbered ADRs** above pointing at that home.
3. **Never** re-create a single growing `decisions.md` monolith — that is the
   D-008 anti-pattern this index replaced. This file stays an INDEX.
