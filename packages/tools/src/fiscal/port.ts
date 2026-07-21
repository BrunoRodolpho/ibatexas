// Fiscal (NFC-e / NFe) provider port — NEW-014, mock-first (integrate-first
// legal cornerstone). Brazilian restaurants must emit a fiscal document
// (NFC-e for consumer sales) for every completed order; this is the seam
// between the ratified real provider (Focus NFe) and a deterministic local
// mock so the whole flow is buildable + test-complete before the external
// certificate/account procurement lands.
//
// The PORT is pure (no I/O in the interface). Adapters do the emission:
//   - MockFiscalProvider  (mock-provider.ts) — deterministic, local, DEFAULT.
//   - FocusNFeAdapter     (focusnfe-provider.ts) — the integrate-first target,
//                          credential-gated, NEVER called in tests.
// Provider selection is env-driven (FISCAL_PROVIDER, index.ts).

/**
 * A single fiscal line item. Prices are INTEGER CENTAVOS (Hard Rule #2) — a
 * fiscal document must never carry a float amount.
 */
export interface FiscalLineItem {
  /** Product description as it appears on the fiscal document (pt-BR). */
  readonly description: string;
  /** Whole-unit quantity (NFC-e item quantity). */
  readonly quantity: number;
  /** Unit price in integer centavos. */
  readonly unitPriceCentavos: number;
}

/**
 * The order projection's fiscal-relevant fields — the emit input. Built (in
 * PR2) from the delivered order's projection; kept deliberately minimal for the
 * mock while carrying everything the real NFC-e payload needs.
 */
export interface FiscalEmitInput {
  readonly orderId: string;
  /** The human-facing order number (goes on the fiscal doc reference). */
  readonly displayId: number;
  readonly items: readonly FiscalLineItem[];
  /** Order total in integer centavos (must equal Σ item quantity×unitPrice). */
  readonly totalCentavos: number;
  /**
   * The consumer's CPF for a "nota com CPF", when the customer provided one.
   * PII — audited redacted (audit-redactor). Omitted for an anonymous note.
   */
  readonly customerTaxId?: string;
}

/**
 * Emission outcome. `approved` carries the SEFAZ-issued access key + document
 * URLs; `rejected` carries the SEFAZ rejection reason; `timeout`/`error` are
 * the retriable transport/authorization outcomes (the pack policy bounds the
 * retries; the caller never treats a non-`approved` as a fiscal success).
 */
export type FiscalEmitStatus = "approved" | "rejected" | "timeout" | "error";

export interface FiscalEmitResult {
  readonly status: FiscalEmitStatus;
  /** SEFAZ chave de acesso (44 digits) — present only on `approved`. */
  readonly accessKey?: string;
  /** URL of the authorized XML — present only on `approved`. */
  readonly xmlUrl?: string;
  /** URL of the DANFE PDF — present only on `approved`. */
  readonly pdfUrl?: string;
  /** SEFAZ/provider reason — present on `rejected` (and on `error`/`timeout`). */
  readonly rejectionReason?: string;
}

/**
 * The fiscal provider port. `emit` is idempotency-agnostic at this layer — the
 * subscriber (PR2) dedups on the order + the execution ledger; a provider MAY
 * additionally dedup on `input.orderId` as its own reference.
 */
export interface FiscalProviderPort {
  /** Stable provider id for logs/audit ("mock" | "focusnfe"). */
  readonly name: string;
  emit(input: FiscalEmitInput): Promise<FiscalEmitResult>;
}
