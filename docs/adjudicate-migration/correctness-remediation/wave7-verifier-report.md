# Wave 7 — Verifier report (adversarial)

> Author: W7-Verifier (independent adversarial agent)
> Branch: `feat/correctness-w7-close-w6-findings` (HEAD = `bda5973`, parent = `94964f0`)
> Scope: re-test all 11 W7 closures (G1-G4, P1-P6, O1-O5), Wave 6 red-team
> re-run, bypass-detection coverage check, commit-scramble forensics, and
> surface NEW findings as Wave 8 inputs.
>
> Posture: BREAK first, confirm second. Treat agent reports as untrusted.

---

## TL;DR

The W7 wave closed all four pre-merge gates (G1-G4) cleanly, closed three
of six governance items completely (P1, P3, P4), closed two with documented
scope limits (P2 deferred allowlist, P6 with a silent fallback that the
unmigrated tool-layer callers DO trip), and closed one with a leftover
hand-off gap (P5 — stripe wrapper covers `packages/tools/src/cart/` but a
bare `stripe.paymentIntents.update(...)` survives in `apps/api/src/routes/
stripe-webhook.ts:308`). Operational findings O1-O5 are all PASS.

Two NEW P0/P1 findings surface for Wave 8 from the hand-off seam between
P5 and P6, plus a residual bypass-detection coverage gap that pre-dates
W7 and is not closed by W7.

**Tier verdicts:**
- **Tier 1 shadow: GREEN** — the 4 pre-merge gates that blocked Tier 1
  are all closed and the red-team exploit cases for G1 + G2 now flip.
- **Tier 3 shadow: YELLOW** — the customer-facing tool layer
  (`cancel_order`, `amend_order`) silently bypasses kernel adjudication
  for medusa-egress because of the P5↔P6 hand-off gap. Close before
  Tier 3 shadow.
- **Tier 4 enforce: RED** — the bypass-detection scanner is still
  gate-blind to `packages/tools/src/cart/` for medusa egress, so a
  future regression in the cart tools' stripeAdjudicated or
  medusaAdjudicated usage will not surface in CI. The G3 hash-verify
  wrapper hoists only `actorPrincipal` — if a caller omits `version/
  nonce/taint`, tamper-at-rest detection silently degrades to
  `missing_fields`. None of the production callers trip this today,
  but the structural gap exists.

---

## 1. Per-finding verdict

| # | Finding | Verdict | Evidence |
|---|---------|---------|----------|
| G1 | whitespace customerId trim | **PASS** | red-team 01 EXPLOIT tests now fail (closed bypass); 05-whitespace-rejected.test.ts (8/8) passes; probe of unicode whitespace NBSP/EM-SPACE rejected via `String.trim()` |
| G2 | template-literal bypass detection | **PASS** | bypass-detection 31/31 pass; red-team 02 still passes (validates pre-fix gap); probe of unicode-quotes, string-concat, var-bound options confirms documented limits |
| G3 | verifyParkedEnvelopeHash inert | **PASS** | adapter hoist for `actorPrincipal` correct; integration test 3/3 incl. tamper detection passes with real Redis; **PARTIAL gap noted in §5** for non-actorPrincipal fields |
| G4 | kernel_audit_sink_spill_size canonical | **PASS** | metric consistent across sink/dashboard/alert; allowlist is programmatic; adversarial sed-edit of alert.yaml correctly fails the test |
| P1 | reservation tool layer | **PASS** | 3 of 4 sites use `*FromEnvelope`; `join-waitlist.ts` documented-blocked on missing service-side `joinWaitlistFromEnvelope`; all 53 reservation tests pass; admin/jobs already use `*FromEnvelope` |
| P2 | admin scheduler/tables/zones (DEFERRED) | **PASS** | path (b) chosen with full justification; DEFERRED_ADMIN_LOW_RISK allowlist enforced by bypass-detection; adversarial probe of injected `svc.createWeeklySchedule` correctly fails the test |
| P3 | customer onboarding upserts wrapped | **PASS** | `auth.ts:430` + `whatsapp/session.ts:177` both wrap via `createFromEnvelope` with system-actor envelope; 78 tests pass |
| P4 | orderNote x4 | **PASS** | 0 production `prisma.orderNote.create` calls left; all 4 sites use `order.note.add` envelope; routing test 7/7 pass; route tests pass |
| P5 | stripeAdjudicated + 6 cart migrations | **PARTIAL** | 6 packages/tools/src/cart sites migrated; stripeAdjudicated wrapper sound; **BUT** bare `stripe.paymentIntents.update()` survives in `apps/api/src/routes/stripe-webhook.ts:308` (out of P5 explicit scope but a real bypass) |
| P6 | fetchAdmin order.service | **PARTIAL** | 6 sites in order.service.ts route through `medusaAdjudicated` when `adminAdjudicated` is injected; stripe-webhook wires it correctly; **BUT** 3 callers in `packages/tools/src/cart/{cancel,amend,check-order-status}-order.ts` instantiate `createOrderService(medusaAdmin)` WITHOUT the `adminAdjudicated` option, hitting the silent fallback on line 133-139 of order.service.ts and bypassing the kernel |
| O1 | defer-resume CLI | **PASS** | `ibx kernel defer resume <sessionId>` implemented; 5 unit tests pass (refuse-no-park, refuse-malformed, happy-path, refuse-tampered, legacy-no-hash); G3 dependency wired (calls verifyParkedEnvelopeHash); runbook reference added |
| O2 | pnpm migrate phantom | **PASS** | replaced with `psql $DATABASE_URL -f packages/audit-postgres/migrations/<file>` path; rationale in W7-DECISIONS-ops.md |
| O3 | CLI vs admin two-person rule | **PASS** | path (b) — CLI gains `--yes-i-am-solo-on-call` + TTY guardrail + Sentry breadcrumb; 3 tests verify the refuse-no-flag posture; runbook line added |
| O4 | MANAGER vs OWNER | **PASS** | route at `apps/api/src/routes/admin/kernel.ts:183,290` uses `requireOwnerRole`; 10 tests pass; strategy doc aligned |
| O5 | runbook key references | **PASS** | only inline `ibatexas:foo` reference left is the counter-example explaining what NOT to do; commit was docs-only per RULE G |

**Counts:** PASS = 9 / 11, PARTIAL = 2 / 11, FAIL = 0 / 11.

---

## 2. Wave 6 red-team re-test

The 4 untracked W6 red-team test files in `apps/api/src/__tests__/wave6-red-team/`
are the verifier's reproduction artifacts. Results after W7:

### `01-customerid-whitespace-bypass.test.ts`
Status: **5 tests / 3 failed / 2 passed** — expected outcome.

The 3 EXPLOIT cases (`"   "`, `"\n"`, `"\tabc\t"` padded) FLIP from passing
to failing because the W7-G1 fix closed the bypass. Specifically:
- `markOtpFresh("   ")` now `rejects` with `InvalidCustomerIdError`
  (was `resolves`).
- `markOtpFresh("\n")` likewise rejects.
- `markOtpFresh("\tabc\t")` now writes the canonicalised Redis key
  `ibatexas:anonymize:otp:abc` (was `\tabc\t`); the test still asserts
  the un-canonicalised form so it correctly fails.
- The EXPLOIT case `"null"` (literal four-char string) still passes — by
  design, since the W7 fix deliberately does NOT reject the literal
  string `"null"` (a legitimate-if-unusual customerId; the upstream
  `requireAuth` is the place to refuse JWT `sub="null"`).
- The CONTRAST case (empty string rejected) still passes.

**Verdict:** the 3 failing tests are the AS-DESIGNED behaviour change.
The companion positive regression test (`05-whitespace-rejected.test.ts`,
8/8 passing) pins the new, correct behaviour.

### `02-template-literal-bypass.test.ts`
Status: **6 tests / 6 passed.**

These tests apply the OLD pre-W7 regex shape inline to the fixture, so
they continue to demonstrate the pre-fix gap empirically — they do NOT
flip. The W7-G2 fix lives in the production regex (the
`FORBIDDEN_MEDUSA_MULTILINE` patterns in
`bypass-detection.test.ts:178-181`), which now includes the backtick.

### `03-otp-lockout-admin-reset.test.ts`
Status: **2 tests / 2 passed.**

Not in the W7 scope (lockout sentinel design discussion). Tests continue
to pass.

### `04-park-nx-placeholder-window.test.ts`
Status: **4 tests / 4 passed.**

W3 P0-7-TRUE fix continues to hold; W7-G3 did not regress the NX guard.

---

## 3. Bypass-detection coverage

### Confirmed gap (UNCLOSED, residual from W6)

`MEDUSA_SCAN_DIRS` in `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:72`:

```
const MEDUSA_SCAN_DIRS = [
  "apps/api/src/routes",
  "apps/api/src/jobs",
  "apps/api/src/subscribers",
]
```

Does NOT include `packages/tools/src/` or `packages/domain/src/`. W6
synthesis §"P0-NEW-W6-4 through P0-NEW-W6-9" item 5 explicitly called
this out:

> "Stripe SDK direct calls: 6 sites in `packages/tools/src/cart/` — no
> adjudication anywhere"

And item 4:

> "`prisma.orderNote.create` in 4 production routes: matches
> `FORBIDDEN_PRISMA` pattern but lives in dirs the bypass-detection
> gate doesn't scan"

W7-P4 fixed the orderNote sites; W7-P5 fixed the cart Stripe sites.
**But neither widened the scan dirs to detect regressions on these
surfaces.** A future contributor reintroducing a bare `stripe.*` call
in `packages/tools/src/cart/` would NOT be flagged by CI. A future
contributor adding a `prisma.orderNote.create` to `packages/tools/src/`
WOULD be flagged (PRISMA_SCAN_DIRS includes packages/tools/), but
adding one in `packages/domain/src/services/` would not (and
intentionally so — domain owns the FromEnvelope writes).

This is a regression-prevention gap, not an active correctness gap.
Wave 8 should consider widening `MEDUSA_SCAN_DIRS` to `packages/tools/src/`
with `packages/tools/src/medusa/adjudicated.ts` on the allow list (per
the existing `ALLOWED_MEDUSA_DIRECT` pattern).

### Adversarial confirmation
- Injected bare `svc.createWeeklySchedule(...)` into
  `apps/api/src/routes/admin/schedule.ts` — the W7-P2
  `DEFERRED_ADMIN_LOW_RISK` scan correctly fails the build.
- Edited `infra/alerts/kernel.yaml` to rename
  `kernel_audit_sink_spill_size` → `kernel_audit_spill_bytes`
  — the W7-G4 programmatic-allowlist test correctly fails the build.

---

## 4. Commit-scramble forensic table

The orchestrator brief flagged that the index race caused commit
messages to scramble vs commit contents. Cross-reference of the 14
W7 commits' actual file scope vs claimed scope:

| SHA       | Claimed scope (from msg)                                    | Actual files (from `git show --stat`)                                                                                                                                       | Match? |
|-----------|--------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------|
| bda5973   | cli,docs,correctness-w7-O1 — defer resume CLI               | cli/kernel.ts + tests + runbook + O1-evidence + pnpm-lock                                                                                                                  | YES    |
| 1efa47a   | api/auth,whatsapp,correctness-w7-P3 — onboarding upserts    | auth.ts + auth tests + whatsapp/session.ts + session tests + auth-customer-envelope test + session-customer-envelope test + P3-before/after                                | YES    |
| d922671   | infra,cli,correctness-w7-G4 — sink metric rename            | infra/alerts + dashboards + cli infra-grafana-alerts test + G4-evidence                                                                                                    | YES    |
| 4924228   | api/auth,whatsapp,correctness-w7-P3 — onboarding upserts    | **MISMATCH** — actually contains the W7-P4 routing test + P4 evidence: `order-note-add-routing.test.ts`, `P4-before/after.txt`                                              | **NO** |
| 77cef72   | api,correctness-w7-P4 — orderNote x4 to order.note.add      | 4 production routes (cart.ts, order-actions.ts, admin/order-actions.ts, admin/payments.ts) + domain/index.ts                                                               | YES    |
| b5ab090   | api/auth,whatsapp,correctness-w7-P3 — onboarding upserts    | **MISMATCH** — actually W7-O2 work: O2-evidence + cli/kernel.ts changes for psql-path replacement + cli kernel.test.ts                                                     | **NO** |
| 8cc3fb3   | tools/reservation,correctness-w7-P1 — 3 sites FromEnvelope  | reservation/{create,modify,cancel,join-waitlist}.ts + tests + tools/package.json + P1-before/after                                                                          | YES    |
| e1e1e10   | api/adapters,correctness-w7-G3 — hoist actorPrincipal       | park-deferred-intent-nx.ts + park-deferred-intent-nx-hash.test.ts + G3-evidence + pnpm-lock                                                                                | YES    |
| 5cfbede   | cli,correctness-w7-O3 — two-person CLI guardrail            | cli/kernel.ts + tests + runbook + O3-evidence + migration/05-kill-switch-strategy.md                                                                                       | YES    |
| dbf077e   | governance,correctness-w7-P2 — deferred admin allowlist     | bypass-detection.test.ts + W7-DECISIONS-admin.md + P2-before/after                                                                                                          | YES    |
| 508b979   | api/admin,correctness-w7-O4 — kill-switch role to OWNER     | **MISMATCH** — bundles O4 + P5 + P6 + stripe-webhook updates: admin/kernel.ts + kill-switch test + stripe-webhook + W7-DECISIONS-ops.md + O4/P5/P6 evidence + stripe wrapper + adjudicated.ts + cart tests + order.service.ts + order-service-egress test + medusa-adjudicated test | **NO** |
| 497e7c7   | domain/order.service,correctness-w7-P6 — fetchAdmin routing | **MISMATCH** — actually W7-G2 work: bypass-detection backtick widening + template-literal fixture + G2-evidence                                                            | **NO** |
| 9fbd335   | runbooks,correctness-w7-O5 — Redis key references           | runbooks/SHADOW-ENFORCE-ROLLOUT.md + governance/07-rollback-recovery.md + O5-evidence                                                                                       | YES    |
| b9575bc   | api,correctness-w7-G1 — trim-aware customerId               | anonymize-otp-gate.ts + 05-whitespace-rejected.test.ts + G1-before/after                                                                                                    | YES    |

**Score: 4 of 14 commits have scrambled message-vs-content (29%).**

Operational impact: a future audit-trail reader who searches `git log
--grep correctness-w7-P5` will find ZERO commits — the actual P5 work
landed under the `correctness-w7-O4` message header (508b979).
Likewise `--grep correctness-w7-G2` lands on commit 497e7c7 whose
message says P6. **An incident-investigator needs to read `git
show --stat <sha>` not commit messages.**

---

## 5. NEW findings (Wave 8 backlog)

### NEW-W7-V1 — **P0**: `cancel_order` / `amend_order` tools bypass kernel for medusa egress

**Category:** correctness / governance
**Layer:** tool layer hand-off
**Severity:** P0 (LLM-callable surface, financial-state-adjacent)

**Reproduction:**
```
grep -n "createOrderService(medusaAdmin)" packages/tools/src/cart/
```
Three callers:
- `packages/tools/src/cart/cancel-order.ts:34`
- `packages/tools/src/cart/amend-order.ts:187`
- `packages/tools/src/cart/check-order-status.ts:18`

All three call `createOrderService(medusaAdmin)` **without** the
`adminAdjudicated` option. The `order.service.ts` `mutate()` helper
(line 116) silently falls back to bare `fetchAdmin` (line 133-139) when
`adminAdjudicated` is undefined.

`cancel-order.ts` invokes `svc.cancelOrder(...)` which calls `mutate({
path: '/admin/orders/<id>/cancel', method: 'POST' })`. The kernel is
NOT consulted; no `order.cancel` audit record emitted; the policy
bundle is not adjudicated.

`amend-order.ts` invokes `svc.cancelItem(...)` and follow-up edits via
`mutate({ method: 'POST' })` calls — all hit the fallback.

**Why W7 didn't close this:**
- W7-Govern-Order (P6) explicitly punted to W7-Stripe-Wrapper in
  `w7-evidence/P6-after.txt:127-131`: "The remaining createOrderService
  callers in packages/tools/src/cart/ (cancel-order.ts, amend-order.ts,
  check-order-status.ts) are W7-Stripe-Wrapper's scope and are NOT
  migrated by this agent."
- W7-Stripe-Wrapper (P5) closed the bare-`stripe.*` calls but did NOT
  pick up the `createOrderService` injection wiring (that file pertains
  to medusa-egress, not Stripe-egress).
- **No agent owned this seam.** It is a coordination failure.

**Suggested fix layer:** in `packages/tools/src/cart/_shared.ts` (or
similar) create a shared `createTooledOrderService()` that wires
`adminAdjudicated` from the cart tool layer's `medusaAdjudicated`
shim, and migrate the three callers to use it. One commit; the
service-layer `mutate()` helper can then drop the silent fallback once
all callers are migrated (turn it into a hard `throw new Error(...)`
to prevent silent regression).

**Tier impact:** Tier 3 (LLM-callable) should not flip to enforce
until this is closed.

---

### NEW-W7-V2 — **P1**: bare `stripe.paymentIntents.update(...)` in stripe-webhook

**Category:** correctness / governance
**Layer:** api/routes
**Severity:** P1 (webhook is post-auth and idempotency-guarded, but the
write is a real PSP-state mutation)

**Reproduction:**
```
grep -n "stripe\.paymentIntents\.\(update\|create\|confirm\|cancel\)" apps/api/src/routes/
```
One survivor:
- `apps/api/src/routes/stripe-webhook.ts:308`

```ts
const stripe = getStripe();
await stripe.paymentIntents.update(paymentIntent.id, {
  metadata: { ...paymentIntent.metadata, medusaOrderId: orderId },
});
```

This is a metadata-write only (not amount/state), but it bypasses the
`stripeAdjudicated.paymentIntents.update(...)` wrapper that W7-P5
introduced. The `getStripe()` factory in the route file is unrelated
to the `getStripe()` in `packages/tools/src/cart/_stripe-helpers.ts`
(both files define a private factory).

**Why W7 didn't close this:**
- W7-P5's scope was explicitly `packages/tools/src/cart/` per the W6
  synthesis text and the P5 brief. The `apps/api/src/routes/stripe-webhook.ts`
  site lives outside that scope.

**Suggested fix layer:** route the call through
`stripeAdjudicated.paymentIntents.update(...)` with the existing
webhook-event context as `sourceSubject` and an idempotency key keyed
on `event.id:metadata-update:<piId>`. Single-line change. Add to
bypass-detection scan surface to prevent regression.

---

### NEW-W7-V3 — **P2**: G3 hoist only covers `actorPrincipal`, not `version/nonce/taint`

**Category:** correctness (hardening)
**Layer:** apps/api/src/adapters
**Severity:** P2 (no current production caller trips it; structural
gap only)

**Reproduction:** see
`docs/adjudicate-migration/correctness-remediation/wave7-verifier-evidence/probe-g3-fields-missing.test.ts`.
Park a parked-blob shape via `parkDeferredIntentWithNxGuard()` with
the envelope omitting `version`, `nonce`, `taint` at the top level
(only `actor.principal` nested). Read back the raw Redis blob and run
`verifyParkedEnvelopeHash(parked)` — returns
`{verified: null, reason: "missing_fields"}`. Tamper-at-rest detection
is silently disabled for that blob.

**Why W7 didn't close this fully:** the W7-G3 hoist in
`apps/api/src/adapters/park-deferred-intent-nx.ts:175-195` defensively
re-derives `actorPrincipal` from `actor.principal`, but the inline
comment (lines 173-174) explicitly notes "The other three verification
fields (version/nonce/taint) have no canonical fallback source —
callers MUST pass them at top level." The current production callers
(`me.ts`, `kernel-executor.ts`, `llm-responder.ts`) do all pass the
fields. **But a future contributor adding a new caller can miss this
contract, and the failure mode is silent (verification degrades, no
runtime error).**

**Suggested fix layer:** either (a) extend the adapter to hoist all
four fields from `args.envelope` where present, OR (b) make the
adapter REFUSE-with-error if `version/nonce/taint` are missing at the
top level (fail-loud). Option (b) is the safer choice — silent
degradation of tamper detection is exactly the W6 finding G3 was
meant to fix.

---

### NEW-W7-V4 — **P2**: bypass-detection scan dirs do not cover `packages/tools/src/cart/` for medusa egress

**Category:** governance regression-prevention
**Layer:** test infra
**Severity:** P2

Already detailed in §3 above. `MEDUSA_SCAN_DIRS` excludes the dirs
where W7-P4 (orderNote) and W7-P5 (stripe) closed bypasses. If a
future PR reintroduces the same pattern in those dirs, CI does not
catch it. W6 surfaced this and W7 did not widen the scan.

**Suggested fix layer:** widen `MEDUSA_SCAN_DIRS` to include
`packages/tools/src/` with `packages/tools/src/medusa/adjudicated.ts`
in the `ALLOWED_MEDUSA_DIRECT` set (already there). Mirror for
`PRISMA_SCAN_DIRS` if applicable. ~30 min work.

---

### NEW-W7-V5 — **P2**: Unicode-quote / string-concat / variable-bound
options still evade bypass-detection regex

**Category:** governance regression-prevention
**Layer:** test infra
**Severity:** P2 (documented Q2 backlog)

The W7-G2 backtick widening closed the specific Wave 6 finding, but
the regex still misses:
- Unicode quotes `“POST”` (U+201C / U+201D)
- String concatenation `method: "PO" + "ST"`
- Backtick with interpolation `\`PO${"ST"}\``
- Variable-bound options (`const opts = { method: "POST" }; medusaStore(url, opts)`)

The last two are documented in the source comments
(`bypass-detection.test.ts:163-166`). The Q2 backlog item is "move to
AST-based scanning (typescript-eslint custom rule)". Not blocking
Tier 1; should be tracked.

---

## 6. Overall Tier verdicts

### Tier 1 shadow rollout: GREEN

All four pre-merge gates that the W6 synthesis listed as blocking
Tier 1 (G1, G2, G3, G4) are PASS. The G3 PARTIAL gap on non-actorPrincipal
fields is structural-only — current production callers populate all
four fields. The Wave 6 red-team exploits flip correctly for G1 and G2.

### Tier 3 shadow rollout: YELLOW

P5 has a residual `stripe.paymentIntents.update` survivor in
`stripe-webhook.ts:308` (P1) and P6 has the silent-fallback hand-off
gap (P0). The tool-layer surface (`cancel_order`, `amend_order` —
both LLM-callable) does NOT actually adjudicate medusa egress today.
Close NEW-W7-V1 (P0) before flipping any Tier 3 intent to shadow with
real-customer traffic. Tier 1 shadow is unaffected because the Tier 1
intents do not exercise the cart-tool order.service caller paths.

### Tier 4 enforce: RED

Two compounding reasons:
1. The bypass-detection scanner is gate-blind to `packages/tools/src/cart/`
   for medusa egress (NEW-W7-V4) — a future Tier-4 regression there
   would not surface in CI.
2. The G3 hoist incompleteness (NEW-W7-V3) means tamper-at-rest is
   only as strong as the human-discipline contract that all callers
   populate `version/nonce/taint`. For LGPD-anonymize and refund-
   issue (the two Tier-4 enforce candidates), silent degradation of
   tamper detection is unacceptable.

Close NEW-W7-V3 (P2 → upgrade to P1 for Tier-4 enforce) and NEW-W7-V4
(P2) before enforcing the highest-risk intents.

---

## 7. Honest meta-commentary — shared-branch model

The 6-agent shared-branch model (single branch
`feat/correctness-w7-close-w6-findings`, all agents committing
concurrently with disjoint file scopes) **was net-positive** for
throughput but exposed three real failure modes:

1. **Commit-message scrambling (29% of commits).** The index race
   between concurrent `git add <paths>` + `git commit` cycles meant 4
   of 14 commit messages don't describe their contents. An audit-trail
   reader cannot rely on `git log --grep` to find a specific W7 sub-task's
   commit — they have to `git show --stat <sha>` each commit and
   cross-reference manually. This is operationally painful but recoverable
   (the actual file content is correct; only the labels are wrong).

2. **Hand-off seam failures.** NEW-W7-V1 (the P5↔P6 cart-tool
   `createOrderService` injection wiring) is the canonical example.
   W7-Govern-Order explicitly punted to W7-Stripe-Wrapper, W7-Stripe-
   Wrapper's scope was Stripe-only and didn't see the punt, and no
   agent owned the seam. A pre-flight "RACI matrix" of overlapping
   responsibilities (or a sentinel test that fails on any unwired
   `createOrderService` caller) would have caught this.

3. **No global view of "what fell through."** The W7 brief listed 11
   findings (G1-G4, P1-P6, O1-O5). The 6 agents each saw their slice.
   No agent re-ran the full list to confirm no orphan. The
   adversarial verifier (this report) is structurally how that gap
   gets closed — but a lighter mechanism (a manifest of
   "claimed-closed" with an automated test that the closure actually
   landed) would catch issues earlier in the wave.

**Verdict:** continue using the shared-branch model for waves with
clearly-bounded file scopes (W3, W5 ran this way). For waves where
the work crosses package boundaries (W7's P5/P6 hand-off being the
canonical example), require an explicit ownership map and a
post-wave smoke test of the full claimed-closed list. The verifier
agent is mandatory, not optional, for any wave that does not have
this discipline.

The throughput gain (14 commits across 6 agents in <1 day vs
14 commits sequentially across ~1 week) is real and meaningful. The
audit-trail integrity cost (29% commit-scramble) is bounded by the
discipline that contents-over-messages is the source of truth and
agents always write evidence files (which DID land correctly under
the W7-P{n}-evidence naming convention; those are the actually-
reliable artifact).

---

## Appendix A — Reproducibility

All commands run from repo root `/Users/thaisrodolpho/projects/ibatexas`.
Branch: `feat/correctness-w7-close-w6-findings`. Baseline: `94964f0`.

Tests run:
- `pnpm vitest run apps/api/src/__tests__/wave6-red-team/01-customerid-whitespace-bypass.test.ts` — 5 tests, 3 failed (as designed, EXPLOIT cases flip)
- `pnpm vitest run apps/api/src/__tests__/wave6-red-team/02-template-literal-bypass.test.ts` — 6/6 pass
- `pnpm vitest run apps/api/src/__tests__/wave6-red-team/03-otp-lockout-admin-reset.test.ts` — 2/2 pass
- `pnpm vitest run apps/api/src/__tests__/wave6-red-team/04-park-nx-placeholder-window.test.ts` — 4/4 pass
- `pnpm vitest run apps/api/src/__tests__/wave6-red-team/05-whitespace-rejected.test.ts` — 8/8 pass
- `pnpm vitest run apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts` — 31/31 pass
- `pnpm vitest run packages/cli/src/__tests__/infra-grafana-alerts.test.ts` — 42/42 pass
- `pnpm vitest run apps/api/src/adapters/__tests__/park-deferred-intent-nx-hash.test.ts` — 3/3 pass (Docker required)
- `pnpm vitest run packages/tools/src/reservation/` — 53/53 pass
- `pnpm vitest run packages/tools/src/stripe/` — 22/22 pass
- `pnpm vitest run packages/tools/src/cart/` — 157/157 pass
- `pnpm vitest run packages/domain/src/services/__tests__/` — 74/74 pass
- `pnpm vitest run packages/tools/src/medusa/__tests__/` — 34/34 pass
- `pnpm vitest run apps/api/src/routes/__tests__/order-note-add-routing.test.ts` — 7/7 pass
- `pnpm vitest run apps/api/src/routes/admin/__tests__/kernel-kill-switch.test.ts` — 10/10 pass
- `pnpm vitest run apps/api/src/__tests__/auth-routes.test.ts apps/api/src/__tests__/whatsapp-session.test.ts apps/api/src/routes/__tests__/auth-customer-envelope.test.ts apps/api/src/whatsapp/__tests__/session-customer-envelope.test.ts` — 78/78 pass
- `pnpm vitest run packages/cli/src/commands/__tests__/kernel.test.ts` — 35 tests, 2 failed (pre-existing 32-kinds baseline drift, NOT W7-introduced; W6 baseline reproduces)

Builds:
- `pnpm --filter @ibatexas/api run build` — clean
- `pnpm --filter @ibatexas/tools run build` — clean
- `pnpm --filter @ibatexas/domain run build` — clean
- `pnpm --filter @ibatexas/cli run build` — clean

Adversarial probes (evidence files under
`docs/adjudicate-migration/correctness-remediation/wave7-verifier-evidence/`):
- `probe-g1-unicode.test.ts` — 6/6 pass, confirms NBSP/EM-SPACE rejected via `String.trim()`, confirms ZWSP/NUL NOT trimmed (residual sub-gap noted)
- `probe-g2-template-eval.test.ts` — 5/5 pass, confirms documented limits
- `probe-g3-fields-missing.test.ts` — 1/1 pass, confirms `verifyParkedEnvelopeHash` returns `missing_fields` when caller omits `version/nonce/taint` at top level
- G4 sed-edit of `infra/alerts/kernel.yaml` — alert-validation test correctly fails
- P2 injected `svc.createWeeklySchedule(...)` in `apps/api/src/routes/admin/schedule.ts` — `DEFERRED_ADMIN_LOW_RISK` scan correctly fails

---

End of report.
