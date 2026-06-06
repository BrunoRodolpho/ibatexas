# Task 10 — Create `@ibatexas/pack-whatsapp`

**Milestone:** M2 (Pack architecture)
**Estimated effort:** M — 2–3 dev-days
**Blocks:** 15, 16 (command services + NATS subscribers depend on this pack to gate WhatsApp egress)
**Blocked by:** 08 (pack-orders template)
**Owner:** unassigned

## Objective

Author the first-party `@ibatexas/pack-whatsapp` package covering channel-level intents: `whatsapp.message.send`, `whatsapp.template.send`, `whatsapp.session.handover`, plus 24-hour message-window rules, staff handoff rate limits, and customer-controlled-string sanitization for messages routed to staff. After this lands, the `notification.send` NATS fan-out (currently the universal WhatsApp egress with no taint check on `body`) becomes adjudicate-gated and PII-redacted.

## Architecture context

Cite: investigation 04 §"Critical findings" #6 + investigation 08 P1 #4.
> "`notification.send` subscriber sends arbitrary WhatsApp body text. The `body` field is whatever the publisher passed. ... If any publisher path were to include LLM-generated text in `body`, it would reach the customer without any taint check."
> "`handoff_to_human` can flood staff WhatsApp. No per-customer rate limit; user-controlled `reason` is template-injected into a staff-bound WhatsApp message."

WhatsApp Business 24-hour message-window rule (Meta/Twilio policy): outside the 24h customer-initiated window, only approved template messages can be sent — free-form messages are rejected by Twilio. Today's IbateXas codebase doesn't enforce this; messages outside the window silently fail.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/whatsapp/client.ts` (sendText, sendMedia, sendTemplate)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/cart-intelligence.ts:665` (notification.send handler)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/handoff-subscriber.ts:14` (staff handoff)
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/support/handoff-to-human.ts` (LLM tool emitting handoff)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/` (Task 08 template)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/package.json`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/tsconfig.json`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/src/index.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/src/types.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/src/policies.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/src/sanitize.ts` (customer-controlled-string sanitizer)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/src/refusals.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/src/__tests__/whatsapp-pack.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/src/__tests__/conformance.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-whatsapp/src/__tests__/sanitize.test.ts`

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/kernel-bootstrap.ts` — `installPack(whatsappPack)`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/package.json` — depend on `@ibatexas/pack-whatsapp`

## Constraints

- Must use `@adjudicate/primitives.createThresholdGuard` for the staff handoff rate limit (e.g. 1 handoff per customer per 10 min → REQUEST_CONFIRMATION at threshold or REFUSE if abusive).
- Must implement a **`sanitizeCustomerString`** function that strips newlines (`\r\n`), markdown control chars (`*`, `_`, `~`, `\``), zero-width chars, and truncates to 100 chars. Use in REWRITE guards for `whatsapp.message.send` payloads where `senderRole = "customer"` and recipient is staff.
- Must enforce 24-hour customer-initiated window: REFUSE `whatsapp.message.send` (non-template) outside the window. Templates pass.
- Must use `@adjudicate/primitives.createRewriteGuard` for the sanitization path so the rewritten envelope is what executes.
- pt-BR for all refusal text.
- Follow CLAUDE.md rule #9 — WhatsApp egress is a sensitive mutation surface; the pack defines authority.

## Implementation requirements

1. **Package scaffold** — identical to Task 08.

2. **`types.ts`:**
   - `WhatsAppIntentKind`: `whatsapp.message.send | whatsapp.template.send | whatsapp.session.handover`
   - Payloads include `{to: PhoneE164, body: string, senderRole: "customer" | "staff" | "system", templateName?: string, templateVariables?: Record<string,string>}`.
   - `WhatsAppState`: `{lastCustomerMessageAt?: Date, perCustomerHandoffCount24h: Record<PhoneHash, number>, ...}`.

3. **`sanitize.ts`:**
   - `export function sanitizeCustomerString(input: string): string`
   - Strip `\r`, `\n`, `​-‏`, ` - `, `*_~\``
   - Truncate to 100 chars max
   - Replace runs of whitespace with single space
   - Unit-tested with 10+ adversarial cases (markdown bombs, zero-width injection, newline injection)

4. **`policies.ts`** — build `whatsappPolicyBundle`:
   - **stateGuards:**
     - 24-hour window check: for `whatsapp.message.send` (non-template), REFUSE if `now - state.lastCustomerMessageAt > 24h` with refusal code `whatsapp_window_expired`. Templates bypass.
   - **authGuards:**
     - `senderRole = "customer"` cannot send to staff phones except via `whatsapp.session.handover`.
   - **taint:** `createSystemTaintPolicy({systemOnlyKinds: ["whatsapp.template.send", "whatsapp.session.handover"], userMinimum: "UNTRUSTED"})`.
   - **business guards:**
     - `createThresholdGuard` for `whatsapp.session.handover` rate-limited at 1 per `WHATSAPP_HANDOFF_LIMIT_MINUTES` (default 10) per customer phone hash. Crossing threshold → REQUEST_CONFIRMATION; >2× → REFUSE.
     - `createRewriteGuard` for `whatsapp.message.send` where `senderRole = "customer"` and recipient is staff — rewrite `body` through `sanitizeCustomerString`.
   - **default:** `decisionRefuse(refuse("policy", "default_refuse", "Operação não permitida."), [...])`.

5. **Refusals (`refusals.ts`):**
   - `refuseWindowExpired` — "Não consigo enviar essa mensagem agora. Por favor aguarde uma resposta do cliente." (pt-BR)
   - `refuseHandoffRateLimited` — "Você já solicitou atendimento humano recentemente. Vou aguardar."
   - `refuseInvalidTemplate` — "Template inválido."

6. **`index.ts`:**
   - `whatsappPack: PackV0<...>` satisfies signature.

7. **Tests:**
   - **conformance.test.ts:** ~20 fixtures covering all 6 decision outcomes per intent kind.
   - **whatsapp-pack.test.ts:**
     - Message inside 24h window → EXECUTE.
     - Message outside 24h window → REFUSE with code `whatsapp_window_expired`.
     - Template outside 24h window → EXECUTE.
     - Customer→staff message with adversarial `*_~` chars → REWRITE with sanitized body.
     - 2nd handoff in 10 min → REQUEST_CONFIRMATION.
     - 3rd handoff in 10 min → REFUSE.
   - **sanitize.test.ts:** 10+ adversarial cases assert expected output.
   - `runConformance(whatsappPack)` zero failures.

8. **Wire at boot** — `installPack(whatsappPack)` in `kernel-bootstrap.ts`.

9. **Document env vars** in `.env.example`:
   - `WHATSAPP_HANDOFF_LIMIT_MINUTES=10`
   - `WHATSAPP_24H_WINDOW_GRACE_SECONDS=300` (allow 5min overshoot before hard refuse)

## Acceptance criteria

- [ ] `@ibatexas/pack-whatsapp` package exists with all 6 source files and 3 test files.
- [ ] `whatsappPack` satisfies `PackV0`.
- [ ] `installPack(whatsappPack)` succeeds at boot.
- [ ] `sanitizeCustomerString` passes 10+ adversarial test cases.
- [ ] Conformance corpus passes.
- [ ] `runConformance(whatsappPack)` returns zero failures.
- [ ] Two new env vars in `.env.example`.

## Testing requirements

- **Unit:** three new test files above.
- **Integration:** N/A at this stage — Task 16 wires the pack into NATS subscribers and Task 15 into command services.
- **Bypass-detection:** default-deny assertion.

## Rollout notes

Direct merge. Pack installed but not enforced. Behavioural change zero until Tasks 15/16 wire the pack into actual call sites.

## Rollback notes

Revert. ETA: 5 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 10: create @ibatexas/pack-whatsapp.

CONTEXT
Per investigation 04 (#6 in §"Highest-risk un-adjudicated async paths") and investigation 08 (P1 #4) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/:
- notification.send NATS subscriber accepts arbitrary body text — no taint check
- handoff_to_human is rate-unlimited and template-injects user-controlled reason into staff WhatsApp messages
- WhatsApp Business 24-hour customer-initiated window is not enforced — messages outside silently fail at Twilio

Your job: create @ibatexas/pack-whatsapp that gates these mutations.

REPO LAYOUT
- packages/pack-orders/ (Task 08 reference)
- packages/pack-reservations/ (Task 09 reference)
- /Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/ (canonical layout)
- apps/api/src/whatsapp/client.ts (sendText, sendMedia, sendTemplate)
- packages/tools/src/support/handoff-to-human.ts (LLM tool)
- @adjudicate/primitives: createThresholdGuard, createRewriteGuard, createSystemTaintPolicy

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/pack-whatsapp/package.json (CREATE)
- packages/pack-whatsapp/tsconfig.json (CREATE)
- packages/pack-whatsapp/src/index.ts (CREATE)
- packages/pack-whatsapp/src/types.ts (CREATE)
- packages/pack-whatsapp/src/policies.ts (CREATE)
- packages/pack-whatsapp/src/sanitize.ts (CREATE)
- packages/pack-whatsapp/src/refusals.ts (CREATE)
- packages/pack-whatsapp/src/__tests__/whatsapp-pack.test.ts (CREATE)
- packages/pack-whatsapp/src/__tests__/conformance.test.ts (CREATE)
- packages/pack-whatsapp/src/__tests__/sanitize.test.ts (CREATE)
- apps/api/src/plugins/kernel-bootstrap.ts (MODIFY — installPack(whatsappPack))
- packages/llm-provider/package.json (MODIFY — add @ibatexas/pack-whatsapp dep)
- .env.example (MODIFY — add 2 WhatsApp env vars)

WHAT TO BUILD

1. Package scaffold mirroring pack-orders, name "@ibatexas/pack-whatsapp"

2. types.ts:
   - WhatsAppIntentKind = "whatsapp.message.send" | "whatsapp.template.send" | "whatsapp.session.handover"
   - WhatsAppPayload variants per kind. Common fields: to (E.164 phone), body, senderRole: "customer" | "staff" | "system"
   - WhatsAppState: { lastCustomerMessageAt?: Date, perCustomerHandoffCount24h: Record<string, number>, recipientType: "customer" | "staff" }

3. sanitize.ts:
   - export function sanitizeCustomerString(input: string): string
   - Strip \r, \n, zero-width chars (U+200B–200F, U+2028–2029), markdown control chars (*_~`)
   - Collapse whitespace runs to single space
   - Truncate to 100 chars

4. sanitize.test.ts (10+ adversarial cases):
   - "newlines stripped": input "line1\nline2" → "line1 line2"
   - "markdown stripped": input "*bold*" → "bold"
   - "zero-width stripped": input "a​b" → "ab"
   - "long input truncated": 200 chars in → 100 chars out
   - "combined adversarial": "*_~​abc\ndef" → "abc def" (or similar — assert specifics)
   - + 5 more edge cases

5. policies.ts — whatsappPolicyBundle:
   - State guards:
     * 24h window: for whatsapp.message.send (non-template), check now - state.lastCustomerMessageAt > 24h * 1000 * 3600 (minus WHATSAPP_24H_WINDOW_GRACE_SECONDS). If outside → REFUSE with code whatsapp_window_expired
   - Auth guards:
     * customer→staff is only allowed via whatsapp.session.handover
   - Taint: createSystemTaintPolicy({systemOnlyKinds: ["whatsapp.template.send", "whatsapp.session.handover"], userMinimum: "UNTRUSTED"})
   - Business guards:
     * createThresholdGuard for whatsapp.session.handover, extract: state.perCustomerHandoffCount24h[customer.phoneHash], threshold = 1 in window WHATSAPP_HANDOFF_LIMIT_MINUTES. comparator: ">=". onCross: REQUEST_CONFIRMATION on 2nd; REFUSE on 3rd+
     * createRewriteGuard for whatsapp.message.send where senderRole === "customer" and recipientType === "staff": rewrite body via sanitizeCustomerString
   - Default: decisionRefuse with pt-BR "Operação não permitida."

6. refusals.ts:
   - refuseWindowExpired — "Não consigo enviar essa mensagem agora. Por favor aguarde uma resposta do cliente."
   - refuseHandoffRateLimited — "Você já solicitou atendimento humano recentemente. Vou aguardar."
   - refuseInvalidTemplate

7. index.ts: whatsappPack: PackV0<WhatsAppIntentKind, WhatsAppPayload, WhatsAppState, WhatsAppContext>

8. whatsapp-pack.test.ts (6+ cases per the table in this task file)

9. conformance.test.ts (~20 fixtures all 6 decision outcomes)

10. kernel-bootstrap.ts: installPack(whatsappPack, {...})

11. .env.example: append:
    WHATSAPP_HANDOFF_LIMIT_MINUTES=10
    WHATSAPP_24H_WINDOW_GRACE_SECONDS=300

CONSTRAINTS
- Read CLAUDE.md rules 4, 9 first
- pt-BR for ALL user-facing refusal text
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify apps/api/src/whatsapp/* or packages/tools/* — Tasks 14, 15, 16 own the call-site refactors
- DO NOT modify @adjudicate/* source

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] Package scaffold matches pack-orders layout
- [ ] whatsappPack satisfies PackV0
- [ ] installPack(whatsappPack) succeeds
- [ ] sanitize.test.ts has 10+ adversarial cases and all pass
- [ ] Conformance corpus passes
- [ ] runConformance(whatsappPack) zero failures
- [ ] Default decision is REFUSE
- [ ] 2 new env vars in .env.example
- [ ] `pnpm typecheck` workspace-wide passes

When complete, return: files created, sanitize test cases, and conformance corpus size.
```
