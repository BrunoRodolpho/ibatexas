# Agents & Agent-Driven Testing — Plan v2 for adjudicate / claustrum / ibatexas

*Produced 2026-06-11. Supersedes `bruno-stack-agents-plan.md` (v1). Method: Phase-A verification sweep (6 read-only sub-agents, one per subsystem, every claim cited at `file:line`), Phase-B constitution conflict check, Phase-C synthesis, Phase-D adversarial review (3 critics — feasibility, operations, governance — whose 12 must-fix findings are incorporated below and recorded in §9). Verified at HEADs: ibatexas `01d2d0a`, adjudicate `28b93a4`, claustrum `41c9e00`. No commits landed in any repo since v1 — every delta comes from deeper verification, not code movement.*

*Decision record: `ibatexas/docs/agents/` holds plan v1, its verification + critique, and the original blueprint artifacts. This file and the Phase-A ledger belong there too (task P0-10).*

---

## 1. Executive summary — what changed vs v1

v1's architecture survives: testing agents on the public surface, managed agents kernel-gated, shared deterministic oracle kit, Journey Registry as Phase 1's spine, PIX remediation as agent #1. **Verification didn't break the architecture; it broke specifics the architecture was standing on:**

1. **Two v1 claims BROKEN.** (a) Medusa entity ids are formally non-deterministic (ULID per seed) — journeys resolve by handle only; lint rejects raw ids. (b) `WebChannel.render` is not a package no-op — the no-op is ibatexas's injected *sink* (open `attachStream()` TODO); render delivery is an adopter seam.
2. **Three "settled" mechanisms were unscheduled engineering**, now tasks: NATS server-side auth (zero auth on four surfaces; runbook already exists at `docs/security/NATS-AUTH-REQUIREMENTS.md`), offline JWT minting (the fake-Twilio seam does not exist), and Stage-0 shadow (a dedicated sandbox tool registry in the shadow composition — the only invariant-compatible suppression design; see T3-6).
3. **Code facts v1 didn't know that reshape tasks:** the Conductor lock key is `${channel}:${customerId}` and ignores `sessionKey`, and ibatexas injects **no SessionLock at all** (in-memory default) — fixed by P0-9 + T3-0. The orders planner gates `order.checkout.create`/`order.cancel` on `isAuthenticated`, and chat guests get `customerId: null` — so a *guest* can never place an order via chat; the flagship journey is authenticated (T1a-12). No compose file anywhere runs Medusa — the test composition is infra-compose + a process-compose test profile, not a "clone of dev compose" (T1a-11a/b).
4. **Substantial reuse discovered:** CC-006 is a working golden-conversation runner; distributed kill-switch pub/sub, `@adjudicate/drift`, `AuditEventBus`, and a supersession-chain walker ship upstream; `ibx chat dump --json` solves transcript extraction; a JSONL event convention exists; BullMQ `jobId` dedup is proven in-repo; `assertPackCoverage()` is the coverage-gate precedent; the approval engine already owns the orchestration v1 budgeted a week for.
5. **The dangling-capability picture corrected twice:** 2 payment kinds are genuinely dangling (planner-advertised, no tool); the 2 staff reservation kinds are **not** — the live planner pins `staffId: null` (staff-route-only by design; admin routes build envelopes directly), so they are coverable today via staff-HTTP journey acts. One tool (`order.review.submit`) is registered but never advertised.
6. **Cost model corrected:** the planner/responder send single-turn perception text with short system prompts — v1-style estimates were ~5× high. §7 now carries over-provisioned ceilings plus a mandatory measure-and-rebaseline step (T1a-13), and the dollar-abort gets a real data source (per-call in/out tokens in the JSONL trace — the Redis counter stores an unsplittable combined total).
7. **Six decision requests** (§4), most notably the SUT model pin (prod default `claude-sonnet-4-6`; a Haiku nightly certifies a different planner) and the console/QA-viewer split.
8. **Phase 1 split into 1a/1b**; every adopted-but-unscheduled v1 §5 item now has a task id.

---

## 2. Verification ledger

Phase-A verdicts: **52 CONFIRMED / 2 BROKEN / 1 STALE / 0 UNVERIFIABLE.** Full evidence: `ibatexas/docs/agents/plan-v2-phase-a-ledger.md`. Condensed (re-verified at current HEAD):

| # | Claim (v1) | Verdict | Evidence | Consequence |
|---|---|---|---|---|
| 1 | Execution Ledger not wired; TODO(Stage 3) | CONFIRMED | `claustrum-bootstrap.ts:1161-1165`; bridge forwards optional `deps.ledger` at `:418` | P0-1 is a one-call change |
| 2 | Planner mints fresh nonce per attempt | CONFIRMED | `ibatexas-planner.ts:261-267` (`randomUUID()`) | Deterministic trigger nonces via `perception.externalId` (T3-1/T3-2); payload also in-hash → host dedup primary |
| 3 | Audit read-paths empty stubs | CONFIRMED | `claustrum-bootstrap.ts:311-323`; `verifyAuditRecord` (:324-332) real | Oracle reads `intent_audit` directly; P0-2 fills the port |
| 4 | `IntentActor.principal` closed union; sessionId free-form, in-hash | CONFIRMED | adjudicate `envelope.ts:38-39`, pre-image `:106-122` | `agent:<id>@<ver>:entity:{id}` identity sound, tamper-evident |
| 5 | "Envelope metadata outside intentHash" | **BROKEN (mechanism)** | `envelope.ts:175-184`: no metadata field; extras rejected | sessionId (later `actor.attestation`) are the only carriers |
| 6 | `actor.attestation` seam | CONFIRMED + nuance | `envelope.ts:48-51`; published schema rejects it (`additionalProperties:false`); admin-sdk Zod accepts | Three surfaces disagree — additive schema fix is a Phase-4 prerequisite (T4-4) |
| 7 | `matchToParked` null; confirm via HTTP receipt only | CONFIRMED | `channel-web/web-channel.ts:66-70` | Chat-confirm journeys stay blocked (no phase closes this — product gap) |
| 8 | `WebChannel.render` no-op | **BROKEN (half)** | Package render calls `config.sink`; the no-op is ibatexas's sink (`:1241-1243`, `attachStream()` TODO) | Adopter injection seam; product gap re-scoped |
| 9 | `ChannelKind` closed union | CONFIRMED | `ports/channel.ts:23`; **second** parallel union `channel-whatsapp/src/attest.ts:30` | T3-0 widens both; no exhaustive switches |
| 10 | 2 dangling payment kinds | CONFIRMED; reservations re-read | `pack-payments/capabilities.ts:84-88` dangling; `reservation.checkin/complete` are staff-route-only **by design** (`claustrum-bootstrap.ts:758-766` pins `staffId:null`; admin routes build envelopes directly, `routes/admin/reservations.ts:159-245`) | P0-7 de-advertises payments only; reservation kinds = staff-HTTP journey cells, no waiver |
| 11 | `HandoffPort` noop | CONFIRMED | `:648-662, 1260` | T3-8 wires it (own acceptance — JOURNEY-003 stays blocked on chat-confirm) |
| 12 | `TokenUsageStore` in-memory | CONFIRMED (telemetry only) | adapter-core store wired `:682-689`, "TELEMETRY ONLY" | **Budget enforcement is Redis-backed**: write `:1019-1032` (combined total — not dollar-convertible), read `resolve-and-assemble.ts:36-56` (`sessionTokenKey` exported, fail-open) |
| 13 | `InMemoryModelProvider` content-blind cursor | CONFIRMED | `:48-56` (modulo; complete+stream share cursor) | T2-6b builds a content-keyed double incl. `embed` |
| 14 | `AnthropicProvider` inline, no DI seam | CONFIRMED | `bootstrapClaustrum()` zero params (`:1102`); singleton `:1103` | T2-6a adds options + reset hook (pgPool, audit-sink DI, metrics sink — not just `_conductor`) |
| 15 | Medusa ids seed-stable | **BROKEN** | seeding never passes ids; `@medusajs/utils` ULID; `ibx db reset` drops DB; `seed-orders.ts:337-415` resolves **by handle** for this exact reason | Handle-only rule; journey lint rejects `prod_`/`variant_`/`cart_` literals |
| 16 | `ibx api chat` = POST+SSE+reuse | CONFIRMED (worse) | never sends `x-session-secret`/`x-session-token` — even first-run SSE GET rejected once secret minted | ChatClient is a rewrite-with-reference (T1a-5), incl. cookie auth |
| 17 | approval-engine complete | CONFIRMED (channels overstated) | shipped channels = console-log + webhook only; engine owns request/resolve/expire (`engine.ts:49-147`) | T3-7 glue = `resolveStateContext` + resolve RPC; Slack via incoming webhook |
| 18 | ConfirmationReceipt lacks approver | CONFIRMED | `adjudicate-and-audit.ts:162-194`; `resolvedBy` only in registry projection | DR-6 |
| 19 | DEFER-resume = system/TRUSTED, nonce = predecessor hash | CONFIRMED | adapter-core `loop.ts:509-541` | Attribution keys on sessionId, not principal; resumes inherit dedup |
| 20 | Console /approvals display-only | CONFIRMED | the page says so itself (`page.tsx:10-14`) | Adopter-side resolve loop is the glue (T3-7) |
| 21 | Lock key ignores sessionKey; sessions per (customerId, channel) | CONFIRMED | `conductor.ts:101-122`, `:245-258` | DR-4 / T3-0 |
| 22 | ibatexas injects a SessionLock | NOT INJECTED | grep = 0 hits; default InMemory (`conductor.ts:95`) | P0-9 — needed today, agents or not |
| 23 | CC-002 + sandbox seam | CONFIRMED | empty-plan noop = 0 invocations (CC-002 tension — smalltalk turns); `chooseImplementation` default = last-registered-wins (`registry.ts:114-119`) | T3-6 uses a dedicated shadow registry, not co-mingled resolution (governance critic) |
| 24 | NATS: no server auth | CONFIRMED (**4 surfaces**) | dev+prod compose, terraform prod, **and** `infra/terraform/environments/dev/compose.yml.tpl:134-139` | DR-2; client plumbing done & fail-closed (`NATS_NKEY_SEED`) |
| 25 | NATS-auth doc missing | **STALE** | EXISTS at `docs/security/NATS-AUTH-REQUIREMENTS.md`; two refs point at the old path | T3-10 executes it; P0-5 fixes refs |
| 26 | `ibx kernel replay` gaps | CONFIRMED (worse) | even the report's *error bucket* exits 0; no `--json`; empty-state; flag-unset stub exits 0; pix pack npm-pinned | T1b-3 retrofits the `--verify-file`/`--json` idiom that exists two commands over |
| 27 | ANTHROPIC_MODEL joint; bogus fallback | CONFIRMED | both sites `?? "claude-opus-4-5-20250101"`; `.env.example:8` = `claude-sonnet-4-6` | DR-1; P0-6 (also covers `EMBEDDING_MODEL_ID ?? "text-embedding-3-small"` — an OpenAI id fed to AnthropicProvider, `:1199-1205`) |
| 28 | check-bypass step 3 silent no-op | CONFIRMED (empirical) | pnpm no-match exits 0 | P0-3 |
| 29 | domain/types tests orphaned | CONFIRMED | no `test` script; 16+7 files never run | P0-4 |
| 30 | Playwright in no CI; fixtures empty | CONFIRMED | 0 hits across 9 workflows | T2-7 |
| 31 | INERT comments stale | CONFIRMED | 2 files false; `claustrum-bootstrap.ts:120` conditionally true — keep | P0-5 |
| 32 | CLAUDE.md/AI_CONTEXT stale | CONFIRMED | rule 9 contradicts code; dead doc links; CLI count wrong both ways (actual 30) | P0-5; never cite as ground truth |
| 33 | `ibx scenario` data-state-only; runPipeline generic | CONFIRMED | closed StepNameSchema; fixed phases; hardcoded verify keys | Journeys get their own runner (T1a-1); never widen StepNameSchema |
| 34 | Vitest count | CONFIRMED (298+3) | find excl. node_modules | Cosmetic |
| 35 | Health endpoint fingerprint-able | CONFIRMED | `routes/health.ts:119-165` (+DLQ/outbox depths) | T1a-10; free "no backlog" post-run assertion |
| 36 | JWT contract | CONFIRMED | aud binding; secrets must differ; **NODE_ENV=test missing secret → random per process** | T1a-11a sets explicit distinct secrets; tokens ride **cookies** (`token=` / `staff_token=` — no header path for staff) |
| 37 | Fake-Twilio Verify seam | CONFIRMED ABSENT | `routes/auth.ts:127-157` real client always | T1a-4 offline JWT is the only path |
| 38 | BullMQ jobId dedup | CONFIRMED (proven in-repo) | `stripe-webhook-processor.ts:86`; prefix `"ibx"` hardcoded (not APP_ENV-namespaced) | T3-2 reuses; isolation via dedicated ephemeral infra (T1a-11a) |

---

## 3. New facts (v1 didn't know; includes Phase-D verified additions)

1. **CC-006 is a working golden-conversation runner** (`fixturesDir` + `options.checks` extension points). → T2-6 extends its fixture format; adopter invariants plug in without upstream changes.
2. **Upstream kill-switch machinery exists** (`startDistributedKillSwitchPubSub`, `createRedisEmergencyStateStore`, kernel basis `kill.ACTIVE`). → T3-5 reuses; v1's bespoke flag dropped.
3. **`@adjudicate/drift` + `AuditEventBus` (Redis) + `bridgeAuditSinkToBus`** exist. → Stage-0 monitoring is wiring (T3-6); reconciliation can subscribe live.
4. **Supersession-chain walker** ships in `@adjudicate/audit`. → T1a-7 imports it.
5. **`KNOWN_INTENT_KINDS` (63 kinds) in `@ibatexas/intent-kinds`; `assertPackCoverage()`** boot-gate precedent. → Gates name their domains (DR-5) and mirror the `--verify-file` idiom.
6. **`IBATEXAS_POLICY_PACKS` is module-private in an app** — unreachable from the CLI. → P0-8 creates a *workspace package* composition home.
7. **`ibx chat scenarios` is a ghost; `ibx chat dump --json` extracts transcripts.** → namespace free; T2-3 reuses dump; help cleanup P0-5.
8. **JSONL event convention exists** (`lib/events.ts`, `IBX_EVENTS=json`) — but it is cli-internal; cli has no exports surface. → the event emitter moves to `@ibatexas/tools` (T1a-1) so journeys→tools and cli→journeys stay one-way (no workspace cycle).
9. **The scenario lock is globally keyed, TOCTOU-racy, plain-DEL** — violating CLAUDE.md rule #10 in the CLI itself. → P0-11 fixes; journey runner uses per-run SET NX + Lua (T1b-7).
10. **`infraEndpoints()` / `ibx dev urls`** is the address source of truth. → harness resolves ports from it; denylist hook (T1a-10).
11. **Env model:** apps load no dotenv; `NODE_ENV=test` + missing secret → random per-process secret; Redis password even locally. → T1a-11a sets the full explicit env contract, including **`ANTHROPIC_API_KEY`** (hard-required by `config.ts:70` — omitted in the draft, caught by the operations critic) and `EMBEDDING_MODEL_ID`.
12. **`ibx test seed/integration/e2e/e2e-run` implement the seeding lifecycle**; CI cannot run Medusa migrations remotely (pooler hang) → ephemeral-local stack is the only nightly option.
13. **`toOrderProjectionData()` + `ibx db backfill`** = canonical Medusa→projection mapping; **`seed-orders.ts`** ships 12 deterministic historical orders resolved by handle. → T2-1 preconditions only (governance: never forge the asserted state — see T2-1).
14. **`OrderEventLog` payloads may be LGPD-anonymized in place.** → matchers tolerate it.
15. **Approvals glue smaller than v1 budgeted** (engine owns orchestration; adopter supplies `resolveStateContext` + resolve RPC; `examples/vacation-approval` is a working reference). → T3-7 ≈ 1 week.
16. **`ibx kernel defer`/`resume` subcommands exist.** → Phase-3 glue inspects/reuses first.
17. **`red-team toSimulateScenario()` + `scenarios generate`** mechanically produce kernel fixtures. → distillation tooling exists at both ends.
18. **Smalltalk turns = EXECUTE-with-empty-plan** (noop dispatch, 0 invocations; CC-002 flags when sampled). → expects-matching ignores noop dispatches; conformance sampling scoped.
19. **Sonar sources are a whitelist.** → new packages invisible until added (explicit line in T1a-1).
20. **Testcontainer postgres:15 vs compose postgres:17.** → align when touched.
21. **(Phase D)** `order.checkout.create`/`order.cancel` are **auth-gated in the planner** (`pack-orders/capabilities.ts:118-133`) and chat guests map to `customerId: null` (`claustrum-bootstrap.ts:751-766`; `chat.ts:268`). → guest journeys cannot place/cancel orders; the flagship journey is authenticated; "guest checkout not proposable" becomes a *negative expectation* journey.
22. **(Phase D)** No compose file anywhere runs Medusa; dev compose is infra-only; prod compose has no commerce service. → the test composition = infra compose + process-compose test profile (T1a-11a/b); containerizing Medusa is explicitly not undertaken.
23. **(Phase D)** The planner sends a ~400-token system prompt + **single-turn perception text** (no history) + a small tool surface; the responder is a one-liner. → real SUT cost ≈ $0.08–0.15/8-turn journey on Sonnet; v1-style estimates were ~5× high; the *driver* (which accumulates context) likely costs as much or more than the SUT (§7).
24. **(Phase D)** The Redis `llm:tokens` counter stores `inputTokens + outputTokens` combined (`:1020-1029`) — **not dollar-convertible** at a $3/$15 in/out split. → cost actuals come from JSONL `llm.call` events + a checked-in price table; the counter remains the kernel-side budget-guard input only (T1b-8).

---

## 4. Decision requests

**DR-1 — SUT model pin (constitution #7 "pinned cheap SUT model").** Prod default is `claude-sonnet-4-6`; `ANTHROPIC_MODEL` controls planner+responder jointly. A Haiku nightly certifies a planner customers never talk to. **Recommend:** nightly certification at prod parity (`claude-sonnet-4-6`); measured cost is small (§7 — likely $3–8/night at the corrected estimates); a cheap-model profile exists for dev runs, marked non-certifying in `sim_runs`. Pre-flight asserts model == certification target. Branch B (cheap nightly + weekly prod pass) is the same tasks, different workflow env.

**DR-2 — Subscribe-only NATS creds (constitution #8).** No server-side auth on four surfaces; client plumbing done; runbook exists. **Recommend:** Phase 1 ships a publish-incapable capture client + check-bypass leg (residual risk documented — bounded by ephemeral env + fingerprint handshake); Phase-3 entry executes the runbook (T3-10).

**DR-3 — Console scope (constitution #13 internal tension).** **Recommend:** console gets `/agents` only (ops — joins /approvals); `/coverage` + run explorer + the four graphs live in the QA viewer (one lightweight read-only app, T2-5); "never a new app" struck. Branch B (all in console) couples QA artifacts into the ops deploy — not recommended.

**DR-4 — Entity serialization (constitution #9).** Lock key ignores `sessionKey`; no SessionLock injected at all. **Recommend:** P0-9 injects `PostgresAdvisorySessionLock` now; T3-0 upstream PR bundles ChannelKind widening (+ `attest.ts:30`) + a lock-key strategy (honor `sessionKey` when supplied). No cheap second branch — without it, trigger and chat turns race.

**DR-5 — Coverage-gate domain (constitution #4).** "intentKind" conflates four sets; the dangling story corrected by Phase D. **Recommend:** coverage domain = **chat-drivable registered tools (17) × pack-declared decision kinds** (cell-level) **∪ staff-route envelope kinds** (`reservation.checkin`/`complete` — covered by deterministic staff-HTTP acts, *no waiver*). `expects` entries validate against `KNOWN_INTENT_KINDS` (journeys may expect system-kind envelopes). Waiver categories: `waived-pending-WS4` (2 payment kinds — they leave the planner surface when P0-7 de-advertises; the journey stays `blocked_by: ws4`), `waived-unadvertised` (`order.review.submit`), `waived-quarantined` (flake-quarantined journeys' cells, visible in the coverage report — never silently counted as covered).

**DR-6 — Approver identity (constitution #11).** Kernel receipt carries no approving principal; `resolvedBy` is a TTL'd projection. **Recommend:** projection-grade approver identity for Phase 3 (render `resolvedBy` + supersession chain; `INV-AGENT-CONFIRM-LINEAGE` documents the trust boundary); file the additive upstream receipt extension as a Phase-4 candidate. Branch B (kernel change now) blocks Phase 3 on a wire-format change — not recommended.

---

## 5. The plan — dependency DAG

Phases: **P0** → **1a** → **1b** → **2** → **3** → **4**. Sizes: S ≤2h, M ≤half-day; anything bigger is split. Every task self-contained for a cold implementer.

### Phase 0 — prerequisites & hygiene (parallel; ~1 week elapsed)

**P0-1 (M)** Wire the execution Ledger.
`createRedisLedger` (from `@adjudicate/audit`; API = `checkLedger`/`recordExecution`) into `buildAdjudicator` at `apps/api/src/claustrum-bootstrap.ts:1161-1165`; the bridge already forwards `deps.ledger` (`:418`) on fresh and resume paths.
Accept: real-Redis testcontainer test — same envelope twice → second REFUSE basis `replay_suppressed`; ledger failure fail-closed.
Verify: `pnpm --filter @ibatexas/api exec vitest run src/__tests__/ledger-replay-suppression.test.ts`
Deps: none. Solo.

**P0-2 (M)** Implement the three audit read-path stubs (`claustrum-bootstrap.ts:311-323`) against the audit-postgres schema, in an apps/api module.
Accept: seeded `intent_audit` rows returned by all three; empty DB → empty, no throw.
Verify: `pnpm --filter @ibatexas/api exec vitest run src/__tests__/audit-read-paths.test.ts`
Deps: none. Solo.

**P0-3 (S)** Repair check-bypass.sh + containment legs (both directions).
Delete the dead `@ibatexas/llm-provider` leg (`:62-69`); guard: a pnpm filter matching nothing fails the script; add **two** new legs: (a) `apps/*` and non-test `packages/*` never import `@ibatexas/journeys`; (b) `packages/journeys` sources never import `apps/api` internals.
Verify: `./scripts/check-bypass.sh && echo OK`; negative run with a bogus filter exits non-zero.
Deps: none. Solo.

**P0-4 (S)** Un-orphan domain/types tests (add `test` scripts; vitest devDep for types).
Verify: `pnpm --filter @ibatexas/domain test && pnpm --filter @ibatexas/types test`
Deps: none. Solo.

**P0-5 (S)** Doc + comment hygiene batch.
Delete stale INERT blocks (`register-ibatexas-tool-packs.ts:32-38`, `ibatexas-planner.ts:43`; keep `claustrum-bootstrap.ts:120`); CLAUDE.md rule-9 wording (post-P0-1), CLI count (30), dead doc links; remove `ibx chat scenarios` ghost (`index.ts:204`); fix the two stale NATS-doc refs (point at `docs/security/NATS-AUTH-REQUIREMENTS.md`); adjudicate AI_CONTEXT.md dead pointers.
Verify: `grep -rn "INERT" apps/api/src/tools/register-ibatexas-tool-packs.ts apps/api/src/claustrum/ibatexas-planner.ts` → 0; `grep -n "chat scenarios" packages/cli/src/index.ts` → 0.
Deps: P0-1 (rule-9 wording only). Solo.

**P0-6 (S)** Fix both bogus model defaults.
(a) `claude-opus-4-5-20250101` (two sites `:813`, `:1254`) → fail-fast assert at bootstrap, no silent fallback. (b) `EMBEDDING_MODEL_ID ?? "text-embedding-3-small"` (`:1199-1205` — an OpenAI id fed to AnthropicProvider): determine whether grounding issues per-turn model calls; replace with fail-fast or a valid value; document in the env contract (consumed by T1a-11a).
Verify: `grep -rn "claude-opus-4-5-20250101\|text-embedding-3-small" apps/` → 0 hits; boot without the vars exits with named errors.
Deps: none. Solo.

**P0-7 (M)** Resolve dangling capabilities + context-aware roster drift.
De-advertise **only** `payment.method.switch` + `payment.retry` (`pack-payments/capabilities.ts:84-88`); journeys re-add behind `blocked_by: ws4`. `reservation.checkin`/`complete` are **left alone** — staff-route-only by design (live planner pins `staffId:null`; admin routes adjudicate direct envelopes; the pack test at `reservations-pack.test.ts:531-541` asserts the staff seam — do not delete it). Extend `toolRosterDrift()` (`:423-445`) to evaluate capability planners under **named contexts** (authed-customer; staff) asserting advertised ⊆ registered per context — with the documented staff-chat exception whitelisted — and warn on registered-but-unadvertised (`order.review.submit`).
Accept: boot passes; a planner-advertised-but-unregistered kind in the authed-customer context fails drift.
Verify: `pnpm --filter @ibatexas/api exec vitest run src/__tests__/tool-roster-integrity.test.ts`
Deps: none. Solo.

**P0-8 (S)** Pack-composition workspace package.
Create `@ibatexas/packs-composed` (workspace package importing the five packs; exports the composed list + intent-union helper). `apps/api` re-imports it (one composition site); the CLI/journeys gates import it too — **an apps/api export is unreachable from packages/, which is why this must be a package** (the §9-recorded failure mode).
Verify: `tool-roster-integrity.test.ts` imports it; `pnpm --filter @ibatexas/api test` green.
Deps: none. Solo.

**P0-9 (S)** Inject `PostgresAdvisorySessionLock` into `createConductor` (`:1248-1271`; pgPool at `:1132`; exported by installed `@claustrum/memory-postgres`).
Accept: two processes contending on the same (channel, customerId) serialize.
Verify: `grep -n "sessionLock" apps/api/src/claustrum-bootstrap.ts` shows the injection; lock test green.
Deps: none. Solo.

**P0-10 (S)** Commit the decision record (`docs/agents/`: 6 existing files + this plan + the Phase-A ledger).
Verify: `git -C ibatexas log --oneline -1 -- docs/agents/`
Deps: none. Solo.

**P0-11 (S)** Fix the scenario lock primitive (`packages/cli/src/lib/lock.ts`): GET-then-SET → `SET NX EX`; Lua conditional release (rule #10; reference `apps/api/src/whatsapp/session.ts`).
Verify: `pnpm --filter @ibatexas/cli exec vitest run src/__tests__/lock.test.ts`
Deps: none. Solo.

**Phase 0 exit criterion** (fresh agent): `cd ibatexas && ./scripts/check-bypass.sh && pnpm test` green; the two named new vitest files green; the P0-5/P0-6 greps empty.

### Phase 1a — Journey Registry, oracle kit, first green journey (~4–5 weeks)

**T1a-1 (M)** `@ibatexas/journeys` package + journey schema v1 + events home.
Zod `JourneyFileSchema`: `{id: JOURNEY-NNN, title, businessCase, persona, channel, params?, acts[] (sequential; kind: chat | http | fixture), expects[] {intentKind, decision}, verify[] (invariant id + harness-bound args), status: active|blocked, blocked_by[], source}`. **Act-kind semantics (governance):** `chat`/`http` = public surface only; `fixture` = *preconditions only* via existing seed helpers — may NEVER publish NATS, mint SYSTEM-taint envelopes, or write any state that later appears in `expects`/`verify` (the reconciliation gate enforces that asserted kinds have matching audited envelopes). Lint rejects raw Medusa ids (`prod_`/`variant_`/`cart_`) — handles only. Move the JSONL event emitter from `packages/cli/src/lib/events.ts` into `@ibatexas/tools` and extend its union (`journey.*`, `act.*`, `llm.call` with per-call `inputTokens`/`outputTokens`, `evidence.*`) — dependency direction stays one-way (journeys→tools, cli→journeys, cli→tools; **no cli↔journeys cycle**; journeys ships its own small sequential runner — `runPipeline` stays cli-internal). Sonar: add the package to `sonar.sources` (explicit decision, not drift).
Verify: `pnpm --filter @ibatexas/journeys test`
Deps: P0-8. Solo.

**T1a-2 (M)** Roster gate (`ibx journey lint` — thin cli registration calling the journeys API).
Every `expects.intentKind` ∈ `KNOWN_INTENT_KINDS`; chat-act expectations ⊆ planner-advertised∪registered per DR-5; staff-http expectations ⊆ staff-route kinds; `verify` refs resolve; persona/act surfaces real. Idiom: baseline JSON + `--verify-file` + `--json` + nonzero exit (exactly `kernel pack-bom`'s).
Verify: `ibx journey lint --json; echo $?` → 0; bad fixture → 1.
Deps: T1a-1, P0-7, P0-8. Solo.

**T1a-3 (M)** Coverage gate (`ibx journey coverage`).
Cell-level per DR-5 (incl. staff-route kinds as staff-http cells); waivers at `packages/journeys/governance/journey-coverage-waivers.json`; covered→uncovered fails; quarantined journeys' cells become `waived-quarantined` (visible, never silently covered). Emits `coverage-matrix.json` + journey-pass view.
Verify: `ibx journey coverage --verify-file packages/journeys/governance/journey-coverage-baseline.json --json; echo $?` → 0.
Deps: T1a-1, T1a-2. Solo.

**T1a-4 (S)** authFixture — offline JWT minting, cookie transport, fingerprint-gated.
Customer JWT (HS256 test `JWT_SECRET`, `{sub, userType:'customer', jti, aud:'token'}`) delivered as the **`token=` cookie** (the API has no header path; staff strictly the `staff_token` cookie; jti revocation needs Redis up). Staff requires a seeded *active* Staff row (`ibx auth create-staff`). **The minting helper refuses to run unless the test-fingerprint env var is present** (governance: containment beyond secret-distinctness) and lives only in `@ibatexas/journeys` (grep leg from P0-3).
Verify: contract test — minted customer cookie → `GET /api/me` 200; staff cookie → staff route 200; minting without the fingerprint var throws; prod-secret env rejects tokens.
Deps: T1a-11a (env). Solo.

**T1a-5 (M)** ChatClient with secret + cookie threading.
POST `/api/chat/messages` capturing `sessionSecret`/`sessionToken`, echoing `x-session-secret`/`x-session-token` on subsequent POSTs **and the SSE GET**; optional auth **cookie threaded on both POST and SSE GET** (authenticated journeys); turn-completion = SSE `done` + audit/projection barrier; buffered replay tolerated. Reference (not lift): `packages/cli/src/commands/api.ts:116-192`. Contract test first.
Verify: contract tests — guest two-turn conversation completes; authenticated conversation carries `request.customerId` (asserted via the audit row's sessionId/customerId).
Deps: T1a-11a/b. Solo.

**T1a-6 (S)** ProjectionBarrier (`awaitProjection` over `OrderProjection.version`/`OrderEventLog`; tolerates LGPD-anonymized payloads; never blind-sleeps).
Verify: vitest with a seeded projection bump.
Deps: none. Solo.

**T1a-7 (M)** AuditReader + AuditTrailMatcher (read-only role; EXACT/IN_ORDER/ANY_ORDER by run-sessionId namespace; `verifyAuditRecord`; supersession chains via the upstream walker — import, don't re-implement).
Verify: vitest over seeded rows incl. a supersedes chain.
Deps: T1a-9. Solo.

**T1a-8 (M)** Test-driver agent + JSONL trace.
~200-line Anthropic tool-use loop; act tools = **closed set {chat, http}** (the trigger-injection helper of T3-9 is *not* an act tool and is grep-gated against driver import); LLM surfaces entity ids into `ctx.vars` only; harness re-executes the invariant set with YAML-bound args; `maxTurns` + per-attempt token ceiling; `llm.call` events record per-call `inputTokens`/`outputTokens` (the dollar source — §7).
Verify: dry-run against a scripted stub; JSONL event-kind snapshot test.
Deps: T1a-5. Solo.

**T1a-9 (S)** Test-plane containment wiring (read-only Postgres role + GET-only verify HTTP client; P0-3 legs verified against the real package name).
Verify: oracle INSERT attempt fails; `./scripts/check-bypass.sh` green.
Deps: T1a-1. Solo.

**T1a-10 (S)** Environment handshake.
`testFingerprint` field on `GET /health` (set only by the test profile env); harness pre-flight: fingerprint + hostname denylist (via `infraEndpoints()`) + `ANTHROPIC_MODEL` == certification target + **`ANTHROPIC_API_KEY` presence** — all recorded into the trace.
Verify: harness vs dev stack (no fingerprint) refuses with a named error; vs test stack proceeds.
Deps: T1a-11a/b. Solo.

**T1a-11a (M)** Test infra composition + env contract.
`docker-compose.test.yml` = the four infra services (clone of dev compose) with **dedicated ephemeral containers per run, host ports overridden via env** (`POSTGRES_PORT` etc.) and resolved via `infraEndpoints()` — the declared isolation model is *one composition per run*; shared-local-infra mode is forbidden (if ever wanted, the checklist extends to Postgres DB names, Typesense collections, NATS subjects). Env contract (explicit, ≥32-char distinct secrets — the NODE_ENV=test random-secret fallback breaks cross-process auth): `JWT_SECRET`, `STAFF_JWT_SECRET`, `REDIS_PASSWORD`, `TYPESENSE_API_KEY`, `APP_ENV` (injected **before process boot** — `rk()` captures at module load), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `EMBEDDING_MODEL_ID`, `WEB_GATEWAY_SIGNING_KEY`, the fingerprint var. Redis DB-index isolation for BullMQ kept as defense-in-depth.
Verify: `docker compose -f docker-compose.test.yml up --wait && ibx svc status` (infra healthy).
Deps: P0-6. Solo.

**T1a-11b (M)** App-boot test profile + boot/seed measurement.
**No compose file anywhere runs Medusa** (dev compose is infra-only; prod compose lacks commerce) — apps boot via a **process-compose test profile** (`process-compose.test.yaml`: api :3001 + commerce :9000 + their existing readiness probes, loading the T1a-11a env file; web/admin excluded until T2-7 needs them). Includes the `ibx bootstrap` migration layers + `ibx test seed` as counted steps; **measure and record boot+seed wall-clock** (this number re-baselines §7). Medusa containerization is explicitly *not* undertaken (greenfield, multi-day — deliberately avoided).
Verify: `process-compose -f process-compose.test.yaml up -D && curl -s localhost:3001/health | jq -e .testFingerprint && ibx test seed`
Deps: T1a-11a. Solo.

**T1a-12 (M)** Author JOURNEY-001…009.
**001 authenticated-customer place+cancel** (the exit journey — checkout/cancel are auth-gated in the planner; guests structurally cannot; authFixture cookie via ChatClient); 002 amend (auth); **003 checkout-failure-recovery — `blocked_by:[handoff-port-noop, chat-confirmation-resume]`; note: T3-8 closes only the former; the journey stays blocked until the web confirmation-resume product gap is fixed (no phase closes it — §"product gaps")**; 004 payment-method-switch `blocked_by:[ws4]`; 005 delivery→pickup conversion; 006 cancel-after-PONR **expecting REFUSE**; 007 PIX-pending **expecting DEFER**; 008 forged-actor HTTP probe **expecting 400 `forgery_attempt` + system-actor REFUSE audit record** (exactly assertable per `customer-intent-gateway.ts`); **009 guest-negative**: guest builds a cart via chat, journey asserts checkout is **not proposable** (no `order.checkout.create` envelope appears; reply does not offer checkout) — the auth-gating fact as a pinned negative. Variants as `params`, never new IDs.
Verify: `ibx journey lint --json` → 0; coverage reports expected cells.
Deps: T1a-1..T1a-3. Solo.

**T1a-13 (M)** JOURNEY-001 green twice, with measured cost.
Full loop: infra up → apps up → seed → driver 001 → invariants (Prisma RO goal-state, audit trajectory, barrier) → JSONL + cost report computed from `llm.call` in/out events × the checked-in price table (driver vs SUT split). Expects-matching ignores noop/smalltalk dispatches (New fact 18). **Acceptance includes recording the measured per-attempt token/cost split and re-baselining §7 from it.**
Verify: `ibx journey run JOURNEY-001 --k 2 --json; echo $?` → 0 twice consecutively, cost line printed.
Deps: T1a-4..T1a-11b. Solo.

**Phase 1a exit criterion (fresh agent):** `docker compose -f docker-compose.test.yml up --wait && process-compose -f process-compose.test.yaml up -D && ibx test seed && ibx journey run JOURNEY-001 --k 2 --json` → exit 0 with a non-zero measured cost line; `ibx journey lint --json && ibx journey coverage --verify-file packages/journeys/governance/journey-coverage-baseline.json` → exit 0.

### Phase 1b — gates + CI hardening (~2–3 weeks)

**T1b-1 (M)** Reconciliation gate: declared `expects` vs observed `intent_audit` per run-sessionId namespace; **unexplained envelopes fail** (noop dispatches excluded); also enforces the fixture-act governance rule (asserted kinds must have audited envelopes — no fixture-forged assertions). Verify: negative fixtures for both. Deps: T1a-7, T1a-13.
**T1b-2 (M)** NatsCapture: publish-incapable client (no publish methods at type + runtime guard), `expectSubjects()`, check-bypass leg. Verify: vitest + type-level test. Deps: T1a-9.
**T1b-3 (M)** `ibx kernel replay` → CI gate: drift exit 2 / errors exit 1 / `--json`; `--ci` hard-fails on unset `IBX_AUDIT_POSTGRES_ENABLED` **or empty window**; **excludes agent-namespace session_id prefixes** (forward-protection for Stage-0 shadow rows — governance critic); empty-state limitation documented in output. PR-gate via path filter on policy/guard files. Verify: seeded-drift test of all exit codes. Deps: P0-1.
**T1b-4 (M)** Nightly workflow (`on: schedule + workflow_dispatch`): GH-hosted runner (ephemeral — teardown by VM destruction; if ever self-hosted: `if: always() — docker compose down -v --remove-orphans`); pnpm install/build, infra compose, process-compose test profile, seed, suite (pass^k k=4 money flows, k=1 exploratory), artifacts (JSONL, coverage-matrix.json, sim_runs export; retention 30 days). Secrets: dedicated **spend-capped `ANTHROPIC_API_KEY`** as a repo environment secret. Flake policy *with ownership*: retry-once = yellow; quarantine after 2 consecutive flakes (listed in artifact + coverage as `waived-quarantined`); **de-quarantine** = green twice on manual re-run; **hard (non-flaky) failure or red run auto-files a GH issue** (assignable owner field in the flake-ledger entry); model per DR-1. Verify: `gh workflow run journeys-nightly && gh run watch $(gh run list --workflow journeys-nightly -L1 --json databaseId -q '.[0].databaseId') --exit-status`. Deps: T1a-13, T1b-1, T1b-8.
**T1b-5 (S)** `sim_runs`/`sim_results` tables + writes (sessionId join; hashed schemas untouched; records model id + certifying/non-certifying flag). Verify: SQL join returns the run's decisions. Deps: T1a-13.
**T1b-6 (S)** SEMCONV add-only keys — upstream PR to `@adjudicate/observability`. Verify: upstream tests green; keys emitted on journey runs. Deps: none.
**T1b-7 (S)** Per-run journey locks (SET NX + Lua, per-runId keys). Verify: different journeys don't serialize; same journey does. Deps: P0-11.
**T1b-8 (S)** Suite-level dollar abort: runner aggregates cumulative cost from `llm.call` events after each journey; ≥ cap → abort as a **red run**, remaining journeys reported `aborted-by-budget` (never silent truncation). The Redis `llm:tokens` counter is *not* the dollar source (combined total — New fact 24); it remains the kernel budget-guard input. Verify: low-cap test run aborts red with the report. Deps: T1a-8.

**Phase 1b exit criterion:** three consecutive nightly runs green/explained (`gh run list --workflow journeys-nightly -L 3`), each with coverage-matrix + sim_runs artifacts; `ibx kernel replay --ci --json` is a required check on a policy-touching test PR; a forced low-budget run aborts red.

### Phase 2 — coverage, paid states, visualization (~3–4 weeks)

**T2-1 (M)** Paid-state fixture, kernel-routed: the asserted paid **transition must be driven through the real signature-verified Stripe webhook route** (locally signed with the test-plane `STRIPE_WEBHOOK_SECRET` → `buildSystemEnvelope` → adjudicate → projection). `toOrderProjectionData()` is restricted to **pre-seeding historical context** (reorder/review journeys) — never forging the asserted state (governance critic). Verify: paid journey's payment transition appears in `intent_audit`.
**T2-2a/T2-2b (M+M)** Journeys 010–016 split by domain: (a) orders/reservations/LGPD; (b) PIX defer→timeout, paid-state flows post-T2-1. payment-retry stays `blocked_by: ws4`; review-submit `blocked_by: unadvertised`.
**T2-3 (M)** `ibx journey from-audit <sessionId>`: scaffold YAML from `ibx chat dump --json` + the audit slice. Verify: scaffolded file passes lint.
**T2-4 (M)** `ibx graph export`: four derived graphs (capability incl. dangling/unadvertised flags; journey; run; impact from `intent_audit` aggregation **excluding agent-namespace prefixes** — same filter as T1b-3) + regenerate-and-diff CI gate. Verify: `ibx graph export --check`; a pack change without regeneration fails.
**T2-5 (M)** QA viewer (DR-3): one read-only app — React Flow + dagre over the graph JSONs, coverage matrix, run explorer. No authoring canvas, ever. Verify: renders all four from committed fixtures. Execution note: UI scaffolding is a worktree-isolated sub-agent task; the graph-JSON contract stays in the main session.
**T2-6a (M)** Scripted-pipeline harness: `bootstrapClaustrum(options?)` (modelProvider override) + **full reset hook** (`_conductor`, per-call pgPool, audit-sink DI, global metrics sink) + pg/pgvector/Redis test harness (reuse `h3-postgres-container`/`redis-testcontainer` patterns; `WEB_GATEWAY_SIGNING_KEY` in env). Verify: two sequential bootstraps in one vitest process don't cross-contaminate.
**T2-6b (M)** Content-keyed scripted ModelProvider (**complete + stream + embed** — the grounding provider calls embeddings) + CC-006-format fixtures with handle-canonicalized templates; runs in PR CI at zero token cost. Verify: a planner-prompt change breaks a fixture. Deps: T2-6a.
**T2-7 (S)** Playwright smoke + api-golden-path in CI. Verify: required check green.

**Phase 2 exit criterion:** `ibx graph export --check` and the coverage gate green with ≥14 active journeys; QA viewer renders committed fixtures; a paid-state journey runs nightly; T2-6b fixture suite green on PRs.

### Phase 3 — managed agent: PIX payment-failure remediation (~5–6 weeks)

Blocking prerequisites (constitution #10): P0-1 (ledger) + deterministic trigger nonces (T3-2) + WhatsApp outbound dedup key (T3-2).

**T3-0 (M)** Upstream claustrum PR + release: widen `ChannelKind` (`ports/channel.ts:23`) **and** `attest.ts:30`; lock-key strategy per DR-4 (honor `sessionKey` when supplied); version bump; ibatexas pin bump. **Acceptance includes a two-process serialization test**: concurrent trigger turn + chat turn for one customer under `PostgresAdvisorySessionLock` + the new strategy → audit rows strictly serialized. Verify: `pnpm -C claustrum test` green; serialization test green on the new pin. Execution note: small focused PR, opened first — release latency gates the phase.
**T3-1 (M)** SystemChannel ChannelDriver (adopter-side): `perceive()` turns a trigger event into an inbound **with `ChannelMessage.externalId = `${sourceSubject}:${eventId}`` — the per-turn carrier `deriveNonce` reads** (CognitiveState has no ctx field; `workingMemory` is a plain string — `perception.externalId` is the only structured channel, feasibility critic); `render()` journals; `matchToParked` null. Verify: unit test opens a capsule from a synthetic `payment.status_changed`. Deps: T3-0.
**T3-2 (M)** Trigger bridge + dedup stack: BullMQ worker (jobId = eventId — the proven `stripe-webhook-processor.ts:86` pattern); `deriveNonce` as a static planner dep reading `state.perception.externalId` (fallback `randomUUID` for conversational turns; **per-envelope suffix for multi-envelope plans**); per-entity cooldown keys; agent-caused-event suppression (skip events whose causal actor sessionId carries the agent prefix); WhatsApp outbound dedup key; host hard caps (max model calls + wall clock per trigger). **Acceptance includes a loop test**: synthetic event with agent-prefixed causal actor → zero capsules opened, suppression journaled. Verify: redelivery test (two deliveries → one EXECUTE + one suppressed) + cooldown test + loop test. Deps: T3-0, T3-1, P0-1.
**T3-3 (S)** AgentDefinition + registry + drift gate: zod manifest `{id, version, declaredIntentKinds, trigger, autonomyStage, budgets, killSwitchKey, owner}`; `agentRosterDrift()` (declared ⊆ registered; sessionId prefix ↔ registry) folded into the AI-BOM via the upstream pack-health/PackManifest mapping. Verify: `ibx kernel pack-bom --verify-file …` covers the agent; drift fixture fails.
**T3-4 (M)** Agent scope + budget guards, correct altitude and factories: `createAgentScopeGuard` is an identity/authorization check → **AUTH phase** (not business — `confirmOnAutoResolveGuard` is prepended to business and would short-circuit an out-of-scope `order.cancel` into REQUEST_CONFIRMATION before a business-phase scope guard could REFUSE; governance critic). Scope violations = custom REFUSE guard; over-budget = **`createEscalateGuard`** (threshold = agent budget reading the `llm:tokens`-shaped counter from state) — `createTokenBudgetGuard`'s action union is `REFUSE|DEFER` only and cannot ESCALATE (feasibility critic). **Conformance fixture: an out-of-scope kind from a registered agent yields REFUSE — not REQUEST_CONFIRMATION — even where confirmOnAutoResolve matches.** Verify: guard fixtures per decision path. Deps: T3-3.
**T3-5 (S)** Per-agent kill switch: reuse `startDistributedKillSwitchPubSub` + `createRedisEmergencyStateStore` keyed per agent; checked host-side before openCapsule and kernel-side (basis `kill.ACTIVE`); outside the seal pipeline. Verify: flip stops the next trigger within 1s. Deps: T3-3.
**T3-6 (M)** Stage-0 true shadow — fail-closed by construction: the shadow conductor composition gets a **dedicated sandbox ToolRegistry** (every tool id namespaced `sandbox:`, no real executors present) — *not* co-mingled `chooseImplementation` resolution (default is last-registered-wins; a mis-set ctx flag could route a real customer to the sandbox or the shadow agent to a real mutator — governance critic). Real tenants can never resolve sandbox tools and the shadow agent can never resolve real ones, by construction; a conformance check (via `options.checks`) asserts the shadow registry contains no real executor and backs the REWRITE path. **Shadow rows in `intent_audit` are real rows**: session-namespace isolation covers memory recall, and **every time-windowed production-signal consumer excludes the agent namespace** — the kernel-replay `--ci` query (T1b-3, already filtered), the impact graph (T2-4, already filtered), and the drift baseline; this exclusion is part of T3-6's acceptance. `agent_runs` journal; `@adjudicate/drift` over `AuditEventBus` monitors the shadow decision distribution. Verify: shadow run produces audit rows + journal and **zero Medusa/Prisma mutations** (oracle); CC-002 sample over the shadow tenant passes; replay `--ci` over a shadow-active window scans zero shadow rows. Deps: T3-1..T3-4, P0-2.
**T3-7 (M)** Approvals glue (Stage 1): host `createApprovalEngine` adopter-side (`resolveStateContext(sessionId)` into SessionPort state); webhook channel → staff notification; console resolve RPC → adopter resolve endpoint → `agent.confirm()` re-adjudication; provenance = sessionId agent prefix + `ApprovalRequest.resolvedBy` (DR-6); `INV-AGENT-CONFIRM-LINEAGE` (supersedes chain via the upstream walker + projection presence). Reference: `examples/vacation-approval`. Verify: parked agent envelope → approval → resolve → EXECUTE with intact chain. Deps: T3-6.
**T3-8 (S)** Wire HandoffPort (ESCALATE → the T3-7 notification channel). **Own acceptance** — a handoff-specific test asserting the queued notification artifact (JOURNEY-003 remains blocked on `chat-confirmation-resume`, which no phase closes — feasibility critic). Verify: ESCALATE decision produces the notification artifact (test). Deps: T3-7.
**T3-9 (M)** PIX remediation agent through the ladder: Stage 0 (≥1 week journaled, drift quiet) → Stage 1 (confirm-gated) → Stage 2 (auto for `pix.regenerate` only; refunds always confirm). Recovered-orders measurement in `sim_runs`/obs. Acceptance harness = the journey suite: seed failed-PIX order, fire the trigger via the **single allowlisted publish helper** — containment specified like the JWT helper's: importable **only** from the journeys acceptance harness (named check-bypass grep leg; not from the driver's closed act-tool set {chat, http, fixture}, not from apps/*), runtime-gated on the test fingerprint var (governance critic). Verify: `ibx journey run JOURNEY-0XX-pix-remediation --k 2` green per stage. Deps: all T3.
**T3-10 (M)** NATS server-side auth: execute `docs/security/NATS-AUTH-REQUIREMENTS.md` across **four** surfaces (dev compose, prod compose, terraform prod, dev-EC2 template); subscribe-only creds for the test plane; client migration (`NATS_CREDS_PATH`/`NATS_NKEY_SEED` plumbing exists). Verify: publish on capture creds rejected by the server; all services healthy. Deps: none technically; Phase-3 entry per DR-2.

**Phase 3 exit criterion (fresh agent):** PIX agent at Stage 1: `ibx journey run JOURNEY-0XX-pix-remediation --k 2 --json` exit 0; `agent_runs` shows ≥1 week Stage-0 journal + drift report; kill-switch, loop-suppression, redelivery, and serialization tests green; `ibx kernel pack-bom --verify-file` covers the AgentDefinition; replay `--ci` provably excludes the agent namespace.

### Phase 4 — extraction (trigger: second business domain; not before)

T4-1 skill-manifest wrapper (pack-health mapping). T4-2 `@claustrum/` extractions (journey runner / agent host / trigger channel) — only with domain #2. T4-3 MCP server for the oracle kit (claustrum roadmap v0.3.x). T4-4 upstream: additive `attestation` JSON-schema fix + golden vectors; approver-identity receipt extension (DR-6). Triggers documented; no tasks scheduled.

### Deliberately not built (re-verified)

| Not built | Revisit when |
|---|---|
| Transcript-replay against the SUT | Never as designed (cursor-stub provider, non-deterministic Medusa ids — formally verified); T2-6 scripted-completion is the variant |
| Medusa containerization | Only if the process-compose test profile proves unworkable in CI |
| Tester-as-Conductor | Never |
| Visual authoring canvas | Never |
| Multi-persona journey schema v2 | After T3-7 |
| Per-run isolated DBs / parallel journey runs | Projected suite wall-clock exceeds the 2h nightly cap |
| LLM-judge assertions | Marked fuzzy-text only, never state, never merge gates |
| A2A endpoint / MCP facade / orchestrator | Cross-org traffic / domain #2 |

---

## 6. Phase exit criteria (consolidated; each checkable by a fresh agent — exact commands in §5 phase footers)

P0 → §5 P0 footer. 1a → §5 1a footer. 1b → §5 1b footer. 2 → §5 Phase-2 footer. 3 → §5 Phase-3 footer.

## 7. Budgets (over-provisioned ceilings; T1a-13 measures and re-baselines)

**Token cost per journey-attempt.** Measured reality check (feasibility/operations critics, from the actual prompt assembly): the planner sends ~400-token system + single-turn perception text + a small tool surface (~1.0–1.6k in/turn); the responder is a one-liner — an 8-turn journey ≈ **$0.08–0.15 SUT-side** on Sonnet 4.6 ($3/$15 per MTok). The **driver** accumulates conversation context and likely costs as much or more. Planning ceiling: **$0.50/attempt combined** until T1a-13's measured split lands (the ceiling, not the estimate, drives the abort math; prompt sizes will grow when richer synthesis ships — re-baseline then).
**Dollar source:** per-call `inputTokens`/`outputTokens` in JSONL `llm.call` events × a checked-in price table (T1a-8/T1b-8). The Redis `llm:tokens` counter is a combined total — *not* dollar-convertible — and stays the kernel budget-guard input only.
**Nightly:** start ~10 journeys (k=4 money, k=1 exploratory ≈ 22 attempts) ≈ **$3–11/night at measured rates, ≤$11 at ceiling**; full 25-journey suite ≈ $25 ceiling. **Hard abort at $50/night** enforced by T1b-8 (cumulative, after each journey; abort = red run, remainder reported `aborted-by-budget`).
**Wall-clock:** boot+seed measured in T1a-11b (planning budget ≤15 min incl. pnpm install/build in CI); journeys sequential 2–5 min each → 22 attempts ≈ 44–110 min → **nightly cap = 2h hard**; the parallelization tripwire (per-run isolated DBs) fires when *projected* suite time exceeds 2h — not on night one. Per-attempt timeout 10 min.
**PR CI:** zero LLM tokens by construction (deterministic suites + T2-6b scripted fixtures + `kernel replay --ci`).

## 8. Risk register (top 10)

| # | Risk | Tripwire (observable) | Mitigation |
|---|---|---|---|
| 1 | Projection-lag flake | Failures passing on immediate retry; barrier-timeout lines in JSONL | ProjectionBarrier everywhere; tune from traces |
| 2 | Model nondeterminism erodes trust | Same journey alternating across nights, no code change | retry-once=yellow; quarantine@2 + de-quarantine rule; weekly transcript review; deterministic gates only |
| 3 | Cost runaway | Cumulative cost ≥80% of cap mid-suite | T1b-8 hard abort (red); per-attempt ceiling; spend-capped dedicated API key |
| 4 | Test plane forges NATS events (until T3-10) | None server-side today — that *is* the risk | Publish-incapable client + grep legs + fingerprint-gated single helper; server auth at Phase-3 entry; ephemeral env bounds blast radius |
| 5 | Trigger-vs-chat double adjudication | Interleaved audit rows, one customer, overlapping turns | P0-9 now; T3-0 lock-key + serialization test; T3-2 cooldowns + loop test |
| 6 | Shadow rows read as production signal | Replay `--ci` or impact graph counts shadow EXECUTEs | Agent-namespace exclusion in T1b-3/T2-4/drift baselines — acceptance-tested in T3-6 |
| 7 | `kernel replay` gate goes vacuous | Gate log: 0 records / flag unset | `--ci` hard-fails on empty window or unset flag |
| 8 | Journey handles drift from seeds | Lint green but acts fail entity-not-found | Handle-only rule; lint cross-checks handles against seed fixtures |
| 9 | Upstream claustrum release latency | T3-0 PR open >1 week | Opened first; small focused diff; ibatexas work proceeds behind the pin |
| 10 | Staff rubber-stamp approvals | Median approval latency <5s or ≈100% approve rate | Provenance UI; weekly sampled review; ladder advance requires reviewed evidence |

## 9. Critic report (Phase D — actual)

Three critics (feasibility, operations, governance) attacked the draft: **12 must-fix, 16 should-fix, 3 accepted-risk.** All three also reviewed the draft's *provisional* critic report and found it understated reality; this section replaces it with what actually happened.

**Critic 1 — feasibility vs code.** Killed: (1) **JOURNEY-001 as a guest journey** — `order.checkout.create`/`order.cancel` are planner-advertised only when `isAuthenticated`, and chat guests get `customerId: null`; the flagship/exit journey is now authenticated, and the guest case became negative JOURNEY-009 (checkout *not* proposable). (2) **T1a-11 "clone dev compose"** — dev compose is infra-only and no compose anywhere runs Medusa; replaced by T1a-11a (infra) + T1a-11b (process-compose test profile), Medusa containerization explicitly not undertaken. (3) **T3-8's acceptance** (JOURNEY-003 passes) — impossible while `chat-confirmation-resume` stays open; T3-8 got its own handoff-artifact acceptance. (4) **P0-7's de-advertising of the staff reservation kinds** — misread; they're staff-route-only by design (live planner pins `staffId:null`; admin routes adjudicate direct envelopes); P0-7 shrank to the payment kinds and the drift extension became context-aware. (5) **T3-4's "budget guard ESCALATEs"** via `createTokenBudgetGuard` — its action union is `REFUSE|DEFER`; rewired to `createEscalateGuard`. Forced: the `deriveNonce` per-turn carrier named (`perception.externalId` via T3-1 — CognitiveState has no ctx field); T2-6 split (bootstrap reset must handle pgPool/audit-sink DI/metrics sink; the scripted provider must implement `embed`); cookie transport for JWTs (no header path; staff strictly cookie); the journeys↔cli workspace cycle broken (events emitter moves to @ibatexas/tools; journeys ships its own runner); P0-8's home named as a workspace package; P0-2/P0-3 containment directions reconciled. Accepted: `gh workflow run` needs `workflow_dispatch` (added); baseline paths pinned; verified-clean: P0-1's one-call claim, the `--verify-file`/`--json` idiom match, `--k` flag parsing, DAG acyclicity.
**Critic 2 — operations.** Killed: (1) the draft's **boot/wall-clock model** — it priced Medusa boot into a composition that contained no app services at all, and §7's own arithmetic (22 attempts × 2–5 min) blew the 45-min cap on night one; nightly cap is now 2h with the parallelization tripwire set where the suite won't trip it by construction. (2) The **dollar-abort data source** — the Redis counter stores an unsplittable in+out total; cost now computes from JSONL `llm.call` events × a price table, with a new owning task (T1b-8) for the suite-level abort. Forced: **`ANTHROPIC_API_KEY`** (hard-required by config, absent from the draft's env list) and `EMBEDDING_MODEL_ID` (a second bogus default of the P0-6 class) into the env contract and pre-flight; the isolation model declared (one ephemeral composition per run; Redis DB-index demoted to defense-in-depth); flake-policy ownership (red runs auto-file an issue; owner field; de-quarantine rule; quarantined cells visible as `waived-quarantined`); loop-suppression and trigger-vs-chat serialization got named test coverage (T3-2, T3-0); token estimates re-derived from the real prompt assembly (~5× lower than the draft) and reframed as measured-ceiling with mandatory re-baseline. Accepted: GH-hosted-runner teardown-by-ephemerality (with the self-hosted cleanup line recorded); artifact retention 30 days.
**Critic 3 — governance & safety.** Killed: (1) the draft's **"session-namespace isolation suffices for Stage 0"** — shadow EXECUTE rows land in the real `intent_audit` and the kernel-replay CI gate and impact graph scan time windows with no principal filter; both now exclude the agent namespace, acceptance-tested in T3-6 and forward-built into T1b-3/T2-4. (2) **Co-mingled `chooseImplementation` sandbox routing** — the default is last-registered-wins, and a mis-set flag could route a real customer to the sandbox or the shadow agent to a real mutator; replaced by a dedicated sandbox ToolRegistry in the shadow composition, fail-closed in both directions by construction, with a conformance check. (3) The draft's **own §9 claim** that the T3-9 helper was "the only publish-capable test path" — refuted by the draft's *other* hand: the `system-fixture` act kind was undefined and author-reachable; act kinds are now `chat|http|fixture` with `fixture` bounded to preconditions (never publish, never SYSTEM taint, never asserted state), and the publish helper got JWT-grade containment (named grep leg + fingerprint runtime gate + excluded from the closed act-tool set). Forced: the agent scope guard moved to the **AUTH phase** (in business, `confirmOnAutoResolveGuard` would short-circuit an out-of-scope money kind into REQUEST_CONFIRMATION before the scope guard could REFUSE) with a conformance fixture proving REFUSE; JWT minting gated on the fingerprint env var (not just secret-distinctness); T2-1's paid state must be driven through the real signed webhook (direct projection writers restricted to preconditions); the precondition-vs-asserted-state rule made explicit and enforced by the reconciliation gate. Accepted: NATS forgery residual until T3-10 (bounded, documented — DR-2).

---

*End of plan v2. Implementation starts at P0-1; every Phase-0 task is independently executable from its own description.*
