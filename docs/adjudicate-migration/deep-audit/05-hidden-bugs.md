# Hidden Bugs & Edge Cases Audit

Auditor: Staff engineer. Method: enumerate input dimensions for each high-risk function, walk the unhappy values, and pursue branches the existing test suite does not exercise. Code is NOT modified — every finding is a recorded observation.

---

## Executive summary

The kernel-migration scaffolding is impressively defensive on the hot path, but several entire categories of input remain unguarded:

1. **Empty-string** values for "principal" identifiers (`customerId`, `staffId`) sneak through every `!= null` / `if (x)` predicate inconsistently. Three distinct codepaths read them as opposite truthy/falsy in the same flow.
2. **NaN / Infinity / MAX_SAFE_INTEGER** centavos amounts. `refundMagnitudeGuard` checks `<= 0` and compares against `refundable`. `NaN > anything` is `false`, so a `NaN` refund slips past the over-balance check and continues to the magnitude ladder. `payload.refundAmountCentavos > escalateThreshold` is `false` for `NaN` → falls through to `EXECUTE`.
3. **Audit-redactor regex order** is documented to put PHONE before CARD, but the PHONE callback returns the match unmodified for short digit runs — and CARD_RE then re-eats long sequences. Numeric strings of 13–19 digits with no separators get masked as CARD even when they are order IDs, intentHashes, or analytics nonces.
4. **The "integration" tests at `apps/api/src/__tests__/integration/`** are unit tests in disguise. `lgpd-anonymize-lifecycle.test.ts` mocks Redis, NATS, Twilio, Prisma, AND the actual `anonymizeCustomer` mutator. The W6-1 test cannot catch any of the W4 anonymize-completeness regressions because the destructive call is replaced by `vi.fn()`.
5. The **defer-resolver** ALWAYS uses `PIX_CONFIRMATION_SIGNAL` to fan out on `payment.status_changed`, but the subscriber sweeps EVERY `defer:pending:*` key (including `customer.anonymize.*` parks) on every PIX confirmation — generating O(N) signal_mismatch reads per webhook delivery.
6. **`anonymizeCustomer` runs all five writes in a single `prisma.$transaction`**, and on a customer with thousands of reviews it will exceed the default Postgres transaction timeout, leaving the customer in a half-anonymized state (`name="Usuário Removido"`, `phone="anonymized:..."`, but `address`/`review`/`customerOrderItem` rows un-touched). LGPD obligation NOT satisfied; no remediation hook.

---

## Per-target findings

### 1. `packages/llm-provider/src/llm-responder.ts`

- File: `packages/llm-provider/src/llm-responder.ts`
- Bugs found:
  - **line 276 `intentIdentity = block.name`** — `block.name` can be the empty string if the Anthropic SDK delivers a malformed tool_use block. `TOOL_CLASSIFICATION.MUTATING.has("")` is `false`, so the planner-violation gate is skipped and the empty-named tool falls through to `executeWithRetry("", input, ctx, …)` which then yields `Tool "" not found` from the registry. Mild — the registry refuses — but `NON_RETRYABLE_TOOLS.has("")` is `false` so the empty name gets the retry loop with exponential backoff, burning 200+400+800 ms of latency on a poisoned chunk. Severity: low.
  - **line 308 `const hash = result.intent.envelope?.intentHash`** — when undefined (envelope is not built) the ledger consult is skipped and the audit emit and dispatch still proceed. The dispatch happens against a malformed intent with no idempotency key. Severity: medium. Tests: none cover envelope-less intent.
  - **line 412 `void getAuditSink().emit(record).catch(...)`** — uses `void` + `.catch`. If `getAuditSink()` ITSELF throws synchronously (e.g. the redactor singleton constructor blows up on first call), no catch fires. The `try/catch` at 401 wraps `buildAuditRecord` but NOT `getAuditSink()`. Severity: low (rare path) but the audit-but-no-dispatch invariant breaks asymmetrically — dispatch can occur with no audit, contradicting the design comment at lines 366–369. Note: comment says "Audit-but-no-dispatch is the design"; the reverse (dispatch-but-no-audit) is, indeed, achievable through a synchronous throw inside `getAuditSink()` because the dispatcher runs at line 442 AFTER the audit emit attempt.
  - **lines 430-494 EXECUTE branch** — dispatch return value `dispatchResult` is checked for `"failed"`. The dispatcher signature returns `Promise<DispatchResult | void> | DispatchResult | void`, so the runtime check `dispatchResult && dispatchResult.kind === "failed"` correctly handles void. BUT a dispatcher that synchronously returns `null` (typo for `undefined`) — `null && anything` is `null`, falsy — silently succeeds. No type-runtime guard.
  - **line 596 `resolveLocalizedRefusalText(decision, localizedDecision)`** — passes both raw `decision` and the localized one. If `localizedDecision.kind === "REFUSE"` but `decision.kind !== "REFUSE"` (shouldn't happen per `localizeDecision` contract but is not asserted), behaviour is undefined.
  - **line 692 `if (digits.length >= 10 && digits.length <= 13)`** in `redactString`: a 14+ digit phone (e.g. some international long-form) is left as the matched substring — but the CARD_RE next pass at line 697 with `digits.length >= 13` catches it and returns `[REDACTED:CARD]`. That is a phone misclassified as a card. Severity: low (still redacted) but misleading audit forensics.
  - **lines 175–186 `streamTextDeltas`** — iterates `for await (const event of stream)`. If the stream errors mid-iteration the generator rethrows; the caller at line 803 (`yield* streamTextDeltas(stream)`) propagates it into the outer try/catch, which then yields `Erro ao processar` — fine. But the assistant message at line 948 (`messages.push({ role: "assistant", content: finalMessage.content })`) is added AFTER stream finishes. If the stream succeeded text-side but then `finalMessage()` throws, the conversation history desyncs from what the user already saw, and the next turn will replay tool calls without the assistant message in context. Severity: medium.

### 2. `packages/llm-provider/src/audit-redactor.ts`

- File: `packages/llm-provider/src/audit-redactor.ts`
- Bugs found:
  - **lines 559-637 `walk` over an object with circular reference** — there is NO cycle detection in `walk`. A payload like `const p = { a: 1 }; p.self = p;` produces `RangeError: Maximum call stack size exceeded`. The outer `try/catch` at line 363 catches it and replaces with `{__redactor_error: true}` per invariant #5 — but the catch handler ALSO calls `recomputeAuditHash` which writes `Object.keys` over the stub. The stub is non-circular so it's fine. Severity: medium — fail-open is honored but the design comment says "Idempotent — `redact(redact(record))` deep-equals" and circular inputs violate that. Worth a stack-overflow regression-test.
  - **line 562 `for (const rawKey of Object.keys(obj))`** — does NOT iterate `__proto__` as a regular key (it's a setter, not own-enumerable). HOWEVER, an object like `{"__proto__": {polluted: true}, name: "x"}` parsed from JSON.parse DOES have `__proto__` as an own key — `Object.keys(JSON.parse('{"__proto__":{"polluted":true},"name":"x"}'))` returns `["__proto__","name"]`. The redactor will then `out["__proto__"] = walk(...)` which sets the prototype, NOT a property, of the output object. Result: prototype pollution **survives redaction** and the redacted payload's prototype is whatever the walker returned. If a downstream sink does `for (k in record.envelope.payload)` it will see the polluted keys. Severity: HIGH (prototype-pollution propagation) — the redactor was supposed to be the PII gate but it's a vector for poisoning the audit consumer process.
  - **line 197 `MAX_STRING_LENGTH = 500`** — a 100 KB payload string is truncated to 500 chars + `[REDACTED:TRUNCATED]`. The regex defenses run AFTER truncation, so the truncation suffix can collide with the CARD_RE for any 13-digit sequence inside the first 500 chars. Edge: harmless.
  - **CPF in scientific notation** — `cpf: 1.2345678900e10` is a `number`; `walk` hits the `typeof v === "number"` branch via the `redactFields.has("cpf")` lookup at line 575 → coerces to sentinel. Caught.
  - **CPF as bigint** — `cpf: 12345678900n` — `typeof === "bigint"` → caught by line 581.
  - **CPF inside `__proto__.cpf`** — sees prototype-pollution propagation above. SEVERITY HIGH.
  - **Field name with prototype-key** — `{"constructor": {...}, "valueOf": "..."}`. Walker does `obj[rawKey]` which retrieves the OWN property, fine.
  - **lines 233 CPF_RE** — the regex requires CPF to NOT be preceded or followed by `[\d.-]`. A CPF embedded in a longer hash like `"hash:12345678900-foo"` is preceded by `:` (OK) and followed by `-foo` (OK because `-` IS in the negative lookahead). Wait, the lookahead is `(?![\d.-])` — `-` matches, so the assertion FAILS, meaning the CPF is left alone if followed by `-`. Bug: a CPF concatenated with a hyphen (`"12345678900-X"`) is NOT redacted. Severity: medium (defense-in-depth bypass).
  - **lines 246 CARD_RE: `(?<!\d)(?:\d[\s-]?){13,19}(?!\d)`** — matches arbitrary 13-19 digit sequences. **Order IDs, intent hashes (any 32-char hex starts with digits), unix timestamps with milliseconds (13 digits)**, all get masked as `[REDACTED:CARD]`. Audit replay tooling that grep-searches by `intentHash` will MISS records where the intentHash happens to be all-digit (rare, but a 13-digit ms-precision timestamp is common: `1700000000000`). Severity: medium for forensics.
  - **line 705 `hashValue` salted SHA-256 truncated to 8 hex chars** — 4 billion buckets, so ~1 in 65 K chance of collision per 1000 records (birthday paradox). For a million customers, collisions are GUARANTEED — multiple customers will hash to the same `hashed:xxxxxxxx`, defeating audit correlation. Severity: medium-low (correlation tolerates dupes; just less unique).
  - **`AUDIT_REDACT_SECRET` env var unset** — line 337 warns; `hashValue(value, "")` still produces a value (just sha256(value)) — rainbow-table attackable as the comment says.
  - **lines 559 `if (typeof value === "object")`** — `Date`, `Map`, `Set`, `Buffer` instances all fall here. A `Date` is an object with no own keys → walker returns `{}` (empty object), losing the date. A `Buffer` is an object with numeric keys → walker iterates each byte. Severity: low; payloads rarely contain Buffer.

### 3. `apps/api/src/subscribers/defer-resolver.ts`

- File: `apps/api/src/subscribers/defer-resolver.ts`
- Bugs found:
  - **line 356 `parked = JSON.parse(raw) as ParkedEnvelope`** — assumes any object whose parse succeeds matches `ParkedEnvelope`. A blob like `JSON.parse('null')` returns `null`; the next access `parked.signal !== signal` throws `TypeError: Cannot read properties of null`. The catch at 358 wraps `JSON.parse` only; the TypeError fires at line 377. Severity: medium (DLQ pollution).
  - **line 357-372 missing-fields envelope** — if the JSON parses but lacks `envelope` (e.g. `{"signal":"x"}`), then `parked.envelope.intentHash` throws at line 399. Same pattern: not caught.
  - **`verifyParkedEnvelopeHash` mode field** — none. The `resolveDeferredSession` ALWAYS calls `verifyParkedEnvelopeHash(parked)`. There is no `verifyHash: "warn" | "strict"` knob threaded through. `verified === null` (legacy blob) is treated as "proceed" silently per the comment at line 414. A legacy-shaped blob created by an attacker with no verification fields slides through. Severity: medium.
  - **line 423 `redis.get(resumedKey).catch(() => null)`** — the very pattern the file's own P1-D section warns against ("collapsed transient errors into 'no parked envelope', silently dropping PIX confirmations"). This GET happens BEFORE the resuming-slot claim. A Redis blip here treats the resume as not-yet-committed, allowing a duplicate dispatch on retry. Severity: high (regression of the P1-D fix).
  - **line 460 `cap = DEFAULT_MAX_RESUME_CYCLES`** — hardcoded 3. Not env-tunable. A heavy-traffic PIX integration that legitimately churns 4 cycles per intent is REFUSEd silently.
  - **lines 472 `await redis.del(resumingKey).catch(() => {})`** — after cycle cap, the resuming marker is cleared. If the DEL fails silently, the resuming marker holds for 60s; subsequent retries get `duplicate_suppressed`. The cycle counter has already incremented (line 462) but the cycle was REFUSEd. Severity: low.
  - **line 654 `if (!SETTLED_WIRE_STATUSES.has(newStatus))`** — uses the wire-level Stripe status set `{paid, captured, confirmed}`. If a status arrives with weird casing (`"PAID"`), the resolver silently ignores it — but the upstream `payment-lifecycle` subscriber may have already mutated state. Cross-subscriber inconsistency.
  - **line 702 `for (const key of seenKeys)`** — sweeps EVERY parked envelope on every payment.status_changed delivery. Includes `customer.anonymize.confirmed_after_grace` parks, each of which hits `signal_mismatch`. O(N) Redis GETs per webhook. Severity: low (correctness OK, scaling concern).
  - **TTL=0 case**: a key with TTL=0 (just expired) — `redis.get` returns null, treated as `no_park`. OK. But the SCAN may have included a key that expired between SCAN and GET — the resolver returns `no_park` then continues; no audit of "we saw it but it's gone" for ops.

### 4. `apps/api/src/jobs/defer-timeout-sweeper.ts`

- File: `apps/api/src/jobs/defer-timeout-sweeper.ts`
- Bugs found:
  - **line 190 `const ttl = await redis.ttl(key).catch(() => -2)`** — `-1` returned by `ttl` means "no TTL set". The code at 195 says `if (ttl > IMMINENT_TTL_SECONDS) continue` — `-1 > 60` is false, so the loop falls through and TREATS THE KEY AS EXPIRED. A parked-envelope key with no TTL (invariant violation, but possible if a manual `redis.set` was run without EX) would be deleted on the next sweep cycle. Comment at line 188 acknowledges this is intentional ("we treat -1 (no TTL) as expired"), but the comment also says "parked envelopes must always have a TTL" — there is no validation that the SET that originally parked the envelope actually included EX. Severity: medium (silent invariant assumption).
  - **line 211 `JSON.parse(raw) as ParkedEnvelope`** — same null/missing-field problem as defer-resolver. If parse succeeds but `parked.envelope` is missing, line 214 throws on `parked.envelope?.intentHash` — but `?.` chains. `parked.envelope?.intentHash` returns undefined. So `intentHash` stays `""` (line 206). OK. But `parked.signal` access at 215 throws if `parked` is `null`. The try at 210 only wraps parse, so null check at 209 (`if (raw)`) catches that — raw === "null" is truthy, so parsed === null bypasses, then line 215 throws inside the inner try... wait, line 215 is inside `try { ... } catch (parseErr)`. The catch handles it. OK.
  - **line 227 `recoveryKey = rk(\`recovery:fired:${intentHash || sessionId}\`)`** — when both `intentHash` and `sessionId` happen to overlap across sessions, recovery markers collide. `sessionId` for the anonymize flow is the customerId; recovery dedupes by customerId. Two distinct intentHashes for the same customer with malformed blobs would deduplicate to one event. Severity: low.
  - **lines 506-513 worker.on("failed")** — does NOT push to DLQ; only Sentry. A failed sweep tick is lost from observability beyond Sentry; ops cannot replay.
  - **line 521 `void runRecoveryScan(logger).catch(...)`** — fire-and-forget. If the recovery scan takes 30s and the first regular tick fires 60s later AND finds the same key still un-deleted, BOTH attempt to publish the timeout. SETNX on `recovery:fired:{intentHash}` dedups them — but ONLY if intentHash is non-empty. A malformed-blob key with empty intentHash dedups by sessionId, so two recoveries for the same sessionId still collide correctly. OK.
  - **Heartbeat key write fails** — line 145 `.catch((err) => ...)`. Sweep continues. A monitoring alert on missing heartbeat would fire spuriously after one bad write while the sweeper is healthy. Severity: low.
  - **SCAN cursor crashes mid-iteration** — line 152 `for await (...)`. On error inside the loop, line 165 catches and returns 0 from the sweep. The cursor is NOT persisted. On the NEXT tick, SCAN starts from cursor 0 — fine for correctness. But if the SCAN consistently crashes at the same cursor offset (poison key), the same keys are revisited forever. Severity: medium.

### 5. `packages/llm-provider/src/audit-redactor.ts` + `intent-audit-wiring.ts`

- File: `packages/llm-provider/src/intent-audit-wiring.ts`
- Bugs found:
  - **line 107 `process.env.IBX_AUDIT_POSTGRES_ENABLED === "true"`** — strict string equality. `"True"`, `"TRUE"`, `"1"`, `"yes"` all evaluate to FALSE. Operators who paste `IBX_AUDIT_POSTGRES_ENABLED=True` find Postgres silently disabled with no boot warning. Severity: medium.
  - **line 93 `bufferCapacity()` returns 1_000 on any malformed env value** — but only after a `console.warn`. Production deployments routing logs through pino-shaped sinks may MISS the warn because it goes to console.warn not the structured logger. Severity: low.
  - **line 142 `_redactor = createAuditRedactor({ hashSecret: process.env.AUDIT_REDACT_SECRET ?? "" })`** — if the env var is unset, the empty string is used. The redactor warns ONCE on boot (line 337 of audit-redactor.ts). The warning goes to `console.warn` not the structured logger. Severity: medium (the docs say "MUST be set in production"; nothing enforces that).
  - **Spill capacity exceeded** — `persistentBufferedSink` with `capacity: 1000`. The `onOverflow` callback is called per overflowed record. If the inner sink stays down for 10 minutes at 30 RPS, the spill grows to 18000 records in Redis. The Redis list has NO MAX SIZE — unbounded growth. Severity: medium (Redis OOM under sustained sink outage).

### 6. `apps/api/src/routes/me/anonymize-otp-gate.ts`

- File: `apps/api/src/routes/me/anonymize-otp-gate.ts`
- Bugs found:
  - **line 118 `sendAnonymizeOtp(phone)`** — does NOT validate `phone`. If the customer has `phone: ""` or `phone: null` (legacy data), Twilio's API call throws — and the caller (me.ts:225 `markOtpFresh(customerId)`) executes BEFORE the throw propagates? No — JS is sequential, the throw aborts. But `markOtpFresh` is called inside a `try` block in me.ts that swallows the error and returns 502. The customer ends up with NO OTP marker (because the throw came before `markOtpFresh`), which is correct. But the call to Twilio with bad input still hits their billing meter.
  - **line 130 `verifyAnonymizeOtp(phone, code)`** — catches ALL errors and returns false. A 401/403 from Twilio (auth failure on our side) is masked as "wrong code", incrementing the customer's fail counter for our infra problem. Severity: medium.
  - **`customerId` is null or empty string** — `me.ts` line 364 does `request.customerId!` (non-null assertion). The auth middleware would have rejected null/undefined. But a JWT carrying `customerId: ""` is not nullish — the JWT verify passes, `request.customerId = ""`, and everything downstream uses `rk(\`anonymize:otp:\`)` (note the missing customerId — empty string interpolated). All anonymize markers for any customer with empty-string JWT land on the SAME Redis key. Severity: HIGH if such a JWT can ever be issued. The auth middleware should reject "" — verify.
  - **`incrementOtpFailureCount` line 249 first INCR returns 1, sets TTL** — correct. But if INCR succeeds and EXPIRE fails (Redis crashed in between), the counter has NO TTL and persists FOREVER. Subsequent customer's anonymize attempts are locked out permanently. Severity: medium.
  - **`resetOtpFailureCount` after successful verify** — uses `redis.del`. If a second verify request races between the success path and the reset, the racing one increments the counter to 1 (with TTL re-set). Counter desync — minor.
  - **Cancel-deletion + initiate-deletion within same request lifecycle** — not possible per-route (Fastify routes are isolated), but the same TCP keepalive socket reused across requests is fine. The Redis keys are the only shared state and they're atomic.

### 7. `apps/api/src/routes/admin/payments.ts` (refund flow)

- File: `apps/api/src/routes/admin/payments.ts`
- Bugs found:
  - **line 444 `request.body.amountInCentavos ?? payment.amountInCentavos`** — if amountInCentavos is 0, the `??` does NOT default (0 is not nullish), so `refundAmount = 0`. Then line 447 `if (refundAmount > refundableAmount)` is `0 > positive` → false. Falls through. Line 459 `refundAmount < REFUND_CONFIRMATION_THRESHOLD_CENTAVOS` → true, enters direct execute. The kernel's `refundMagnitudeGuard` at policies.ts:215 REFUSEs on `<= 0` — so the refund is correctly refused. But the request body schema at line 415 is `z.number().int().min(1).optional()` — so `0` is rejected at validation. OK.
  - **`refundAmount = NaN`** — body validation requires `z.number()`, which Zod parses `NaN` as a number type (Zod's `.number()` rejects NaN only if `.refine(n => !isNaN(n))` is added). It is NOT here. `z.number().int().min(1)` — `int()` checks `Number.isInteger(NaN)` which is `false` → rejection. OK Zod catches it.
  - **`refundAmount > Number.MAX_SAFE_INTEGER`** — Zod `.int()` checks `Number.isInteger`. `Number.MAX_SAFE_INTEGER + 1 === Number.MAX_SAFE_INTEGER + 2` due to float precision; `Number.isInteger(2 ** 53)` is true. So a 2^53 refund passes. `refundableAmount = payment.amountInCentavos - refundedAmountCentavos` is small integer. `2^53 > small_int` → over-refund refusal. OK.
  - **Currency mismatch** — there is NO currency field in the schema. Refund amount is always in centavos and the Payment record's `amountInCentavos` is always BRL. If the system ever processes USD payments, the schema is silent. Severity: scoped to future expansion.
  - **Step-1 and step-2 with DIFFERENT amounts** — line 693 reads `stored.refundAmount` from the receipt JSON; step-2's request body does NOT carry an `amountInCentavos`. Cannot be replayed with modified amount via the standard flow. BUT if an attacker can MUTATE the Redis receipt (write access required), they can change the stored amount. Defense-in-depth missing: receipt JSON is not signed. Severity: low (Redis write requires infra compromise).
  - **Refund for already-fully-refunded payment** — line 437 checks `payment.status` in `[PAID, PARTIALLY_REFUNDED]`. `REFUNDED` status is excluded → 422. Correct.
  - **`incrementDailyRefundTotal` line 143 INCRBY + EXPIRE** — IF the INCRBY succeeds and EXPIRE crashes, the bucket lacks TTL and accumulates forever — locking out the staff member from sub-threshold refunds for life. Severity: medium.
  - **Daily bucket midnight rollover** — uses `now.getUTCDate()`. A staff member in BRT timezone (UTC-3) sees the "day" roll at 21:00 local. Operators reporting cumulative refunds for "today" (local) miss the 21:00–23:59 window. Severity: low (no functional bug, UX confusion).
  - **`refundDailyBucketKey` with `actor = staffId ?? "api-key"`** — if `staffId = ""`, actor is `""` (empty), key becomes `refund:daily-total::yyyy-mm-dd`. All API-key refunds AND any "" staffIds share. Severity: medium.

### 8. `packages/pack-payments/src/policies.ts` (W5)

- File: `packages/pack-payments/src/policies.ts`
- Bugs found:
  - **line 214 `refundMagnitudeGuard` with `payload.refundAmountCentavos = NaN`** — `typeof NaN === "number"` is true. `NaN <= 0` is FALSE. So the first refuse-non-positive branch is skipped. Then line 248 `payload.refundAmountCentavos > refundable` → `NaN > number` is FALSE; over-balance check skipped. Line 264 `> escalateThreshold` → FALSE; line 275 `> confirmThreshold` → FALSE. Falls through to `decisionExecute([...])`. **A NaN refund EXECUTES** through the kernel. Severity: HIGH on paper, but Zod at the route layer rejects NaN via `.int()`. If any caller bypasses the route schema (test, internal script, future API), NaN passes the kernel.
  - **`refundAmountCentavos = Number.MAX_SAFE_INTEGER`** — `>0`, then `> refundable` (which is at most `payment.amountInCentavos`) → over-refund refuse. OK.
  - **`refundAmountCentavos = Number.POSITIVE_INFINITY`** — `Infinity > 0` true. `Infinity > refundable` true → over-refund refuse. OK.
  - **`refundAmountCentavos = -0`** — `-0 <= 0` true → refused. OK.
  - **line 333 `regenerationCountCapGuard` `stateCount + 1 > cap`** — for `stateCount = 0xFFFFFFFF` (legacy bad data), `stateCount + 1 = 0x100000000` which is still < 2^53, fine. But if a malicious projection feeds `stateCount = NaN`, `NaN + 1 = NaN`, `NaN > cap` false → falls through to NULL → next guard runs → eventually `executeAll` fires `decisionExecute` for `payment.pix.regenerate`. **A NaN regen count bypasses the cap.** Severity: medium.
  - **idempotency on retry**: `regenerationCountCapGuard` reads `state.ctx.regenerationCount` — if a retry comes in after the first one bumped state to `cap+1`, the second call's `stateCount + 1 > cap` is `cap+2 > cap` true → REFUSE. Correct.

### 9. `apps/api/src/routes/admin/admin-confirmation-store.ts`

- File: `apps/api/src/routes/admin/admin-confirmation-store.ts`
- Bugs found:
  - **`consumeWithSameActorCheck` line 188-190** — `requestStaffId !== null && pending.staffId !== null && requestStaffId === pending.staffId`. **An empty-string staffId bypasses this**: `pending.staffId === ""` (set by route handler when staffId was empty); `requestStaffId === ""`. Both `!== null`, equal → same-actor violation. OK that's correct.
  - BUT: `principalFor("")` at payments.ts:161 returns the SYSTEM principal because `if (staffId)` is falsy for "". So an empty-string staffId is treated as SYSTEM by the envelope-build, yet treated as a USER staffId by the same-actor check. **Internal inconsistency.** A staff member with somehow-empty `request.staffId` builds envelopes with `principal: "system"`, `sessionId: "admin:api-key"`, but their step-2 same-actor check uses the empty-string staffId. Severity: medium.
  - **Confirmation token expired but TTL gap** — `consume` calls `CONSUME_RECEIPT_SCRIPT` (atomic Lua GET+DEL). If the key just expired between SCAN and GET, the script returns nil → 410 to operator. Correct.
  - **Token that's been consumed but is in the Redis TTL gap (consumed by Lua but not yet deleted)** — impossible by Lua atomicity: GET and DEL are in the same script execution.
  - **staffId is empty string** — line 222-228 `confirmationId` validation: length must be 1–64. `""` returns null. OK for confirmationId. But pending.staffId is not validated.

### 10. `apps/api/src/plugins/kernel-bootstrap.ts`

- File: `apps/api/src/plugins/kernel-bootstrap.ts`
- Bugs found:
  - **IBX_KERNEL_ENFORCE with whitespace**: `parseList` at `@adjudicate/core/kernel/enforce-config.ts:21-28` does `.trim()` and filters empty. `IBX_KERNEL_ENFORCE=" , , "` → empty set after trim/filter. No warn, no error. **Silently disables enforcement.** Severity: HIGH.
  - **IBX_KERNEL_ENFORCE empty string** `IBX_KERNEL_ENFORCE=""` — `parseList` returns `{wildcard: false, kinds: new Set()}`. No enforcement. No warn. Severity: HIGH for ops misconfig.
  - **IBX_KERNEL_ENFORCE duplicate kinds** `IBX_KERNEL_ENFORCE=order.cart.add,order.cart.add` — `new Set(["order.cart.add", "order.cart.add"])` is `{order.cart.add}`. Idempotent. OK.
  - **Case-sensitive kind matching** `IBX_KERNEL_ENFORCE=Order.Cart.Add` — `KNOWN_INTENT_KINDS` is the union of pack intents with their declared casing. The Pack declares `order.cart.add` (lowercase). `validateEnforceConfig` line 104 `!knownIntents.has(k)` → `Order.Cart.Add` is unknown → `unknownEnforce.push(...)`. Bootstrap throws at line 196. OK, this is the documented behaviour.
  - **Mixed wildcard + named kinds** `IBX_KERNEL_ENFORCE=*,order.cart.add` — `parseList` at line 25 hits `parts.includes(WILDCARD)` → wildcard true, kinds excludes "*". Wildcard wins. Correct semantically.
  - **Pack-conformance failure during boot** — `installFirstPartyPacks()` throws `PackConformanceError`. The catch at line 165 re-throws → server fails to start. But `bootstrapKernel` is called AFTER `buildServer` returns. The metrics sink at line 96 is already installed; the registry is leaking on retry. Severity: low.

### 11. Customer service `anonymizeCustomerFromEnvelope` (W4)

- File: `packages/domain/src/services/customer.service.ts`
- Bugs found:
  - **lines 483-527 single `prisma.$transaction`** with NO timeout override. Default Prisma `$transaction` timeout is 5 seconds. A customer with 10000 reviews `tx.review.updateMany` at line 517 might exceed 5s. The transaction times out, throws, the catch (none) bubbles up to `anonymizeCustomerFromEnvelope` which propagates to the adopter. The customer record at this point has ALREADY been updated (line 486) IF Prisma already started executing — wait, `$transaction` rolls back on throw. OK, rollback restores all fields. But the customer was in the "deletion pending" state with the receipt cleared. Severity: HIGH (LGPD obligation breach + UX dead-end).
  - **`customer.phone = phoneSentinel` UNIQUE constraint** — `anonymized:${first-8-hex-of-sha256(id)}` is 16 hex chars (line 481: `.slice(0, 16)`). 16 hex = 2^64 buckets. Collision space huge. But comment at line 477 says "first-8-hex" — code says `.slice(0, 16)`. The comment is stale. Not a bug, but worth correcting.
  - **`medusaId: null` when already null** — Prisma `update` with `data: { medusaId: null }` is a no-op. No throw. OK.
  - **Customer with no addresses** — `tx.address.deleteMany({where: {customerId}})` returns `{count: 0}`. No error. OK.
  - **Customer not found** — `tx.customer.update({where: {id: customerId}, ...})` throws `RecordNotFound`. The receipt is cleared in the grace resolver only AFTER `anonymizeCustomer` resolves; on throw, the receipt remains and the next defer-timeout-sweeper tick re-fires. Loop. Severity: medium (poison pill).
  - **`Review.customerId` is `String` (not nullable) per the comment** — the comment confesses they can't null it from app code without migration. So FK leak: the customer row is anonymized but Review still FK-points to the now-anonymized customer. PII NOT linked (since name="Usuário Removido"), so the LGPD obligation is met PROVIDED the analytics consumer of Review does not also query Customer table. Severity: low (already documented).

### 12. `apps/api/src/routes/__shared__/customer-intent-gateway.ts`

- File: `apps/api/src/routes/__shared__/customer-intent-gateway.ts`
- Bugs found:
  - **`decision.kind` switch lines 233-298** — covers all 6 cases. If a future kernel adds a 7th `Decision` kind without updating the switch, TypeScript's exhaustiveness check should fire — but only at compile time. At runtime an unknown kind falls through the switch with no default, and the function returns `undefined`. Caller does `reply.code(out.statusCode).send(out.body)` — `out.statusCode` throws `TypeError: Cannot read properties of undefined`. Severity: low.
  - **Concurrent calls with same envelope** — adjudicate is pure (deterministic given state). Two concurrent same-envelope calls produce the same decision. EXECUTE branch runs `executor(payload)` twice — NOT idempotent. The kernel's ledger (when enabled) dedupes by `intentHash`; in this gateway there is NO ledger check before executor. The kernel-side dedup is in the LLM responder's path (llm-responder.ts:308-340), NOT in this gateway. Severity: HIGH for replay safety on HTTP routes.
  - **REQUEST_CONFIRMATION 202** — line 281 returns `{confirmationRequired: true, prompt: ...}`. There is no continuation token. The client has no way to send the confirmation back — they must re-submit the original request, which will again hit REQUEST_CONFIRMATION (idempotent → loop). The route has to layer a separate two-step receipt protocol on top (admin-confirmation-store), but customer-facing routes (cart/order/anonymize) don't do this. Severity: medium (semantic dead-end for customer-driven flows).
  - **`ALWAYS_ENFORCE.has("customer.anonymize.cancel")` line 173-176** — `customer.anonymize.cancel` is force-enforced but a typo from the pack-customer-onboarding side (`customer.anonymize.cancellation`) would not match. No grep-test confirms the pack's intent kind name aligns.

### 13. Integration tests from W6

- File: `apps/api/src/__tests__/integration/lgpd-anonymize-lifecycle.test.ts`
- Findings:
  - **lines 91-119** — mocks `@ibatexas/domain` ENTIRELY including `anonymizeCustomer`. The test never runs the destructive function. The W6-1 assertion at line 368 `expect(mockAnonymizeCustomer).toHaveBeenCalledTimes(1)` only verifies the call was made — NOT that phone was hashed, reviews scrubbed, email nulled, etc.
  - **lines 100-110** — mocks `@ibatexas/tools.getRedisClient` with a `Map<string,string>` storage. No SCAN, no expiry semantics, no EVAL. The atomic Lua receipt-consume scripts don't run. The defer-pending TTL is not honored.
  - **line 100 `mockRedisSet`** ignores the `{EX}` option. Cancel-cooldown never expires. Test asserts the option was passed (line 287), but the storage doesn't enforce it.
  - **line 116** — mocks `subscribeNatsEvent` to a vi.fn — the defer-resolver subscriber NEVER runs. The cross-subscriber flow (PIX confirm → defer-resolver → resume → audit) is not covered.
  - **`audit-sink-fail-resilience.test.ts`** — also unit-shaped; uses a stub Redis Map with no TTL. Asserts `getAuditSink().emit()` resolves despite a failing Postgres writer. Real-world: the multi-sink Promise.allSettled is the actual resilience surface; the test stubs the writer to throw, which is the right shape but with no NATS sink wired the test doesn't exercise the fan-out at all.
  - **`multi-pack-supersedes.test.ts`** — purely in-memory: calls `adjudicate()` and `buildAuditRecord()` directly with no Redis/NATS/HTTP. It's a contract test, not an integration test.

---

## Branches not exercised by tests

1. **`llm-responder.ts:308-340` Phase F/G ledger replay-suppression** — no test wires a real ledger and asserts the `already_processed` tool result is returned.
2. **`llm-responder.ts:498-577` DEFER park-quota-exceeded branch** — no test injects a parkResult `{parked: false, reason: ...}`.
3. **`llm-responder.ts:589-625` REFUSE / ESCALATE / REQUEST_CONFIRMATION tool result emit** — covered for REFUSE in audit-redaction-contract.test.ts but not exercised end-to-end for ESCALATE.
4. **`defer-resolver.ts:264-292 robustRedisGet error path with all 3 retries failing** — test stubs Redis as a Map; cannot inject `redis.get` to throw 3 times then succeed.
5. **`defer-resolver.ts:455-475 cycle-cap-exceeded branch** — `DEFAULT_MAX_RESUME_CYCLES = 3`; no test increments the counter past 3.
6. **`defer-timeout-sweeper.ts:330-491 runRecoveryScan`** — recovery-only path; no test asserts the SETNX recovery-fired key prevents the next normal sweep from double-firing.
7. **`audit-redactor.ts:419-447 fail-open stub payload path** — no test forces `walk` to throw to assert the `{__redactor_error: true}` stub is emitted.
8. **`payments.ts:459-531 drip-cap-exceeded fallback to two-step**` — no test pumps the `refund:daily-total:*` counter to the cap and asserts the 202 + `code: REFUND_DRIP_CAP` is returned.
9. **`policies.ts:333 regenerationCountCapGuard with `stateCount + 1 > cap`** — no test asserts NaN stateCount bypass (it's a hidden bug AND uncovered).
10. **`kernel-bootstrap.ts:188-209 enforce-config typo fatal exit** — covered by unit test, but no integration test asserts the process exits non-zero.

---

## Type-coercion / NaN / encoding bugs

- **NaN payloads in `refundMagnitudeGuard`** — payload `refundAmountCentavos: NaN` passes the kernel's magnitude ladder unrefused and EXECUTEs (`policies.ts:214`). Zod at the route guards against it, but ANY internal caller bypassing the schema (`packages/domain/src/services/payment.service.ts` direct invocation) opens the door.
- **NaN in `regenerationCountCapGuard`** — `state.ctx.regenerationCount = NaN` bypasses `stateCount + 1 > cap`.
- **`Number.parseInt(...)` returns NaN on garbage** — `apps/api/src/routes/me/anonymize-otp-gate.ts:264 Number.parseInt(value, 10) || 0` defends with `|| 0`. But `payments.ts:128-130 Number.isNaN(n) ? 0 : n` is correct. Inconsistent.
- **`process.env.IBX_AUDIT_POSTGRES_ENABLED === "true"` strict equality** — `"True"` evaluates false silently.
- **Empty-string staffId** treated as system principal by `principalFor` (truthy check) but treated as user staffId by `consumeWithSameActorCheck` (null check) — same value, two interpretations.
- **`CARD_RE` masks any 13-19 digit sequence** — 13-digit ms-precision unix timestamps in payload (e.g. `parkedAt`, `createdAt` if represented as Number rather than ISO string) are masked as `[REDACTED:CARD]`.
- **JSON-parse `null`** treated as `ParkedEnvelope` in `defer-resolver.ts:356` and `defer-timeout-sweeper.ts:211` — `JSON.parse("null")` is `null`; not caught by the `try/catch` around parse because parse succeeded.

---

## Time-zone / clock-skew issues

- **`refundDailyBucketKey` uses UTC** (`getUTCDate`) — staff in BRT see "today" rollover at 21:00 local. Drip-cap counters reset 3h before midnight local.
- **`anonymize:cancel-cooldown` TTL of 30 min** measured by Redis server time, not application time. If Redis is on a separate host with clock skew, the cooldown can end early/late by skew amount.
- **Sweeper `IMMINENT_TTL_SECONDS = 60` and runtime park TTL `signal.timeoutMs/1000 + 60`** — if Redis clock and worker clock skew by >60s, a parked key can be deleted before the sweeper sees it imminent. The sweep cadence is also 60s; combined, a >120s skew can lose a timeout entirely.
- **`Date.now()` in `redactor` vs `Redis SET EX`** — the redactor's auditHash recomputation uses canonicalized JSON. If `record.at` (ISO string) and the Redis-stored representation use different precision (ms vs s), hash mismatches on read-back.
- **`buildResumeOrderState` line 198 `activeOrderId: event.orderId`** — relies on the wire event having `orderId`. If null/undefined the projected state lacks an active order; the kernel guard's `state.ctx.exists` check fails → REFUSE. The resume is silently lost.

---

## State machine holes

- **Defer resume + cycle counter**: `defer-resolver.ts:462` INCRs the cycle counter BEFORE adjudicate. If adjudicate throws (line 494), the counter retains the bump but the resuming-marker is cleared. Next attempt's counter is already +1. After 3 such failures, the cycle cap fires and the legitimate intent is REFUSEd permanently.
- **Anonymize flow stuck at "in flight" if grace resolver throws**: `anonymizeCustomerFromEnvelope` returns; `customer-intent-gateway` doesn't clear `anonymize:pending:{customerId}` because that's the route's responsibility. If the route's executor throws AFTER park, the pending key persists for 24h, blocking initiate-deletion.
- **Refund step 1 → step 2** — between step 1 (202) and step 2, the operator can call other admin endpoints. There is no lock; another step-1 with a different amount can be issued, generating a new confirmationId. Then step 2 against the FIRST confirmationId consumes it normally — but the operator may have intended to confirm the SECOND amount. Severity: low (UX).
- **`customer.anonymize.cancel` after grace expired** — the grace resolver fires at 24h; cancel-deletion at 24h+1s sees no pending receipt → returns success but anonymize has ALREADY run. Customer believes their account is still alive.
- **Twilio Verify code never expires server-side** — Twilio expires the code in 10 min; our `ANONYMIZE_OTP_TTL_SECONDS = 300` is half that. Discrepancy: customer can verify successfully on Twilio side but our `hasFreshOtp` returns false at the 5-min mark.
- **DEFER park quota** — line 528 quota-exceeded REFUSE returns to the user, but the audit record was already emitted at line 411. The audit reports the kernel's DEFER decision; nothing audits the park-quota REFUSE. Forensic gap.

---

## Findings ranked

| # | Severity | File:Line | Bug | Test gap |
|---|----------|-----------|-----|----------|
| 1 | HIGH | `audit-redactor.ts:562` | Prototype-pollution propagation via `__proto__` own-key in JSON.parse'd payloads — redacted record's prototype is set, not its property. | Yes |
| 2 | HIGH | `policies.ts:214` `refundMagnitudeGuard` | NaN refundAmountCentavos EXECUTEs through every gate. | Yes |
| 3 | HIGH | `anonymize-otp-gate.ts:163-167` + `me.ts:364` | Empty-string customerId from JWT lands as key `anonymize:otp:` (no suffix); all empty-id customers share state. | Yes |
| 4 | HIGH | `defer-resolver.ts:423` | `redis.get(resumedKey).catch(() => null)` — same bug as P1-D claimed to fix. Transient Redis error → duplicate dispatch. | Yes |
| 5 | HIGH | `customer.service.ts:483` | `prisma.$transaction` over `tx.review.updateMany` has no timeout override; 10k+ reviews → rollback → LGPD obligation breach. | Yes |
| 6 | HIGH | `kernel-bootstrap.ts:188` + `enforce-config.ts:21` | `IBX_KERNEL_ENFORCE=" , , "` parses to empty set silently. No warn, no error. Enforcement disabled. | Yes |
| 7 | MEDIUM | `audit-redactor.ts:233` CPF_RE | CPF followed by `-` (e.g. `12345678900-xyz`) bypasses redaction due to negative lookahead including `-`. | Yes |
| 8 | MEDIUM | `customer-intent-gateway.ts:235` EXECUTE branch | No ledger dedup. Concurrent identical envelopes execute twice. | Yes |
| 9 | MEDIUM | `intent-audit-wiring.ts:107` | `=== "true"` strict check — `"True"`/`"1"` silently disable Postgres. | Yes |
| 10 | MEDIUM | `payments.ts:111-118` | `refundDailyBucketKey` uses UTC date; BRT staff see midnight rollover at 21:00 local. Plus empty-string staffId collides into "" bucket. | Yes |

### Top 5 tests that look real but mock too much

1. **`lgpd-anonymize-lifecycle.test.ts`** — labelled "integration" but mocks Redis (Map), Twilio, NATS, Prisma, **and `anonymizeCustomer` itself**. Test asserts the mock was called; cannot detect any W4 anonymize regression (phone-hash, reviews-scrub, FK relinking).
2. **`audit-sink-fail-resilience.test.ts`** — mocks Redis spill with a Map (no TTL), Postgres writer with `throw`. Real fan-out (`multiSink` over NATS + console + Postgres) is bypassed; only the wrapped-buffered-sink path runs.
3. **`multi-pack-supersedes.test.ts`** — pure-function adjudicate; no HTTP, no Redis. Misnamed as integration.
4. **`defer-resolver.test.ts`** — stubs Redis client; the SCAN iteration uses a fixed array. Cannot detect the SCAN-resumes-from-cursor-0 issue or the O(N) fan-out scaling.
5. **`audit-redaction-contract.test.ts`** — asserts certain payloads are redacted but uses a small synthesis corpus. Does NOT include `__proto__`-pollution, cycles, Date/Map/Set inputs, or CARD/PHONE collision.

### Top 3 input scenarios with no validation

1. **Empty-string identifiers**: `customerId`, `staffId`, intent `block.name`. Auth middleware should reject empty `customerId` JWT; payments.ts treats empty `staffId` as system; admin-confirmation-store treats it as user.
2. **NaN / Infinity numeric payloads**: defended at the Zod route schema but not at the kernel boundary. Internal callers bypassing the schema (services, scripts, tests) reach `refundMagnitudeGuard` / `regenerationCountCapGuard` with NaN.
3. **Prototype-polluted JSON payloads**: `JSON.parse` preserves `__proto__` as own key; audit-redactor's `walk` propagates it to the output. Any downstream sink that does `for (k in payload)` inherits the pollution.

### Verdict on test suite trustworthiness

**Low-to-medium**. The unit-test surface for `@adjudicate/*` packages, packs (`pack-orders`, `pack-payments`), and the redactor's positive corpus is strong. The **adopter-side** (IbateXas) tests labelled "integration" are unit tests with hoisted mocks for every external dependency — they assert plumbing (call counts, argument shapes) but **not** the destructive behaviours they claim to cover. The W6 integration suite gives false confidence: a refactor that broke `anonymizeCustomer` would still pass `lgpd-anonymize-lifecycle.test.ts` because the function is mocked at the module boundary.

Recommendations for the next test wave (W7?):
- A real Redis container (`testcontainers`) for the LGPD lifecycle test — Redis TTL semantics are load-bearing for the cooldown and the receipt expiry.
- A real Prisma over a transient Postgres for `anonymizeCustomer` — assert phone format, FK delinking, transaction timeout behaviour with 10k-review fixture.
- A fuzz-test corpus for the audit-redactor: `__proto__` keys, cycles, Date/Map/Buffer, NaN/Infinity, CARD/PHONE collision strings, 100KB payloads.
- A property-based test for `refundMagnitudeGuard` / `regenerationCountCapGuard` over `fc.float()` / `fc.bigInt()` to catch NaN-passthrough.
- A boot-time integration test for `IBX_KERNEL_ENFORCE` parsing — whitespace, empty, duplicate, mixed-case kinds.
