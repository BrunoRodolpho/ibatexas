# The catalog compiler's conformance suite (LE2-017)

**This suite is the compiler's compatibility contract.**

The nine static passes are one of Language Engine 2.0's architectural
foundations. What makes their behavior a *versioned promise* rather than an
implementation detail is this corpus: one committed fixture catalog per
rejection class, each one's compiler output pinned byte-for-byte.

> LE2 Testing Decisions — *Build gate (existing, extended)*: "every rejection
> class gets a fixture catalog that must fail to compile, and compiled
> projections are golden-pinned exactly like today's generated rosters."

## The standing convention

**No new rejection class lands without a conformance fixture.**

This is not a convention you have to remember. `__tests__/meta-coverage.test.ts`
parses `src/compiler/` for the registered passes and every rule id they can
emit, and fails — naming the gap — when the corpus does not cover one. A
ticket that adds a pass turns this test red until its fixtures land in the
same change — which is exactly what happened to LE2-018's `external-references`
pass and to LE2-025a's `alias-gazetteer` pass, and how their fixtures came to
exist.

## What it is, and what it is not

| | |
|---|---|
| The pass **unit tests** (`src/compiler/__tests__/`) | assert pass LOGIC inline: this input, that diagnostic, in prose |
| This **conformance suite** | pins the DIAGNOSTIC CONTRACT over committed fixture catalogs: the exact diagnostics, in the exact order, with the exact object / field / rule / message / reference |

They are complements. A logic change that is intentional shows up in both; a
logic change that was *not* intentional usually shows up here first, because a
golden diff needs no one to have thought of the case.

## Layout

```
src/conformance/
  types.ts              the fixture contract + the one widening cast
  fixtures/
    base.ts             the two WELL-FORMED base capabilities (the controls)
    <pass>.ts           one fixture catalog per rule id of that pass
    clean.ts            the fixtures that must compile silent
    index.ts            CONFORMANCE_FIXTURES — the registry the gate reads
  rule-inventory.ts     reads the passes' rule ids out of the compiler's SOURCE
  golden.ts             the golden shape and its canonical bytes
  regenerate.ts         the regen entry point
  __golden__/           one committed golden per fixture + the rule inventory
  __tests__/            the byte-identity suite and the meta-enforcement gate
```

The suite rides the package's normal test run (`pnpm --filter
@ibatexas/catalog test`, and so `pnpm turbo test`). There is no separate CI
step to keep in sync — the existing test gate is the gate.

## Adding a fixture for a new rule

1. **Write the fixture catalog.** Add an entry to `fixtures/<pass>.ts` (create
   the file for a new pass, and register it in `fixtures/index.ts`):

   ```ts
   {
     name: "<pass>.<rule>",              // also the golden's basename
     targets: "<pass>/<rule>",
     why: "the one sentence a reviewer needs",
     definitions: fixtureCatalog({ ...IDENTITY_BASE, kind: "conformance.…", /* one deviation */ }),
   }
   ```

   Rules for a fixture catalog:
   - **Tiny and single-purpose** — start from a base in `fixtures/base.ts` and
     change exactly one slot. Two capabilities only when the rule is a
     collision or a per-Pack coverage statement, which a single object cannot
     express.
   - **Self-contained** — never import `CAPABILITY_DEFINITIONS`. A fixture that
     read live data would change meaning every time the catalog is edited.
   - **Declare co-emissions.** If the catalog legitimately trips another pass
     too, list those rule ids in `alsoEmits` with the reason in `why`. The
     suite asserts the emitted set is EXACTLY `targets + alsoEmits`, so an
     accidental extra diagnostic fails rather than accumulating.

2. **Regenerate the goldens** (writes every golden and deletes orphans):

   ```bash
   pnpm --filter @ibatexas/catalog run conformance:regen
   ```

3. **Read the diff.** A golden diff you cannot explain is the finding, not an
   inconvenience — see below.

## Reading a golden diff

A golden changes only when one of four things changed, and each is a change to
what the compiler *promises*:

| The diff touches | What changed |
|---|---|
| `diagnostics[].rule` / a new or vanished entry | a rule changed its mind about the data |
| `diagnostics[].message` / `formatted[]` | the build-log UX changed |
| `passes[].checked` | a pass changed what it looks at — on a **clean** fixture this is the anti-vacuous-gate signal (a pass that stops counting has stopped running) |
| the ORDER of `diagnostics[]` | the total order moved — LE2-016 guarantees it, so this is a defect until proven otherwise |

"Just regenerate it" is never the answer on its own.

### What the golden deliberately does not pin

`catalogVersion`. It is the catalog's serial, not the compiler's diagnostic
contract, and a fixture catalog is not the catalog — pinning it would turn
every version bump into a twenty-file regeneration whose diff carries no
signal.

Diagnostics are re-serialized with their fields in a fixed **key order**. JSON
key order is an artifact of how a pass spells its object literal; it is not
part of the contract. The **array order** is written exactly as the compiler
emitted it: the suite never sorts, filters or normalizes the diagnostics
themselves.

## The rule inventory (why the gate cannot go vacuous)

`rule-inventory.ts` parses `src/compiler/` and resolves the rule ids the
passes can emit. It reads these shapes:

```ts
rule: "unknown-slot"                  // a literal
rule: known ? "a" : "b"               // a conditional over literals
rule: danglingRuleFor(d.field)        // a local function returning them
{ pass: PASS, rule, … }               // the `rule` parameter of a local helper,
                                      // resolved through its call sites
```

Anything else — a rule id built by concatenation, imported from a table, or
computed at runtime — makes the scan **throw**, naming file and line, rather
than return a short list. A meta-gate that quietly found no rules would pass
forever. Likewise a file that builds diagnostics but declares no
`const PASS = "<pass id>" as const` throws: there would be no way to say which
pass owes the fixture.

If your pass needs a shape the scanner cannot read, teach it the shape in the
same change. `__tests__/scanner-fixtures/` holds two deliberately unreadable
sources that prove the scanner fails loudly rather than under-reporting.

The inventory itself is golden-pinned (`__golden__/pass-rule-inventory.json`),
so an added, renamed or removed rule id is a reviewable diff.
