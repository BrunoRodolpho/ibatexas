# `extraction-eval/` — the offline parser evaluation harness (LE2-05)

> **Program rule, binding from this ticket on:** every parser-affecting change
> — funnel tiers, wire constraints, salvage, any future fine-tune — lands with
> a **before/after score from this harness**. It is the LE2 program's hard
> gate.

```
ibx journey extraction-eval                      # score, human output
ibx journey extraction-eval --json               # score, machine output
ibx journey extraction-eval --out ./eval-out     # + two committed-shaped views
ibx journey extraction-eval --verify-file packages/journeys/governance/extraction-eval-baseline.json
```

The harness is **offline**: no model, no server, no database. It reads
committed files only, so the same inputs always produce the same numbers.
Contrast `ibx journey extraction-accuracy`, which drives the **live** model.

---

## What it scores

| | |
|---|---|
| **Expectations** | the 308 authored cases in `../extraction-corpus/*.yaml` (consumed **unmodified**) + the ∅-class cases in `refusal-corpus.yaml` |
| **Evidence** | the pinned parse artifacts in `fixtures/*.json` |
| **Join key** | the **normalized utterance** — NFC form, trimmed, inner whitespace collapsed, case-folded |
| **Verdict** | `passing` / `failing` / `unscoreable`, plus a first-class refusal category |

### Structural, not literal

Scoring runs over the **parsed envelope**, never over rendered prose:

- the **capability must match exactly** — no tolerance at all;
- each authored slot is compared with `deepEqualArgs` (the existing sanctioned
  comparator: object key order irrelevant, array order significant) over
  values put through the same formatting normalizer as the join key — so
  casing, Unicode NFC form, padding and collapsed inner whitespace are noise;
- `payloadExactKeys` discipline is preserved verbatim — an extra or a missing
  slot key **fails**, exactly as it does for the live meter.

**Deliberately not tolerated:** type coercion. `"2"` is not `2`; `"true"` is
not `true`. The wire schema (`apps/api/src/claustrum/language-engine/
wire-schemas.ts`) pins each slot's JSON type, so a type mismatch is a *wrong
slot* the harness must keep catching.

### Refusal / irrelevance is its own category

A `refusal-corpus.yaml` case declares that its utterance must parse to **no
capability at all** — the extraction-plane mirror of the read-tool corpus's
`expectArgs: null` sound-abstain mode.

Refusal is **never folded into** extraction pass/fail. It is scored as the ∅
class of an ordinary per-class confusion matrix over the capability the parse
selected, which yields, from one uniform mechanism:

- `classification[]` — precision/recall for **every** capability, with the ∅
  class riding along under the reserved key `eval.refusal`;
- `refusal` — the aggregate block:
  - `correctlyRefused` — should refuse, did refuse (TN),
  - `leaked` — should refuse, parsed anyway (FP), attributed per capability,
  - `wronglyRefused` — should parse, refused anyway (FN),
  - `precision = correctlyRefused / (correctlyRefused + wronglyRefused)`,
  - `recall = correctlyRefused / (correctlyRefused + leaked)`.

A leaked greeting and a mis-extracted slot are different defects; they can
never cancel out.

### No artifact ⇒ UNSCOREABLE

A case whose utterance appears in no fixture, or whose expectation needs an
observability its evidence cannot give, is reported `unscoreable` with a
machine-readable reason — **counted, never passed, never failed, never
silently skipped**:

| reason | meaning |
|---|---|
| `no_artifact` | no pinned fixture carries this utterance |
| `hydration_not_observed` | the case asserts `hydratedIntentIR`, the artifact is wire-only (captured before any resolver ran) |
| `provenance_not_observed` | the case asserts `provenanceTrust`, the artifact carries no provenance map |
| `decision_not_observed` | the case asserts a kernel `decision`, the artifact carries none |

Note the asymmetry that keeps this honest: a captured parse that selected **no
capability** is always *scoreable* against a parse case — that is the
`wronglyRefused` false negative, not a missing observation.

### Several captures of one utterance

A case passes **iff every** captured parse of its utterance satisfies the
expectation. Re-driving the same utterance N times (the program's N× re-drive)
therefore measures stability for free — an unstable parser is a failing parser
— and the score never depends on which capture happened to be picked. Each
capture contributes its own observation to the classification matrix.

---

## The three input sources

### (a) The authored extraction corpus — `../extraction-corpus/*.yaml`

Supplies **expectations**: 308 cases across 22 capabilities, each an
`{utterance → expected {capability, payload subset}}` pair with the full
`IrExpectation` clause vocabulary (`payload`, `payloadExactKeys`,
`payloadPresent`, `provenanceTrust`, `hydratedIntentIR.confirmationRequired`,
`decision`). **Zero edits** were made to it by this ticket; the harness
re-keys the cases and reuses `evaluateExpectPayload` with only the leaf
comparator swapped, so there is no second copy of the expectation semantics.

### (b) Audit-gold turns — `fixtures/*.json`, `"source": "audit-gold"`

An `intent_audit` row carrying the FE-T05 `metadata.languageEngine` sidecar
(materialized post-hoc by `apps/api/src/claustrum/language-engine/
audit-metadata.ts` for exactly the 22 registered capabilities). Carries the
full `ExtractionIR` + `HydratedIntentIR` + per-field provenance + the kernel
decision — every clause an authored case can declare is observable.

### (c) Captured wire records — `fixtures/*.json`, `"source": "wire"`

An `llm_wire` request/response **attempt** pair (one row per attempt;
`UNIQUE (turn_id, seq)`; correlates to `turn_trace` on `(turn_id,
call_index)`). Carries only the raw assistant completion — or an
`express_intent` tool call — because an attempt is captured at the fetch
boundary, *before* any resolver ran.

Completions are stored **verbatim**, never pre-parsed. The harness reads them
with `parseWireCompletion`, which is **deliberately non-salvaging**: it
accepts a whole-completion JSON object (optionally inside one ` ```json `
fence) carrying a `capability` key, and reads *everything else* — prose, a
JSON object with no `capability` key, JSON buried inside a sentence — as **no
parse**. See "Feeding tickets 01–03" below for why that restraint is the
point.

---

## Fixture format

```jsonc
{
  "formatVersion": 1,               // bumped only on a breaking shape change
  "source": "audit-gold",           // or "wire" — discriminates `artifacts`
  "id": "audit-gold-dev-2026-07",   // kebab-case, unique across fixture files
  "synthetic": false,               // true ⇒ hand-authored; labelled everywhere it is reported
  "note": "how this file was produced…",
  "artifacts": [ /* … */ ]
}
```

**`audit-gold` artifact**

```jsonc
{
  "utterance": "quero uma coca",             // the join key
  "capability": "order.item.add",            // null ⇒ the turn produced NO envelope
  "extractionIR":     { "payload": {…}, "provenance": {…} },
  "hydratedIntentIR": { "payload": {…}, "provenance": {…}, "confirmationRequired": false },
  "decision": "EXECUTE",                     // AuditRecord.decision.kind
  "provenance": { "store": "intent_audit", "sessionId": "hashed:…", "recordedAt": "…" }
}
```

**`wire` artifact**

```jsonc
{
  "utterance": "Oi",
  "completion": "{\"capability\": \"order.note.add\", …}",   // verbatim assistant text
  "toolCall": { "name": "express_intent", "arguments": { "capability": "…", "payload": {…} } },
  "provenance": { "store": "llm_wire", "turnId": "…", "seq": 0, "callIndex": 0, "model": "…", "recordedAt": "…" }
}
```

At least one of `completion` / `toolCall` is required. A tool call wins over
the text when both are present (the model used the sanctioned channel). Only
`express_intent` proposes a capability; a read-tool call proposes none.

`provenance` is recorded so a committed fixture is auditable back to its row.
It is **never read by the scorer** — it must not be able to influence a score.

### Governance posture

Exported fixtures follow the **`ibx journey from-audit` precedent**: they are
reviewed, committed files, produced by a human running the recipe below and
reading the diff. The harness never opens a socket, so a fixture is the only
way evidence enters it — which is exactly what makes the score reproducible
by anyone with a checkout.

---

## Export recipe

Both stores live in the same Postgres. Point `DATABASE_URL` at the stack whose
turns you want (`:5433` dev, `:5434` the ephemeral test stack). Run from
`packages/journeys/`, review the output, then commit it under `fixtures/`.

### (b) audit-gold

`intent_audit` does **not** store the utterance, so it is recovered by
re-deriving the salted session hash (D-012: `session_id = "hashed:" +
sha256(rawSessionId + AUDIT_REDACT_SECRET).hex.slice(0, 8)`) to map an audit
row back onto its `ibx_domain.conversations` row, then taking the latest
`conversation_messages` user message at or before the audit row's
`recorded_at`. **Both timestamps must be read as UTC** — `recorded_at` is
`timestamptz`, `sent_at` is a naive UTC `timestamp`, and a driver that
interprets the naive one as local time will silently pair nothing.

```js
// node, from packages/journeys/ (pg + yaml are already deps of this package)
import { createHash } from "node:crypto"
import pg from "pg"

const SECRET = process.env.AUDIT_REDACT_SECRET ?? ""          // dev stack: empty
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const hashed = (raw) =>
  `hashed:${createHash("sha256").update(raw).update(SECRET).digest("hex").slice(0, 8)}`

const convs = (await pool.query("select id, session_id from ibx_domain.conversations")).rows
const byHash = new Map(convs.map((c) => [hashed(c.session_id), c.id]))

const audit = (await pool.query(`
  select session_id, kind, decision_kind, metadata_jsonb,
         to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
  from intent_audit where metadata_jsonb ? 'languageEngine'
  order by recorded_at asc, id asc`)).rows

const msgs = (await pool.query(`
  select conversation_id, content,
         to_char(sent_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
  from ibx_domain.conversation_messages where role = 'user'
  order by sent_at asc, id asc`)).rows

// pair each audit row with the latest preceding user message of its conversation,
// keep the rows whose utterance is also an extraction-corpus utterance (that
// intersection IS the scoreable overlap), dedupe, and sort by
// (normalized utterance, capability, recordedAt).
```

Ops-plane turns are **not** recoverable this way: ops chat history lives in
Redis, not in `conversation_messages`, so an ops-plane audit row has no
utterance in Postgres. Use source (c) for those, or export from a corpus drive
where the driven utterance is known.

### (c) wire

```sql
select turn_id, seq, call_index, model, request_jsonb, response_jsonb,
       to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
from llm_wire order by turn_id asc, seq asc;
```

For each row: the utterance is the **last `user` message** of
`request_jsonb.messages`; the completion is
`response_jsonb.choices[0].message.content`; a tool call, when present, is
`…message.tool_calls[0]`.

**Keep only the parse attempt.** A turn emits several attempts: the extraction
call *and* the responder call, distinguishable by the request's system
message — the extraction persona opens with *"interpretador de comandos
operacionais"* on the ops plane. The responder attempt generates prose and
asserts nothing about parsing; including it would score the wrong call.

`llm_wire` is already PII-scrubbed at write time (`llm-wire-writer.ts` runs
the audit redactor's regex family over every message content — system
included — and every response string leaf), so an exported wire fixture needs
no further redaction. Read the diff anyway.

---

## Feeding tickets 01–03

LE2 tickets 01–03 (**stranded-JSON completions**, **envelope salvage**) are
about what the model leaves in the completion string — precisely the bytes
source (c) preserves verbatim. Their cases enter the harness like this:

1. **Preserve the turn.** Every re-drive of a stranding-prone utterance lands
   in `llm_wire` automatically (one row per attempt). Export the parse
   attempts with the recipe above into a new `fixtures/wire-<label>.json`.
   The N× re-drive of ticket 21 gives several artifacts for one utterance —
   the harness scores them **all**, so the stranding *rate* shows up directly
   as a case that only passes when every capture parsed.

2. **Author the expectation.** If the utterance targets a capability, the case
   already exists in `../extraction-corpus/` (or is added there, in the
   ordinary way). If it must be refused, add it to `refusal-corpus.yaml`.

3. **Score before.** `ibx journey extraction-eval --json` on the pre-change
   fixture set. Stranded JSON reads as **no parse** — `parseWireCompletion`
   refuses to salvage — so it shows up as a `wronglyRefused` false negative
   and a failing case. That is the honest "before" number.

4. **Score after.** Ticket 02's salvage translator becomes a **second,
   explicitly-selected reader** in `eval-score.ts` alongside
   `parseWireCompletion`; re-scoring the *same pinned fixtures* with it is the
   ticket's before/after delta. Nothing about the evidence changes — only the
   reading of it — which is what makes the delta attributable to the salvage
   change and to nothing else.

Teaching `parseWireCompletion` to salvage would erase this measurement. Do not.

---

## Governance

| file | role |
|---|---|
| `../governance/extraction-eval-baseline.json` | the passing set (`{"passing": [...]}`); `--verify-file` fails **exit 1** on any `passing → not-passing` regression — no tolerance band |
| `../governance/extraction-eval-waivers.json` | the same waiver schema/semantics as the live meter's; a waiver excuses a *failure*, never a missing measurement (an `unscoreable` case stays `unscoreable` even under a matching waiver) |
| `../governance/extraction-eval-flake-ledger.json` | the `--quarantined` seam, driven by the existing `ibx journey flake --ledger <path> --list-quarantined` machinery. **Not committed**: a replay of pinned artifacts is deterministic, so it cannot flake. The seam exists for the day an artifact set is knowingly unstable, not before. |

Every file is separate from the live meter's (`extraction-accuracy-*.json`) —
the two measure different things (a live drive vs. a replay of pinned
artifacts) and must never be mixed.

## Determinism

The scored body carries **no timestamp**, no wall clock, no run id, no host
detail — the same idiom the existing `AccuracyReport` follows. Every
collection is sorted: cases by their stable intake order (corpus files sorted
by filename, cases in declared order, then the ∅ class), capability and leak
rows by capability, unscoreable rows by the declared reason order, source rows
by source. Two runs over the same committed files are byte-identical, and a
unit test pins it.
