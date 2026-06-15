

# ===== ARCHITECT: testing =====

# Agent-Based Integration Testing Platform — Blueprint

## Critique first
Your instinct (agents as real users) is right, but two corrections. (1) "Cover ALL business use cases" via LLM agents is the wrong target: exhaustive coverage belongs to the deterministic layers you already have (pack conformance fixtures enumerate intent×decision cheaply). The fleet should start with 20–50 scenarios drawn from real failures (Anthropic eval guidance) and grow from production incidents. (2) Your biggest test problem today is not duplication — it's plumbing: `packages/domain` (16 files) and `packages/types` (7 files) never run in CI, `check-bypass.sh` step 3 silently no-ops against a deleted package, and Playwright is in no workflow. Fix those before building anything new.

## Where the fleet lives
One new pnpm package in **ibatexas** (scenarios are business-specific; claustrum/adjudicate stay generic): `/Users/thaisrodolpho/projects/ibatexas/packages/fleet/` —
- `src/harness/` — Agent SDK runner, pass^k executor, budget meter, report writer
- `src/validators/` — deterministic graders (subpath export `@ibatexas/fleet/validators`, also reusable from Playwright/Vitest)
- `skills/<name>/SKILL.md` — agentskills.io-spec skills; a build step copies them into repo `.claude/skills/` so Claude Code (interactive) and the SDK fleet (CI) load the SAME folders
- `scenarios/<pack>/<id>.fleet.yaml` — scenario catalog
- `personas/*.ts` — AgentDefinition objects (persona system prompts, allowedTools)

Do NOT extract a generic fleet framework into claustrum yet; revisit after 2 months of real use.

## Runtime: Claude Agent SDK
`@anthropic-ai/claude-agent-sdk` (TypeScript, pnpm-native). Each scenario run = one `query()` session with: persona AgentDefinition, skills from `packages/fleet/.claude`, `settingSources` restricted to the fleet dir (hermetic), `permissionMode:"dontAsk"` with explicit `allowedTools` (`Bash(ibx *)`, `Bash(tsx *)`, Read, Grep — never bypassPermissions, never raw Bash). Invoked by a new **`ibx fleet`** command group built on the existing `runPipeline`/StepRegistry, so seeding, locking, and `--dry-run` come free. Claude Code agent teams = interactive exploratory mode only (experimental, not CI). Plain-API harness rejected: SDK gives sessions, skill loading, hooks, and per-subagent attribution for free.

## Skills taxonomy (heavily shared)
**Driver skills** (how to act like a user):
- `drive-web-chat` — guest protocol verified in code: POST `/api/chat/messages` → capture `sessionSecret` → echo `x-session-secret` → consume SSE; or shell to `ibx api chat "..." --session <uuid>` (already exists)
- `drive-whatsapp` — `scripts/send-whatsapp.ts` computes the real Twilio HMAC (TWILIO_AUTH_TOKEN + TWILIO_WEBHOOK_URL) and posts form-encoded to `/api/webhooks/whatsapp`; no prod seam needed
- `auth-as-customer` — `scripts/mint-jwt.ts`: HS256 JWT_SECRET, `{sub: customerId, userType:"customer", jti, aud:"token"}` cookie (verified against middleware/auth.ts aud-binding); staff via STAFF_JWT_SECRET. Solves the Twilio OTP problem with zero production change
- `simulate-system-events` — `ibx stripe complete --cart`, `ibx kernel defer resume`, or `buildSystemEnvelope()`+`publishNatsEvent()` for payment.status_changed (PIX confirm path)
- `seed-env` — wraps `ibx db reset`, `ibx test seed`, `ibx scenario <yml>`, `ibx simulate`

**Validation skills** (shared by every persona; SKILL.md + thin `tsx` scripts over `@ibatexas/fleet/validators` so logic is typed and unit-tested, not bash blobs):
- `verify-order-db` / `verify-payment-db` — Prisma goal-state diff against `canTransition`/`canTransitionPayment` matrices
- `verify-audit-ledger` — SQL over `intent_audit`: expected intent kinds × decision kinds (the ledger IS the trajectory log — tau2-style action grading becomes deterministic SQL)
- `verify-nats-events` — per-run capture subscriber via @ibatexas/nats-client (net-new utility, justified: today nothing asserts event emission)
- `verify-redis-state` — `rk()`-prefixed key assertions
- `verify-admin-ui` — Playwright MCP (`@playwright/mcp`) against :3002/admin (phase 3)

Format: spec-compliant SKILL.md (name, description, allowed-tools frontmatter; scripts/, references/ for PIX flows + order-state docs); validate with `skills-ref` in CI.

## Scenario catalog (coverage enumerable)
`*.fleet.yaml` extends the existing `ibx scenario` zod schema rather than a new engine: `depends:` reuses base-customers/base-products seeding and `verify:` rules. New fleet block: `{id, businessCase, persona, channel, goal (natural language for the agent), startState, goalState (validator refs), expectedDecisions ([{intentKind, decisionKind}]), nlAssertions (judge, trend-only), pass: {k, mode: passHatK|passAtK}, covers: [tool ids]}`. Coverage = build-time matrix from `covers` × `listIbatexasToolPacks()` (17 tools) × 6 decision kinds, emitted as `fleet-report.json` + `coverage-matrix.json` artifacts — the contract the console/graph workstream renders; the testing layer does not build UI.

## Grading split
- **Gate (deterministic only):** DB goal state, intent_audit decisions, NATS events, Redis keys, HTTP statuses. Money flows (checkout, PIX, refund, cancel) gate on pass^k k=4; exploratory flows pass@2.
- **LLM judge (never a merge gate):** pt-BR tone, correctness of communicated info; cheap model; scores trended in the report with significance thresholds.
- Transcripts auto-saved (`ibx chat dump` + SDK JSONL); failed runs distill into golden replay fixtures (below).

## CI, cost, flakiness
- PR CI: unchanged deterministic suites + (phase 2) golden-conversation replay — zero LLM cost.
- Nightly workflow + on-demand `ibx fleet run [--scenario id] [--k n]`: live LLM, fresh `ibx db reset` env per run (testcontainers-style isolation per Anthropic guidance), budget meter aborting the run at a token ceiling (SDK usage events), `maxTurns` cap per session, Sonnet-class simulator model pinned and versioned (simulator choice shifts results ±9pp).
- OTLP: harness emits through @adjudicate/observability SEMCONV (`adjudicate.*` + `gen_ai.*`), trace id correlated to intent_audit rows — one trace from persona turn → kernel decision → ledger.

## Consolidation plan & resulting pyramid
**Fix now:** add test scripts to packages/domain + packages/types (turbo-wired); repair check-bypass.sh step 3; wire Playwright `smoke` + `api-golden-path` into CI.
**Keep:** pack conformance (×5), adjudicate/claustrum conformance, bypass-detection gates, kernel CI gates, unit tests for pure logic, scripted Playwright for checkout math/admin CRUD (Momentic exclude-list: financial precision + compliance stay scripted).
**Freeze/shrink:** mocked api "integration theater" (chat-integration mocked Conductor, planner golden-set) stays as contract tests but stops growing — multi-turn behavior moves to fleet + replay; wave6 red-team `.skip` docs stay; new adversarial multi-turn cases become fleet red-team scenarios reusing @adjudicate/red-team vectors.
**Net-new layer 3 — golden conversation replay** (closes ibatexas "Phase C deferred" AND claustrum layer-2 gap): record fleet transcripts (prompts+completions), replay through real bootstrap wiring with `InMemoryModelProvider` scripted completions in Vitest on PRs. Deterministic, free, catches wiring regressions.

**Pyramid:** L0 static gates → L1 unit (logic only) → L2 kernel/pack conformance + scenario fixtures (every commit) → L3 golden replay (PR) → L4 agent fleet (nightly/on-demand, pass^k) → L5 production drift-detector + obs. Failures iterate downward: every fleet failure becomes an L3 fixture or L2 scenario.

## Phases
**Phase 1 (~2 weeks, value: first real end-to-end agent runs):** packages/fleet skeleton; skills drive-web-chat, auth-as-customer, seed-env, verify-order-db, verify-audit-ledger; 10 scenarios (place/amend/cancel order, guest card checkout — avoids PIX/auth complexity); `ibx fleet run` + JSON report; fix orphaned suites + check-bypass; wire Playwright smoke into CI.
**Phase 2 (weeks 3–5):** drive-whatsapp (HMAC script), PIX scenarios + simulate-system-events, verify-nats/redis, nightly workflow with pass^k + budget meter, transcript→golden-replay recorder, coverage-matrix artifact, judge scoring.
**Phase 3 (weeks 6–8):** multi-turn red-team personas, verify-admin-ui via Playwright MCP, scenario authoring from intent_audit ("save session as scenario"), prune frozen mocked suites, hand coverage-matrix.json to console workstream.

## keyDecisions
- Fleet lives in ibatexas as one new package (packages/fleet: harness + validators + skills/ + scenarios/ + personas/) — scenarios are business-specific; no generic extraction to claustrum until proven by use
- Runtime = Claude Agent SDK (@anthropic-ai/claude-agent-sdk) TS query() sessions with AgentDefinition personas, hermetic settingSources, permissionMode dontAsk + explicit allowedTools; Claude Code (same skill folders) for interactive exploration only; orchestrated by a new `ibx fleet` command built on the existing runPipeline/StepRegistry
- Skills are agentskills.io-spec SKILL.md folders split into driver skills (drive-web-chat, drive-whatsapp, auth-as-customer, simulate-system-events, seed-env) and shared validation skills (verify-order-db, verify-payment-db, verify-audit-ledger, verify-nats-events, verify-redis-state, verify-admin-ui); scripts/ are thin tsx wrappers over a typed @ibatexas/fleet/validators package
- Auth: mint customer/staff JWTs directly (HS256 JWT_SECRET, aud:'token' — verified against middleware/auth.ts) for seeded customers, guest chat via the existing sessionSecret protocol, WhatsApp via locally computed Twilio HMAC — zero production auth changes, no OTP bypass seam
- Scenario catalog extends the existing ibx scenario YAML engine (depends/verify reused) with a fleet block: persona, channel, goal, goalState validators, expectedDecisions (intentKind×decisionKind ledger assertions), nlAssertions, pass policy, covers[] — coverage matrix (17 tools × 6 decisions) generated from front-matter into coverage-matrix.json for the console workstream
- Grading: deterministic validators (Prisma goal-state diff, intent_audit SQL as the trajectory oracle, NATS capture, rk() Redis keys) are the only gates; LLM judge is trend-only and never blocks merges; money flows gate on pass^k (k=4), exploratory on pass@2
- CI: PRs run only deterministic layers plus (phase 2) golden-conversation replay of recorded fleet transcripts via InMemoryModelProvider through real bootstrap wiring; live-LLM fleet runs nightly + on-demand with fresh ibx db reset env, pinned simulator model, maxTurns cap, and a hard token-budget abort
- Consolidation: keep conformance/static-gate/unit layers; freeze (not delete) mocked Conductor/planner contract tests; immediately fix orphaned packages/domain + packages/types test scripts, stale check-bypass.sh step 3, and wire Playwright smoke + api-golden-path into CI
- Resulting pyramid: L0 static gates → L1 unit → L2 kernel/pack conformance (every commit) → L3 golden replay (PR) → L4 agent fleet (nightly, pass^k) → L5 production drift/obs, with every fleet failure distilled downward into an L3/L2 fixture
- Observability: harness emits via the existing @adjudicate/observability OTLP exporter using frozen adjudicate.* SEMCONV plus gen_ai.* attributes, correlating fleet trace ids to intent_audit rows; fleet-report.json is the contract artifact for the visibility/console workstream — the testing layer builds no UI

## risks
- LLM-judge and simulator nondeterminism: judge disagreement and simulator-model choice shift outcomes (±9pp per research) — mitigated by deterministic-only gates, pinned simulator model versions, and weekly transcript review, but trend metrics will still be noisy early
- Token cost of nightly pass^k runs (k=4 across money flows, multi-turn) can balloon — the budget meter and scenario-count discipline (20–50, not 'all business cases') are the controls; expect to tune k and scenario set in the first month
- JWT-minting skill requires JWT_SECRET in the fleet environment; if fleet runs ever point at a shared/staging env this becomes a credential-handling risk — restrict to local/ephemeral envs and never ship the skill outside the repo
- PIX end-to-end cannot complete without Stripe sandbox events; `ibx stripe complete --cart` and synthetic payment.status_changed envelopes are simulations, so a class of real-PSP integration bugs stays invisible to the fleet
- payment.method.switch and payment.retry have no registered tool handlers (dispatch to tool_unresolved) — conversation-driven scenarios for those flows will fail for product reasons, not test reasons; scope them out until WS4 lands
- Golden-conversation replay fidelity: recorded completions go stale as prompts/prompt-graphs evolve; without a re-record workflow (fleet rerun → fixture refresh) L3 will rot into permanent-skip territory like wave6
- Environment isolation relies on full `ibx db reset` per run (destructive, serial); parallel fleet runs on one machine will collide on Postgres/Redis/NATS until per-run APP_ENV prefixes or testcontainers-per-worker are added
- Claude Agent SDK billing change (June 15, 2026 separate Agent SDK credit) and its fast-moving API surface may force harness rework; pin SDK versions and isolate SDK usage behind the harness module

## avoid
- Do not build agents to 'cover all business use cases' — exhaustive enumeration belongs to deterministic pack-conformance fixtures (cheap, already exist); the fleet covers the 20–50 highest-value multi-turn journeys sourced from real failures
- Do not run the live-LLM fleet on PR CI or use LLM-judge scores as merge gates — cost, latency, and flakiness will destroy trust in the suite; PRs get deterministic layers + recorded replay only
- Do not add an OTP/auth bypass endpoint to the API for testing — JWT minting with the existing secret achieves the same with zero production attack surface; an env-flag bypass seam is exactly the kind of thing your own bypass-detection suite exists to prevent
- Do not build a new scenario engine or a parallel seeding system — extend ibx scenario YAML, runPipeline, and the existing seed/reset/simulate commands; a second engine doubles the maintenance burden you already fear
- Do not adopt @langwatch/scenario or ADK as the fleet runtime — the Agent SDK plus your own validators covers the need with skills as the differentiator (shared across interactive Claude Code and CI); borrow tau2/ADK shapes (goal-state grading, pass^k, conversation_plan personas) as conventions, not dependencies
- Do not delete the mocked api contract tests (chat-integration, planner golden-set) when the fleet arrives — freeze them as wiring contracts; deleting them removes your only millisecond-fast turn-pipeline regression signal
- Do not start the React agent-workflow graph UI before fleet-report.json/coverage-matrix.json exist — visual authoring is the industry's failed bet (OpenAI Agent Builder shutdown); viewers over real run artifacts are the proven pattern, and the artifact contract comes first
- Do not write skills as opaque bash blobs — every validation skill script must be a thin wrapper over typed, unit-tested functions in @ibatexas/fleet/validators, or the skill layer becomes the next untested codebase

# ===== ARCHITECT: platform =====

# Server-Side Managed Agents: Platform Blueprint

## 1. What a managed agent IS

A managed agent is **not a new runtime**. It is a versioned **AgentProfile** bound to the existing claustrum Conductor loop: `{identity, triggers, capability allowlist, prompt fragments, model binding, budgets, autonomy tier, escalation route}`. A managed-agent *run* is an ordinary `openCapsule → handleTurn → closeCapsule` invocation whose entry is a synthetic ChannelMessage built from a trigger event, not a human message.

Kernel doctrine is preserved exactly:
- The trigger event carries **zero authority**. The capsule actor for a triggered turn is `principal: "system"` (via the existing `OpenCapsuleInput.actor` override, conductor.ts:79/151, per ADR-0004), but every envelope the agent's LLM planner emits stays `actor.principal: "llm"`, `taint: UNTRUSTED`, proposed via `express_intent` only. No taint elevation for being "server-resident."
- Agents do not get new tools. They get a **narrower** capability allowlist over the existing 17 pack tools (`register-ibatexas-tool-packs.ts`), enforced two ways: planner-side (CapabilityPlanner subset) and kernel-side (PolicyBundle composed per-agent by TenantResolver — the existing per-turn policy assembly seam).

Where code lives: `packages/agent-profiles` in ibatexas (zod manifest + per-agent TS modules); `@claustrum/channel-trigger` in claustrum (new adapter package); one ~3-line core edit widening `ChannelKind` to include `"trigger"` (channel.ts:23 — this is the only core change required; everything else is adopter-side, exactly the WebChannelStub pattern).

## 2. Triggering: a ChannelDriver adopter + a thin TriggerRouter (net-new, small)

`handleTurn` is strictly ChannelMessage-shaped, so a trigger IS a ChannelDriver: `@claustrum/channel-trigger` implements `perceive()` (deserialize event payload into perception + structured workingMemory), `render()` (route output to WhatsApp via existing channel, or audit-only), `matchToParked()` (match events to DEFER signals — this generalizes ibatexas's existing `defer-resolver.ts`, which already resumes parked checkout envelopes on `payment.status_changed`; that subscriber is the proof the pattern works).

Net-new infra #1: **TriggerRouter** in `apps/api` (later `apps/agents` worker): NATS JetStream WorkQueuePolicy streams per domain, one durable pull consumer per AgentProfile trigger, `Nats-Msg-Id` dedup, **ack-after-audit-commit** so redelivery is safe (intentHash dedup in the kernel absorbs duplicates — effectively-once is already solved, don't rebuild it). Justification: today claustrum has no non-conversational ingress at all; this is the genuinely missing piece. Plain-NATS subscribers exist in ibatexas but lack durability/replay for agent triggers.

Net-new infra #2: **Deferred-work scheduler** — generalize the existing `defer-timeout-sweeper.ts` BullMQ job into a wake scheduler that opens trigger turns for due DeferredEnvelopes and scheduled agent runs. Today deferrals only resume when the user happens to message; that gap is real and cheap to close with BullMQ (already in the stack). Durable timers = Postgres rows + BullMQ, not a new engine.

## 3. First agents, and what stays deterministic

**Agent #1: PIX payment-failure remediation.** Trigger: `payment.status_changed → failed/expired`. Goal: recover the checkout — draft a WhatsApp outreach, propose `payment.pix.regenerate` or method switch, escalate when ambiguous. Why first: triggers, tools, policies, jobs (pix-expiry-monitor) and escalation paths all exist; outcome is measurable (recovered orders); failure mode is bounded (worst case = no outreach, which is today's behavior).

**Agent #2 (later): escalation triage.** Trigger: `order.escalation_needed` / `support.handoff_requested`. Draft-only forever-ish: gathers context (order projection, audit trail, conversation archive), drafts a staff action into the admin console.

**Stays deterministic (explicit):** PIX expiry transitions, reminder messages, order status transitions, reservation confirmations, webhook processing, anonymize grace flows. These are working BullMQ/NATS handlers. Converting them to agents is the documented 8x-cost anti-pattern. Honest critique: "expert agents triggered in complex situations" over-scopes — in this stack, almost every complex situation is a deterministic workflow with one ambiguous step. The agent owns only the ambiguous step (what to say, which remedy to propose); the workflow stays code.

## 4. Durability: no Temporal/Inngest/Hatchet

At this scale (single restaurant business, turns measured in seconds), DEFER park/resume + intentHash + JetStream ack-after-commit **is** the durable substrate. A crashed turn is safely *re-run*, not resumed: redelivery re-proposes, kernel dedups, tool idempotency keys (`runId+stepIdx` propagated to Medusa/Stripe) absorb side effects. Long waits are already zero-process suspension (parked envelopes in Redis/Postgres). Add only a `agent_runs` journal table (runId, agentId+version hashes, triggerMsgId, turnIds, status, token spend) for visibility and crash forensics — not step-level replay.

## 5. Agent definition: versioned, testable, reviewable

AgentProfile = TypeScript module + zod manifest in `packages/agent-profiles`, PR-reviewed, with: content-addressed prompt fragments (claustrum FragmentRegistry — versioning already solved), pinned model id, capability allowlist, budget caps, autonomy tier. Governance reuses adjudicate machinery: profile lint as a conformance-style check (capabilities must exist in the roster, composed policy passes `kernel analyze`), AI-BOM entry per profile (`pack-bom --verify` pattern, already a CI gate), `intent_audit` rows tagged with `agent.id@version`. In-flight version pinning is free: store fragment/policy hashes in `agent_runs`, resolve by hash on resume.

Testing reuses the existing stack wholesale: scenario fixtures (`adjudicate simulate --scenarios` contract), pack conformance, golden trigger-fixtures (event JSON + seeded state + expected decision sequence) run in Vitest with the InMemoryModelProvider/StubAdjudicator doubles, plus the agent-testing fleet from goal #1 as the live tier.

## 6. Budgets and approval gates

- Extend the existing `llm:tokens` Redis budget (resolve-and-assemble.ts:36) with per-run and per-agent-day counters checked at the ModelProvider boundary.
- **Enforcement lives in the kernel, not prompts**: TenantResolver injects a budget snapshot into SystemState; a PolicyBundle guard ESCALATEs over-budget proposals. Auditable, replayable.
- Turn-chain cap per trigger correlation id (agent self-continuation bounded, cap-hit → ESCALATE).
- Autonomy ladder = policy values, no new mechanism: **draft-only** (every mutating envelope REQUEST_CONFIRMATION-gated, surfaced via @adjudicate/approval-engine into the console/staff WhatsApp) → **confirm-gated** → **auto-under-threshold** (e.g., pix.regenerate auto; refunds always confirm). Kill switch: existing console Control panel state checked before openCapsule; fleet stop via governance event.

## 7. Rollout without shadow mode

Doctrine forbids un-audited shadow decisions. Substitute: (a) **replay evidence** — run candidates against recorded production triggers in a sandboxed tenant/schema (ibx-seeded) via existing replay CLIs + scenario diffs; (b) **draft-only production** — the agent runs live, fully audited, but humans execute everything (this is shadow mode's evidence value without doctrine violation); (c) **canary** by trigger-percentage with @adjudicate/drift monitoring REFUSE/ESCALATE-rate deltas as the rollback trigger — a stack-native canary metric.

## 8. Phases

**Phase 1 (~2 weeks, ships value):** ChannelKind widening + `@claustrum/channel-trigger`; AgentProfile manifest v0; JetStream consumer for `payment.status_changed`; PIX remediation agent in draft-only mode with approval-engine surfacing; `agent_runs` table; observe via `intent_audit` + `ibx obs`. Value: staff stop manually chasing failed PIX payments.

**Phase 2 (~3-4 weeks):** wake scheduler; budget guard + turn-chain caps; autonomy ladder to auto-under-threshold for pix.regenerate; SEMCONV `gen_ai.agent.*` attributes on runs; golden trigger-fixture CI suite; profile lint + AI-BOM gate.

**Phase 3:** escalation-triage agent; rollout controller (version pinning, canary, drift rollback); console Agents view (runs timeline + declared trigger→agent→tool graph); compensation registry only if multi-intent plans materialize.

## keyDecisions
- A managed agent is a versioned AgentProfile over the existing claustrum loop, not a new runtime: trigger events carry zero authority, agent-emitted envelopes stay principal=llm/UNTRUSTED via express_intent, and per-agent narrowing happens in TenantResolver-composed PolicyBundles — kernel doctrine untouched.
- Triggers are a ChannelDriver adopter: widen ChannelKind to add "trigger" (the only claustrum core edit, channel.ts:23) and build @claustrum/channel-trigger on the WebChannelStub pattern; matchToParked generalizes ibatexas's existing defer-resolver.ts.
- Trigger transport is NATS JetStream WorkQueuePolicy + durable pull consumers with ack-after-audit-commit; kernel intentHash dedup makes redelivery safe — effectively-once is already solved, do not rebuild it.
- No Temporal/Inngest/Hatchet at this scale: DEFER park/resume + intentHash + JetStream + tool idempotency keys (runId+stepIdx) cover durability; crashed turns are re-run, not resumed; add only an agent_runs journal table for visibility.
- Close the real deferred-work gap with a BullMQ wake scheduler (generalize defer-timeout-sweeper.ts) so due DeferredEnvelopes and scheduled runs fire without waiting for an inbound message.
- First agent is PIX payment-failure remediation (trigger: payment.status_changed failed/expired) in draft-only mode; second is escalation triage; all existing deterministic jobs (expiry transitions, reminders, status machines) stay deterministic code.
- AgentProfile = PR-reviewed TypeScript + zod manifest in packages/agent-profiles, with content-addressed prompt fragments (FragmentRegistry), pinned model, capability allowlist, budgets, autonomy tier; governed by conformance-style profile lint, kernel analyze, and AI-BOM CI gates.
- Budget enforcement lives in the kernel, not prompts: extend the existing llm:tokens Redis meter to per-run/per-agent-day, inject budget state into SystemState via TenantResolver, and let a PolicyBundle guard ESCALATE over-budget proposals; turn-chain caps per trigger correlation id.
- Autonomy ladder is pure policy configuration: draft-only (REQUEST_CONFIRMATION on every mutation via @adjudicate/approval-engine) -> confirm-gated -> auto-under-threshold; kill switch reuses the console Control panel checked before openCapsule.
- Rollout evidence without shadow mode: replay recorded triggers in a sandboxed tenant via existing replay CLIs, then draft-only production (live, audited, human-executed), then trigger-percentage canary with @adjudicate/drift REFUSE/ESCALATE-rate deltas as the automated rollback signal.

## risks
- ChannelKind widening is a claustrum core API change consumed by ibatexas via npm — requires a coordinated version bump and may ripple through exhaustive switch statements on the union; budget a claustrum release cycle into Phase 1.
- Draft-only mode creates real staff workload (approving every agent proposal); if approval volume is high or the console UX is slow, staff will rubber-stamp, destroying the evidence value of the rollout phase.
- Re-run-instead-of-resume durability depends on tool idempotency keys actually reaching Medusa/Stripe/Twilio; any non-idempotent side effect outside the kernel path (e.g., WhatsApp sends) can duplicate on JetStream redelivery — outbound messaging needs its own dedup key before Phase 1 ships.
- The wake scheduler introduces a second mutation ingress (system-opened turns); per-session locking via SessionLock must serialize scheduler-opened turns against live customer conversations or two turns can race on one session (InMemorySessionLock is single-replica only — needs the Postgres advisory lock impl).
- claustrum SessionPort save/load are TODO stubs in ibatexas (history lives on dev Redis only); agent runs that span days via DEFER depend on session durability that does not fully exist yet.
- Per-agent PolicyBundle composition in TenantResolver adds a policy variant per agent version; without the profile-lint/kernel-analyze gate enforced in CI from day one, policy drift across agent versions will be invisible until an audit.
- Decision-rate canary metrics (REFUSE/ESCALATE deltas) have low statistical power at this business's event volume — a single restaurant's payment-failure rate may take weeks to surface a regression; pair with replay evidence rather than relying on canary alone.
- Stale repo signals (deleted PROJECT_STATUS docs, stale 'INERT' comment in register-ibatexas-tool-packs.ts, missing docs referenced by CLAUDE.md) will mislead both human reviewers and coding agents building this layer — clean them up in Phase 1 or the new packages inherit confusion.

## avoid
- Do NOT adopt Temporal/Inngest/Restate/Hatchet now: every one duplicates what DEFER park/resume + intentHash + JetStream already provide at this scale, and adds a cluster or pricing model the two-person ops budget cannot carry; revisit only if turns become multi-minute multi-step plans.
- Do NOT build step-journaled full resumability of the cognitive loop: turns are cheap and idempotently re-runnable through the kernel; a run journal for forensics is enough.
- Do NOT convert existing deterministic jobs (pix-expiry-checker, order status transitions, reservation confirmations, reminders) into agents — that is the documented 8x-cost anti-pattern; the agent owns only the ambiguous step.
- Do NOT host on Anthropic Managed Agents / Bedrock AgentCore / LangSmith Deployment yet: the kernel-gated loop must stay in-process where adjudicate intercepts every proposal; external hosting reopens the bypass surface check-bypass.sh exists to close.
- Do NOT build an MCP server / A2A facade for the 17 tools in this workstream: no external consumer exists today; it is a clean later phase once agents are stable.
- Do NOT weaken taint for server-resident agents (no SYSTEM-taint envelopes from LLM planners 'because the trigger was a system event') — that would silently disable the UNTRUSTED guard floor that AC-001 and the bypass suites protect.
- Do NOT build a multi-agent broker/coordinator or PlannerProfile routing layer (claustrum v0.6 roadmap territory): with two agents, routing is one JetStream consumer per profile; a broker is speculative infrastructure.
- Do NOT implement classic shadow mode by running un-audited kernel decisions on production traffic — it violates the audit doctrine; use replay-in-sandbox plus draft-only production instead.

# ===== ARCHITECT: ops =====

# Operations & Observability Blueprint

## Stance
You already own the hard parts: a partitioned `intent_audit` system-of-record, a 15-route operator console, a frozen `adjudicate.*` SEMCONV, replay/simulate/red-team CLIs, and `ibx`. The visibility gap is **correlation IDs + aggregation views**, not new telemetry infrastructure. The minimum viable set is: one ID scheme, one run-record table, one registry gate, two console pages. Everything else is phased.

## 1. Trace & correlation model (one scheme for test fleet AND managed agents)
- **New SEMCONV keys (add-only)** in `packages/observability/src/semconv.ts`: `adjudicate.agent.id`, `adjudicate.agent.version`, `adjudicate.skill.name`, `adjudicate.sim.run.id`, `adjudicate.sim.scenario.id`, `adjudicate.sim.persona`. Same registry, same deprecation rules — no second namespace.
- **OTel GenAI spans** emitted from a claustrum `TelemetryPort` adapter in ibatexas (`apps/api`), through the existing `@adjudicate/observability` Exporter: `invoke_agent {agent}` (turn) → `chat {model}` (ModelProvider) → `execute_tool {tool}`. Emit `gen_ai.*` alongside `adjudicate.*`; pin `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` and version-tag (spec is still Development).
- **Span↔ledger join**: spans already carry `adjudicate.intent.hash`; that is the join key. **Do not add metadata to IntentEnvelope/AuditRecord** — verified neither has a slot, and forking the hashed contract is a cross-repo migration. Instead the sim harness records `runId → sessionIds` (it creates every session), and audit rows carry `actor.sessionId`. Join in SQL.
- **TRACEPARENT** propagated from the Agent SDK test fleet → HTTP → claustrum `traceId`, so one distributed trace spans simulator → loop → kernel → ledger.

## 2. Storage: build on the audit ledger; Langfuse explicitly deferred
- Phases 1–3 are **Postgres-only**: new tables `sim_runs` (runId, startedAt, gitSha, agentId, scenarioId, sessionIds[], model, promptGraphHash, policyVersion, verdict) and `sim_results` (per-assertion outcome). Phase 3 adds `claustrum_llm_traces` keyed by `traceId + promptManifest` hash via `boundLLMTrace()` — this fills claustrum's roadmap v0.5 trace-store gap and unlocks replay-by-manifest.
- **Langfuse decision: not now.** It adds ClickHouse + S3/MinIO to a one-team ops surface. Adopt only when (a) console views are exhausted for ad-hoc trace exploration AND (b) trace volume makes Postgres queries slow. When adopted, point the existing OTLP exporter at `/api/public/otel` — zero code change, which is exactly why deferring is safe. Phoenix (single container, your Postgres) is the fallback if budget is tighter.

## 3. Console: extend adjudicate console (NO new app), max three new routes
Follow the established admin-sdk schema → handler → tRPC → hook → page pattern. Keep ibatexas specifics behind the registry/adapter pattern (precedent: AdapterTrace registry slot).
1. **`/agents`** — registry view: id, owner, version, skills, packs, trigger type; per-agent decision distribution + token spend from the ledger; **per-agent kill switch**.
2. **`/coverage`** — scenario coverage matrix: rows = business scenarios (pack `scenarios/` fixtures + sim scenarios), columns = agent × decision-kind (and a tools view); cells = pass/fail/untested + last-run timestamp from `sim_results`. promptfoo's matrix is the rendering reference.
3. **`/runs/[runId]`** — run explorer on Temporal's triad: Compact (per-loop-stage grouping), Timeline (Gantt of stages, model calls, tool executions, decisions), Raw (ledger + TurnRecord events); rows deep-link to existing `decisions/[intentHash]` pages.
Plus two buttons, not pages: **"save as scenario fixture"** on decision detail (audit row → simulate-scenario JSON per `docs/guides/testing-your-policy.md` contract — the adk-web record-as-eval pattern) and **replay-from-console** wiring the existing `admin-sdk replay.run`.

## 4. The React graph UI
`@xyflow/react` + dagre **inside the console**, strictly a **viewer**: declared topology JSON assembled from the agent registry + `listIbatexasToolPacks()` + `describePolicyBundle`; runtime overlay = edge weights aggregated **from the audit ledger** (agent → tool kind → verdict distribution), not from spans — the ledger is the system of record and survives sampling. Per-trace path highlighting links nodes to the run explorer. No authoring canvas: the industry verdict (OpenAI killed Agent Builder; DevUI/Temporal-style viewers thrive) matches your maintenance fear.

## 5. Agent/skill registry + drift gates
- **`packages/agent-registry`** in ibatexas: one YAML per agent — id, owner, purpose, model, promptGraphHash, policy packs, skills consumed, scenario IDs covered, trigger (human/event/cron), budget ceiling. Skills live as spec-compliant `SKILL.md` folders (shared package), validated by `skills-ref` in CI.
- **`agentRosterDrift()`** boot/CI gate mirroring `toolRosterDrift()`: registry ↔ skills dirs ↔ tool packs ↔ scenario files. Fold agents into the existing AI-BOM (`generateAiBom`) so `pack-bom --verify` covers them — one drift mechanism, not two.
- **Scenario lint**: every scenario names an owning agent + pack; orphans fail CI.

## 6. Dev workflow
Add a scenario: write the fixture (existing adjudicate contract + tau2-style goal-state block) → `ibx sim run <scenario>` seeds via `ibx test seed`, drives the loop, prints the diff table, writes `sim_runs/sim_results` → see it in `ibx sim report` (terminal matrix) or local console `/coverage`. Add a skill: SKILL.md folder + registry YAML entry; drift gate enforces. Whatever simulation framework the testing track picks, it must emit `sim_runs` rows — the contract is the table, not the framework.

## 7. CI gates and runbook deltas
- **PR gate (deterministic only)**: conformance, scenario replay (cached/mocked model), registry drift, coverage regression (covered→untested flip fails). **Nightly**: live-LLM sims, pass^k (k=4) on pack-payments/pack-orders; LLM-judge scores trended, never merge-gating.
- **New alert classes**: REFUSE/ESCALATE rate deltas via the existing `@adjudicate/drift` detector (wire to alerting — it exists, unalerted today); budget breach (new Redis meter at the ModelProvider port: tokens/cost per runId/agent/day, surfaced by extending TokenBudgetPanel); stuck DEFER/parked envelopes (extend `reap`); nightly sim failure; DLQ depth (`ibx dlq` exists).
- **Kill-switch scope**: per-agent kill = pause its JetStream consumer + kernel kill-switch on its capabilities; global stays on the existing Control page.

## 8. Phased rollout
- **Phase 1 (~2 weeks, immediate value)**: SEMCONV additions; `ibx sim` runner skeleton (wraps `simulate --scenarios` + the existing `ibx api chat` driver) writing `sim_runs/sim_results`; `packages/agent-registry` + CI drift gate; hygiene fixes agents will trip on (stale `check-bypass.sh` step 3, stale "INERT" comment, restore status docs). Deliverable: Audit Explorer answers "which agent called what, testing which scenario" via the sessionId join; CI guards the registry.
- **Phase 2 (3–4 weeks)**: console `/coverage` + `/agents`; save-as-scenario + replay-from-console; `gen_ai.*` span emission from the TelemetryPort adapter.
- **Phase 3 (4–6 weeks)**: `/runs` explorer + React Flow graph view; `claustrum_llm_traces` store + replay-by-manifest; budget meter + alert wiring + per-agent kill switch.
- **Phase 4 (optional, criteria-gated)**: Langfuse self-host.

## keyDecisions
- Build run/trace visibility on the existing Postgres audit ledger + new sim_runs/sim_results tables; explicitly DEFER Langfuse (ClickHouse+S3 ops cost) behind stated adoption criteria — the OTLP exporter makes later adoption a config change, not a rewrite
- Single correlation scheme added add-only to the existing frozen SEMCONV (adjudicate.agent.id, adjudicate.sim.run.id, adjudicate.sim.scenario.id, skill.name, persona) — no second attribute namespace, no per-repo registries
- Do NOT add metadata fields to IntentEnvelope/AuditRecord (verified: no slot exists; the envelope is hash-bearing). Correlate spans→ledger via the already-documented adjudicate.intent.hash join key, and sim runs→ledger via sim_runs.sessionIds ↔ intent_audit actor.sessionId
- Emit OTel GenAI semconv (invoke_agent → chat {model} → execute_tool) from a claustrum TelemetryPort adapter in apps/api through @adjudicate/observability's Exporter, alongside adjudicate.* attributes; pin gen_ai_latest_experimental since the spec is still Development
- Extend the adjudicate console — never a new app — with at most three routes (/agents, /coverage, /runs/[runId]) using the established admin-sdk schema/handler/tRPC/hook/page pattern; ibatexas specifics enter via the registry/adapter-slot pattern already used by AdapterTracePanel
- Graph UI = @xyflow/react + dagre VIEWER in the console: declared topology from agent registry + listIbatexasToolPacks() + describePolicyBundle, runtime overlay aggregated from the audit ledger (not spans — ledger is the system of record and survives sampling). No authoring canvas, ever
- Agent/skill registry = checked-in YAML per agent in packages/agent-registry + SKILL.md folders validated by skills-ref; enforce with an agentRosterDrift() CI/boot gate mirroring toolRosterDrift() and fold agents into the existing AI-BOM so pack-bom --verify covers them
- Coverage matrix is data-first: the contract is the sim_runs/sim_results tables written by an `ibx sim` runner (wrapping simulate --scenarios and ibx api chat), so any simulation framework the testing track picks plugs in; console /coverage and `ibx sim report` are just views
- Replay-from-console wires the EXISTING admin-sdk replay.run; add a 'save audit record as scenario fixture' button (adk-web record-as-eval pattern) using the existing scenario fixture contract — closing the production-failure→scenario loop with zero new formats
- Ops gates: PR = deterministic only (conformance, cached replay, registry drift, coverage regression); nightly = live-LLM pass^k on money flows with judge scores as trends; kill-switch scope for managed agents = pause JetStream consumer + kernel capability kill-switch per agent; budgets metered at the ModelProvider port in Redis, surfaced via the existing TokenBudgetPanel

## risks
- OTel GenAI semconv is still Development status — attribute renames upstream (e.g. gen_ai.system→provider.name already happened) can break dashboards; mitigate by treating adjudicate.* as the stable layer and gen_ai.* as best-effort, version-tagged emission
- The sessionId join depends on the sim harness faithfully recording every session it opens; a missed sessionId silently drops audit rows from run views — make sim_runs writes transactional with session creation in the runner, and alert on audit rows from sim-tagged time windows with no run match
- Console lives in the adjudicate repo but /agents and /coverage need ibatexas data (registry, sim tables) — cross-repo coupling risk; keep tRPC procedures generic (registry/coverage schemas in admin-sdk, data via adopter-supplied handlers) or the console silently becomes ibatexas-specific
- Each new console page is permanent maintenance for a team that already fears complexity — the three-route cap is load-bearing; if phase 2 scope creeps past coverage+agents, phase 3 should be cut rather than stacked
- Nightly live-LLM sim runs have real token cost and judge nondeterminism; without the budget meter (phase 3) arriving close behind the runner (phase 1), a misconfigured nightly loop is an unbounded spend incident — consider a crude env-var token cap in the runner from day one
- agentRosterDrift CI gate can false-positive during normal development (new skill added before registry YAML), blocking CI and training developers to bypass it — ship it with a clear fix-it message and an `ibx registry sync` helper
- claustrum_llm_traces fills a roadmap gap (v0.5) in a library you also maintain — implementing it ibatexas-side first risks divergence when claustrum ships its own trace store; build it as a claustrum package (memory-postgres sibling) consumed by ibatexas, not as app code
- Stale artifacts actively mislead agent-driven workflows today (check-bypass.sh step 3 no-ops against a deleted package, the 'INERT' comment contradicts live wiring, deleted status docs still referenced) — any agent fleet reading the repo will inherit these errors; phase 1 must include the hygiene fixes

## avoid
- Do not stand up Langfuse (or any ClickHouse+S3 trace platform) in phase 1 — it is the single largest avoidable ops burden on the table, and the OTLP exporter means adopting it later costs a config change; exhaust the ledger-backed console views first
- Do not build a drag-and-drop agent workflow EDITOR — the user's 'React-drawn graph UI' instinct is right only as a viewer; visual authoring is the pattern the industry just abandoned (OpenAI Agent Builder killed 8 months post-launch) and would be pure maintenance debt
- Do not derive the agent graph primarily from OTel spans — spans are sampled, lossy, and not the system of record; the audit ledger already records agent→tool→verdict and must be the aggregation source, with spans as drill-down detail only
- Do not add scenario/agent metadata fields to IntentEnvelope or AuditRecord — the envelope is the hashed, frozen wire contract across three repos and external replay corpora; correlation belongs in spans, sessionId joins, and sim_runs, not in the kernel schema
- Do not build a new Next.js observability app or a parallel dashboard in ibatexas — the adjudicate console with its admin-sdk pattern is the established surface; a second console doubles auth, deploy, and component maintenance forever
- Do not invent a new scenario/run file format — the adjudicate scenario fixture contract (testing-your-policy.md), the ibx scenario YAML engine, and the CLI exit-code conventions already exist; the coverage matrix must consume these, not a parallel schema
- Do not make LLM-judge scores or live-LLM simulation runs PR merge gates — they are nondeterministic and costly; PRs gate on deterministic checks (conformance, cached replay, drift, coverage regression), live runs go nightly with pass^k and trended scores
- Do not create separate observability stacks for the test fleet and future server-side managed agents — design the ID scheme, span model, registry, and kill-switch scope once so both populations land in the same ledger, same console, same alerts