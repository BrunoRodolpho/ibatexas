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
| `check_order_status` | orders | none | **orderId** — auto-resolved via `resolveOrderId` (see below) |
| `get_recommendations` | orders | `context?` enum (state) | owner from `ctx.customerId` |
| `get_also_added` | orders | `productId` (state, public catalog lookup key) | n/a (no owner scope) |
| `get_ordered_together` | orders | `productId` (state) | owner from `ctx.customerId` |
| `get_payment_status` | payments | none | **orderId** — auto-resolved via `resolveOrderId` |
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

`check_order_status` / `get_payment_status` structurally cannot accept
`orderId` anymore (Identity class, forbidden). Pre-FE-T13, an authenticated
customer calling either with no `orderId` dead-ended to the BKL-107/BKL-118
typed-empty fact (`{order: null, reason: "no_orders_for_session"}` /
`{payment: null, reason: "no_payment_for_session"}`) — correct for a guest,
but now the ONLY possible outcome for an authenticated owner too, since the
model can never supply the field. Fixed by auto-resolving the customer's own
most-recent order, reusing `resolveOrderId`
(`apps/api/src/claustrum/resolve-and-assemble.ts`, now exported) — the SAME
"most recent order" fallback `order.amend.*` / `order.cancel` already rely on
on the mutating side, rather than re-deriving a byte-parallel copy. Both
executors (`claustrum-bootstrap.ts`'s `IBATEXAS_READ_TOOL_EXECUTORS`) now:
guest → empty fact (unchanged); authenticated + no order to resolve → empty
fact (new, but same shape); authenticated + a resolvable order → delegates to
the real read with the resolved id (new — previously unreachable for these
two tools' common case). `hasResolvableOrderId`/`stripModelOwner` stay as
defense-in-depth against a model that emits `orderId` anyway (a JSON-Schema
`additionalProperties:false` hint is not a wire-level enforcement).

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

Authored for the **5 field-bearing tools only** — `check_availability` (12
cases), `get_recommendations` (12), `get_also_added` (10), `get_ordered_together`
(10), `get_my_reservations` (12). The other 7 tools have **zero fields to
calibrate**: any phrasing produces the identical `{}` call by construction, so
a corpus asserting extraction accuracy for them would be vacuous — their
coverage is fully carried by the golden gate (proving the schema is wired)
and the schema-lint gate (proving it stays sound), not a corpus.

Validated by `packages/journeys/src/read-tool-corpus/__tests__/load.test.ts`:
every file loads and schema-validates, every `expectArgs` key is a real
declared field of its tool's schema (catches an authoring typo), every
field-bearing tool has a committed corpus, every corpus has a real
phrasing-diversity sample.

## What's NOT built (deliberately deferred, flagged to team-lead before starting)

**A live-drive calibration runner against the local 4B.** The corpus above is
authored but not wired to a live-drive harness. Building one needs either:

1. A new capture point recording a read tool's actual `call.input` — today
   `ibatexas-planner.ts`'s `read_loop.executed` log line (~line 1001) only
   logs tool NAMES, never args — plus a VictoriaLogs-backed runner to query
   it back per turn, since there is no AuditReader-equivalent for reads; or
2. Scoping this rollout slice's proof to the deterministic golden +
   schema-lint gates (this report's posture) and deferring live calibration
   to a follow-up ticket.

This was flagged to team-lead before implementation began, with a stated
default of (2) absent redirection, to avoid speculatively building a new
logging + query pipeline mid-ticket. The corpus itself is real, committed,
independently-authored value regardless of which path is chosen later — it
documents the intended extraction behavior and is ready for either a future
runner or manual spot-verification.

## Files touched

- `apps/api/src/claustrum/language-engine/read-tool-schemas.ts` (new) — the 12 schemas + registry
- `apps/api/src/claustrum/ibatexas-planner.ts` — `buildToolSurface` wired to the registry
- `apps/api/src/claustrum/resolve-and-assemble.ts` — `resolveOrderId` exported
- `apps/api/src/claustrum-bootstrap.ts` — `check_order_status`/`get_payment_status` executors auto-resolve
- `apps/api/src/__tests__/check-order-status-executor.test.ts`, `get-payment-status-executor.test.ts` — updated for the auto-resolve behavior
- `apps/api/src/claustrum/language-engine/__tests__/read-tool-extraction-prompt-fragment-support.ts`, `read-tool-extraction-prompt-golden.test.ts`, `__golden__/read-tools.extraction-prompt-fragment.json` (new)
- `apps/api/src/claustrum/language-engine/__tests__/read-tool-schema-lint-gate.test.ts`, `read-tool-schemas.test.ts` (new)
- `apps/api/src/__tests__/scripted-pipeline/fixtures/completions/surfaces.json` — re-recorded (the 12 read tools' `inputSchema` entries only; express_intent untouched) after the intentional tool-surface change, per that file's own "re-record if the change is intended" contract
- `packages/journeys/read-tool-corpus/*.yaml` (new, 5 files)
- `packages/journeys/src/read-tool-corpus/schema.ts`, `load.ts`, `index.ts`, `__tests__/load.test.ts` (new)
- `packages/journeys/src/index.ts` — one-line barrel addition

## Verification

`turbo run build --filter=@ibatexas/api --filter=@ibatexas/journeys`: clean.
`vitest run` (apps/api, isolated): 327/327 files, 3986/3986 tests, 15 skipped
(Redis-gated). `vitest run` (packages/journeys): 44/44 files (3 live-skipped),
497/497 tests. 3 unrelated CPU-contention timeouts observed under concurrent
full-monorepo turbo load (`nx-park-conformance.test.ts`,
`confirmations-route.test.ts` x2, `kernel-bootstrap-pack-failure.test.ts`,
`staff.test.ts`) — confirmed pre-existing/environmental by isolated re-run
(all pass cleanly alone); none touch any file this rollout slice changed.
