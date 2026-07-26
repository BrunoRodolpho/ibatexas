# Alias mining — turning misunderstandings into catalog data

**Command:** `ibx alias mine` · **Ticket:** LE2-026 · **Blocked by:** LE2-025 (the semantic alias layer)

Every time a customer names a product with a word the catalog does not know, the
turn degrades — a CLARIFY at best. The alias gazetteer
(`packages/catalog/src/alias-gazetteer.ts`) is where those words become
resolvable. This runbook is the loop that keeps it growing from evidence rather
than from imagination.

---

## What the job does, and what it deliberately does not

`ibx alias mine` is an **offline analysis job**. It reads recorded turns,
classifies the product words customers used against the **live product roster**,
and writes a ranked markdown worksheet with approve/reject checkboxes per
candidate.

It writes **nothing** back. Not to the catalog, not to the runtime, not to any
store it reads. The only path from a mined candidate to system behavior is a
human editing the gazetteer in a reviewed PR. That is not a limitation to be
engineered away later — it is the design:

- **Mining cannot regress the runtime.** No `apps/api` code imports anything the
  miner touches, so no mining bug can reach a customer turn.
- **Approval is a real gate.** A candidate is a hypothesis about language. The
  build gates (ambiguity, allergen/dietary safety) run on the human's edit, not
  on the miner's guess.
- **The durable artifact is the gazetteer diff**, reviewable in git history
  forever. The report is a worksheet with a short life.

---

## When to run it

| Trigger | Why |
|---|---|
| **Monthly**, as a standing cadence | Vocabulary drifts with the menu and the season. A month is short enough that a recurring miss is caught before it becomes normal, and long enough to accumulate evidence above the noise floor. |
| **After a menu change** — a new product, a renamed one, a new variant | New things arrive with colloquial names already attached. This is the highest-yield trigger. |
| **After a marketing push or a viral moment** | Campaigns teach customers a word. If it is not the catalog's word, every one of those turns clarifies. |
| **When the ALIAS funnel tier's clarify counter climbs** | `funnel.tier` with `tier=ALIAS` is the runtime saying it hit a declared-ambiguous surface with no disambiguating token. A rising count is a direct request for gazetteer work. |
| **Before any alias-layer change** | To get a baseline you can compare against afterwards. |

Not on a cron, and not in CI. The output needs a human decision to be worth
anything, so scheduling it faster than an owner reviews it only produces stale
worksheets.

---

## Running it

```bash
# From the repo root, with the dev stack up (`ibx svc health`).
ibx alias mine

# Narrow the labelled-event window, widen the transcript read.
ibx alias mine --since 7d --limit 20000

# Only recurring candidates.
ibx alias mine --min-evidence 3

# Deterministic frequency ranking, no embedder.
ibx alias mine --no-embed

# Read it without writing a file.
ibx alias mine --stdout | less
```

| Flag | Default | Meaning |
|---|---|---|
| `--since <window>` | `30d` | LogsQL window for labelled funnel events. |
| `--limit <n>` | `5000` | Max distinct transcript utterances read. |
| `--min-evidence <n>` | `1` | Drop candidates below this many distinct utterances. |
| `--out <path>` | `scratch/language-engine-2/results/26-alias-mining-<date>.md` | Report path. |
| `--no-embed` | embedder on | Skip the advisory embedder; rank by frequency alone. |
| `--stdout` | off | Print instead of writing. |

### Prerequisites

- **Postgres** (`:5433`) — required. Supplies both the transcripts and the live
  roster. An unreachable roster is the one fatal error: classifying against an
  empty roster would report the entire catalog as missing.
- **VictoriaLogs** (`:9428`) — optional. Supplies the labelled funnel events.
  It ships in `docker-compose.observability.yml`, which is **not** part of the
  default `ibx dev` stack; start it with
  `docker compose -f docker-compose.observability.yml up -d victorialogs`.
  When it is down the report says so, per source, and carries on.
- **Embedder** (`OLLAMA_EMBED_URL`, `OLLAMA_EMBED_MODEL`) — optional and
  advisory. See "Where embeddings are allowed" below.

---

## Where the reports live, and why they are not committed

Reports default to **`scratch/language-engine-2/results/`** — outside the
repository, alongside every other LE2 measurement artifact.

They contain real customer utterances. Those are PII-scrubbed through
`@ibatexas/pii`'s `PII_PATTERNS` (the same taxonomy the audit redactor and the
decision-layer classification guard use), plus a wider pass that masks order
references, which are not PII but are a direct handle onto one customer's order.

Scrubbing is a **filter, not a proof**. A worksheet whose whole purpose is to be
marked up and discarded has no reason to become a permanent, world-readable
record of what customers typed, so the default keeps it out of git. Commit a
report only after reading it end to end, and then only if there is a reason the
gazetteer diff does not already serve.

---

## The report, row type by row type

Rows are grouped by what they ask of you, ordered by actionability and then by
evidence.

| Row type | What it means | What you do |
|---|---|---|
| `propose-alias` | Exactly one live product answers to this word, and the gazetteer does not know it. | Approve → add one `AliasEdge`. The common case. |
| `needs-disambiguation` | The word names **two or more** products. | Approve → author one edge **per reading**, each with a `disambiguatedBy` token. The `alias-gazetteer` compile pass rejects anything less. |
| `variant-target` | The word names a product **variant** (e.g. `coca` → the Coca-Cola variant of `refrigerante`). | **Not approvable today.** `AliasEdge.canonical` is a product or category handle; an edge pointing at the parent product would collapse two variants into one and lose the customer's actual choice. Needs an owner decision on the edge shape first. |
| `catalog-gap` | Customers ask for it by the unit and **nothing in the live roster matches**. | A product decision, not an alias one. Never paper over it with an alias: an alias pointing at a handle that does not exist turns a clear request into a **silent miss**, which is worse than the CLARIFY it replaces. |
| `already-canonical` | The word is the store's own name for the thing. | Nothing. Reported so a reviewer can see the miner checked. |
| `already-aliased` | Already a declared surface form. | Nothing — but the evidence count tells you whether the edge is earning its place. |
| `noise` | Extraction artefact. | Nothing. Listed so the extractor's error rate stays visible instead of hidden. |

### Approving a row

1. Tick **approve** in the report.
2. Add one `AliasEdge` to `ALIAS_GAZETTEER` in
   `packages/catalog/src/alias-gazetteer.ts`:
   - `surface` — the customer's own spelling, natural pt-BR, accents and all.
   - `canonical` — the kebab-case handle from the row.
   - `provenance: "production-utterance"` — every mined row is grounded in real
     traffic, which is what that tag means.
   - `why` — one clause, taken from the row's evidence.
   - `disambiguatedBy` — required if and only if the surface names more than one
     entity.
3. `pnpm --filter @ibatexas/catalog build` (or `ibx catalog check`) to run the
   gates: ambiguity, and the allergen/dietary safety binding (BKL-143 / BKL-123 /
   BKL-171) that forbids an alias edge starting from **or** ending at an allergen
   or dietary attribute.
4. Open a PR. **This diff is the versioned record of the mining run.**

---

## Sourcing boundary — load-bearing

Nothing may be mined from **`packages/journeys/extraction-corpus`** or the
**extraction-eval fixtures**. That corpus is the hard gate for every parser
change; mining it would convert the gate into training data and quietly destroy
its independence.

The miner enforces this structurally rather than by policy: `sources.ts` performs
**no filesystem reads at all**. Its only inputs are two live stores, so there is
no code path to the corpus to accidentally take. The report additionally states
its source **per row**, so a reviewer can check the boundary held rather than
trust that it did.

---

## Where embeddings are allowed

Offline and advisory. Never on an authoritative path.

Concretely, embeddings may only **reorder** rows and fill the advisory *nearest
canonical* line. They may **not** change a row's type, add a row, or remove one.
Classification is a pure function of (mentions, roster, gazetteer) and is
identical with the embedder up or down.

The reason is reproducibility of a human decision. If a similarity score could
flip a row from `catalog-gap` to `propose-alias`, then the report's content would
depend on whether an ollama host happened to answer — two runs, two different
owner decisions, and nothing in the artifact to tell them apart. With the
embedder down the report degrades to `frequency-only` and **says so in its
header**, which is the difference between a weaker report and an untrustworthy
one.

---

## Known limits — read these before trusting a row

- **The extractor is lexicon-driven.** Candidates are the objects of request
  verbs (`quero uma coca` → `coca`). A request phrased with a verb the lexicon
  does not hold contributes nothing at all. This is a **recall** limit, and it is
  the safe direction to fail in when a human approves the output: a missed
  candidate costs another run, an invented one costs a wrong alias.
- **`catalog-gap` vs `noise` rests on one heuristic** — whether the object was
  ever preceded by an indefinite article or a numeral ("uma agua"). It is right
  far more often than not, and it is why `muda o status` is not filed as a
  request for a new product. Expect a handful of obvious rejects per run.
- **Plurals are matched by stripping a trailing `-s`.** Deliberately blunt. It is
  confined to *matching*; an approved row still writes the surface the customer
  actually typed.
- **A labelled event carries no utterance.** The funnel logs surfaces and
  handles, never customer prose, so those rows show the surface form as their own
  evidence. Real, and shown as such rather than padded with invented context.

---

## A worked finding, and the lesson in it

The first real run's headline row was `coca` — 12 distinct utterances, the
highest-evidence unresolved surface in the corpus. It came back as
**`variant-target`**, not `propose-alias`, because `coca` names the Coca-Cola
*variant* of the `refrigerante` product.

That row also corrected the record. LE2-025a's gazetteer header states as fact
that `refrigerante` is a catalog gap — *"there is NO soft-drink handle in the
seed at all"* — and declined to author the ticket's own motivating example
(`coquinha` → Coca-Cola) on that basis. The live store has sold a published
`refrigerante`, with Coca-Cola and Guaraná Antarctica variants, since
`apps/commerce/src/seed-data.ts` was written.

The header's own "Reconciliation, deferred" section explains how that happens: it
says plainly that the catalog package **cannot** prove a canonical name resolves
to a live product. The header then made exactly that live-store claim anyway,
from a package-local view, and it read as authoritative because it was
confidently phrased.

**This is why the miner classifies against the live roster and never against the
catalog's own view of itself.** A `catalog-gap` row means the job queried the
products table and found nothing — a claim you can re-run in one command. It is
the difference between a fact and a recollection.
