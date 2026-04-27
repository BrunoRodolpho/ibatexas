/**
 * @adjudicate/pack-payments-pix — refusal taxonomy.
 *
 * Stable refusal codes a kernel decision may carry. Codes are dotted
 * and prefixed with `pix.charge.*`; the user-facing copy is pt-BR
 * (matching IbateXas's user base) with English fallbacks documented in
 * the README. Adopters who need other locales can map by `code`.
 *
 * Keep one builder per code. Keep the prefix stable — analytics and
 * dashboards key off it.
 */

import { refuse, type Refusal } from "@adjudicate/core";

// ── State refusals ──────────────────────────────────────────────────────────

export const refusePixChargeNotFound = (chargeId: string): Refusal =>
  refuse(
    "STATE",
    "pix.charge.not_found",
    "Não localizamos esse pagamento PIX.",
    `chargeId=${chargeId}`,
  );

export const refusePixChargeAlreadyCaptured = (chargeId: string): Refusal =>
  refuse(
    "STATE",
    "pix.charge.already_captured",
    "Esse pagamento PIX já foi confirmado.",
    `chargeId=${chargeId}`,
  );

export const refusePixChargeExpired = (chargeId: string): Refusal =>
  refuse(
    "STATE",
    "pix.charge.expired",
    "Esse pagamento PIX expirou. Gere um novo QR para continuar.",
    `chargeId=${chargeId}`,
  );

export const refusePixChargeFailed = (chargeId: string): Refusal =>
  refuse(
    "STATE",
    "pix.charge.failed",
    "O pagamento PIX falhou. Por favor, tente novamente.",
    `chargeId=${chargeId}`,
  );

// ── Business-rule refusals ──────────────────────────────────────────────────

export const refusePixAmountInvalid = (
  amountCentavos: number,
): Refusal =>
  refuse(
    "BUSINESS_RULE",
    "pix.charge.amount_invalid",
    "O valor do pagamento PIX é inválido.",
    `amountCentavos=${amountCentavos}`,
  );

export const refusePixRateLimitExceeded = (
  count: number,
  cap: number,
): Refusal =>
  refuse(
    "BUSINESS_RULE",
    "pix.charge.rate_limit_exceeded",
    "Muitas tentativas de pagamento. Aguarde alguns minutos antes de tentar novamente.",
    `count=${count}, cap=${cap}`,
  );

export const refusePixRefundExceedsCapture = (
  requested: number,
  available: number,
): Refusal =>
  refuse(
    "BUSINESS_RULE",
    "pix.charge.refund_exceeds_capture",
    "O valor do reembolso é maior que o valor disponível.",
    `requested=${requested}, available=${available}`,
  );

export const refusePixRefundUncapturedCharge = (chargeId: string): Refusal =>
  refuse(
    "BUSINESS_RULE",
    "pix.charge.refund_before_capture",
    "Não é possível reembolsar um pagamento que ainda não foi capturado.",
    `chargeId=${chargeId}`,
  );

// ── Auth refusals ───────────────────────────────────────────────────────────

export const refusePixConfirmRequiresWebhook = (): Refusal =>
  refuse(
    "AUTH",
    "pix.charge.confirm_requires_webhook",
    "A confirmação de PIX só pode ser feita pelo provedor de pagamento.",
  );
