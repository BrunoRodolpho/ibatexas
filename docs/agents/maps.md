

# ===== MAP: ibatexasTesting =====

## summary
ibatexas is a pnpm/turbo monorepo (Vitest 3.2 unit/integration, Playwright 1.58 e2e, testcontainers 12) with ~301 test files. `pnpm test` = `turbo test` running per-package `vitest run` (root vitest.config.ts: node env, globals, v8 coverage, @/ alias to apps/web/src). Heaviest suites: apps/api (~120 files: routes, jobs, subscribers, claustrum planner, integration, bypass-detection static gates, wave6 red-team, audit-2026-05-24 conformance with real Redis/Postgres testcontainers), packages/tools (~60), cli (~25), web (~22), 5 pack conformance suites using @adjudicate/conformance runConformance + envelope-corpus fixtures. Playwright lives at root (tests/e2e: smoke, web-golden-path, api-golden-path; auto-starts web+api dev servers) but is NOT in CI; tests/e2e/fixtures is empty. CI (.github/workflows/ci.yml) runs lint, vitest+coverage (Docker probe for testcontainers), check-bypass.sh, audit, build, kernel pack-bom/analyze gates, SonarCloud. The ibx CLI provides rich environment tooling: `ibx test seed/integration/e2e/e2e-run/status`, `ibx db seed*/reset/provision`, `ibx simulate` (deterministic seeded-PRNG commerce-data generator), `ibx scenario` (YAML state scenarios with verify rules), `ibx matrix` (2^N combinatorial UI states + snapshots), `ibx chat list/dump/clean` (session inspection only). There are NO conversation-simulation or golden-conversation tests: the planner "golden-set" test mocks the ModelProvider, chat-integration mocks the Conductor, and live LLM intent-extraction accuracy is explicitly deferred ("Phase C, observed measurement, not a gate"). No .claude skills/agents/commands exist in the repo, projects dir, or home dir. domain/types test files are orphaned from turbo (no test script); check-bypass.sh references the deleted @ibatexas/llm-provider.

## reusableAssets
- ibx CLI pipeline runner (runPipeline, StepRegistry, step-cache, --from/--skip/--dry-run) and guardDestructive — extend for new test orchestration instead of new scripts
- ibx scenario YAML engine (scenario-schema.ts zod schema, DAG depends, cleanup/setup/verify min-count rules, locks) — natural home for golden-conversation scenario files
- ibx test seed / test integration / test e2e / db reset — full deterministic environment seeding and teardown for e2e or simulation runs
- ibx simulate seeded-PRNG engine + behavior profiles (lib/simulator.ts, lib/profiles.ts) — deterministic persona/data generation reusable for conversation personas
- testcontainers helpers: apps/api/src/__tests__/helpers/redis-testcontainer.ts and audit-2026-05-24/h3-postgres-container.ts (real-infra-or-fail policy)
- apps/api vitest setup.ts no-op audit-sink bootstrap pattern for any new api-level suite
- Mocked ModelProvider double + EXPRESS_INTENT assertions in ibatexas-planner.test.ts — template for planner/turn-level conversation tests; deriveIbatexasPlannerContext export
- chat-integration.test.ts Fastify+mocked Conductor (getConductor/handleTurn/Capsule) harness for turn-pipeline tests; ibx chat dump for transcript extraction
- @adjudicate/conformance runConformance + envelope fixture-corpus pattern (pack conformance tests) for deterministic decision assertions
- Playwright root config with webServer auto-start and web/api/smoke project split; ibx test e2e-run wrapper
- process-compose.yaml + docker-compose.yml for full-stack local env with readiness probes
- turbo test task (caching, ^build dependency, coverage outputs) and Sonar lcov aggregation — register any new test package here
- kernel governance gates already in CI (pack-bom drift, kernel analyze, check-bypass.sh) — pattern for adding new fail-closed CI gates
- drift-detector.ts / drift-evaluate.ts and toolRosterDrift() boot gate for runtime behavioral monitoring

## gaps
- No conversation-simulation, golden-conversation, or transcript-replay tests exist anywhere; live LLM intent-extraction accuracy is explicitly deferred ('Phase C observed measurement') and unimplemented — planner test mocks the model, chat-integration mocks the Conductor
- No LLM-judge / eval framework dependency or harness in the repo; no golden transcript fixtures (tests/e2e/fixtures contains only .gitkeep)
- No WhatsApp-channel or chat-flow e2e: Playwright golden paths cover storefront browse/cart and raw API only, never the conversational turn pipeline
- Playwright e2e is not wired into any CI workflow — e2e runs are local/manual via ibx test e2e-run
- packages/domain (16 test files) and packages/types (7 test files) have no test script, so turbo test and CI never execute them (only one domain file runs via check-bypass.sh)
- scripts/check-bypass.sh step 3 targets deleted @ibatexas/llm-provider — silently no-ops; stale since the claustrum cutover
- No per-test fixture isolation for e2e: ibx test e2e is a destructive global clean+reseed; no API-level fixture/seeding utilities scoped to a single test or conversation
- CLAUDE.md test rule ('No DB or network — mock everything external') contradicts the testcontainers RULE-3 real-infra policy used by api conformance suites — guidance for a new agent layer must reconcile this
- No .claude skills, agents, or commands exist in the repo, /Users/thaisrodolpho/projects/.claude, or ~/.claude — a new agent layer starts from zero (only CLAUDE.md conventions and the ibx-first rule)
- No coverage thresholds or vitest workspace config at root; apps/web and several packages rely on implicit config resolution; apps/admin has no tests at all

## inventory (name :: location)
- Root Vitest config :: /Users/thaisrodolpho/projects/ibatexas/vitest.config.ts
- apps/api Vitest config + setup :: /Users/thaisrodolpho/projects/ibatexas/apps/api/vitest.config.ts
- apps/api unit/route suites (~120 files) :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/__tests__/
- Real-infra testcontainer helpers :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/__tests__/helpers/redis-testcontainer.ts
- Integration suites :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/__tests__/integration/
- Bypass-detection gate suite :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/__tests__/bypass-detection/
- check-bypass.sh :: /Users/thaisrodolpho/projects/ibatexas/scripts/check-bypass.sh
- wave6 red-team suite :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/__tests__/wave6-red-team/
- audit-2026-05-24 conformance suites :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/__tests__/audit-2026-05-24/
- Pack conformance tests (x5) :: /Users/thaisrodolpho/projects/ibatexas/packages/pack-{orders,payments,reservations,whatsapp,customer-onboarding}/src/__tests__/conformance.test.ts
- Pack behavior tests :: /Users/thaisrodolpho/projects/ibatexas/packages/pack-*/src/__tests__/
- packages/tools suite (~60 files) :: /Users/thaisrodolpho/projects/ibatexas/packages/tools/src/**/__tests__/
- packages/domain suite — ORPHANED :: /Users/thaisrodolpho/projects/ibatexas/packages/domain/src/**/__tests__/
- packages/types suite — ORPHANED :: /Users/thaisrodolpho/projects/ibatexas/packages/types/src/__tests__/
- packages/cli suite (~25 files) :: /Users/thaisrodolpho/projects/ibatexas/packages/cli/src/__tests__/
- apps/web suite (~22 files) :: /Users/thaisrodolpho/projects/ibatexas/apps/web/src/**/__tests__/
- apps/commerce suite :: /Users/thaisrodolpho/projects/ibatexas/apps/commerce/__tests__/indexing.test.ts
- Playwright e2e :: /Users/thaisrodolpho/projects/ibatexas/playwright.config.ts + tests/e2e/
- ibx test command group :: /Users/thaisrodolpho/projects/ibatexas/packages/cli/src/commands/test.ts
- ibx db seed/reset commands :: /Users/thaisrodolpho/projects/ibatexas/packages/cli/src/commands/db.ts
- ibx simulate (data simulator) :: /Users/thaisrodolpho/projects/ibatexas/packages/cli/src/commands/simulate.ts + src/lib/simulator.ts + src/lib/profiles.ts
- ibx scenario (YAML state testing) :: /Users/thaisrodolpho/projects/ibatexas/packages/cli/src/commands/scenario.ts + src/lib/scenario-engine.ts + scenarios/*.yml
- ibx matrix (combinatorial UI states) :: /Users/thaisrodolpho/projects/ibatexas/packages/cli/src/commands/matrix.ts + src/matrices/index.ts + src/lib/{matrix,snapshot}.ts
- ibx chat (session inspection) :: /Users/thaisrodolpho/projects/ibatexas/packages/cli/src/commands/chat.ts
- Planner golden-set test (closest to conversation testing) :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/__tests__/ibatexas-planner.test.ts
- turbo test pipeline + CI :: /Users/thaisrodolpho/projects/ibatexas/turbo.json + .github/workflows/ci.yml
- Dev environment orchestration :: /Users/thaisrodolpho/projects/ibatexas/process-compose.yaml + docker-compose.yml
- correctness-remediation artifacts :: /Users/thaisrodolpho/projects/ibatexas/correctness-remediation/
- .claude dirs (no skills/agents/commands anywhere) :: /Users/thaisrodolpho/projects/ibatexas/.claude/

# ===== MAP: ibatexasSurfaces =====

## summary
IbateXas is a pnpm/turbo monorepo: Fastify API (apps/api, port 3001), Next.js storefront (apps/web, 3000), staff admin (apps/admin, 3002/admin), Medusa v2 commerce (apps/commerce, 9000), plus Postgres 5433, Redis 6379, Typesense 8108, NATS 4222 (started via `ibx dev start`). The LLM agent surface is the claustrum Conductor (bootstrapClaustrum() at apps/api/src/index.ts:93, composition root apps/api/src/claustrum-bootstrap.ts) reached through POST /api/chat/messages + SSE GET /api/chat/stream/:sessionId (web) and POST /api/webhooks/whatsapp (Twilio-signature-verified). The LLM sees one mutating tool, express_intent (apps/api/src/claustrum/ibatexas-planner.ts); 17 LLM-callable mutating tools (10 orders, 4 reservations, 2 customer-onboarding, 1 payments) are registered in apps/api/src/tools/register-ibatexas-tool-packs.ts with capability===intentKind, adjudicated by @adjudicate kernel against pack PolicyBundles (packages/pack-*/src/policies.ts). Order lifecycle: pending→confirmed→preparing→ready→in_delivery/delivered, cancel pre-PONR (packages/types/src/order-status.ts). Payment lifecycle per-attempt rows: awaiting_payment→payment_pending→paid/expired/failed, switching_method, refund/dispute (packages/types/src/payment-status.ts); PIX uses createPixPendingDeferGuard (kernel DEFER, defer:pending:{sessionId}), pix-expiry-checker/monitor jobs, defer-resolver resume on payment.status_changed. NATS subjects ibatexas.{domain}.{action} (order.placed, payment.status_changed, cart.abandoned, reservation.*, review.submitted...). DB layers: Prisma ibx_domain schema (packages/domain/prisma/schema.prisma), Medusa, intent_audit/governance_events (kernel), claustrum_memory_*/claustrum_grounding_docs (pgvector) — all provisioned by `ibx bootstrap`/`ibx db provision`. Auth: Twilio Verify OTP → JWT cookies (customer `token` aud=token 4h HS256 JWT_SECRET; staff `staff_token` aud=staff_token 8h STAFF_JWT_SECRET); a test agent can mint JWTs directly or use seeded customers; guest chat needs only x-session-secret returned on first POST. ibx CLI (24 command groups) covers seed/reset/inspect/simulate/chat-drive (`ibx api chat`).

## reusableAssets
- ibx CLI as the environment-control plane: ibx bootstrap / db reset / test seed / scenario / simulate full give deterministic seeded states (seeded PRNG, scale presets) — a test agent should shell out to these rather than writing its own seeders
- ibx api chat "..." --session <uuid> — an existing CLI driver for the conversational agent over the real chat route; ibx chat list/dump for transcript validation
- Guest chat protocol needs zero auth: POST /api/chat/messages returns sessionSecret on first call; echo as x-session-secret afterwards; consume SSE at /api/chat/stream/:sessionId
- JWT minting seam for customer auth: HS256 with JWT_SECRET, payload {sub: customerId, userType: 'customer', jti, aud: 'token'}, set as httpOnly cookie `token` — avoids real Twilio OTP; seeded customers come from ibx db seed:delivery / seed:orders / ibx simulate
- ibx auth create-staff + ibx auth flush for staff identity setup and OTP rate-limit cleanup between runs
- Validation oracles already in place: intent_audit Postgres table + ibx obs decisions/turn/payments/funnel for kernel decisions; ibx orders inspect <orderId> for projection+event-log; NATS subjects (subscribe via @ibatexas/nats-client) for order.placed/payment.status_changed assertions; Redis keys via ibx debug redis; conversation archive via ibx chat dump --source postgres
- Stripe simulation: ibx stripe listen/trigger/complete --cart (dev rescue to force-complete PIX carts without a real payment) and ibx stripe flush for idempotency-key cleanup
- ibx kernel defer resume <sessionId> [--json] to drive/inspect the PIX DEFER-resume path deterministically
- canTransition/canTransitionPayment matrices in packages/types/src/order-status.ts and payment-status.ts as the authoritative state-machine spec to generate test cases from
- agent-tools.md + listIbatexasToolPacks() as the machine-readable tool roster (auth level, IO schema, riskLevel, requiresConfirmation) to auto-generate per-tool test plans
- Existing Playwright config + golden-path specs in tests/e2e as the harness skeleton (projects split web vs api by filename regex)
- buildSystemEnvelope() helper and publishNatsEvent() for injecting system events (payment.status_changed etc.) when simulating webhook/job outcomes
- rk() key helper from @ibatexas/tools for any direct Redis assertions (APP_ENV prefixing)

## gaps
- No OTP test bypass: /api/auth/verify-otp always calls Twilio Verify — an integration agent needs either real Twilio creds + a real phone, direct JWT minting (requires JWT_SECRET access and an existing Customer row), or a new dev-only auth seam
- tests/e2e/fixtures is empty — no authenticated-session fixture, no seeded-customer fixture, no chat-session helper exists for Playwright
- No programmatic WhatsApp-channel driver: inbound requires a valid x-twilio-signature (HMAC of TWILIO_WEBHOOK_URL+params with TWILIO_AUTH_TOKEN); a test agent must compute the signature itself or use ibx tunnel + real Twilio sandbox; no CLI command fakes an inbound WhatsApp message
- PIX payment confirmation cannot be completed end-to-end without Stripe sandbox events; ibx stripe complete --cart is the only force-complete path and refuses in production-like env
- payment.method.switch and payment.retry are advertised by paymentsCapabilityPlanner but have no registered tool handler — LLM proposals for them dispatch to tool_unresolved (documented TODO WS4); a conversation-driven test of those flows must use the HTTP routes instead
- SSE streaming is single-chunk (one text_delta + done) — token-level streaming assertions are not possible yet; claustrum SessionPort save/load are TODO stubs (history lives only on the dev Redis store)
- docs/PROJECT_STATE.md and docs/backlog/TODO-BACKLOG.md referenced by CLAUDE.md do not exist — no canonical 'what's broken' list to scope test priorities
- Stale 'INERT' comment block in register-ibatexas-tool-packs.ts contradicts live wiring (bootstrapClaustrum runs at apps/api/src/index.ts:93) — could mislead an agent reading code; verified live
- No machine-readable OpenAPI export step documented (Swagger UI exists at :3001/docs but no checked-in spec snapshot for contract diffing)
- No existing harness to assert NATS event emission (tests mock at caller boundary per CLAUDE.md); an integration agent needs a NATS subscriber utility or to poll downstream effects (intent_audit, projections, Redis)

## inventory (name :: location)
- Chat HTTP route (web channel) :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/chat.ts
- WhatsApp webhook route :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/whatsapp-webhook.ts
- Stripe webhook + processor :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/stripe-webhook.ts
- Auth routes (Twilio Verify OTP) :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/auth.ts
- Auth middleware (test-agent auth seam) :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/middleware/auth.ts
- 17-tool LLM registry :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/tools/register-ibatexas-tool-packs.ts
- Agent tools spec (auth/IO contracts) :: /Users/thaisrodolpho/projects/ibatexas/docs/architecture/design/agent-tools.md
- Planner (express_intent) :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/claustrum/ibatexas-planner.ts
- Conductor composition root :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/claustrum-bootstrap.ts
- Order lifecycle pack + state machine :: /Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src
- Payment lifecycle (PIX) :: /Users/thaisrodolpho/projects/ibatexas/packages/types/src/payment-status.ts
- PIX jobs + defer resume :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/jobs
- Customer order/payment action routes :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/order-actions.ts
- Cart/checkout routes :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/cart.ts
- Catalog/reservation/misc routes :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes
- LGPD anonymize routes :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/me.ts
- Admin API routes (staff JWT) :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/admin
- Web storefront pages :: /Users/thaisrodolpho/projects/ibatexas/apps/web/src/app/[locale]
- Admin panel pages :: /Users/thaisrodolpho/projects/ibatexas/apps/admin/src/app/admin
- Prisma domain schema (ibx_domain) :: /Users/thaisrodolpho/projects/ibatexas/packages/domain/prisma/schema.prisma
- Kernel audit + claustrum DB schemas :: /Users/thaisrodolpho/projects/ibatexas/node_modules/.pnpm/@adjudicate+audit-postgres@2.0.1*/node_modules/@adjudicate/audit-postgres/migrations
- NATS subjects inventory :: /Users/thaisrodolpho/projects/ibatexas/packages/nats-client/src/index.ts
- Redis key pattern inventory :: /Users/thaisrodolpho/projects/ibatexas/docs/ops/redis-memory.md
- ibx CLI (env seed/reset/drive) :: /Users/thaisrodolpho/projects/ibatexas/docs/cli/reference.md
- Session store + SSE emitter :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/session/store.ts
- Existing Playwright e2e suite :: /Users/thaisrodolpho/projects/ibatexas/tests/e2e
- System-actor envelope helper :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/__shared__/system-actor-envelope.ts
- Observability/validation streams :: /Users/thaisrodolpho/projects/ibatexas/apps/api/src/observability
- Env contract :: /Users/thaisrodolpho/projects/ibatexas/.env.example

# ===== MAP: claustrum =====

## summary
claustrum (@claustrum/core@0.2.0) is a hexagonal agent runtime over the deterministic @adjudicate/core kernel. Testing: of the documented 4 layers, layer 1 (unit per port) and layer 4 (property tests, fast-check, N>=100 asserted) are fully implemented; layer 2 (golden conversation snapshots) exists only as single-turn JSON fixtures (CC-006 few-shot fixtures, CLI replay turn files) — no multi-turn snapshot harness, zero toMatchSnapshot usage; layer 3 (replay against historical LLM traces) is plumbing-only: fragmentManifest is produced by PromptComposer and typed into LLMTrace.promptManifest, CC-003 enforces manifest-in-trace, but there is no trace store and no replay-by-manifest tool (roadmap v0.5.x). @claustrum/conformance ships CC-001..CC-006 with seeded LCG determinism; CC-006 is the few-shot drift detector but uses its own fixture schema (expectedEnvelopeKinds + expectedDecisionKind), NOT the FewShotIndex.goldOutcome oracle — the FewShotIndex port has no implementation and is never consumed. Extension points: handleTurn is a pure function over a Capsule minted by Conductor.openCapsule (per-session lock, TenantResolver, session load); entry is strictly ChannelMessage-shaped and ChannelKind is a closed union "whatsapp"|"web", so a synthetic/internal trigger channel requires widening one union in core — otherwise a ChannelDriver is fully first-class (WebChannelStub already runs in conformance/examples). Non-conversational triggers have doctrine (ADR-0004: system-actor envelopes for jobs/webhooks; Actor.principal includes "system") but no ingress; deferred envelopes only resume when an inbound arrives (no scheduler). Multi-agent is aspirational: Session.agent?: string plus roadmap notes only.

## reusableAssets
- Conductor.openCapsule/closeCapsule + handleTurn as the single turn entry — an agent/trigger layer should synthesize OpenCapsuleInput (it already accepts an `actor` override; Actor.principal "system" is typed) rather than invent a second loop
- WebChannelStub pattern (packages/core/src/test-doubles/web-channel-stub.ts): a synthetic ChannelDriver already runs first-class in conformance, property tests, and the healthcare-stub example — template for an internal/trigger channel driver
- packages/conformance/tests/make-conductor.ts: complete in-memory Conductor factory from test-doubles — base for any simulation harness
- @claustrum/core/test-doubles subpath exports (StubAdjudicator call-recording, RecordingTelemetrySink, InMemoryModelProvider scripted completions, InMemorySessionStore/Lock, EmptyGroundingProvider, runModelProviderContract)
- packages/core/test/properties/harness.ts (buildHarness/buildInbound/buildTestEnvelope/makeTool) for property-style loop testing
- @claustrum/conformance runner + ConformanceCheck interface + DEFAULT_CHECKS extension point (custom checks via options.checks) + withInstrumentedPort spy helper + seeded lcg PRNG
- CC-006 fixture format and runner (fixtures/few-shots/*.json) — extend toward goldOutcome rather than building a parallel regression system
- CLI loadConductorFactory + runReplay/runConformance (packages/cli/src/lib/load-conductor.ts, commands/) for driving adopter conductors from tooling
- SessionPort parked/deferred envelope machinery + Adjudicator.resume re-adjudication path — the existing deferred-work substrate a scheduler/cron trigger should drive (fire due deferrals by opening a turn), never dispatch-on-confirm
- PromptComposer fragmentManifest + LLMTrace.promptManifest + boundLLMTrace — the replay key plumbing any trace store/replay tool must consume
- TenantResolver and ResolverPort as the per-turn policy/state assembly seams for agent-scoped configuration
- dispatchDecision total-function matrix — handles all six Decision variants; agent layers act on DispatchResult, not raw Decisions

## gaps
- Layer 2 (golden conversation snapshots) has no real implementation: CC-006 drives only the LAST user message of single fixtures; no multi-turn conversation snapshot harness, no toMatchSnapshot/__snapshots__ anywhere
- Layer 3 (replay against historical LLM traces) is plumbing-only: no LLM-trace store exists (roadmap v0.5.x), core never calls emitLLMTrace, and CLI replay re-executes turns live instead of replaying stored traces/fragmentManifests by hash
- FewShotIndex goldOutcome regression is unwired: the port has zero implementations, is never consumed by the loop/synthesizer/conformance, and CC-006 uses a weaker parallel schema (kind-name + decision-kind match, not intentHash + basis equality); PROJECT_STATUS lists 'few-shot regression-test integration as drift detector' as explicitly remaining
- No non-conversational ingress: turns can only open from a ChannelMessage; ChannelKind is a closed union "whatsapp"|"web" so an internal/trigger/synthetic channel kind requires a core edit; no webhook/cron/event entry, no scheduler that fires due DeferredEnvelopes (they resume only when the user happens to message again)
- Multi-agent is doc-only: Session.agent?: string is the sole code hook; PlannerProfile (named in PROJECT_STATUS) does not exist; agent routing, broker, and IPC boundary are v0.6.x roadmap items with open transport decisions
- No server runtime at all: examples are a readline REPL and a scripted demo; no HTTP server, no long-running process, no operator console/WebSocket decision stream (v0.5.x)
- Referenced docs missing: packages/core/src/ports/STATUS.md (linked from PROJECT_STATUS) and docs/architecture/design/hybrid-state-flow.md (linked from CLAUDE.md) do not exist
- No simulation or autonomy design doc exists in docs/architecture/design/ — only agent-context-ranking (profile/ranking pattern), runtime-kernel-layer-split, tool-classification
- MCP integration (@claustrum/mcp-client/server) is planned v0.3.x, not started

## inventory (name :: location)
- handleTurn cognitive loop :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/handle-turn.ts
- Conductor / Capsule lifecycle :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/conductor.ts
- Capsule type :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/capsule.ts
- PlannerPort + CognitiveState :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/ports/planner.ts
- ResolverPort (optional resolve stage) :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/ports/resolver.ts
- ChannelDriver port :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/ports/channel.ts
- SessionPort (parked/deferred envelopes) :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/ports/session.ts
- TelemetryPort + LLMTrace :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/ports/telemetry.ts
- Decision dispatch matrix :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/execution/dispatch.ts
- ToolRegistry (capability→tool indirection) :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/tools/registry.ts
- Test doubles barrel :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/test-doubles/index.ts
- ModelProvider shared contract test :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/test-doubles/model-provider-contract.ts
- Property tests (layer 4) :: /Users/thaisrodolpho/projects/claustrum/packages/core/test/properties/
- Core unit tests (layer 1) :: /Users/thaisrodolpho/projects/claustrum/packages/core/test/
- @claustrum/conformance runner :: /Users/thaisrodolpho/projects/claustrum/packages/conformance/src/runner.ts
- Conformance checks CC-001..CC-006 :: /Users/thaisrodolpho/projects/claustrum/packages/conformance/src/checks/
- CC-006 few-shot drift detector :: /Users/thaisrodolpho/projects/claustrum/packages/conformance/src/checks/few-shot-regression.ts
- FewShotIndex port (goldOutcome oracle) :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/ports/few-shot.ts
- Conformance test conductor factory :: /Users/thaisrodolpho/projects/claustrum/packages/conformance/tests/make-conductor.ts
- CLI replay command :: /Users/thaisrodolpho/projects/claustrum/packages/cli/src/commands/replay.ts
- PromptComposer / fragment manifest :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/prompting/synthesizer.ts
- CLI conformance + init commands :: /Users/thaisrodolpho/projects/claustrum/packages/cli/src/commands/
- Adjudicator port (kernel surface) :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/ports/adjudicator.ts
- TenantResolver port :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/ports/tenant.ts
- SessionLock port + in-memory impl :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/ports/session-lock.ts
- Examples (boot wiring reference) :: /Users/thaisrodolpho/projects/claustrum/examples/
- PROJECT_STATUS_AND_NEXT_STEPS.md :: /Users/thaisrodolpho/projects/claustrum/PROJECT_STATUS_AND_NEXT_STEPS.md
- Design docs (agents/plans) :: /Users/thaisrodolpho/projects/claustrum/docs/architecture/design/
- ADR-0004 system-actor doctrine :: /Users/thaisrodolpho/projects/claustrum/docs/decisions/0004-intent-gated-execution.md
- Telemetry bounds helper :: /Users/thaisrodolpho/projects/claustrum/packages/core/src/telemetry-bounds.ts

# ===== MAP: adjudicate =====

## summary
adjudicate is a post-v1 TypeScript monorepo (pnpm) implementing a deterministic decision kernel for LLM-proposed actions (6-outcome Decision algebra, taint lattice, audit/replay). It already ships a complete agent-adjacent ops layer: an `adjudicate` CLI (simulate with scenario-diff mode, seeded scenario generation, deterministic red-team, audit replay, static SVG policy visualization, interactive REPL, docker-compose dev harness, analyze/SARIF, export, pack init/lint/bom/verify, doctor, reap); @adjudicate/conformance with deterministic checks AC-001..AC-006 plus pack trust/fingerprint, AI-BOM, config-seal, pack-health; @adjudicate/observability with a single Exporter abstraction over OTLP and frozen SEMCONV `adjudicate.*` attributes; @adjudicate/drift (statistical distribution drift, TV-distance, history ring buffer); @adjudicate/approval-engine (REQUEST_CONFIRMATION orchestration, in-memory/Redis registries, webhook channels); @adjudicate/admin-sdk (Zod schemas + tRPC router for audit/emergency/replay/governance); and apps/console, a Next.js operator console with 15 routes (Audit Explorer with live tail, Dashboard, Governance, Policy Tree, Red Team, Drift, PII, Command Risk, Tokens, AI-BOM, Integrity, Approvals, Control/kill-switch, Decision detail + supersession lineage). The console has NO agent-workflow-graph visualization and NO scenario-coverage view. docs/guides/testing-your-policy.md defines the scenario fixture contract. The repo defines no adjudicate-specific Claude skills — skills-lock.json pins only a third-party remotion skill (.agents/skills/); .claude/ holds only worktrees. docs/roadmap/ and PROJECT_STATUS_AND_NEXT_STEPS.md were deleted in commit 50eec91 (2026-06-10) but are recoverable via git; AI_CONTEXT.md still references them.

## reusableAssets
- Scenario fixture JSON contract ({intent,state,expected}) + `adjudicate simulate --scenarios` diff mode and its 0/1/2 exit-code convention — any agent test harness should emit/consume this format, not invent a new one (docs/guides/testing-your-policy.md)
- Pack loading convention: loadPackFromModule (npm name or file path), assertPackConformance gate, and the optional pack.rehydrateState(raw) state-rehydration convention — reuse for any tool that feeds JSON state into the kernel
- @adjudicate/red-team library (seeded vector generators, runRedTeam, toSimulateScenario, history store + trend points) — extend with new attack vectors rather than writing a separate adversarial harness
- @adjudicate/conformance runConformance + AC-001..AC-006 plus pack trust/AI-BOM/config-seal/pack-health primitives — agent-layer CI gates should call these, not reimplement invariant checks
- Seeded-LCG determinism pattern (same construction in conformance/prng, red-team/prng, scenarios-generate) — mandatory for any new generator so outputs stay byte-reproducible
- @adjudicate/observability Exporter abstraction + frozen SEMCONV adjudicate.* attribute names (already includes adapter.phase/iteration/outcome, provider.id, pause.phase) — emit agent telemetry through these, never invent parallel attribute names
- @adjudicate/admin-sdk Zod schemas + tRPC router (audit.query, replay.run, governance.*) and apps/console hooks/components — new console views should add tRPC procedures + schemas here, following the established handler/schema/hook/page pattern
- @adjudicate/approval-engine for human-in-the-loop REQUEST_CONFIRMATION flows (registries, channels, replay-safe resume via agent.confirm)
- @adjudicate/adapter-core agent loop (createAdjudicatedAgent, ProviderBridge, MemoryStore, TraceSink) + anthropic/openai shims — the place to build agent runtime behavior; new providers are <200-line bridges
- @adjudicate/drift detector/history for distribution monitoring; console AdapterTrace registry slot for vendor-specific per-record rendering
- adjudicate dev docker-compose harness (Redis+Postgres) and adjudicate replay/export for audit-record pipelines
- describePolicyBundle (core/kernel) + CLI visualize SVG renderer + console PolicyTree/manifest-diff as the starting points for any richer graph visualization
- docs/specs canonical JCS hashing + intent-envelope-v2 schema + golden vectors for envelope construction; AI_CONTEXT.md as the agent onboarding brief

## gaps
- No agent-workflow-graph visualization anywhere: CLI visualize is a static 4-phase SVG of guard structure; console has policy tree and supersession lineage, but nothing renders agent loop execution (iterations, tool calls, defer/confirm pauses, multi-step sessions)
- No scenario-coverage visualization or reporting: scenarios run via CLI diff tables only; no view of which intents/guards/decision-kinds are covered by fixtures, and the console has zero scenario awareness
- scenarios generate produces only generic payloads (no Pack schema introspection); the code explicitly invites a Zod/schema-aware generator layered on top
- CLI replay is state-blind (synthetic empty state); state-aware replay exists only as the admin-sdk replay.run procedure with Postgres access — no unified operator workflow
- No Claude/agent skills defined for this repo: skills-lock.json only pins a third-party Remotion skill; no .claude/skills, no SKILL.md describing how an agent should drive the adjudicate CLI/conformance/red-team toolchain
- docs/roadmap/ and PROJECT_STATUS_AND_NEXT_STEPS.md were deleted (commit 50eec91, 2026-06-10) while AI_CONTEXT.md still references them — stale pointers; authoritative remaining-work snapshot now lives only in git history and POST_V1_STRATEGY.md
- Outstanding items from the deleted status doc that remain open: restart-mid-flow integration test (DEFER + REQUEST_CONFIRMATION across process restart), console migration from 2s polling to AuditEventBus/WebSocket, pack registry indexer (design-only), Vercel AI adapter, adopter-evidence gates for kill-switch v2 and AuditEventBus fan-out
- REPL is single-line-JSON only (no multi-line paste, no autocomplete on intent kinds); export lacks Postgres source and Parquet; red-team vectors fixed at three

## inventory (name :: location)
- CLI: simulate :: /Users/thaisrodolpho/projects/adjudicate/packages/cli/src/commands/simulate.ts
- CLI: scenarios generate :: /Users/thaisrodolpho/projects/adjudicate/packages/cli/src/commands/scenarios-generate.ts
- CLI: red-team :: /Users/thaisrodolpho/projects/adjudicate/packages/cli/src/commands/red-team.ts
- CLI: replay :: /Users/thaisrodolpho/projects/adjudicate/packages/cli/src/commands/replay.ts
- CLI: visualize :: /Users/thaisrodolpho/projects/adjudicate/packages/cli/src/commands/visualize.ts
- CLI: repl :: /Users/thaisrodolpho/projects/adjudicate/packages/cli/src/commands/repl.ts
- CLI: dev :: /Users/thaisrodolpho/projects/adjudicate/packages/cli/src/commands/dev.ts
- CLI: other commands :: /Users/thaisrodolpho/projects/adjudicate/packages/cli/src/bin.ts
- @adjudicate/conformance :: /Users/thaisrodolpho/projects/adjudicate/packages/conformance/src
- @adjudicate/observability :: /Users/thaisrodolpho/projects/adjudicate/packages/observability/src
- SEMCONV attributes :: /Users/thaisrodolpho/projects/adjudicate/packages/observability/src/semconv.ts
- @adjudicate/drift :: /Users/thaisrodolpho/projects/adjudicate/packages/drift/src
- @adjudicate/approval-engine :: /Users/thaisrodolpho/projects/adjudicate/packages/approval-engine/src
- @adjudicate/admin-sdk :: /Users/thaisrodolpho/projects/adjudicate/packages/admin-sdk/src
- @adjudicate/red-team (library) :: /Users/thaisrodolpho/projects/adjudicate/packages/red-team/src
- Operator Console app :: /Users/thaisrodolpho/projects/adjudicate/apps/console/src/app
- Console: Audit Explorer + Decision detail :: /Users/thaisrodolpho/projects/adjudicate/apps/console/src/app/page.tsx
- Console: Dashboard / Governance / Control :: /Users/thaisrodolpho/projects/adjudicate/apps/console/src/app/dashboard/page.tsx
- Console: Policy Tree view :: /Users/thaisrodolpho/projects/adjudicate/apps/console/src/app/policy-tree/page.tsx
- Console missing visualizations :: /Users/thaisrodolpho/projects/adjudicate/apps/console/src
- Guide: testing your policy :: /Users/thaisrodolpho/projects/adjudicate/docs/guides/testing-your-policy.md
- skills-lock.json / Claude skills :: /Users/thaisrodolpho/projects/adjudicate/skills-lock.json
- PROJECT_STATUS_AND_NEXT_STEPS.md (deleted) :: git: 50eec91^:PROJECT_STATUS_AND_NEXT_STEPS.md
- docs/roadmap (deleted) :: git: 50eec91^:docs/roadmap/
- AI_CONTEXT.md :: /Users/thaisrodolpho/projects/adjudicate/AI_CONTEXT.md
- Agent loop substrate (adapter-core + provider shims) :: /Users/thaisrodolpho/projects/adjudicate/packages/adapter-core
- POST_V1_STRATEGY (futures) :: /Users/thaisrodolpho/projects/adjudicate/docs/release/POST_V1_STRATEGY.md
- Specs for deterministic interop :: /Users/thaisrodolpho/projects/adjudicate/docs/specs