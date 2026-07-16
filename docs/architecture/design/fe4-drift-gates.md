# FE-4 drift-gate classification (FE-4.3 / FE-T25)

FE-4's consolidation (`~/projects/IBX_LANGUAGE_ENGINE_SPEC.md` §"FE-4 — Capability
metadata consolidation") replaces ~16 hand-maintained lists with generators derived
from a single `CapabilityDefinition` registry
(`packages/packs-composed/src/capability-definitions/`). FE-T19 through FE-T24
authored and freshness-gated those generators alongside the hand lists they mirror
(MIGRATE), without repointing any consumer (nothing broke — both sources stayed
alive). The final CONTRACT step (a later ticket) deletes the hand lists once every
consumer reads the generator instead.

**The risk this document resolves (FE-4.3's own mandate):** several boot-time drift
gates compare TWO sides — and some gates historically had one side be a hand list
that CONTRACT will delete. If a gate's *other* side is also generated from
`CapabilityDefinition`, deleting the hand list would leave the gate comparing
generated-vs-generated — an always-green, tautological check that catches nothing.
FE-4.3's mandate: every surviving gate must diff the generated projection against an
**independent runtime materialization** (an actually-installed Pack's own
`.intents[]`, the actually-registered DI tool container, the actually-executed
`CapabilityPlanner.plan()` output) — never another artifact of the same source data.

This ticket (FE-T25) traced all four boot drift gates + the surrounding drift-test
suite, classified each comparison, and repointed the ones that needed it. **Zero
gates required retirement** — every comparison that referenced a dying hand list
had an independently-real other side (a Pack object, a DI registration, a live
planner call), so repointing (swap the hand-list side for the generated projection,
leave the runtime side untouched) was always sufficient. This document is the
recorded rationale FE-4.3 requires either way.

## Classification table

| # | Gate | Location | Side that WAS a dying hand list | Side that is (and stays) runtime-independent | Classification | This ticket's change |
|---|------|----------|----------------------------------|------------------------------------------------|-----------------|-----------------------|
| 1 | `assertPackCoverage` | `apps/api/src/plugins/kernel-bootstrap.ts` | `knownKinds` argument — `PACK_REGISTERED_INTENT_KINDS`, derived from `KNOWN_INTENT_KINDS` (`@ibatexas/intent-kinds`) | `declared` — union of every **installed Pack's own** `pack.intents[]`, read live inside `assertPackCoverage`'s own body | **needs-repoint** | Real boot call now passes `GENERATED_PACK_REGISTERED_INTENT_KINDS` (`generateKnownIntentKinds(CAPABILITY_DEFINITIONS, {pixIntentKinds: paymentsPixPack.intents, loyaltyIntentKinds})`, minus loyalty kinds) instead. `PACK_REGISTERED_INTENT_KINDS` stays defined and genuinely IN USE (both counts now logged) — both sources alive. |

> **MINOR-2 (accepted, not fixed further) — the PIX sub-leg of gate 1 is now SAME-SOURCE.**
> Before this repoint, the walked side's pix kinds came from `KNOWN_INTENT_KINDS`'s own
> hand-typed `PIX_INTENT_KINDS` literal (`@ibatexas/intent-kinds`) — a value typed
> independently of the real `@adjudicate/pack-payments-pix`'s own `.intents`, so
> `assertPackCoverage`'s pix sub-check was genuinely hand-vs-runtime. This ticket's
> repoint passes `paymentsPixPack.intents` (the REAL pix pack's own array) as the
> generator's `pixIntentKinds` external input — so for the 3 pix kinds specifically,
> the walked side and the `declared` side now both trace back to the *exact same*
> live object. That narrows what this one gate can catch for pix: a hypothetical
> future divergence between the hand-typed `PIX_INTENT_KINDS` and the real pack's
> `.intents` would no longer be caught HERE. Accepted because (a) a full pix-pack
> **removal** is still caught — proven by a dedicated forced-mismatch test (see
> below) — and (b) the hand-vs-runtime pix drift class this sub-leg used to catch is
> still pinned elsewhere: `generateKnownIntentKinds`'s own FE-T20 freshness test in
> `packages/packs-composed` diffs `generateKnownIntentKinds(CAPABILITY_DEFINITIONS,
> {pixIntentKinds: paymentsPixPack.intents, ...})` against the real, hand-authored
> `KNOWN_INTENT_KINDS` — so a `PIX_INTENT_KINDS` hand-typo would still fail THAT test.
> Net: no coverage gap, just a relocated one — but it is exactly the class of
> same-sourcing this ticket exists to police, so it is called out here rather than
> left implicit.
| 2a | `toolRosterDrift` — check 1 (`registered ⊆ pack-owned`) | `apps/api/src/tools/register-ibatexas-tool-packs.ts`, called from `claustrum-bootstrap.ts` | *(none)* | `tools` = `listIbatexasToolPacks()` (the real DI tool container); `packIntentKinds` = `composedIntentKinds()` (real union of `IBATEXAS_COMPOSED_PACKS[*].intents`, itself runtime-derived — not a mirrored hand list) | **survives-as-is** | No change. Neither side was ever a FE-4 hand list. |
| 2b | `toolRosterDrift` — context-aware leg + `chatSurfacedKinds` exemption | same | `chatSurfacedKinds` | `planners` = `IBATEXAS_COMPOSED_CAPABILITY_PLANNERS` (real, live `.plan()` calls); the checked `kind` values come from the real registered tools and the real advertised-intents output | **already-repointed (FE-T22)** | `chatSurfacedKinds` has been `new Set(generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS))` since FE-T22 — confirmed still independent, because the OTHER side of this specific check (registered/advertised kinds) is genuinely runtime-real, not itself generated. No further action; re-verified as part of this ticket's audit. |
| 3 | `readToolRosterDrift` | same, called from `claustrum-bootstrap.ts` | *(none)* | `planners` = real; `readExecutorKeys` = `Object.keys(IBATEXAS_READ_TOOL_EXECUTORS)` (real executor registration) | **survives-as-is** | No change. READ tools are entirely out of `CapabilityDefinition`'s scope (it models `mutating` capabilities only — see `types.ts`), so this gate never touched a FE-4 hand list at all. |
| 4a | `opsPlaneDriftProblems` — `toolRosterDrift`/`readToolRosterDrift` sub-legs | `apps/api/src/ops/ops-conductor.ts`, called from `claustrum-bootstrap.ts` | *(none)* | `opsTools` = `listOpsToolDefinitions(...)` (real); `composedIntentKinds()` (real); `planners = [opsCapabilityPlanner]` (real); `readExecutorKeys` = `Object.keys(opsReadToolExecutors)` (real) | **survives-as-is** | No change. |
| 4b | `opsPlaneDriftProblems` — BKL-096 forbidden-verb check | same | `forbidden` argument to `forbiddenOpsVerbProblems` — defaulted to `FORBIDDEN_OPS_DESTRUCTIVE_KINDS` (`ops-verb-scope.ts`) | `opsTools` = real DI ops-tool registry | **needs-repoint** | Added `forbiddenOpsKinds?: ReadonlySet<string>` to `opsPlaneDriftProblems`'s input (threaded to `forbiddenOpsVerbProblems`); the real boot call in `claustrum-bootstrap.ts` now supplies `generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS)`. `undefined` (omitted) still falls through to the old hand-authored default — every other caller is unchanged. |
| 4c | `opsPlaneDriftProblems` — BKL-100 advertised⊆renderable check | same | `renderableReadKeys` — defaults to `OPS_READ_RENDER_TEMPLATE_KEYS` | the advertised-reads side is real (`planner.plan()` output) | **survives-as-is** — genuinely out of scope | `OPS_READ_RENDER_TEMPLATE_KEYS` is **render-template territory**, not ops-boundary data — confirmed out of the FE-4 family already in FE-T24's own inventory sweep. No `CapabilityDefinition` field models render templates; this hand list is not scheduled for CONTRACT deletion at all. |
| 5 | "the drift unit test" (the suite exercising gates 1–4) | `apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts`, `apps/api/src/__tests__/tool-roster-integrity.test.ts`, `apps/api/src/__tests__/chat-drivable-roster-drift.test.ts`, `apps/api/src/ops/__tests__/ops-drift-parity.test.ts`, `ops-forbidden-destructive-drift.test.ts`, `ops-boundary-generator-freshness.test.ts` | — | — | **survives, re-verified green** | All pass after the repoint (counts below). No hand-list-vs-generated tautology found in any of these test files' own assertions (they all assert against real runtime output, e.g. real `Decision`s from `adjudicate()`, real planner `.plan()` calls). |

## Notes on adjacent, deliberately out-of-scope constants

- **`OPS_FOREIGN_ADVERTISED_KIND` / `_TRANSITION_KIND` / `_REFUND_KIND`**
  (`packages/pack-ops/src/capabilities.ts`) are hardcoded TypeScript literals
  *inside* the real `opsCapabilityPlanner`'s `allowedIntents` array — not read
  from an external hand list at runtime. They feed the **runtime-real** side of
  gates 2b/4a (the live `.plan()` output), so there is nothing here for a drift
  gate to compare against a generated projection. `generateForeignAdvertisedKinds`
  (FE-T24) reproduces their VALUES for its own freshness test, but that is a
  packages-level codegen-freshness check, not one of the four boot drift gates.
  Repointing the PLANNER's own source to read from the generator instead of the
  hardcoded literals would be a CONSUMER repoint (T26's territory), not a
  drift-gate repoint.
- **`WA_EXCLUDED_OPS_KINDS`** (`ops-verb-scope.ts`) — never appears inside any of
  the four gates' own comparison logic (it feeds `excludedKindsForScope`, a
  planner-SCOPING filter for the WhatsApp ingress, not a drift check). FE-T24
  already found and documented that this is a genuine business-policy judgment,
  not `CapabilityDefinition` data — reconfirmed here as out of scope for the same
  reason.

## CONTRACT (T26) sequence — per constant this ticket touched

This ticket keeps both sources alive (nothing repointed at T26's level — production
now READS the generated projection, but the hand-authored constants stay defined,
referenced, and freshness-pinned). T26 must not simply delete them and let the
compiler tell it what broke — each has a load-bearing NON-boot dependency a
compile error would not explain on its own:

1. **`FORBIDDEN_OPS_DESTRUCTIVE_KINDS`** (`ops-verb-scope.ts`) — is still
   `forbiddenOpsVerbProblems`'s DEFAULT parameter value
   (`forbidden: ReadonlySet<string> = FORBIDDEN_OPS_DESTRUCTIVE_KINDS`). Deleting
   the constant breaks that default EXPRESSION at compile time — a real signal, but
   an implementer under time pressure could "fix" it by pasting in
   `generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS)` as the new
   default WITHOUT registering that this silently changes every OTHER caller of
   `forbiddenOpsVerbProblems` that does not pass an explicit `forbidden` argument
   (any test or future call site that relies on the bare default). **Required T26
   action:** either (a) make `forbidden` a REQUIRED parameter (no default at all —
   forces every call site to state its intent explicitly, the safer option), or
   (b) flip the default to the generated set as a DELIBERATE, reviewed decision,
   not an incidental fix. Either way, `opsPlaneDriftProblems`'s own default (when
   `forbiddenOpsKinds` is omitted) must also be re-derived from the generator at
   that point — its current default-through-`forbiddenOpsVerbProblems`'s-default
   chain is the same landmine one level up.
2. **`PACK_REGISTERED_INTENT_KINDS`** (`kernel-bootstrap.ts`) — depends on
   `KNOWN_INTENT_KINDS` (`@ibatexas/intent-kinds`), which T26 also deletes. Its
   deletion is gated by the info-log dependency THIS review fix restored
   (`packRegisteredCount: PACK_REGISTERED_INTENT_KINDS.size` — the hand-authored
   count, logged alongside `generatedPackRegisteredCount`). **Required T26
   sequence:** (a) decide the log's final shape first — drop the hand-authored
   `packRegisteredCount` field, or collapse to a single field once there is only
   one source of truth — THEN (b) delete `PACK_REGISTERED_INTENT_KINDS` itself.
   Deleting step (b) before resolving (a) reproduces this exact review's BLOCKER
   (an orphaned `const` → `no-unused-vars` lint failure).

## Forced-mismatch evidence (AC: "observe each repointed gate fail-closed at boot")

- **Gate 1 (`assertPackCoverage`)** —
  `apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts`, describe block
  `"FE-T25 — assertPackCoverage's generated walked-set repoint"`: an incomplete
  7-pack roster (pack-payments omitted — a real DI mismatch, not a synthetic toy)
  probed against the GENERATED walked set still throws `PackCoverageError`, with
  a positive control (`payment.pix.regenerate` appears in `missingKinds`) proving
  the failure is real, not vacuous. A SECOND test omits the installed PIX pack
  itself and confirms a `pix.charge.*` kind appears in `missingKinds` — the
  positive-control evidence backing MINOR-2's "roster-removal still caught" claim
  above.
- **Gate 4b (`opsPlaneDriftProblems`'s forbidden-verb check)** —
  `apps/api/src/ops/__tests__/ops-boundary-generator-freshness.test.ts`, describe
  block `"FE-T25 — the FULL opsPlaneDriftProblems gate, repointed to the GENERATED
  forbidden set"`: a synthetic `order.cancel` ops tool injected into the real
  8-verb registry, probed through the FULL `opsPlaneDriftProblems` function (not
  just the extracted `forbiddenOpsVerbProblems` helper) with `forbiddenOpsKinds`
  set to the GENERATED projection, still flags `"FORBIDDEN"` + `"order.cancel"`.
  A third test in the same block confirms omitting `forbiddenOpsKinds` entirely
  preserves the pre-FE-T25 (hand-authored-default) behavior byte-for-byte.
- **Gate 2b (`chatSurfacedKinds`, already repointed FE-T22)** —
  `apps/api/src/__tests__/tool-roster-integrity.test.ts`, test `"a synthetic
  planner-advertised-but-unregistered kind under authed-customer FAILS drift,
  EVEN WITH the production chatSurfacedKinds wired in"`: re-verified still
  passing as part of this ticket's audit — no new test needed, this ticket did
  not touch that leg's code.

## Test counts (post-repoint, this ticket)

- `apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts`: 19/19 (15 pre-existing
  + 4 new, incl. the pix positive-control test added in review).
- `apps/api/src/ops/__tests__/ops-boundary-generator-freshness.test.ts`: 7/7 (4
  pre-existing FE-T24 + 3 new).
- `apps/api/src/__tests__/tool-roster-integrity.test.ts`: 31/31 (unchanged, re-run
  as part of this audit).
- Full affected-suite run (boot suites, `ops-conductor`, `ops-drift-parity`,
  `ops-forbidden-destructive-drift`, `chat-drivable-roster-drift`, `packages/
  packs-composed`, full `apps/api`): see FE-T25's PR body for the complete count
  table.
