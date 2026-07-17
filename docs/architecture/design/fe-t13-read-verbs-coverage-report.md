# FE-T13 — CHAT_DRIVABLE status/read verbs extraction rollout: coverage report

Ticket: `~/projects/tickets/language-engine/issues/13-rollout-status-read-verbs.md`.
Branch: `feat/le-13-extraction-rollout`.

## TL;DR

The ticket's "18-capability CHAT_DRIVABLE roster" framing does not describe
where the read/status-query surface actually lives. `CHAT_DRIVABLE_TOOL_KINDS`
(`packages/packs-composed/src/capability-definitions/`) is **mutating-only by
construction** — `generateChatDrivableToolKinds` filters on `mutating === true`,
and all 66 `CAPABILITY_DEFINITIONS` entries are `mutating: true` (reads never
route through `adjudicate()`). The real read/status-query surface is a
**structurally separate roster**: the 12 chat-plane-advertised `READ_ONLY` tool
names, unioned across `pack-orders` / `pack-payments` / `pack-reservations` /
`pack-customer-onboarding`'s `ToolClassification.READ_ONLY` sets (each pack's
`src/capabilities.ts`). These are the same 12 names `claustrum-bootstrap.ts`'s
`IBATEXAS_READ_TOOL_EXECUTORS` doc-comment calls "the 12 advertised read-tool
names."

The real untyped-blob bug lived in `apps/api/src/claustrum/ibatexas-planner.ts`'s
`buildToolSurface`: every read tool got the literal same generic schema,
`{ type: "object", additionalProperties: true }`, regardless of what it
actually accepts. This is now fixed for all 12.

## The 12-tool roster + authored schema

| Read tool | Pack | Fields (Directive/State unless noted) | Identifier resolved server-side |
|---|---|---|---|
| `get_cart` | orders | none | cart id — session-scoped, always ignored input |
| `get_order_history` | orders | none | owner from `ctx.customerId` |
| `check_order_status` | orders | `orderReference?` (directive, display-number NL reference) | **orderId** — resolved via `resolveCustomerOrderReference` (see below) |
| `get_recommendations` | orders | `context?` enum (state) | owner from `ctx.customerId` |
| `get_also_added` | orders | `productId` (state, public catalog lookup key) | n/a (no owner scope) |
| `get_ordered_together` | orders | `productId` (state) | owner from `ctx.customerId` |
| `get_payment_status` | payments | `orderReference?` (directive) | **orderId** — resolved via `resolveCustomerOrderReference` |
| `get_payment_history` | payments | none | owner from `ctx.customerId` |
| `check_availability` | reservations | `date`, `partySize` (directive, required); `preferredTime?` (directive) | n/a (guest-accessible, no owner scope) |
| `get_my_reservations` | reservations | `status?` enum (directive) | owner from `ctx.customerId` |
| `get_my_profile` | customer-onboarding | none | owner from `ctx.customerId` |
| `get_my_preferences` | customer-onboarding | none | owner from `ctx.customerId` |

Every schema is authored in
`apps/api/src/claustrum/language-engine/read-tool-schemas.ts`
(`READ_TOOL_AUTHORED_SCHEMAS` / `READ_TOOL_SCHEMAS_BY_NAME`), reusing —
**not reimplementing** — `extraction-schema.ts`'s `CapabilityExtractionSchema` /
`assertSoundExtractionSchema` / `toPayloadJsonSchema` / the shared
`FORBIDDEN_EXTRACTION_FIELD_NAMES` list (orderId/paymentId/customerId/cartId/
reservationId/... never appear as a field on any of the 12). Wired into
`buildToolSurface`'s read-tool branch, additively — a read tool without an
authored schema (today: the 2 staff/ops-only reads, `ops_snapshot` /
sales-analytics, never chat-plane-visible) keeps the generic fallback.

## Why 2 of the 12 needed a real production fix, not just a schema

`check_order_status` / `get_payment_status` structurally cannot accept a raw
`orderId` anymore (Identity class, forbidden). Their ONE model-facing field is
`orderReference` — a Directive-class display-number NL reference ("1234",
"#1234"), never the internal id. Pre-FE-T13, an authenticated customer
calling either with no `orderId` dead-ended to the BKL-107/BKL-118 typed-empty
fact (`{order: null, reason: "no_orders_for_session"}` / `{payment: null,
reason: "no_payment_for_session"}`) — correct for a guest, but would now be
the ONLY possible outcome for an authenticated owner too, since the model can
never supply a raw id.

Fixed via a NEW `resolveCustomerOrderReference`
(`apps/api/src/claustrum/resolve-and-assemble.ts`): an explicit
`orderReference` is parsed as a display number (reusing the ops-plane's
`parseDisplayIdRef`, `ops-order-resolution.ts` — pure, no ops-specific
dependency) and IDOR-checked against the caller's `customerId` before being
trusted (unlike `OrderQueryService.findByDisplayId` itself, which has no
owner scoping — the staff/internal path); absent, unparseable, or matching no
order owned by the caller, it falls through to `resolveOrderId`'s existing
"most recent order" auto-resolve — the SAME fallback `order.amend.*` /
`order.cancel` already rely on on the mutating side, reused (via a thin new
wrapper) rather than re-derived. Both executors
(`claustrum-bootstrap.ts`'s `IBATEXAS_READ_TOOL_EXECUTORS`) now: guest → empty
fact (unchanged); authenticated + no order to resolve → empty fact (new, but
same shape); authenticated + a resolvable order (by reference or
auto-resolved) → delegates to the real read with the resolved id (new —
previously unreachable for these two tools' common case).
**Known limitation, shipped as-is (team-lead ruling, carved as FE-D24):**
`orderReference` resolves an explicit DISPLAY NUMBER only ("pedido 1234"). A
customer naming a specific PAST order by relative date instead ("o pedido de
ontem", not their most recent) still falls through to the most-recent-order
auto-resolve, which can answer about the wrong order if they have several.
Reads are low-irreversibility and the reply names the display id it answered
about, so a most-recent fallback is honest-if-imperfect, not a silent wrong
answer. `check_availability`'s `date` field is the emission precedent —
the model already proves out converting a relative date phrase to an ISO
date elsewhere in this same rollout — so extending `orderReference` (or a
sibling field) to accept a date and match against it in
`resolveCustomerOrderReference` is real, buildable, but out-of-scope-for-this-
ticket new work: FE-D24 (date-based order-reference resolution for
`check_order_status`/`get_payment_status`).

`hasResolvableOrderId`/`stripModelOwner` stay as defense-in-depth against a
model that emits a raw `orderId` anyway — see the P5 fix below for why that
defense is now backed by real sanitization, not just schema guidance.

## P5 fix: the advertised schema was advertisement-only (team-lead ruling)

Team-lead flagged the P5 check ("metadata DESCRIBES, guards IMPLEMENT"):
does anything actually VALIDATE a read tool's `call.input` against its
advertised `inputSchema`, or is the typing purely cosmetic? Traced the
dispatch path (`translateToolCalls`, `ibatexas-planner.ts:718`): a read call
is pushed onto `readToolCalls` with `input: call.input` verbatim — no
validation of any kind. `call.input` then flows straight into the executor
(`executors[call.name](call.input, state)`). Confirmed: **nothing validated
it** — the schema was advertisement-only.

Fixed with `sanitizeReadToolInput` (`read-tool-schemas.ts`), wired into the
ONE dispatch choke point (`ibatexas-planner.ts`'s read-loop invocation,
~line 998): for a tool with an authored schema, drops any field not declared
on it and drops any declared field whose runtime type/enum doesn't match
(treated as absent, never coerced, never forwarded malformed); a tool with no
authored schema is untouched. Never throws, never hard-fails a read — the
worst case is an over-stripped call that behaves exactly like today's argless
call (P4 — availability wins, reads are low-irreversibility). This is
metadata enforcing a structural shape, not a business-logic decision —
ownership/legality/money-threshold enforcement all stay exactly where they
already lived (inside each real handler / kernel guard).

## What the ticket's ACs meant vs. what's structurally possible

**AC1 (authored schema + hydration + corpus, identifiers/PII forbidden):**
DONE for schemas + hydration (above). Corpus: see below — a materially
different shape from the mutating rollout's corpus, for a structural reason.

**AC2 (live-driving yields VALIDATED envelopes...):** read tools **never
produce an envelope** — they don't mutate, so they never reach
`adjudicate()`. This AC's literal wording assumes the mutating-verb pipeline;
it does not apply to reads. See "What's NOT built" below for the honest
accounting of what a live-calibration equivalent would need.

**AC3 (coverage report showing schema + golden fragment, off the blob):**
DONE — this document + the golden gate below.

## Golden gate (the deterministic, CI-enforced proof)

`apps/api/src/claustrum/language-engine/__tests__/read-tool-extraction-prompt-golden.test.ts`
+ `__golden__/read-tools.extraction-prompt-fragment.json` — byte-pins the
exact `{name, description, inputSchema}` the model receives for all 12 read
tools, driven through the REAL `createIbatexasPlanner` → `buildToolSurface`
(never a reimplementation). Asserts every schema is
`additionalProperties:false` (the untyped-blob regression test). Mirrors the
FE-T06 golden idiom, one fixture for the whole 12-tool roster (not 12 files —
all are composed through the identical `buildToolSurface` branch).

`read-tool-schema-lint-gate.test.ts` — the read-tool sibling of FE-T10's
`schema-lint-gate.test.ts`: walks `READ_TOOL_AUTHORED_SCHEMAS`, proves every
entry passes `assertSoundExtractionSchema` (green) and that a deliberately
forbidden field trips it (red), same mechanism, same forbidden-field list.

`read-tool-schemas.test.ts` — per-schema field-set + wire-shape assertions
(mirrors `order-amend-granular.schema.test.ts`'s pattern).

## Why the mutating rollout's corpus/accuracy-meter infra does NOT apply here

`packages/journeys/src/extraction/` (`ExtractionCorpusFileSchema`,
`evaluateExpectPayload`, `driveExtractionCorpusOverOpsChat`,
`runExtractionAccuracyCli`) is built entirely on
`AuditRecord.metadata.languageEngine` — a sidecar `audit-metadata.ts`'s
`buildLanguageEngineAuditMetadata` materializes ONLY for a kind that went
through `adjudicate()` (`field-trust.ts`'s own header: "re-derives
{ExtractionIR, HydratedIntentIR} from the FINAL, already-adjudicated
`AuditRecord.envelope`"). A read tool call never produces an `IntentEnvelope`,
never reaches the kernel, never gets an `intentHash`, and therefore never has
a `languageEngine` sidecar to evaluate. `driveExtractionCorpusOverOpsChat`
settle-polls the audit reader for a NEW record matching `intentKind:
file.capability` — structurally inapplicable to a tool call that produces no
record at all. This is not a gap in this rollout slice's effort; it is a
structural boundary the earlier tickets (05/06/07/09/10) never had to cross,
because every capability they authored was mutating.

## What IS built for reads: a parallel, lighter corpus format

`packages/journeys/read-tool-corpus/*.yaml` (schema:
`packages/journeys/src/read-tool-corpus/schema.ts`, loader:
`load.ts`) — a deliberately NEW, narrower format:
`{tool, source, cases: [{id, utterance, expectArgs, note?, precedingContext?}]}`.
`expectArgs` is authored independently of the model under test (same
independent-truth discipline as the mutating corpora); `expectArgs: null`
documents a case where a SOUND extraction abstains entirely (no tool call)
rather than guessing a lookup key with no grounding context.

Authored for the **7 field-bearing tools** — `check_availability` (12 cases),
`get_recommendations` (12), `get_also_added` (10), `get_ordered_together`
(10), `get_my_reservations` (12), `check_order_status` (10), `get_payment_status`
(9) — the last two added after the `orderReference` field landed (team-lead
ruling), each covering BOTH arms: reference absent (the common case) and an
explicit display-number reference present. The other 5 tools have **zero
fields to calibrate**: any phrasing produces the identical `{}` call by
construction, so a corpus asserting extraction accuracy for them would be
vacuous — their coverage is fully carried by the golden gate (proving the
schema is wired) and the schema-lint gate (proving it stays sound), not a
corpus.

Validated by `packages/journeys/src/read-tool-corpus/__tests__/load.test.ts`:
every file loads and schema-validates, every `expectArgs` key is a real
declared field of its tool's schema (catches an authoring typo), every
field-bearing tool has a committed corpus, every corpus has a real
phrasing-diversity sample.

## Calibration (team-lead ruling — minimal path, one extension)

Team-lead's ruling on the AC2 gap ("live-drive a representative sample"):
take the minimal path rather than build the full corpus-fed accuracy-meter
harness (structurally inapplicable here — see above).

1. **DONE** — `call.input` (sanitized, per the P5 fix) added to the
   `read_loop.executed` log line (`ibatexas-planner.ts`), bounded to
   authored-schema tools only and length-capped (`MAX_LOGGED_ARGS_CHARS`).
   No PII/identifier field can appear by construction (the read-tool
   schema-lint gate enforces it), so nothing here needs redaction. This line
   previously logged only tool NAMES; it now gives a live drive something
   concrete to score against.
2. **DONE (live-verified 2026-07-16)** — an 8-utterance live representative
   sample driven against the local 4B, NOT a full corpus harness, run twice
   against an **ephemeral test stack** (never the shared dev stack — infra
   ports isolated, app ports reassigned to 3013/9013 for the duration, full
   teardown after each window). Driven via `packages/journeys`'s existing
   `ChatClient` + `mintCustomerToken`/`cookieHeader`, the same live-drive
   infra `chat-client.live.test.ts` already proves out. Sanitized `args`
   were read back directly off the `read_loop.executed` log line via a
   temporary log-capture pipe (no VictoriaLogs on the ephemeral stack).
   Seed data: two customers seeded via `seed-refundable-order.ts`
   (domain-only — `order_projections`, not a real Medusa order; a
   real-checkout seeding attempt hit `AuditSinkNotInitializedError` and
   was not resolved in-window — tracked as a limitation below), each with
   a known display_id (`987234` / `916930`).

   | # | Case | Result |
   |---|------|--------|
   | 1 | `check_order_status`, reference absent | **FAILED** — transient Ollama malformed-tool-call-XML 500 (`complete-with-retry.ts`), reproduced identically on retry. Not a rollout defect: cases 2–3 exercise the identical tool/schema and succeeded cleanly. |
   | 2 | `check_order_status`, reference present, caller's OWN order | PASS |
   | 3 | `check_order_status`, reference present, **a DIFFERENT customer's order** (IDOR arm) | **PASS — IDOR proven.** Sanitized args correctly carried `orderReference:"916930"`; the resolved order in the downstream Medusa lookup was the CALLER's own order, never the other customer's — `resolveCustomerOrderReference`'s customerId-filtered lookup rejected the cross-customer match and fell through to auto-resolve, exactly as designed. No cross-customer data surfaced at any point. |
   | 4 | `get_payment_status`, reference absent | PASS (see note below) |
   | 5 | `get_payment_status`, reference present, own order | PASS |
   | 6 | `check_availability`, fields present | PASS |
   | 7 | `get_cart`, zero-field control | PASS — sanitized log line carried `{}` |
   | 8 | `get_my_profile`, zero-field control | PASS — sanitized log line carried `{}` |

   7 of 8 cases succeeded; the one failure is model-inference flakiness
   (confirmed non-deterministic per the retry + adjacent-case evidence),
   not a schema or sanitization defect. Sanitization was verified correct
   across all 8 cases — every logged `args` value matched exactly what its
   schema declares, nothing undeclared or forged ever passed through.

   Side note on case 4: since the seeded orders are domain-only (not real
   Medusa orders — see above), a read-tool executor hitting Medusa admin
   API would 404. Case 4's correct "pago" answer instead came from the
   claims-pipeline's separate Investigate-stage read backend (domain-only,
   no Medusa dependency) — a different, pre-existing read mechanism from
   the one this ticket's schemas govern. Noted as an interesting seam, not
   a defect in this rollout.
3. **DEFERRED (FE-D22)** — the full read-corpus-fed accuracy-meter
   integration. The ticket's literal "corpus feeds the accuracy meter above
   baseline" AC is inapplicable to reads (T07's meter is
   express_intent/audit-sidecar-based, see above); its spirit is covered by
   the golden gate + live sample + this carved-out follow-up ticket.

## Files touched

- `apps/api/src/claustrum/language-engine/read-tool-schemas.ts` (new) — the 12 schemas + registry + `sanitizeReadToolInput` (the P5 fix)
- `apps/api/src/claustrum/ibatexas-planner.ts` — `buildToolSurface` wired to the registry; read-loop invocation sanitizes `call.input` before the executor; `read_loop.executed` log line carries sanitized `args`
- `apps/api/src/claustrum/resolve-and-assemble.ts` — `resolveOrderId` exported; new `resolveCustomerOrderReference` (displayId-reference resolution, IDOR-checked, falls through to `resolveOrderId`)
- `apps/api/src/claustrum-bootstrap.ts` — `check_order_status`/`get_payment_status` executors resolve via `resolveCustomerOrderReference`; new `readOrderReference` helper
- `apps/api/src/__tests__/check-order-status-executor.test.ts`, `get-payment-status-executor.test.ts` — updated for the reference-resolve behavior (both arms)
- `apps/api/src/claustrum/__tests__/resolve-and-assemble.test.ts` — new `resolveCustomerOrderReference` test block (displayId parse, IDOR check, fail-safe fallback)
- `apps/api/src/claustrum/language-engine/__tests__/read-tool-extraction-prompt-fragment-support.ts`, `read-tool-extraction-prompt-golden.test.ts`, `__golden__/read-tools.extraction-prompt-fragment.json` (new)
- `apps/api/src/claustrum/language-engine/__tests__/read-tool-schema-lint-gate.test.ts`, `read-tool-schemas.test.ts` (new; the latter includes `sanitizeReadToolInput` unit tests)
- `apps/api/src/__tests__/scripted-pipeline/fixtures/completions/surfaces.json` — re-recorded TWICE (the 12 read tools' `inputSchema` entries only, then again for `check_order_status`/`get_payment_status` after the `orderReference` field landed; express_intent, tool count, and tool order verified SEMANTICALLY identical both times per the t12-relayed hazard — the regen script parses+re-serializes the whole file via `json.dump`, which reformats whitespace file-wide, so the verification was a structural/value equality check on the express_intent section, not a byte-for-byte file diff)
- `packages/journeys/read-tool-corpus/*.yaml` (new, 7 files — 5 original + `check_order_status`/`get_payment_status` added after the field landed)
- `packages/journeys/src/read-tool-corpus/schema.ts`, `load.ts`, `index.ts`, `__tests__/load.test.ts` (new)
- `packages/journeys/src/index.ts` — one-line barrel addition

## Verification

`turbo run build --filter=@ibatexas/api --filter=@ibatexas/journeys`: clean.
`vitest run` (apps/api, isolated): 328/328 files, 4024/4024 tests, 15 skipped
(Redis-gated). `vitest run` (packages/journeys): 44/44 files (3 live-skipped),
497/497 tests. A handful of unrelated CPU-contention timeouts (route/bootstrap
tests hitting the vitest default 5000ms under concurrent full-monorepo turbo
load — `nx-park-conformance.test.ts`, `confirmations-route.test.ts`,
`kernel-bootstrap-pack-failure.test.ts`, `staff.test.ts`) were observed across
several runs; each confirmed pre-existing/environmental by isolated re-run
(all pass cleanly alone, several times), and none touch any file this rollout
slice changed.

One real regression was found and fixed during this verification pass:
`ibatexas-planner.test.ts`'s read-loop enrichment test asserted the
test-double `get_cart` executor received the model's raw `{cartId: "c1"}` —
now sanitized to `{}` per the P5 fix (get_cart's authored schema has zero
fields), exactly the intended behavior. Updated the assertion; `plan.
readToolCalls` (the raw-call telemetry record, a separate, unsanitized field)
is unaffected and still asserted verbatim by its own sibling test.
