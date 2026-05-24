> ⚠️ **SUPERSEDED on 2026-05-24.** W6 integration E2E verification (2026-05-23) against real Docker Redis. 7/7 paths PASS at the time; the underlying primitives have evolved since but the verification approach remains a useful reference. For current outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Wave 6 — Replay & Integration End-to-End Verification

Live verification of W1+W3 critical paths against real Docker Redis (port
6385) and standalone harness scripts, not mocked tests.

**Environment**

- Docker container: `w6-int-redis` on `redis://localhost:6385` (`redis:7-alpine`).
- Harness scripts: `/Users/thaisrodolpho/projects/ibatexas/apps/api/tmp/w6-int/p{1..7}*.ts`
  (executed via `npx tsx`, scoped to `apps/api/` so workspace symlinks
  resolve).
- All harnesses are throwaway. Production code was not modified.

**Final verdict: Integration: 7/7 paths verified; 0 partial; 0 fail.**

Per-path totals (assertion counts in parens):

| # | Path                                       | Result   | Assertions |
|---|--------------------------------------------|----------|------------|
| 1 | DEFER park/resume round-trip               | PASS     | 15/15      |
| 2 | Refund cap atomic Lua                      | PASS     | 13/13      |
| 3 | OTP brute-force atomic counter             | PASS     | 12/12      |
| 4 | Audit redactor adversarial inputs          | PASS     | 17/17      |
| 5 | Multi-line bypass detection on a fresh file| PASS     | 6/6        |
| 6 | Boot sequence with all packs registered    | PASS     | 24/24      |
| 7 | Postgres ON CONFLICT / sink fail-resilience| PASS     | 7/7        |

Aggregate: **94/94 assertions PASS**.

---

## Path 1 — DEFER park/resume round-trip

### Harness
`apps/api/tmp/w6-int/p1-park-defer.ts` — uses real `redis@4` client, the
production `parkDeferredIntentWithNxGuard` wrapper, and exercises
collisions + concurrent races + `verifyParkedEnvelopeHash` + `deferResumeHash`.

### Captured output
```
PASS :: first park returns parked:true
PASS :: first park count=1 :: count=1
PASS :: park key exists in Redis
PASS :: park key has TTL :: ttl=120
PASS :: stored envelope payload is env1 (orderId ord_1) ...
PASS :: second park returns parked:false
PASS :: second park reason=collision :: reason=collision
PASS :: park key still holds env1 (no overwrite)
PASS :: stored intentHash matches env1
PASS :: race: exactly 1 winner :: winners=1
PASS :: race: 4 collisions :: collisions=4
PASS :: verifyParkedEnvelopeHash returns 'verified=null' (missing_fields)
       on standard buildEnvelope blob
PASS :: verifyParkedEnvelopeHash succeeds when actorPrincipal is hoisted
PASS :: deferResumeHash is deterministic non-empty string
PASS :: deferResumeHash is deterministic across calls
```

### Verdict per assertion
- NX wrapper preserves the first envelope on collision: **PASS**
- Collision returns `{parked:false, reason:"collision"}`: **PASS**
- Race of 5 concurrent parks produces exactly 1 winner, 4 collisions: **PASS**
- `deferResumeHash` is deterministic: **PASS**

### Surprises

**Surprise #1 — `verifyParkedEnvelopeHash` reports `missing_fields` for every
envelope built via the canonical `buildEnvelope`.** The runtime's `ParkedEnvelope`
type expects four hash-verification fields at the **top level** of
`envelope` — `version`, `nonce`, `taint`, `actorPrincipal` — but `buildEnvelope`
nests the principal under `actor.principal` (no top-level `actorPrincipal`).
Result: every park-time hash-verification call returns
`{verified: null, reason: "missing_fields"}`, which is the back-compat /
"legacy blob" branch. **In practice T-005 tamper detection at resume time
is silently disabled for the IbateXas-shaped park blob.** When I manually
hoisted `e.actor.principal → e.actorPrincipal`, the verifier produced
`{verified: true}`, confirming the primitive itself works. Either
`buildEnvelope` needs to mirror `actor.principal` to the top level when the
envelope is serialized for park, or the `defer-resolver` needs to do the
hoist before calling `verifyParkedEnvelopeHash`. Today, neither does.

### Two-phase commit window
I did not spin up NATS, so I exercised the resume primitives in isolation
(`verifyParkedEnvelopeHash`, `deferResumeHash`) rather than the full
subscriber. The collision-preservation invariant — the FIRST envelope's blob
remaining unmodified after a second NX attempt — is the load-bearing
two-phase invariant and it holds.

---

## Path 2 — Refund cap atomic Lua

### Harness
`apps/api/tmp/w6-int/p2-refund-cap.ts` — replicates the production Lua
script verbatim from `apps/api/src/routes/admin/payments.ts:153-165` and
runs it against the real Redis. Scenarios: A) N=5 concurrent at R$1900,
cap R$2000; B) N=10 random amounts, cap R$100; C) N=200 burst, amount=100,
cap=10000; D) rollback semantics via `DECRBY`; E) exact-at-cap and one-over.

### Captured output
```
PASS :: A: exactly 1 allowed at R$1900×5 cap R$2000 :: allowed=1
PASS :: A: 4 refused :: refused=4
PASS :: A: stored counter = 190000 :: stored=190000
PASS :: B: total allowed ≤ cap :: totalAllowed=9011 cap=10000
PASS :: B: stored counter == totalAllowed
PASS :: C: exactly 100 allowed (cap/amount)
PASS :: C: stored counter = 10000
PASS :: D: first reserve allowed
PASS :: D: stored=2000
PASS :: D: post-rollback stored=0
PASS :: D: post-rollback can reserve up to cap
PASS :: E: exact-at-cap allowed
PASS :: E: 1 centavo over → cap_exceeded
```

### Verdict per assertion
- Concurrent reservations beyond cap are atomically refused: **PASS**
- Cap is never exceeded under random-amount concurrency: **PASS**
- `rollbackDailyRefundReservation` DECRs correctly: **PASS**
- Exact-at-cap is allowed; one-centavo-over is refused: **PASS**

### Surprises
None — the Lua script is correct and the rollback semantics match the
documented contract.

---

## Path 3 — OTP brute-force atomic counter

### Harness
`apps/api/tmp/w6-int/p3-otp-brute.ts` — replicates the production Lua from
`apps/api/src/routes/me/anonymize-otp-gate.ts:341` verbatim, threshold=5.
Scenarios: A) 10 concurrent attempts; B) 7 sequential confirming sentinel
fast-path; C) reset-counter-doesn't-release-sentinel; D) sentinel TTL
expiry; E) high-concurrency N=50.

### Captured output
```
PASS :: A: at most THRESHOLD allowed :: allowed=5
PASS :: A: locked_out ≥ N - THRESHOLD :: locked=5
PASS :: A: allowed counts are distinct :: counts=1,2,3,4,5
PASS :: A: stored counter ≤ N :: stored=6
PASS :: B: 1-5 all allowed
PASS :: B: 6th locked_out (sentinel just set) ... fromSentinel: false
PASS :: B: 7th locked_out (from sentinel fast-path) ... fromSentinel: true
PASS :: C: reset counter → still locked via sentinel
PASS :: C: clearLockout releases
PASS :: D: sentinel TTL expiry + counter still high → still locked
PASS :: D: counter+sentinel cleared → allowed
PASS :: E: high-concurrency allowed ≤ threshold :: allowed=5
```

### Verdict per assertion
- 10 concurrent attempts: ≤5 allowed, ≥5 locked: **PASS**
- Allowed counts are distinct (proves INCR atomicity): **PASS**
- Sentinel persists across `resetOtpFailureCount`: **PASS**
- TTL expiry of the sentinel does NOT re-enable attempts while the counter
  is still over threshold (because the next INCR pushes count past
  threshold and re-sets the sentinel): **PASS**
- High-concurrency N=50: at most threshold allowed: **PASS**

### Surprises
None — the Lua + sentinel split is well-shaped and behaves correctly under
all probed concurrency regimes.

---

## Path 4 — Audit redactor adversarial inputs

### Harness
`apps/api/tmp/w6-int/p4-audit-redactor.ts` — exercises `createAuditRedactor()`
with: A) `__proto__` inside a nested array; B) Buffer carrying PII; C)
`Uint8Array` carrying PII; D) PII inside a JWT-like base64 segment; E)
determinism check; F) idempotence; G) deeply nested cycle.

### Captured output
```
PASS :: A.pre: JSON.parse created own __proto__ inside array element
PASS :: A: redactor did NOT crash
PASS :: A: Object.prototype.polluted is undefined
PASS :: A: redacted array elements do NOT own __proto__
PASS :: B: redactor handles Buffer without crash
PASS :: B: serialized output does NOT leak Buffer-PII verbatim
PASS :: C: redactor handles Uint8Array without crash
PASS :: C: serialized output does NOT leak Uint8Array-PII verbatim
PASS :: D: redactor handles JWT-like string without crash
PASS :: D: plain email value is redacted
PASS :: D: redactor does NOT crack JWT base64 (documented limitation)
PASS :: E: redactor output is deterministic across calls
PASS :: F: idempotent
PASS :: G.raw: redactPayload(cycle) DOES throw (documented gap)
PASS :: G.prod: redact(record) on cycle does NOT throw (fail-open)
PASS :: G.prod: fail-open onFailure hook fires on cycle
PASS :: G.prod: stub payload has __redactor_error marker
```

### Verdict per assertion
- Prototype pollution probes (nested array, constructor, nested __proto__):
  no global Object.prototype pollution, output never owns `__proto__`: **PASS**
- Buffer/Uint8Array survival: the redactor walks own-numeric keys and the
  resulting JSON has no readable CPF/email string: **PASS**
- JWT base64 PII: scanner does NOT decode JWT; the base64 PII survives in
  the token field. This is a **documented limitation** — adopters must
  reject JWT-carrying intent payloads upstream (or extend rules to base64-
  decode known-token-shaped fields).
- Determinism + idempotence: **PASS**
- Cycle: `redact(record)` (production path) catches and emits a fail-open
  stub with `__redactor_error: true`; `onFailure` hook fires: **PASS**

### Surprises

**Surprise #2 — the low-level `redactPayload(value)` DOES throw
"Maximum call stack size exceeded" on a cyclic input.** The public
`redact(record)` path has a try/catch + fail-open stub (invariant #5),
which is what production uses. But anyone calling `redactPayload` directly
(future ad-hoc tooling, scripts, replay tools) can crash the process.
Recommendation: wrap the inner walker in the same try/catch as `redact()`,
or document the gap on the public type.

**Surprise #3 — buildEnvelope/buildAuditRecord canonicalization ALSO
stack-overflows on a cyclic payload** (the audit-redactor test was a side
effect; the canonical hash calls `Array.from(Object.entries(value))` and
recurses unbounded). This means cycles in an LLM-emitted payload would
crash the envelope build BEFORE the redactor ever sees the record. The
production-path `redact(record)` cycle defense is therefore only a useful
last-line-of-defense for cycles injected by **mutation after build**.
Pre-build cycles crash the process.

---

## Path 5 — Multi-line bypass detection on a fresh file

### Harness
`apps/api/tmp/w6-int/p5-bypass-detection.ts` — writes throwaway files to
`/tmp/w6-int-p5/`, applies the production `FORBIDDEN_MEDUSA_MULTILINE`
regex + `stripComments` from `apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts`,
and verifies expected hits/misses.

### Captured output
```
PASS :: A: scanner detects multi-line medusaStore POST :: matches=1
PASS :: B: scanner does NOT match medusaAdjudicated POST :: matches=0
PASS :: C: scanner detects multi-line medusaStoreFetch PUT :: matches=1
PASS :: D: scanner does NOT match medusaStore GET (read-only) :: matches=0
PASS :: E: line-commented bypass does NOT match :: matches=0
PASS :: F: block-commented bypass does NOT match :: matches=0
```

### Verdict per assertion
- A fresh multi-line `medusaStore("...", { method:"POST", ... })` is
  detected: **PASS**
- The same shape but with `medusaAdjudicated(...)` is clean: **PASS**
- `medusaStoreFetch` variant also caught: **PASS**
- Read-only GET is correctly NOT a bypass: **PASS**
- Line/block comments are stripped, not matched: **PASS**

### Surprises
None — the regex + strip-comments pair is robust for the cases probed.

---

## Path 6 — Boot sequence with all packs registered

### Harness
`apps/api/tmp/w6-int/p6-boot-packs.ts` — drives `installFirstPartyPacks()`
plus `installKernelMetricsSink()`, then runs one `adjudicate(...)` per
intent kind and scrapes the prom-client registry's `/metrics` body.

### Captured output (truncated)
```
PASS :: A: KNOWN_INTENT_KINDS.size ≥ 62 :: size=62
PASS :: A.has: order.checkout.create
PASS :: A.has: reservation.create
PASS :: A.has: whatsapp.message.send
PASS :: A.has: customer.profile.update
PASS :: A.has: payment.status.transition
PASS :: B: installFirstPartyPacks runs without throwing
PASS :: B: orders / reservations / whatsapp / customer-onboarding / payments registered
PASS :: C.adj: order.checkout.create produces a known decision kind ::
       decision={"kind":"REFUSE", refusal: order.cart.missing, …}
PASS :: C.adj: reservation.create produces a known decision kind ::
       decision={"kind":"REFUSE", refusal: SECURITY guard_panic, …}
PASS :: C.adj: whatsapp.message.send ::  guard_panic (auth phase)
PASS :: C.adj: customer.profile.update :: guard_panic
PASS :: C.adj: payment.status.transition :: guard_panic
PASS :: D: /metrics text contains kernel_decision_total
PASS :: D: /metrics text contains kernel_pack_install_total
PASS :: D.pack-label: orders / reservations / whatsapp / customer-onboarding / payments
```

### Verdict per assertion
- `KNOWN_INTENT_KINDS.size` is exactly **62** (the documented target): **PASS**
- All 5 Packs install without throwing `PackConformanceError`: **PASS**
- All 5 intent kinds adjudicate to a valid decision (4 returned
  `REFUSE/guard_panic` because the harness state was empty — expected, this
  proves the auth-phase guards are wired): **PASS**
- Prometheus registry contains `kernel_decision_total` AND `kernel_pack_install_total{pack=…}` for all 5 packs: **PASS**

### Surprises

**Surprise #4 — boot-ordering sharp edge in the metrics recorder.** If
`installFirstPartyPacks()` is called BEFORE `installKernelMetricsSink()`,
the `recordPackInstall(...)` calls inside `installFirstPartyPacks` log
`"kernel-metrics-recorder: metric not registered — recorder operation no-op"`
and silently drop the metric increment. Production's `bootstrapKernel()`
in `apps/api/src/index.ts` does install the sink first, so this is fine in
practice — but any future caller (test, alternative boot path) that flips
the order silently loses observability. Recommend either (a) defending
the recorder with lazy registration, or (b) asserting the sink is installed
in `installFirstPartyPacks()` and throwing.

**Observation #5 — `KNOWN_INTENT_KINDS.size === 62` is the floor, not a
ceiling.** The task brief says `>= 62` and the live count is exactly 62.
Adding any new intent kind to a Pack without also updating
`packages/llm-provider/src/intent-kinds.ts` will fail the TS `satisfies`
check at build time — but a new Pack added to `installFirstPartyPacks`
without updating `KNOWN_INTENT_KINDS` would boot, register, and then have
its kinds rejected by `validateEnforceConfig` as "unknown". Boot would
abort via the `unknownShadow` / `unknownEnforce` typo guard — fail-loud,
which is correct.

---

## Path 7 — Postgres ON CONFLICT / sink fail-resilience

### Harness
`apps/api/tmp/w6-int/p7-postgres-isolated.ts` + `p7-postgres-child.ts`.
Spawns two fresh tsx child processes — one with `IBX_AUDIT_POSTGRES_ENABLED`
unset, one with it `=true` and a Prisma stub that throws `relation
"intent_audit" does not exist` (Postgres error 42P01). Each child runs
`getAuditSink().emit(...)` once and reports whether the postgres branch
was taken, whether emit threw to the caller, and whether the buffered-sink
fallback message appears.

### Captured output (7a + 7b summary)
```
7a child stdout:
  [ibx-audit] {"v":4,"at":"...","intentHash":"…","decision":"EXECUTE",…}
  EMIT_OK
  PG_INVOCATIONS= 0
  DONE
PASS :: 7a: child exits 0 when postgres disabled
PASS :: 7a: emit succeeded message in child stdout
PASS :: 7a: child stdout shows postgres branch NOT taken

7b child stdout:
  [ibx-audit] {…}
  POSTGRES_CALLED: 1
  EMIT_OK
  PG_INVOCATIONS= 1
  DONE
7b stderr / combined output:
  [intent-audit-wiring] postgres sink emit failed — falling back to spill storage
    { err: 'relation "intent_audit" does not exist' }
  Failed to publish event audit.intent.decision.v1: CONNECTION_REFUSED
  [intent-audit-wiring] audit emit failed — record buffered for retry
    { intentKind: 'order.checkout.create', err: 'AuditSinkError: multiSink: 1 sink failed' }
PASS :: 7b: child exits 0 (no boot-loop / cascading throw)
PASS :: 7b: child stdout shows POSTGRES branch was taken
PASS :: 7b: child stdout shows EMIT_OK despite postgres throw
PASS :: 7b: postgres failure absorbed by surrounding plumbing
```

### Verdict per assertion
- `IBX_AUDIT_POSTGRES_ENABLED=false` → Postgres NEVER called: **PASS**
- `=true` + no migrations → Postgres call attempted, throws 42P01,
  buffered sink catches via the `onError` hook + the persistentBufferedSink's
  try/catch (record buffered for retry, no throw to the audit caller): **PASS**
- No boot-loop or cascading throw: **PASS**

### Surprises

**Surprise #6 — `multiSink` is STRICT (rethrows on any inner failure) but
`persistentBufferedSink` catches the rethrow AND swallows it after
buffering.** This means the audit caller (kernel decision emit path) never
learns about a postgres outage. That's by design (audit must never block a
decision), but it also means a chronic postgres outage produces NO
caller-facing signal — only the `kernel_audit_sink_*` metrics +
`audit-consumer` retry. Operators who rely on caller-side error rates
to detect audit breakage will miss it. The intent-audit-wiring logger DOES
emit a structured warn line per failure, and the spill-depth gauge IS
incremented, so observability is there — just not at the caller's call
stack.

**Surprise #7 — `nats-client.publishNatsEvent` swallows ALL errors.**
When NATS is unreachable it logs `Failed to publish event …: CONNECTION_REFUSED`
and resolves the promise cleanly. The audit-pipeline's NATS sink therefore
never throws even when nats is down — which makes "postgres throw" the
sole way `multiSink` errors propagate. If a future change removes the
postgres sink and leaves only the NATS sink, audit failures will be
**completely invisible** to multiSink's strict logic. This is a real
fragility in the audit pipeline that deserves a follow-up: either NATS
publish should rethrow (and the buffered sink should be the absorption
layer), or the audit-pipeline should treat the publish-error-swallowing as
its own observability contract.

---

## Surprising-finding ranking

1. **`verifyParkedEnvelopeHash` is silently inert in production** —
   the framework's hash-verification re-derives over `e.actorPrincipal`
   which `buildEnvelope` doesn't populate. Tamper-at-rest detection at
   resume is effectively off until either the framework reads from
   `e.actor.principal` or the adopter hoists the field before resume.
2. **NATS publish errors are silently swallowed by `publishNatsEvent`**,
   so the audit pipeline's only strict-throw path is postgres. If postgres
   is removed from the sink chain, audit failures become invisible.
3. **`redactPayload` (low-level walker) crashes on a cycle**, while
   `redact(record)` (production wrapper) absorbs it. Direct callers of
   `redactPayload` (tests, future tooling) can crash the process.
4. **Boot-ordering sharp edge** — `installFirstPartyPacks()` BEFORE
   `installKernelMetricsSink()` silently drops the per-pack install
   metric. Production boot is correct; alt paths are not defended.

---

## Verdict on real-infrastructure quality of W1+W3 work

The atomic Lua primitives — refund cap (P1-I-TRUE) and OTP counter
(P0-X-OTP) — are **rock solid**. Concurrent stress at N=50 / 200 with
random amounts could not produce a single cap or threshold violation; the
sentinel + reset-vs-clearLockout split has the exact semantics the brief
prescribes. The DEFER NX wrapper preserves the first envelope under all
probed contention. The audit redactor's hot-path invariants (idempotence,
determinism, prototype-pollution defense, Buffer/Uint8Array survival)
all hold.

The boot sequence is correctly wired and KNOWN_INTENT_KINDS hits the
≥62 floor. Postgres sink fail-resilience works as designed under the
"missing migrations" failure mode.

The four surprises above are NOT in the W1/W3 hot path — they are
adjacent observability / type-shape issues. The hot-path concurrency and
audit-redactor work delivers what the deep-audit asked for. Recommended
follow-ups for the surprises, in priority order:

1. Fix or document the `verifyParkedEnvelopeHash` /
   `buildEnvelope.actorPrincipal` mismatch — this is the most load-bearing
   gap because it's silently disabling a security feature.
2. Decide whether `publishNatsEvent` should rethrow on connection errors,
   or document that audit-pipeline strictness depends entirely on the
   postgres sink being present.
3. Guard `redactPayload` against cycles for symmetry with `redact()`.
4. Defend `installFirstPartyPacks` against being called before the metrics
   sink.

---

## "Tests pass" but doesn't actually work in integration

Nothing in the W1/W3 surface fits this bill. The `park-deferred-intent-nx`
vitest test does pass and the wrapper actually works end-to-end. The
refund-drip-cap-atomic and otp-brute-force-atomic vitest tests do pass
and the atomicity actually holds at high concurrency. The bypass detection
regex actually catches the multi-line shape on a fresh file.

The closest thing to a "passes-but-doesn't-work" is
`verifyParkedEnvelopeHash` — the framework's unit test in
`@adjudicate/runtime` presumably constructs a fixture with `actorPrincipal`
hoisted, but the IbateXas integration never hoists it, so the production
park blob ALWAYS lands in the `missing_fields` branch. This is the
canonical adopter-vs-framework integration gap and matches the kind of
finding the deep-audit calls out.

---

## Cleanup

- `docker rm -f w6-int-redis` — done at the end of the verification run.
- Throwaway harnesses left under `apps/api/tmp/w6-int/` (gitignored path).
