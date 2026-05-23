# Pack Conformance Audit

> Audit date: 2026-05-23. Auditor: Pack Conformance Auditor.
> Scope: 4 first-party Packs (`pack-orders`, `pack-reservations`, `pack-whatsapp`, `pack-customer-onboarding`) plus the cross-pack assembly in `@ibatexas/llm-provider` and `apps/api`.
> No code modified — review-only.

## Executive summary

All 4 Packs compile against `PackV0` via `as const satisfies PackV0<...>`, ship a `default: "REFUSE"` PolicyBundle, name-prefix their refusal codes (`order.*`, `reservation.*`, `whatsapp.*`, `customer.*`), `safePlan`-wrap their planners against pack-scoped `ToolClassification`, and export rehydrators. `KNOWN_INTENT_KINDS` totals 32 (10+8+3+3+8), matching the four pack-intent unions plus PIX's 3.

The taxonomy/Pack disagreement is **intentional and documented** for the WhatsApp and Customer domains: `pack-whatsapp` ships 3 of the 6 governance-listed kinds (`handoff.request`, `followup.schedule`, `outreach.send` are deferred); `pack-customer-onboarding` ships 8 of ~14 governance kinds (excludes `customer.session.*`, `customer.loyalty.*`, `customer.welcome_credit.*`). The intent-kinds module makes the omissions explicit.

Three concerns deserve attention before declaring "production-ready":

1. **`pack-orders` ships taxonomy-drifted intent names.** `order.coupon.apply` is correct, but the audited Pack omits 8 of the 19 governance-listed kinds (`order.cart.sync`, `order.pix.details.set`, `order.cancel.force`, `order.address.change`, `order.type.switch`, `order.status.transition`, `order.status.reconcile`, `order.review.submit`, `order.reorder`). Lighthouse Pack scope is narrower than the master taxonomy advertises.
2. **`apps/api/src/index.ts` does NOT exit on `PackConformanceError`.** `start()` is invoked without `.catch()`; a synchronous throw inside `bootstrapKernel` rejects an unawaited promise and hits the `unhandledRejection` handler, which captures Sentry + logs but does NOT call `process.exit(1)`. The process keeps running with subscribers never registered.
3. **WhatsApp REWRITE guard increases work-set without REFUSE on `senderRole=customer→staff`.** The auth phase has zero guards; the policy relies entirely on a downstream REWRITE-clamp. Defence-in-depth comment in `policies.ts:130` acknowledges this; the legitimate path is the inverted handoff-request flow that doesn't exist in this Pack yet (task 16).

## Per-pack scorecard

| Pack | Intent kinds (count vs taxonomy) | Conformance corpus | Default REFUSE | Taint correct | pt-BR | Safety guards | Rehydrator | Verdict |
|---|---|---|---|---|---|---|---|---|
| `pack-orders` | 10 / 19 (subset, see Findings #1) | 30 fixtures, 6 outcomes | yes (`"REFUSE"` literal + `assertPackConformance` opt-in) | yes — `order.cancel.system` system-only | yes — all refusals carry pt-BR | yes — allergens explicit array (line 270-299), centavos integer threshold (CONFIRM_LARGE_TICKET=100_000), payment-method enum guard | yes (passthrough — state is plain JSON) | **needs-fix** (taxonomy scope mismatch) |
| `pack-reservations` | 8 / 8 (full coverage) | 25 fixtures, 5 outcomes (no REWRITE) | yes | yes — `no_show.mark` + `waitlist.notify` system-only | yes | yes — `partySize` positive integer, slot capacity, slot-in-past, blocked-customer; env-driven thresholds via `readPositiveNumber` | yes — `Date` rehydration for `now`/`slot.startAt`/`newSlot.startAt` | **production-ready** |
| `pack-whatsapp` | 3 / 6 (deferred 3) | 25 fixtures, 5 outcomes (no DEFER, no ESCALATE) | yes | yes — `template.send` + `session.handover` system-only | yes — including REWRITE reason text | yes — 24h window REFUSE, handover threshold (CONFIRM at 2nd, REFUSE at 3rd+), customer-string sanitization with newline/markdown/zero-width strip + 100-char truncate | yes — `Date` rehydration for `now`/`lastCustomerMessageAt` | **needs-fix** (auth phase empty; relies on REWRITE for customer→staff) |
| `pack-customer-onboarding` | 8 / 14 (subset by design) | 28 fixtures, 3 outcomes (EXECUTE/REFUSE/DEFER) | yes | yes — `customer.create` system-only with `systemMinimum: "SYSTEM"` lift (not `TRUSTED`) | yes | yes — allergen explicit array, **CPF Modulo-11 checksum** (lines 125-145), OTP-freshness gate on `customer.anonymize` + `.cancel`, profile rate-limit, anonymize idempotency | yes — `Date` rehydration for `now`; epoch-ms numbers pass through | **production-ready** |

### Notes per scorecard row

- **`pack-orders`**: corpus exercises all 6 decision kinds (EXECUTE×9, REFUSE×13, DEFER×2, REWRITE×2, REQUEST_CONFIRMATION×3, ESCALATE×3 — total 30). Boundary cases tested (exactly-at-threshold). Each intent kind has positive + negative case. Confirm threshold `100_000` centavos is integer; escalate cap is `100_000 * 10 = 1_000_000`. Allergen guard explicit on `Array.isArray(value)` AND each entry `typeof === "string"`. PIX-pending DEFER composed via `createPixPendingDeferGuard` from `@adjudicate/pack-payments-pix` — confirmed-status set `{paid, captured, confirmed}` matches the legacy `order-policy-bundle.ts`.
- **`pack-reservations`**: covers 5 of 6 decision kinds; REWRITE not exercised because the domain has no clamping primitive. Three threshold cases per outcome. Env-var defaults via `readPositiveNumber` (CANCEL_CONFIRM_HOURS=2, NO_SHOW_ESCALATE_RATE=0.3, SLOT_RELEASED_TIMEOUT_MS=30min). Rehydrator carefully validates `slot.startAt` shape.
- **`pack-whatsapp`**: covers 4 of 6 decision kinds (EXECUTE, REFUSE, REQUEST_CONFIRMATION, REWRITE). Conformance `it("corpus is at least 25 cases")` passes — there are 25 fixtures. Two threshold guards layered (refuse-first, then confirm) so REFUSE wins over CONFIRM at handover count >= 3. The 24h-window guard treats absent `lastCustomerMessageAt` as expired (REFUSE), which is the safe default. Sanitization is a categorical REWRITE (not `createRewriteGuard` — that's tailored to numeric clamps); pattern is correct per the inline comment.
- **`pack-customer-onboarding`**: 3 of 6 decision kinds (EXECUTE, REFUSE, DEFER) — explicitly documented as appropriate since the domain has no clamp/confirm/escalate threshold. Special "REFUSE-supersedes-parked" pattern documented for `customer.anonymize.cancel` (returns REFUSE with code `customer.anonymize.cancel_supersedes_parked` but `RULE_SATISFIED` basis — semantic success encoded in basis category). CPF validator includes the all-same-digit rejection (e.g., `11111111111` is structurally checksum-valid but administratively invalid). Taint policy explicitly lifts `systemMinimum: "SYSTEM"` above the default `TRUSTED` — `customer.create` cannot be forged by a TRUSTED staff principal, only by the OTP-verify hook.

## Cross-pack consistency

### `KNOWN_INTENT_KINDS` assembly (`packages/llm-provider/src/intent-kinds.ts`)

The module composes the literal-list mirrors of each pack's `IntentKind` union and pins each via `... as const satisfies readonly OrderIntentKind[]`. The `satisfies` clause guarantees that adding a kind to a pack's union without updating the literal list fails the build (`@ibatexas/llm-provider` is downstream of every pack).

Count verification:
- Order: 10
- Reservation: 8
- WhatsApp: 3
- PIX (`@adjudicate/pack-payments-pix`): 3 (`pix.charge.{create,confirm,refund}`)
- Customer-Onboarding: 8

Total: **32 intent kinds** — matches the task brief. The governance taxonomy lists **64** total intent kinds across all 6 domains; the gap (32) is the deferred coverage — `payment.*` (14 kinds), `customer.session.*` (3), `customer.loyalty.*` (2), `customer.welcome_credit.*` (1), unfielded `whatsapp.*` (3), unfielded `order.*` (9), `system.*` (6).

### `installFirstPartyPacks()` (`apps/api/src/plugins/kernel-bootstrap.ts:122-128`)

All 4 Packs are registered via `installPack(...)`:

```
const orders = installPack(ordersPack)
const reservations = installPack(reservationsPack)
const whatsapp = installPack(whatsappPack)
const customerOnboarding = installPack(customerOnboardingPack)
```

The call site does not pass `{ allowDefaultExecute: true }` to any pack, which is correct — every Pack ships `default: "REFUSE"`. `installPack` calls `assertPackConformance` then wraps the policy via `withBasisAudit` (which catches REFUSE-code drift, basis-vocabulary drift, REWRITE-taint regression, and DEFER-signal drift at runtime and records `recordSinkFailure(...)`).

`validateEnforceConfig(KNOWN_INTENT_KINDS, process.env, warn)` runs after pack installation. Typos in `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` surface as one-time pino warnings.

## Boot-time assertion review

### What `assertPackConformance` actually checks (`@adjudicate/core/src/pack-conformance.ts:105-193`)

The structural assertions are:

1. `id` is non-empty string.
2. `version` is non-empty string.
3. `contract === "v0"`.
4. `intents` is non-empty array with unique entries.
5. `basisCodes` is non-empty array with unique non-empty-string entries.
6. `policy` and `planner` are both non-null.
7. **`policy.default === "EXECUTE"` only allowed with `{ allowDefaultExecute: true }` opt-in** (T4 #20 — fail-open default is the most direct authority leak).
8. `signals` (if present) is array of unique non-empty strings.

What it does **not** check:

- It does NOT call any guards (no behavioural probe).
- It does NOT cross-check `intents` against `KNOWN_INTENT_KINDS` — a pack can declare an intent kind that's missing from the global typo-allowlist; only `validateEnforceConfig` would catch that (and only for kinds named in env vars).
- It does NOT verify that `basisCodes` are exhaustively covered by guards or that the policy actually emits them (drift is observed at runtime via `withBasisAudit`'s sink-failure path, not at boot).
- It does NOT verify the planner is `safePlan`-wrapped — that's a Pack-author convention enforced only by code review.

The `@adjudicate/conformance` package's `runConformance(pack)` does the **behavioural** invariants (replay determinism, taint protection, basis-vocabulary purity, guard ordering, default polarity). Each pack's `__tests__/conformance.test.ts` calls `runConformance(...)` and asserts zero failures — that's the behavioural net at CI time, not boot.

### Boot failure mode

`bootstrapKernel(server)` is awaited at `apps/api/src/index.ts:56`. If `installPack` throws `PackConformanceError`:

1. `bootstrapKernel`'s try/catch logs `[kernel-bootstrap] pack conformance failed` at `fatal` level and re-throws.
2. The rejection propagates out of the awaited `bootstrapKernel(server)` call inside `start()`.
3. `start()` returns a rejected promise — **but the top-level `start()` invocation at line 131 does NOT `.catch()` or `await` it**.
4. The unhandled rejection hits the `unhandledRejection` handler at line 33 — which captures Sentry and `logger.error(...)`, but **does NOT call `process.exit(1)`**.
5. The process keeps running. `server.listen()` was never reached, so HTTP traffic isn't served. Subscribers and BullMQ workers are never started.

This is **not the documented behaviour**. The kernel-bootstrap.ts comment block (lines 14, 21-26) says "synchronously … prevents serving traffic" and "exit non-zero before `server.listen()`". The actual behaviour: the process hangs with no listener and no subscribers, and emits a single Sentry capture. Whether this is operationally fail-safe depends on the orchestrator (a healthcheck probe would mark the pod unready; a bare `node` process would just sit). **Finding ranked #2 below.**

## Findings ranked

### #1. `pack-orders` ships only 10 of 19 governance-taxonomy order kinds; the Pack docstring claims it migrates `order-policy-bundle.ts` "bit-for-bit"

Severity: high (taxonomy/Pack drift, but documented).
Location: `packages/pack-orders/src/types.ts:40-50` (the `OrderIntentKind` union); cross-ref `governance/01-intent-taxonomy.md:54-72`.

Missing kinds:
- `order.cart.sync`
- `order.pix.details.set`
- `order.cancel.force`
- `order.address.change`
- `order.type.switch`
- `order.status.transition`
- `order.status.reconcile`
- `order.review.submit`
- `order.reorder`

The Pack docstring (`index.ts:6-9`) says the Pack migrates `order-policy-bundle.ts`. The taxonomy expects these kinds to be fielded by a future Pack (probably `@ibatexas/pack-order-fulfillment` per investigation 05), but the docs do not say so. Consumers who read only the Pack docstring will assume `order.*` belongs entirely to `pack-orders` and route the missing kinds through it — which will hit `default: REFUSE` since they're not in the intent union.

Recommend: update `OVERNIGHT-RUN-SUMMARY.md` and the master plan to record explicit scope ("Phase 1: cart + checkout + amendment + cancel + notes; Phase 2: fulfillment + status + review will land in `@ibatexas/pack-order-fulfillment`"), and add a Pack-level docstring listing the deferred kinds.

The user-facing notes in the task brief specifically called out `order.cart.add` vs taxonomy's `order.item.add` — confirmed: the Pack uses `order.item.add` (matches taxonomy). No drift on that name.

### #2. API boot does NOT exit non-zero on `PackConformanceError`

Severity: high (operational silent-failure).
Location: `apps/api/src/index.ts:131` (`start();`).

`start()` is invoked without `await` or `.catch()`. A synchronous throw inside `bootstrapKernel(server)` rejects an unawaited promise; the `unhandledRejection` handler captures Sentry + logs but does not exit.

Recommend: wrap with `start().catch((err) => { logger.fatal({ err }); process.exit(1) })` OR change the `unhandledRejection` handler to `process.exit(1)` after Sentry flush. The kernel-bootstrap comment ("exit non-zero before `server.listen()`") will then match observed behaviour.

### #3. WhatsApp Pack has no auth-phase guards; relies on REWRITE for customer→staff sanitization

Severity: medium (defence-in-depth; documented).
Location: `packages/pack-whatsapp/src/policies.ts:130-142` (comment block), `:274-306` (`sanitizeCustomerToStaff` guard).

The comment explicitly states: "A future revision may add a customer→staff REFUSE when the relayed message is not part of an active handover." Today, customer-controlled strings flowing to staff are SANITIZED (REWRITE) but not REFUSEd — the policy trusts the upstream `recipientType=staff` projection to be set "ONLY by the handover-aware command service". This is correct only if every emission path is rigorously projected; an inline `subscribers/handoff-subscriber.ts` (`investigation 08 P1 #4` original site) that emits without setting `recipientType` would bypass the REWRITE entirely (the guard short-circuits on `recipientType !== "staff"`).

Recommend: in the task-16 subscriber refactor, audit every `whatsapp.message.send` emission site to ensure `recipientType` is projected. Add a Pack-level REFUSE guard for `senderRole=customer && recipientType==null` (= "we have no idea where this is going; refuse").

### #4. `withBasisAudit` records DRIFT to `recordSinkFailure` — fail-open posture

Severity: medium (governance gap).
Location: `@adjudicate/core/src/pack-conformance.ts:211-316` (`withBasisAudit`).

Drift (unknown refusal codes, unknown basis category:code, REWRITE-taint regression, unknown DEFER signal) is recorded but does not block the decision. The wrapper "mirrors the audit-fail-open posture of the pre-T4 wrapper: drift is observed, not blocked" (line 209).

This means a Pack can emit a refusal code outside `basisCodes` and the kernel will pass the Decision through; only the sink-failure event reaches operators. If the sink itself drops the event (e.g., NATS down during the rollout's quiet hours), the drift is undetected.

Recommend: add a Pack-level test that exercises every guard and asserts every emitted basis is in `pack.basisCodes ∪ KERNEL_REFUSAL_CODES`. The `runConformance` invariants partially cover this (AC-XXX basis-vocabulary purity) but only against synthetic envelopes; a fixture-driven coverage check is stronger.

### #5. Default-deny check at the `PolicyBundle` level uses string literal `"REFUSE"`, not a `decisionRefuse(...)` constant

Severity: low (intentional framework convention).
Location: every pack's `policies.ts` (`default: "REFUSE"`).

The task brief asks whether "every PolicyBundle's `default` slot evaluates to a REFUSE decision". The answer is yes — `default: "REFUSE"` is the literal string the kernel pattern-matches on (sentinel value). The kernel emits the kernel-vocabulary `default_deny` refusal with pt-BR text from `@adjudicate/locales-pt-br.portugueseRefusalMessages`. Packs that want a richer user-facing message export `refuseDefault(...)` (every pack does) and the adopter can compose it as a final business guard if needed.

There is **no drift** between the conformance test assertion `expect(ordersPack.policy.default).toBe("REFUSE")` and the runtime behaviour — both check the same string. The conformance corpus also exercises taint-gated REFUSE on system-only kinds (every pack has at least one such fixture).

### Additional observations (no rank)

- **All 4 packs use `safePlan(...)` correctly**, wrapping the raw planner with the pack's `ToolClassification`. Any future addition of a MUTATING tool name to `visibleReadTools` throws `PlanConformanceError` at boot (loud).
- **`safePlan` is invoked at module load**, not per-call. Wait — re-checked: `safePlan(raw, TOOLS)` returns a wrapped planner that asserts on EVERY `.plan()` invocation, not once at module load. This is correct (state-dependent visibility could regress over time).
- **`pack-customer-onboarding.signals.ts`** is a dedicated subpath. Other packs export the signal constant inline. Both patterns work; the dedicated subpath is preferable for adopters who only need the signal string (subscribers).
- **The intent-bridge `*_TOOL_TO_INTENT` maps** in each pack's `capabilities.ts` cover only the LLM-callable mutating tools. Staff-only / system-only kinds (`reservation.checkin`, `customer.create`, `whatsapp.template.send`, etc.) intentionally have no LLM-callable tool entry — this is correct per CLAUDE.md rule #9 (LLM cannot propose them via the tool path).
- **`rehydrateState` is `optional` in `PackV0`**. All 4 packs ship one. The customer-onboarding rehydrator uniquely returns a fully-typed default state (rather than `{ ctx: {...} }`-only); this is defensible because that pack's state has more required fields than the others.
- **Date handling**: `pack-reservations` and `pack-whatsapp` are the only packs whose state carries `Date` fields that don't survive `JSON.stringify`. Both rehydrators correctly promote ISO strings / epoch ms to `Date`.
- **Centavos discipline (CLAUDE.md rule #2)**: `pack-orders` uses `CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS = 100_000`, `ESCALATE_CANCEL_AMOUNT_CENTAVOS = 100_000`, and the amount-cap is `CONFIRM_LARGE_TICKET_THRESHOLD_CENTAVOS * 10`. All integer comparisons; no float math. The PIX-pending DEFER inherits the `confirmedStatuses` set from `@adjudicate/pack-payments-pix` so there's no string-comparison fragility there.

---

## Verdict per pack

| Pack | Verdict | Rationale |
|---|---|---|
| `pack-orders` | **needs-fix** | Taxonomy/scope drift (Finding #1) and the lighthouse Pack's docstring claims byte-identical migration of `order-policy-bundle.ts` while shipping only 10/19 governance kinds. Fix: update docs / add a scope-deferred kinds list. |
| `pack-reservations` | **production-ready** | 8/8 taxonomy coverage, 5/6 decision outcomes (REWRITE legitimately absent), env-driven thresholds, careful rehydrator. No findings against the Pack itself; Finding #2 (boot exit) and #4 (drift fail-open) are framework-level. |
| `pack-whatsapp` | **needs-fix** | Empty auth phase + REWRITE-only customer→staff path (Finding #3). Functionally correct for the documented happy path but the defence-in-depth is incomplete until the upstream `recipientType` projection is rigorously audited (task 16). |
| `pack-customer-onboarding` | **production-ready** | LGPD destructive-flow lighthouse with correct OTP-freshness gate, CPF Modulo-11 validation, idempotency on parked anonymize, and the `systemMinimum: "SYSTEM"` lift on `customer.create`. The "REFUSE-supersedes-parked" semantic is unusual but documented. No findings. |

**Cross-pack blockers**: Finding #2 (the API doesn't exit non-zero on PackConformanceError) blocks the "fail-safe boot" guarantee the migration plan promises. Finding #4 (drift records but doesn't block) is the framework's deliberate posture but worth surfacing for the operator runbook.
