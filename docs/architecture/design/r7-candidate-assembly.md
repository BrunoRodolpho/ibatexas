# R7 — candidate assembly: REFUSED (relocation, not concentration)

**Status: CLOSED — refused on measured evidence. Do not re-propose without new evidence
against the bar in the last section.**

The architecture review's recommendation R7 proposed ONE candidate-assembly module in the
claim planner, on the grounds that the registry's 3-class subject taxonomy is dispositioned
in several places. The review's own adversarial verifier downgraded it to *worth-exploring*,
observing that the assemblers are deliberately DIFFERENT disposition policies over a taxonomy
whose predicates are already shared. This document records the measurements that settled it,
and what shipped instead.

## The taxonomy, and where it is dispositioned

The 3-class partition is computed from the registry, not hand-maintained: a type is
OWNER-SCOPED if `ownerScopedBaseKey` is defined, PUBLIC PER-ITEM if `publicPerItemBaseKey`
is (documented as the complement of the first over the `perResourceKey` types), and
FIXED-SUBJECT otherwise. Measured against the current registry — **23 types: 7 owner-scoped,
4 public per-item, 12 fixed-subject.**

| # | Site | Location | Does it branch on the taxonomy? |
|---|------|----------|--------------------------------|
| 1 | `buildClassifyOnlyCandidates` | `apps/api/src/claustrum/classify-only-reads.ts` :498-605 | Yes — all three classes |
| 2 | `deriveUnionSubject` + `unionRequiredCandidates` | `apps/api/src/claustrum/ibatexas-claim-planner.ts` :317-332, :360-395 | Yes — all three classes |
| 3 | `synthesizeSafeTerminalCandidates` | `apps/api/src/claustrum/ibatexas-claim-planner.ts` :243-268 | **No** — uniform `subject = principal`, no class branch at all |
| 4 | in-planner FIX 1 (actor) + FIX 2 (subject) | `apps/api/src/claustrum/ibatexas-planner.ts` :2274-2343 | Partly — owner-scoped as a class, public per-item **per TYPE** |

## Phase A measurements

### 1. The premise still holds structurally

No commit since the review baseline (`c21d907f`, 11 commits back) has touched any of
`classify-only-reads.ts`, `ibatexas-claim-planner.ts`, or `ibatexas-planner.ts`. The R2
claimdef adoption changed the registry's SOURCE (specs now compile from `.claim.ts`
claimdefs) but not the values the two predicates read, so the parity surface is unchanged.

### 2. The incident-shape test: taxonomy changes DO land in one home at a time

Nine commits touched exactly TWO of the three files; **none touched all three.** The pattern
is consistent — a taxonomy fact lands wherever the ticket happened to be working:

- BKL-289 (`856e8823`) added site 2 **alone** — the motivating incident, a third assembler
  added because no shared seam existed.
- BKL-142 (`8ce3b55a`) added site 4's menu-item subject branches **alone**; BKL-183
  (`1551fde1`) taught sites 1+2 the same fact in a **separate** commit.
- BKL-203 (`b72e30c7`) added site 1's named-owned-order resolution **alone**.
- BKL-214 (`060da19d`) added `MENU_DIETARY` to site 1 and gave site 4 a VALUE deriver — but
  **no site-4 SUBJECT branch.**

So the multi-home audit confirms the review's motivating observation. What it does **not**
show is that a merged module would have prevented any of it — see the next two sections.

### 3. The deletion test: the merge relocates, it does not concentrate

Measured per class, against the live registry:

- **FIXED-SUBJECT (12 of 23 types) — nothing to concentrate.** The three sites use three
  different placeholders (site 1 `""`, sites 2/3 the authenticated principal, site 4 the
  model's string verbatim). Measured: for every fixed-subject type, all three produce
  **byte-identical evidence and valueBinding keys**, because the spec is never
  `:{subject}`-parameterized. The differences are cosmetic; a shared module would unify three
  spellings of one no-op.
- **PUBLIC PER-ITEM (4 of 23) — already shared.** Sites 1 and 2 share both predicates AND the
  "exactly one present ledger id" rule; site 2 literally calls site 1's `presentPublicItemIds`.
  What differs is DISPOSITION: on ≥2 present ids site 1 forces `CLARIFY`, site 2 silently
  declines. That difference is deliberate and documented (the union must never force a
  terminal).
- **OWNER-SCOPED (7 of 23) — three deliberately different policies.** Site 1 drops and
  CLARIFYs; site 2 declines the class outright by design; site 4 preserves a model-supplied id
  so the kernel's owns-check can REFUSE it. Each has a documented justification tied to what
  its caller can do.
- **Site 3 does not participate.** It is taxonomy-blind. Folding it in would ADD a branch that
  does not exist today.
- **Site 4 structurally cannot participate.** `ClaimAwarePlannerPort.proposeClaims(state, auth)`
  receives **no `EvidenceLedger`** — which is precisely why it re-derives public per-item
  subjects from the request text with the shared resolvers instead of reading the ledger.
  Joining it to a ledger-based module is not a refactor; it is a port-signature change.

Net: the discriminated-mode module would concentrate the ~4-line class dispatch across TWO
sites, and relocate three genuinely different disposition policies behind one door — with a
three-branch mode switch to tell them apart. That is the verifier's call, confirmed.

### 4. The parity-by-comment hazard is real, and was the finding's live half

`buildClassifyOnlyCandidates`'s doc comment asserts it "Mirrors `ibatexas-planner.ts`'s FIX 1
(actor) + FIX 2 (subject) resolution EXACTLY, minus the 'honor the model's subject' branch".
That contract was stated ONLY in that comment and pinned by **no test**:
`fe-t18-classify-only-reads.test.ts` drives the classify-only route with a COUNTING SPY in
place of `proposeClaims` (it asserts the model call was or was not made, never what the model
route would have derived), and `tracka-fix-actor-subject.test.ts` drives the model route alone.

Driving both REAL routes on identical inputs found the comment is **already stale, in two
places** (both measured, both now pinned):

- **Divergence 1 — a NAMED owned order.** Customer owns 2 orders and says "e o pedido 933869,
  como está?". Classify-only binds `order-A1` via BKL-203's display-number resolution; the
  model route emits no candidate and forces `CLARIFY`, because the model can only ever emit the
  display number it read in the text and `owned.includes("933869")` is false. Same utterance,
  same auth, same ledger — answered on one route, deflected on the other. Fail-SAFE (an ask,
  never a wrong order), but it is the dead-end BKL-203 exists to fix, still live on the model
  route.
- **Divergence 2 — `MENU_DIETARY`'s subject.** It is public per-item, so sites 1 and 2 derive
  its subject from the ledger (`presentPublicItemIds` — the investigator names the admissible
  item, never the model). Site 4 has branches for the other three public per-item types and
  **none** for `MENU_DIETARY`, so the model's string passes through verbatim and keys
  `menu:dietary:{whatever-the-4b-said}`. Fail-SAFE (an unrecognised tag parameterizes a key
  nothing recorded → ABSENT → honest UNKNOWN; the ledger still gates every validation), but it
  is the one public per-item type whose model-route subject is model-authored.

Critically for the disposition: **a merged module would have prevented neither.** Divergence 1
is a disposition policy — exactly the thing R7's corrected shape keeps visible and different.
Divergence 2 could not be fixed by sharing a classifier, because site 4 has no ledger to
classify against. The live drift is a PARITY problem, not a CONCENTRATION problem, so the
parity pin is the closure that actually fits it.

## Disposition

**R7 REFUSED as a merge.** Shipped instead: the narrow parity pin the finding's sharpest half
warranted — `apps/api/src/claustrum/__tests__/r7-cross-path-subject-parity.test.ts` (11 tests),
which drives both real routes on identical inputs and:

1. pins the 3-class partition as total and disjoint, and pins the PUBLIC-PER-ITEM membership
   (the class coupled to a per-type site-4 branch, so a new member surfaces here);
2. asserts owner-scoped subject parity across both routes where the contract holds (1 owned,
   0 owned, ≥2 owned);
3. CHARACTERIZES both divergences above, so neither can widen silently — and so that closing
   either turns the test RED, forcing this record to be updated with it.

`classify-only-reads.ts`'s "Mirrors … EXACTLY" comment was corrected in the same change to
state what is actually true and to point here; leaving a comment that asserts a parity the
code does not have is worse than the gap it hides.

## Recorded residuals (neither fixed here — each needs its own ticket)

| # | Residual | Severity | Why not fixed under R7 |
|---|----------|----------|------------------------|
| 1 | BKL-203's named-owned-order resolution exists only on the classify-only route | Low — fail-safe (a CLARIFY, never a wrong order), but a real dead-end for a multi-order customer on any turn that falls to the model route | A behavior change on the model path, out of a refactor-assessment's remit. Site 4 already has the ledger-free inputs it would need (`auth.ownedByBaseKey` + the text), so this is tractable without the port change residual 2 needs. |
| 2 | `MENU_DIETARY` has no in-planner subject branch | Low — fail-safe (absent key → honest UNKNOWN) | Same remit boundary. The uniform fix (route site 4's public per-item class through the ledger like sites 1/2) requires widening `proposeClaims` to accept the `EvidenceLedger`; the narrow fix (add a `detectDietaryPreferenceTags`-based branch beside the other three) does not, and is the smaller step. |

## The bar for re-proposing a merged assembler

R7 should be re-opened only on evidence that defeats the specific measurements above:

- a taxonomy change that must land in **three or more** of the four sites at once (the audit
  found the ceiling is two, and never the same two);
- OR `proposeClaims` gaining an `EvidenceLedger` for independent reasons — which removes the
  structural blocker and makes sites 1, 2 and 4 genuinely mergeable on the public per-item class;
- OR the FIXED-SUBJECT class ceasing to be key-irrelevant (i.e. a fixed-subject spec becoming
  `:{subject}`-parameterized), which would turn today's three cosmetic placeholder spellings
  into three real behaviors that must agree.

Absent one of those, the merge moves code without removing a decision, and the parity risk it
was reaching for is covered by the pin above.
