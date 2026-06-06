> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover test-quality audit (2026-05-23). Findings on unit-tests-in-disguise integration tests drove Wave-7 fault-injection suite and the 6 conformance suites (T1, T2, T3, T5, T6, T7). For current test coverage and outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Test Quality & Assertion Depth Audit

> Audited 2026-05-23 by the Test Quality & Assertion Depth Auditor agent.
> Surface area: 235 `*.test.ts` files (excluding `dist/`), ~286 use `vi.mock`/`vi.fn`.

## Methodology

For each file I read the full source (no `grep -A` shortcuts), traced what is
mocked vs what is exercised, and then answered three questions:

1. **What does this test CLAIM to verify?** (from the doc-block + test name)
2. **What does it ACTUALLY exercise?** (from the inputs and the call graph)
3. **What would change if I broke production?** (would the test fail?)

The third question is the load-bearing one. A test whose assertion can be
satisfied by a constant string return from a stub is theater, regardless of
how many fixtures the suite enumerates.

I spot-checked ~30 high-risk files, focused on the W2-W6 additions and the
audit-08 "coverage gap" tasks the migration agent claimed to have closed.

---

## High-risk file audit (per test file)

### 1. `apps/api/src/__tests__/integration/lgpd-anonymize-lifecycle.test.ts` (W6-1)

Claim: "Composes the route → DEFER park → defer-timeout-sweeper → grace-resolver
subscriber → anonymizeCustomer pipeline through a single test … closes 4 P0
gaps simultaneously."

Reality:
- **Not an integration test in the usual sense.** All collaborators are mocked
  at the module boundary: `@ibatexas/domain` (line 91-98), `@ibatexas/tools`
  Redis client (line 100-110), `@ibatexas/llm-provider` audit sink (line 112-114),
  `@ibatexas/nats-client` (line 116-119), `twilio` (line 121-134), and the
  Fastify `requireAuth` middleware (line 136-148).
- The "Redis" is a shared `Map<string,string>` (line 55). No test container,
  no IO, no real expiry semantics (TTLs are recorded but never enforced — the
  test cannot catch a TTL regression where, e.g., the cooldown is set to 30
  seconds instead of 30 minutes; line 287 checks `EX: 30 * 60` is *passed*,
  not that the key actually expires).
- `anonymizeCustomer` is a hoisted `vi.fn()` (line 40). The grace-resolver
  test (line 327) only verifies `mockAnonymizeCustomer.toHaveBeenCalledWith(CUSTOMER_ID)`
  — does NOT verify the customer was actually anonymised. The real
  W4 P0-13 contract (phone hashed, reviews scrubbed, email/cpf nulled) is
  tested separately in `domain/__tests__/anonymize-customer.test.ts` — not
  here. Calling this test "closes P0-13" is misleading.
- The OTP brute-force test (line 375) does exercise the counter→429 path
  correctly, which is the strongest piece of this file.
- The grace-resolver signal-mismatch test (line 412) and no-receipt test
  (line 437) are well-scoped — they catch real regressions in the resolver.

**Verdict:** This file is a useful narrative test of the route + resolver
*flow*, but the "closes 4 P0 gaps" framing oversells it. A real Redis or DB
regression would not surface here. The W6-1 task should be re-labelled as
"flow composition test", not "integration test".

### 2. `apps/api/src/__tests__/integration/multi-pack-supersedes.test.ts` (W6-2)

Reality: Pure `adjudicate()` tests that build envelopes by hand, pass them
to the real policy bundles, and then *manually* construct the audit records
with the `supersedes` link populated by hand (line 166-171). The audit
chain is asserted in memory — it's never written to a sink, never queried
back, never validated against the `intent_audit` consumer schema.

The test demonstrates **the developer believes** the chain is constructed
correctly. It does not verify that the production code path (the actual
follow-on refund publisher inside the cancel handler) actually populates
`supersedes` — because the production publisher is never invoked. This is a
**wrong-subject** test: claims to test the multi-pack chain composition,
actually tests `buildAuditRecord()`'s field plumbing.

### 3. `apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts` (W6-3)

Reality:
- Test 1 (line 109) calls `adjudicate()` directly with the real policy
  bundle. Solid — verifies the kernel decision is independent of audit
  sink state.
- Test 2 (line 117) injects a failing Prisma writer via
  `_setAuditSinkDependencies` (a test-only mutator on the wiring module).
  This actually exercises the spill path. The assertion that
  `redis._store.get("test:audit:spill:queue")` contains a record is real
  evidence. Good test.
- Test 4 (line 184) — the "route-handler-style flow" — is misleading. It
  doesn't import a route handler. It inlines the if-then ladder *inside the
  test body*, sets `status = 200` unconditionally inside the `if (decision.kind
  === "EXECUTE")` branch, then asserts `status === 200`. The decision is
  always EXECUTE on the supplied state, so the test is a tautology. The
  comment "fail-open at the route boundary" suggests it's testing the route
  contract, but no route exists in the test.

**Verdict:** Tests 1-3 add real value (the spill path is the load-bearing
piece). Test 4 is theater.

### 4. `packages/llm-provider/src/__tests__/kernel-contract.test.ts` (W6 task 20)

Reality: 77 cases, one per intent kind × expected outcome. Each `it()` calls
`adjudicate()` with a real `policyBundle` and asserts the decision kind.

This is one of the few **genuinely high-value** files in the W6 sweep. A
guard regression in any Pack (e.g., removing the allergens REFUSE in
pack-orders) would trip the corresponding case. The assertions are
mostly only on `decision.kind` (not on basis or refusal code), so a guard
that returns the right kind for the wrong reason wouldn't surface — but
the file is honest about its scope.

**Minor concerns:**
- The PIX confirm test (line 1321) `expect(["EXECUTE", "REFUSE"]).toContain(d.kind)`
  is a hedge — the test isn't sure what the Pack will return. That's a
  weak assertion; either the Pack contract is "TRUSTED webhook is EXECUTE"
  or it isn't. Pinning the actual contract would catch a real regression.
- Same with `pix.charge.refund` test (line 1358) — three possible outcomes
  in `expect(["EXECUTE", "REWRITE", "REFUSE"]).toContain(d.kind)`. This is
  too lenient.

### 5. `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts`

Reality:
- The W3 audit claimed the bypass-detection scan was made "multi-line" to
  catch refactored `medusaStore("admin/cart", { method: "POST" })` writes.
- The **scan IS still line-based** (line 197-200: `lines.forEach((text, i) => { ... pattern.test(text) }`).
  Only the `ALLOWED_MEDUSA_DIRECT` curated list check at line 297+ uses
  `content.match()` against whole-file content.
- Verified empirically:
  ```
  await medusaStore(
    "/admin/carts",
    { method: "POST" }
  )
  ```
  splits into 4 lines, none of which individually match
  `/medusaStore\([^)]*['"](POST|PUT|DELETE|PATCH)\b/`. The regex returns
  `false` for every line. A real multi-line bypass would slip through.
- Similarly for `/prisma\.orderNote\.create/`: a refactor that wraps
  the call with the method on its own line (`await prisma.orderNote\n  .create(...)`)
  would not match either.
- The `it("logs suspicious console.log matches… (warning only)")` test
  (line 552) is **explicitly a no-op** — it always passes via
  `expect(true).toBe(true)` (line 564) regardless of findings, only
  writing to stderr. This is a documented warning gate, but it's still a
  test that cannot fail.

**Verdict:** The bypass-detection file's coverage of multi-line bypass
patterns is **strictly weaker than claimed**. The W3 "multi-line bypass
extension" was applied to the carve-out audit only, not to the main scan.

### 6. `packages/pack-payments/src/__tests__/conformance.test.ts`

Claim: "39 fixtures."

Reality: 35 fixtures (counted `^\s*name:` lines). The doc comment says
"30+", which 35 satisfies, but the migration agent's reporting elsewhere
said "39". Minor.

Each fixture passes through real `adjudicate(envelope, state, paymentsPack.policy)`.
The assertions check `decision.kind` and conditionally `refusal.code`,
`signal`, `escalateTo`. These are real value.

The corpus has solid boundary coverage (R$500, R$500.01, R$1000, R$1000.01,
R$5000 — see refund cases). Good.

`runConformance(paymentsPack)` is invoked but only the boolean
`report.passed` is checked. A new conformance check that always passes
would not improve coverage but the test wouldn't catch that — minor risk.

### 7. `apps/api/src/subscribers/__tests__/defer-resolver.test.ts` (W2 + P0-8 extensions)

Reality: Uses an in-memory Redis stub. Mocks NATS at the boundary.

The "two-phase commit" tests at line 464 actually do verify the load-bearing
contract — the dispatcher closure asserts the resuming marker exists
*during* dispatch and the resumed ledger doesn't yet (line 475-483). This is
a clever way to pin intermediate state. Real value.

The "simulated restart mid-resume" test (line 598) is **wrong-subject**.
Its setup comment says "Simulate the post-crash state: pending key is
INTACT … a stale resuming marker exists from the crashed worker". But the
test then writes "Simulate that the crashed worker's resuming marker has
expired (i.e., it's no longer in the store)" and only pre-populates the
pending key — NOT a stale resuming marker. So the test is exercising the
clean retry path (no pre-existing marker), not the orphan-marker recovery.
A bug where the resolver was tripped up by a stale marker would NOT
surface here.

The concurrent-delivery test (line 550) holds the dispatcher mid-flight
with a manual promise, verifies the second delivery short-circuits. This is
a legitimate concurrency test (single-process JS, but it does interleave
microtasks correctly).

### 8. `packages/llm-provider/src/__tests__/envelope-determinism.test.ts` (W6-7)

Claim: "100 concurrent envelope builds".

Reality: `Promise.all(Array.from({length: 100}, () => Promise.resolve(buildEnvelope(sharedInput))))`.

`buildEnvelope` is **synchronous**. `Promise.resolve(buildEnvelope(input))`
calls `buildEnvelope` immediately, then wraps the result in a resolved
promise. There is **no concurrency** — all 100 builds run sequentially in
a single tick. Same for the 1000-build test.

This is **wrong subject**. The test verifies the canonicalizer is
deterministic, not that it's safe under concurrent invocation. (For a pure
synchronous function with no shared state, the two coincide, but the
*claim* is concurrency safety and the *exercise* is determinism.) If
someone later introduced a stateful WeakMap or a shared serialization
buffer, this test wouldn't catch it because they'd still execute one at a
time.

### 9. `apps/api/src/routes/admin/__tests__/force-routes-governance.test.ts` (W6-5 concurrent confirm)

Reality: The "concurrent consume Lua atomicity" suite (line 1425) uses
a mocked `redis.eval` that runs the GET+DELETE *in JavaScript*
(line 55-63). Since JS is single-threaded, the mock trivially satisfies
the "exactly one wins" contract — the mock is **tautological**.

The Lua script never runs. The test verifies what the mock returns when
called twice; it does not verify the production Lua script's
atomicity. A real bug (e.g., the Lua script being deleted and the code
falling back to a non-atomic JS implementation, or the Lua script
having a typo that returned the value without deleting) would not
surface here.

This is the canonical **mock-too-much** case in the suite. The W6-5 task
deliverable should have used an embedded Redis (or at minimum a
`redis-mock` library) to run the real Lua script, not a hand-rolled JS
emulation.

### 10. `packages/llm-provider/src/__tests__/audit-redaction-contract.test.ts` (Task 18 + W4 P0-10)

Reality: 55 fixtures (verified by reading). Each fixture builds a real
`AuditRecord`, redacts it, then scans the redacted JSON for CPF / email /
phone / card patterns. **Solid contract test.**

The W4 P0-10 `actor.sessionId` extension (line 605-636) adds three real
fixtures with sessionId = customerId; the `detectPII` helper (line 645)
explicitly includes `envelope.actor` in the scan. Genuine fix verification.

The P0-15 auditHash recomputation assertion (line 750) is well-shaped — it
verifies `verifyAuditRecord` works on redacted records (the pre-W2 bug
where every redacted record reported `tampered`).

The "no plaintext customerId" assertion at line 826-834 is exactly the
shape the prompt asks for — not just "hashing happened", but explicit
"customerId substring MUST NOT appear in actor JSON" + "sessionId matches
`^hashed:[a-f0-9]{8}$`".

The bypass-detection sub-test (line 933) greps `packages/llm-provider/src/`
for direct sink primitive imports — real source-level invariant
enforcement.

### 11. `packages/nats-client/src/__tests__/nats-client.test.ts` (W4 P0-12)

Reality: 16 tests, all running against a fully mocked `nats` module
(line 14-38). The mock returns the literal strings `"credsAuth"` and
`"nkeyAuth"` for the two authenticators, and the production code path is
"call `nats.connect({authenticator: …, tls: …})`".

The tests assert that the *parameters passed to connect()* match what
the production code constructs. They do NOT verify:
- That a real nats-server with credentials configured would accept these
  parameters.
- That the .creds file contents are parsed correctly (the
  `readFile` mock just returns a stub buffer).
- That the TLS CA is actually used to authenticate the connection.

**Mock-too-much.** The "production auth code path" is not exercised — only
the parameter-construction shim is. A bug where the production code
accidentally swapped `credsAuthenticator(buf)` for
`credsAuthenticator(buf.toString())` would silently pass because the mock
returns the same string regardless.

Several tests have **shape-only** assertions (line 94-96 / 113-116):
`expect(subscription).toHaveProperty("unsubscribe")` — does not verify
that `unsubscribe()` actually unsubscribes, only that the property exists.

### 12. `packages/pack-payments/src/__tests__/refund-magnitude-ladder.test.ts`

Reality: 10 tests with explicit boundary coverage:
- R$0 (zero) → REFUSE ✓
- R$1 (1 centavo above zero) → EXECUTE ✓
- R$500 (boundary inclusive) → EXECUTE ✓
- R$500.01 (just above) → REQUEST_CONFIRMATION ✓
- R$1000 (boundary inclusive) → REQUEST_CONFIRMATION ✓
- R$1000.01 (just above) → ESCALATE ✓
- R$5000 (large) → ESCALATE + `decision.to === "human"` ✓
- amount > refundable → REFUSE
- state-divergent refunded amount → REFUSE with `refund.state_divergent`
- partial refund with prior partial → EXECUTE

**Excellent coverage.** Missing: negative amounts explicitly. The "≤ 0"
case only tests zero, not -1 or -500. Brazilian PIX cannot have negative
refunds, but a typed bypass (e.g., `refundAmountCentavos: -100` cast
from a string) would not be tested here. The conformance test corpus
(line 292) does include `-100`, so the negative case is covered overall,
just not in the ladder file.

### 13. `packages/domain/src/services/__tests__/anonymize-customer.test.ts` (W4 P0-13)

Reality: 12 tests. Mocks `prisma.customer.update`, `address.deleteMany`,
`customerPreferences.deleteMany`, `review.updateMany`,
`customerOrderItem.updateMany`. Each test asserts the call shape.

Strong assertions:
- `call.data.email === null`, `cpf === null`, `medusaId === null` (line 76-78)
- `call.data.name === "Usuário Removido"` (line 86)
- Phone matches `/^anonymized:[a-f0-9]{16}$/` (line 96)
- Phone is deterministic per customerId (line 103-114) — tests retry idempotency
- Phone differs across customers (line 116-127)
- `review.updateMany` clears `comment` to null (line 143-152)
- `customerOrderItem` is delinked (line 154-160)
- Negative PII assertions (line 162-178): JSON.stringify of the update
  payload contains no plaintext customerId, no phone-like, email-like, or
  CPF-like patterns. Excellent.

**One gap:** the test (line 180) `runs all mutations inside a single $transaction`
only asserts that all five mock fns were called — does NOT verify they
were called *inside the transaction wrapper*. A regression where the
review.updateMany call was hoisted out of the `$transaction` callback
would pass this test. The shape would be:
```ts
expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function))
// AND verify that, inside the transaction callback, all 5 ops fire
```
The current shape is weaker than the docstring suggests.

---

## Anti-pattern inventory

### Tautology

- `packages/llm-provider/src/__tests__/audit-emission-contract.test.ts:251`
  — `it("documents the 'no emit on pure-legacy EXECUTE' invariant", () => { expect(true).toBe(true) })`.
  Pure theater.
- `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:564`
  — `expect(true).toBe(true)` in the console-PII warning gate.
- `apps/api/src/routes/admin/__tests__/force-routes-governance.test.ts:1432-1481`
  — concurrent Lua atomicity tested against a JS-emulated mock that
  trivially satisfies "exactly one wins" semantics.
- `apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts:184-218`
  — route-handler test that inlines `status = 200` inside an if-branch
  with deterministic input that always takes that branch.

### Shape-only

- `packages/nats-client/src/__tests__/nats-client.test.ts:94-96,113-116`
  — `expect(subscription).toHaveProperty("unsubscribe")`, `expect(conn).toHaveProperty("publish")`.
- `packages/llm-provider/src/__tests__/no-execute-tool-direct.test.ts:24-27`
  — `expect(mod).not.toHaveProperty("executeToolDirect")` — this is
  **acceptable** because the symbol's presence/absence IS the contract.
- `packages/llm-provider/src/__tests__/audit-emission-contract.test.ts:113-133`
  — asserts only that each Decision kind produces a record with the
  right field shape; does NOT verify the record was emitted to a sink
  (an emit-suppression bug would not be caught here).

### Mock-too-much

- `apps/api/src/__tests__/integration/lgpd-anonymize-lifecycle.test.ts` —
  mocks Domain, Tools/Redis, llm-provider audit sink, nats-client, Twilio,
  and Fastify auth middleware. The only un-mocked surface is the Fastify
  route layer's parameter validation and the meRoutes registration. A
  real DB regression cannot surface.
- `packages/nats-client/src/__tests__/nats-client.test.ts` — mocks the
  entire `nats` module. Production-level auth wire-up is not exercised.
- `apps/api/src/routes/admin/__tests__/force-routes-governance.test.ts`
  — mocks Redis `eval` as JS GET+DELETE. The "Lua atomicity" claim is
  unfalsifiable from this test surface.
- `apps/api/src/subscribers/__tests__/defer-resolver.test.ts` — Redis
  is an in-memory stub; the kernel adjudicate is mocked (line 26 +
  124-132 patch) for some tests, real for others — depends on the test
  case. Mixed.

### Happy-path monoculture

- `packages/llm-provider/src/__tests__/audit-emission-contract.test.ts`
  has 6 Decision kinds × 1 fixture each = 6 happy-path verifications. No
  failure modes (sink-throw, malformed record, missing intentHash, etc.)
  in this file (those are in other files).
- The `kernel-contract.test.ts` has 77 cases but the assertions are
  mostly `expect(d.kind).toBe(…)`. Failure modes are tested for each
  intent kind (REFUSE branches), so this is OK — not pure monoculture,
  but the REFUSE basis codes are mostly not asserted (only kind).

### Silent skips

- `packages/domain/src/services/__tests__/no-direct-prisma-bypass.test.ts:105`
  — `it.skip(`${scanDir}: directory empty or absent`, () => {})`. This is
  the ONLY `.skip` in the live test surface (the `dist/` copy is a build
  artefact). The skip is defensible — it documents that a missing scan
  directory is a no-op, not a failure. Low risk.
- No `if (process.env.CI) return` patterns found.

### Wrong subject

- `apps/api/src/__tests__/integration/multi-pack-supersedes.test.ts` —
  claims to test the cancel→refund follow-on chain; actually tests
  manual `buildAuditRecord` field plumbing. The production follow-on
  publisher is not invoked.
- `apps/api/src/subscribers/__tests__/defer-resolver.test.ts:598` — claims
  to test orphan-resuming-marker recovery; actually tests vanilla clean
  retry.
- `packages/llm-provider/src/__tests__/envelope-determinism.test.ts` —
  claims to test 100 concurrent builds; actually tests determinism under
  sequential invocation.
- `apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts:184`
  — claims route-handler fail-open; actually tests an inlined
  decision-ladder that doesn't reach a route.
- `apps/api/src/routes/admin/__tests__/force-routes-governance.test.ts:1432`
  — claims Lua atomicity; actually tests a JS emulation.

---

## Tests that DO add real value (give credit)

1. **`packages/llm-provider/src/__tests__/kernel-contract.test.ts`** — 77
   real `adjudicate()` invocations against the real policy bundles. A
   guard regression in any Pack fails at least one case here. This is
   the single highest-value file in the W6 sweep.
2. **`packages/llm-provider/src/__tests__/audit-redaction-contract.test.ts`**
   — 55 fixtures + 5 P0-10 sessionId-leak fixtures + bypass-detection
   grep. Catches PII leak, intentHash drift, auditHash recomputation,
   and authorised-sink bypass in one file.
3. **`packages/pack-payments/src/__tests__/refund-magnitude-ladder.test.ts`**
   — explicit boundary coverage at R$0, R$1 cent, R$500, R$500.01,
   R$1000, R$1000.01, R$5000. The boundary precision is exactly what an
   audit auditor wants to see.
4. **`packages/domain/src/services/__tests__/anonymize-customer.test.ts`**
   — strong assertions on every scrubbed field, deterministic-per-customer
   sentinel, no-leak JSON.stringify scan. Best mock-heavy unit test in
   the suite.
5. **`apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts`
   tests 1-3** — actually injects a failing Postgres writer via
   `_setAuditSinkDependencies` and verifies the spill receives the
   record. Real bug-catching power.
6. **`packages/pack-customer-onboarding/src/__tests__/lgpd-anonymize.test.ts`**
   — lifecycle tests at T0, T+1h, T+1h+1s, T+24h+1ms against the real
   policy bundle. Pinning sequenced contract.
7. **`packages/llm-provider/src/__tests__/no-execute-tool-direct.test.ts`**
   — small but does what it claims (import surface check + source grep).
8. **`packages/pack-orders/src/__tests__/conformance.test.ts`** and
   sibling Pack conformance tests — 30+ fixture corpora each, fed through
   `adjudicate()` with real policies.

---

## Recommended test rewrites (specific files)

### High priority

1. **`bypass-detection.test.ts`** — switch the scan from line-based to
   content-based (`content.match` with `g` flag). Add fixtures of
   multi-line `prisma.X.create(...)` and `medusaStore("...", { method:
   "POST" })` calls to a `__fixtures__/should-be-caught/` dir, then
   assert the scanner catches each. Currently a multi-line bypass slips
   through silently.
2. **`force-routes-governance.test.ts`** Lua atomicity suite — replace
   the JS-emulated `eval` with either `redis-memory-server` or an actual
   Redis test container. The current test cannot detect a regression in
   the production Lua script.
3. **`nats-client.test.ts` auth wiring** — add at least one end-to-end
   test using a NATS test container with credentials configured.
   Current tests pass even if the production code passes garbage to
   `connect()`.
4. **`audit-sink-fail-resilience.test.ts` test 4** — either remove the
   "route-handler-style flow" test or replace it with a real
   `app.inject()` call against a Fastify route. Right now it's
   tautological.
5. **`envelope-determinism.test.ts`** — rename to
   `envelope-determinism-sequential.test.ts` and remove the
   "concurrent" wording from the docstring. Or, if real concurrency is
   wanted, use `worker_threads` to actually fork the builds.
6. **`defer-resolver.test.ts:598` (simulated restart)** — pre-populate
   a stale resuming marker before invoking the resolver. The current
   setup doesn't model the orphan state.
7. **`multi-pack-supersedes.test.ts`** — invoke the real production
   follow-on publisher (the cancel handler that emits `payment.refund.issue`
   on EXECUTE) instead of hand-constructing both envelopes.
8. **`lgpd-anonymize-lifecycle.test.ts`** — re-label as "lifecycle flow
   composition", not "integration test". Add at least one path that
   exercises the real `anonymizeCustomer` (or import the real
   `customer.service.ts` and verify the prisma mock receives the right
   shape), so the file actually exercises P0-13.

### Medium priority

9. **`audit-emission-contract.test.ts:244`** — remove the
   `expect(true).toBe(true)` documentation test. If the invariant is
   load-bearing, write a real test for it. If it's not load-bearing,
   delete the test.
10. **`kernel-contract.test.ts`** PIX confirm + refund — replace the
    `expect([...]).toContain(d.kind)` hedges with explicit single-kind
    assertions. The Pack contract should be precise.
11. **`anonymize-customer.test.ts:180`** — assert the five mutations
    happen *inside* the `$transaction` callback, not just that they
    were called.

---

# Return value — summary

## Estimated bug-catcher % vs theater

Across the ~30 high-risk files I read deeply, my estimates:

- **Real bug-catchers (would fail on a corresponding production regression):** ~55%
- **Partial value (catch some regressions but mock too much):** ~30%
- **Theater / wrong-subject / tautology (would pass even if production was broken):** ~15%

Extrapolating to the full ~2,800 tests (only sampled, not exhaustive), I'd
estimate ~50-60% are real bug-catchers, ~25-35% partial, ~10-15% theater.
The newest W6 additions skew worse than the older suite — agents who wrote
W6 optimised for the "task acceptance criterion" (e.g., "≥ 60 cases", "≥
50 fixtures") rather than for assertion strength.

## Top 10 misleading tests (claim more coverage than they have)

1. `lgpd-anonymize-lifecycle.test.ts` — claims "closes 4 P0 gaps simultaneously";
   actually closes the OTP brute-force gate and the grace-resolver no-receipt
   branch. The other gaps are covered by sibling files, not by this one.
2. `multi-pack-supersedes.test.ts` — claims to test the cancel→refund
   chain; actually tests `buildAuditRecord()` field plumbing with hand-
   constructed envelopes.
3. `envelope-determinism.test.ts` — claims 100 concurrent builds; actually
   tests 100 sequential builds. (`Promise.resolve(buildEnvelope(...))`
   executes synchronously.)
4. `force-routes-governance.test.ts` lines 1432-1547 — claims to verify
   Lua atomicity under concurrent confirm; actually verifies a JS
   emulation of GET+DELETE.
5. `nats-client.test.ts` P0-12 suite — claims to test the production auth
   code path; actually tests that string parameters reach `nats.connect()`.
6. `audit-sink-fail-resilience.test.ts` test 4 — claims to test route-
   handler fail-open; the test never invokes a route.
7. `bypass-detection.test.ts` (W3 multi-line claim) — the scan is still
   line-based for the main checks; multi-line bypass writes slip through.
8. `audit-emission-contract.test.ts:244` "documents the no-emit invariant"
   — `expect(true).toBe(true)`.
9. `defer-resolver.test.ts:598` "simulated restart mid-resume" — does
   not actually simulate the post-crash orphan marker state.
10. `kernel-contract.test.ts` PIX confirm/refund cases — use
    `expect([...]).toContain(d.kind)` hedges that allow EXECUTE OR REFUSE
    OR REWRITE to all pass.

## Top 5 exceptionally good tests

1. **`kernel-contract.test.ts`** — 77 real adjudications across all Packs.
2. **`audit-redaction-contract.test.ts`** — 55 fixtures + PII scanner with
   sentinel-stripping + explicit no-leak negative assertions + P0-10
   sessionId hash verification + bypass-detection grep.
3. **`refund-magnitude-ladder.test.ts`** — explicit boundary precision at
   R$0, R$1cent, R$500, R$500.01, R$1000, R$1000.01, R$5000.
4. **`anonymize-customer.test.ts`** — strong per-field assertions,
   deterministic sentinel, idempotency, no-leak JSON.stringify scan.
5. **`pack-*/conformance.test.ts` files** (orders, payments, reservations,
   customer-onboarding, whatsapp, pix) — 30+ fixture corpora, each fed
   through real `adjudicate()` calls. The pattern is consistent and
   high-value.

## Verdict — real test-coverage strength

The codebase has **solid policy-layer coverage** (kernel-contract +
pack-*/conformance) and **solid PII-redaction coverage** (audit-redaction-
contract + anonymize-customer). These three files alone (1.5% of the test
count) carry most of the real safety net.

The codebase has **weak integration coverage**. What's labelled
"integration test" is mock-heavy unit composition. The migration's "fail-
open at Redis/Postgres outage" claims are not actually exercised against
real infrastructure; they're exercised against in-memory stubs of the
desired behaviour.

The codebase has **misleading concurrency coverage**. The two W6
"concurrent" tests (envelope-determinism and Lua atomicity) do not
actually exercise concurrency — one runs sequentially, the other tests a
JS emulation.

For the kernel migration's enforce-mode gate: the kernel-contract suite is
strong enough to catch policy regressions. The bypass-detection regex
suite is weaker than claimed (line-based scan that misses multi-line
patterns) — this is the biggest risk in the migration's safety story.
The "integration tests" do NOT give the confidence their label suggests;
treat them as compositional unit tests when planning rollout gates.
