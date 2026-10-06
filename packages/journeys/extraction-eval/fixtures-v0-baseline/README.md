# `fixtures-v0-baseline/` — the pinned BEFORE of wire-constraint V1 (LE2-006)

This directory holds artifact fixtures captured under a **retired wire regime**. It
is deliberately **not** `fixtures/`, so the harness's default score never reads it.

```
# score the retired V0 regime (the "before")
ibx journey extraction-eval --fixtures-dir packages/journeys/extraction-eval/fixtures-v0-baseline

# score the current regime (the standing gate, the "after")
ibx journey extraction-eval
```

## Why it is not in `fixtures/`

The harness's default fixture set is the project's **standing evidence**, and its
scoring rule is *"a case passes iff **every** captured parse of its utterance
satisfies the expectation."* That rule is what makes an N× re-drive measure
stability for free — but it only means that when every capture came from **one**
configuration.

`wire-le2-001-redrive-2026-07-25.json` was captured with
`response_format: { type: "json_object" }` on every tool-bearing body. LE2-006
removed that (see `apps/api/src/claustrum/ollama-fetch-client.ts`). Pooling both
regimes in one directory would:

1. **permanently fail** the four ∅-class cases that V1 fixed, because the retired
   regime's debris would sit in the same bucket as the current regime's clean
   prose forever — the improvement would be unscoreable by construction; and
2. make every **future** ticket's score unattributable, since a delta could come
   from the change under test or from the retired evidence.

Keeping the regimes in separate directories preserves the "before" as reviewable,
auditable, re-scorable evidence while letting the standing gate describe the wire
the code actually sends. The before/after numbers this split produces are recorded
in `scratch/language-engine-2/results/06-adoption-after-measure-2026-07-26.md`.

## Known residue in the standing set

`fixtures/wire-ops-2026-07-21.json` is **also** pre-V1 capture (2026-07-21). It was
already committed to `fixtures/` before LE2-006 and is left in place — moving it is
not this ticket's call. It is the sole reason `eval.refusal:bare-greeting-oi` still
records one leaked observation (`order.note.add`) in the standing score: that leak
comes from the old V0 capture of "Oi", not from the current wire, which answers the
same utterance with prose in all four V1 passes. Whoever next touches this harness
should decide whether that file moves here too.

## Contents

| file | regime | provenance |
|---|---|---|
| `wire-le2-001-redrive-2026-07-25.json` | V0 (`json_object` on tool-bearing bodies) | LE2-001 emission baseline, 338 artifacts / 59 join keys, 4 passes on nemotron-3-nano:4b. Full provenance in the file's own `note`. |
