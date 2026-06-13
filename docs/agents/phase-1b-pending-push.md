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

## 10. T2-6b scripted fixture suite green on PRs (Phase 2 exit-criterion leg)

The golden-conversation suite (`apps/api/src/__tests__/scripted-pipeline/`) rides the
EXISTING PR workflow — `.github/workflows/ci.yml` runs `pnpm test` (turbo → apps/api
`vitest run`) after a `docker info` testcontainer preflight, so NO workflow change was
needed. Zero tokens by construction: the suite injects the content-keyed scripted
ModelProvider through the T2-6a DI seam, so the Anthropic SDK client is never
constructed (no secret is read; `ANTHROPIC_API_KEY` is not required by the job).
After push:

1. Open any PR touching `apps/api/**` and confirm the **`CI / check`** run executes
   `src/__tests__/scripted-pipeline/` (2 files / 10 tests) green — that is the
   "T2-6b fixture suite green on PRs" clause of the Phase 2 exit criterion.
2. Negative leg (optional, mirrors the local acceptance run): a PR that edits the
   planner system prompt in `apps/api/src/claustrum/ibatexas-planner.ts` without
   re-recording `fixtures/completions/surfaces.json` must FAIL the suite with the
   loud unknown-content-key error naming the nearest fixtures.

Verified locally before commit (T2-6b task output): full directory green
(10/10: container suite — postgres+audit migrations+domain `prisma db push`, redis,
real `bootstrapClaustrum` — plus the zero-infra content-key unit acceptance), and the
one-char prompt mutation produced a different content key + the loud unknown-key
error listing `planner:cancel-confirm-gate` as nearest (shared prefix 1180 chars).

## 11. T3-0 claustrum release + registry pin bump (Phase 3, D-017)

The T3-0 upstream change (claustrum `agents/phase-3`, commit `f8e24b1`: `ChannelKind`
widened with `"system"`; DR-4 `lockKeyStrategy` + `sessionKeyAwareLockKey`; two-process
trigger-vs-chat serialization test) is consumed by ibatexas as **committed local
tarballs** (`local-tarballs/claustrum-*.tgz`, `file:` pins in `apps/api/package.json`
plus a root `pnpm.overrides` entry for `@claustrum/core` — needed because the packed
`memory-postgres`/`grounding-pgvector` tarballs carry an EXACT `0.3.0` core dependency).
At push/release time:

1. Push claustrum `agents/phase-3`, open the PR (small focused diff — this gated the
   phase, plan §5 T3-0). NOTE: the branch is **already versioned** (core `0.3.0` minor,
   channel-whatsapp `0.2.0` minor, dependents patch + CHANGELOGs — the changeset was
   applied locally), so the changesets bot will see no pending changeset: publish with
   `pnpm changeset publish` (tags + npm) after merge, or re-add a changeset and revert
   the version commits if you prefer the bot's version-PR flow. Deliberate deviation
   recorded in the claustrum commit: changesets' default peer-dep rule escalated all
   core peer-dependents to **1.0.0**; this was overridden to patch bumps
   (anthropic/channel-web/conformance/openai `0.1.2`) to avoid an unintended stability
   signal — re-apply your preferred policy at publish time if different.
2. After the registry has the release: in ibatexas, replace the six `file:` pins in
   `apps/api/package.json` with registry ranges (`@claustrum/core ^0.3.0`,
   `@claustrum/channel-whatsapp ^0.2.0`, others `^0.1.1`/`^0.1.2`), DELETE the root
   `pnpm.overrides`/`overrideNotes` entry for `@claustrum/core`, delete
   `local-tarballs/`, and `pnpm install`.
3. Re-verify: `pnpm --filter @ibatexas/api test` green; in claustrum,
   `pnpm -C packages/memory-postgres test` green (includes
   `conductor-trigger-chat-serialization.test.ts`).

## 11. T3-10 NATS server-side auth — production / dev-EC2 rollout (deploy-dependent)

Server-side nkey auth is COMMITTED on all five surfaces (dev compose, prod compose,
terraform prod, dev-EC2 template, test stack) and live-proven on the test stack
(`scripts/test-stack/nats-auth-probe.mjs`). The local-machine surfaces work today
(dev compose after `./scripts/nats/gen-dev-nats-auth.sh`; test stack after
`./scripts/gen-env-test.sh --force`). The remote surfaces need credentials pushed
and stacks rolled — impossible from this session (no terraform apply, no AWS
writes, no deploys). After push/deploy access:

1. **Mint per-environment pairs** (never reuse a dev seed): run
   `node scripts/nats/gen-nkey-user.mjs` once per environment → `SEED PUBLIC`.
2. **dev-EC2 (SSM)**: `ibx infra secrets:push` with `NATS_NKEY_SEED` +
   `NATS_APP_NKEY_PUBLIC` (names already declared in
   `infra/terraform/environments/dev/secrets.tf`), then `terraform apply` in
   `infra/terraform/environments/dev` (new user_data writes
   `/opt/ibatexas/nats-server.conf`; note `user_data_replace_on_change = false`
   — either taint/recreate the instance or write the conf + redeploy via SSM),
   then trigger `ibatexas-deploy`. Verify: `docker logs ibatexas-nats` shows the
   config boot; an unauthenticated `nats sub 'ibatexas.>'` against the docker
   network is refused; api logs `[nats] connected` clean.
3. **terraform prod (ECS)**: set Secrets Manager values
   `ibatexas/production/NATS_NKEY_SEED` + `ibatexas/production/NATS_APP_NKEY_PUBLIC`
   (resources declared in `production/secrets.tf`), `terraform apply` in
   `infra/terraform/environments/production` (nats task entrypoint + api task
   secret from `nats.tf`/`ecs.tf`), roll the nats service THEN the api service.
   `terraform validate` passed locally (1.9.8); plan/apply unverified.
4. **prod compose host (if used)**: `./scripts/nats/gen-dev-nats-auth.sh
   --env-file <prod .env>` on the host, `docker compose -f docker-compose.prod.yml
   up -d nats api`.
5. **TLS (runbook §2, still open)**: provision server cert/key + CA, mount into
   the NATS container(s), add the `tls {}` block to
   `infra/nats/nats-server.app.conf` (and the `nats.tf` inline mirror), set
   `NATS_TLS_CA` + `NATS_TLS_REQUIRED=true` on every client env. The client
   plumbing is live and fail-closed already.
6. **Rotation cadence** (runbook §4): re-mint the pair, push, roll nats then the
   apps — one service at a time; calendar it at ≥ every 90 days.

Local verification recorded with the T3-10 commit: test-stack probe all-green
(server-rejected capture publish included), JOURNEY-001 k=1 green on the authed
stack, `pnpm --filter @ibatexas/nats-client test` 34/34, journeys suite green,
`terraform validate` green in both environments (the dev module's pre-existing
`${REDIS_PASSWORD}` template-escape failure was fixed in passing).
