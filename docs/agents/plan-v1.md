# Agents & Agent-Driven Testing Plan for adjudicate / claustrum / ibatexas

*Produced 2026-06-11 from a multi-agent deep-read of all three repos (HEAD of main), an industry research sweep (Google, OpenAI, Anthropic, Microsoft, agentic-testing vendors), two competing designs, and three adversarial critique passes verified against the actual source.*

---

## 1. Verdict on the idea

Your instinct to separate **testing agents** from **managed business agents** is right and survives review. Two amendments matter:

**Amendment 1 — you already have a production skill system; don't build a second one.**
A production "skill" in this stack already exists as the pack shape: `{ToolDefinitions, CapabilityPlanner, PolicyBundle, refusals}` — `packages/pack-orders/src/{capabilities,policies,refusals,types,index}.ts` plus the 17 `ToolDefinition`s in `apps/api/src/tools/register-ibatexas-tool-packs.ts`, registered into `@claustrum/core`'s `createToolRegistry` with the `capability === intentKind` invariant enforced by `toolRosterDrift()` at boot. A new `PlaceOrderSkill` abstraction would be a third restatement of `order.place` that must be kept coherent with the pack planner and the tool roster — drift surface, not reuse.

**Amendment 2 — testing skills and production skills must NOT share action implementations.**
A production agent mutates in-process (envelope → `buildAdjudicator()` → tool handler). A testing agent's "place order" must go through the **public surface** (`POST /api/chat/messages` + SSE, or the HTTP routes) — otherwise it bypasses auth, route validation, `customer-intent-gateway.ts` forgery defenses, and confirmation round-trips, and certifies a system that doesn't exist. Conversely, verification skills (read Postgres, `intent_audit`, NATS) must be **structurally unreachable** from any production agent.

**What IS shared — and is the real "skills first" deliverable — is the deterministic verification library** (the oracle kit). The testing agents consume it in Phase 1; the managed agents' acceptance tests consume the same functions in Phase 3. Shared verification, not shared actions.

---

## 2. What the industry converged on (mid-2026)

The unanimous pattern across every credible player: **LLM at the edges, determinism in the loop.**

- **Google (ADK 2.0, A2A, Agent Engine):** abandoned free-form hierarchical agents for a graph-based workflow runtime — determinism (routing, retries, HITL, state) owned by the engine, LLM autonomy an explicit bounded slider. ADK's eval framework asserts **tool trajectories with EXACT / IN_ORDER / ANY_ORDER matchers** — directly adoptable over your `intent_audit`. A2A is Linux Foundation-governed v1.0 (JS SDK exists) — relevant only when you have cross-org agent traffic (you don't yet). Per-agent attested identity (SPIFFE) as the authorization principal; governance at I/O chokepoints (Agent Gateway + Registry).
- **OpenAI (Agents SDK, Responses API):** agents-as-config — a typed bundle of model + instructions + tools + handoffs + guardrails consumed by a small generic runner. They **killed the visual Agent Builder** (~14 months) and are **winding down the hosted evals platform (gone Nov 2026)** — lessons: typed config beats visual builders; own your evals in your own CI.
- **Anthropic (Agent SDK, Skills, MCP):** SKILL.md progressive disclosure (~100-token description always in context, body on activation) is now an open standard read by 32+ tools — the right *packaging* format for capability docs, later. Governance lives in the harness at the tool boundary (hooks), not in the prompt. Sub-agent hierarchies kept shallow; cheap models for read-only exploration. Evals playbook: 20–50 tasks harvested from real failures, code graders first, LLM-judges last and human-calibrated.
- **Microsoft (Agent Framework / Foundry):** typed graph workflows with checkpoint/rehydrate; HITL as a **typed, durable request/response object** (never a callback) — which is exactly what your kernel's `REQUEST_CONFIRMATION` + park/resume already is; "does this need a human?" should be a kernel decision — adjudicate already owns that predicate. Treat checkpoint/journal storage as a trust boundary (schema-validated plain JSON only).
- **Testing vendors (QA Wolf, Momentic, Playwright Agents, Antithesis, testRigor):** two-phase architecture everywhere — LLM agents author/heal tests, CI executes deterministic artifacts. Assertions stratified: exact (code) / backend (SQL, events) / LLM-judge (rare, marked). Retry-pass is recorded as **flake, not pass**; healers run only on failure, bounded, output reviewed by humans. The #1 flake source in CQRS systems is read-after-write projection lag — kill it structurally with an await-projection barrier, never sleeps.

**Your differentiator, confirmed:** a deterministic governance kernel with canonical-hashed envelopes, a six-outcome decision algebra, an append-only event log, and replayable audit records makes *everything exactly assertable*. None of the big-vendor stacks have this layer; most testing vendors fake it with screenshots. Don't squander it on LLM-judge assertions.

---

## 3. What actually exists in your repos (corrections to "I have no agents or skills")

Live and load-bearing today (verified in code):
- ibatexas chat + WhatsApp run through claustrum's `handleTurn` 7-step loop (`bootstrapClaustrum()` invoked in `apps/api/src/index.ts:93`; `routes/chat.ts`, `routes/whatsapp-webhook.ts` call `getConductor()`).
- "Claustrum proposes, adjudicate decides" is real: planner (`createIbatexasPlanner`) emits `express_intent` → `IntentEnvelope` (principal `"llm"`, taint `UNTRUSTED`) → `buildAdjudicator()` → `adjudicateAndAudit` → fail-closed audit to Postgres/NATS → dispatch only on EXECUTE/REWRITE.
- 17 LLM-callable tools, per-pack CapabilityPlanners, six-outcome dispatch with park/resume, Redis SessionPort, claustrum Postgres memory + pgvector grounding, `ibx` CLI (31 commands incl. `kernel replay`, `scenario`, `matrix`, `simulate`), 294 vitest files, bypass-detection CI gate, conformance suites, config seals, AI-BOM gate.

Gaps that define the work (all verified):
1. **Execution Ledger not wired** — `buildAdjudicator({ sink: getAuditSink() })` (`claustrum-bootstrap.ts:1165`) never passes `deps.ledger` (TODO Stage 3). No replay suppression → a retried BullMQ/NATS trigger double-fires intents.
2. **Audit read-paths are stubs** — `replayEnvelopesByCustomerId`/`streamAuditByIntentHashPrefix`/`getOutcomes` return empty (`claustrum-bootstrap.ts` ~311–323, `TODO(loop-closure)`).
3. **No programmatic chat client** for tests (two-step POST + SSE with session tokens, guest secrets, per-session locks).
4. **No e2e auth path** — Twilio Verify OTP has no test seam at the HTTP level; no e2e has ever placed an authenticated order.
5. **Web-chat confirmation resume doesn't exist** — `WebChannel.matchToParked` returns `null` by design; the only customer confirm seam is the HTTP receipt store (`routes/checkout-confirmation-store.ts`). Saying "yes" in chat re-parks forever. (Product gap, not test gap.)
6. **Dangling capabilities** — `payment.method.switch` / `payment.retry` advertised by the planner with no registered tool (`tool_unresolved` on EXECUTE).
7. **HandoffPort is a noop** — ESCALATE goes nowhere humanward.
8. **No agent identity scheme** — `IntentActor.principal` is a closed union `"llm" | "user" | "system"`; you cannot legally put `"agent:foo"` there, and envelope `metadata` is outside the intentHash (not tamper-evident).
9. Stale `INERT` comments in `register-ibatexas-tool-packs.ts` / `ibatexas-planner.ts` contradict the live wiring.

---

## 4. The plan

### Phase 0 — prerequisites (days, do regardless)
- Wire `createRedisLedger` into `buildAdjudicator` (closes TODO Stage 3). Note the nonce caveat: dedup keys on intentHash which includes the nonce, and the planner mints a fresh nonce per attempt — so also derive **deterministic nonces for trigger-originated envelopes** (hash of triggerId+intentKind) and add host-level trigger dedup (BullMQ jobId / per-entity Redis cooldown keys).
- Implement the three audit read-path stubs against the `@adjudicate/audit-postgres` reader, **in apps/api or a small read-only package — never importing from the testkit** (enforce with a `check-bypass.sh` rule). One artifact, two payoffs: the testkit's AuditReader and claustrum's operational-memory contract.
- Fix or de-advertise the two dangling payment capabilities; extend `toolRosterDrift()` to diff planner-advertised capabilities vs registered tools.
- Delete the stale INERT comments.

### Phase 1 — Journey Registry + `packages/agent-testkit` + first green LLM-driven journey (3–4 weeks)

One new package, inside ibatexas. No upstream changes to adjudicate/claustrum.

**Step 0 — the Journey Registry (days, before any harness code).** Naming decision: these are *journeys* (multi-persona customer stories: ask delivery area → checkout issue → talk to support → place order → switch payment → switch fulfillment), not "scenarios" — `ibx scenario` keeps its name as the deterministic data-state engine; the new artifact gets its own `ibx journey` namespace and a sibling YAML schema (zod). Registry-first works as a *specification* activity, not a documentation project:
- `journeys/*.journey.yml` with `persona`, `channel`, `acts` (sequential), `expects` (intentKind × Decision ledger assertions), `verify` (invariants with harness-bound expected values), `status`/`blocked_by`, optional `params` (variants — payment method, delivery vs pickup, persona mood — are **parameters of one journey, never new journey IDs**; the deterministic layers below do enumeration; hold the 20–50 line).
- **v1 is single-LLM-persona with sequential acts.** Staff/admin legs still happen — as *deterministic* HTTP acts with a staff JWT, not a second LLM persona. True multi-persona (two concurrent drivers with turn-taking) is schema v2, deferred until the Phase-3 approval surface exists; resist anything resembling a coordination protocol between persona agents.
- **Three gates, increasing depth:**
  1. *Roster gate* (static, CI + boot — the `journeyRosterDrift()` analog): every `expects.intentKind` ∈ `KNOWN_INTENT_KINDS` / `listIbatexasToolPacks()`, every Decision kind valid, every invariant resolves to a registered validator, every act references a real surface.
  2. *Coverage gate* (the self-maintaining map): every intentKind in the roster covered by ≥1 journey's `expects` — or carries an explicit checked-in waiver. Tool #18 added → CI fails until a journey covers it or someone consciously waives it. Seeded immediately: `payment.method.switch` and `payment.retry` enter as `waived-pending-WS4`, converting a known dangling capability from tribal knowledge into a gate.
  3. *Reconciliation gate* (per run): diff declared `expects` against the observed `intent_audit` trajectory for the run's sessionId namespace (EXACT/IN_ORDER/ANY_ORDER matchers). **Unexplained envelopes are drift, not a pass** — an agent that mutated something the journey never declared fails the run even if all invariants hold.
- **Coverage needs two views, because read-only acts are invisible to the ledger.** "Ask delivery area / ask ETA" produce no envelopes — those legs never touch `intent_audit`. Track (a) the intentKind × Decision matrix (derived from the ledger) AND (b) journey-level pass status (from the harness). Matrix-only measurement would call a journey healthy whose conversational legs are broken but whose mutations land. Read-leg assertions stay mostly deterministic even so: assert the reply contains the *actual* zone fee/ETA from the DB, not an LLM-judge "sounds right."
- **Negative journeys are first-class from day one.** A registry of happy paths covers the EXECUTE column and nothing else; journeys expecting REFUSE (cancel after point-of-no-return), DEFER (PIX pending), ESCALATE belong in the first ten — the six-outcome algebra is the differentiator precisely because refusals are exactly assertable.
- **`blocked_by` makes the registry executable requirements.** JOURNEY-003 (checkout failure recovery → contact support → switch payment) is declared `status: blocked, blocked_by: [handoff-port-noop, chat-confirmation-resume]` rather than discovered broken at authoring time. Blocked journeys ARE the product backlog with acceptance criteria pre-written; the day a gap closes, the journey is the test that proves it. Gaps become journeys, exactly like incidents do.
- **Naming boundary (three nouns, distinct meanings):** *journey* (authored multi-persona business story, ibatexas) → *ibx scenario* (deterministic data-state engine, keeps its name) → *kernel scenario fixtures* (adjudicate's `{intent, state, expected}` atoms consumed by `adjudicate simulate` — do NOT rename these). The distillation edge runs downward: when a journey fails on a policy decision, the harness already holds the envelope + expected decision — emit a kernel scenario fixture that pins the failure deterministically forever (caveat: capture the `SystemState` the bridge passed at run time, same substrate `ibx kernel replay` uses). Journeys find failures; kernel scenarios pin them.
- `ibx journey from-audit <sessionId>` (Phase 2+): scaffold a journey from a real conversation's audit slice — observed kinds + decisions become `expects`. Production incidents literally become journeys.
- Write the first 8–10 by hand (including the negative ones); they double as the requirements spec for the oracle kit. A journey that has never executed is linted but flagged unverified — the catalog only stays honest once CI runs it. Don't write 30 before one is green.
- **The noun test for future proposals:** each plane gets exactly one authored noun — *journey* (QA plane) and *AgentDefinition* (ops plane) — plus derived verdicts below. Any proposal introducing a new layer-noun between those and intentKind gets rejected; the vocabulary is intentKind, and each plane only binds it differently. The 18-month failure mode isn't human authorship — it's human *synchronization* of two representations of the same fact. Journeys encode intent (requirements, underivable from code); everything downstream — coverage matrix, journey graph, kernel fixtures, viewer JSON — must be generated projections of authored sources.

**Oracle kit (the genuinely new asset):**
- `AuditTrailMatcher` over `intent_audit`: by customer / intentHash prefix, **trajectory matchers (EXACT / IN_ORDER / ANY_ORDER over intent kinds)** — ADK's vocabulary, made exact by your canonical-hashed AuditRecords — plus `verifyAuditRecord` tamper checks and supersession-chain walking.
- `ProjectionBarrier` — `awaitProjection(predicate, {timeoutMs, pollMs})` polling `OrderProjection.version` / `OrderEventLog`. Never sleeps. This is the single highest-leverage anti-flake primitive.
- `NatsCapture` — buffered subscribe with `expectSubjects()`, on **subscribe-only NATS credentials** (a publish-capable test client could forge `payment.status_changed` and launder taint through `buildSystemEnvelope` subscribers — around the kernel entirely).
- `ChatClient` — wraps POST `/api/chat/messages` + SSE await-turn. Budget 2–3 days; define turn-completion as SSE terminal event + audit/projection barrier; write its contract test first.
- `authFixture` — test-OTP via the existing fake-Twilio seam for customers; staff-JWT minting gated separately and tighter.

**Test-driver agent:** a plain ~200-line Anthropic tool-use loop (`@anthropic-ai/sdk` declared directly). NOT a claustrum Conductor — the tester's mutations are HTTP calls to an already-governed system; wrapping it in its own adjudicator is governance theater.

**Skill split, enforced structurally (not by convention):**
- `act` skills get `{api, chat, vars, budget}` and only touch the public surface.
- `verify` skills get a read-only oracle context: Prisma on a **Postgres read-only role**, audit reader, NATS capture, barrier — and a GET-only HTTP client if any. Zero LLM calls, zero mutations.
- Pass/fail: scenario YAML carries `required_invariants` **with their expected parameters bound harness-side**. The LLM's only job is surfacing entity ids into `ctx.vars`; the harness re-executes the full invariant set at end-of-run with scenario-bound args. (Otherwise the driver can echo observed actuals as expectations and "prove" anything.)

**Scenario rules learned from the code:**
- Chat drives cart-building and intent; **confirmation always traverses the HTTP receipt round-trip** (`/api/cart/checkout/confirm`) — chat-confirm is structurally unsatisfiable today. Harness pre-flight rejects scenarios that expect a confirmed EXECUTE without the HTTP confirm step.
- Phase-1 scenarios stop at `pending_payment` or use cancel paths (e.g. *order-cancel-before-prep*). Paid-order scenarios need a Stripe/PIX webhook fixture — explicit Phase-2 deliverable.
- Seed once per CI job (catalog/zones/schedule); scenarios create all run-scoped data through the public surface under a runId namespace (per-scenario destructive re-seeds would wipe the evidence the JSONL traces point at).

**Safety rails (Phase-1 blockers, not nice-to-haves):**
- **Environment handshake:** the harness refuses to run unless the target attests test mode (health endpoint returns a test-mode fingerprint only present when the test composition booted) + production-hostname denylist. An LLM harness pointed at prod would place real orders, perfectly adjudicated.
- **Auth: no test route in the binary at all.** The harness mints customer JWTs *offline* with the test environment's `JWT_SECRET` for seeded customers (the fleet blueprint's approach — strictly safer than any env-gated route, which is a backdoor compiled into production no matter how it's gated). Tokens only work where the secret matches, and test environments use their own secret. Staff-JWT minting gated separately and tighter. WhatsApp driving likewise needs no production seam: compute the real Twilio HMAC locally and post to the webhook.

**Cost & flake posture:**
- Pin `ANTHROPIC_MODEL` to a Haiku-class model in the test env and assert it in pre-flight — SUT-side tokens (planner + responder per chat turn) dominate cost, not the driver. Budget ≈ $0.35–0.60/scenario at realistic token counts; still trivial, but state it honestly and read actuals from the existing token accounting.
- Cadence: **nightly + on-demand (PR label), never per-PR.** The PR gate stays your deterministic suites — plus promote **`ibx kernel replay` to a policy-diff CI gate on policy/guard PRs** (re-adjudicate the last N days of `intent_audit` under the PR's policy, diff outcomes). Token-free, real today, unique to this stack.
- Retry once; retry-pass recorded as flake (yellow); a scenario flaking two nights in a row leaves the suite until re-authored. No mid-run improvisation to turn red green.
- JSONL trace per run (LLM messages, skill calls, evidence, audit ids) as CI artifact — with `intent_audit` + `OrderEventLog` ids, any failure is rebuildable locally.

**Explicitly rejected:** transcript-replay as a token-free PR gate (Design B's flagship). Verified infeasible: no model-provider boot seam in `claustrum-bootstrap.ts` (AnthropicProvider constructed inline), `InMemoryModelProvider` is a content-blind cursor stub, Medusa ids aren't seed-stable, and prompt fragments carry dynamic state so staleness checks fire on every run. If a cache is ever wanted, cache at the *driver* level (Stagehand-style action cache), never raw SUT transcripts.

**Exit criterion:** an LLM driver places and cancels an order through real chat + HTTP confirm, and the harness proves all invariants from Postgres/`intent_audit`/NATS, twice in a row, with honest token accounting.

### Phase 2 — coverage + hardening (weeks 5–8)
6–8 scenarios: amend, batch amend, PIX defer→timeout, payment retry, reservation lifecycle, LGPD deletion. Stripe webhook/`confirm-cash` fixture for paid states. Flake ledger + quarantine. Admin UI: **plain Playwright specs** reading the same seeded state — not LLM-driven (revisit Playwright Test Agents later). Optional: driver-level action cache for the 1–2 cheapest scenarios before promoting them to PR-time.

### Phase 3 — first managed business agent: PIX payment-failure remediation (weeks 9–13)

First agent changed from OrderShepherd to **PIX remediation** (trigger: `payment.status_changed` → failed/expired), adopting the fleet blueprint's stronger justification: the trigger, tools, policies, jobs, and escalation paths all exist (`@adjudicate/pack-payments-pix` is the lighthouse pack), the outcome is directly measurable (recovered orders), and the worst case is today's behavior. The autonomy ladder is pure policy config: draft-only → confirm-gated → auto-under-threshold (e.g. `pix.regenerate` auto; refunds always confirm). Stale-order shepherding becomes agent #2.

A managed agent is **a second composition of the existing Conductor**, not a new runtime:
- `SystemChannel` (a `ChannelDriver` whose `perceive()` turns a NATS event / BullMQ job / due deferred envelope into an inbound; `render()` journals + notifies). Trigger bridge alongside `jobs/register-workers.ts`. Stateless per-trigger turns; complex cases loop *turns at the host level* — the adjudicate-once-per-turn invariant stays intact and every hop is audited.
- **Identity (the legal way):** `actor.principal` stays `"llm"`; agent identity goes in `actor.sessionId` — e.g. `agent:order-shepherd@3:order:{entityId}` — which is free-form, inside the intentHash, and lands in every audit row. Add `createAgentScopeGuard` (composed like `sessionTokenBudgetGuard`) that REFUSEs any envelope whose intentKind is outside the agent's declared set or whose sessionId prefix doesn't match a registered agent. Taint stays UNTRUSTED — autonomy comes from policy, never taint escalation. Longer term, the envelope's reserved `attestation` seam is the right home for signed agent identity (kernel roadmap item).
- **Entity-scoped sessionKey is mandatory** (per-entity serialization via the existing session locks) + **loop breakers**: suppress triggers whose causal event was produced by an agent actor, per-entity cooldown keys, runsPerHour circuit breaker at the worker level. Host-level hard caps (max model calls, wall clock) — the kernel token-budget guard only fires on the *next mutation* and can't stop a read-loop token burn.
- **Rollout, honestly named:**
  - *Stage 0 — true shadow:* decisions journaled, dispatch structurally suppressed. No approval plumbing needed; the journal becomes the eval dataset.
  - *Stage 1 — supervised:* shadow guard converts EXECUTE → REQUEST_CONFIRMATION. **Prerequisite (~1 week, budget it):** the approvals surface. Route agent confirmations through `@adjudicate/approval-engine` (exists upstream: `createApprovalEngine`, `ApprovalRegistry` memory/Redis, pluggable webhook/Slack/email channels) surfaced in the adjudicate console's approvals pages — NOT through ibatexas's `admin-confirmation-store.ts` (a receipt cache for two-step admin HTTP routes; it cannot list or resume parked envelopes). The glue that must be budgeted: parked claustrum SessionPort envelope ↔ approval request ↔ the bridge's `resume()` re-adjudication, with agent provenance rendered prominently. Without this glue, "supervised mode" parks envelopes forever and nothing is learned.
  - *Stage 2 — live*, lowest-risk intent kinds first (staff notes → WhatsApp nudge → cancel proposals).
- Per-agent kill switch: a Redis flag keyed on the agent principal, checked by the scope guard and the host — outside the seal pipeline so incident response isn't gated on redeploy.
- Wire `HandoffPort` (ESCALATE → admin notification) while you're here.
- Resume lineage spec before launch: resumed envelopes carry `supersedes` lineage to the agent's original UNTRUSTED envelope; the ConfirmationReceipt records the approving staff principal. Add testkit invariant `INV-AGENT-CONFIRM-LINEAGE`.
- **The Phase-1 harness is the agent's acceptance test**: seed a stale order, fire the trigger (the one allowlisted publish helper), assert the decision trail. This is where the shared-skills hypothesis actually pays off.

### Phase 4 — extract upward (quarter horizon, only with two consumers)
Skill manifest as an *additive* wrapper over existing registrations (install-time `intentKinds ⊆ KNOWN_INTENT_KINDS`, manifest digest report-only before it ever joins the F5 boot seal); then `@claustrum/skills` / `@claustrum/agent-host` / scenario-runner extraction; SKILL.md emission from manifests; MCP server for the oracle kit; evaluate A2A and native kernel `adjudicatePlan`.

### Deliberately not built (revisit triggers)
| Not built | Revisit when |
|---|---|
| Skill manifest/registry platform | A managed agent + testkit both consume it (Phase 3/4) |
| Transcript-replay CI gate | Never as designed; driver-level action cache instead |
| Tester-as-Conductor | Never — plain tool-use loop |
| Visual builder, A2A endpoint, multi-agent orchestration | Cross-org traffic / >2 production agents |
| Per-run isolated DBs / parallel scenarios | Nightly suite exceeds ~45 min |
| LLM-as-judge assertions | Only for marked fuzzy text (pt-BR tone), never state |
| Lifting anything into claustrum/adjudicate repos | Two proven consumers exist |

---

## 5. Reconciliation with the fleet blueprint (2026-06-11, later)

The earlier session's blueprint ("fleet": `ibatexas/packages/fleet/`, Claude Agent SDK runtime, SKILL.md skills, PIX remediation agent, console extensions, `/tmp/wf-results/` artifacts) merges with this plan as follows — each ruling verified against source:

**Adopted from the fleet blueprint (it was right):**
- **Offline JWT minting instead of any test-auth route** — strictly safer; no backdoor in the binary. Twilio HMAC computed locally for the WhatsApp driver.
- **`ibx api chat` already implements the chat+SSE protocol** (verified: `packages/cli/src/commands/api.ts` — POST /api/chat/messages, SSE parse, session reuse). Lift it into the fleet ChatClient; the "2–3 days of fiddly SSE work" shrinks substantially.
- **First agent = PIX payment-failure remediation**, draft-only, approval via `@adjudicate/approval-engine` + console (engine verified present upstream). Autonomy ladder as policy config.
- **`ChannelKind` widening is genuinely required** (verified: closed union `"whatsapp" | "web"`, `claustrum/packages/core/src/ports/channel.ts:23`) — accept the one-line upstream edit + version bump; keep the trigger ChannelDriver implementation adopter-side initially, lift to `@claustrum/channel-trigger` once stable.
- **Don't put agent/run identity in envelope metadata or new AuditRecord fields** (hashed frozen wire contract): `sim_runs`/`sim_results` Postgres tables joined to `intent_audit` via sessionId + add-only SEMCONV keys. Composes perfectly with this plan's `actor.sessionId = agent:<id>@<ver>:…` encoding (in-hash, guard-enforceable).
- **Scenario count discipline:** 20–50 journeys grown from real failures; exhaustive enumeration stays in deterministic pack-conformance fixtures. Every fleet failure distills downward into a deterministic fixture (the L0–L5 pyramid).
- **Agents own only the ambiguous step** of otherwise-deterministic workflows (what to say, which remedy) — workflow stays code; converting deterministic jobs to agents is the 8×-cost anti-pattern.
- **`agentRosterDrift()` boot/CI gate + agent registry folded into the AI-BOM**; console extended (≤3 routes: /agents, /coverage, /runs + "save audit record as journey" button), never a new app.
- **Hygiene list (Phase 0 additions):** `packages/domain` (16 test files) and `packages/types` (7) have no test script — CI never runs them; `check-bypass.sh` step 3 targets the deleted `@ibatexas/llm-provider` (a third of the bypass gate silently dead); Playwright wired into no CI workflow, `tests/e2e/fixtures` empty; CLAUDE.md references missing docs; adjudicate AI_CONTEXT.md points at deleted roadmap files.

**Corrected from this session's deeper verification (the fleet blueprint was wrong):**
- *"Your intentHash dedup already makes redelivery safe"* — **false today.** The Ledger is not wired into `buildAdjudicator` (TODO Stage 3), and the planner mints a fresh nonce per attempt, so a redelivered trigger re-plans into a new hash. JetStream WorkQueue + durable consumers stays the right transport, but ledger wiring + deterministic nonces for trigger-originated envelopes are blocking prerequisites (Phase 0 here).
- *Golden-conversation replay on PRs as free* — **rescoped.** `InMemoryModelProvider` is a content-blind sequential cursor stub; `claustrum-bootstrap.ts` constructs `AnthropicProvider` inline (no DI seam — though that file is ibatexas-side, so adding an optional `modelProvider` override is an in-repo change); Medusa entity ids are not seed-stable, so raw transcripts replayed against a re-seeded DB reference phantom entities. Feasible version: **scripted-completion pipeline regression tests** — record golden conversations as *templates* (entity ids canonicalized, completions sequenced per turn), run the real composition with the injected stub in Vitest. Valuable (extends the existing planner contract tests; closes ibatexas's deferred "Phase C" accuracy measurement) but it is an engineering deliverable with the canonicalization cost stated, not a free PR gate. The genuinely free PR-time replay remains `ibx kernel replay` policy-diff.
- *Naming:* the fleet block extends `ibx scenario` infrastructure (runPipeline/StepRegistry — agreed, one engine) but the artifact is a **journey** with its own `ibx journey` namespace and schema (vocabulary decision from this session stands).

**Durability note:** `/tmp/wf-results/{architectures,maps,research}.md` still exists but dies on reboot — copy it plus this file into `ibatexas/docs/agents/` (or a sibling docs repo) to make the decision record durable.

## 6. Product gaps surfaced (file as product work, independent of agents)
1. Web-chat confirmation resume (matchToParked is null; customers can't confirm in chat — only via HTTP checkout confirm).
2. HandoffPort noop — ESCALATE decisions vanish.
3. WebChannel render is a no-op (no per-token streaming).
4. Dangling payment capabilities (WS4 TODO).
5. Execution Ledger unwired (Stage 3 TODO) — relevant beyond agents: any webhook/job redelivery today lacks kernel-level replay suppression.
