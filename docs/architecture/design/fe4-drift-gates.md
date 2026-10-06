# FE-4 drift-gate classification (FE-4.3 / FE-T25 / FE-T26 CONTRACT)

FE-4's consolidation (originally specified in `IBX_LANGUAGE_ENGINE_SPEC.md` §"FE-4 —
Capability metadata consolidation" — that spec doc was lost from disk 2026-07-21 and is
not reconstituted; surviving authority = the FE rows in `~/projects/ibx-master-tracker.yaml`
plus this file, per the tracker's header note) replaces ~16 hand-maintained lists with generators derived
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

---

# FE-T26 — CONTRACT: the deletion inventory

FE-T25 left every hand-maintained list ALIVE, with production reading the
generated projection alongside it (drift gates repointed, hand list kept for
its OWN load-bearing dependents — a default parameter value, a log field).
FE-T26 is the final CONTRACT step: for each of the ~16 mirrors FE-T19's
original inventory found, either (a) DELETE the hand list outright (its data
now lives solely in `CapabilityDefinition` + a generator), (b) CONVERT it to a
machine-written region of a still-committed file (the intent-kinds family —
see the codegen-to-committed-file design below), or (c) KEEP it, with the
rationale recorded here per team-lead's explicit rulings. Nothing in this
table was decided unilaterally — each disposition below is either a direct
instruction from the FE-T26 dispatch or the follow-up ruling message that
resolved this ticket's own research-fork inventory.

## Deletion inventory

| # | Constant / list | Location | Disposition | Where the data lives now | Why |
|---|------------------|----------|-------------|---------------------------|-----|
| 1 | `KNOWN_INTENT_KINDS` + 6 per-pack `*_INTENT_KINDS` arrays (`ORDER_INTENT_KINDS`, `PAYMENT_INTENT_KINDS`, `RESERVATION_INTENT_KINDS`, `WHATSAPP_INTENT_KINDS`, `CUSTOMER_ONBOARDING_INTENT_KINDS`, `OPS_INTENT_KINDS`) | `packages/intent-kinds/src/index.ts` | **CONVERTED — codegen-to-committed-file** | Machine-written region of the same file, between `GENERATED_BEGIN`/`GENERATED_END` markers, regenerated from `CAPABILITY_DEFINITIONS` by `packages/packs-composed/scripts/regenerate-intent-kinds.ts` | See the dedicated design section below — full deletion was not possible without either a turbo build-graph cycle or breaking the 12+ leaf-package consumers that import these as static, `satisfies`-checked arrays. |
| 2 | `PIX_INTENT_KINDS`, `LOYALTY_INTENT_KINDS` | `packages/intent-kinds/src/index.ts` | **KEPT — genuine external input** | Unchanged, hand-authored, now positioned OUTSIDE the generated region (verified by a dedicated freshness-test assertion) | Not a mirror of anything in `CapabilityDefinition` — pix/loyalty are external-package concerns (`@adjudicate/pack-payments-pix` types, a loyalty concept with no first-party Pack yet) that `generatePackIntents`/`generateKnownIntentKinds` take as explicit INPUT parameters, never derive. |
| 3 | `CHAT_DRIVABLE_TOOL_KINDS` | `packages/packs-composed/src/index.ts` | **DELETED — mechanical repoint, same export name** | `generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)`, called at module scope, assigned to the same export identifier | Ruling: "delete-mechanical (in-place swap to the generator inside packs-composed, same export name) — approved." All 12+ consumers import the export by name; none needed to change. |
| 4 | `IBATEXAS_CAPABILITY_DESCRIPTIONS` | `apps/api/src/tools/register-ibatexas-tool-packs.ts` | **DELETED — mechanical repoint** | `generateCapabilityDescriptions(CAPABILITY_DEFINITIONS)` | Ruling: "delete-mechanical repoint — approved." The per-tool inline `description` literals inside each `makeTool({...})` call are UNCHANGED (kept — see note below); this map was always a SEPARATE derived index keyed by capability, not the tools' own source of truth. |
| 5 | `FORBIDDEN_OPS_DESTRUCTIVE_KINDS` | `apps/api/src/ops/ops-verb-scope.ts` | **DELETED** | `CapabilityDefinition.opsForbiddenDestructive: true` (3 kinds), projected by `generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS)` | Per this ticket's own FE-T25-recorded contract sequence: `forbiddenOpsVerbProblems`'s `forbidden` parameter flipped from defaulted-to-this-constant to REQUIRED (no default), eliminating the constant's last load-bearing use. Every call site now states its source explicitly. |
| 6 | The old `PACK_REGISTERED_INTENT_KINDS` derivation (`[...KNOWN_INTENT_KINDS].filter(...)`) | `apps/api/src/plugins/kernel-bootstrap.ts` | **DELETED** (the export name `PACK_REGISTERED_INTENT_KINDS` survives, renamed from the generated variable) | `generateKnownIntentKinds(CAPABILITY_DEFINITIONS, {pixIntentKinds: paymentsPixPack.intents, loyaltyIntentKinds: [...LOYALTY_INTENT_KINDS]})`, filtered to exclude loyalty | Per this ticket's own FE-T25-recorded contract sequence: the dual-log (`packRegisteredCount` + `generatedPackRegisteredCount`) collapses to a single field now that there is one source; `assertPackCoverage`'s real boot call takes the sole derivation directly. |
| 7 | Per-pack `*_TOOL_TO_INTENT` maps (`ORDER_TOOL_TO_INTENT`, `PAYMENT_TOOL_TO_INTENT`, `RESERVATION_TOOL_TO_INTENT`, `CUSTOMER_ONBOARDING_TOOL_TO_INTENT`, `WHATSAPP_TOOL_TO_INTENT`) + each pack's `MUTATING` tool-name sets | Each pack's own `packages/pack-*/src/capabilities.ts` | **KEPT — pack-owned ROOT SOURCE, not a dying mirror** | Unchanged; `CapabilityDefinition.legacyNames` is generated FROM these (`generate-mutating-tool-names.ts`, `generate-tool-to-intent-map.ts`), the checked mirror, not the other way around | Ruling: "KEEP as pack-owned ROOT SOURCES (they're the pack's own declaration, not dying mirrors; the registry is the checked mirror of the packs for this data — record this source-direction acknowledgment in the doc)." This is the one family in the whole FE-4 sweep where the DIRECTION is inverted from the rest: `CapabilityDefinition` is the downstream, freshness-tested copy, and each pack's own file is upstream. |
| 8 | `policy-manifest-export.ts`'s direct imports of the same five `*_TOOL_TO_INTENT` maps | `apps/api/src/claustrum/policy-manifest-export.ts` | **KEPT — left unchanged, not repointed** | N/A — reads each pack's own live export directly | Ruling: "Repoint the external policy-manifest-export.ts consumer only if it's clean; otherwise leave." Traced in full: this file's entire purpose (per its own doc comment) is producing a `PolicyManifest` for the operator console "so the manifest cannot drift from production" — it deliberately reads each pack's OWN live export, the strongest possible source for a diagnostic artifact whose whole point is zero-drift-from-production. Repointing through `CapabilityDefinition` (itself already one hop removed, per item 7's source-direction) would add an indirection and WEAKEN that guarantee for no benefit — item 7's mirror is exactly as fresh as the pack, but "exactly as fresh as" is not "is." Left unchanged. |
| 9 | Planner `allowedIntents` literals (all 6 packs' `capabilities.ts` + the 3 ops-foreign-advertised constants) | Each pack's `capabilities.ts` | **KEPT** | `CapabilityDefinition.plannerAdvertisedBy` is generated FROM these (`generate-planner-allowed-intents.ts`), never the reverse | Ruling: "KEEP (P5 business logic; runtime-materialization freshness stays the honesty floor)." Per-state advertisement gating is business logic (FE-4.1/P5 — "guards IMPLEMENT policy, metadata DESCRIBES capabilities"); modeling it as data here would be the exact fabrication P5 forbids. |
| 10 | `refusalCodes` (each pack's `refusals.ts`) / `SUCCESS_CLAIM_CLASSES` (`ibatexas-responder.ts`) | Each pack + `apps/api/src/claustrum/ibatexas-responder.ts` | **KEPT — never mirrors** | Unchanged | Ruling: "KEEP (never mirrors) — no action." `CapabilityDefinition.refusalCode`/`successClaimLinks` are one-way REFERENCES into these registries (a pointer, not a duplicate value-for-value copy), so there was never a hand-list/generated-projection pair here to consolidate. |
| 11 | `INTENT_KIND_LABELS` | `apps/admin/src/domains/admin/agent-approvals.mappers.ts` | **KEPT — documented permanent mirror** | Unchanged; `generate-admin-labels.ts` + `apps/admin/src/domains/admin/__tests__/agent-approvals.admin-label-freshness.test.ts` (both pre-existing, from the FE-T2x MIGRATE step) keep it byte-identical to the generated projection | Ruling: "KEEP as documented permanent mirror (devDependency bundle constraint) — record the decision." `apps/admin` can only depend on `@ibatexas/packs-composed` as a `devDependency` (a runtime import would pull server-side composition code into the admin browser bundle), so the hand map is the only shippable production source; the freshness test is the honesty floor, permanently, not a MIGRATE-phase stopgap. |
| 12 | `READ_ONLY` tool sets (each pack's read-tool registries) | Various | **OUT OF SCOPE — never modeled** | N/A | `CapabilityDefinition` models `mutating` capabilities only (`types.ts`: "all 66 first-party kinds route through `adjudicate()`... a future non-mutating capability... needs somewhere to say `false`" — aspirational, not yet used). READ tools never had a hand-list/generated pair to consolidate. |
| 13 | `WA_EXCLUDED_OPS_KINDS` | `apps/api/src/ops/ops-verb-scope.ts` | **OUT OF SCOPE — genuine business policy** | N/A | Already found and documented by FE-T24: a narrow reversibility judgment (which specific irreversible money verb needs WhatsApp-ingress step-up), not structural registry data. Re-confirmed during this ticket's inventory pass — no change. |
| 14 | `OPS_READ_RENDER_TEMPLATE_KEYS` | `apps/api/src/ops/ops-conductor.ts` (consumer) | **OUT OF SCOPE — render-template territory** | N/A | Confirmed in FE-T25's own classification table (gate 4c) as outside the FE-4 family entirely — no `CapabilityDefinition` field models render templates. |
| 15 | The docs file (`docs/architecture/design/agent-tools.md`) | `docs/` | **OUT OF SCOPE — FE-D16** | N/A | Human-maintained reference documentation, never machine-consumed; FE-D16 explicitly excludes it from the generator family. |
| 16 | `ADVERTISED_NOT_REGISTERED_WHITELIST` | (formerly `apps/api/src/tools/register-ibatexas-tool-packs.ts`) | **Already ELIMINATED — FE-T22** | `CapabilityDefinition.surfaces` data | Recorded in `types.ts`'s own module doc; listed here only for inventory completeness — no action needed in this ticket. |

## Note on the kept inline tool `description` literals

`apps/api/src/tools/register-ibatexas-tool-packs.ts`'s `makeTool({...,
description: "..."})` calls each still carry their own inline pt-BR
description literal, now DECOUPLED from `IBATEXAS_CAPABILITY_DESCRIPTIONS`
(item 4). Verified via grep across `apps/api` that nothing in this repo's own
code reads `.description` off a constructed `ToolDefinition` besides the now-
generated map — the inline literals exist because `@claustrum/core`'s
`ToolDefinition` type may consume `description` internally (LLM tool-schema
presentation). Left untouched; out of this ticket's mandate (repointing
CONSUMERS of a hand list, not auditing every literal that happens to share a
string value with one).

## Codegen-to-committed-file: the intent-kinds family

Team-lead's ruling for item 1, verbatim: *"A regen script (ibx-invocable + plain
node script, your call) WRITES the generated sections of
`packages/intent-kinds/src/index.ts` from `CAPABILITY_DEFINITIONS` (+ the
external pix/loyalty literal inputs, which stay), under a clear
DO-NOT-EDIT-GENERATED banner; a CI freshness gate asserts the committed file
matches regeneration BYTE-FOR-BYTE... This preserves the leaf-package layering
(all 12+ infra consumers unchanged — no packs-composed dependency inversion),
preserves the `satisfies` compile-time exhaustiveness guards (they live IN the
generated output, still compiler-checked), and makes a stale hand-edit
impossible."

**Why not a full deletion (generator called at consumer import-time
instead)?** `@ibatexas/intent-kinds` is a LEAF package — 12+ packages across
the monorepo import its exported `*_INTENT_KINDS` arrays and `KNOWN_INTENT_KINDS`
as plain static values, several inside `satisfies readonly XIntentKind[]`
clauses that need a literal array type, not a function-call return value typed
`ReadonlySet<string>`. Making `@ibatexas/intent-kinds` import
`@ibatexas/packs-composed` (which is a HIGH-level, composed package — it
imports every first-party Pack) to call the generator at runtime would invert
the leaf/composed layering the whole monorepo relies on, and — concretely,
discovered during implementation — creates a real **turbo build-graph cycle**:
`packages/packs-composed/package.json` already carries `@ibatexas/intent-kinds`
as a devDependency (for its OWN freshness tests), so adding the reverse edge
makes `pnpm turbo run build` fail with `Cyclic dependency detected:
@ibatexas/intent-kinds#build, @ibatexas/packs-composed#build` (turbo's task
graph does not distinguish `dependencies` from `devDependencies`).

**The chosen design:**
- `packages/packs-composed/src/codegen/build-generated-region.ts` — a pure
  function, `buildGeneratedRegion(): string`, building the 6 per-pack
  `*_INTENT_KINDS` arrays + `KNOWN_INTENT_KINDS` as literal TypeScript source
  text, from `CAPABILITY_DEFINITIONS` + `generatePackIntents`.
- `packages/packs-composed/scripts/regenerate-intent-kinds.ts` — a `tsx`-
  invocable CLI script (`pnpm --filter @ibatexas/packs-composed run
  regen:intent-kinds`) that reads `../../intent-kinds/src/index.ts` via a
  plain relative FILESYSTEM path (never a package import), splices the fresh
  `buildGeneratedRegion()` output between the committed `GENERATED_BEGIN`/
  `GENERATED_END` markers, and writes the file back. Idempotent — a no-op
  regen logs "already up to date" and produces a zero-diff write.
  **R6 legs 1a + 1b extended this same script to THIRTEEN target files** — it
  now also splices each of the six packs' own `xxxPack.intents` arrays (leg 1a,
  family member 3) and each pack's own kind TYPE UNION in `src/types.ts` (leg
  1b) — both below. One command, one marker pair, one CI gate per target group.
- `packages/packs-composed/src/__tests__/regen-intent-kinds-freshness.test.ts`
  — the CI freshness gate: (1) the committed `GENERATED_BEGIN`..`GENERATED_END`
  region is byte-identical to a fresh in-memory `buildGeneratedRegion()` call,
  (2) both markers appear exactly once, (3) `PIX_INTENT_KINDS`/
  `LOYALTY_INTENT_KINDS` are declared OUTSIDE the generated region (the
  external-input boundary stays enforced, not just documented in a comment).
- `@ibatexas/intent-kinds`'s own `package.json` gained ZERO new dependency
  edges — the file this system writes to is reached purely by filesystem path
  from the tooling package, so the leaf package's dependency graph, its
  `satisfies` exhaustiveness checks (now checking machine-generated array
  content, verified during the throwaway-capability proof below to still
  catch a genuinely-invalid kind at compile time), and all 12+ consumers'
  static imports are completely unaffected by this ticket.

This is why item 1 is marked CONVERTED rather than DELETED in the inventory
above: the hand-maintained *authorship* of the six arrays + `KNOWN_INTENT_KINDS`
is gone (a human editing them directly now produces a byte-mismatch the
freshness gate catches at CI), but the committed file itself — and every
consumer's import path — is unchanged, per the explicit design goal of "makes
a stale hand-edit impossible" without an "expect wide but mechanical diffs"
across 12+ leaf-package consumer files that a full deletion-and-inline-call
approach would have forced.

## R6 leg 1a — the same region pattern applied to the packs' own `intents[]`

Family member 3 (each Pack's own `xxxPack.intents` literal) was, until R6 leg
1a, still hand-authored and guarded only by an array-equality freshness test:
adding a kind meant hand-editing a mirror a generator could write. It is now a
GENERATED region in each of the six `packages/pack-*/src/index.ts` files, using
the identical marker pair and the identical relative-filesystem-path,
no-new-dependency-edge design proved above — the packs gain no dependency on
`@ibatexas/packs-composed`; markers are comments and generation is offline.

- `packages/packs-composed/src/codegen/build-pack-intents-region.ts` —
  `buildPackIntentsRegion(target)`, plus `PACK_INTENTS_TARGETS` (the six packs)
  and the per-kind **annotations table**.
- `packages/packs-composed/src/__tests__/regen-pack-intents-freshness.test.ts`
  — the CI gate: byte-identity per pack, markers exactly once, plus STRUCTURAL
  bracket-adjacency assertions (the region begins immediately after
  `intents: [` and ends immediately before `],`), because the region is spliced
  inside a live object literal next to hand-maintained `basisCodes`/`policy`/
  `planner` members and byte-identity alone would not prove it still covers the
  right bytes.

Two findings worth carrying forward:

1. **"Structurally identical data" is not "identical source text."**
   `generate-pack-intent-kinds.ts`'s doc claim (verified byte-for-byte for the
   KIND LISTS) does not extend to the files' text: `pack-payments` carries a
   2-line BKL-176 note explaining an ABSENCE, and `pack-ops` carries FOUR notes
   genuinely INTERLEAVED between elements (NEW-004, SCN-114, BKL-088, SCN-127).
   None of that text exists in `CAPABILITY_DEFINITIONS`, so a generator emitting
   bare `"kind",` lines would have silently DELETED five blocks of rationale.
   They live in the annotations table now, and the gate asserts each note is
   still attached to its own kind — position, not mere presence.
2. **The array-equality test in `capability-definitions.intent-identity-family.test.ts`
   is KEPT, not superseded.** It reads the RUNTIME-LOADED `xxxPack.intents`
   value; the new gate reads committed SOURCE TEXT. Measured during the
   revert-to-red proof: corrupting a kind in `pack-orders/src/index.ts` left the
   runtime test GREEN (it resolves `@ibatexas/pack-orders` to `dist/`, which was
   stale) while the source-text gate went red. The complement holds in reverse —
   a `dist` that disagrees with the registry fails the runtime test and is
   invisible to the source-text one. Neither gate subsumes the other.

## R6 leg 1b — the same region pattern applied to the packs' kind TYPE UNIONS

The last hand mirror of the intent-identity family: each pack's own
`OrderIntentKind`/`ReservationIntentKind`/… union in
`packages/pack-*/src/types.ts`. It was the EXPENSIVE one — `intent-kinds/src/index.ts`
closes each of its six generated arrays with
`as const satisfies readonly OrderIntentKind[]`, so a union that had not been
hand-updated broke the workspace build (TS2820). Adding a capability was a data
edit in `definitions.ts` PLUS a hand edit in a second package purely to stop the
compiler complaining. Now it is the data edit and a regen. Same marker pair,
same relative-filesystem-path/no-new-dependency-edge design; the six unions
bring `regenerate-intent-kinds.ts` to **thirteen** target files under one
command.

- `packages/packs-composed/src/codegen/annotated-member-region.ts` —
  `renderAnnotatedMemberRegion()`, extracted from leg 1a: the ONE definition of
  "a GENERATED region that is a list of per-kind members, some carrying
  hand-written rationale comments". Both `buildPackIntentsRegion` and
  `buildPackKindUnionRegion` call it, so the two family members cannot drift in
  comment handling. The extraction is byte-safe by construction, not by
  inspection — leg 1a's gate diffs the committed arrays against the refactored
  builder's output, and the first regen after the extraction was a 13-file no-op.
- `packages/packs-composed/src/codegen/build-pack-kind-union-region.ts` —
  `buildPackKindUnionRegion(target)`, `PACK_KIND_UNION_TARGETS`, and the
  union-side annotations table.
- `packages/packs-composed/src/__tests__/regen-pack-unions-freshness.test.ts`
  — the CI gate (24 tests): byte-identity per pack, markers exactly once, plus
  STRUCTURAL declaration/tail assertions.

Three findings worth carrying forward:

1. **Derivability was CHECKED, not assumed.** A union could legitimately have
   outlived the definitions — `pack-payments`' own BKL-176 note documents 5
   RETIRED `payment.charge.*` kinds — and absorbing such a member into a
   generated region would DELETE it on the next regen: a type-level regression
   dressed up as codegen. Measured against the real projection first: all six
   unions are exactly `generatePackIntents(CAPABILITY_DEFINITIONS, pack)`, same
   members, same order, 62 total, **zero union-only members in any pack** (the
   retired `payment.charge.*` kinds are absent from the unions too). Nothing was
   absorbed, and the finding is now an executable test case rather than a claim
   in a comment.
2. **The annotations table is per FAMILY MEMBER, not per kind.** Leg 1a found
   five rationale blocks inside the `intents[]` arrays (payments' BKL-176, ops'
   four). The unions carry rationale too — and it is DIFFERENT rationale in a
   DIFFERENT pack: `pack-whatsapp`'s union carries two interleaved blocks (W5-6
   on `conversation.message.append`, F5/L3/BKL-030 on
   `whatsapp.handoff.request`, 8 lines) that appear in neither
   `CAPABILITY_DEFINITIONS` nor `pack-whatsapp/src/index.ts`, while the packs
   whose arrays carry notes carry NONE inside their unions. Note text is a
   property of the (FILE, kind) pair. One table keyed by kind alone would have
   invented committed bytes in one direction or the other, so there are two
   tables behind one renderer.
3. **A union has no closing token, so the tail needs two pins.** Leg 1a could
   lean on `],`; a union ends where its members stop. "END marker followed by a
   blank line" alone leaves a real hole — blank lines are whitespace to
   TypeScript, so a member hand-added BELOW the blank line is still part of the
   type and the gate would stay green. The gate therefore also asserts the first
   non-blank line after the region does not continue the union with another `|`.

**The TS2820 compile-time leg is KEPT, and is genuinely complementary.** It
proves the TYPE the application compiles against; the source gate proves the
committed text is what the generator would write. Each sees what the other
cannot: markers and rationale comments are type-invisible (a corrupted marker or
a deleted note compiles perfectly), and conversely an ADDED union member
type-checks fine because `satisfies` only requires the array to be a SUBSET of
the union — a hand-widened union is invisible to `tsc` and caught only by the
source gate. Both directions are asserted in that file's last describe block.

## R6 leg 2 — the six capability-count literals become one pin

Six independently-written spellings of the registry's size, in four files across
three packages, none of them referring to the others:

| Site | Was | Now |
|---|---|---|
| `capability-definitions.intent-identity-family.test.ts` (×2) | `62`, `62` | `EXPECTED_CAPABILITY_COUNT` |
| `capability-definitions.tool-driving-family.test.ts` (×2) | `66`, `62` | `EXPECTED_CAPABILITY_COUNT (+ externals)` |
| `regen-pack-unions-freshness.test.ts` | `62` | `EXPECTED_CAPABILITY_COUNT` |
| `packages/cli/.../kernel.test.ts` | `66` | `EXPECTED_CAPABILITY_COUNT + externals` |
| `packages/journeys/src/gates/lint.ts` (comment) | "the full 66-kind union" | pointer, no number |
| `capability-definitions/index.ts` (doc) | "62 — 20 chat-tier, 42 identity-tier" | pointer, no number |

`EXPECTED_CAPABILITY_COUNT` lives in `definitions.ts`, immediately above
`CAPABILITY_DEFINITIONS`, and stays a **hand-written literal**. Writing
`= CAPABILITY_DEFINITIONS.length` would assert `x === x`: every gate reading it
would go green for any registry, including one a bad merge halved. The number
must be written by a human who intended it, so that changing the registry
*without* intending to change its size is what goes red.

Three things the consolidation surfaced, each of which is the argument for doing
it — every one had been sitting green:

1. **The six sites disagreed about what they pinned.** Four pinned the registry
   (62); two pinned the composed union (66 = 62 + the 4 external pix/loyalty
   kinds). Nothing said so, and the two families were being maintained as if
   they were the same number.
2. **Two carried stale prose.** `kernel.test.ts`'s history comment stopped at
   "63 → 65" while its literal said `66`, and its sibling case was *titled*
   "includes all 65 KNOWN_INTENT_KINDS" — a case that asserts membership and
   never a count, so nothing was ever going to catch it.
3. **`capability-definitions/index.ts` documented a tier split of "20 chat-tier,
   42 identity-tier"; the real split is 19/43.** That doc line has now gone
   stale three times (FE-T19/T20's "18 + 48", then the LE2 spec's ratified
   "59/20/39"). It is replaced by a pointer rather than a fourth number: a count
   nothing gates on rots.

The union's size is spelled as the arithmetic it is —
`EXPECTED_CAPABILITY_COUNT + PIX_INTENT_KINDS.length + LOYALTY_INTENT_KINDS.size`
— rather than as a second magic `66`. Deriving the *external* term is not the
self-reference trap the registry term avoids: those two sets are hand-authored in
`@ibatexas/intent-kinds` and are deliberately outside the catalog, so the
assertion still compares a generated union against something a human wrote.

**Measured tripwire behaviour** (add a 63rd capability, run
`regen:intent-kinds`, do not bump the pin): 4 count assertions go red across 3
files, every one of them reporting `63 to be 62` / `67 to be 66` against
`EXPECTED_CAPABILITY_COUNT`, and **one bump to that single line clears all four**
(packs-composed back to 187/187). Three further reds in the same simulation are
*not* count-pin failures and are correct to fire: `kernel.test.ts`'s
per-domain-prefix pins (`order (26)` → 27) and the `pack-bom` committed
governance baseline. Those per-domain counts are a genuinely separate pin family
— being per-prefix, they cannot read one registry-wide constant — and are left
hand-authored.

## R6 leg 3 — the audit-redactor PII classification is NOT projected (decided by measurement)

The review proposed a declared per-kind judgment slot so the redactor's PII
classification becomes a catalog projection. **It is not built, and must not be**,
for a reason that is measurable rather than stylistic.

`packages/audit-sink/src/audit-redactor.ts` classifies every kind into
`INTENT_KIND_FIELD_RULES` (40 keys) or `PII_FREE_KIND_ALLOWLIST` (46 entries).
Only the catalog-kind subset could ever be projected: **24 of those 86 entries
are non-catalog** and stay hand-declared regardless — 4 HTTP-plane `staff.*`
kinds, 13 `medusa.*` / 3 `stripe.*` / 1 `twilio.*` egress-wrapper kinds, 2
`validation.*` synthesised events, 3 `pix.*` and 1 `loyalty.*` external kinds.

**Why the projection is worse than the status quo.** The F-5 sentinel's whole
value is that it compares **two independently-authored artifacts**: the kind
union and the classification. `KNOWN_INTENT_KINDS` is *already* regenerated from
`CAPABILITY_DEFINITIONS`. Projecting the allowlist from the same source makes
both sides of that comparison projections of one input, and the gate becomes
analytically incapable of failing on a catalog kind. Simulated over the real
corpus — add a capability, run the regen, classify nothing:

| | conformance verdict |
|---|---|
| today (hand-declared allowlist) | **RED**, naming the unclassified kind |
| with the proposed projection | **GREEN** — the projection absorbed it |

A new capability would ship auto-declared "PII-free" with no human ever having
named its payload's PII surface. That is precisely the regression class F-5 is,
re-created at the root.

Two independent reasons point the same way. `CapabilityDefinition` models **no
payload shape at all** — the rule *values* are payload field paths (`body`,
`comment`, `lastMessage`, `note`, `otpToken`, `reason`, `specialRequests`,
`text`), so projecting them means inventing a payload-shape axis the codebase
does not otherwise model, which is the fabrication FE-4.1 forbids and which
`opsForbiddenDestructive`'s own doc cites as the reason `WA_EXCLUDED_OPS_KINDS`
was traced but not generated. And the allowlist's code-review-enforced "1-line
WHY comment naming the payload's PII surface" would follow the R6-S1/S2 pattern
into a generator-side annotations table — moving a security control's
justification *away* from both the control and the definition.

**The agreement gate the review offered as the fallback already exists and is
strictly stronger than a catalog-scoped one.**
`apps/api/src/__tests__/audit-2026-05-24/per-intent-redactor-conformance.test.ts`
already iterates `KNOWN_INTENT_KINDS ∪ HTTP_PLANE_GOVERNED_KINDS` (70 kinds, vs
the 62 a catalog-scoped gate would cover) and requires each to be classified.
Measured: deleting one catalog kind (`order.item.add`) from the allowlist turns
2 cases red, naming the kind, with a file:line pointer. All 62 catalog kinds are
classified today (21 ruled, 41 PII-free), and `catalog kinds ⊄ KNOWN_INTENT_KINDS`
is itself gated by the intent-identity family's set-equality test. No new gate was
added: a second assertion green-by-entailment would fail this doc's own standard
(leg 1a/1b kept two legs only because each catches a drift the other cannot).

`audit-sink` therefore gains **no dependency on `@ibatexas/catalog`** — which
matters independently: `audit-sink` is on the kernel path, consumed by `apps/api`
and by `@ibatexas/tools` (the widest-blast-radius package in the workspace).

## Tautological-gate retirements (FE-4.3's own named risk)

Two pre-existing freshness tests became vacuous once their target constant was
repointed to literally equal the generator's own output, and were explicitly
retired (never left silently green) with rationale recorded at the retirement
site:

1. **`packages/packs-composed/src/__tests__/capability-definitions.freshness.test.ts`**
   — two tests ("reproduces the committed hand list byte-for-byte", "covers
   exactly the hand list's cardinality") compared `generateChatDrivableToolKinds(...)`
   against the (formerly hand-typed, now `= generateChatDrivableToolKinds(...)`)
   `CHAT_DRIVABLE_TOOL_KINDS` import — after item 3's repoint this became
   `generateChatDrivableToolKinds(...) === generateChatDrivableToolKinds(...)`,
   an expression compared to itself. RETIRED with a comment pointing to the
   genuinely independent surviving check:
   `apps/api/src/__tests__/chat-drivable-roster-drift.test.ts`'s "T1a-2 — chat-
   drivable roster drift" block, which diffs `CHAT_DRIVABLE_TOOL_KINDS` against
   `listIbatexasToolPacks()` — the REAL, runtime-registered DI tool container,
   a genuinely different materialization. A new cardinality-only test (against
   the generator directly, no comparison) was added in its place so the file
   still exercises the generator's own shape. Net: 5 tests → 4 tests in this
   file, zero coverage lost (the retired comparisons' only remaining value —
   catching a hand-edit — is structurally impossible now that there is no hand
   list to edit).
2. **`apps/api/src/__tests__/chat-drivable-roster-drift.test.ts`** — the entire
   "FE-T21 — generateCapabilityDescriptions vs the real
   IBATEXAS_CAPABILITY_DESCRIPTIONS" describe block (2 tests) compared
   `generateCapabilityDescriptions(...)` against the (formerly hand-computed,
   now `= generateCapabilityDescriptions(...)`) map from item 4's repoint —
   same tautology class. RETIRED with a comment in place. The sibling "T1a-2"
   block in the SAME FILE (chat-drivable roster vs `listIbatexasToolPacks()`)
   is UNCHANGED and remains the file's genuine independent check — it was
   never comparing two views of the same generated data.
3. **`apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts`** — NOT a
   retirement, a REFRAME. Its "assertPackCoverage's generated walked-set
   repoint" block (from FE-T25) compared a direct `CAPABILITY_DEFINITIONS`→
   walked-set derivation against `PACK_REGISTERED_INTENT_KINDS` — at FE-T25
   time, `PACK_REGISTERED_INTENT_KINDS` was still hand-authored-via-
   `KNOWN_INTENT_KINDS`, so the comparison was genuinely hand-vs-generated.
   After item 6's deletion, `PACK_REGISTERED_INTENT_KINDS` is ITSELF now
   `generateKnownIntentKinds(...)`-derived — but critically, `KNOWN_INTENT_KINDS`
   is NOT deleted (item 1 converts it, doesn't remove it), so this test still
   compares two INDEPENDENT regeneration call sites: one direct
   (`generateKnownIntentKinds(CAPABILITY_DEFINITIONS, {...})` called fresh in
   the test) against one indirect (via the committed, regenerated
   `KNOWN_INTENT_KINDS` export, filtered by `kernel-bootstrap.ts`). Both trace
   back to the same ultimate source data, but through genuinely different code
   paths (one calls the generator function directly; the other reads a
   committed file that a SEPARATE script wrote by calling the same generator
   function at a different time) — this still catches a real class of bug (the
   two call sites' filter/compose logic diverging), so it was RENAMED (to "FE-4
   CONTRACT (FE-T26) — assertPackCoverage's sole (generated) source") and
   re-documented, not retired. The variable `handAuthoredPackRegistered` was
   renamed to `viaKnownIntentKinds` to stop asserting a now-false premise. The
   sibling "assertPackCoverage — real boot roster" block (testing directly
   against the real `KNOWN_INTENT_KINDS` export) is unchanged.

## Throwaway-capability proof transcript (AC: "a stale hand-edit is now impossible")

Demonstrated by construction — the lists no longer exist to hand-edit; a
synthetic capability was added via ONE data-only edit and its effect on every
live projection was directly observed, then fully reverted.

1. **Edit:** added a throwaway `order.throwaway.proof` identity-tier entry to
   `packages/packs-composed/src/capability-definitions/definitions.ts`
   (`{kind: "order.throwaway.proof", pack: "ibatexas/pack-orders", mutating:
   true, tier: "identity"}`) — the ONE place a new capability is now declared,
   per the ticket's own success criterion ("adding a capability becomes a
   one-place data edit").
2. **Freshness gate catches the drift (RED, before regen):** with the
   committed `packages/intent-kinds/src/index.ts` left un-regenerated, the
   freshness test (`regen-intent-kinds-freshness.test.ts`) FAILED — the
   committed `GENERATED_BEGIN..GENERATED_END` region no longer matched a fresh
   `buildGeneratedRegion()` call, which now included `order.throwaway.proof`
   in `ORDER_INTENT_KINDS`/`KNOWN_INTENT_KINDS`. This is the "stale hand-edit
   is now impossible" guarantee in action: the drift is caught even though no
   hand list exists — the COMMITTED FILE itself drifted from its declared
   generator.
3. **Regenerated (GREEN):** ran `pnpm --filter @ibatexas/packs-composed run
   regen:intent-kinds` — spliced the new entry into `packages/intent-kinds/src/index.ts`'s
   generated region; `git diff --stat` showed the expected single-line
   addition to `ORDER_INTENT_KINDS` + `KNOWN_INTENT_KINDS`; freshness test
   re-ran GREEN (3/3).
4. **Per-projection enumeration** (observed directly, via the generators
   called against the mutated `CAPABILITY_DEFINITIONS`):
   - **Included** (correctly, since the throwaway entry has `mutating: true`
     and `pack: "ibatexas/pack-orders"`): `ORDER_INTENT_KINDS`,
     `KNOWN_INTENT_KINDS` (via `generatePackIntents`/`generateKnownIntentKinds`).
   - **Excluded** (correctly, since the entry is `tier: "identity"`, not
     `"chat"`, and carries no `description`/`legacyNames`/`guardRefs`):
     `CHAT_DRIVABLE_TOOL_KINDS` (`generateChatDrivableToolKinds` filters on
     `tier === "chat"`), `IBATEXAS_CAPABILITY_DESCRIPTIONS` (no `description`
     field to project). Confirmed by direct node-script invocation of both
     generators against the mutated definitions array — the throwaway kind
     was absent from both outputs.
5. **Two-layer boot-time consequence** (a richer proof than originally
   planned — discovered mid-exercise): after regen, `pnpm --filter
   @ibatexas/intent-kinds run build` FAILED with a genuine `tsc` error:
   `Type '"order.throwaway.proof"' is not assignable to type
   'OrderIntentKind'` — the `satisfies readonly OrderIntentKind[]` clause on
   `ORDER_INTENT_KINDS` caught the synthetic kind at COMPILE TIME, proving the
   compile-time exhaustiveness guard still functions correctly on
   MACHINE-GENERATED array content, not just hand-typed content (team-lead's
   ruling explicitly named this as something to preserve). Separately —
   because `vitest`'s esbuild-based transform strips TypeScript types WITHOUT
   full type-checking, a genuine `tsc` compile error does not by itself block
   `vitest run` — the SAME source (not a `dist` build) was exercised at
   runtime to observe the independent, second failure layer:
   `assertPackCoverage(allPacks, PACK_REGISTERED_INTENT_KINDS)` throws
   `PackCoverageError` because no installed Pack's own `pack.intents[]`
   declares `order.throwaway.proof` — the walked/declared sets diverge by
   exactly one kind. (A real gotcha surfaced first: `apps/api`'s vitest run
   initially showed the boot test passing unexpectedly, traced to a STALE
   cached `dist/` build of `@ibatexas/intent-kinds` that predated the regen;
   explicitly rebuilding that package — which is what surfaced the
   `satisfies` compile error above — and re-running vitest against the fresh
   source correctly reproduced `PackCoverageError`.) Net: the synthetic
   capability fails closed at TWO independent layers — TypeScript's own
   compile-time typo-guard, AND the runtime boot check — neither depending on
   the other.
6. **Full revert, re-verified clean:** removed the throwaway entry from
   `definitions.ts`; rebuilt `packages/packs-composed` (clean); re-ran
   `regen:intent-kinds` (`git diff --stat` showed the region returning to its
   original FE-T26 content, throwaway line absent); rebuilt
   `@ibatexas/intent-kinds` (clean, no more `satisfies` error); freshness test
   3/3 green; `kernel-bootstrap.test.ts` 19/19 green (full recovery). Final
   check: `grep -c "throwaway" packages/packs-composed/src/capability-definitions/definitions.ts
   packages/intent-kinds/src/index.ts` → `0` and `0` — zero residue anywhere.

## Test counts (FE-T26, post-CONTRACT)

- `packages/packs-composed/src/__tests__/regen-intent-kinds-freshness.test.ts`
  (new): 3/3.
- `packages/packs-composed/src/__tests__/capability-definitions.freshness.test.ts`:
  4/4 (was 5 — 2 tautological retired, 1 cardinality test added).
- `apps/api/src/__tests__/chat-drivable-roster-drift.test.ts`: retired 2
  tautological tests from the FE-T21 describe block; surviving "T1a-2" block
  (4 tests) unchanged and green.
- `apps/api/src/ops/__tests__/ops-boundary-generator-freshness.test.ts`: 5/5
  (rewritten — 1 generator-projection test + 2 `forbiddenOpsVerbProblems`
  tests + 2 full-`opsPlaneDriftProblems` tests, replacing the retired
  byte-identical-to-deleted-constant comparisons).
- `apps/api/src/ops/__tests__/ops-drift-parity.test.ts`: 6/6 (all 5
  `opsPlaneDriftProblems` call sites updated with the now-required
  `forbiddenOpsKinds` argument).
- `apps/api/src/ops/__tests__/ops-forbidden-destructive-drift.test.ts`: 8/8
  (repointed from the deleted `FORBIDDEN_OPS_DESTRUCTIVE_KINDS` import to
  `generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS)`).
- `apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts`: 19/19 (unchanged
  count from FE-T25 — the one repointed block was reframed, not
  added-to/removed-from).
- Throwaway-capability proof: transcript above; full clean revert verified
  (zero grep residue).
- Full repo-wide `pnpm turbo run build` + `pnpm turbo run test`: see this
  ticket's PR body for the complete post-CONTRACT sweep.
