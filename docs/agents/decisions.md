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

> **The second sentence is SUPERSEDED as of M0 (2026-08-04).** The `REDIS_TEST_URL` idiom is the
> silent-skip class: `REDIS_TEST_URL` is unset in CI, so those `describe.skipIf` blocks skipped and the
> files still printed a ✓ — measured on dev @ `2f5c4979`, five files, twelve real-Redis cases, green.
> All five are on `setupRedisTestContainer` now and the env var appears nowhere in the test tree. Use the
> shared harness; the only real-Redis knob is `IBX_SKIP_REAL_REDIS=1` (local dev). New real-Redis suites
> must be added to the roll call in `scripts/check-real-redis-suites.mjs` — the gate fails on any
> un-enumerated one. See `docs/architecture/redis-lua-testing-decision.md` (Q1).

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
  `IBATEXAS_COMPOSED_CAPABILITY_PLANNERS`, `composedIntentKinds()` (62-kind dedup union; `pix.*`/
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

## D-009 — Fail-safe grounding wrapper (pre-Phase-1a SUT fix, commit 1c6e784)

The P0-6 watch item proved out: `handleTurn` awaits `grounding.retrieve()` with no catch;
`createPgVectorGroundingProvider.retrieve()` embeds on every call; `AnthropicProvider.embed()` throws
`not_implemented` with no embedding proxy configured → **every Conductor turn rejected before the
planner ran**. JOURNEY-001 (and all of T1a-13) was structurally impossible. Fix: `failSafeGrounding()`
wrapper in the bootstrap — retrieve degrades to empty docs (recall-path philosophy, mirrors P0-2);
attestGrounding degrades to zero proofs (kernel refuses grounding-required envelopes — fail-closed on
the money path). The underlying product gap — no embedding vendor wired, pgvector grounding inert at
runtime — needs a vendor decision (user's call) and is NOT made here. EMBEDDING_MODEL_ID stays
boot-required per P0-6.

## D-010 — Phase 1a naming/contract pins (set once, used by multiple tasks)

- Test fingerprint env var: **`IBX_TEST_FINGERPRINT`** (set only by the test profile env); `/health`
  exposes it as `testFingerprint`; the JWT-minting helper refuses to run without it (T1a-4/10/11a).
- Certification model target: **`claude-sonnet-4-6`** (DR-1); harness pre-flight asserts
  `ANTHROPIC_MODEL` equals it.
- Journey YAML home: `packages/journeys/journeys/*.yaml`; governance files at
  `packages/journeys/governance/`.
- Dependency direction (enforced by check-bypass legs 6/7): journeys→tools, cli→journeys, cli→tools;
  never journeys→cli, never journeys→apps/api. If the harness needs `infraEndpoints()` (today in
  packages/cli/src/services.ts), the address-resolution slice moves to @ibatexas/tools (the same move
  the events emitter makes), with cli re-exporting.

## D-011 — Phase 1a interruption + resume (2026-06-12)

The Phase 1a workflow hit the account session limit mid-run (~01:30 CDT): T1a-1/2/6/9/11a/11b committed;
T1a-3/12/10/7/4/5/8 died with partial uncommitted work in the tree. Resumed at 07:36 CDT from the
workflow journal (completed tasks cached); re-run agents instructed by their standing prompts to read
current file state and adapt, so partial work is absorbed rather than discarded.

## D-012 — Fail-safe memory wrapper (T1a-5 live-test discovery, commit d303b2e, 2026-06-12)

The first REAL chat turn ever driven against the SUT (T1a-5's live contract test) failed with
"Erro interno." on EVERY turn: `handleTurn` awaits `memory.recall()` with no catch (same UNDERSTAND
Promise.all as D-009), and `createPostgresMemoryProvider`'s cold path reads
`prisma.claustrum_memory_*.findMany` — but the injected `@ibatexas/domain` PrismaClient declares NO
claustrum_memory models, so the delegate is `undefined` (TypeError on every cache-cold turn). The SQL
tables exist (`ibx claustrum migrate`); the gap is the Prisma CLIENT surface. Fix mirrors D-009:
`failSafeMemory()` wrapper in the bootstrap — recall degrades to an empty snapshot, search/recentActions
to empty lists, observe to a logged no-op; turns run memory-less, mutations stay kernel-guarded. The
underlying product gap (domain schema lacks the models the installed @claustrum/memory-postgres adapter
consumes — long-term memory is inert at runtime) needs a schema decision (user's call) and is NOT made
here. T1a-5's authenticated-conversation assertion choice is also recorded in the live test header:
smalltalk turns dispatch no envelope, so the test uses a proposing utterance (authenticated cart add)
and asserts BOTH the intent_audit row AND the sessionId↔customerId binding via the SUT-minted
`sessionToken` (signed chat-session-store claim). **Binding live finding for T1a-13/T1b-1 scoping**:
the audit sink's redactor HASHES `actor.sessionId` before the row lands —
`intent_audit.session_id = "hashed:" + sha256(chatSessionId + AUDIT_REDACT_SECRET).hex.slice(0,8)`
(audit-redactor.ts:847/:1106; intent-audit-wiring.ts:210) — so the run's chat-act audit namespace is
the HASHED conversationId, never the raw one (and NOT customerId; payload.customerId absent in the
live row — the D-008 recall gap confirmed). The customerId binding lives in the sessionToken claim.

## D-014 — T1a-13 closure: Phase 1a exit criterion VERIFIED (2026-06-12)

JOURNEY-001 green twice via `ibx journey run JOURNEY-001 --k 2 --json` — agent's two acceptance runs
PLUS a fresh main-session verification run (exit 0, 2/2 PASS, $0.1150 total; lint + coverage gates
exit 0). Measured §7 re-baseline (docs/agents/phase-1a-measurements.md): ~$0.057/attempt combined
(driver ~$0.032, SUT ~$0.025, 3 turns); per-SUT-turn ≈ $0.008 → 8-turn journey ≈ $0.07 (inside the
plan's $0.08–0.15 band); $0.50 ceiling kept (9× headroom); nightly ≈ $1.3 for 22 attempts.

**JOURNEY-001 corrected to what the system actually does** (executable-spec principle): order assembly
via storefront HTTP API (chat planner emits free-form NL payloads, readToolCalls never executed, no
resolver leg for cart ops — chat item-add structurally REFUSEs `order.cart.missing`; `order.item.add
EXECUTE` is producible by NO public surface); cancel leg = chat asserts the confirm gate
(REQUEST_CONFIRMATION via auto-resolve, works live) + documented `POST /api/orders/:orderId/cancel`
completes EXECUTE (WebChannel.matchToParked ≡ null; SSE carries no confirm token; no chat-confirm
endpoint; responder never surfaces the confirm prompt).

**Four real SUT bugs found+fixed by the crucible**: (1) chat SSE abort race — late socket close
aborted the session's NEXT turn (silent reply drops in prod); (2) web checkout 403 for everyone —
route dropped `deliveryType` from kernel ctx; (3) test stack had no projections — subscribers gated
off under NODE_ENV=test, now keyed to IBX_TEST_FINGERPRINT prod-parity; (4) audit-sink Postgres writer
dropped all v4/v5 columns incl. `audit_hash` while stamping v5 — tamper-evidence was defeated in
production; writer now persists all 25 columns.

**New product gaps recorded**: `chat-order-assembly` (planner payload synthesis + read-tool execution
missing); `chat-confirmation-resume` extended with responder blindness (users never see confirm
prompts/tool results); JOURNEY-002/005 chat expects likely unexecutable the same way (correct in
Phase 1b); order-cancel route rate limit (5/10min/customer) caps same-stack JOURNEY-001 attempts at 4
per window.

## D-017 — Phase 3 execution pins (set before launch)

- **Upstream consumption without npm publish**: T3-0's claustrum changes (ChannelKind widening +
  sessionKey lock-key strategy) cannot be published from this session. Strategy: build claustrum
  locally, `pnpm pack` tarballs into `ibatexas/local-tarballs/`, pin the affected `@claustrum/*` deps
  to `file:` tarballs on agents/phase-3 (in-repo precedent: the pnpm store shows prior
  `file+..+local-tarballs+claustrum-core` pins). Real publish + registry pin bump is a push/release
  item for the user (recorded in phase-1b-pending-push.md).
- **Stage-0 soak is calendar-gated**: the plan requires ≥1 week journaled Stage-0 shadow before
  Stage 1. Build + activate + validate the mechanics now (multiple trigger cycles live); the 7-day
  soak clock starts at activation and the Stage-1 flip is gated on it — recorded with the activation
  date, not faked.
- **Agent sessionId**: `agent:<id>@<ver>:entity:<entityId>` with the `agent:` prefix written UNHASHED
  to intent_audit (redactor change scoped to Phase 3; T1b-3/T2-4 filters already expect it).

## D-016 — Phase 2 outcomes (2026-06-12, all 9 tasks done; exit criterion verified fresh)

Commits 3d48baa (T2-1), dac0260 (T2-2a), ef447ee (T2-2b), 8471bf2+a0fb5fb (T2-4), c24e1cd (T2-3),
f2ac544 (T2-6a), 25a69a0 (T2-6b), c57aeca (T2-7), 94f3d1a (T2-5). Verified: graph --check, lint,
coverage, QA viewer build+test, scripted-pipeline suite, full pnpm test — all exit 0.

- **SEVENTH SUT bug class (T2-1, `medusa-v2-capture-payment`)**: the webhook paid path was structurally
  dead — POST /admin/orders/:id/capture-payment is a removed Medusa-v1 endpoint (404 on every call)
  while medusaAdjudicated audited kernel EXECUTE, and the throw killed the BullMQ job behind its
  already-claimed 7-day idempotency key → **PAID status permanently lost in production**. Fixes (flag
  for user review — production money-path behavior changes): dead mutate removed (gap-named log; v2
  metadata stamp kept; full port to /admin/payments/:id/capture is named backlog); capture-leg failures
  now isolated (reconciliation always proceeds — payment truth lands even when Medusa bookkeeping
  fails); reconcile PI-lookup gained an orderId fallback (adopts the order's single ACTIVE payment via
  the SUT's own metadata.medusaOrderId stamp; never adopts a payment carrying a different PI). Worker
  gate re-keyed to prod-parity (NODE_ENV test gating stranded jobs — same class as D-014 item 3).
  Recorded gap **CLOSED (BKL-230)**: the webhook PIX leg passed FORMATTED IBX-#### ids (vs cash flow's
  raw ids). It was not cosmetic — `capturePayment`'s `GET /admin/orders/IBX-0230` 404'd, the throw hit
  the capture-leg isolation catch above, `result` stayed null and the "already processed" early return
  fired BEFORE the `order.placed` publish, so PIX orders were completed but never announced (cash was,
  keeping `rawOrderId` for NATS and formatting only the user-facing string). The leg now returns
  `completion.order?.id` and the raw id flows to `capturePayment`, the `metadata.medusaOrderId` stamped
  back onto the PaymentIntent (which later webhook legs read), the reconcile fallback lookup, the
  `order.placed` payload and `markPixPaid`; nothing on this leg is user-facing, so `formatOrderId` is
  gone from the route entirely. Pinned by the BKL-230 suite in `stripe-webhook-route.test.ts`, whose
  id-strict `capturePayment` test reproduces the 404 → swallow → no-publish chain (the older PIX suites
  stubbed `capturePayment` to `null`, which masked it).
- **EIGHTH SUT bug class — chat-plane PIX checkout, CLOSED (BKL-230)**: `createCheckout`'s PIX branch
  (create-checkout.ts:598-605) requires `extra.customerName || extra.customerEmail` because Stripe's PIX
  confirm needs a payer, and the conversational tool-pack executor passed no third argument at all — so
  every chat/WhatsApp PIX checkout was structurally unsatisfiable ("Nome e email são obrigatórios para
  pagamento PIX.", no QR, no `metadata.cartId`, hence no `payment_intent.succeeded` and no order), while
  the HTTP route was unaffected because it resolves its own `pixExtra` and calls `createCheckout`
  directly. The identity is now wired server-side in the executor from the session's authenticated
  customerId — precedence per field: explicit saved PIX details (`customer:pix:<customerId>`, incl.
  taxId) over the `Customer.name/email/cpf` profile fallback — leaving the PII posture untouched: name/
  email/CPF are still never on the model wire (`order-checkout-create.schema.ts` declares no
  `pixDetails`, and the payload's is ignored on this plane), a guest still gets the existing honest
  failure, and identity is resolved only from the session so no argument can select another customer's.
- **Journeys 010–016 all ACTIVE and live-verified** (010 reservation lifecycle w/ staff-HTTP checkin/
  complete cells — no waiver, per DR-5; 011 reorder-from-history; 012 LGPD export+erasure; 013
  order-note + review-unadvertised negative; 014 executable PIX slice; 015 paid-state flow via the
  signed-webhook fixture — added to nightly money flows; 016 large-ticket confirm + escalated cancel).
  Registry: 16 authored / 10 active / 6 blocked-with-gap-ids. Plan's "≥14 active" not met numerically
  (D-015 deviation stands): every EXECUTABLE story is active; the gap list is the product backlog.
- **Paid semantics on the test plane**: cash checkout is the only executable storefront money path;
  fixture drives cash_pending→paid (kernel-legal); paid journeys assert the PAYMENT plane (order
  auto-confirm deliberately skips cash). firePaidStateWebhook is fingerprint-gated (trust-anchor
  containment); STRIPE_WEBHOOK_SECRET is per-machine generated, now load-bearing.
- **Graph contract**: one nodes/edges JSON schema across capability/journey/run/impact graphs
  (committed under packages/journeys/graphs/ + README); `ibx graph export --check` is the drift gate;
  impact generator excludes `agent:` namespaces (T1b-3 filter parity).
- **T2-6a/b**: bootstrapClaustrum(options) DI + resetClaustrumForTests (fingerprint-gated);
  content-keyed scripted ModelProvider (complete+stream+embed, loud unknown-key errors); golden
  fixtures exercise the REAL planner pipeline at zero tokens on PRs.
- **T2-7**: e2e web overlay (first time web boots in the test profile) + e2e-smoke.yml; push-dependent
  items extended in phase-1b-pending-push.md.

## D-015 — Phase 1b outcomes (2026-06-12, all 9 tasks done; exit criterion local parts verified)

Commits e16f86f (T1b-1), 54fc64c (T1b-8), 666d80e (T1b-3), d2127c6 (T1b-2), b5630be (T1b-7),
4cb1afb (T1b-5), ac4c76f (T1b-0), a301418 (T1b-4); adjudicate 22d1de5 (T1b-6). Binding outcomes:

- **Reconciliation gate (T1b-1)**: tuple-level (kind+decision) matching; supersession chains resolved
  default-on; `optional: true` expects[] flag for in-namespace extras (claims no coverage cells);
  `gate.reconciliation` is harness-mandatory, not journey-declarable. KEY STRUCTURAL FACT: system-actor
  envelopes (`sessionId = sourceSubject:eventId`) hash outside any run namespace — never need
  allowances; JOURNEY-001's real extras are the cancel route's inner order.status.transition +
  payment.status.transition (user-principal, sessionId=customerId).
- **Suite runner + dollar abort (T1b-8)**: `ibx journey run --suite [--only] [--k] [--k-money
  --money-flows id,..] [--budget-usd]`; cap flag>env(IBX_NIGHTLY_BUDGET_USD)>default-50; abort = RED,
  remainder `aborted-by-budget`; budget applies to --k loops too.
- **Replay gate (T1b-3)**: exit 0/1/2; `--ci` hard-fails on unset flag/empty window; agent-namespace
  exclusion pinned to UNHASHED `agent:` sessionId prefix (Phase-3 composition must write it unhashed —
  redactor change scoped there).
- **SIXTH-class SUT finding (T1b-0)**: order-amend is dead against Medusa v2 — add/remove/update_qty
  hit removed v1 order-edit endpoints (404) while the HTTP route returns 200 and the kernel audits
  EXECUTE for mutations that never happened (decision-vs-execution divergence, tamper-evident audit
  attests to phantom mutations). JOURNEY-002 re-blocked (`medusa-v2-order-edit`); unblock = port
  amendOrder/cancelItem to /admin/order-edits. Active journeys now: 001, 005, 009.
- **Nightly (T1b-4)**: journeys-nightly.yml authored; local rehearsal green — suite 3 journeys
  (001 k=4 certifying, all 4 cancels inside one rate-limit window), $0.2806 vs $50 cap; nightly mode
  is the ONLY path that mutates the flake ledger; measured nightly ≈$0.28 (vs §7's ≈$1.3 estimate).
- **Push-dependent items** (docs/agents/phase-1b-pending-push.md): 3-consecutive-nights-green
  criterion, kernel-replay-gate as branch-protection required check, journeys-nightly environment +
  spend-capped ANTHROPIC_API_KEY secret. These CANNOT be verified without the user pushing.
- **Phase 2 exit-criterion deviation flagged**: plan says "≥14 active journeys"; 6 of 9 authored
  journeys are blocked on real product gaps (the plan's own blocked-journeys-are-backlog principle
  forbids fabricating green specs). Phase 2 targets every EXECUTABLE journey active + gaps documented;
  the numeric target is met only if the gaps' surfaces allow it. Recorded here rather than silently
  missed.

## D-013 — Phase 1a outcomes (2026-06-12, all 12 workflow tasks done; T1a-13 in flight)

- **Journeys authored (T1a-12)**: 9 files; 4 active (001 authed place+cancel, 002 amend, 005
  delivery→pickup, 009 guest-negative), 5 blocked with named gap ids. THREE NEW product/test gaps
  discovered during authoring, encoded as blockers rather than knowingly-failing specs:
  `order-cancel-kernel-ponr` (006), `web-pix-pending-ctx` (007), `envelope-ingress-gap` (008) — each
  YAML header cites code locations and unblock requirements. These join the product backlog
  (blocked journeys ARE the backlog, per the plan's design commitment).
- **Coverage at authoring**: 5/114 cells covered, 103 uncovered, 6 waived-unadvertised — honest matrix;
  Phase 2 grows it.
- **Boot+seed measured (T1a-11b)**: 57s cold local (infra 5 / migrate 12 / apps 18 / seed 22) — far
  under the ≤15 min CI planning budget. §7 cost re-baseline lands with T1a-13.
- **Live SUT verified (T1a-5)**: real two-turn guest + authenticated chat conversations completed
  against the running stack — only possible because of the D-009/D-012 fail-safe wrappers; before
  them, zero turns had ever completed through the Conductor on this composition.
- **Stack lifecycle**: ./scripts/test-stack-up.sh / ./scripts/test-stack-down.sh (dev-stack guard,
  full teardown); .env.test from .env.test.example; serialize via /tmp/ibx-test-stack.lock.d.

## D-007 — CLAUDE.md "only run tests when explicitly requested" vs plan verify steps

ibatexas CLAUDE.md's Agent Behavior section discourages unprompted test runs. The plan's per-task
acceptance criteria explicitly name verify commands; executing the plan includes running them. The plan
(and the goal directive) take precedence for this initiative.

## D-018 — Phase 3 outcomes (2026-06-12, resumed session): all 9 task mechanics done; live boot + Stage-0 soak are calendar/stack-gated

Phase 3 (managed agents) implemented on `agents/phase-3`. T3-0/T3-3/T3-4/T3-10 were already committed
at session start; this session completed T3-1, T3-2, T3-5, T3-6, T3-7, T3-8 and the T3-9 mechanics.
Commits: eae10f9 (T3-1), 0847411 (T3-2), 0b7e56e (T3-5), 16266a4 (T3-6), 1ac9211 (T3-7), bf81c80
(T3-8), 484920c (T3-9). All verified: per-task vitest suites green; full `@ibatexas/api` suite 161
files / 1506 passed / 15 skipped; `@ibatexas/journeys` 381 passed; `@ibatexas/audit-sink` 85 passed;
CLI 478 passed; `tsc --noEmit` clean across touched packages; `scripts/check-bypass.sh` green.

Engineering decisions / assumptions adopted (most-logical, per the goal directive):

- **T3-1 (SystemChannel)**: committed as-found (the in-flight uncommitted work) after verifying its 10
  tests + typecheck against the consumed claustrum 0.3.0 tarball (all T3-0 symbols present:
  sessionKeyAwareLockKey, resolveGatewaySigningKey, verifyGatewayAttestation, widened ChannelKind).

- **T3-2 (trigger bridge + dedup)**: `deriveNonce` is an injectable planner dep defaulting to
  `deriveDeterministicNonce` — reads `state.perception.externalId` (the `${sourceSubject}:${eventId}`
  carrier) with a per-envelope `#index` suffix, falling back to `randomUUID()` for chat turns; ONE
  planner serves both surfaces, no bootstrap planner change needed. The bridge (`agent-trigger-bridge.ts`)
  owns the dedup stack (loop → redelivery two-phase claim → per-entity cooldown → run under wall-clock
  cap) and takes an INJECTED turn-runner (T3-6 wires the shadow conductor). LOOP SUPPRESSION reads an
  OPTIONAL `causalActorSessionId` on the trigger (agent-prefixed → drop); full causal-provenance
  stamping on every domain event is a follow-up — per-entity cooldown is the always-on loop-breaker
  meanwhile (matches the plan's "host-level dedup primary"). Model-call cap = `createModelCallCap`
  wrapper (composed onto the agent model in the live wiring).

- **T3-5 (per-agent kill switch)**: each agent gets ONE `startDistributedKillSwitchPubSub` poller bound
  to a DEDICATED throwaway `RuntimeContext` (never the global kernel switch), state read via `onApply`
  into a per-namespace map. Kernel-side `createAgentKillSwitchGuard` (basis `kill.ACTIVE`) is prepended
  FIRST in the AUTH phase, reading a late-bound holder (`setAgentKillStateReader`) that defaults to
  never-killed (inert for the pure CLI/manifest exporter; pointed at the live manager in the live wiring).
  Host-side pre-openCapsule check consults `manager.isKilled` in the runner (live wiring).

- **T3-6 (Stage-0 shadow)**: REDACTOR CHANGE (D-017) landed — `audit-redactor.ts` keeps a strict
  `agent:<kebab>@<x.y.z>:entity:<id>` sessionId UNHASHED (operational id, not PII; a forged shape is
  still hashed), so the `agent:` exclusion filters work on stored rows. Sandbox plane =
  dedicated registry (`sandbox:<id>` no-op tools, conformance-asserted `assertNoRealExecutors`), NOT
  co-mingled chooseImplementation. The runner OVERRIDES `inbound.conversationId` to the agent sessionId
  so the planner stamps `envelope.actor.sessionId = agent:…` (how shadow rows land agent-namespaced).
  `observeDriftRecord` now ROUTES by namespace (agent → shadow monitor, excluded from production
  baseline). `agent_runs` journal is a logging/in-memory seam — the durable Postgres table (with the
  soak activation timestamp) lands with the soak gate (below).

- **T3-7 (approvals glue)**: `@adjudicate/approval-engine` is NOT installed (unpublished; D-017
  no-publish) and expects an `AdjudicatedAgent` while ibatexas runs the claustrum Conductor — so this is
  the ADOPTER-SIDE engine (`agent-approvals.ts`) built on the proven HTTP-receipt round-trip the
  customer checkout/confirm path uses: park a single-use token, resolve re-adjudicates the IDENTICAL
  envelope through `adjudicateAndAudit` carrying a `confirmationReceipt` → EXECUTE. Provenance is
  projection-grade (DR-6: `resolvedBy` on the request, the kernel receipt records no approver) +
  `verifyAgentConfirmLineage` (INV-AGENT-CONFIRM-LINEAGE) over the supersession-chain walker. The thin
  HTTP resolve route + the production engine instance (wired with `resolveCapabilityPolicy` +
  `resolveAndAssemble`) land in the live wiring.

- **T3-8 (HandoffPort)**: `natsHandoff()` replaces the noop — ESCALATE publishes
  `support.handoff_requested` (existing subscriber → WhatsApp staff alert); `queue()` never throws
  (would mask the ESCALATE as `handoff_threw`). JOURNEY-003 stays blocked on `chat-confirmation-resume`.

- **T3-9 (PIX agent ladder)**: `agent-autonomy.ts` = the 3-rung ladder (shadow / supervised:confirm-all
  / live:auto-allowlist) + `canPromoteToStage1` soak gate (≥7 journaled calendar days from activation +
  ≥1 run + quiet drift; clock read, never faked). Stage-2 AUTO is a per-kind allowlist
  ({payment.pix.regenerate}); `pix.charge.refund` is confirm-gated PERMANENTLY. The SINGLE sanctioned
  test-plane publish helper (`packages/journeys/src/harness/trigger-inject.ts`) wakes the agent in a
  journey — fingerprint-gated, not in the driver act-tool set, apps/*-unreachable, and a NAMED
  check-bypass leg-8 carve-out (grep-honest). The PIX_REMEDIATION_AGENT def (T3-3) is already complete
  at Stage 0.

### CALENDAR/STACK-GATED OPERATIONAL REMAINDER (the activation — not faked, per D-017)

The mechanics are built + unit-validated; the following are operational steps that REQUIRE the running
test/staging stack and/or a real 7-day soak clock, so they cannot complete in-session:

1. **Live boot wiring — DONE (flag-gated, commit 15f3c02).** `startManagedAgentPlane` +
   `createPixTriggerMapper` (`managed-agent-plane.ts`) compose the Stage-0 plane from the production
   ports (shadow conductor T3-6 + sandbox registry, kill-switch manager T3-5, approval engine T3-7,
   kill-guarded shadow runner over the trigger bridge T3-2) and `bootstrapClaustrum` starts it behind
   `IBX_AGENTS_ENABLED` (default OFF; fail-open; Redis pub/sub via `redis.duplicate()`; cleanup in
   `resetClaustrumForTests`). Unit-validated flag-OFF path + mapper; the flag-ON `start()` (live NATS/
   BullMQ/Redis-pubsub) is operator-validated on the test stack — that enabled boot starts the soak
   clock. STILL PENDING here: the `POST …/approvals/:token/resolve` HTTP route (thin glue over the
   engine) + an optional per-trigger `createModelCallCap` on the agent model.
2. **agent_runs durable table** — add the Postgres `agent_runs` migration (records `activatedAt`, decision
   distribution, stage) that the soak gate reads across restarts.
3. **Stage-0 activation** — record the activation timestamp (soak clock start) when the plane boots in
   the test/staging stack; `agent_runs.activatedAt` is the gate input.
4. **Journey JOURNEY-017-pix-remediation** — author + run via the harness (`injectPixFailureTrigger`
   fires the trigger; the oracle asserts the shadow audit row + zero Medusa/Prisma mutations at Stage 0).
   `ibx journey run JOURNEY-017-pix-remediation --k 2` green per stage is the acceptance; Stages 1/2 are
   gated on the soak below.
5. **7-day soak → Stage-1 flip → Stage-2** — `canPromoteToStage1` permits the 0→1 flip only on/after
   `activatedAt + 7d` with quiet drift; the Stage-1→2 promotion follows once supervised approvals are
   clean. These are FUTURE-DATED, condition-gated operations (a `/schedule`-able follow-up keyed to the
   recorded activation date + 7 days).
6. **Recovered-orders measurement** — fold the agent's recovered-order count into `sim_runs`/obs once the
   journey runs on the live stack.

Push-dependent items (real claustrum publish + registry pin bump, branch-protection checks, nightly
secrets) remain as recorded in `docs/agents/phase-1b-pending-push.md`.
