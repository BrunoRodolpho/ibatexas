# Today's-commits regression audit — 2026-05-24

Branch `feat/kernel-always-on-cutover` @ `c5c839c`. Scrutiny of the 15
commits landed 2026-05-23. Verification via `git show <SHA>` + source
reads, not agent reports.

## TL;DR

One **P1 safety-critical** allergen-data-loss regression introduced by
B2's `update_preferences` tool refactor. Several minor concerns
(audit-fidelity loss in D3 vocab collapse, refusal-as-transient retry in
B3, audit kind naming drift in C1/W4, surfacing of kernel REFUSE text in
W4 catch blocks). No P0s observed. Cross-package dep additions resolve
cleanly. Pre-existing latent bug surfaced incidentally:
`get_loyalty_balance` is a READ_ONLY-classified LLM tool that triggers a
Postgres upsert via `getOrCreateAccount` — not introduced by D5 but
flagged here because D5 documents "all LoyaltyService mutations now
flow through kernel".

## Per-commit verdict

| Commit | Verdict | Notes |
|---|---|---|
| `b297753` docs | skipped (low risk) | docs-only |
| `ebc98d4` A1 audit-consumer guard | clean | safe; stale `IBX_AUDIT_POSTGRES_ENABLED` references in CLI/tests not load-bearing |
| `f87fb0b` docs A2 | skipped (low risk) | docs-only |
| `2abf295` A3+D6 kill-switch sweep | skipped per brief | — |
| `93a4389` D2 G3 hoist | minor | `park_blob_unverifiable` ResolveResult never surfaced in resume-sweep log branch (DLQ inside `resolveDeferredSession` is the only ops signal) |
| `ec5057c` D4 recordSinkFailure | clean | counter reset semantics correct; concurrent emits behave as expected for "consecutive" semantics |
| `35dbbea` D5 LoyaltyService wrap | minor | wrap is correct, but `LoyaltyService.getBalance` → `getOrCreateAccount` → `prisma.loyaltyAccount.upsert` is reachable from a READ_ONLY-classified LLM tool. Pre-existing; not regressed by D5 but contradicts the open-blockers update |
| `fa8ca8c` B1 joinWaitlist | clean | random-nonce + service-level dedup on (customerId,timeSlotId,notifiedAt=null) is safe |
| `ca8ec80` B3 twilioAdjudicated | minor | retry loop in `apps/api/src/whatsapp/client.ts` retries `TwilioAdjudicateRefusedError` (test gap); refusal multiplies audit emissions |
| `d700e5b` B2 update_preferences + submit_review | **bug** | P1 safety regression in `update-preferences` tool: missing-allergen LLM omissions silently overwrite stored allergens with `[]` |
| `92534eb` B4 updatePixDetails | clean | empty CPF rightly refused; principal split (user vs system) is consistent with taint policy |
| `81a7331` D3 /address + /type | minor | HTTP `pickup`/`dine_in` collapsed to `takeout` in outer envelope — audit record loses original vocabulary fidelity |
| `8653a13` C1 medusaStoreAdjudicated wrapper | minor | taxonomy collision: `carts.update` SDK call publishes intent kind `medusa.store.cart.email.update` even when only metadata is being written |
| `102cf4f` docs E | skipped (low risk) | docs-only |
| `c5c839c` W4 cart migrations | minor | catch blocks swallow kernel-REFUSE userFacing text (`add_to_cart`, `update_cart`) and surface generic messages |

## Bug 1 — `update_preferences` silently zeroes allergen list

**Severity:** P1 (safety-critical — allergens are a CLAUDE.md hard
rule because they are food-safety).
**Commit:** `d700e5b` (B2 — `audit-2026-05-23-B2`)
**File:** `packages/tools/src/intelligence/update-preferences.ts:34-58`
**Class:** Logic / safety regression.

**Description.** Pre-B2, the tool passed the LLM input through to
`svc.updatePreferences(...)` untouched. The service-side `updatePreferences`
applies its update branches with the pattern `...(input.allergenExclusions === undefined ? {} : { allergenExclusions })`,
so an omission left the persisted allergen list alone.

B2 changed the tool to coerce an omitted allergen array to `[]` **before**
building the envelope:

```ts
// packages/tools/src/intelligence/update-preferences.ts:34
const allergenExclusions = Array.isArray(parsed.allergenExclusions)
  ? parsed.allergenExclusions
  : []
const payload: CustomerPreferencesUpdatePayload = {
  allergenExclusions,
  ...
}
```

The Pack guard `validateAllergenExplicitArray` at
`packages/pack-customer-onboarding/src/policies.ts:243` only refuses if
`allergenExclusions` is not an array — `[]` passes. The kernel returns
EXECUTE. The executor at `customer.service.ts:357` then calls
`updatePreferences(extras.customerId, { allergenExclusions: [], ... })`,
whose update branch is now triggered because `input.allergenExclusions`
is no longer `undefined`:

```ts
// packages/domain/src/services/customer.service.ts:105
update: {
  ...(input.allergenExclusions === undefined ? {} : { allergenExclusions }),
  ...
}
```

Net effect: a customer with stored allergens `["castanhas"]` who asks
the agent "salva minhas preferências, gosto de churrasco" (LLM emits
`favoriteCategories: ["churrasco"]` without naming allergens) has their
allergen exclusion list silently overwritten to `[]`. The very pattern
CLAUDE.md rule #1 + the Pack guard exist to prevent.

**Reproduction (sketch).** With existing customer prefs row
`{ allergenExclusions: ["castanhas"] }`:

```ts
await updatePreferences(
  { favoriteCategories: ["churrasco"] },   // no allergen field
  { customerId: "cust_x" },
)
// Resulting Prisma row: allergenExclusions = []
```

**Suggested fix.** Drop the `[]` coercion in the tool. Either:

1. Leave `payload.allergenExclusions` undefined → the Pack guard
   REFUSEs and the LLM has to re-prompt the user, OR
2. Have the executor pass `allergenExclusions: undefined` (not `[]`)
   when the envelope payload's `allergenExclusions` is absent — but
   the payload shape declares the field with no `| undefined`, so
   path #1 is the cleaner outcome.

The companion test
`packages/tools/src/intelligence/__tests__/update-preferences.test.ts`
should add a "missing-allergen LLM omission does NOT overwrite stored
allergens" case — currently absent.

## Bug 2 — Twilio retry loop treats REFUSE as transient

**Severity:** P2.
**Commit:** `ca8ec80` (B3).
**File:** `apps/api/src/whatsapp/client.ts:143-160` and `:220-240`.
**Class:** Logic / retry-class confusion + test gap.

**Description.** The migrated `sendSingleMessage` / `sendMedia`
wraps `twilioAdjudicated.messages.create(...)` inside the legacy
3-retry exponential-backoff loop. When the wrapper refuses (e.g.
empty body) it throws `TwilioAdjudicateRefusedError`. The catch
block has no narrowing — it retries with `getRetryDelay(err, attempt)`
where status is undefined → falls into `200 * 2 ** attempt` backoff.

Effect per refused payload:

- 3× `adjudicate(...)` calls (each rebuilds envelope, runs kernel,
  emits audit record).
- ~1.4s added latency before the refusal surfaces.
- 3× `kernel_audit_sink_failure_total` / governance-events bumps if
  the refusal sub-emits any (depending on policy).

**Reproduction.** Call `sendText("", "")` (empty `to`) or arrange
the wrapper-local guard to refuse — observe 3 audit records + 3
identical pino warnings in logs before the error throws.

**Suggested fix.** In the catch, exit early when err is an instance
of `TwilioAdjudicateRefusedError`, `TwilioAdjudicateDeferredError`,
or `TwilioAdjudicateNeedsReviewError` — those are terminal.

## Bug 3 — D3 vocab collapse loses original `type` in audit record

**Severity:** P2.
**Commit:** `81a7331` (D3).
**File:** `apps/api/src/routes/order-actions.ts:1487-1499`.
**Class:** Audit fidelity loss / observability gap.

**Description.** When a customer changes order type to `pickup` or
`dine_in`, the outer envelope coerces both into `takeout`:

```ts
const packNewType: "delivery" | "takeout" =
  newType === "delivery" ? "delivery" : "takeout";
const typePayload: OrderTypeSwitchPayload = { orderId: id, newType: packNewType };
```

The audit record built by the outer `runCustomerIntent` carries
`takeout` — the original `pickup` / `dine_in` distinction is gone
from the outer-envelope audit. The inner `switchOrderType` tool
DOES build its own projection envelope with the precise vocab — but
that's a SECOND audit emit; the outer one is misleading.

**Reproduction.** Issue
`PATCH /api/orders/<id>/type` with `{ "type": "pickup" }`. Grep the
audit log for the resulting intent — there are two records, the
outer-bundle one says `takeout`.

**Suggested fix.** Extend pack-orders' `OrderTypeSwitchPayload` (or
add an optional `httpType` echo field) so the outer envelope can
carry the source vocabulary. Or skip the outer envelope and rely on
the inner-tool envelope alone (it covers the same intent kind).

## Bug 4 — `medusaStoreAdjudicated.carts.update()` emits misleading intent kind

**Severity:** P3 (cosmetic / triage friction).
**Commit:** `8653a13` (C1).
**File:** `packages/tools/src/medusa/store-adjudicated.ts:748` (and call
site `packages/tools/src/cart/create-checkout.ts:235`).
**Class:** Taxonomy drift.

**Description.** The wrapper exposes `carts.update()` which dispatches
intent kind `medusa.store.cart.email.update` regardless of body
contents. `create-checkout.ts:235` calls `carts.update({ cartId, body: { metadata } })`
with no email field — but the audit record still shows
`kind: medusa.store.cart.email.update` and the call-site sourceSubject
is `"cart:create-checkout:update-email"` even though no email is being
set. Cosmetic but actively misleading for incident triage and log
slicing.

**Suggested fix.** Split into `cart.email.update` (when body has email)
vs `cart.metadata.update` (when body has metadata) OR rename to
`medusa.store.cart.update` (generic) since the wrapper does not in fact
specialize. Update `sourceSubject` in `create-checkout.ts:238` to
`"cart:create-checkout:metadata"`.

## Bug 5 — W4 cart tools collapse kernel-REFUSE userFacing copy into a generic error message

**Severity:** P2 (UX regression — pt-BR refusal copy is lost).
**Commit:** `c5c839c` (W4).
**Files:**
  - `packages/tools/src/cart/add-to-cart.ts:67-85`
  - `packages/tools/src/cart/update-cart.ts:27-30`
  - `packages/tools/src/cart/remove-from-cart.ts` (same pattern)
**Class:** Logic / UX.

**Description.** Pre-migration these tools wrapped `medusaStore`/
`medusaStoreFetch` errors generically. Post-migration the same
catch swallows `MedusaStoreAdjudicateRefusedError` and reports
`"Erro ao adicionar item ao carrinho. Verifique o produto e tente novamente."`
instead of the kernel's pt-BR `decision.refusal.userFacing` text.

**Reproduction.** Send `add_to_cart({ cartId: "", variantId: "v", quantity: 1 })`
(empty cartId) — the wrapper REFUSEs with userFacing
`"Não foi possível processar a operação no carrinho porque o identificador está vazio."`,
but the customer sees the generic message.

**Suggested fix.** Narrow catches:

```ts
if (err instanceof MedusaStoreAdjudicateRefusedError) {
  return { success: false, message: err.userFacing };
}
```

Mirrors the existing `MedusaRequestError` branch.

## Other observations (not bugs, worth tracking)

### `defer-resolver` resume-sweep loop has no branch for `park_blob_unverifiable`

`apps/api/src/subscribers/defer-resolver.ts:840-873` handles
`re_adjudicated`, `park_blob_tampered`, `transient_error` — but
`park_blob_unverifiable` (the new D2 kind) is not surfaced. The
DLQ + delete is performed inside `resolveDeferredSession`, so
functionally fine, but ops loses the warn-level signal at the
subscriber boundary.

### Pre-existing: `get_loyalty_balance` is a hidden Postgres mutation in a READ_ONLY tool

D5's `open-blockers.md` update implies all LoyaltyService mutating
paths are now adjudicated. They are not — `LoyaltyService.getBalance`
calls `getOrCreateAccount` which does
`prisma.loyaltyAccount.upsert(...)`. This is invoked by the LLM tool
`get_loyalty_balance`, classified as READ_ONLY in
`packages/llm-provider/src/machine/types.ts:394`. Not introduced by
D5 — pre-existing — but the doc update is now overstating coverage.

### Customer-context check on `submit_review` (pre-existing, surfaced by review)

`packages/pack-orders/src/policies.ts:219` `requireOrderIdForMutation`
asserts `state.ctx.orderId` is present but NOT that the orderId
actually belongs to the calling customer. The tool's executor passes
`extras.customerId` (the agent's own customer) to the upsert, so a
customer X can leave a review on customer Y's order if X knows
orderId Y. The upsert `where: { orderId_customerId: { orderId, customerId } }`
creates a new (orderY, customerX) row rather than updating Y's. Pre-
existing — `submitReview` worked this way before — but B2's expanded
governance doc claims coverage that doesn't include cross-customer
ownership.

### Stale `IBX_AUDIT_POSTGRES_ENABLED` references

A1 cleaned the audit-consumer subscriber, but:
- `apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts:99`
  still calls `vi.stubEnv("IBX_AUDIT_POSTGRES_ENABLED", "true")`.
- `packages/cli/src/commands/__tests__/kernel.test.ts` keeps env
  stubs (and the bundled `dist/` mirrors them).

No functional consequence (the env var no longer gates anything),
but the tests are misleading. Tracked under
`apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts`.

## Test coverage gaps observed

- `packages/tools/src/intelligence/__tests__/update-preferences.test.ts`
  — no test asserts "LLM omission of allergens does NOT overwrite
  stored allergens" (Bug 1).
- `apps/api/src/whatsapp/client.ts` — retry loop is not tested with
  a `TwilioAdjudicateRefusedError` injection (Bug 2).
- `packages/tools/src/cart/__tests__/add-to-cart.test.ts` — no test
  asserts that a kernel REFUSE returns
  `{ success: false, message: <kernel userFacing> }`; the wrapper
  mock is exercised but only on EXECUTE happy path (Bug 5).
- `apps/api/src/subscribers/__tests__/defer-resolver.test.ts` — no
  end-to-end test asserts the resume-sweep log on
  `park_blob_unverifiable` (observation A).
- `packages/pack-orders/src/__tests__/orders-pack.test.ts` — no test
  asserts cross-customer review ownership refusal (observation D).

## Methodology / clean surfaces

For each focus commit I:

1. Read the commit message + diff stat.
2. Read the full code diff (`git show <SHA> -- <file>`).
3. Cross-referenced the post-merge file content to verify the diff
   landed as expected (no hidden cleanup of related files).
4. Traced policy-bundle composition and executor call sites for
   correctness-critical patterns (CPF, allergens, taint policies,
   counter resets, retry loops, ResolveResult branches).

**Clean surfaces (no further concerns):**

- A1 `audit-consumer.ts` — guard removal is consistent; subscriber
  builds writer lazily so no boot-time crash when Postgres is down.
- B1 `joinWaitlist` — service-side dedup on
  `(customerId, timeSlotId, notifiedAt = null)` keeps random-nonce
  retries safe.
- B4 `updatePixDetails` — empty-CPF correctly REFUSEd by the Pack's
  `validateCpfShape`; the user/system principal split matches the
  taint policy contract.
- D2 hoist + fail-loud refuse — `typeof envelope.version !== "number"`
  correctly accepts `version: 0`; the framework's back-compat warn
  branch is intentionally left alone per the commit message.
- D4 `recordSinkFailure` wire — counter reset on success, capacity-
  spill resets the buffer-spill counter; concurrent emits reduce to
  the documented "consecutive" semantics.
- B3 wrapper internals (separate from caller retry loop) — pt-BR
  refusal copy attached to refusal errors; system-principal taint
  enforced at the wrapper boundary.

Twilio dep (`twilio: ^5.13.0` → installed `5.13.1`) resolves; no
new direct npm deps in B2 beyond a workspace `@ibatexas/pack-customer-
onboarding` entry that already exists as a workspace package.
W4's `DEFERRED_MEDUSA_MIGRATIONS = new Set<string>([])` matches the
W4 commit-message claim; the multi-line scanner's regex bounds the
`{...}` to a single options-object literal so a future "options
bound to variable" bypass would slip through (tracked in pre-existing
audit Q2 backlog).
