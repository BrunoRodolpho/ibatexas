# Extraction-accuracy meter — Nemotron lane (non-certifying)

> The extraction-accuracy meter (FE-T07, `ibx journey extraction-accuracy`)
> measures the REAL local model, not a mock. Its lane is deliberately
> **non-certifying**: it never gates a merge, because GitHub-hosted runners
> have no route to the LAN-only Nemotron box (192.168.1.80). The per-commit
> gate that DOES block a merge is model-free — see
> `.github/workflows/ci.yml`'s "Extraction-accuracy consistency gate
> (FE-T08, model-free)" step and `ibx journey extraction-consistency --help`.

## Two ways to run this lane

### 1. Right now, locally (no setup beyond what already exists)

This is the path FE-T07's PR #263 actually used for its 9 recorded live
runs — fully proven, needs nothing new.

```
scripts/run-extraction-accuracy-lane.sh
```

or the bare CLI invocation it wraps:

```
node packages/cli/dist/index.js journey extraction-accuracy \
  --env-file .env.test \
  --verify-file packages/journeys/governance/extraction-accuracy-baseline.json
```

Preconditions (all satisfied by a normal `ibx dev` + `ibx test seed`
checkout, or the equivalent hand-assembled env FE-T07 used against the
ad-hoc dev stack — see that PR's report for the exact recipe if `.env.test`
isn't already generated for your stack):

- The dev/test API is reachable (default `http://localhost:3001`,
  override with `--api-base-url`).
- `STAFF_JWT_SECRET` matches what the RUNNING api actually loaded (NOT
  necessarily `.env.test`'s own value if you're pointing at an ad-hoc dev
  stack rather than the ephemeral test-profile one — see the gotcha below).
- `ORACLE_DATABASE_URL` connects as a genuinely read-only Postgres role
  (`ibx_oracle_ro` — `scripts/test-stack/create-readonly-role.sql`
  provisions it; safe to run against any Postgres instance, dev included).
- `REDIS_URL` is set and reachable (per-case ops-history isolation — a
  missing/wrong value degrades to a hard `isolation_degraded` failure by
  design, not a silent warning: see accuracy.ts's FE-T07-review MAJOR fix).
- The one seeded staff row exists and is active (`ibx test seed`,
  `packages/domain/src/seed-constants.ts`'s `SEED_STAFF`).
- At least one ACTIVE order exists (so "most recent active order"
  resolution succeeds) — any status short of terminal (delivered/canceled)
  works; the corpus's own case mix will exercise several transitions
  against whichever one it resolves.

**Gotcha (found live during FE-T07):** if you're driving against an ad-hoc
dev stack rather than a properly-provisioned ephemeral test-profile one,
`.env.test`'s own `STAFF_JWT_SECRET`/`AUDIT_REDACT_SECRET`/
`ORACLE_DATABASE_URL` may not match what that stack's API process actually
loaded (they're generated for a DIFFERENT, usually-not-simultaneously-
running test-profile Postgres/API pair). Build a small scratch env file
with the REAL secrets that api process loaded instead — see
`scripts/run-extraction-accuracy-lane.sh`'s header comment for the exact
diagnostic commands (`grep`, `psql \du`, `lsof -i`) that surfaced this the
first time.

### 2. Via GitHub Actions, once a `nemotron`-labeled runner exists

`.github/workflows/nemotron-extraction-lane.yml` — `workflow_dispatch`
(optionally add a `schedule` once you want a cadence; commented out by
default). It runs the IDENTICAL CLI invocation above on a self-hosted
runner, annotates the job summary, uploads the JSON report as an artifact,
and never fails the workflow's caller (`continue-on-error` on the driving
step) — advisory only, exactly like the local path.

**This workflow has not been end-to-end exercised** — registering the
runner is a repo-admin action (a registration token minted from the repo's
Settings page) outside what an agent can do. To activate it:

1. On a machine on the same LAN as the Nemotron box (or the box itself, if
   it can also run the dev/test API + Postgres/Redis stack): repo Settings
   → Actions → Runners → New self-hosted runner. Follow GitHub's
   installation script; add the label `nemotron` (`--labels nemotron` at
   registration, or via Settings after).
2. Ensure that machine can reach a running dev/test API instance and has a
   `.env.test`-shaped credentials file at the repo root (same
   preconditions as the local path above).
3. `gh workflow run nemotron-extraction-lane` (or the Actions tab's "Run
   workflow" button) to smoke-test it; the job summary + uploaded artifact
   report the result.

If registering a runner never happens for this repo, the local path above
is the permanent, fully-legitimate way to run this lane — not a
placeholder for it.

## Reading a report

`--json` output (either path) shapes as:

```json
{
  "byCapability": [{ "capability": "order.status.transition", "total": 20, "passing": 12, "ratio": 0.6 }],
  "verify": { "ok": true, "regressions": [], "quarantinedClaims": [], "waivedClaims": [...], "newlyPassing": [] },
  "problems": []
}
```

A non-empty `verify.regressions` means a baseline-claimed case stopped
passing. Advisory here (never blocks); if the regression is genuine (not
a known flake), apply the SAME waiver policy FE-T07's PR established:
move the case out of `packages/journeys/governance/extraction-accuracy-
baseline.json`'s `passing` list and add a `waived-quarantined` entry to
`extraction-accuracy-waivers.json` citing the evidence — never silently
re-baseline or drop it.
