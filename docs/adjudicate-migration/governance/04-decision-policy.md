> **NOTE — load-bearing with localized stale refs.** The six decision outcomes (`EXECUTE/REFUSE/DEFER/ESCALATE/REQUEST_CONFIRMATION/REWRITE`), refusal taxonomy, and pt-BR localization below are still authoritative. **Exception:** line 216 references `IBX_KERNEL_SHADOW`/`IBX_KERNEL_ENFORCE` typo-guarding — these env vars were deleted by the IBX-IGE v3.0 cutover (`f3bea43`). The underlying `validateEnforceConfig` contract may still exist as a type-shape; verify before relying on it. See `README.md` in this directory for the full classification.

---

# 04 — Decision Policy

> Companion to: [`01-intent-taxonomy.md`](./01-intent-taxonomy.md), [`03-trust-boundary-model.md`](./03-trust-boundary-model.md), [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md), [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md).
> Sources: investigations [01](../investigation/01-llm-tool-execution.md), [05](../investigation/05-adjudicate-capabilities.md), [08](../investigation/08-security-trust-boundaries.md). Adjudicate framework: `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts`, `pack-payments-pix/src/policies.ts`, `pack-deployments-approval/src/policies.ts`, `locales-pt-BR/src/index.ts`.

## Executive summary

- Six decision outcomes per `Decision` union from `@adjudicate/core` (per investigation 05): **EXECUTE / REFUSE / DEFER / ESCALATE / REQUEST_CONFIRMATION / REWRITE**. Every adjudicated intent produces exactly one. Default for unmatched bundles is **REFUSE**.
- All user-facing strings are **pt-BR** from `@adjudicate/locales-pt-BR.portugueseRefusalMessages` (per `/Users/thaisrodolpho/projects/adjudicate/packages/locales-pt-BR/src/index.ts`), localized at presentation time via `localizeDecision(decision, portugueseRefusalMessages)` from `@adjudicate/core` (per investigation 05 Tier 0 #1).
- The **`BASIS_CODES`** vocabulary from `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts` is the controlled set of basis codes. The refusal-taxonomy table in this doc maps every code to a pt-BR message and source category. Pack-specific codes (e.g. `pix_pending`, `slot_full`) extend the dictionary by spread, not free-form strings.
- **Confirmation** (REQUEST_CONFIRMATION) follows the `pack-deployments-approval` pattern: kernel emits REQUEST_CONFIRMATION with `prompt`, user (or staff) responds via a separate envelope carrying `confirmationReceipt`, kernel substitutes EXECUTE on the second pass. The receipt protocol is symmetric for destructive customer actions (anonymize), destructive operator actions (force-cancel, refund), and confirm-or-cancel checkout flows.
- **Escalation** (ESCALATE) routes to a human via the `whatsapp.handoff.request` intent kind. Monetary thresholds (refund > R$500), allergy-related orders, anonymize requests, and policy-rule violations on critical paths trigger ESCALATE per the table below.

## The six decision outcomes

Per investigation 05 §"core top-level" — `Decision` is a 6-variant union. Each row below shows ibatexas's adopted semantics.

| Decision kind | Semantics | When ibatexas uses it | User-facing pt-BR |
|---|---|---|---|
| `EXECUTE` | Kernel approves; downstream executor runs the original envelope. | All normal customer/staff/system flows where guards pass. Default outcome for read-only-like mutations after WS6 enforce. | (no user text; LLM continues turn) |
| `REFUSE` | Kernel rejects; envelope discarded; user told why. | Policy violations (allergens, slot full, terminal state, role insufficient, kill switch active, ledger replay). | Per refusal taxonomy table below. |
| `DEFER` | Kernel parks the envelope awaiting a wire signal; resumes on signal arrival. | PIX payment pending → wait for `payment.confirmed`; LGPD anonymize → wait 24h for `customer.anonymize.confirmed_after_grace` (timeout sweeper signal); KYC vendor pending → wait for `kyc.vendor.completed`; staff handoff pending → wait for `staff.handoff.received` (future). | `"Estou aguardando confirmação. Te aviso assim que tudo estiver certo."` — current text from `llm-responder.ts:399` per investigation 04 §"Park mechanism"; for `customer.anonymize`: `"Pedido de exclusão recebido. Você tem 24 horas para cancelar."` |
| `ESCALATE` | Kernel routes to a human; envelope held until human resolves. | Refund > R$500 (matches `ESCALATE_REFUND_THRESHOLD_CENTAVOS` from `@adjudicate/pack-payments-pix` per investigation 05); allergen-marked order cancellation; LGPD anonymize after 3+ rapid retries within 24h (suspicious pattern); Stripe dispute open. | `"Vou pedir ajuda da nossa equipe — eles entram em contato em breve."` |
| `REQUEST_CONFIRMATION` | Kernel emits a destructive-action prompt; consumer must produce a receipt envelope. | Cancel paid reservation within ≤24h of slot; cancel paid order; refund between R$500 and R$1000 (CONFIRM threshold per `@adjudicate/pack-payments-pix`); OWNER `payment.waive` / `payment.status.force`. (LGPD anonymize uses DEFER + 24h grace instead — see DEFER row.) | `"Tem certeza? Para confirmar, responda 'sim, confirmo'."` (customer) / `"Confirmar essa ação? Use o ticket de aprovação."` (staff) |
| `REWRITE` | Kernel substitutes a different envelope; executor runs the rewritten one. | Cap order quantity at stock (REWRITE with `quantity = stock`); cap rampPercent at MAX (mirroring `pack-deployments-approval`'s `MAX_PRODUCTION_RAMP_PERCENT`); sanitize free-form text (homoglyph normalize per `validation/HOMOGLYPH_NORMALIZED` basis code). | `"Pedido ajustado para a quantidade disponível em estoque."` (with the adjusted number filled in) |

`Decision` constructor exports per investigation 05 §"core top-level":
- `decisionExecute(basis: DecisionBasis[])`
- `decisionRefuse(refusal: Refusal, basis: DecisionBasis[])`
- `decisionDefer(signal: string, timeoutMs: number, basis: DecisionBasis[])`
- `decisionEscalate(to: "human"|"supervisor", reason: string, basis: DecisionBasis[])`
- `decisionRequestConfirmation(prompt: string, basis: DecisionBasis[])`
- `decisionRewrite(rewritten: IntentEnvelope, reason: string, basis: DecisionBasis[])`

## Refusal taxonomy table

The refusal code (`Refusal.code`) is the stable identifier under `byCode` lookup in `RefusalMessages`. The pt-BR text comes from `portugueseRefusalMessages` (per `/Users/thaisrodolpho/projects/adjudicate/packages/locales-pt-BR/src/index.ts` — verified). Pack-specific codes spread on top.

### Kernel-emitted codes (from `KERNEL_REFUSAL_CODES`, per `portugueseRefusalMessages.byCode`)

| Refusal code | Basis | Trigger | pt-BR (from `portugueseRefusalMessages`) |
|---|---|---|---|
| `kill_switch_active` | `kill/active` | Global kill switch on; see [`07-rollback-recovery.md`](./07-rollback-recovery.md) §"Global kill switch" | `"Sistema temporariamente indisponível."` |
| `schema_version_unsupported` | `schema/version_unsupported` | Envelope version mismatch | `"Não foi possível processar essa ação no momento."` |
| `taint_level_insufficient` | `taint/level_insufficient` | User taint below `systemMinimum` for kind | `"Não posso realizar essa ação com a informação disponível."` |
| `default_deny` | `kernel/default_deny` | Bundle reached its default REFUSE slot | `"Essa ação não é permitida neste momento."` |
| `guard_panic` | `kernel/guard_panic` | A guard threw during evaluation; kernel converts to SECURITY REFUSE per `core/src/basis-codes.ts:96-99` | `"Sistema temporariamente indisponível."` |
| `ledger_replay_suppressed` | `ledger/replay_suppressed` | Intent hash matched a recent successful execution | `"Essa ação já foi processada."` |
| `kernel_deadline_exceeded` | `deadline/exceeded` | `adjudicateWithDeadline` exceeded budget | `"Não foi possível processar a ação no tempo disponível."` |

### ibatexas Pack-specific extensions (spread on top of kernel codes)

| Refusal code | Basis | Trigger | pt-BR |
|---|---|---|---|
| `allergen_mismatch` | `business/rule_violated` | `passesAllergenFilter` (`packages/tools/src/search/search-products.ts`) fails — order contains a flagged allergen | `"Esse pedido contém um alérgeno que você marcou. Posso buscar uma opção compatível?"` |
| `slot_full` | `business/rule_violated` | `TimeSlot.reservedCovers >= capacity` (per investigation 03 §"reservation.service.ts") | `"Esse horário está lotado. Quer entrar na lista de espera?"` |
| `terminal_state` | `state/terminal_state` | Order/reservation already in CANCELED/DELIVERED/NO_SHOW; transition illegal | `"Esse pedido já foi finalizado e não pode ser alterado."` |
| `cart_ownership_violation` | `auth/scope_insufficient` | `assertCartOwnership` fails (investigation 01 §"Cross-customer leak risk") | `"Esse carrinho pertence a outro cliente."` |
| `scope_insufficient` | `auth/scope_insufficient` | Staff role too low for kind (e.g. ATTENDANT attempting `payment.refund.issue`) | `"Sua função não permite essa ação."` |
| `identity_missing` | `auth/identity_missing` | Customer JWT absent on required-auth route | `"Por favor, faça login para continuar."` |
| `identity_expired` | `auth/identity_expired` | JWT past expiry | `"Sua sessão expirou. Faça login novamente."` |
| `payment_method_invalid` | `business/rule_violated` | Stripe doesn't support the requested method for the cart total | `"Não foi possível processar esse meio de pagamento."` |
| `pix_pending` | `state/transition_illegal` | PIX already in pending; new `payment.charge.create` for same order rejected | `"Já existe um PIX pendente. Vou esperar a confirmação."` |
| `pix_expired` | `state/terminal_state` | PIX past expiry; can't confirm | `"O PIX expirou. Vou gerar um novo QR para você."` |
| `regeneration_limit_exceeded` | `business/rule_violated` | `regenerate_pix` past 3/h or 5/order (investigation 08 §"Rate limiting") | `"Limite de regerações atingido. Posso gerar daqui a pouco."` |
| `refund_amount_invalid` | `schema/payload_invalid` | Refund amount > refundable balance | `"Esse valor de reembolso é maior do que o disponível."` |
| `idempotency_duplicate` | `ledger/replay_suppressed` | Webhook event_id already processed (per `createIdempotencyGuard` in [`03-trust-boundary-model.md`](./03-trust-boundary-model.md) §"Boundary 6") | `"Esse evento já foi processado."` |
| `quantity_capped` | `business/quantity_capped` | Companion to REWRITE quantity clamp; emitted when quantity > stock and policy can't REWRITE | `"Só temos {stock} unidades disponíveis."` (with substitution) |
| `handoff_rate_exceeded` | `business/rule_violated` | Per-customer handoff > 1/10min (investigation 08 §"P1 #4") | `"Já avisei nossa equipe. Aguarde um momento, por favor."` |
| `ledger_unavailable` | `kernel/default_deny` (custom) | Redis ledger circuit open + `IBX_LEDGER_FAIL_OPEN=false` (investigation 06 §"Intent ledger wiring") | `"Sistema temporariamente indisponível. Tente em alguns minutos."` |

### Localization wiring

Per investigation 05 Tier 0 #1: every kernel decision becomes user-facing only via `localizeDecision(decision, ibxRefusalMessages)`. Where:

```ts
import { localizeDecision } from "@adjudicate/core";
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-BR";

const ibxRefusalMessages = {
  fallback: portugueseRefusalMessages.fallback,
  byCode: {
    ...portugueseRefusalMessages.byCode,
    // ibatexas Pack-specific codes
    allergen_mismatch: "Esse pedido contém um alérgeno que você marcou. ...",
    slot_full: "Esse horário está lotado. Quer entrar na lista de espera?",
    // … (table above)
  },
};
```

This single `ibxRefusalMessages` is installed at boot and used at every presentation site (LLM tool result, REST API error body, WhatsApp message).

## Confirmation policy table

Pattern (from `@adjudicate/pack-deployments-approval`, per investigation 05 §"pack-deployments-approval"):

1. Original envelope arrives → kernel emits **REQUEST_CONFIRMATION** with `prompt` text.
2. Consumer (LLM tool result, REST response, WhatsApp message) renders the prompt + a confirmation token.
3. User/staff produces a second envelope carrying `confirmationReceipt` in `AdjudicateAndAuditDeps`.
4. Kernel re-evaluates and substitutes **EXECUTE** with basis `confirmation/received` (per `BASIS_CODES.confirmation.RECEIVED` in `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts:85-87`).
5. AuditRecord links both envelopes via `supersedes` (see [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Supersession chains").

| Intent kind | Trigger condition | Prompt (pt-BR) | Receipt source | Timeout |
|---|---|---|---|---|
| `order.cancel` | Order paid + delivery type = delivery + ≤2h to delivery window | `"Tem certeza que quer cancelar esse pedido pago? Responda 'sim, cancelar' para confirmar."` | Customer second message in same session | 5 min |
| `reservation.cancel` | Reservation confirmed + ≤24h to slot time | `"O cancelamento desse horário é fora do prazo. Confirma o cancelamento?"` | Customer second message | 10 min |
| `payment.refund.issue` | Amount > R$500 AND ≤ R$1000 (CONFIRM threshold) | `"Confirmar reembolso de R${valor}? Use o ticket {ticketId}."` | Second staff envelope with `confirmationReceipt` token from a separate admin endpoint | 15 min |
| `payment.refund.issue` | Amount > R$1000 | (skips REQUEST_CONFIRMATION; routes to ESCALATE — see table below) | n/a | n/a |
| `payment.waive` | Always (OWNER-only) | `"Confirmar perda contábil de R${valor}? Razão: {reason}."` | Second OWNER envelope | 15 min |
| `payment.status.force` | Always (OWNER-only) | `"Forçar status de pagamento para {newStatus}? Essa ação é irreversível."` | Second OWNER envelope | 15 min |
| `order.cancel.force` | Always (MANAGER+) | `"Forçar cancelamento ignorando regras de transição? Razão: {reason}."` | Second MANAGER envelope | 15 min |
| `system.kernel.kill_switch.toggle` | Always | `"Ativar parada de emergência? Razão: {reason}."` | Second admin envelope | 5 min |

**Note:** `customer.anonymize` does NOT use REQUEST_CONFIRMATION. It uses **DEFER with 24h grace** — see the DEFER section below and `@ibatexas/pack-customer-onboarding` (task 21). The fresh-OTP gate (5 min TTL) is enforced at the HTTP layer (task 14) before the envelope is ever built; the DEFER period gives the customer 24 hours to call `customer.anonymize.cancel`. This is a deliberate departure from the receipt-protocol pattern: irreversible PII deletion warrants a longer "I really meant it" window than a 5-minute prompt provides.
| `system.backfill.execute` | `dryRun=false` | `"Executar backfill em produção? Job: {job}."` | Second admin envelope | 15 min |

### Receipt envelope shape

The confirmation receipt is **a separate envelope** with its own kind suffix (`.confirm`) or a discriminating payload field. Per investigation 05 §"adjudicateAndAuditDeps" the framework slot is `confirmationReceipt`:

```ts
// First envelope:
const original = buildEnvelope({
  kind: "payment.refund.issue",
  payload: { paymentId, amountCentavos: 60000, reason: "customer_complaint" },
  actor: { principal: "user", taint: "TRUSTED", sessionId: "staff:xyz" },
});
// Kernel returns REQUEST_CONFIRMATION; UI shows prompt.

// Second envelope (receipt redemption):
const receipt = buildEnvelope({
  kind: "payment.refund.issue.confirm",
  payload: { originalIntentHash: original.intentHash, ticketId },
  actor: { principal: "user", taint: "TRUSTED", sessionId: "staff:xyz" },
});
// adjudicateAndAudit called with deps.confirmationReceipt = { originalIntentHash, redemptionToken }
// Kernel substitutes EXECUTE with basis confirmation/received.
```

The `.confirm` suffix is the convention for ibatexas; it surfaces as a distinct kind for the kernel and audit log. Per `pack-deployments-approval`, the deploy pack uses `deployment.approval.resolve` as the receipt kind (per investigation 05 §"pack-deployments-approval" — `DeploymentIntentKind`).

### Receipt token storage

Per investigation 05 §"adapter-core" — `createInMemoryConfirmationStore()` and `createRedisConfirmationStore(opts)` from `@adjudicate/adapter-core`. ibatexas uses the Redis variant in production. Key shape: `rk("confirmation:pending:{intentHash}")`, TTL = receipt timeout from table above + 60s grace.

## Escalation policy table

ESCALATE routes to a human. The kernel decision is `ESCALATE`; the executor publishes a `whatsapp.handoff.request` envelope with `principal: "system"` to fan out to staff. Per investigation 05 §"core top-level" — `decisionEscalate(to: "human"|"supervisor", reason: string, basis)`.

| Intent kind | Trigger condition | Reason | `to` | Staff notification template |
|---|---|---|---|---|
| `payment.refund.issue` | Amount > R$1000 (matches `ESCALATE_REFUND_THRESHOLD_CENTAVOS = 100_000` in `@adjudicate/pack-payments-pix`, per investigation 05) | `"refund_above_escalate_threshold"` | `"human"` | `"Reembolso de R${valor} pedido por {staffName} no pedido {orderId}. Aprovar?"` |
| `payment.dispute.open` | Always (Stripe `charge.dispute.created`) | `"stripe_dispute"` | `"human"` | `"Disputa do pedido {orderId} — R${valor}. Detalhes: {stripeDisputeUrl}"` |
| `customer.anonymize` | 3+ anonymize/cancel toggles within 24h (suspicious — possible account takeover or coercion) | `"anonymize_rapid_retries"` | `"human"` | `"Cliente {phoneHash} alternou exclusão/cancelamento {n} vezes em 24h. Verificar segurança da conta."` |
| `order.cancel` | Order has allergen-flagged item + already paid + ≤30min to delivery | `"allergen_cancel_late"` | `"human"` | `"Pedido {orderId} com alérgeno marcado pediu cancelamento tardio."` |
| `order.checkout.create` | Cart total > R$2000 (large-ticket policy) | `"large_ticket_review"` | `"human"` | `"Pedido grande de R${valor} aguardando revisão."` |
| `reservation.no_show.mark` | Customer's no-show count > 3 in 90 days | `"chronic_no_show"` | `"supervisor"` | `"Cliente {customerId} com {count} no-shows. Bloquear reservas?"` |
| `system.kernel.kill_switch.toggle` | Active = false (clearing kill switch after incident) | `"kill_switch_cleared"` | `"supervisor"` | `"Kill switch desativado por {adminName}. Razão: {reason}."` |

### Handoff fan-out

After ESCALATE, the kernel-side response is just the Decision. The executor then publishes a system-actor `whatsapp.handoff.request` envelope:

```
[customer's order.cancel envelope] → kernel says ESCALATE("allergen_cancel_late")
   ↓ (executor publishes follow-on envelope)
[system actor whatsapp.handoff.request envelope] → kernel says EXECUTE
   ↓
notification.send subscriber → STAFF_NOTIFICATION_PHONE
```

The original envelope is **not** parked (unlike DEFER). It produces ESCALATE in audit, and a separate handoff envelope creates the human notification. The customer-facing message is rendered from the escalation reason:

`"Não consegui cancelar agora — vou pedir ajuda da nossa equipe. Eles entram em contato em breve."`

## Decision-kind selection per intent

A summary view: which decision kinds are *possible* per intent kind (subset of the 6). Drives policy bundle author tests per investigation 07 §"Test categories" "Kernel contract".

| Intent kind | Possible decisions |
|---|---|
| `order.cart.ensure` | EXECUTE, REFUSE (cart-ownership) |
| `order.item.add` | EXECUTE, REFUSE (allergen, ownership), REWRITE (quantity cap) |
| `order.checkout.create` | EXECUTE, REFUSE (kitchen closed, payment invalid), DEFER (PIX pending), REWRITE (quantity cap on stale cart) |
| `order.cancel` | EXECUTE, REFUSE (terminal state, ownership), REQUEST_CONFIRMATION (paid + delivery imminent), ESCALATE (allergen + late) |
| `order.cancel.force` | EXECUTE, REQUEST_CONFIRMATION (always for MANAGER+) |
| `payment.refund.issue` | EXECUTE (≤R$500), REQUEST_CONFIRMATION (R$500-R$1000), ESCALATE (>R$1000) |
| `payment.charge.confirm` | EXECUTE, REFUSE (idempotency duplicate, no matching payment) |
| `payment.dispute.open` | ESCALATE (always) |
| `payment.waive` | REQUEST_CONFIRMATION (always) |
| `payment.status.force` | REQUEST_CONFIRMATION (always) |
| `reservation.create` | EXECUTE, REFUSE (slot full, allergen, ownership), REWRITE (party size cap) |
| `reservation.cancel` | EXECUTE, REQUEST_CONFIRMATION (≤24h), REFUSE (terminal state) |
| `customer.anonymize` | DEFER (24h grace, signal `customer.anonymize.confirmed_after_grace`), REFUSE (OTP stale, already pending), ESCALATE (3+ rapid retries) |
| `customer.anonymize.cancel` | REFUSE-supersedes-parked (happy path; clears the parked anonymize), REFUSE-no-parked-deletion |
| `whatsapp.handoff.request` | EXECUTE, REFUSE (rate exceeded) |
| `whatsapp.message.send` | EXECUTE, REFUSE (template invalid, taint untrusted body), REWRITE (sanitize free-form fields) |
| `system.kernel.kill_switch.toggle` | REQUEST_CONFIRMATION (always), ESCALATE (on clear-after-incident) |

## Audit fields per decision (summary)

Per `AuditRecord` (v4) from `@adjudicate/core` (per investigation 05). See [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) for the full schema.

| Decision | Required fields |
|---|---|
| EXECUTE | `decision.basis[]`, `durationMs`, `plan` (AuditPlanSnapshot), `ledgerHit` (for replay-suppressed double-execute detection) |
| REFUSE | `decision.refusal: {kind, code, userFacing, detail?}`, `decision.basis[]` (must include the rule_violated category) |
| DEFER | `decision.signal`, `decision.timeoutMs`, `decision.basis[]`, `parkKey` (Redis key for park entry) |
| ESCALATE | `decision.to: "human"\|"supervisor"`, `decision.reason: string`, `decision.basis[]`, downstream `handoffEnvelopeIntentHash` (linked envelope) |
| REQUEST_CONFIRMATION | `decision.prompt: string`, `decision.basis[]`, `confirmationKey` (Redis key for pending receipt), `expectedReceiptKind` (the `.confirm` kind expected) |
| REWRITE | `decision.rewritten: IntentEnvelope`, `decision.reason: string`, `decision.basis[]`, both `intentHash` (original) and `rewritten.intentHash` recorded |

## Default REFUSE on unmatched

Per master plan §"Governance principles" #4: every PolicyBundle ends with `default: constant(decisionRefuse(...))`. The default refusal uses code `default_deny` (per `portugueseRefusalMessages.byCode.default_deny`) and basis `kernel/default_deny`. Adopting `validateEnforceConfig(KNOWN_INTENT_KINDS, env)` at boot (per investigation 06 §"P0-3") additionally guards against typos in `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` — unknown tokens in those env vars produce a `recordSinkFailure({code: "enforce_config_typo"})` event and a console warning, but they do **not** flip an intent into the wrong gate.

## Decision → user surface

The kernel produces a Decision; the LLM/HTTP route/subscriber renders it to the customer. The rendering pipeline:

1. **Localize**: `userText = localizeDecision(decision, ibxRefusalMessages)` (per investigation 05 Tier 0).
2. **Inject** into the appropriate surface:
   - LLM tool result: structured `{status: "refused"\|"deferred"\|"escalated"\|"confirmation_required", message: userText, decision: {...}}` (current `llm-responder.ts:426-457` shape preserved).
   - REST API: HTTP response body `{error: {code, message: userText, decisionId: intentHash}}`. Status code: 400 for REFUSE business, 401 for auth, 403 for taint, 409 for state, 422 for schema, 503 for kill switch.
   - WhatsApp: `sender.sendText(toPhoneHash, userText)`. No structured payload; the customer sees only the message.
3. **Audit**: the same `userText` is recorded in `AuditRecord.decision.userFacing` for post-hoc compliance review.

The 6 decision kinds map cleanly to existing tool-result shapes in `llm-responder.ts:251-457` per investigation 01 — only minor surface tweaks needed to add ESCALATE / REQUEST_CONFIRMATION fields. REFUSE and DEFER are already plumbed.

## Cross-references

- Intent kinds and their actor constraints: [`01-intent-taxonomy.md`](./01-intent-taxonomy.md).
- Trust boundaries that gate decision authority: [`03-trust-boundary-model.md`](./03-trust-boundary-model.md).
- Audit schema fields per decision: [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md).
- DEFER park/resume mechanics: [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md).
- Per-decision rollback and kill switch behavior: [`07-rollback-recovery.md`](./07-rollback-recovery.md).
- pt-BR localization source: `/Users/thaisrodolpho/projects/adjudicate/packages/locales-pt-BR/src/index.ts`.
- Basis code vocabulary: `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts`.
- Adjudicate evaluation order: `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/kernel/adjudicate.ts` (kill → schema → state → taint → auth → business → default).
