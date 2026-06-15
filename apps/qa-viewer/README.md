# @ibatexas/qa-viewer — read-only QA viewer (T2-5 / DR-3)

One lightweight app over the journey-harness's **derived, committed
artifacts**. Six tabs, no router, no state library, no backend:

| Tab | Artifact | Source of truth |
|---|---|---|
| Capability graph | `graphs/capability.json` | `ibx graph export` (T2-4) — dangling/unadvertised roster flags rendered distinctly |
| Journey graph | `graphs/journeys.json` | T2-4 — blocked journeys + gap nodes rendered distinctly (blocked journeys ARE the product backlog, D-014/D-015) |
| Run graph | `graphs/run-fixture.json` | T2-4 — sanitized JOURNEY-001 fixture run |
| Impact graph | `graphs/impact.json` | T2-4 — `intent_audit` window aggregation, `agent:` namespace excluded |
| Coverage matrix | `coverage-matrix.json` + `governance/journey-coverage-baseline.json` | `ibx journey coverage --out` (DR-5 cells; the three waiver categories visually distinct; baseline claims ringed, regressions highlighted) |
| Run explorer | `runs/<runId>/trace.jsonl` via file picker (defaults to the committed sanitized fixture) + `governance/price-table.json` | the harness's per-run JSONL trace — act/chat/llm.call/verify timeline + driver/SUT cost summary |

## READ-ONLY, by design

**No authoring canvas, ever** (plan T2-5). The app has no write endpoint of
any kind: the vite plugin that serves `/artifacts/*` answers GET/HEAD only,
and the build output is a fully static site (`dist/` + `dist/artifacts/`).
Graphs are regenerated with `ibx graph export`, coverage with
`ibx journey coverage` — never through this UI.

## Running

```bash
pnpm --filter @ibatexas/qa-viewer dev      # vite dev server on :3010
pnpm --filter @ibatexas/qa-viewer build    # tsc --noEmit + vite build (self-contained dist/)
pnpm --filter @ibatexas/qa-viewer preview  # serve the build output
pnpm --filter @ibatexas/qa-viewer test     # smoke: committed fixtures render
```

Default artifacts are the **committed fixtures**, copied/served by the
`qa-artifacts` plugin in `vite.config.ts`. Point the viewer at another
statically served artifact tree (e.g. a downloaded nightly-run artifact dir)
with:

```bash
VITE_QA_ARTIFACTS_BASE=http://localhost:8000/artifacts pnpm --filter @ibatexas/qa-viewer dev
```

To explore a live run, use the run-explorer file picker on
`runs/<runId>/trace.jsonl` (run traces are gitignored — they never become
committed fixtures).

## Fixtures

`fixtures/coverage-matrix.json` is a committed snapshot of
`ibx journey coverage --out <dir>` (the `coverageMatrixView` payload —
`packages/journeys/src/gates/coverage.ts`). It exists so the viewer (and its
smoke test) has a deterministic default without running the gate; regenerate
it alongside coverage-surface changes:

```bash
node packages/cli/dist/index.js journey coverage --out /tmp/cov \
  && cp /tmp/cov/coverage-matrix.json apps/qa-viewer/fixtures/
```

All other defaults are read directly from their committed homes under
`packages/journeys/` (graphs are drift-gated by `ibx graph export --check`;
this app never carries copies in git).

## Notes

* English UI: internal QA tool — the pt-BR hard rule covers user-facing
  product surfaces (recorded in the T2-5 decision notes).
* Type mirrors live in `src/types.ts` — the app never imports
  `@ibatexas/journeys` (test-plane package, "never imported by apps/*").
