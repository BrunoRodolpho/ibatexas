# Task 18 — Audit Redactor

**Milestone:** M4 (Audit & observability)
**Estimated effort:** M — 2–3 dev-days
**Blocks:** 12, 13, 14, 15, 16, 17, 19 (any task that emits PII-bearing audit records depends on this — must land first)
**Blocked by:** 01 (kernel bootstrap), 05 (metrics sink to record redaction events)
**Owner:** unassigned

## Objective

Implement an `AuditRedactor` and wire it into `intent-audit-wiring.ts` BEFORE the NATS sink. The redactor masks CPF, email, phone, and payment-method strings in `AuditRecord.envelope.payload` before any sink emits the record. After this lands, no PII leaks to NATS subject `audit.intent.decision.v1` or to console sinks. A contract test ensures no CPF/email/phone/payment-method strings remain in emitted audit records.

## Architecture context

Cite: investigation 08 P0 #1.
> "Audit pipeline leaks PII to NATS / console without redaction. `AuditRecord.envelope.payload` contains the LLM's literal tool input. `set_pix_details` sends customer's full name + email + CPF as a NATS message to subject `ibatexas.audit.intent.decision.v1`. Anyone with NATS subscribe permission ... reads CPF in cleartext."
> "Fix: introduce an `AuditRedactor` in `@adjudicate/audit` that masks fields per intent-kind schema; wire it into `intent-audit-wiring.ts`. Effort: ~1–2 days for the framework; ~1 day for IbateXas adapter."

Existing IbateXas asset: `apps/api/src/utils/sanitize-analytics.ts` masks CPF/email/phone for PostHog analytics. Reuse its patterns.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/intent-audit-wiring.ts` (current sink composition)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/utils/sanitize-analytics.ts` (existing PII mask)
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/cart/set-pix-details.ts` (PII-bearing payload)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/audit-redactor.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/__tests__/audit-redactor.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/__tests__/audit-redaction-contract.test.ts`

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/intent-audit-wiring.ts` — compose redactor BEFORE multi-sink fan-out.

## Constraints

- Redaction is structural: walk the payload tree, for any string field whose name matches `cpf|email|phone|cellphone|whatsapp|cardNumber|cvv` or whose value matches the regex patterns, replace with `[REDACTED]`.
- For `name` and `address` fields, hash with SHA-256 truncated to 8 hex chars (collision-safe enough to correlate without leaking).
- Preserve audit-record shape: `decision`, `decision_basis`, `intentHash`, `auditHash`, timestamps stay intact.
- Audit-record fields OUTSIDE payload (`actor`, `taint`, `kind`) remain untouched — they're already PII-free by design.
- Redactor is idempotent (running twice produces same output).
- Emit a `recordSinkFailure({sink: "redactor"})` metric if redaction fails (don't block the decision; fail-open with alert).
- pt-BR not relevant.
- Follow CLAUDE.md rule #4 (PII protection alignment).

## Implementation requirements

1. **Redactor signature:**
   ```ts
   export interface AuditRedactor {
     redact(record: AuditRecord): AuditRecord;
   }
   export function createAuditRedactor(opts?: {hashSecret?: string}): AuditRedactor;
   ```

2. **Redaction rules** (apply to `record.envelope.payload` only):
   - Field-name match (any depth): `cpf`, `cnpj`, `email`, `phone`, `cellphone`, `whatsapp`, `cardNumber`, `cvv`, `pan` → replace value with `"[REDACTED]"`.
   - Regex match (string values, even in unmatched field names):
     - CPF pattern: `^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$` → `"[REDACTED:CPF]"`
     - Email pattern: standard RFC-like regex → `"[REDACTED:EMAIL]"`
     - Brazilian phone pattern: `^\+?55\d{10,11}$` or `\(\d{2}\) \d{4,5}-?\d{4}$` → `"[REDACTED:PHONE]"`
     - Stripe card brand prefixes (e.g. `4111111111111111`) → `"[REDACTED:CARD]"`
   - Field-name hash (preserve correlation): `name`, `customerName`, `addressLine1`, `addressLine2` → `"hashed:" + sha256(value, hashSecret).slice(0, 8)`
   - Deeply nested objects/arrays: walk recursively.

3. **Compose in `intent-audit-wiring.ts`:**
   ```ts
   const redactor = createAuditRedactor({hashSecret: process.env.AUDIT_REDACT_SECRET ?? ""});
   const innerSink = multiSink(createConsoleSink({prefix: "[ibx-audit]"}), createNatsSink({...}));
   const sink: AuditSink = {
     emit: async (record) => {
       const redacted = redactor.redact(record);
       return innerSink.emit(redacted);
     },
   };
   ```

4. **Env var** — `AUDIT_REDACT_SECRET` in `.env.example` (must be set in production to prevent rainbow-table attacks on the hash; fall back to empty in dev but emit a warning at boot).

5. **Tests:**
   - **audit-redactor.test.ts:**
     - "redacts cpf field" — input `{cpf: "12345678900"}` → output `{cpf: "[REDACTED]"}`.
     - "redacts email by field name" — input `{email: "user@example.com"}` → `[REDACTED]`.
     - "redacts CPF by value regex even in unmatched field" — input `{notes: "meu cpf é 123.456.789-00"}` → notes has substring redacted.
     - "hashes name field" — input `{name: "João Silva"}` → output `name = "hashed:abc12345"` (SHA-256 truncated).
     - "deep-walks nested objects" — input `{customer: {address: {line1: "Rua X 123"}}}` → line1 is hashed.
     - "idempotent" — `redact(redact(record))` === `redact(record)`.
     - "preserves audit shape" — `decision`, `intentHash`, etc. unchanged.
   - **audit-redaction-contract.test.ts:**
     - Run a corpus of 50+ representative envelopes (from PIX checkout, cart add, reservation create, etc.) through the redactor. Assert NONE of the emitted records contain a regex-match for CPF/email/Brazilian phone in their JSON-stringified output. CI-gate this test.

## Acceptance criteria

- [ ] `AuditRedactor` exists with rules above.
- [ ] `intent-audit-wiring.ts` composes redactor BEFORE multi-sink.
- [ ] `AUDIT_REDACT_SECRET` documented in `.env.example`.
- [ ] All audit-redactor tests pass.
- [ ] Contract test (50+ envelopes corpus) passes — ZERO PII leaks.
- [ ] CI gate added: contract test runs on every PR.

## Testing requirements

- **Unit:** audit-redactor.test.ts.
- **Contract:** audit-redaction-contract.test.ts (CI gate).
- **Bypass-detection:** assert NO `getAuditSink().emit(record)` call site in IbateXas bypasses the redactor (grep-test).

## Rollout notes

Direct merge — this is a defensive change with no behavioural impact except masked audit content. Watch for:
- Operator complaints about lost detail in audit views (they need to query by intentHash, not by customer email — provide a hash-lookup tool).
- Replay tests breaking if they expected raw CPF (replay logic should use `intentHash`, which is computed BEFORE redaction).

## Rollback notes

Revert. Raw PII flows again. ETA: 5 min. CRITICAL: if rollback is needed due to a redactor bug, the production NATS subject MAY have accumulated PII during the buggy window — alert security/compliance team. Mitigate by adding a contract test that ALSO runs in production against a NATS subject sample (daily).

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 18: audit redactor.

CONTEXT
Per investigation 08 (P0 #1) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/08-security-trust-boundaries.md:
- AuditRecord.envelope.payload contains LLM tool inputs (set_pix_details includes name, email, CPF)
- Audit publishes to NATS subject ibatexas.audit.intent.decision.v1 in cleartext
- Anyone with NATS subscribe permission reads CPF/email/phone

Your job: implement an AuditRedactor that masks PII before any sink emits, and wire it into intent-audit-wiring.ts.

REPO LAYOUT
- packages/llm-provider/src/intent-audit-wiring.ts (current sink composition)
- apps/api/src/utils/sanitize-analytics.ts (existing CPF/email/phone mask — reuse patterns)
- @adjudicate/core exports: AuditRecord type
- @adjudicate/audit exports: AuditSink, multiSink, createConsoleSink, createNatsSink

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/llm-provider/src/audit-redactor.ts (CREATE)
- packages/llm-provider/src/__tests__/audit-redactor.test.ts (CREATE)
- packages/llm-provider/src/__tests__/audit-redaction-contract.test.ts (CREATE — CI gate)
- packages/llm-provider/src/intent-audit-wiring.ts (MODIFY — compose redactor before multi-sink)
- .env.example (MODIFY — add AUDIT_REDACT_SECRET)

WHAT TO BUILD

1. audit-redactor.ts:
   ```ts
   export interface AuditRedactor { redact(record: AuditRecord): AuditRecord; }
   export function createAuditRedactor(opts?: {hashSecret?: string; warn?: (msg: string) => void}): AuditRedactor;
   ```
2. Redaction rules:
   - Apply to record.envelope.payload only — DO NOT modify record.envelope.actor, record.envelope.kind, record.envelope.intentHash, record.decision, record.auditHash, record.envelope.taint
   - Field-name match (case-insensitive, any depth): cpf, cnpj, email, phone, cellphone, whatsapp, cardNumber, cvv, pan → replace value with "[REDACTED]"
   - Regex match on string values (even outside matched field names):
     * CPF: ^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$ → "[REDACTED:CPF]"
     * Email: standard regex (use one from sanitize-analytics.ts) → "[REDACTED:EMAIL]"
     * Brazilian phone: \+?55\d{10,11} or \(\d{2}\)\s?\d{4,5}-?\d{4} → "[REDACTED:PHONE]"
     * Stripe card-like 16-digit sequences → "[REDACTED:CARD]"
   - Field-name hash (preserve correlation): name, customerName, fullName, addressLine1, addressLine2 → "hashed:" + sha256(value + opts.hashSecret).slice(0, 8)
   - Walk objects/arrays recursively; preserve structure
3. Idempotency: redact(redact(record)) === redact(record). Ensure regex replacements don't re-trigger on "[REDACTED:*]" strings.

4. intent-audit-wiring.ts: 
   - Build redactor with hashSecret from process.env.AUDIT_REDACT_SECRET (fallback "" with console.warn if empty)
   - Wrap inner multi-sink:
     ```ts
     const innerSink = multiSink(createConsoleSink({prefix: "[ibx-audit]"}), createNatsSink({...}));
     export const _sink: AuditSink = {
       emit: async (record) => {
         const redacted = redactor.redact(record);
         return innerSink.emit(redacted);
       },
     };
     ```

5. .env.example: append
   AUDIT_REDACT_SECRET=                       # required in production; HMAC key for hashing name/address fields

6. Tests (audit-redactor.test.ts) — 7+ cases per task description above.

7. Contract test (audit-redaction-contract.test.ts):
   - Build a corpus of 50+ representative AuditRecord fixtures simulating outputs of:
     * set_pix_details payload (name, email, cpf)
     * cancel_order payload (customerId, orderId)
     * reservation.create payload (customerName, phone, partySize)
     * create_checkout payload (cardNumber if card path)
     * notification.send payload (body which may contain customer name)
     * + 5 more representative payloads
   - For each fixture: run redactor, JSON.stringify, run regex matches for CPF / email / Brazilian phone / card patterns; assert ZERO matches
   - Mark this test as CI-gate (it should run on every PR; add a comment in the file: // CI gate: this test MUST pass before any merge)
   - Add it to the package.json test scripts if needed

CONSTRAINTS
- Read CLAUDE.md rule 4 first
- TypeScript strict, ESM, .js extensions on local imports
- Idempotent redactor (no double-redact corruption)
- Preserve intentHash and auditHash — they were computed BEFORE redaction and must remain stable for replay
- DO NOT modify @adjudicate/* source
- DO NOT redact fields outside record.envelope.payload (actor.sessionId may include phone hash — but that's already hashed; safe)

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] createAuditRedactor exported with rules above
- [ ] intent-audit-wiring.ts composes redactor BEFORE multi-sink fan-out
- [ ] AUDIT_REDACT_SECRET in .env.example with comment
- [ ] All 7+ audit-redactor unit tests pass
- [ ] Contract test with 50+ fixtures passes with ZERO PII leaks
- [ ] Idempotency test passes
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes

When complete, return: files created/modified, contract test fixture count, sample redacted-vs-raw output diff for the set_pix_details payload, and any PII patterns you found in the corpus that needed additional rules.
```
