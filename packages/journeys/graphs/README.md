# Derived graphs (`ibx graph export`) — T2-4

Four **derived, drift-gated, never hand-maintained** graph artifacts.
`intentKind` is the universal join key across all four. Regenerate with
`ibx graph export`; `ibx graph export --check` regenerates in memory and
byte-diffs against the committed files — nonzero exit on any drift
(the regenerate-and-diff CI gate, `.github/workflows/graphs-gate.yml`).

**Never edit the `*.json` artifacts by hand.** Change the inputs (packs,
planners, journey registry, fixtures) and re-run `ibx graph export`.

## The ONE graph JSON contract

Every artifact is a `GraphDocument`
(`packages/journeys/src/graphs/contract.ts` — the T2-5 QA viewer consumes
exactly this shape):

```jsonc
{
  "version": 1,
  "graph": "capability" | "journeys" | "run" | "impact",
  "meta": { /* graph-level metadata (totals, window, flagged kinds…) */ },
  "nodes": [{ "id": "…", "type": "…", "label": "…", "meta": { } }],
  "edges": [{ "from": "<node id>", "to": "<node id>", "type": "…", "meta": { } }]
}
```

Determinism is load-bearing (the gate compares bytes): nodes are sorted by
`(type, id)`, edges by `(type, from, to)` (code-point order), meta keys are
sorted recursively, and documents carry **no timestamps / hostnames /
absolute paths**. Serialization is 2-space JSON with a trailing newline.

## The four graphs

| Artifact | Derived from | Nodes | Edges |
|---|---|---|---|
| `capability.json` | `@ibatexas/packs-composed` + `KNOWN_INTENT_KINDS` + the chat-drivable roster + pack policy metadata (`plausibleDecisions`) | `pack`, `intent`, `tool`, `planner` | `declares` (pack→intent), `registers` (intent→tool), `advertises` (planner→intent, meta.contexts), `plans` (pack→planner) |
| `journeys.json` | the Journey Registry (`packages/journeys/journeys/*.yaml`) | `journey`, `act`, `expectation` (`expect:<kind>:<decision>`, shared), `gap` | `has-act`, `expects` (meta.optional — T1b-1 allowances claim no coverage), `blocked-by` (→ gap — **blocked journeys ARE the product backlog**, D-014/D-015) |
| `run-fixture.json` | `fixtures/run-trace.jsonl` + `fixtures/run-decisions.json` (sanitized — see below) | `run`, `act`, `envelope`, `decision`, `verify` | `has-act`, `observed` (act→envelope, temporal attribution; off-window envelopes hang off the run), `decided` (envelope→decision), `verified` |
| `impact.json` | `fixtures/impact-window.json` — an `intent_audit` aggregation (kind × decision counts) **excluding the `agent:` session namespace** (same filter as the T1b-3 replay gate; T3-6 shadow rows can never read as production signal; the exclusion count is always reported) | `intent`, `decision` | `decided` (meta.count) |

### Capability-graph roster flags (the P0-7 facts)

`capability.json` flags two intent-node states on `meta.flags` and
summarizes them in `meta.dangling` / `meta.unadvertised`:

- **`dangling`** (*advertised-no-tool*): a capability planner advertises the
  kind in some persona context, but no registered chat-drivable tool carries
  it.
- **`unadvertised`** (*registered-not-advertised*): a tool is registered for
  the kind, but no planner advertises it in any persona context (e.g. the
  WS4 de-advertised payment kinds).

The graph **renders** the facts; the apps/api `toolRosterDrift` boot gate
remains the enforcement point.

## Fixtures (`fixtures/`)

- `run-trace.jsonl` + `run-decisions.json` — a SMALL **sanitized** sample
  run (synthetic ids/timestamps mirroring a real D-014 JOURNEY-001 attempt).
  The committed run graph is generated from these, **never from live data**
  (`runs/<runId>/` traces are gitignored and may carry per-run identifiers).
  To graph a live run during debugging:
  `ibx graph export --only run --run-trace runs/<runId>/trace.jsonl --run-decisions <join.json>`
  (refused in `--check` mode — the gate always diffs the committed fixtures).
- `impact-window.json` — captured from the **test stack's** audit plane
  (golden-vector-seeded `intent_audit`; zero LLM tokens). Recapture against
  any audit database with
  `DATABASE_URL=… ibx graph export --capture-impact --since 24h`, then
  commit the regenerated `impact.json` + fixture together. The generator
  (`fetchImpactWindow` / `buildImpactGraph`) is what matters — the fixture
  keeps the drift gate deterministic and DB-free.

## Regeneration discipline

Any change to packs, planners, the intent-kind union, the journey registry
or these fixtures requires re-running `ibx graph export` and committing the
diff — that diff review IS the review of the composition change. The CI
gate fails any PR that changes the inputs without regenerating.
