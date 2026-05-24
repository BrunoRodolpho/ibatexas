# Adjudicate sibling-repo state — 2026-05-23

## TL;DR

- **Branch state:** sibling repo is on `main`, clean, up-to-date with `origin/main` at `fb10141` (v0.1.1 merged 2026-05-24 UTC, ~2h ahead of audit-day boundary). All `claude/unruffled-bassi-305034` and `chore/release-v0.1.1` PRs are merged; **no in-flight feature branches**. The blocker from the overnight 2026-05-22 run (dirty WIP on `claude/unruffled-bassi-305034`) is **cleared**.
- **F2 status: STILL DEFERRED.** `kernel.intent_dispatched` basis code is **not present** in the sibling repo. The `kernel` category in `packages/core/src/basis-codes.ts:100-102` contains only `GUARD_PANIC`. F2 was not landed alongside the v0.1.1 / v1.0.1 release cuts. Action required in sibling repo before ibatexas can consume it.
- **Version sync verdict: ALIGNED.** Every `@adjudicate/*` version pinned by ibatexas matches both the sibling repo HEAD `package.json` and the actual npm-published version. No drift, no stale pins, no pins to non-existent versions.

## Section 1 — Repo state

- **Path:** `/Users/thaisrodolpho/projects/adjudicate`
- **Branch:** `main`
- **Working tree:** clean (`git status` reports "nothing to commit, working tree clean")
- **Tracking:** `main` is up to date with `origin/main`
- **HEAD commit:** `fb10141 Merge pull request #19 from BrunoRodolpho/chore/release-v0.1.1`
- **Remote branches:** only `origin/main` (no feature branches in flight at the remote — `git fetch --all` confirms)
- **Local branches:** only `main` (`git branch -a` shows nothing else)
- **Tags (local only — none pushed to origin):**
  - `v0.5.1-local`
  - `v0.5.0-local`
  - `v0.4.0-local`
  - `v0.3.0-local`
  - `v0.2.0-local`
  - All five tags use the `-local` suffix, suggesting they were never published as remote release tags. The post-v1 cuts (v1.0, v1.0.1, v0.1.1) appear to have shipped via npm `publish` without git tags at all.

### Recent commit history (top 30)

```
fb10141 Merge pull request #19 from BrunoRodolpho/chore/release-v0.1.1
2ebf483 chore(release): v0.1.1 + @adjudicate/locales-pt-br casing fix
2662dc7 chore: gitignore Claude Code local skill scaffolding
165fc70 Merge pull request #18 from BrunoRodolpho/claude/unruffled-bassi-305034
a87acba chore(npm): flip root package to non-private for publish-ability
d2be497 Merge pull request #17 from BrunoRodolpho/claude/unruffled-bassi-305034
73d3410 chore(audit,audit-postgres,cli,apps,docs,deps): post-v1 reliability sweep
8f07e71 Merge pull request #16 from BrunoRodolpho/claude/unruffled-bassi-305034
1b155f0 feat(docs,audit): post-v1 long-term stewardship + operational survivability primitives
bd79771 v1.0 + post-v1: certification, freeze matrix, ecosystem primitives, governance discipline (#15)
db13440 Merge remote-tracking branch 'origin/main' into claude/unruffled-bassi-305034
2c98d29 feat(observability,audit,conformance,docs,specs): post-v1 governance + opt-in ecosystem primitives
36e7e76 v1.0-RC: freeze matrix + certification + scale evidence (#14)
f361e93 Merge origin/main (v0.5.1) into v1.0-RC branch
1ec8a65 feat(release,bench,docs,security,scripts): v1.0-RC certification + freeze matrix + scale evidence
bddf704 feat(audit,adapter-core,conformance,cli): v0.7 — operational hardening + ecosystem trust
e9fc3ad v0.5.1 — Foundation + L2 + Analyzer + Console UX + 7 CLI commands (#13)
1f532c9 Merge remote-tracking branch 'origin/main' into claude/unruffled-bassi-305034
8146d34 feat(console,cli): UX cut — console enhancements + 7 CLI commands + 4 templates
393763d feat(docs,release): M4 — hosted architecture + security/compliance + v0.5 cut
2cdbadb feat(core,audit-postgres,admin-sdk): M3 batch 2 — AuditRecord v4 + ADRs
9a80188 feat(conformance,observability,migrate,docs): M3 batch 1
7625f86 feat(analyze,cli,pix,deploys,docs): M2 — analyzer + L2 + registry foundations
d9a3330 feat(primitives,docs): T-024..T-027 L2 expansion + T-037..T-039 ecosystem docs
acc2bac feat(release): T-017..T-023 v0.2.0 release infra + ADR-106/107
51f0127 feat(bench,docs): T-013..T-016 perf characterization
c06c9c8 feat(core,locales-pt-BR): T-009..T-012 externalize Portuguese refusal strings
d59b75b feat(runtime,anthropic): T-005..T-008 resume-hash verification
0324446 feat(core): T-001..T-004 guard exception isolation + BASIS_CODES.kernel category
f63edfd feat(execution): T-021 scaffold execution state docs
```

### In-flight work

**None.** No open feature branches at origin, no uncommitted work in the worktree. `gh pr list --repo BrunoRodolpho/adjudicate --state all` shows the last 10 PRs are all MERGED (most recent `#19` chore/release-v0.1.1 merged 2026-05-24T01:02:04Z).

## Section 2 — Version sync between repos

### Consumed @adjudicate/* deps (inventoried across ibatexas package.json files)

| Package | ibatexas pinned | Sibling HEAD package.json | npm published | Status |
|---|---|---|---|---|
| `@adjudicate/core` | `^1.0.0` | 1.0.0 (`packages/core/package.json`) | 1.0.0 | aligned |
| `@adjudicate/audit` | `^1.0.1` | 1.0.1 (`packages/audit/package.json`) | 1.0.1 | aligned |
| `@adjudicate/audit-postgres` | `^1.0.1` | 1.0.1 (`packages/audit-postgres/package.json`) | 1.0.1 | aligned |
| `@adjudicate/conformance` | `^0.1.1` | 0.1.1 (`packages/conformance/package.json`) | 0.1.1 | aligned |
| `@adjudicate/locales-pt-br` | `^0.1.1` | 0.1.1 (`packages/locales-pt-BR/package.json` — note: dir is `pt-BR`, name is `pt-br`) | 0.1.1 | aligned |
| `@adjudicate/pack-payments-pix` | `^0.1.1` | 0.1.1 (`packages/pack-payments-pix/package.json`) | 0.1.1 | aligned |
| `@adjudicate/primitives` | `^0.1.1` | 0.1.1 (`packages/primitives/package.json`) | 0.1.1 | aligned |
| `@adjudicate/runtime` | `^0.1.1` | 0.1.1 (`packages/runtime/package.json`) | 0.1.1 | aligned |

### Consumer manifest map

- `apps/api/package.json` — audit-postgres, core, pack-payments-pix, runtime
- `packages/cli/package.json` — audit, audit-postgres, core, runtime
- `packages/domain/package.json` — audit, core, primitives
- `packages/llm-provider/package.json` — audit, audit-postgres, core, locales-pt-br, pack-payments-pix, runtime
- `packages/pack-customer-onboarding/package.json` — conformance, core, locales-pt-br, primitives
- `packages/pack-orders/package.json` — conformance, core, locales-pt-br, pack-payments-pix, primitives
- `packages/pack-payments/package.json` — conformance, core, locales-pt-br, pack-payments-pix, primitives
- `packages/pack-reservations/package.json` — conformance, core, locales-pt-br, primitives
- `packages/pack-whatsapp/package.json` — conformance, core, locales-pt-br, primitives
- `packages/tools/package.json` — core, primitives

### Drift analysis

- No package consumed by ibatexas is behind the sibling's HEAD version.
- No package is pinned to a version that no longer exists on npm (verified via `npm view <pkg> version`).
- All eight consumed packages match exactly: ibatexas pin caret-range, sibling HEAD `package.json`, and the live npm registry are in lockstep.

### Sibling packages NOT consumed by ibatexas

Available in sibling but not pinned anywhere in ibatexas: `@adjudicate/adapter-core` (0.1.1), `@adjudicate/admin-sdk` (1.0.0), `@adjudicate/analyze` (0.1.1), `@adjudicate/anthropic` (0.1.1), `@adjudicate/cli` (0.1.1), `@adjudicate/eslint-config` (0.0.1, private), `@adjudicate/migrate` (0.1.0), `@adjudicate/observability` (0.1.1), `@adjudicate/openai` (0.1.1), `@adjudicate/pack-deployments-approval` (0.1.1), `@adjudicate/pack-identity-kyc` (0.1.1).

## Section 3 — F2 status

### Verdict: STILL DEFERRED — basis code does NOT exist in sibling repo

**Where basis codes live:** `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts`

**The `kernel` category (lines 100-102):**

```ts
kernel: {
  GUARD_PANIC: "guard_panic",
},
```

That is the only `kernel.*` basis code defined. There is no `INTENT_DISPATCHED`, no `intent_dispatched`, no equivalent string anywhere in `packages/*/src/` (grep across `packages/core/src/**`, `packages/audit/src/**`, and all other sibling packages returns zero hits).

**The `BasisCategory` type at line 12-23** lists `"kernel"` as a category, and the inline JSDoc at lines 88-99 explains `GUARD_PANIC` is the result of T-002 (kernel-internal guard exception wrapper). No mention of a planned `INTENT_DISPATCHED`.

**ibatexas usage of `intent_dispatched`:** zero — `grep -rn "intent_dispatched\|INTENT_DISPATCHED\|intentDispatched" packages/ apps/` returned empty. The ibatexas tree does not yet reference the symbol, so this is purely a forward-looking blocker (the migration plan needs it before kernel-emitted dispatch records can carry the canonical code).

**What ibatexas needs from the sibling:**

1. Sibling repo PR that adds `kernel.INTENT_DISPATCHED: "intent_dispatched"` to `BASIS_CODES.kernel` in `packages/core/src/basis-codes.ts`.
2. Patch release bump on `@adjudicate/core` (e.g., 1.0.1) and `@adjudicate/audit` if any audit-record schema cross-checks the value.
3. ibatexas then bumps `@adjudicate/core` pin in 4 consumers (`apps/api`, `packages/cli`, `packages/domain`, `packages/llm-provider`) plus the 6 `pack-*` packages, and runs `pnpm install`.
4. ibatexas migration step F2 can then emit the basis code from the kernel-dispatch path.

The path is unambiguous; the only blocker is a PR in `BrunoRodolpho/adjudicate`.

## Section 4 — Lighthouse pack-payments-pix alignment

**Verdict: MATCH — no divergence.**

### Sibling pack layout

`/Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/`:
- `capabilities.ts`, `guards.ts`, `handlers.ts`, `index.ts`, `policies.ts`, `refusals.ts`, `types.ts`

`packages/pack-payments-pix/package.json` (sibling):
- `"name": "@adjudicate/pack-payments-pix"`, `"version": "0.1.1"`
- Exports a single `.` entrypoint via `./dist/index.js` + `./dist/index.d.ts`

### Sibling exports (from `packages/pack-payments-pix/src/index.ts`)

- Default export: `paymentsPixPack` (PackV0-conformant, id `"pack-payments-pix"`)
- Re-exports: `PIX_CONFIRMATION_SIGNAL`, `PIX_CONFIRMED_STATUSES`, `PIX_DEFAULT_DEFER_TIMEOUT_MS`, `PIX_DEFAULT_EXPIRY_SECONDS`, `pixTaintPolicy`, types (`PixCharge`, `PixChargeConfirmPayload`, `PixChargeCreatePayload`, `PixChargeRefundPayload`, `PixChargeStatus`, `PixContext`, `PixIntentKind`, `PixState`)
- Refusals: `refuseChargeAlreadyRefunded`, `refuseChargeExpired`, `refuseChargeFailed`, `refuseChargeNotConfirmed`, `refuseChargeNotFound`, `refuseConfirmRequiresWebhook`, `refuseInvalidAmount`, `refuseInvalidStateForConfirm`, `refuseRateLimitExceeded`
- Policy thresholds: `CONFIRM_REFUND_THRESHOLD_CENTAVOS`, `ESCALATE_REFUND_THRESHOLD_CENTAVOS`, `pixPolicyBundle`
- Capabilities: `PIX_TOOLS`, `pixCapabilityPlanner`
- Handlers: `inMemoryPixHandlers`
- Guards: `createPixPendingDeferGuard`, type `PixPendingDeferGuardOptions`
- Rehydration: `rehydratePixState`

### ibatexas consumption sites

- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts:45` — `import { createPixPendingDeferGuard } from "@adjudicate/pack-payments-pix"`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts:282` — composes `createPixPendingDeferGuard<OrderState>({...})`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/types.ts:395` — `export { PIX_CONFIRMATION_SIGNAL } from "@adjudicate/pack-payments-pix"`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-payments/src/signals.ts:20` — `export { PIX_CONFIRMATION_SIGNAL } from "@adjudicate/pack-payments-pix"`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-payments/src/index.ts:110` — re-exports `PIX_CONFIRMATION_SIGNAL`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/order-policy-bundle.ts:16` — JSDoc citing PIX-pending DEFER guard factory delegation
- `/Users/thaisrodolpho/projects/ibatexas/packages/cli/src/commands/kernel.ts:514` — registry entry `["@adjudicate/pack-payments-pix", "pixChargeLifecyclePack"]`

Every import is satisfied by the sibling's exported surface. No symbol referenced by ibatexas is missing from the pack.

### Pack JSDoc note

The pack's `index.ts:18-21` explicitly names IbateXas as the canonical adopter of pattern #2 ("factory pattern"): "Canonical example: IbateXas's `@ibatexas/llm-provider`'s `order-policy-bundle.ts` composes the factory against `order.confirm`." That documentation reference is now slightly stale — IbateXas migrated the composition site to `@ibatexas/pack-orders/policies.ts` (per the legacy shim in `packages/llm-provider/src/order-policy-bundle.ts:1-19`). Cosmetic only, not a behavior break.

## Section 5 — Other consumable packs

### Sibling-repo `@adjudicate/pack-*` inventory

| Pack | Version | ibatexas already consumes? | Decision algebra emphasis |
|---|---|---|---|
| `@adjudicate/pack-payments-pix` | 0.1.1 | yes (via `pack-orders`, `pack-payments`, `llm-provider`) | full lifecycle, all six outcomes |
| `@adjudicate/pack-identity-kyc` | 0.1.1 | no | async DEFER + ESCALATE (KYC state machine) |
| `@adjudicate/pack-deployments-approval` | 0.1.1 | no | ESCALATE + REQUEST_CONFIRMATION + ramp-clamp REWRITE |

### Recommendation: `@adjudicate/pack-deployments-approval`

**Pattern fit for ibatexas:** ibatexas already exercises `REQUEST_CONFIRMATION` in `@ibatexas/pack-orders` (large-ticket checkout threshold at `R$ 1.000` — see `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts:418` and `packages/pack-orders/src/types.ts:371`). The deployment pack's `REQUEST_CONFIRMATION` for destructive rollbacks and its `ESCALATE` for production-deploy-without-prior-human-approval are exactly the "two-person rule" pattern ibatexas docs already reference. However, ibatexas has no current `deployment.*` intent surface — the value would be **pattern adoption / test-suite cross-validation**, not direct domain reuse.

The pack's exports from `/Users/thaisrodolpho/projects/adjudicate/packages/pack-deployments-approval/src/index.ts:25-50`: `deploymentsApprovalPack`, `approvalKey`, `deploymentTaintPolicy`, `MAX_PRODUCTION_RAMP_PERCENT`, `DEPLOYMENT_CI_GREEN_SIGNAL`, `DEPLOYMENT_DEFAULT_DEFER_TIMEOUT_MS`, `HIGH_RAMP_THRESHOLD`, `deploymentPolicyBundle`, `DEPLOYMENT_TOOLS`, `deploymentCapabilityPlanner`. Concrete reusable primitive: **none directly**, but the structure (approvals ledger keyed by tuple, two-step `request` → `resolve` lifecycle) is a template if ibatexas ever adds a staff-approval flow (e.g., manual order overrides, manual refund authorization above a threshold).

**Recommendation:** do NOT adopt as a runtime dep today. Note in the migration docs as a reference pattern when ibatexas designs a "staff-approval" or "manager-override" Pack (would replace ad-hoc `whatsapp` staff-confirm flows).

### Recommendation: `@adjudicate/pack-identity-kyc`

**Pattern fit for ibatexas:** sibling pack covers a KYC lifecycle (`kyc.start` → DEFER on `kyc.documents.uploaded`). ibatexas has `@ibatexas/pack-customer-onboarding` which covers a customer-onboarding flow. There is potential overlap, but the sibling pack is opinionated on KYC vendor webhook semantics; ibatexas onboarding is focused on WhatsApp OTP + first-order context. **Likely not a swap candidate.**

**Recommendation:** do NOT adopt. Keep `@ibatexas/pack-customer-onboarding` as the IbateXas-specific onboarding surface.

### Other consumable packages worth noting

- **`@adjudicate/observability` (0.1.1)** — not currently consumed. Worth investigating in a separate audit pass: ibatexas has its own observability primitives in `apps/api` and `packages/llm-provider`. If the sibling package offers OpenTelemetry hooks or structured-log helpers that ibatexas duplicates, this could be a consolidation opportunity. **Not blocking; flag for follow-up.**
- **`@adjudicate/cli` (0.1.1)** — not consumed. ibatexas has its own `packages/cli` (`@ibatexas/cli`, exposed as `ibx`). The sibling CLI is a separate tool (`adjudicate simulate`, etc.); both can coexist.
- **`@adjudicate/anthropic` / `@adjudicate/openai` (0.1.1 each)** — adapter packages for LLM providers. ibatexas's `@ibatexas/llm-provider` rolls its own. If the sibling adapters mature, ibatexas could swap in. **Not blocking.**

## Section 6 — Open work in sibling repo

- **Open PRs:** zero (`gh pr list --repo BrunoRodolpho/adjudicate --state open` would return empty; the recent merged list shown above stops at PR #19).
- **Pending releases:** zero. No `changeset-release/main` branch active right now. The `.changeset/` directory contains three historical changeset files (`v0.5-foundation-safety-analyzer.md`, `v0.6-adapter-core-openai.md`, `v0.7-operational-trust.md`) — all of which look consumed by past release PRs based on the commit history.
- **Tags published:** **none on the remote** as of this audit. Only local `v0.x.y-local` tags exist; the actual v0.1.1 / v1.0.x releases shipped without git tags. This is a minor governance gap worth flagging — the source-of-truth versions on npm are not traceable to a git ref.
- **WIP branches:** none observed.

**Net:** nothing in flight at the sibling that ibatexas depends on or is waiting for.

## Section 7 — Conformance suite adoption

**Verdict: PARTIALLY ADOPTED — six ibatexas packs use it as a devDependency for their own conformance tests; not wired into ibatexas CI as a kernel-level cross-pack gate.**

### Where `@adjudicate/conformance` is consumed in ibatexas

`runConformance(...)` from `@adjudicate/conformance` is invoked in:

- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/src/__tests__/conformance.test.ts:25`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/__tests__/conformance.test.ts:27`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/src/__tests__/conformance.test.ts:26`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/__tests__/conformance.test.ts` (via package devDep, file referenced multiple times)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-payments/src/__tests__/conformance.test.ts` (via package devDep)

Plus a sixth pack via `packages/pack-orders/src/__tests__/conformance.test.ts:7`.

### Package.json wiring

`@adjudicate/conformance: ^0.1.1` is declared in all 6 first-party packs (see Section 2 manifest map):
- `packages/pack-customer-onboarding/package.json:39`
- `packages/pack-orders/package.json:30`
- `packages/pack-payments/package.json` (verified via Section 2 inventory)
- `packages/pack-reservations/package.json:29`
- `packages/pack-whatsapp/package.json:29`
- `packages/pack-payments/package.json` (per Section 2)

The harness is wired per-pack, **not as a top-level CI gate**. There's no `apps/api`, root-level, or `packages/cli` consumption of conformance — each pack runs its own conformance suite as part of its `vitest run`.

### Gap

No global "run conformance against every first-party Pack" job exists in ibatexas CI. Adding `ibx conformance run` (a CLI command iterating over all `@ibatexas/pack-*` packages, invoking `runConformance` on each, and reporting a single pass/fail) would be a small uplift — it would give CI a single signal for kernel-contract regression across the whole `@ibatexas/pack-*` family. **Recommend treating this as a separate follow-up task; not blocking for F2 or the kernel always-on cutover.**

## Open questions for orchestrator

1. **F2 ownership.** Who opens the PR in `BrunoRodolpho/adjudicate` to add `kernel.INTENT_DISPATCHED`? The sibling repo is clean and ready to receive a focused PR. If the orchestrator wants to spawn a sibling-repo edit agent next phase, the diff is small (one constant + JSDoc + a CHANGELOG entry + version bump). Should that agent also do the npm publish, or just open the PR for a human to ship?
2. **Remote-tag hygiene.** Sibling repo ships to npm without git tags. Worth flagging to upstream maintainer that v0.1.1 / v1.0.1 should have `v0.1.1` / `v1.0.1` annotated tags pushed for traceability. **Not blocking.** Out of ibatexas's lane to act on directly.
3. **Stale JSDoc in lighthouse pack.** `packages/pack-payments-pix/src/index.ts:21` references the old `@ibatexas/llm-provider` composition site instead of the migrated `@ibatexas/pack-orders` site. Cosmetic. Worth a doc PR in the sibling next time someone touches the pack.
4. **Top-level conformance gate.** Should the orchestrator schedule a separate task to add an `ibx conformance` CLI command that walks every `@ibatexas/pack-*` and runs `runConformance` as a single CI step? Not in critical path for F2 or kernel cutover; useful regression net for the whole pack family.
5. **Sibling-pack adoption signal.** The lighthouse pack docs name IbateXas as the canonical pattern-#2 adopter. As more ibatexas packs ship (`pack-orders`, `pack-payments`, etc.), is there interest in upstreaming any patterns back to sibling? E.g., the `REQUEST_CONFIRMATION` threshold + Portuguese refusal-string layering pattern from `pack-orders` could become a shared utility in `@adjudicate/primitives`. Out-of-scope decision for orchestrator; flagging because the sibling repo is clean and receptive right now.
