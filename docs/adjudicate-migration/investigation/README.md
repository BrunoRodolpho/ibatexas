# `investigation/` — Phase-1 pre-cutover investigation (2026-05-22)

## What's in this directory

Eight specialised investigation reports produced during the Phase-1
discovery pass that preceded the MASTER_PLAN. Each report mapped one
surface of the codebase (LLM tool execution, HTTP/webhook mutations,
DB/commerce writes, NATS/background jobs, adjudicate-platform capability
inventory, runtime-config/governance plumbing, test/observability gaps,
trust boundaries) against the IBX-IGE v2.0 design intent at the time
("LLM is a semantic parser with zero state-mutation authority").

The investigation discovered the gap that drove the entire migration:
the kernel was wired but dormant (env-var-gated), `onToolIntent` was
unwired, `defer-resolver` was never started, and ~150+ mutation
entrypoints bypassed `adjudicate()`. Findings here informed the
`MASTER_PLAN.md`, governance/, and the subsequent audit + remediation
arcs.

All findings have either been worked through (Waves 1-9 + cutover) or
have evolved into governance/ artifacts. The constitutional rule is now
`CLAUDE.md` rule #9 (IBX-IGE v3.0); the env-var gating described
throughout these files no longer exists.

## Classification

| File | Classification | One-line summary |
|---|---|---|
| `01-llm-tool-execution.md` | Historical preserved | Mapped the LLM responder path. Surfaced the "kernel is dormant, `onToolIntent` unwired" finding that catalysed M0-M2. |
| `02-api-webhook-mutations.md` | Historical preserved | 0/17 customer routes + 0/27 admin routes adjudicated; Stripe webhook unadjudicated; `defer-resolver` never started. |
| `03-db-commerce-mutations.md` | Historical preserved | ~50 production Prisma writes, 88 including seeds/CLI. Mapped the mutation graph. |
| `04-background-jobs-nats.md` | Historical preserved | NATS/BullMQ inventory: 25 handlers, 11 workers, 7 Medusa subscribers. None adjudicated at investigation time. |
| `05-adjudicate-capabilities.md` | Historical preserved | Capability inventory of `@adjudicate/*` v1.0-rc; 13 packages + ~130 named exports unused by ibatexas at the time. |
| `06-runtime-config-governance.md` | Historical preserved | "Kernel dormant by accident not design" finding; env-var gates `IBX_KERNEL_SHADOW`/`IBX_KERNEL_ENFORCE` no longer exist (cutover deleted them). |
| `07-testing-observability.md` | Historical preserved | "Only 2 unit-shaped tests directly touch the kernel" finding. Drove Wave-6 test work + audit-2026-05-23 redo. |
| `08-security-trust-boundaries.md` | Historical preserved | Trust-boundary inventory; informed `../governance/03-trust-boundary-model.md`. |

## Current-state pointers

- **Closeout status (authoritative as of 2026-05-24):** [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md)
- **Constitutional rule:** `CLAUDE.md` rule #9 — "LLM Authority — IBX Intent-Gated Execution v3.0"
- **Always-on cutover commit:** `f3bea43` (deleted env-var gating these files assume)
- **Successor design docs:** [`../governance/`](../governance/) (load-bearing constitutional artifacts)
- **Successor threat model:** [`../threat-model/THREAT-MODEL.md`](../threat-model/THREAT-MODEL.md)
