> ⚠️ **SUPERSEDED on 2026-05-23.** This document describes a pre-cutover migration plan. The plan has been executed (IBX-IGE v3.0 always-on cutover landed at commit `f3bea43`; ~200 commits of implementation work followed across 9 correctness waves). For the current-as-of-2026-05-23 gap report, see [`audit-2026-05-23/SYNTHESIS.md`](./audit-2026-05-23/SYNTHESIS.md). For historical record of the original plan, the content below is preserved unchanged.

---

# Adjudicate Migration — Master Plan

**Status:** Draft v0.1 — pending stakeholder review before Phase 5 execution
**Owner:** Principal Orchestrator (Claude)
**Last updated:** 2026-05-22

---

## TL;DR

The documented claim ("LLM is a semantic parser with zero state-mutation authority", CLAUDE.md rule #9) is **not true today.**

The kernel is wired into the LLM responder but resolves to a hardcoded `EXECUTE` because no env vars are set; even when the kernel returns a decision, the `onToolIntent` callback that should act on it is never wired, so adjudicated EXECUTEs are silently dropped while the LLM tells the user "Solicitação registrada". Outside the LLM path the picture is starker: **47 mutating HTTP routes, ~50 Prisma mutation sites, 32 reactive NATS/queue handlers — 0% adjudicated.** The Stripe webhook captures money and refunds without kernel review. The DEFER subscriber is dead code. The MetricsSink is never installed, so every kernel metric is a no-op and the runbooks reference Prometheus counters and a CLI that don't exist.

The good news: the framework is real, the kernel package is excellent, and the *plumbing* to make the kernel fire is ~1 dev-day. The *scope* of work to extend governance from the LLM-tool path to the entire mutation graph is ~4–6 months of focused engineering across 6 workstreams.

This plan converts the current "scaffolded but dormant" state into "systemic, default-deny governance with measurable coverage" in nine milestones.

---

## Current state — the gap

### What the investigation found

| Surface | Mutating sites | Adjudicated | Bypass % |
|---|---|---|---|
| LLM tools | 19 of 35 | 0 (callback unwired) | 100% |
| HTTP routes | 47 | 0 | 100% |
| Prisma writes | ~50 | 0 | 100% |
| NATS subscribers + workers | 32 | 0 | 100% |
| Webhooks | Stripe, Twilio | 0 (direct) | 100% |
| **Total mutation entrypoints** | **~150+** | **0** | **100%** |

### Why the prior audit said "deeply integrated"

The prior audit looked at the *call graph in `llm-responder.ts`* and saw `adjudicate()` and `adjudicateWithShadow()` invocations, the policy bundle, the audit-record builder, the PIX defer guard, the refusal taxonomy. That's the *aspirational chokepoint*: if everything routed through `runOrchestrator` and `onToolIntent` were wired and env vars were set, the LLM-tool path would in fact be deeply governed.

But:
1. `onToolIntent` is never wired in `agent.ts:329` — every adjudicated EXECUTE is a NOOP.
2. `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` are unset everywhere → `llm-responder.ts:329-332` falls into a "pure legacy" branch that hardcodes `EXECUTE`.
3. Kernel-direct mutation calls (`addItemToCart`, `processCheckout`, `cancelOrderAction`, `regeneratePixAction`) bypass `adjudicate()` entirely.
4. `startDeferResolverSubscriber` is defined but never invoked in `apps/api/src/index.ts` — DEFER park/resume is dead at runtime.
5. `resumeDeferredIntent` only flips the dedup ledger and deletes the parked key; it never re-executes the envelope.

### Why production isn't broken today

Because the kernel is dormant, today's behavior equals the v1.0 pre-kernel baseline: legacy `EXECUTE` for LLM tools (when the dispatcher *does* fire), direct route/job/subscriber mutations for everything else. The system works; it just has no deterministic mutation authority.

---

## Target state — the vision

> **No mutation in ibatexas — whether LLM-proposed, user-requested, automation-triggered, webhook-driven, or operator-issued — may take effect without an IntentEnvelope, adjudicated by a registered policy pack, with an audit record persisted and replayable.**

Concretely:

1. **Single chokepoint per mutation domain.** Every command service (`OrderCommandService`, `PaymentCommandService`, `ReservationCommandService`, `CustomerCommandService`, `MessageCommandService`) accepts only `IntentEnvelope<*>` inputs.
2. **System actors.** Subscribers, jobs, webhooks, admin routes mint envelopes from a known system actor with provenance.
3. **Three categories of policy:**
   - **Domain packs** (`@ibatexas/pack-{orders,reservations,whatsapp,customer-onboarding}`) own per-intent rules.
   - **Cross-cutting guards** (rate limiting, idempotency, PII redaction, role gates) compose into bundles via `@adjudicate/primitives`.
   - **Operator confirmation** for destructive actions follows `pack-deployments-approval`'s `REQUEST_CONFIRMATION → receipt → kernel-substitutes-EXECUTE` pattern.
4. **Durable audit.** `@adjudicate/audit-postgres` for the system of record; NATS subject `ibatexas.audit.intent.decision.v1` for hot fanout; `persistentBufferedSink` for crash safety.
5. **Replayable.** Every envelope hashes deterministically; `replayWithIntegrity` + `classifyReplayDrift` run daily.
6. **Observable.** A `MetricsSink` adapter publishes to PostHog (product-side dashboards), Sentry (alerting), and Prometheus (SLO charts). Operator console exposes Audit Explorer, decision detail, supersession chains, replay reports.
7. **Failsafe.** Distributed kill switch (`createDistributedKillSwitchPubSub`) per-tool and global; `IBX_KILL_SWITCH` checked in fast path; runbooks for every staged enforce flip.

---

## Governance principles (non-negotiable)

1. **LLM never executes.** It proposes intents. Period. The current `executeToolDirect` export from `tool-registry.ts` is removed.
2. **Authority belongs to the kernel.** Not the LLM, not the route handler, not the subscriber, not the cron job, not the operator session.
3. **System actors are first-class.** Cron, NATS, webhook-driven, admin-forced — each has an `IntentEnvelope` actor identity with provenance.
4. **Default-deny.** A policy bundle's default kind must be `REFUSE`. No silent EXECUTE on unmatched intents.
5. **Validated at boot.** `validateEnforceConfig(knownIntents, env)` runs in every app's boot sequence. Typos = startup failure.
6. **Replayable.** Every decision has a stable hash. Every envelope is reconstructable.
7. **Auditable but PII-safe.** Audit records pass through an `AuditRedactor` before any sink. No CPF/email/phone/payment-method in NATS payloads.
8. **Reversible rollouts.** Every enforce flip has a kill switch reachable from a privileged admin endpoint and a documented runbook.

---

## Workstreams

Six parallel-ish workstreams, sequenced by dependency:

### WS1 — Plumbing flip *(makes the kernel actually run)*
Bootstrap, env vars, MetricsSink, pack registration, validateEnforceConfig, onToolIntent wiring, defer-resolver wiring, fix `resumeDeferredIntent` to re-execute. **~3–5 dev-days.**

### WS2 — LLM tool path completion
Wrap the 4 kernel-direct mutations in envelopes. Reclassify `set_pix_details`. Adopt `orderCapabilityPlanner`. Remove `executeToolDirect`. Add `safePlan`. Audit redactor for tool inputs. **~2–3 weeks.**

### WS3 — Mutation-entrypoint governance *(the bulk of the work)*
Wrap every API route (47), every webhook (Stripe, Twilio), every NATS subscriber (25), every job (11), every command service (Order/Payment/Reservation/Customer/Message) at its method boundary. System-actor envelopes for non-user-initiated mutations. **~10–12 weeks.**

### WS4 — Pack architecture
Migrate `order-policy-bundle.ts` into `@ibatexas/pack-orders`. Author `@ibatexas/pack-reservations`, `@ibatexas/pack-whatsapp`, `@ibatexas/pack-customer-onboarding`. Adopt `@adjudicate/locales-pt-BR`. **~3–4 weeks.**

### WS5 — Observability, audit, replay
Implement `MetricsSink` (PostHog + Sentry + Prometheus). Wire `@adjudicate/audit-postgres`. Wire NATS audit consumer. Adopt `persistentBufferedSink`. Build `ibx kernel status`, `ibx kernel replay`, `ibx kernel divergence` CLIs. Test coverage: kernel contract, shadow/enforce branching, DEFER round-trip, audit emission, bypass detection. **~3–4 weeks.**

### WS6 — Rollout choreography
Shadow-mode flip for every known intent. Divergence dashboards. Staged enforce flips, intent-by-intent, with per-intent kill switches. Production runbooks rewritten to match real metrics/CLI. **~6–8 weeks.**

---

## Milestone phasing

```
M0  Plumbing flip                     Week 1
M1  LLM-path completion               Weeks 2-4
M2  Pack architecture                 Weeks 3-6  (overlaps M1)
M3  Mutation-entrypoint governance    Weeks 4-15 (the long pole)
M4  Observability + audit + replay    Weeks 4-7
M5  Shadow-mode rollout (all intents) Weeks 7-9
M6  Test coverage to migration grade  Weeks 8-10
M7  Enforce-mode rollout, low risk    Weeks 10-12
M8  Enforce-mode rollout, high risk   Weeks 13-18

End-to-end: ~4-5 months wall clock if 2-3 engineers are dedicated.
```

Dependencies:
- M0 unblocks everything else.
- M1, M2, M3, M4 run in parallel as engineer count allows.
- M5 requires M0+M4 (you can't shadow without metrics).
- M6 should be on the critical path before M7 — never enforce what isn't tested.
- M7→M8 is sequential and per-intent-kind, not big-bang.

---

## Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Enforce-flip blocks a real customer flow → revenue loss | M | H | Shadow first for ≥7 days per intent; divergence dashboard; per-intent kill switch with documented runbook |
| R2 | Audit pipeline backpressure → kernel latency spike | M | M | `persistentBufferedSink` + bounded queue; sink failure must not block decisions (fail-open with metric) |
| R3 | PII leak to NATS audit subject | H today | H | `AuditRedactor` lands in M0; verified by contract test before any shadow flip |
| R4 | LGPD anonymize replay → permanent data loss | L | Catastrophic | OTP re-verification + 24h grace period before M3 lands customer-route governance |
| R5 | Pack policy drift between repos | M | M | `assertPackConformance` at boot; `@adjudicate/conformance` matrices in CI |
| R6 | Kernel-direct mutation discovered post-flip | M | H | Bypass-detection test that fails CI if a non-envelope path reaches command service |
| R7 | NATS connection-only auth + spoofed subscriber | L | H | Per-message signing or NATS auth tokens (WS5) before enforce flip on any subscriber |
| R8 | Schema drift between ibatexas envelope shapes and pack expectations | M | M | TypeScript-narrowed envelope types per pack; runtime Zod on the kernel boundary |

---

## Success criteria

The migration is *done* when all of the following hold for ≥14 consecutive days in production:

- [ ] **Coverage:** ≥95% of mutation entrypoints (as inventoried in `investigation/*`) pass through `adjudicate()`.
- [ ] **No bypass:** CI bypass-detection test exists and passes; static analyzer flags any new Prisma write outside a wrapped command service.
- [ ] **Enforce mode live:** `IBX_KERNEL_ENFORCE` includes every known mutating intent kind.
- [ ] **Audit:** Every adjudicated decision lands in `@adjudicate/audit-postgres`; `audit.intent.decision.v1` NATS lag <1s p99.
- [ ] **Replay:** Daily `ibx kernel replay --since=24h` job runs with `classifyReplayDrift` = 0 drifted decisions.
- [ ] **Observability:** Grafana dashboards live for decision rate, refusal rate (with reason breakdown), DEFER backlog, audit lag, kernel latency p50/p95/p99.
- [ ] **Failsafe:** Kill switch verified in staging once per quarter.
- [ ] **Tests:** Kernel contract suite ≥90% pass rate; bypass-detection in CI; integration tests for every domain pack.
- [ ] **Runbooks:** Each enforce flip has a runbook that references real metrics and a real kill-switch command.
- [ ] **No PII in audit:** Contract test verifies `AuditRecord.envelope.payload` is redacted; daily NATS subject sample produces zero CPF/email/phone matches.

---

## Out of scope (explicit)

- Replacing Medusa with a custom commerce layer.
- Replacing NATS with another messaging system.
- Replacing Prisma with a CQRS event-sourced store.
- Adding GraphQL or gRPC as the LLM transport.
- Migrating from `@anthropic-ai/sdk` to a different LLM SDK.

The migration *extends* current architecture; it does not refactor it.

---

## Document map

- `MASTER_PLAN.md` — this file
- `investigation/01-llm-tool-execution.md` — LLM tool path audit
- `investigation/02-api-webhook-mutations.md` — HTTP & webhook audit
- `investigation/03-db-commerce-mutations.md` — Prisma & Medusa audit
- `investigation/04-background-jobs-nats.md` — Async surface audit
- `investigation/05-adjudicate-capabilities.md` — adjudicate framework inventory
- `investigation/06-runtime-config-governance.md` — Plumbing audit
- `investigation/07-testing-observability.md` — Test & telemetry audit
- `investigation/08-security-trust-boundaries.md` — Security & PII audit
- `governance/` — design docs (intent taxonomy, capability model, trust boundaries, policies, audit/replay, deferred execution, rollback)
- `migration/` — rollout strategy, milestone breakdown, blast-radius analysis, shadow→enforce sequencing, kill-switch strategy, observability requirements, production safety checklist
- `tasks/` — per-stream task files with ready-to-spawn sub-agent prompts

---

## Next actions

**Pending stakeholder decision:**
1. Approve scope and milestone phasing (above).
2. Confirm engineer count and pace.
3. Approve `M0` (plumbing flip) for immediate execution — this is the smallest, lowest-risk milestone and unblocks all others.
4. Approve Phase 5 (spawn implementation sub-agents per task file) once tasks/ is generated.

Until approved, no implementation agents are spawned and no code is changed.
