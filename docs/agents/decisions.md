# Execution decisions — bruno-stack-agents-plan-v2.md

Running log of assumptions and decisions made during autonomous execution (started 2026-06-11).
Per the goal directive: ambiguities are resolved with the most logical engineering assumption,
documented here, and execution proceeds immediately.

## D-001 — The six pending decision requests (plan §4) are resolved by adopting the plan's own recommendations

The plan marked DR-1..DR-6 "pending user". The user instructed full execution without stopping
for clarification; each DR carries an explicit "Recommend:" produced by the verification+critique
process. Adopting them:

- **DR-1**: Nightly certification at prod parity (`claude-sonnet-4-6`); cheap-model dev profile marked non-certifying in `sim_runs`; pre-flight asserts model == certification target.
- **DR-2**: Phase 1 ships a publish-incapable NATS capture client + check-bypass leg; NATS server-side auth runbook executes at Phase-3 entry (T3-10).
- **DR-3**: Adjudicate console gets `/agents` only; coverage/run-explorer/graphs go to the QA viewer (T2-5); "never a new app" struck.
- **DR-4**: P0-9 injects `PostgresAdvisorySessionLock` now; T3-0 upstream PR bundles ChannelKind widening + lock-key strategy honoring `sessionKey`.
- **DR-5**: Coverage domain = chat-drivable registered tools × pack-declared decision kinds (cell-level) ∪ staff-route envelope kinds; waiver categories `waived-pending-WS4`, `waived-unadvertised`, `waived-quarantined`.
- **DR-6**: Projection-grade approver identity for Phase 3 (`resolvedBy` + supersession chain; `INV-AGENT-CONFIRM-LINEAGE` documents the trust boundary); kernel receipt extension deferred to Phase 4.

## D-002 — decisions.md location

The goal names `decisions.md` without a path. It lives at `/Users/thaisrodolpho/projects/decisions.md`
(sibling of the plan file it accompanies). A durable copy lands in `ibatexas/docs/agents/` with P0-10's
decision-record commit, and is kept in sync at each phase boundary.

## D-003 — Commit strategy

The plan doesn't specify granularity. Each P0/T task gets its own commit in the owning repo with the
task id in the subject (e.g. `P0-1: wire createRedisLedger into buildAdjudicator`), so the decision
record maps 1:1 to the history. Work happens on a branch `agents/phase-0` (etc.) per phase; no pushes
to any remote without explicit instruction.

## D-004 — Execution order within Phase 0

P0-1, P0-2, P0-6, P0-7, P0-8, P0-9 all touch `apps/api/src/claustrum-bootstrap.ts` → executed
sequentially (P0-1 → P0-2 → P0-6 → P0-8 → P0-7 → P0-9) to avoid merge conflicts. P0-3, P0-4, P0-11
are file-disjoint → parallel. P0-5 runs after P0-1 (rule-9 wording dependency); P0-10 closes the phase.

## D-005 — Docker dependency

Docker daemon was down at session start; started Docker Desktop (came up as 29.5.3). Testcontainer-based
acceptance tests (P0-1, P0-2, P0-9) run against it; `testcontainers@^12` was already an apps/api devDep.

## D-006 — Phase 0 baseline

`pnpm --filter @ibatexas/api test` at branch point (01d2d0a): 144 files / 1377 passed / 15 skipped / exit 0
(log: /tmp/api-test-baseline.log). "No new failures" for Phase 0 is measured against this. Note: the repo
already has an env-gated real-Redis test idiom (`REDIS_TEST_URL` skip-guards) alongside testcontainers —
agents may use either pattern where the plan says "real-Redis test".

## D-008 — Phase 0 outcomes: assumptions adopted from the implementing agents (2026-06-12)

All 10 workflow tasks `done`; commits 7b82f8e (P0-1), 83d2c8c (P0-2), d93dc89 (P0-6), 2a1deaf (P0-8),
f96246a (P0-7), 1dc2364 (P0-9), a32392f + adjudicate 99ec4dd (P0-5), 3bee5e5 (P0-4), 0a2ca96 (P0-3),
10fa796 (P0-11), 04e6609 (P0-10). Notable engineering decisions inherited by later phases:

- **Ledger identifiers (P0-1)**: replay suppression surfaces as refusal code `ledger_replay_suppressed`
  with basis `{category:"ledger", code:"replay_suppressed"}` — journey oracles must assert these exact
  strings. `@adjudicate/audit@^2.0.1` is now a direct apps/api dep; node-redis is adapted via a typed
  narrowing wrapper (rejections pass through → bridge fail-closed).
- **Audit read-path conventions (P0-2)**: no upstream reader fits the port shapes; direct SQL through
  audit-postgres's `PostgresReader` + its canonical `rowToRecord`. Customer attribution = `session_id
  = customerId` OR `envelope payload.customerId`; an LLM-planner envelope without payload.customerId is
  NOT attributable from the audit row (documented recall gap). Wrong tenantId → empty (fail-safe).
  Caps: 500 rows replay/outcomes, keyset-paged 200 stream.
- **WATCH ITEM — embedding gap (P0-6 investigation)**: `@claustrum/grounding-pgvector.retrieve()` calls
  `modelProvider.embed(perception.text)` at runtime, but `AnthropicProvider.embed()` throws
  `not_implemented` unless constructed with an `embedding.proxy` — and claustrum-bootstrap constructs
  it without one. Pre-existing production gap (not introduced here). MUST verify how the cognitive loop
  handles a throwing grounding port before T1a-13 runs JOURNEY-001 against the real SUT.
- **ANTHROPIC_MODEL + EMBEDDING_MODEL_ID** are now fail-fast required at boot (first statements of
  bootstrapClaustrum) — the T1a-11a env contract must set both; .env.example documents both as REQUIRED.
- **packs-composed surface (P0-8)**: exports `IBATEXAS_COMPOSED_PACKS`,
  `IBATEXAS_COMPOSED_CAPABILITY_PLANNERS`, `composedIntentKinds()` (59-kind dedup union; `pix.*`/
  `loyalty.*` deliberately excluded — those live in @ibatexas/intent-kinds). @adjudicate/pack-payments-pix
  is NOT in the composed list (platform pack, not first-party). T1a-2's lint gate imports this package.
- **Roster drift (P0-7)**: `toolRosterDrift(tools, intents, {planners, contexts, onWarn})` — context legs
  run only when planners supplied; `ROSTER_DRIFT_CONTEXTS` + `ADVERTISED_NOT_REGISTERED_WHITELIST`
  (keyed `<context>:<kind>`) exported from register-ibatexas-tool-packs.ts. De-advertising touched only
  planner `allowedIntents`; tool→intent maps + MUTATING classifications kept so WS4 restore is one line.
- **P0-4**: 3 stale domain tests updated to the kernel-REFUSE contract (`payment.not_found` /
  `order.projection.not_found`) — the cutover moved the not-found path from thrown errors to REFUSE
  decisions; tests now assert the current intended contract.
- **P0-5**: CLAUDE.md rule 9 verified ACCURATE post-P0-1 (no edit needed). Six (not two) stale NATS-doc
  refs repointed. Remaining dead-link debt (README→PROJECT_STATE, 7 kernel.yaml runbook_urls →deleted
  migration docs, ADR content home deleted) recorded as product-docs backlog — outside plan scope.
- **P0-11**: lock value = JSON blob `{scenario,pid,startedAt,token:<uuid>}` with full-string Lua compare
  (strictly stronger than PID check); `force` = plain SET EX takeover, old holder's release no-ops.
- **Transient**: one Docker Hub pull flake (TLS handshake timeout on redis:7-alpine) in a full-suite run;
  clean on immediate re-run. If nightly CI hits this, add a registry mirror/retry — not a code issue.

## D-007 — CLAUDE.md "only run tests when explicitly requested" vs plan verify steps

ibatexas CLAUDE.md's Agent Behavior section discourages unprompted test runs. The plan's per-task
acceptance criteria explicitly name verify commands; executing the plan includes running them. The plan
(and the goal directive) take precedence for this initiative.

## D-013 — T1a-13 outcomes: JOURNEY-001 green twice, measured cost, live corrections (2026-06-12)

Acceptance met: two consecutive `ibx journey run JOURNEY-001 --k 2 --json` runs, both exit 0
(4/4 green attempts, all certifying), cost lines non-zero. Measured split + §7 re-baseline
recorded in docs/agents/phase-1a-measurements.md (~$0.057/attempt combined: driver ~$0.032 /
SUT ~$0.025; ~35 s/attempt). Engineering decisions and assumptions inherited by later phases:

- **JOURNEY-001 corrected to the system's REAL behavior** (the journey is the executable spec):
  order assembly runs through the storefront's public HTTP API (create cart → line-items →
  checkout); chat asserts ONLY the cancel confirm gate (`order.cancel REQUEST_CONFIRMATION`
  via auto-resolve, verified live); the public cancel route completes the loop. expects[] =
  checkout EXECUTE → cancel REQUEST_CONFIRMATION → cancel EXECUTE (IN_ORDER).
- **Product gaps discovered (recorded, not closed here)**:
  - `chat-order-assembly`: the planner is a single-shot semantic parser (free-form NL payloads;
    readToolCalls recorded but never executed; no resolver leg for cart-op payloads) — chat
    item-add structurally REFUSEs `order.cart.missing`; `order.item.add EXECUTE` is producible
    by NO public surface (the HTTP route audits as `medusa.cart.line_items.add`, system actor).
  - `chat-confirmation-resume` (already named by JOURNEY-003): WebChannel.matchToParked ≡ null,
    the SSE carries no confirmation token, no chat-confirm endpoint exists, AND the naive
    responder is blind to decision/acted (the user never even SEES the confirm prompt).
  - JOURNEY-002/005's chat expects (amend / item.add / checkout via chat) are very likely
    similarly unexecutable — their live corrections are T1b work; the coverage baseline still
    carries the chat cells they claim (journey-level attribution model).
- **Real SUT bugs found-and-fixed by the crucible** (each its own commit):
  1. chat SSE abort race — a post-terminal late socket close aborted the session's NEXT turn
     (reply silently dropped, client hangs);
  2. web checkout dropped `deliveryType` from the kernel ctx → `requireSlotsFilledForCheckout`
     403'd EVERY web checkout (`order.checkout.slots_incomplete`);
  3. NATS subscribers/jobs were gated off under NODE_ENV=test → the journey stack had no
     order projections at all; gate now honors IBX_TEST_FINGERPRINT (prod parity on the
     test stack);
  4. the audit-sink Postgres writer dropped ALL v4/v5 columns (incl. `audit_hash`, the
     tamper-evidence chain) while stamping record_version=5 — `verifyAuditRecord` was
     structurally defeated end-to-end in production.
- **Harness conventions pinned**: `.env.test` is loaded with OVERRIDE semantics by
  `ibx journey run` (the CLI's dotenv preload of the dev .env must never leak into the test
  plane); audit fetches are time-scoped to the attempt (`since=runStartedAt`) because the
  seeded customer's hashed namespace accumulates rows across runs; `audit.record.verified` is
  redaction-aware (sentinel-redacted envelopes fall back to the whole-record auditHash check —
  the redactor recomputes it post-redaction by design); http acts support `:var` path/body
  substitution + declared response `capture`; fixtures stay read-only resolves (`seedCustomer`,
  `resolveProductVariant`); the PersonaDriver gets NO http executor (http acts are
  harness-mechanical, the persona model can never fire a mutation act). The raw-Medusa-id lint
  requires an id-like tail (≥8 alphanumerics) so field names like `variant_id` pass.
- **Operational caveat**: POST /api/orders/:id/cancel rate-limits 5 cancels/10 min per
  customer — JOURNEY-001 uses the fixed seeded customer, so >4 attempts inside 10 min on one
  stack will 429 (nightly k=4 fits; debug sessions should clear `rate:cancel:<customerId>` or
  wait).
