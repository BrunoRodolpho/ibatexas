# Language Engine 2.0 — Program Spec

> **Status:** DRAFT — awaiting owner confirmation of shared understanding.
> **Date:** 2026-07-21.
> **Sources:** the "IBX Language Engine 2.0 — Evidence & Design" artifact (wire-level forensics of the three flagged ops turns + 8-dimension research sweep), a 30-fact repo verification sweep, and the owner interview of 2026-07-21 (20 resolved decisions, recorded below).
> **Authority note:** the four prior program-authority documents (master plan, manifesto, language-engine spec, architecture assessment) were lost from disk and, by owner decision, are **not** reconstituted. The surviving program record is: the master tracker, the evidence artifact, and this spec — which is versioned in-repo precisely so the loss cannot recur.

---

## Problem Statement

I run the restaurant through two conversational planes — my customers order on one, and I manage the store on the other — and three turns on my own ops thread showed me the machine confidently asserting a fact it never looked up ("sim, entregamos em Ibate"). The answer happened to be true, but nothing made it true: the delivery-zone data, the admin screen, and even a finished estimation tool all exist, yet no conversational surface can reach them, so the model invents coverage answers for any place name.

Underneath that single scare are four structural problems:

1. **The greeting problem.** "Oi" costs a full model call against a static multi-thousand-character prompt, every time, and the model is asked to choose among the entire capability roster for an utterance that needs none of it. Small models measurably degrade as the decision surface widens — I am paying the maximum price for the minimum question.
2. **The ops-plane problem.** The customer plane has months of hardening — claims, template renders, fail-closed refusals — while the ops plane I use daily ships raw model prose on its empty-plan path. It is the mechanism, not the audience, that is wrong: any digit-free factual assertion sails through unguarded.
3. **The multi-step problem.** A customer saying "cancela minha order, faz outra igual, e aplica o cupom X1234" is expressing a conditional plan. Today the parser must emit exactly one verb, so the conditional logic is discarded — best case the customer is made to drive each step manually; worst case a destructive cancel executes on a premise no component ever evaluated. The published record is unanimous that no model free-runs this reliably; it must be decomposed and governed.
4. **The identity problem.** The business's knowledge — menu, combos, coupons, zones, hours, policies, journeys — is scattered across code, comments, and hardcoded strings (a welcome-coupon literal whose backing discount "must be manually created before go-live" is the emblem). There is no single versioned definition of the business that everything else provably derives from.

## Solution

IBX becomes a **catalog-driven conversational operating system** (owner-canonized identity). One versioned catalog is the source of business truth, compiled at build time; the kernel keeps sole runtime authority; the model's job shrinks to selecting catalog objects and filling their parameters. Concretely, in five movements:

1. **Close the coverage wound (P0).** Delivery coverage becomes conversational on both planes: a grounded claim answers "entregam em X?" by zone name with fee and ETA, falls back to asking for a CEP, and never guesses. In parallel, the wire loss class is closed: capability JSON stranded in the model's text is salvaged into a provenance-marked envelope, and wire-level constraint options are probed on the pinned engine so prevention is decided by evidence.
2. **Converge the planes.** The ops plane gets the full claims pipeline — investigator, claim planner, claims kernel, template renderer, safe-unknown gate — so factual answers to me are grounded exactly like factual answers to customers. No stopgap: the raw-prose branch is deleted by convergence, not patched.
3. **Build the parse funnel (P1).** Most turns never reach the model: social utterances get instant templates (L0); byte-identical repeats replay their memoized parse (L1, exact-match only); everything else gets a parse scoped to the few plausible capabilities (L2) with full-roster fallback. Every tier is gated behind an evaluation harness that scores parsing — including refusals — before and after every change.
4. **Author the journeys (P2).** Multi-step requests are met by hand-authored journey definitions in the catalog — the model selects and parameterizes, never composes. A generic executor instantiates the journey: feasibility pre-checked from claims, one whole-journey confirmation with grounded amounts, per-activity kernel adjudication, declared compensators, catalog-version pinning. A catalog compiler makes an inconsistent catalog fail to build, and a dangling external reference refuse to boot.
5. **Remember the customer (P3).** Session-close summarization writes a per-customer profile; the greeting — already deterministic at L0 — warms up with grounded, recent, bounded personal touches. A substitutions/pairings graph gives grounded "o que combina?" answers. Allergen and dietary implications stay compile-time forbidden, per ratified policy.

## User Stories

### Customer (cliente, WhatsApp / web)

1. As a customer, I want to ask "vocês entregam em Ibaté?" and get a grounded yes/no with the delivery fee and estimated time, so that I can decide whether to order without being misled.
2. As a customer whose neighborhood name isn't a listed zone, I want to be asked for my CEP instead of guessed at, so that the answer I receive is true for my address.
3. As a customer whose CEP is outside every zone, I want an honest "não entregamos aí", so that I never place an undeliverable order.
4. As a customer, I want "oi" answered instantly and warmly, so that the conversation feels human and immediate.
5. As a customer, I want my thanks and goodbyes acknowledged naturally without machinery behind them, so that closing a conversation feels effortless.
6. As a returning customer, I want the greeting to recall my recent visit ("Oi de novo! Como estava o brisket?") when it was recent, so that I feel known as a regular.
7. As a customer who hasn't ordered in months, I want a clean-slate greeting, so that the restaurant isn't holding stale impressions of me.
8. As a customer, I want to demand deletion of my data and have my profile purged through the existing anonymization path, so that my LGPD rights are honored.
9. As a customer, I want "se não der pra usar o cupom, cancela minha order, faz outra igual, e aplica o cupom" understood as one plan, so that I don't have to drive each step manually.
10. As a customer, I want the plan presented back to me as one clear confirmation — grounded amounts, refund consequence, new total — so that I decide once, with full information.
11. As a customer, I want an invalid coupon detected before anything destructive happens, so that my order is never cancelled for nothing.
12. As a customer mid-journey, if a later step fails, I want earlier steps compensated and an honest explanation, so that I'm never left half-cancelled with no new order.
13. As a customer, I want "refaz meu último pedido" to work as a single flow, so that reordering my usual takes seconds.
14. As a customer cancelling a paid order, I want the existing money guarantees intact — confirmation below the threshold, human escalation at or above it — so that big-money moves always get the right scrutiny.
15. As a customer who parks a confirmation and returns later, I want the plan I confirmed to be the plan that executes, still protected by current policy, so that what I approved is what happens.
16. As a customer, I want the tenth "vocês estão abertos?" answered as fast as the first, with the answer always freshly read, so that speed never comes at the cost of staleness.
17. As a customer using colloquial names ("coquinha", "pep"), I want them understood or clarified — never silently guessed into the wrong item — so that my order is what I meant.
18. As a customer asking "o que combina com brisket?", I want grounded suggestions from the restaurant's own pairing knowledge, so that recommendations are real, not invented.
19. As a customer asking about allergens, I want an honest self-report and a staff handoff rather than an inferred "não contém", so that my safety never rests on a guess.
20. As a customer whose request matches no journey and no capability, I want a graceful clarification rather than a wrong action or silence, so that the system fails closed at the journey level too.

### Owner / staff (ops plane)

21. As the owner on the ops thread, I want factual questions answered only from grounded claims, so that my own system never invents facts at me.
22. As the owner, I want ops answers about zones, hours, orders, and payments to come through the same claims discipline customers get, so that both planes earn the same trust.
23. As the owner, I want small talk on the ops thread to stay natural and instant, so that governance never makes the assistant stilted.
24. As the owner, I want to know a reply was actually delivered, not merely sent, so that "respondido" means the customer's phone received it.
25. As the owner, I want the catalog build to fail on any dangling reference and the platform to refuse to boot on a missing external reference, so that a misconfigured offer can never silently go live.
26. As the owner, I want business policy switches (like coupon-on-placed-order) to live as catalog flags, so that changing commerce policy is a data change, not engine work.
27. As the owner, I want delivery-zone edits in the admin to reflect in chat answers immediately, so that operations and conversation never disagree.
28. As the owner, I want journey definitions reviewed like code — hand-authored, golden-gated, versioned — so that conversational flows change only deliberately.
29. As the owner, I want the fine-tuning decision to come back to me as a packet of real measured numbers, so that I authorize training on evidence, not enthusiasm.
30. As the owner, I want every parser-affecting change to carry a before/after score from the harness, so that "improved" is always a number.

### QA / RCA investigator

31. As the RCA investigator, I want every turn stamped with its catalog version and funnel-tier attribution, so that any historical turn is replayable against exactly what it saw.
32. As the RCA investigator, I want salvaged envelopes provenance-marked, so that wire anomalies stay visible in the audit trail even after recovery.
33. As the RCA investigator, I want parse-cache hits and retriever selections recorded in the turn trace, so that "why did the parser see what it saw" stays answerable.
34. As the RCA investigator, I want the conversation rail grouped by customer with sessions as sub-rows and ops threads labeled, so that a customer's history reads as one thread.
35. As the RCA investigator, I want the two empty-responder ghost turns root-caused as their own incident, so that an unexplained silence class doesn't linger.
36. As the RCA investigator, I want a measured baseline of the text-stranding emission rate before the fix lands, so that the fix has an honest before/after.

### Maintainer / developer

37. As a maintainer, I want one versioned catalog package that compiles into every derived surface (parser roster, retrieval index, feasibility predicates, executor config, render tables, eval goldens), so that adding business behavior is a checked data change.
38. As a maintainer, I want catalog compile errors for referential breaks, missing compensators, slot use-before-def, safety-implication edges, uncovered terminal paths, cyclic graphs, and deletion of referenced objects, so that whole error classes die at build time.
39. As a maintainer, I want the parser's per-turn decision surface scoped to a handful of plausible capabilities with full-roster fallback, so that accuracy rises without any coverage regression.
40. As a maintainer, I want the wire-constraint question settled by a recorded probe on the pinned engine, so that the blocked engine-fact row is retired with evidence instead of assumption.
41. As a maintainer, I want orchestration-shaped capabilities expressible as journey-invocable without becoming free chat verbs, so that the tier system keeps composition out of the parser's hands.
42. As a maintainer, I want prompts laid out prefix-stable — static head, variable tail, utterance last — so that engine-level prefix caching and attention behavior both work in my favor.
43. As a maintainer, I want the session-close summarizer to be the profile's only writer, with supersession semantics and validity windows, so that memory never becomes a second source of truth.
44. As a maintainer, I want this spec and each decision it records versioned in the repository, so that program authority can never again vanish with a directory.

## Implementation Decisions

All twenty interview decisions, plus the defaults set with them. "The artifact" = the LE2.0 evidence & design document.

**Program governance**

1. **Lost authority docs are not reconstituted.** The program record is: master tracker + evidence artifact + this spec. Dangling references to the lost documents are repointed at the artifact and this spec.
2. **The catalog-driven identity is canonical** (artifact Part IV-c), with both guardrails binding — (a) the dependency graph is substrate, journeys are authored routes on it; (b) the catalog is the source of definition, never the seat of runtime authority: kernel, policy bundles, and money thresholds remain code with tests — and the weight warning binding: hand-authored TypeScript data module, no CMS, no runtime editing until the schema survives five real journeys unchanged.
3. **This spec is the deliverable of record for the program**; on confirmation, its decisions are written into the master tracker — reusing existing rows where they overlap (delivery coverage, envelope-gate work, memory writers, claims expansion) and adding new rows for net-new work (parse cache, catalog package, journey layer, funnel tiers, harness).

**P0 — coverage and emission**

4. **Delivery coverage is name-grounded with CEP fallback, on both planes.** A new delivery-coverage claim type resolves by zone-name match (grounded yes, with fee and ETA, phrased with a soft confirmed-at-checkout caveat); an unmatched name clarifies for a CEP and answers precisely through the existing estimation tool; an uncovered CEP renders an honest no. The resolver never guesses. The existing admin cache invalidation keeps chat answers current.
5. **Envelope salvage ships with provenance; prevention is probed, not assumed.** Exact, unambiguous capability JSON stranded in the model's text is promoted to an envelope marked as salvaged in the audit record and adjudicated identically; ambiguous text still refuses. A one-off recorded probe of forced tool choice and JSON-schema response formatting against the pinned engine decides the prevention layer and settles the blocked engine-fact row with evidence either way.

**Ops plane**

6. **Full claims-pipeline convergence, no stopgap.** The ops conductor gains the investigator, claim planner, claims kernel, template renderer, and the safe-unknown gate; factual ops answers become claims-grounded renders; raw prose survives only for small talk. The prior "ops never wires safe-unknown" decision (D5) is dissolved, its pinning test replaced. Convergence brings: ops-scoped claim coverage (store-level questions need claim types the customer-scoped registry doesn't have), the ops read roster feeding the investigator, the staff-actor envelope seam intact, and the ops history block converging toward the same prefix-stable summary-plus-recent-turns shape as the customer plane. The raw-prose branch remains as-is until convergence lands — accepted openly, in exchange for building no throwaway guard.

**P1 — funnel**

7. **The evaluation harness is a hard gate.** It ships before any funnel tier. Every parser-affecting change — tiers, wire constraints, fine-tuning — lands with a before/after score over the corpus, with irrelevance/refusal as a first-class scored category.
8. **L0 answers social utterances only** — greetings, thanks, farewells — from templates with zero model calls. Confirm-window affirmatives keep their ratified restate-then-confirm path; factual questions never enter L0.
9. **L2 scopes the parse to K≈3–5 capabilities with full-roster fallback.** The retriever is the ratified local embedder over pt-BR capability descriptions compiled from the catalog's conversation projection. Low retriever confidence falls back to today's full-roster prompt — the funnel can match but never regress current coverage; the confidence threshold tightens only on harness evidence.
10. **L1 is exact-match memoization now, semantic similarity only on evidence.** Key: canonicalized utterance + prompt/model/catalog version; purge on any version bump. At temperature zero this is memoization of a deterministic function — zero false-hit risk. The embedding-similarity tier stays specced but deferred until trace telemetry shows the residual repeat-miss rate justifies it.
11. **Fine-tuning returns to the owner as a decision packet** — per-capability accuracy, refusal precision, and the specific residual gap — after constraints and scoping are scored. No pre-set trigger.
12. **Caching doctrine: cache the parse, never the answer.** Every invoke re-reads fresh projections. Prompt layout is prefix-stable: static head, retrieved variable material in the tail, utterance last.

**P2 — catalog and journeys**

13. **The catalog package starts as minimal accretion**: capability definitions and claim-registry references move under one versioned root with cross-reference checks; every turn stamps the catalog version into its trace (the replay enabler). Nothing new is added until what exists is unified.
14. **Coupon-on-placed-order ships OFF.** The swap-for-coupon journey's only route is the confirmed cancel → reorder → apply → checkout saga. The branch exists as catalog data; opening it later is a catalog change. No price-adjustment capability is built.
15. **A journey-scoped access class is introduced.** The reorder orchestration becomes journey-invocable: never emittable by the parser as a free verb, instantiable only by the journey executor, per-activity kernel adjudication intact. Standalone reordering rides the reorder-last journey. The access class is reusable for every future orchestration-shaped capability.
16. **The catalog compiler is fully fail-closed.** Static passes (referential integrity, compensation completeness, slot dataflow, safety invariants, terminal coverage, graph shape, lifecycle) are compile/CI errors. Boot-time reconciliation of declared external references (promotions, zones) **refuses to start the process on any miss** — the artifact's strict form, blast radius accepted. Mitigation: the catalog check is runnable against the live store in CI and pre-deploy, so danglers surface at change time, not restart time. The hardcoded welcome-coupon literal becomes a declared external reference under this gate.
17. **Journey instances pin shape, adjudicate fresh.** An instance completes on the catalog version it started under; every activity still passes current-code kernel adjudication, so policy changes bite immediately even mid-journey — if current policy blocks a pinned activity, the journey fails closed with an honest render. Confirm-window TTLs bound park staleness. Catalog objects are retired, never deleted, while referenced (compiler-enforced).
18. **A coupon-validity read is added** (promotion lookup) so journey feasibility pre-checks and coupon questions are grounded reads instead of attempt-and-see. Seed journeys: swap-for-coupon, reorder-last, paid-cancel — three, hand-authored, golden-gated.

**P3 — memory and semantics**

19. **The greeting is warm, specific, and bounded.** Session-close (or idle-triggered) recursive summarization writes the per-customer profile — last visit, last order and items, sentiment, open threads — as the sole writer, with supersession and validity windows. The greeting may reference the last visit/order within a ~30-day window, always via the episodic-summary claim, render-gated. Profiles purge after ~180 days of inactivity; redaction at write; the LGPD delete path wires to the existing anonymization coverage. Factual assertions always re-read authoritative projections — memory supplies warmth and pointers, never facts of record.
20. **The substitutions/pairings graph survives as its own typed capability** on top of the catalog's semantic layer, emitting its own claim type so renders stay gated. The semantic layer owns aliases, containment, and attribute routing; allergen and dietary implication edges are compile errors, enforcing the ratified conservative policy (honest self-report + staff handoff; no dietary renders).

**Housekeeping and sequencing**

21. **All four housekeeping items are in scope:** land the current qa-viewer working-tree changes through the normal review flow; group the conversation rail by customer with sessions as sub-rows and labeled ops threads; persist the message SID and delivery-status callback so send verdicts become delivery verdicts; run the N× re-drive to baseline the text-stranding rate (doubling as the salvage/constraint before-measure) and root-cause the two ghost turns as a separate incident.
22. **Sequencing:** P0 + qa-viewer landing first; then the harness; then the funnel tiers and the ops convergence proceed as parallel workstreams; then the catalog package and journey layer; then memory and the pairings graph. The fine-tune packet returns whenever the harness says the funnel has plateaued.

## Testing Decisions

**What makes a good test here:** it asserts external behavior at the highest seam — the reply a person receives, the adjudication decision recorded, the domain state that resulted, and the trace attribution — never the internals of a tier or a prompt string. A test that would survive a complete rewrite of a funnel tier's implementation is a good test; a test that knows how the tier works is not.

**Primary seam — the turn seam (existing).** The journeys acceptance framework drives an utterance in and asserts on what comes out. Everything runtime in this program asserts here: the grounded delivery answer and its clarify/honest-no branches; salvage promotion and its provenance mark; ops-plane grounded renders after convergence; L0 template replies; L1 memoized replays (asserted via trace attribution, not cache internals); L2 scoped parses and full-roster fallbacks; whole-journey confirm → execute → compensate sequences as multi-turn drives, including the park/resume and mid-journey-policy-change cases; memory-fed greetings. **Trace stage records are the funnel's observability contract:** tier attribution, cache hits, retriever selections, and catalog version are asserted by reading the trace.

**Build gate (existing, extended).** The golden/freshness/drift idiom gains the catalog compiler: every rejection class gets a fixture catalog that must fail to compile, and compiled projections are golden-pinned exactly like today's generated rosters. Boot reconciliation is tested with a deliberately-dangling external reference. Prior art: the capability-definitions freshness gates, the roster-integrity pins, the fail-closed boot drift check.

**Extraction corpus → harness (existing, extended).** The corpus grows into the evaluation harness: offline AST-style scoring of parses over captured wire records and authored cases, per-capability, with irrelevance/refusal scored. It consumes evidence the turn seam already emits; it is a consumer, not a seam. Prior art: the extraction-corpus module and its golden byte-identity gate.

**Modules under test:** the delivery-coverage claim resolver and its renders; the salvage translator; the ops conductor post-convergence; each funnel tier via trace-attributed turn drives; the catalog compiler and its projections; the journey executor (feasibility, confirm, compensation, pinning); the profile summarizer and greeting renders; the pairing capability and its claim. Prior art for contract-style pins: the defer-resume role-contract census test and the escalation-approval end-to-end suite.

**Probes are not tests.** The wire-constraint probe is a one-off recorded experiment whose outcome lands in the tracker; it does not become a permanent suite.

## Out of Scope

- **Answer caching, in any form** — doctrine: the parse may be cached; answers to time-dependent facts are always fresh renders.
- **The embedding-similarity cache tier** — deferred until telemetry earns it.
- **Fine-tune training work** — nothing is built until the owner approves the numbers packet.
- **A price-adjustment capability** — the coupon-on-placed-order flag is OFF; the branch exists only as closed catalog data.
- **Allergen or dietary renders of any kind** — ratified conservative policy stands; implication edges are compile errors.
- **A catalog CMS, admin editor, or any runtime catalog mutation** — hand-authored code-reviewed data only, until the schema survives five real journeys.
- **Reconstituting the lost authority documents.**
- **An inference-engine swap** — the probe decides constraint usage on the pinned engine; swapping engines is not this program.
- **A general knowledge-graph/RAG layer over the domain** — structure already lives in projections and claims; only the scoped pairing graph earns a place.
- **Model-authored plans** — journeys are authored; an unmatched multi-step request clarifies. Any future plan-authoring escape hatch is a separate owner decision.
- **Multi-tenant/multi-restaurant generalization of the catalog.**

## Further Notes

- **Naming collision:** "journeys" currently names the acceptance-test framework; this program introduces catalog journey definitions. The spec distinguishes "the journeys acceptance framework" from "journey definitions / the journey layer"; if a shorter disambiguation is wanted (e.g., renaming the catalog artifact "roteiros"), that is a cosmetic owner call at build time.
- **Count corrections vs the artifact:** the capability registry is 58 kinds (20 chat-drivable, 38 identity), not 62/18; the runtime claim registry is 17 types with the 37-row design vocabulary owned by the existing expansion row; JSON-mode response formatting is already live on every tool-bearing call — the genuinely open constraint questions are forced tool choice and schema-constrained decoding, which the probe settles.
- **The ops history window** is 8 turns / 2,000 chars by configuration; the observed 5 pairs were that conversation's actual depth.
- **Replay completion:** catalog-version stamping plus the existing durable wire capture closes deterministic turn replay — any historical turn re-runnable against exactly the catalog it saw.
- **The organizing admission test** for every subsystem remains the five-phase loop — Perceive → Interpret → Verify → Execute → Observe: a proposal that does not reduce uncertainty before Execute does not go in.
- **Cautionary reference:** the breadth-without-governance failure mode (the Klarna walk-back) is the anti-goal; every movement here adds governed surface, never ungoverned breadth.
