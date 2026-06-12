# Phase 1b — push-dependent items (T1b-4; extended by Phase 2)

Everything below is implemented and committed on `agents/phase-1b` (Phase 2 additions on
`agents/phase-2`) but can only be **activated/verified after the branch is pushed** (the
workspace never pushes — recorded discipline). Work through this list at push time, in order.

## 1. Repo environment + the spend-capped key (BLOCKS the nightly)

The nightly workflow (`.github/workflows/journeys-nightly.yml`) declares
`environment: journeys-nightly`. Before the first run:

1. GitHub → Settings → Environments → **New environment** → `journeys-nightly`.
2. Add environment secret **`ANTHROPIC_API_KEY`** — a **DEDICATED, SPEND-CAPPED key**
   (Anthropic console: separate workspace with a hard monthly budget; suggested cap
   ≈ $100/month ≥ 30 × the measured ~$1.3/night from D-014's §7 re-baseline, with
   retry/abort headroom). Never the production key. The workflow's own `--budget-usd 50`
   abort (plan §7) is the second line of defense, not the first.
3. Every other secret (JWT/STAFF JWT, AUDIT_REDACT_SECRET, DB/Redis passwords,
   IBX_TEST_FINGERPRINT, …) is generated per run by `scripts/gen-env-test.sh` —
   no other repo secret is needed.

## 2. First dispatch + watch (the plan's verify command)

```bash
gh workflow run journeys-nightly
gh run watch $(gh run list --workflow journeys-nightly -L1 --json databaseId -q '.[0].databaseId') --exit-status
```

Inspect the run artifacts (`journeys-nightly-<run_id>`): `artifacts/nightly-suite.json`,
`artifacts/coverage/coverage-matrix.json`, `artifacts/sim_runs.json` / `sim_results.json`,
`runs/<runId>/trace.jsonl`, `/tmp/ibx-test-events.jsonl`.

## 3. 3-nights-green criterion (Phase 1b exit, plan §5)

Phase 1b's nightly is **certified** only after **three consecutive green scheduled runs**
(not dispatches): yellow nights count as green for the criterion (retry-once policy),
red nights reset the count. Track via:

```bash
gh run list --workflow journeys-nightly -L3 --json conclusion,event,createdAt
```

Known first-night risks (all recorded, none code bugs): Docker Hub pull flake
(D-008 — re-run; add a registry mirror if recurrent), runner wall-clock if a money-flow
retry adds its 600 s rate-limit spacing (job timeout is 120 min vs ~25 min nominal).

## 4. Branch protection — kernel-replay-gate required check (T1b-3)

After push, make the T1b-3 PR gate **required** on `main`:
Settings → Branches → `main` protection rule → Require status checks →
add **`Kernel replay gate / replay-gate`**. Until this is clicked, the gate runs but
cannot block merges. (`ci.yml`'s `check` job should already be required; verify both.)

## 5. Flake-ledger commit-back permission

The nightly commits `packages/journeys/governance/flake-ledger.json` updates back to
`main` (quarantine state must survive the ephemeral runner) using the workflow's
`GITHUB_TOKEN` with `permissions: contents: write`. If `main`'s branch protection
blocks pushes from `github-actions[bot]`, either:

- allow the bot via the protection rule's bypass list (preferred — narrowest), or
- switch the step to open a PR instead (`gh pr create`) and require human merge;
  quarantine then only takes effect on merge (record the choice in decisions.md).

## 6. Cancel rate-limit constraint for money flows (D-014) — recorded operating fact

`POST /api/orders/:id/cancel` is rate-limited **5 per 10 min per customer**
(`apps/api/src/routes/order-actions.ts:418-426`), capping same-stack JOURNEY-001 at
**4 attempts per window** — exactly the nightly's `--k-money 4`. Consequences encoded
in the workflow:

- the single nightly retry waits `--retry-delay-seconds 600` (fresh window);
- if a second money-flow journey ever becomes active, EITHER give it a different seeded
  customer (`params.customerPhone` — SEED_CUSTOMERS has 10) OR implement per-attempt
  customer rotation in the runner before raising any `--k-money`. Rotation was assessed
  during T1b-4 and deliberately deferred: k=4 fits the window today and rotation
  touches the journey digest baselines + the harness fixture path for zero present gain.

## 7. Issue hygiene (optional, after first red night)

`gh issue create` payloads carry `[journeys-nightly]` title prefixes (no label
dependency — labels require admin setup). If you want a label, create `journeys-nightly`
once and add `--label journeys-nightly` to the issue step.

## 8. e2e-smoke required check (T2-7, Phase 2)

`.github/workflows/e2e-smoke.yml` runs the Playwright smoke + web golden path + the
authed api-golden-path (JOURNEY-001's HTTP legs: cart create → line-item → checkout
cash/pickup) against the full ephemeral test stack **with web (:3000) booted** via the
`IBX_TEST_E2E=1` overlay (`process-compose.e2e.yaml`). It needs **NO repo secret** —
zero-tokens by design, the stack boots with a placeholder `ANTHROPIC_API_KEY`, so it is
fork-PR safe. After push:

1. First dispatch + watch:

   ```bash
   gh workflow run e2e-smoke
   gh run watch $(gh run list --workflow e2e-smoke -L1 --json databaseId -q '.[0].databaseId') --exit-status
   ```

2. Make it a **required check** on `main`: Settings → Branches → `main` protection
   rule → Require status checks → add **`e2e-smoke / e2e`** (alongside the
   kernel-replay-gate check from item 4 and `ci.yml`'s `check`).

3. Note: it triggers on `pull_request` for web/api/commerce + shared-package +
   harness paths only — a docs-only PR will not produce the check. If `main`
   requires it unconditionally, GitHub treats path-filtered absent checks as
   pending; prefer "required for the matching paths" semantics via merge-queue or
   accept the dispatch fallback (`workflow_dispatch` exists for that).

Verified locally before commit (recorded in the T2-7 task output): full
`IBX_TEST_E2E=1` stack boot + `playwright test` all specs green + teardown.

## 9. Graphs gate required check (T2-4, Phase 2)

`.github/workflows/graphs-gate.yml` is the regenerate-and-diff gate over the four
derived graph artifacts (`packages/journeys/graphs/*.json` — contract + regeneration
discipline in `packages/journeys/graphs/README.md`). It needs **NO secret and NO
database** — zero tokens; the impact graph regenerates from the committed test-stack
window fixture. After push:

1. Sanity-dispatch is not possible (`pull_request`-only trigger) — open any PR touching
   `packages/packs-composed/**` or `packages/journeys/**` and confirm the
   **`Graphs gate / graphs-gate`** check appears and passes; then verify the negative
   leg by pushing a PR commit that edits a pack/journey WITHOUT running
   `ibx graph export` → the check must fail (drift), and pass again after committing
   the regenerated graphs.
2. Make it a **required check** on `main` alongside items 4/8: Settings → Branches →
   `main` → Require status checks → add **`Graphs gate / graphs-gate`**. Same
   path-filter caveat as item 8.3 (docs-only PRs produce no check).

Verified locally before commit (T2-4 task output): `ibx graph export --check` exit 0
on the committed artifacts; mutated-artifact negative → exit 1 (DRIFT) → regenerate →
exit 0; vitest drift/missing/registry-change legs green.
