# Fresh gap report — 2026-05-23 evening synthesis

**Branch:** `feat/kernel-always-on-cutover` (pushed to origin, 193 commits ahead of `main`)
**Cutover commit:** `f3bea43` — *IBX-IGE v3.0: always-on cutover, delete staged-rollout machinery*
**Method:** 5 parallel read-only investigation agents
**Source reports:**
- [cutover-consistency.md](./cutover-consistency.md)
- [coverage-baseline.md](./coverage-baseline.md)
- [open-blockers-reconciliation.md](./open-blockers-reconciliation.md)
- [adjudicate-sibling-state.md](./adjudicate-sibling-state.md)
- [net-new-findings.md](./net-new-findings.md)

---

## TL;DR

The migration is **far further along than the master plan suggests**. The "dormant kernel" premise the orchestrator brief assumes is **false** — the kernel is always-on and authoritative; shadow/enforce/kill-switch infrastructure has been **deleted**, not just enabled.

**Fresh coverage baseline:** ~**88% adjudicated** (140 wrapped / 159 enumerated entrypoints), counting documented deferrals as known scope. ~**75%** if those deferrals are counted as bypass. Up from ~65% at W6.

**Open-item ledger:** Of ~52 pre-existing items: **38 CLOSED**, **9 STILL OPEN**, **3 deliberately deferred**, **2 unclear**. The kill-switch surface deletion **mooted** several W7 operational items.

**One genuine production bug found**: `apps/api/src/subscribers/audit-consumer.ts:68` still gates the NATS audit-consumer (the durability *redundancy* path) on `IBX_AUDIT_POSTGRES_ENABLED !== "true"`. Post-cutover the in-process Postgres sink is always-on; the consumer guard is stale. With the env var unset, redundancy is silently dormant.

**Stale documentation is the biggest operator risk.** Three runbooks would actively mislead a 3am operator (they reference deleted CLI surfaces and env-var flips).

---

## Critical findings (severity-ranked)

### 🔴 P0 — production bug + operator-mislead-risk docs

| # | Finding | File / artifact | Effort |
|---|---|---|---|
| C1 | **NATS audit-consumer stale env guard** — durability redundancy is dormant | `apps/api/src/subscribers/audit-consumer.ts:68` | ~30min (delete guard + update comment) |
| C2 | **`svc.joinWaitlist` LLM-eligible kernel bypass** — pack kind declared, executor method missing | `packages/tools/src/reservation/join-waitlist.ts:29` | ~1h (add `joinWaitlistFromEnvelope` to service) |
| C3 | **Three mislead-risk runbooks** reference deleted shadow/enforce/kill-switch surfaces | `docs/adjudicate-migration/runbooks/SHADOW-ENFORCE-ROLLOUT.md`, `migration/04-shadow-enforce-sequencing.md`, `migration/05-kill-switch-strategy.md` | ~1-2h (archive to `superseded/` + banner) |
| C4 | **Stale `ibx kernel kill-switch` test suite** tests CLI commands the cutover deleted — will fail at runtime if exercised | `packages/cli/src/commands/__tests__/kernel.test.ts:422-680` | ~30min (delete or migrate) |

### 🟠 P1 — LLM-callable bypasses + Wave 9 epic

| # | Finding | File / artifact | Effort |
|---|---|---|---|
| H1 | LLM tools `update_preferences` + `submit_review` bypass kernel; `updatePreferencesFromEnvelope` exists | `packages/tools/src/intelligence/update-preferences.ts:22`, `packages/tools/src/intelligence/submit-review.ts:23` | ~2h (wrap; declare `customer.review.submit` kind if needed) |
| H2 | LLM tool `schedule_follow_up` directly `zAdd`s to Redis to schedule outreach 1–72h later, no audit | (cited in `net-new-findings.md`) | ~2-3h (new intent kind + envelope path) |
| H3 | **Wave 9 cart-egress** — 10 LLM-callable Medusa STORE-scope sites bypass kernel | `packages/tools/src/cart/*.ts` (10 sites) | ~3-5 days (`medusaStoreAdjudicated` wrapper + 10 migrations + tests) |
| H4 | 2× direct Twilio `messages.create` outside any wrapper | `apps/api/src/whatsapp/client.ts:132,204` | ~2h |
| H5 | 2× `svc.updatePixDetails` bare-arg calls (envelope path exists) | `apps/api/src/routes/cart.ts:130`, `packages/llm-provider/src/machine/actions.ts:401` | ~1h |

### 🟡 P2 — quick wins + completion items

| # | Finding | File / artifact | Effort |
|---|---|---|---|
| Q1 | **F2** — `kernel.intent_dispatched` basis code in sibling repo. Sibling repo `main` is clean and ready. | `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts` | ~15min in sibling + version bump + ibatexas consume |
| Q2 | **G3 hoist completion** — only `actorPrincipal` hoisted; `version/nonce/taint` not. Tier-4 enforce blocker for tamper-at-rest. | NX-wrapper adapter | ~30min (fail-loud refuse) |
| Q3 | **Task 14 `/address` + `/type`** routes still call legacy tools directly; pack kinds + methods exist | `apps/api/src/routes/order-actions.ts` (PATCH /api/orders/:id/{address,type}) | ~90min total |
| Q4 | `recordSinkFailure` not wired audit-redactor → metrics sink | `apps/api/src/intent-audit-wiring.ts` (comment marks site) | ~1h |
| Q5 | `LoyaltyService.addStamp` doc/code drift — docs say "Redis only" but it `prisma.loyaltyAccount.update`s | `open-blockers.md:42` + `LoyaltyService` | ~30min (doc fix or wrap) |
| Q6 | Dead code: `recordKillSwitchState`, `kernel_kill_switch_state` Prometheus gauge | Various | ~30min sweep |

### ⏸ Deliberate-defer or operator-action

| # | Item | Notes |
|---|---|---|
| D1 | WhatsApp `notification.send` / `handoff-subscriber` blocked on `lastCustomerMessageAt` state-builder | Confirmed still real; ~1-2d once state-builder design lands |
| D2 | Audit-Postgres SQL migrations applied + Postgres provisioning | Post-cutover, this is a **hard precondition** (no longer a flag flip). Operator action. |
| D3 | NATS auth deployment (per-message signing or auth tokens) | Operator action; enforce-readiness item |
| D4 | Task 13 pack-layer `REQUEST_CONFIRMATION` migration | Route-layer Redis-backed two-person rule is functionally equivalent today; deeper integration is M4-candidate |
| D5 | `customer.address.{add,remove}` executor wiring | Service-level abstraction doesn't exist; addresses live in route-direct Prisma. Larger refactor. |
| D6 | Conformance gate at top-level CI iterating all `@ibatexas/pack-*` | Useful follow-up; non-blocking |

---

## Stale planning docs (orchestrator should clean up before next handoff)

These are **authoritative-but-stale** — they describe a state that no longer exists. Risk: a future Claude session loads them as ground truth and acts on premises that contradict reality.

| Doc | Current claim | Reality | Recommendation |
|---|---|---|---|
| `MASTER_PLAN.md` | "Draft v0.1, no implementation started" | 193 commits, 9 waves complete | Mark superseded; link to `audit-2026-05-23/SYNTHESIS.md` |
| `current-state.md` | "M0-M6 task ledger" | M0-M6 complete; W1-W8 also complete | Replace with link to overnight + W7 summaries |
| `open-blockers.md` | Pre-W6 follow-up list | 38/52 items closed | Per Agent 3 reconciliation: prune closed items |
| `runbooks/SHADOW-ENFORCE-ROLLOUT.md` | Operator playbook for staged flips | Staged-rollout machinery deleted | Move to `superseded/` |
| `migration/04-shadow-enforce-sequencing.md` | Per-intent shadow→enforce sequencing | No env-var gating exists | Archive |
| `migration/05-kill-switch-strategy.md` | Kill-switch HTTP/CLI surfaces | Surfaces deleted | Archive |

---

## Cross-repo coordination items

| Item | Repo | Status | Effort |
|---|---|---|---|
| F2: `kernel.intent_dispatched` basis code | adjudicate | `main` clean; ready for PR | ~15min PR + cut release + bump consumer pin |
| Git tag publishing (npm-only releases create traceability gap) | adjudicate | `v0.1.1`, `v1.0.1` exist on npm but not as git refs | Upstream concern, document and move on |

---

## Aggregate "what's actually left" buckets

### Bucket A — Production-bug + operator-safety (close before next push)
- C1 audit-consumer guard (30min)
- C3 archive misleading runbooks (1-2h)
- C4 delete stale CLI tests (30min)

**Total ~2-3h. Highest priority — leaves the repo in a defensible state.**

### Bucket B — LLM-callable bypass closure (P0/P1 quick wins)
- C2 joinWaitlist (~1h)
- H1 update_preferences + submit_review (~2h)
- H4 Twilio direct calls (~2h)
- H5 updatePixDetails callers (~1h)

**Total ~6h. Closes 5-7 LLM-reachable mutation paths.**

### Bucket C — Wave 9 cart-egress epic
- H3: `medusaStoreAdjudicated` wrapper + 10 site migrations + tests

**Total ~3-5 days. Largest single piece of remaining LLM-tool work.**

### Bucket D — Completion / polish
- Q1 F2 cross-repo (~15min + release)
- Q2 G3 hoist (~30min)
- Q3 Task 14 /address+/type (~90min)
- Q4 recordSinkFailure (~1h)
- Q5 LoyaltyService drift (~30min)
- Q6 dead-code sweep (~30min)

**Total ~5h.**

### Bucket E — Doc rewrite
- Stale planning artifacts (MASTER_PLAN, current-state, open-blockers)
- Replacement: "current as-of YYYY-MM-DD" snapshot doc

**Total ~3h.**

### Bucket F — Operator-action (not engineering)
- D2 audit-postgres SQL migrations + provisioning
- D3 NATS auth deployment

### Bucket G — Larger architectural follow-ups
- D1 WhatsApp `lastCustomerMessageAt` state-builder (~1-2d, unblocks notification.send + handoff + cart-tier-escalation)
- D5 customer-address service abstraction (refactor)
- D4 Task 13 pack-layer confirmation
- D6 Conformance gate at top-level CI

---

## Recommended sequencing (orchestrator's view)

**Phase A (close-out, parallel-safe):** Buckets A + B + D — ~13-14h total wall-clock across 4-6 sub-agents in parallel. Disjoint file scopes; no merge conflicts expected.

**Phase B (epic):** Bucket C (Wave 9 cart-egress) — single sequential epic, ~3-5d.

**Phase C (housekeeping):** Bucket E (doc rewrite) — solo session; needs synthesis judgment.

**Phase D (waits on stakeholder):** Bucket F (operator action) + Bucket G item priority.

---

## Open questions for stakeholder

1. **F2 in sibling repo**: ready to PR. Coordinate the release cadence (publish a `kernel.intent_dispatched` basis code, cut a minor on `@adjudicate/core`, then bump ibatexas pin)?
2. **Doc archival**: confirm `MASTER_PLAN.md`, `current-state.md`, `open-blockers.md` can be marked superseded vs. rewritten in place. Same for the 3 mislead-risk runbooks.
3. **Wave 9 scope confirmation**: build `medusaStoreAdjudicated` per the W9 backlog, or take a different approach (e.g., re-route cart tools through the existing `OrderCommandService` envelope path)?
4. **WhatsApp `lastCustomerMessageAt` state-builder design**: there's no design doc yet; it unblocks ~7 deferred subscriber/job sites. Worth a focused design session?
5. **Implementation pace**: parallel agent sprint (close Bucket A+B+D in one session) vs. serial review (close one bucket per session with human sign-off in between)?

---

## What this report does NOT cover

- Latency/throughput regression analysis of the always-on kernel under load. The W3 testcontainer suite covered correctness, not performance.
- Cross-repo conformance matrix execution (the harness exists; CI gate doesn't).
- Threat model refresh for the cutover-deleted operational surfaces (some attack surface was removed *with* the staged-rollout machinery — net-effect is positive but unaudited).
- Independent verification of the W6 Red-Team's 17 exploit-demonstration tests post-W7/W8. They should still pass; nothing checked since.
