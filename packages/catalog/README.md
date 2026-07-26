# `@ibatexas/catalog`

The single **versioned root of business definition**.

LE2 Implementation Decision 13:

> The catalog package starts as **minimal accretion**: capability definitions
> and claim-registry references move under one versioned root with
> cross-reference checks; every turn stamps the catalog version into its trace
> (the replay enabler). **Nothing new is added until what exists is unified.**

## The one rule

**The catalog defines; it never holds runtime authority.**

Every export is inert data or a pure function over that data. Nothing here
reads a clock, performs IO, or decides anything at request time. The runtime
authorities are untouched and keep their power: the kernel adjudicates,
`SUCCESS_CLAIM_CLASSES` clamps confabulated success prose, `CLAIM_REGISTRY`
constrains claim generation, the installed Packs own their guards, and
`toolRosterDrift()` still runs fail-closed at boot in
`apps/api/src/claustrum-bootstrap.ts`.

## Contents

| Module | What it is |
|---|---|
| `src/version.ts` | `CATALOG_VERSION` — the monotonic serial (see below) |
| `src/capability-definitions/` | The authored capability data (58 capabilities — 20 chat-tier, 38 identity-tier) and its twelve pure projection generators |
| `src/claim-references.ts` | The claim **name spaces** a definition may point at |
| `src/external-references.ts` | The names the catalog **depends on but does not own** — a promotion in Medusa, a zone row in the domain DB (LE2-018) |
| `src/compiler/` | The **catalog compiler** — five fail-closed static passes, wired into `build`, CI, and `ibx catalog check` |
| `src/conformance/` | The compiler's **conformance suite** — a fixture catalog per rejection class, golden-pinned ([README](src/conformance/README.md)) |
| `src/build-gates/check-claim-references.ts` | Cross-reference check v0 — now a thin adapter over the compiler's referential edge table (same API) |

## The catalog compiler (LE2-016/018)

LE2 Implementation Decision 16: *"The catalog compiler is fully fail-closed.
Static passes … are compile/CI errors."* **An inconsistent catalog does not
build.**

| Pass | What it proves | Example rejection |
|---|---|---|
| `referential-integrity` | Every cross-reference resolves; every identity is unambiguous | `successClaimLinks[1] -> "order-nuked"` resolves against nothing; two capabilities claim the tool name `reorder` |
| `slot-dataflow` | Every declared slot is well-formed for its tier contract | `successClaimLinks: []` (say `undefined`); `refusalCodes:` (a typo nothing reads); `refusalCode` on an identity-tier capability |
| `safety-implication-edges` | No claim edge terminates in an allergen/dietary attribute | a capability linking its success to `MENU_ITEM_ALLERGENS` or to `sem_gluten` |
| `terminal-coverage` | Declared terminals are complete and pack-coherent | a guard chain with no refusal floor; two capabilities of one Pack declaring different floors |
| `external-references` | The external-reference table is well-formed and consumer-attributed | a declaration naming an unprobeable store; a `keyFrom` that is not an env-var name; a consumer naming a capability kind that no longer exists |

Every diagnostic names **the object, the offending slot/edge, and the violated
rule**, and the whole list is stable-sorted so a CI log diff is meaningful.

```
✗ slot-dataflow — 1 error(s) (1300 checked)
    slot-dataflow/unknown-slot: capability:order.cancel · refusalCodes — no such slot in the …
```

Run it:

```bash
ibx catalog check            # all five passes, human-readable
ibx catalog check --json     # the full CatalogCompileResult
ibx catalog check --live     # …plus reconciliation against the live stores (LE2-018)
pnpm --filter @ibatexas/catalog run check   # the same passes, no CLI build needed
```

The passes are **pure** — no clock, no RNG, no network, no IO beyond the
package's own data — so the command needs no database and no running service,
and reproduces exactly what CI sees. The compiler is a **build tool**: it is
upstream of the runtime and holds none of its authority.

### The safety pass is a ratified policy, not a heuristic

`safety-implication-edges` encodes three ratified tracker rulings and nothing
else: **BKL-143** (an owner-attested allergens array does not license a
customer-facing *"não contém X"* render — standing policy is honest self-report
plus real staff handoff), **BKL-123** (`MENU_ITEM_ALLERGENS` stays deliberately
UNKNOWN-only), and **BKL-171** (no dietary *"sem glúten/lactose"* renders;
vegano/vegetariano-only renders remain out too). Reopening any of them requires
an explicit owner reversal in writing — and a deliberate change to
`src/compiler/passes/safety-implication-edges.ts`, never a quiet edit to the
marker list.

Unrecognized safety-bearing names route **conservatively to deny**: markers are
matched as stems, so a reference nobody anticipated (`menu-item-allergens-v2`)
is refused by construction rather than assumed harmless.

### External references: the catalog declares, it never verifies (LE2-018)

Most of what a capability points at lives inside the catalog. Some of it does
not — a Medusa promotion, a delivery-zone row — and until LE2-018 those
dependencies were string literals in code with a `// must be created in Medusa
admin before going live` comment beside them. `src/external-references.ts`
turns each into a declaration: which store must hold it, which **environment
variable** names its key, and every code site that breaks without it.

The catalog holds the variable's *name* and never the key. A coupon code is
environment data (CLAUDE.md rule 3), and a catalog carrying one would compile
differently per environment.

Verification lives strictly downstream, because this package does no IO:

| Where | What it does |
|---|---|
| `external-references` pass (here) | the table is well-formed and its consumers resolve |
| `@ibatexas/tools` `reconcileExternalReferences` | probes each live store through the client the repo already uses |
| `apps/api/src/claustrum-bootstrap.ts` | **refuses to start** on any miss, beside `toolRosterDrift()` |
| `ibx catalog check --live` | the same reconciliation, standalone — and the pre-deploy gate |

The boot gate is strict with no bypass (LE2 Implementation Decision 16, owner-
ratified; blast radius accepted). The mitigation is `--live`, wired into the
staging deploy pipeline so a dangling reference surfaces when someone changes
it rather than when something restarts — see
[docs/setup/deployment.md](../../docs/setup/deployment.md).

Adding a reference: declare it here, add its variable to `.env.example` and the
environment's secrets, and create the thing in its store. Adding a *store* is
one entry in `EXTERNAL_REFERENCE_STORES`, one probe in
`packages/tools/src/external-references/probes.ts`, and the conformance fixture
the meta-gate will demand.

### The conformance suite is the compiler's compatibility contract (LE2-017)

`src/conformance/` holds one committed fixture catalog per **rule id** — 26
today across the five passes, plus four clean controls — each with its
compiler output pinned byte-for-byte in `src/conformance/__golden__/`. The
passes' unit tests assert pass *logic*; the conformance corpus pins the
*diagnostic contract*: the exact diagnostics, in the exact order, with the
exact object / field / rule / message / reference, and each pass's `checked`
count.

**No new rejection class lands without a conformance fixture** — and that is a
mechanism, not a convention. The meta-gate parses `src/compiler/` for the
registered passes and the rule ids they can emit, and fails naming the gap when
the corpus misses one. It runs inside the package's ordinary `test`; there is
no separate CI step to keep in sync.

```bash
pnpm --filter @ibatexas/catalog test               # the suite rides the normal test gate
pnpm --filter @ibatexas/catalog run conformance:regen   # regenerate goldens deliberately
```

See [`src/conformance/README.md`](src/conformance/README.md) for how to add a
fixture and how to read a golden diff.

### Not here, by design

Journeys, aliases, and the pairings knowledge graph are **later LE2 tickets** —
Decision 13's "nothing new is added until what exists is unified" is a
constraint on this package, not an oversight. A catalog CMS, an admin editor,
and any runtime catalog-mutation path are **ratified Out-of-Scope**: catalog
data is hand-authored and code-reviewed until the schema has survived five
real journeys.

The guard-resolution boot assertion also stayed behind in
`@ibatexas/packs-composed`. It resolves a guard *reference* to a real guard
*function* in an installed Pack — a statement about the runtime, not about the
definition — so it belongs on the binding side. (It is also mechanically
impossible to move: it reads `IBATEXAS_COMPOSED_PACKS`, which would make the
catalog depend on its own dependent and produce a circular turbo build graph.)

## Version-bump discipline

`CATALOG_VERSION` is a **hand-authored monotonic integer**, currently `1`.

It is deliberately *not* derived (no content hash, no git sha, no build
timestamp): a derived version changes on every unrelated edit and cannot be
reviewed in a diff. The stamp is meaningful precisely because a human decided
"the business definition changed" and a reviewer can see that decision.

### When to bump

Bump by **exactly +1**, in the **same commit** as the change, for any change to:

- `src/capability-definitions/definitions.ts` — adding, removing, or editing a
  capability; changing any field on one (`guardRefs`, `refusalCode`, `auth`,
  `surfaces`, `successClaimLinks`, `legacyNames`, `adminLabel`, …)
- `src/capability-definitions/types.ts` — the field contract itself
- `src/claim-references.ts` — either claim name space
- Any `src/capability-definitions/generate-*.ts` whose output would change for
  unchanged input (a projection semantics change)

### When *not* to bump

- Comment, doc, or README edits
- Test-only changes
- A refactor that provably cannot change any generator's output for any input

When in doubt, bump. A skipped bump makes a historical turn irreproducible; a
spurious bump costs nothing but a row value.

### Never

- **Never reuse a value.** Two different catalogs sharing a version breaks
  replay — the whole reason the version is stamped.
- **Never decrease.** Reverting a definition change is a *new, higher* version,
  not a return to the old one. The version orders edits; it does not name
  states.

## Cross-reference check v0

`pnpm --filter @ibatexas/catalog build` runs `tsc` and then the gate:

```
[catalog] cross-reference check OK — catalog v1: 32 claim reference(s) across 58 capability definition(s) all resolve.
```

v0 checks the one capability→claim edge that exists today:
`CapabilityDefinition.successClaimLinks` → `CLAIM_CLASS_REFERENCES`. A dangling
reference exits non-zero and fails the build, following the repo's fail-closed
gate idiom (the capability-definitions freshness gates, the roster-integrity
pins, the boot drift check).

Adding a new edge means appending one entry to `EDGES` in
`src/build-gates/check-claim-references.ts` — the checker is written against a
list of edges, not against one hard-coded field.

### Why the vocabularies are mirrors, and why that is safe

`packages/*` cannot import `apps/api`, so the gate cannot read the live
`SUCCESS_CLAIM_CLASSES` / `CLAIM_REGISTRY` arrays. `src/claim-references.ts`
mirrors their **names only**. Both mirrors are pinned to their originals by
tests that *can* see both sides:

- `apps/api/src/claustrum/__tests__/catalog-claim-references.test.ts` — pins
  **both** vocabularies set-equal to the real `SUCCESS_CLAIM_CLASSES` ids and
  `CLAIM_REGISTRY`, in both directions.
- `apps/api/src/claustrum/__tests__/capability-definitions.success-claim-round-trip.test.ts`
  — the pre-existing pin that no capability links to an id the responder does
  not define. Unchanged; the build gate is its build-time restatement.

Adding a claim class or registry type without updating this package fails those
tests loudly. That coupling is intended and cheap.

## The trace stamp

Every turn stamps `CATALOG_VERSION` into `turn_trace.catalog_version`
(`flushTurnTraces` in `apps/api/src/claustrum-bootstrap.ts`, the once-per-turn
flush seam — the same place `conversationId` is injected). The qa-viewer RCA
workbench displays it on the turn header strip.

Together with the durable wire capture this closes deterministic turn replay:
any historical turn is re-runnable against exactly the catalog it saw.

## The only import path

The move landed in two halves, both zero-behavior-change. LE2-014 was the
**expand** phase: the files moved here and
`@ibatexas/packs-composed/capability-definitions` re-exported them verbatim, so
no call site had to change in the same commit as the move. LE2-015 was the
**contract** phase: every caller now imports `@ibatexas/catalog`, and those
re-exports are deleted.

Import capability definitions, their types, and every `generate*` projection
from this package. There is no second path.

`@ibatexas/packs-composed/capability-definitions` still exists and still runs
its eager guard-resolution boot assertion, but it exports only the
guard-resolution surface — binding a guard reference to a live guard function
in an installed Pack is runtime authority, which the catalog never holds.
