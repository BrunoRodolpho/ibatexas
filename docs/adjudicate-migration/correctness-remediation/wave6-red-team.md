> ⚠️ **SUPERSEDED on 2026-05-24.** W6 red-team adversarial review (2026-05-23). The 2 exploitable findings (whitespace customerId, template-literal bypass) were closed in W7-G1+G2. For current outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Wave 6 — Red-Team Adversarial Review

**Date:** 2026-05-23
**Reviewer:** Red-Team Adversarial Reviewer (Wave 6 final verification)
**Scope:** All 21 W1+W3 fixes claimed as P0/P1 closures (commits f2a256f..c764c0d)
**Method:** Distrust every fix; construct inputs the implementer did not anticipate; write reproducing tests where exploits land.

---

## Final verdict line

**Red-Team: 17/21 fixes hold; 2 exploitable; 2 suspicious-but-unverified.**

Test files committed under `apps/api/src/__tests__/wave6-red-team/`:
- `01-customerid-whitespace-bypass.test.ts` — Target 5 (exploit)
- `02-template-literal-bypass.test.ts` — Target 8 (exploit)
- `03-otp-lockout-admin-reset.test.ts` — Target 12 (operator UX bug)
- `04-park-nx-placeholder-window.test.ts` — Target 1 (quota-slot leak + placeholder window)

---

## Detailed findings (per target)

### Target 1 — P0-7-TRUE parkDeferredIntent NX wrapper

**Status:** holds with two subtle hazards.

**File:** `apps/api/src/adapters/park-deferred-intent-nx.ts`

**Hazards** (test: `wave6-red-team/04-park-nx-placeholder-window.test.ts`):

1. **Placeholder visibility window** (P2). Between the `SETNX placeholder` (line 121) and the framework's `SET envelope` (line 140), any reader of `defer:pending:{sessionId}` sees the placeholder shape:
   ```
   { __nx_placeholder__: true, sessionId, claimedAt: "..." }
   ```
   The current consumer (`defer-resolver.ts`) is safe because it checks `parked.signal !== signal` first and the placeholder has no `signal` field. But:
   - The `kernel_defer_pending_gauge` (kernel-metrics-sink.ts:298) bumps when this key is created — so a startup burst of N first-time DEFERs will briefly inflate the gauge by N. Not a security issue, but a monitor-tuning surprise.
   - Any future consumer that reads `parked.envelope.kind` will throw `Cannot read property 'kind' of undefined`.

2. **Quota-slot leak on mid-park throw** (P2). The wrapper's catch block (lines 155-161) deletes the park key but does NOT decrement the per-session counter. If `parkDeferredIntent` throws AFTER its INCR but BEFORE its SET (e.g., network blip mid-call), the counter stays inflated. The framework's own rollback (defer-park.ts:198-199) only handles the quota_exceeded branch, not thrown exceptions. A legitimate caller hits `quota_exceeded` earlier than they should until the counter TTL expires.

**Fix recommendation:** In the catch path of the wrapper, derive `counterKey = args.rk(deferCounterKey(sessionId))` and `await args.redis.decr?.(counterKey).catch(() => {})` before re-throwing.

---

### Target 2 — P0-15+X5 prototype pollution + adversarial fuzz

**Status:** holds.

**File:** `packages/llm-provider/src/audit-redactor.ts`

**Tested exploits:**
- `JSON.parse('{"__proto__": {...}}')` exposes `__proto__` as own key via `Object.keys`. The redactor's walk function at line 614 uses `Object.create(null)` for the output container AND explicitly drops `__proto__` / `constructor` / `prototype` keys at lines 622-628. Verified the defense works (node REPL).
- Base64-encoded smuggled payload: the redactor does NOT auto-parse strings; a base64 blob stays as a string. No recursion into encoded content. Safe.
- Proxy object that lies about its keys: the audit pipeline cannot construct a Proxy from JSON.parse'd input. Not reachable.
- Long-string truncation cap at 500 chars: CPF straddling position 500 leaks partial digits (5 of 11) — too few to reconstruct a CPF. Acceptable.

**No exploit found.**

---

### Target 3 — NEW-P0-X6 NaN refund rejection

**Status:** holds.

**File:** `packages/pack-payments/src/policies.ts:214-225`

**Tested exploits:**
- `"NaN"` (string): blocked by `typeof !== "number"`.
- `Number.MAX_SAFE_INTEGER + 1` (9007199254740992): finite + positive → passes the early guards, hits the escalate threshold → correctly escalates.
- `-0`: `-0 <= 0` → true → blocked.
- `Number.MAX_VALUE`: finite + positive → escalates. Behavior correct.

**Marginal:** if `payload.refundableBalanceCentavos` is undefined (no snapshot supplied), the over-balance check is skipped. An over-cap refund would still hit the escalate band. Defensive enough.

**No exploit found.**

---

### Target 4 — P1-D-VERIFY robust Redis get

**Status:** holds, with one inefficiency.

**File:** `apps/api/src/subscribers/defer-resolver.ts:256-292` (robustRedisGet)

**Observation:** The retry logic blindly retries on ANY error class (ECONNREFUSED, READONLY, OOM, MOVED, WRONGTYPE). It does not discriminate recoverable from unrecoverable errors. The 3-retry × exponential backoff (50/100/200ms) is then followed by a DLQ push. This is operationally noisy for unrecoverable cases (e.g., WRONGTYPE — a programming error never recovers), but not a security or correctness defect. **No exploit.**

---

### Target 5 — NEW-P0-X8 empty customerId guard

**Status:** **EXPLOITABLE** (P1).

**Files:**
- `apps/api/src/middleware/auth.ts:127`
- `apps/api/src/routes/me/anonymize-otp-gate.ts:86-90`

**Exploit** (test: `wave6-red-team/01-customerid-whitespace-bypass.test.ts`):
The guard only rejects literal `""` and falsy values; it does NOT trim. Strings consisting entirely of whitespace OR the literal string `"null"` pass:
- `customerId = "   "` → Redis key `anonymize:otp:   `
- `customerId = "null"` → Redis key `anonymize:otp:null`
- `customerId = "\n"` → Redis key `anonymize:otp:\n`

Multiple stolen / forged JWTs with `sub = "   "` collide on the same Redis namespace — the original P0-X8 attack model with `sub=""` is only partially closed.

**Test reproduces the bypass directly:** `markOtpFresh("   ")` resolves and writes to Redis.

**Fix:** widen the assertion to reject whitespace-only:
```ts
if (customerId == null || typeof customerId !== "string" ||
    customerId.trim().length === 0) {
  throw new InvalidCustomerIdError();
}
```
AND canonicalize the assigned value to the trimmed form so downstream keys are unique.

---

### Target 6 — NEW-P0-X2 default-REFUSE

**Status:** holds.

**File:** `apps/api/src/routes/__shared__/customer-intent-gateway.ts:208-242`

**Tested branches:**
- Kind in shadow but NOT in enforce: `isEnforced` returns false, `isShadowed` returns true → adjudicate runs for telemetry, legacy EXECUTE wins. Correct.
- Kind in BOTH sets: `isEnforced` short-circuits first → adjudicate decision is binding. Correct.
- Kind in NEITHER: falls through to REFUSE. Correct.
- `legacy_allow_kinds` env: no such backdoor exists. Good.

**No exploit found.**

---

### Target 7 — NEW-P0-X4 + R1-DELETE payment.method.switch + bare-arg deletion

**Status:** holds.

**Files:**
- `packages/domain/src/services/order-command.service.ts:143-189`
- `packages/domain/src/services/payment-command.service.ts:100-160`

**Verification:**
- `grep transitionStatus(` across the workspace shows zero production callers (only comments / docstrings).
- The bare-arg method declarations are deleted from BOTH the interface AND the impl factory. TypeScript catches any attempted reintroduction at compile time.
- Dynamic access via `(svc as any).transitionStatus` is NOT compile-time defended, but the runtime impl simply doesn't have the method → "transitionStatus is not a function". Defense in depth holds.

**No exploit found.**

---

### Target 8 — NEW-P0-X9 multi-line bypass detection

**Status:** **EXPLOITABLE** (P1).

**File:** `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:171-176`

**Exploit** (test: `wave6-red-team/02-template-literal-bypass.test.ts`):
The regex character class `['"]` only matches single or double quotes:
```
\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]
```

A developer writing `method: \`POST\`` (template literal / backtick) bypasses the scanner:
```ts
await medusaStore("/store/carts", {
  method: `POST`,        // bypass
  body: JSON.stringify(cartBody),
});
```

The CI gate passes; the bypass ships.

**Additional limitation pinned in the same test file:** options-object stored in a variable (`const opts = {method: "POST"}; medusaStore(url, opts)`) also evades — already acknowledged in the test file's own comment but documented here.

**Fix:** widen the character class to ``['"`]`` in all four patterns (one-character change × 4 lines).

---

### Target 9 — NEW-P0-X1 boot-window race

**Status:** holds.

**File:** `apps/api/src/index.ts:106-108` + `apps/api/src/subscribers/defer-resolver.ts:724-734`

**Verification:**
- `startDeferResolverSubscriber(log, { dispatcher })` wires the dispatcher SYNCHRONOUSLY via `setResumeIntentDispatcher` BEFORE calling `subscribeNatsEvent`. No remaining window.
- A "process restart between wire and subscribe" is microseconds — and a process restart restarts everything, not a partial state.
- If `createResumeDispatcherAdapter` throws on construction, the await fails, `index.ts`'s outer try/catch calls `process.exit(1)`. Fail-closed.

**No exploit found.**

---

### Target 10 — NEW-P0-X3 NATS auth fail-CLOSED

**Status:** holds.

**File:** `packages/nats-client/src/index.ts:148-161`

**Tested:**
- `NODE_ENV=production`, `NATS_NKEY_SEED=""`: empty string is falsy → `nkeyAuthenticator` skipped → `authenticator === undefined` → THROW. Good.
- `NODE_ENV=production`, `NATS_NKEY_SEED="invalid_seed"`: passes the empty-check at line 68, builds an authenticator with garbage bytes. The boot-time security check passes, but `connect()` later fails when NATS rejects the seed. Eventually fails-closed (process crash), just at a different stack frame.
- `NATS_CREDS_PATH="/nonexistent"`: `readFile` throws ENOENT, bubbles up uncaught → process crashes at boot. Fail-closed.

**No exploit found.**

---

### Target 11 — P1-I-TRUE refund cap atomic Lua

**Status:** holds.

**File:** `apps/api/src/routes/admin/payments.ts:153-215`

**Tested:**
- `amount = 0`: blocked at the route layer by Zod (`z.number().int().min(1).optional()`) before reaching Lua. Even if it did reach Lua, the script would increment by 0 (no-op) and refresh TTL — a marginal "extend the counter window" effect at most.
- `amount > cap on fresh bucket`: Lua returns `{0, 0}` (cap_exceeded, current=0). Counter NOT incremented. Correct.
- Negative `amount`: blocked by Zod's `min(1)`.
- `EVAL_RO vs EVAL`: the route uses `redis.eval` (not EVAL_RO). Reads on a replica would fail with READONLY — caught by the route's try/catch which falls back to step-2 receipt (fail-CLOSED).

**No exploit found.**

---

### Target 12 — P0-X-OTP atomic OTP counter

**Status:** operator-UX BUG (P2).

**File:** `apps/api/src/routes/me/anonymize-otp-gate.ts:341-430`

**Bug** (test: `wave6-red-team/03-otp-lockout-admin-reset.test.ts`):
`clearOtpLockout(customerId)` deletes the lockout sentinel but does NOT reset the failure counter. The Lua script then:
1. Sees `EXISTS lockout_key == 0` → proceeds.
2. INCRs the counter (still at threshold+1 from the burst).
3. `count > threshold` → re-sets the sentinel.

Ops calls `clearOtpLockout` to unstick a customer; the very next OTP attempt re-locks. The customer remains effectively locked out and ops thinks "did the reset not take?". Not exploitable from outside, but real ops-time friction.

**Test reproduces the bug end-to-end** with a Lua-aware Redis mock.

**Fix:** make `clearOtpLockout` symmetric — also `del` the counter key. One-liner.

---

### Target 13 — P0-9-TRUE enforce-config empty-trim

**Status:** holds.

**File:** `apps/api/src/plugins/kernel-bootstrap.ts:229-257`

**Tested:**
- `IBX_KERNEL_ENFORCE=",,,"`: parsed → empty; raw.length > 0 → THROWS. Good.
- Tab characters: trimmed → empty → THROWS. Good.
- ` ` (NBSP) — ECMAScript whitespace, trimmed → empty → THROWS. Good.
- `​` (zero-width space) — NOT in ECMAScript whitespace, kept as a token. Then `validateEnforceConfig` against KNOWN_INTENT_KINDS flags it as unknown → throws at the downstream gate. Good.
- `","` (single comma): parsed → empty; raw.length === 1 > 0 → THROWS. Good.

**No exploit found.**

---

### Target 14 — P0-5-TRUE two-person staffId null edge

**Status:** holds.

**File:** `apps/api/src/routes/admin/admin-confirmation-store.ts:223-286`

**Tested:**
- `staffId` literal string `"null"`: `normalizeStaffId("null")` returns `"null"` (not coerced to actual `null`). Both step-1 and step-2 with this value → `same_actor_violation`. REFUSED.
- JWT `sub="   "` (whitespace): `normalizeStaffId("   ")` → trim → empty → returns `null` → triggers `null_staff_violation`. REFUSED.
- Step-1 JWT (staffId="A"), step-2 API key (staffId=null): `pendingStaff = "A"`, `requestStaff = null` → `null_staff_violation`. REFUSED.

The defense holds even though Target 5's upstream empty-string guard is incomplete — the `normalizeStaffId` here catches whitespace-only that Target 5 missed. Defense in depth.

**No exploit found.**

---

### Target 15 — NEW-P0-X7 anonymize $transaction timeout

**Status:** holds.

**File:** `packages/domain/src/services/customer.service.ts:473-648`

**Tested:**
- Boundary 500 / 1000 reviews: `reviewCount > 1000` is false at exactly 1000 → light path (single tx). At 1001+ → heavy path with batching. Boundary is consistent with `REVIEW_BATCH_HEAVY_THRESHOLD = 1000`.
- Mid-batch throw (lines 561-580): error propagates out, customer record stays un-anonymized, receipt remains, retry is idempotent (the `where: comment: { not: null }` filter only re-targets unscrubbed rows).
- Receipt cleanup on throw: the grace-resolver subscriber catches the throw at `anonymize-grace-resolver.ts:119-126` and explicitly logs "receipt left for retry" — does NOT clear the receipt. Correct.

**No exploit found.**

---

### Target 16 — NEW-P1-CPF regex edge

**Status:** holds.

**File:** `packages/llm-provider/src/audit-redactor.ts:241`

**Tested:**
- Scientific notation `1.234e10`: doesn't contain 11 contiguous digits in a CPF shape → no match. Not a real CPF; correct behavior.
- CPF followed by hyphen `123.456.789-00-`: lookbehind passes, match succeeds, lookahead `(?!\d)` passes (next is `-`, not digit). Match fires. Correct per the W2 fix.
- CPF preceded by hyphen: lookbehind fails (excludes `-`). Intentional per code comments — leading `-` means we're mid-sequence.
- Unicode digits (e.g., Devanagari): `\d` is ASCII by default; non-ASCII CPF-shapes don't match. Brazilian CPFs are ASCII, so acceptable.

**No exploit found.**

---

### Target 17 — NEW-P1-ENV parseBoolEnv

**Status:** holds.

**File:** `packages/llm-provider/src/parse-bool-env.ts`

**Tested:**
- `"  TRUE  "`: trim + lowercase = `"true"` → returns `true`. Good.
- `"1.0"` (decimal): not in TRUTHY/FALSY set → returns `defaultValue`. Reasonable.
- JSON-decoded boolean `true` (programmer error): TS signature is `string|undefined`. Calling with a non-string would throw at `value.trim()`. Defense via TS signature; runtime crash if abused. Acceptable.

**No exploit found.**

---

### Target 18 — W3 11 ghost metrics

**Status:** holds.

**File:** `apps/api/src/plugins/kernel-metrics-sink.ts`

**Verification:** Each of the 11 ghost metrics named in `migration/06-observability-requirements.md` exists in code with the same name:
1. `kernel_audit_lag_seconds` ✓
2. `kernel_replay_drift_total` ✓
3. `kernel_kill_switch_state` ✓
4. `kernel_pack_install_total` ✓
5. `kernel_defer_pending_gauge` ✓
6. `kernel_defer_quota_exceeded_total` ✓
7. `kernel_defer_timeout_total` ✓
8. `kernel_audit_redactor_failures_total` ✓
9. `kernel_audit_sink_buffer_size` ✓
10. `kernel_audit_sink_spill_size` ✓
11. `kernel_intent_kind_unknown_total` ✓

**No drift found.**

---

### Target 19 — W3 CLI kill-switch + admin endpoint

**Status:** holds with one missing layer.

**File:** `apps/api/src/routes/admin/kernel.ts:217-225`

**Tested:**
- Step-1 with staffA, step-2 with staffA → `constantTimeEqual("A","A")` → SAME_ACTOR refusal. Good.
- Step-1 JWT (staffA), step-2 API key (staffId=null) → `pendingStaff = "A"`, `requestStaff = ""` → length 0 → NULL_STAFF refusal. Good.

**Missing layer:** the admin endpoint uses its OWN inline two-person check (lines 218-224) rather than `consumeWithSameActorCheck`. It lacks the explicit `actor_type_mismatch` check that the order-confirmation store has (P0-5 step 2). In practice the null guard catches every cross-credential case (because API-key paths have `staffId=null`), so the gap is not exploitable today. Hardening: factor `consumeWithSameActorCheck` to share between order-confirmation and kernel-confirmation.

**No exploit found.**

---

### Target 20 — W3 replay (real, not stub)

**Status:** holds.

**File:** `packages/cli/src/commands/kernel.ts:220-246`

**Tested:**
- `IBX_AUDIT_POSTGRES_ENABLED=false` (or unset): `parseBoolEnv(..., false)` → false → enters the stub block, prints structured TODO, exit 0. Graceful.
- `IBX_AUDIT_POSTGRES_ENABLED="TRUE"` (uppercase): parseBoolEnv → true → proceeds to real replay. Good.
- `IBX_AUDIT_POSTGRES_ENABLED="1"`: → true. Good.

**No exploit found.**

---

### Target 21 — Medusa migration P0-X9 follow-up

**Status:** holds.

**Files:** `apps/api/src/routes/admin/products.ts`, `apps/api/src/routes/cart.ts`, `apps/api/src/routes/stripe-webhook.ts`

**Verification:** ran the W3 multi-line bypass regex (FORBIDDEN_MEDUSA_MULTILINE) against all 3 files manually via Node → ZERO matches. The before-state's 13 sites are all on `medusaAdjudicated`. The DEFERRED_MEDUSA_MIGRATIONS allow-list is empty.

**No exploit found.**

---

## Suspicious-but-unverified (3)

1. **Target 1 — placeholder shape leak into kernel_defer_pending_gauge metric.** The gauge polls `defer:pending:*` keys; during a startup burst with concurrent first-time DEFERs across N sessions, the gauge briefly reads N higher than the truth because each session has a placeholder between SETNX and the framework's SET. We did not run a load test to confirm the magnitude.

2. **Target 4 — Redis error-class blind retry.** `robustRedisGet` retries on all errors without distinguishing READONLY / OOM / MOVED. We did not run a chaos test against a Redis cluster to confirm the DLQ-after-3-retries pattern bridges all real failure modes correctly. Suspicion: a MOVED (cluster redirect) is currently retried on the OLD node, not the new — likely re-fails 3× then DLQs. Operationally noisy; not a correctness bug.

3. **Target 10 — NATS auth post-boot rotation.** The fail-closed check runs at process start. If credentials rotate mid-process and the existing connection drops, reconnect uses the OLD authenticator object (constructed at boot from the OLD seed). We did not verify whether `node-nats` re-reads creds on reconnect — if it does not, a rotation causes a permanent disconnection that requires process restart. Operational gotcha; not a security defect.

---

## Top 5 most concerning exploits

1. **Target 5 — whitespace customerId bypass.**
   File: `apps/api/src/routes/me/anonymize-otp-gate.ts:86-90` and `apps/api/src/middleware/auth.ts:127`.
   Test: `wave6-red-team/01-customerid-whitespace-bypass.test.ts`.
   `markOtpFresh("   ")` resolves and writes to Redis key `ibatexas:anonymize:otp:   `. Multiple forged tokens with whitespace `sub` collide on this namespace.

2. **Target 8 — template-literal bypass of medusa scanner.**
   File: `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:171-176`.
   Test: `wave6-red-team/02-template-literal-bypass.test.ts`.
   `method: \`POST\`` evades all four FORBIDDEN_MEDUSA_MULTILINE patterns. CI gate trivially evaded.

3. **Target 12 — OTP lockout admin reset is one-attempt grace.**
   File: `apps/api/src/routes/me/anonymize-otp-gate.ts:426-430`.
   Test: `wave6-red-team/03-otp-lockout-admin-reset.test.ts`.
   `clearOtpLockout(customerId)` resets only the sentinel, not the counter — next attempt instantly re-locks.

4. **Target 1 — NX-wrapper quota-slot leak on mid-park throw.**
   File: `apps/api/src/adapters/park-deferred-intent-nx.ts:155-161`.
   Test: `wave6-red-team/04-park-nx-placeholder-window.test.ts`.
   If the framework park throws AFTER counter INCR but BEFORE SET, the wrapper cleans up the placeholder key but does NOT decrement the counter. Quota slot leaked until TTL.

5. **Target 1 — placeholder envelope shape visible to readers.**
   File: same as above.
   The `defer-resolver` is safe (signal mismatch short-circuit), but the metric gauge and any future consumer that reads `parked.envelope.kind` will misbehave.

---

## Top 3 fixes that held up best under adversarial review

1. **Target 13 — P0-9-TRUE empty-trim validation.**
   `kernel-bootstrap.ts:assertEnforceConfigNotEmptyAfterTrim` correctly handles commas, tabs, NBSP. The downstream `validateEnforceConfig` catches anything that passes the trim check but isn't a known kind. Two-layer defense.

2. **Target 14 — P0-5-TRUE two-person staffId null edge.**
   `normalizeStaffId` trims and length-checks; null guards fire first, then actor-type mismatch, then same-actor. Layered defense that even covers cases where the upstream auth check leaks whitespace (Target 5's gap).

3. **Target 11 — P1-I-TRUE refund cap Lua.**
   Atomic Lua script + Zod schema at the route + try/catch fail-CLOSED on Redis errors + best-effort rollback on REFUSE = four-layer defense. Zero realistic exploit surface.

---

## Trustworthiness verdict

**Would deploy WITH the following two-line fixes applied first:**

1. `apps/api/src/routes/me/anonymize-otp-gate.ts:87` and `apps/api/src/middleware/auth.ts:64,95,127` — add `.trim().length === 0` to the empty-string guards. Closes Target 5.

2. `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:171-176` — widen `['"]` to ``['"`]`` in all four FORBIDDEN_MEDUSA_MULTILINE patterns. Closes Target 8.

Both are mechanical, low-risk, no behavior change for existing inputs. Targets 1 and 12 are operationally minor and can ship as documented follow-ups (Target 1's slot-leak is bounded by TTL; Target 12's admin reset is a runbook update plus a one-line fix). The remaining 17 fixes are robust under adversarial inputs.

The Wave 6 set is **substantially safe to ship** — two pre-merge edits land it cleanly.
