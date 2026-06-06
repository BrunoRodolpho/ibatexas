# Civilization Health Report — 2026-05-24

**Lens:** sovereign-civilization-kernel (institutional memory, constitutional coherence, entropy regulation, long-horizon survivability)
**Branch:** `feat/kernel-always-on-cutover` @ `3f36bc1` (post-H2 closeout)
**Method:** post-closeout reconnaissance of the institutional-memory layer above tactical code
**Scope of this report:** the META layer (docs, constitution, governance artifacts), NOT the tactical code which the audit-2026-05-24 sweep already covered.

---

## TL;DR

The civilization just finished a major Phase-2 metabolic cleanup (audit-2026-05-24 closeout — 18 commits, 9/9 P0 + 8/8 P1 + 8/8 P2 + 6/7 hardening conformance suites). The TACTICAL frontier is in excellent shape.

The META layer — institutional memory, constitutional coherence, governance topology — has measurable drift:

1. **CLAUDE.md is internally contradictory.** Line 18 points future engineers at a "4-stage shadow → enforce playbook" that **does not exist** (the cutover deleted the framework; rule #9 affirms "no shadow mode, no kill switch"). Constitutional inconsistency.
2. **`docs/adjudicate-migration/README.md`** — the canonical entrypoint — points at the 2026-05-23 SYNTHESIS as "current state" but `audit-2026-05-24/CLOSEOUT-STATUS.md` is now authoritative.
3. **Three unbannered pre-cutover ledgers** (`task-graph.md`, `decisions-log.md`, `OVERNIGHT-RUN-SUMMARY.md`) look current to a fresh reader but document deleted machinery and an aborted pre-cutover phase.
4. **Eight subdirectories** (`audit/`, `deep-audit/`, `investigation/`, `remediation/`, `correctness-remediation/`, `governance/`, `migration/`, `threat-model/`) hold a mix of (a) load-bearing constitutional artifacts that must persist, (b) pre-cutover historical records that need superseded-banners, and (c) work-product that's stale. **No per-directory README classifies which is which.**
5. **No civilization-map / governance-topology atlas exists.** Despite ~40 docs in `adjudicate-migration/`, none is the "you are here, here are the trust boundaries, here is the mutation graph, here is the audit pipeline" single-page topology.
6. **P0-2 is reported "CLOSED" but is partially closed.** The T6 conformance test demonstrates 1-4% violation per 100 iterations (R2-1 SETNX mutex has a release-ordering bug). The audit ledger needs to reflect institutional truth: P0-2 has a known race v2 tracked under E2.

The civilization is healthy at the code frontier and drifting at the institutional layer. This is the inverse of the typical aging system — usually entropy enters via the code first.

---

## Entropy hotspots (ranked by severity × leverage)

### H-α — Constitutional contradiction in CLAUDE.md line 18

**Severity:** high (constitutional law contradicts itself)
**Leverage:** very high (one-line fix; CLAUDE.md is read by every agent + every new contributor)
**Evidence:**
- Line 18: `| Kernel rollout — 4-stage shadow → enforce playbook | [docs/ops/runbooks/](docs/ops/runbooks/) |`
- Line 43 (rule #9): `**The kernel is always authoritative** — no env-var gating, no shadow mode, no kill switch`
- `docs/ops/runbooks/` contains only `kernel-operations.md` (no staged-rollout playbook exists)

Future readers parsing the table at line 18 will assume a 4-stage shadow→enforce framework exists, contradicting the constitutional rule three lines below.

**Fix shape:** change line 18 to point at `kernel-operations.md` and rename the row to reflect always-on reality.

### H-β — README.md entry-point staleness

**Severity:** medium-high (canonical entrypoint misdirects)
**Leverage:** very high (one-line fix; first doc a new reader will hit)
**Evidence:**
- `docs/adjudicate-migration/README.md` says "Current state + gap analysis: audit-2026-05-23/SYNTHESIS.md"
- audit-2026-05-24/CLOSEOUT-STATUS.md is now authoritative (supersedes the 2026-05-23 synthesis for outstanding items)

**Fix shape:** update the entrypoint to point at the 2026-05-24 closeout doc; preserve the 2026-05-23 pointer as historical.

### H-γ — Unbannered pre-cutover ledgers

**Severity:** medium (looks current; will mislead)
**Leverage:** high (three banner-additions; clear classification)
**Evidence (all top-level, no SUPERSEDED banner):**
- `task-graph.md` — "Per-task ID completion record" — pre-cutover M3 task ledger
- `decisions-log.md` — "Every non-trivial judgment call made during the overnight autonomous run" — pre-cutover decisions
- `OVERNIGHT-RUN-SUMMARY.md` — "Started: 2026-05-22 (you signed off) Finished: 2026-05-23" — overnight session summary

Compare to MASTER_PLAN.md / current-state.md / open-blockers.md which **do** have `⚠️ SUPERSEDED on 2026-05-23` banners.

**Fix shape:** add SUPERSEDED banners with pointers to current state. Same template as MASTER_PLAN.md banner.

### H-δ — P0-2 closure status is institutional-record-wrong

**Severity:** medium-high (institutional record contradicts forensic reality)
**Leverage:** medium (one CLOSEOUT-STATUS edit + create E2 follow-up artifact)
**Evidence:**
- CLOSEOUT-STATUS.md says P0-2 closed at `a1fbb25` (R2-1 SETNX mutex)
- T6 conformance suite documented 1-4% violation rate per 100 iterations
- T6 currently passes at 10% tolerance — the institutional record looks clean while the prod race persists

**Fix shape:** re-classify P0-2 in CLOSEOUT-STATUS as "partially closed; race v2 tracked under follow-up E2"; create an explicit `tasks/e2-sweeper-resolver-race-v2.md` so the institutional record matches reality.

### H-ε — Per-directory README classification missing for 8 subdirs

**Severity:** medium-low (latent institutional ambiguity, no immediate misdirection)
**Leverage:** medium (per-dir audit + classification, ~30 min)
**Subdirectories needing classification:**
- `audit/` — 9 docs from a pre-cutover audit pass
- `deep-audit/` — 10 docs from a deeper pre-cutover audit
- `investigation/` — 8 docs from Phase-1 investigation
- `remediation/` — 4 docs (`NATS-AUTH-REQUIREMENTS.md`, `REMEDIATION-COMPLETE.md`, `REMEDIATION-STATE.md`, `W3-INTENT-GAPS.md`)
- `correctness-remediation/` — W7 closure docs + Wave 9 backlog
- `governance/` — 7 docs (intent-taxonomy, capability-model, trust-boundary-model, etc.) — likely **load-bearing constitutional artifacts that must persist**
- `migration/` — 5 docs after the 04+05 archival (01-rollout-strategy, 02-milestones, 03-blast-radius-analysis, 06-observability-requirements, 07-production-safety-checklist)
- `threat-model/` — 1 doc (`THREAT-MODEL.md`)

**Fix shape:** per-dir README.md classifying each doc as (a) load-bearing-constitutional / (b) historical-preserved / (c) superseded-with-pointer. Some load-bearing docs (governance/, migration/03-blast-radius, threat-model/) should NOT be banner'd; they're still authoritative.

### H-ζ — No civilization-map / governance-topology atlas

**Severity:** low-medium (latent — manifests when scale or onboarding pressure rises)
**Leverage:** high long-term, medium short-term (~2-3h to do well)
**Evidence:**
- The audit findings reference: trust boundaries, kernel authority, audit pipeline, capability registry, mutation graph, intent taxonomy, refusal taxonomy, deferred execution model.
- Each of these concepts is scattered across multiple docs (`governance/03-trust-boundary-model.md`, `governance/02-capability-model.md`, etc.).
- No single doc maps the whole topology in one place.
- A new contributor or a future-Claude-session has to assemble the picture from ~10 docs.

**Fix shape:** produce `docs/architecture/governance-topology.md` — a single-page atlas with: trust-boundary diagram, kernel/wrapper/sink data-flow, capability-registry layout, mutation-graph high-level, audit-pipeline (in-process + NATS + Postgres), deferred-execution model, replay topology. Links into the deep docs for each. ~2-3h of focused synthesis.

### H-η — `pix.charge.refund.reason` redactor rule (E1 minor)

**Severity:** low (one free-form field; logged as warning in CI)
**Leverage:** very high (~5 min fix; closes the only known KNOWN_REDACTOR_GAP)
**Evidence:** T3 conformance suite emits `console.warn` on every CI run citing this kind.

**Fix shape:** add `"pix.charge.refund": ["reason"]` to `INTENT_KIND_FIELD_RULES` in `packages/llm-provider/src/audit-redactor.ts`.

### H-θ — Workspace dist-build ergonomics

**Severity:** medium (institutional friction; every contributor will hit it)
**Leverage:** depends on solution; likely 4-8h investigation + implementation
**Evidence:**
- Polish-A had to run `pnpm -F @ibatexas/nats-client build` to refresh `dist/index.d.ts` before api typecheck would resolve.
- P2-8 v2 reported 172 + 78 pre-existing typecheck errors in `tools` + `llm-provider` from cross-package `@ibatexas/types` / `@ibatexas/nats-client` resolution.
- Cross-package tests in `apps/api` can't run without `dist/` builds.

The pattern of source-imports-from-`dist/` instead of source-imports-from-`src/` is an institutional choice (likely from when `apps/api` consumed pre-built packages). Post-monorepo, this creates friction. **Worth a focused investigation** before deciding whether to migrate to `tsc --build` orchestration or source-imports config or stay on the current pattern with better tooling.

---

## Governance drift (constitutional integrity)

The audit-2026-05-24 closeout largely aligned ARCHITECTURAL governance with REAL governance. Two remaining alignments:

1. **CLAUDE.md ↔ rule #9** — line 18 entry contradicts rule #9 (see H-α).
2. **CLOSEOUT-STATUS.md ↔ T6 empirical evidence** — P0-2 "closed" classification contradicts T6's documented 1-4% violation rate (see H-δ).

Both should be addressed in this session.

ADR file (`docs/architecture/decisions.md`) is in good shape — all 14 ADRs present, ADR #14 documents the cutover. CLAUDE.md ADR references (#9, #13, #14) all resolve. Constitutional record is structurally sound at that layer.

---

## Institutional memory hazards

Pre-cutover institutional records that future engineers may misread as current:

| Doc | Risk | Recommended action |
|---|---|---|
| `task-graph.md` | High — looks like current task ledger | Add SUPERSEDED banner (now) |
| `decisions-log.md` | Medium — could be misread as live ADR log | Add SUPERSEDED banner with pointer to `docs/architecture/decisions.md` (now) |
| `OVERNIGHT-RUN-SUMMARY.md` | Medium — looks like recent status | Add SUPERSEDED banner (now) |
| `audit/AUDIT-SYNTHESIS.md` | Low — already named "AUDIT-SYNTHESIS" so reader will assume historical | Per-dir README classification |
| `deep-audit/MASTER-DEEP-AUDIT.md` | Low — same | Per-dir README classification |
| `correctness-remediation/WAVE9-CART-EGRESS-BACKLOG.md` | Medium — wave 9 was completed but doc says backlog | Update or banner |
| All `governance/*` | None — these are likely load-bearing | Per-dir README to confirm authoritative status |

---

## Evolutionary forecasting

Three areas where the civilization will face entropy pressure in the next 6-18 months:

### F-1 — Cross-repo treaty erosion (adjudicate sibling ↔ ibatexas)

The two repos are linked by:
- Semver pins in `package.json`
- Folk knowledge of which version supports which feature
- F2 (the `kernel.intent_dispatched` basis code) still un-PR'd in the sibling

There's no automated check that ibatexas's pinned version supports the features ibatexas actually uses. As the sibling evolves, drift will compound silently. **Future move:** a `pnpm verify-adjudicate-version` script that asserts known features exist in the pinned version.

### F-2 — Conformance-test maintenance burden

R3-1 + Conformance-A added 5 conformance suites (T1, T3, T5, T6, T7). T2 from H2 brings it to 6. Each suite encodes institutional rules; each must be maintained as the codebase evolves. If a conformance suite breaks and is silenced rather than fixed, the underlying rule erodes silently. **Future move:** an annual conformance-suite review checkpoint; document a process for retiring suites whose rules are no longer load-bearing.

### F-3 — `packages/audit-sink` boot-order dependency

The new `@ibatexas/audit-sink` leaf (H2) is fail-closed: `getAuditSink()` throws if `__setAuditSinkDependencies` hasn't been called. This is correct fail-closed behavior, but it creates a HARD boot-order dependency: anything that exercises the kernel path before the bootstrap runs will throw.

**Forecasted risk:** future contributors adding init-time kernel operations (e.g., a startup health-check that adjudicates a synthetic envelope) will hit this and either (a) move their code, (b) silently catch the error, or (c) call `__setAuditSinkDependencies` from a second place. **Future move:** a startup-order conformance test that asserts no kernel path is exercised before `__setAuditSinkDependencies` returns.

---

## Proposed evolutionary moves (prioritized)

### Immediate (this session, mechanical, low risk)

- **M1 — Fix CLAUDE.md line 18** (H-α). One-line edit. **Doing inline.**
- **M2 — Update `docs/adjudicate-migration/README.md`** to point at 2026-05-24 closeout (H-β). One-line edit. **Doing inline.**
- **M3 — SUPERSEDED-banner the three unbannered ledgers** (`task-graph.md`, `decisions-log.md`, `OVERNIGHT-RUN-SUMMARY.md`) (H-γ). Three small edits. **Doing inline.**
- **M4 — Re-classify P0-2 in CLOSEOUT-STATUS** (H-δ). Mark as "partially closed; race v2 tracked under E2". Create `tasks/e2-sweeper-resolver-race-v2.md` follow-up. ~10 min. **Doing inline.**
- **M5 — Close E1** (H-η). Add the `pix.charge.refund` redactor rule. ~5 min. **Doing inline.**

### Near-term (gated; ~1-3h each)

- **M6 — Per-directory README classification** for the 8 subdirectories in `docs/adjudicate-migration/` (H-ε). Per-dir audit + status banners. Distinguishes load-bearing (governance/, migration/03-blast-radius, threat-model/) from historical-preserved from superseded. ~1-2h.
- **M7 — Civilization-map atlas** (H-ζ). New `docs/architecture/governance-topology.md` — trust-boundary diagram, mutation graph, audit pipeline, deferred execution model. Single-page topology. ~2-3h.
- **M8 — Workspace dist-build ergonomics investigation** (H-θ). Focused investigation of the source-imports-from-dist pattern; propose a migration path or alternative. ~3-4h investigation, no implementation.

### Longer-horizon (gated; multi-session)

- **M9 — H3 LGPD epic** — already documented at `audit-2026-05-24/tasks/h3-lgpd-anonymize-scope-expansion.md`. Gated on G2 sub-decisions (Medusa cross-DB approach, JSON strategy, LoyaltyAccount policy). ~1-2 days.
- **M10 — E2 sweeper-resolver race v2** — follow-up artifact will document the recommended fix (resolver re-checks parkKey post-SETNX). Implementation ~3-4h.
- **M11 — F2 sibling-repo basis code release cadence** (G4).
- **M12 — Cross-repo treaty conformance script** (F-1 forecast).
- **M13 — WhatsApp `lastCustomerMessageAt` state-builder design** (G5).
- **M14 — Annual conformance-suite review process** (F-2 forecast).
- **M15 — Startup-order conformance test** (F-3 forecast).

---

## Decision gates

For the user — the orchestration discipline says "gate implementation on explicit approval for high-blast-radius work":

| Gate | Move | Default recommendation |
|---|---|---|
| G6 | M6 per-dir READMEs | Yes — institutional clarity is high leverage |
| G7 | M7 governance-topology atlas | Yes — but defer if user wants closure on H3 first |
| G8 | M8 workspace dist-build investigation | Defer — only if the friction is biting; if not, lower priority than H3 |
| G9 | M10 E2 race v2 fix | Yes — this is a real production race; should land before next push |
| G10 | M11 F2 sibling release | Bundle with next sibling-repo change |
| G11 | M12 cross-repo conformance script | Defer; only if F-1 manifests |
| G12 | M14 conformance-suite review process | Future-Claude problem (annual cadence) |
| G13 | M15 startup-order conformance test | Yes — small effort, prevents H2 fail-mode |

---

## Constitutional self-assessment

| Constitutional law | Status |
|---|---|
| Law 1 — Authority must be explicit | ✅ Strong (post-H2: wrapper meta requires auditSink; intent-bridge controls visibility; system-actor envelopes always wrap subscriber/job mutations) |
| Law 2 — Governance must be universal | 🟡 Strong but with one known partial bypass (E2 race v2; production race lets some mutations double-execute) |
| Law 3 — Replayability is sacred | ✅ Strong (audit trail emits everywhere; supersedes chain on DEFER/resume; T5 conformance) |
| Law 4 — Institutional memory must persist | 🟡 Mixed (excellent at ADR + CLAUDE.md rule #9 layers; drifting at the docs/adjudicate-migration/ layer — see entropy hotspots) |
| Law 5 — Entropy never sleeps | ✅ Active vigilance (this report) |

The civilization is *mostly* law-abiding. The two non-compliance gaps (E2 race + institutional-memory drift in the migration/ doc tree) are both addressable.

---

## What this report does NOT cover

- Code-level audit of post-H2 state (the audit-2026-05-24 sweep was thorough; nothing new to surface).
- Performance / scalability under load (open since audit-2026-05-23).
- Cross-repo conformance matrix (`@adjudicate/conformance` harness exists; CI integration doesn't).
- The sibling adjudicate repo's own civilization-health state — separate scope.
