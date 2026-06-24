/**
 * @ibatexas/pack-payments — typed refusal helpers (pt-BR).
 *
 * Every refusal the Pack's policy emits flows through one of these
 * builders. The machine-readable `code` is stable — observability,
 * drift detection (M3 AaC review), and audit-record analytics key
 * off it. The user-facing text is pt-BR per CLAUDE.md rule #4 and is
 * the only place the strings live.
 *
 * Codes follow the dotted convention prefixed by the Pack's domain
 * (`payment.*` and `refund.*`), mirroring the `pix.charge.*` convention
 * in `@adjudicate/pack-payments-pix`.
 */

import { refuse, type Refusal } from "@adjudicate/core"
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br"

// ── State refusals (STATE) ──────────────────────────────────────────────

export function refusePaymentNotFound(): Refusal {
  return refuse(
    "STATE",
    "payment.not_found",
    "Pagamento não encontrado.",
  )
}

export function refusePaymentOwnershipDenied(): Refusal {
  return refuse(
    "SECURITY",
    "payment.ownership_denied",
    "Esse pagamento não pertence à sua conta.",
  )
}

export function refusePaymentTerminal(currentStatus?: string): Refusal {
  return refuse(
    "STATE",
    "payment.terminal_state",
    "Pagamento já está em estado final.",
    currentStatus ? `currentStatus=${currentStatus}` : undefined,
  )
}

export function refundStateDivergent(envelopeValue: number, stateValue: number): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "refund.state_divergent",
    "Estado de reembolso divergente. Reabra a operação.",
    `envelope=${envelopeValue} state=${stateValue}`,
  )
}

export function refuseRegenerationStateDivergent(
  envelopeValue: number,
  stateValue: number,
): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "regeneration.state_divergent",
    "Estado de regeneração divergente. Reabra a operação.",
    `envelope=${envelopeValue} state=${stateValue}`,
  )
}

export function refuseRegenerationCapExceeded(current: number, cap: number): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "regeneration.cap_exceeded",
    "Limite de regenerações para este pagamento atingido.",
    `current=${current} cap=${cap}`,
  )
}

export function refuseRetryCapExceeded(current: number, cap: number): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "retry.cap_exceeded",
    "Limite diário de tentativas de pagamento atingido. Tente novamente amanhã.",
    `current=${current} cap=${cap}`,
  )
}

// ── Business refusals (BUSINESS_RULE) ───────────────────────────────────

export function refuseRefundAmountInvalid(amount: unknown): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "refund.amount_invalid",
    "Valor de reembolso inválido.",
    `amount=${String(amount)}`,
  )
}

export function refuseRefundOverBalance(
  amount: number,
  refundable: number,
): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "refund.amount_invalid",
    "Esse valor de reembolso é maior do que o disponível.",
    `amount=${amount} refundable=${refundable}`,
  )
}

export function refuseAmountNonPositive(amount: unknown): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "payment.amount_invalid",
    "Valor do pagamento inválido.",
    `amount=${String(amount)}`,
  )
}

export function refuseMethodInvalid(method: unknown): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "payment.method.invalid",
    "Método de pagamento inválido.",
    `method=${String(method)}`,
  )
}

export function refuseSameMethodSwitch(method: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "payment.method.same",
    "Esse já é o método de pagamento atual.",
    `method=${method}`,
  )
}

/**
 * Pack-level default-deny. The kernel's own default-deny path emits
 * `default_deny`; Packs that want a richer user-facing message return
 * this Refusal from a final business-guard fall-through.
 */
export function refuseDefault(reason?: string): Refusal {
  return refuse(
    "BUSINESS_RULE",
    "payment.default.deny",
    "Operação não permitida.",
    reason,
  )
}

// ── pt-BR locale dictionary (re-export for adopter convenience) ─────────

export { portugueseRefusalMessages }
