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
  **no site-4 SUBJECT branch.** (That branch landed later, as F-20 — one taxonomy fact, two
  commits, months apart: the audit's point, not a counter-example to it.)

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
  route. **CLOSED by F-19 — see "Residuals closed" below; the characterization is now a
  directional parity assertion.**
- **Divergence 2 — `MENU_DIETARY`'s subject.** It is public per-item, so sites 1 and 2 derive
  its subject from the ledger (`presentPublicItemIds` — the investigator names the admissible
  item, never the model). Site 4 has branches for the other three public per-item types and
  **none** for `MENU_DIETARY`, so the model's string passes through verbatim and keys
  `menu:dietary:{whatever-the-4b-said}`. Fail-SAFE (an unrecognised tag parameterizes a key
  nothing recorded → ABSENT → honest UNKNOWN; the ledger still gates every validation), but it
  is the one public per-item type whose model-route subject is model-authored. **CLOSED by
  F-20 — see "Residuals closed" below; the characterization is now a directional parity
  assertion.**

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

That third mechanism has since fired as designed, twice. **F-19** and **F-20** each turned a
characterization RED; both are now directional parity assertions and this record was updated
with them (see "Residuals closed"). The file no longer characterizes any divergence — what it
pins is the taxonomy, the class membership, and agreement.

`classify-only-reads.ts`'s "Mirrors … EXACTLY" comment was corrected in the same change to
state what is actually true and to point here; leaving a comment that asserts a parity the
code does not have is worse than the gap it hides.

## Recorded residuals

| # | Residual | Severity | Why not fixed under R7 | Status |
|---|----------|----------|------------------------|--------|
| 1 | BKL-203's named-owned-order resolution exists only on the classify-only route | Low — fail-safe (a CLARIFY, never a wrong order), but a real dead-end for a multi-order customer on any turn that falls to the model route | A behavior change on the model path, out of a refactor-assessment's remit. Site 4 already has the ledger-free inputs it would need (`auth.ownedByBaseKey` + the text), so this is tractable without the port change residual 2 needs. | **CLOSED — F-19** (see below) |
| 2 | `MENU_DIETARY` has no in-planner subject branch | Low — fail-safe (absent key → honest UNKNOWN) | Same remit boundary. The uniform fix (route site 4's public per-item class through the ledger like sites 1/2) requires widening `proposeClaims` to accept the `EvidenceLedger`; the narrow fix (add a `detectDietaryPreferenceTags`-based branch beside the other three) does not, and is the smaller step. | **CLOSED — F-20** (see below) |

**No residuals from R7 remain open.**

## Residuals closed

### Residual 1 — F-19: the model route reaches the named owned order

The model route now binds an explicitly-named owned order at ≥2-owned, exactly as the
classify-only route has since BKL-203. The classify-only route is **unchanged** — parity was
reached by moving the model route to it.

**Mechanism — one resolver, not two.** The read plane's `resolveNamedOwnedOrderSubject`
(classify-only-reads.ts) is reused verbatim; the model route grew **no** display-number
parsing. What it grew is a consumer: `ClaimAuthContext.namedOwnedSubjectByBaseKey`, an
optional `Map<baseKey, ownedId>` carrying that resolver's RESULT. The claim-planner adapter
(`ibatexas-claim-planner.ts`) — which already projects the turn ledger into
`auth.ownedByBaseKey` via `ownedResourceIdsByBaseKey`, and which is the one seam both routes
pass through — computes it with `namedOwnedSubjectsByBaseKey` from the SAME ledger and the
SAME `perception.text` it hands the classify-only route. Site 4 consults it only in the
`owned.length > 1` branch, keeping FIX 2's existing precedence (model-supplied-owned →
exactly-one-owned → **named** → CLARIFY).

**Why not the port change.** Measurement 3 above still holds: `proposeClaims(state, auth)`
receives no `EvidenceLedger`, and F-19 did not give it one. The residual row's claim that site
4 "already has the ledger-free inputs it would need (`auth.ownedByBaseKey` + the text)" was
right about the *shape* and imprecise about the *data*: the match is against each owned
order's `displayId`, which lives in the ledger VALUE, not in the id set. The auth context is
the existing channel for exactly that kind of ledger-derived, owner-scoped projection, so the
fix rides it. `proposeClaims`'s signature is untouched, and the re-proposal trigger in the
last section is therefore **not** met by this change.

**Ambiguity contract — inherited, not re-decided.** Because the model route consumes a result
rather than re-implementing a match, the 0-or-≥2-matches disposition cannot drift: the shared
resolver returns a subject only on EXACTLY ONE match (it delegates to BKL-216's
`matchNamedOwnedOrders`), so a message naming none or two of the owned orders yields no map
entry and the ≥2-owned CLARIFY stands on both routes. IDOR-safety is inherited the same way —
the resolver can only ever return an id drawn from the authenticated owned set, so a foreign
display number is unrepresentable, not merely rejected.

**The parity test flipped.** `r7-cross-path-subject-parity.test.ts`'s `DIVERGENCE 1`
characterization is gone, replaced by a `F-19` describe block of directional parity
assertions (both routes bind the same owned id; both keep the CLARIFY when none or two are
named; neither binds a foreign number) plus one test that drives the REAL adapter with only a
ledger + text — the non-vacuity guard proving production actually fills the map, since the
parity tests build the auth context themselves. Each ambiguity/IDOR test carries its binding
CONTROL arm in the same test, so none of them can pass with F-19 reverted.

### Residual 2 — F-20: `MENU_DIETARY` gets its in-planner subject branch

Site 4 now has a branch for all FOUR public per-item types. The NARROW fix this record named
is what shipped: the subject comes from `detectDietaryPreferenceTags` (menu-item-resolver.ts)
— the SAME pure detector the investigator keys its `menu:dietary:{tag}` read by — so the
candidate subject equals the ledger key suffix by construction, exactly as BKL-142's
`resolveMenuItem` and BKL-138's `resolveQueriedScheduleDate` branches beside it already did.
No member of the class is model-authored any more.

**The uniform fix was NOT taken, and its blocker is unchanged.** Routing site 4's public
per-item class through the ledger like sites 1/2 still requires widening `proposeClaims` to
accept an `EvidenceLedger` — the re-proposal trigger in the last section. Nothing in F-20
touched that signature, so the trigger remains unmet. What stays structurally different
between the routes is the INPUT (ledger-named vs text-derived), not the answer.

**Boundaries — measured against what the classify-only route does, not invented.**

- *Unrecognised diet* (a model proposal naming a diet outside the closed
  `{vegetariano, vegano}` set): the proposal is DROPPED, the shape all three sibling
  branches already use when their resolver finds nothing. Fail-safe — honest UNKNOWN, and no
  `menu:dietary:` key is ever parameterized by a model-authored string. Not an error.
- *Two diets named* ("tem opção vegetariana ou vegana?"): DROP + forced `CLARIFY`, mirroring
  `buildClassifyOnlyCandidates`'s `publicAmbiguity` disposition for ≥2 present public
  per-item reads. This is the one place the model route cannot be made byte-exact: it
  CLARIFYs on ≥2 *detected* tags where classify-only CLARIFYs on ≥2 *present* ones, so when
  two diets are asked about and only one has tagged products, the model route asks where
  classify-only would answer. That is the fail-safe direction of a disagreement neither route
  can settle without the other's input — and it replaces today's worse behavior, where the
  model route silently answered about whichever diet the 4B happened to name.

**The parity test flipped.** `DIVERGENCE 2` is gone. `MENU_DIETARY` joined the per-type roll
call of overridden subjects (now the whole class — a hand-written roll call, so deleting a
branch deletes a passing test rather than its own coverage), and the characterization became
a directional assertion that both routes key the candidate by the SAME tag from their
different inputs. Both boundaries above are pinned, each with its binding CONTROL arm in the
same test.

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
