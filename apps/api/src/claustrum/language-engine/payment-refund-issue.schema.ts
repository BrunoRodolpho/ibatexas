// payment-refund-issue.schema.ts — the SECOND authored extraction schema
// (FE-T10), and the FIRST money-tier one. Wires the BKL-085 refunds-by-
// message verb (`payment.refund.issue`) through the extraction-schema
// authoring contract: the model sees ONLY `orderReference` (which order to
// refund), `amount` (how much, in REAIS), and `reason` (optional, free text).
// `paymentId` and the three balance-snapshot fields
// (`refundableBalanceCentavos` / `amountInCentavos` / `currentRefundedCentavos`)
// are Identity/State-class, resolver-stamped from the live DB payment row
// (STOP-GATE B, `ops-resolver.ts`'s `resolveRefundTarget`) — never listed
// here, never requested of the model.
//
// ── Unit semantics (the ticket's explicit "ground it" ask) ──────────────────
//
// The model emits NL amounts; the resolver coerces — never the reverse. The
// wire contract's `PaymentRefundIssuePayload.refundAmountCentavos` is an
// INTEGER CENTAVOS field (CLAUDE.md rule #2: "Prices: integer centavos —
// never floats"), but that rule governs INTERNAL representation — it does not
// mean the MODEL should be asked to do reais->centavos arithmetic itself.
// `ops-resolver.ts`'s `resolveRequestedRefundCentavos` (BKL-094) is the
// established precedent this schema REUSES, not reinvents: live proof showed
// both the 4B and Sonnet spontaneously put the spoken figure under
// `amount`/`value`/`valor` IN REAIS ("reembolsa 10 reais" -> `{amount: 10}`),
// which `parseRefundReaisToCentavos` then converts to EXACT integer centavos
// via decimal-string integer arithmetic (never `reais * 100` — IEEE-754 would
// occasionally corrupt a cent). So THIS schema exposes `amount` as a REAIS
// number (the field name BKL-094 already prioritizes first among its alias
// list) and asks the model for NOTHING but the natural-language figure — the
// resolver's existing, already-tested coercion does the money-safe part,
// unchanged. `refundAmountCentavos` (integer centavos) is deliberately NOT
// exposed here: it would ask the model to multiply, the exact class of
// arithmetic mistake ("cinquenta" -> 5000 vs 50000) BKL-085's own UNTRUSTED-
// taint CONFIRM overlay exists to catch, and REAIS is what models already
// naturally produce without being asked.
//
// ── The order reference — Directive, NOT `orderId` ──────────────────────────
//
// `resolveRefundTarget` needs SOME order reference to resolve a payment to
// refund (unlike `order.status.transition`, refund has no ambient "most
// recent order" fallback — money moves only against an order the staff named).
// The wire's resolved field is literally `payload.orderId` (display number /
// customer name pre-resolution, rewritten to the real id post-resolution —
// the established BKL-089 idiom), but `orderId` is a FORBIDDEN extraction-
// schema field NAME regardless of declared trustClass
// (FORBIDDEN_EXTRACTION_FIELD_NAMES, extraction-schema.ts) — it denotes a
// RESOLVED identifier convention-wide, and this field's value is NOT
// resolved yet; it is exactly the "natural-language reference the model
// copies verbatim" field-trust.ts's own Directive-class definition names.
// This schema therefore names it `orderReference`; `ops-resolver.ts`'s
// `resolveRefundTarget` accepts it as an ADDITIVE alias for `payload.orderId`
// (mirroring BKL-094's alias-fallback shape exactly — see that module), so
// the model's narrowed `{orderReference, amount, reason}` payload still
// resolves a real order, and the pre-existing (unguided, `inputSchema: {}`)
// refund-by-message path — which already accepts a bare `orderId` key when
// no typed schema is wired — keeps working unchanged.

import {
  type CapabilityExtractionSchema,
  assertSoundExtractionSchema,
} from "./extraction-schema.js";

/**
 * FE-T10 — the RESOLVER-applied default reason (`ops-resolver.ts`'s
 * `resolveRefundTarget`) when the model supplied none. Lives here (not in
 * `ops-resolver.ts`) so `audit-metadata.ts` (a language-engine sibling) can
 * import it without creating a reverse `claustrum -> ops` dependency (the
 * established direction is `ops -> claustrum`, e.g. `ops-conductor.ts`
 * already imports from `../claustrum/`) — `ops-resolver.ts` imports this
 * constant FROM here instead, the same direction as that precedent.
 * Recognizing this exact string is what lets `derivePaymentRefundIssue`
 * attribute a defaulted `reason` to the RESOLVER, never the model — without
 * it, the audited `reason` key would be indistinguishable from genuine model
 * output (both land under the SAME wire key, unlike `orderReference`/
 * `amount`, which are RENAMED on resolution and so unambiguously signal "the
 * resolver touched this").
 */
export const OPS_REFUND_DEFAULT_REASON = "Reembolso solicitado pela operação (ops).";

export const PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA: CapabilityExtractionSchema =
  {
    capability: "payment.refund.issue",
    fields: [
      {
        name: "orderReference",
        // Directive, NOT Identity: an unresolved NL reference (display
        // number or customer name) the resolver must still look up — never
        // the resolved `orderId` itself (see the module header).
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          description:
            "Referência do pedido a reembolsar — número de exibição ou " +
            "nome do cliente (o resolver mapeia para o pedido/pagamento real).",
        },
        required: true,
      },
      {
        name: "amount",
        // Directive: user/model-produced content the runtime adjudicates
        // (the refund-magnitude ladder + the BKL-085 UNTRUSTED-taint CONFIRM
        // overlay, pack-payments/src/policies.ts) before it can ever EXECUTE.
        trustClass: "directive",
        jsonSchema: {
          type: "number",
          description:
            "Valor do reembolso EM REAIS (não em centavos) — ex.: 10.5 " +
            "para R$ 10,50. Omita se o funcionário não mencionar um valor " +
            "(reembolso do saldo integral).",
        },
        required: false,
      },
      {
        name: "reason",
        trustClass: "directive",
        jsonSchema: {
          type: "string",
          description:
            "Motivo do reembolso, se mencionado (ex.: 'cliente desistiu', " +
            "'pedido errado'). Omita se não houver motivo explícito.",
        },
        required: false,
      },
    ],
    example: {
      utterance: "reembolsa 20 reais do pedido 12345, o cliente desistiu",
      payload: {
        orderReference: "12345",
        amount: 20,
        reason: "o cliente desistiu",
      },
    },
    // FE-T11 (review) — the plan-time payload filter (ibatexas-planner.ts's
    // stripUnauthoredPayloadFields) would otherwise strip every one of these
    // as undeclared fields (none is `orderReference`/`amount`, this schema's
    // own field names). But `ops-resolver.ts` has always accepted them
    // directly — this schema's own header already documents that the
    // pre-existing, unguided refund-by-message path "keeps working
    // unchanged." Declaring the channels here (rather than leaving them
    // undeclared, accidentally-broken exceptions — caught live by the full
    // e2e suite: REFUND_CALL's default test helper scripts `orderId` +
    // `refundAmountCentavos` directly, not `orderReference`/`amount`) is
    // what makes that claim still true now that the filter exists.
    // OPS-plane reference/amount-TO-VERIFY, not a customer-plane
    // autoresolve hazard: the resolver looks the named order up
    // authoritatively and REFUSES/falls back if it doesn't resolve, and
    // NEVER clamps an over-balance amount (it passes through so the pack
    // REFUSEs) — the BKL-085 UNTRUSTED-taint confirm overlay + the refund
    // guards still apply afterward regardless of which channel supplied
    // the reference/amount.
    legacyPayloadChannels: [
      {
        field: "orderId",
        reason:
          "Pre-existing refund-by-message explicit-reference path " +
          "(resolveRefundTarget, ops-resolver.ts) — predates and is " +
          "independent of this schema's orderReference field; an " +
          "ops-plane authoritative lookup, not a customer-plane " +
          "autoresolve hazard.",
      },
      {
        field: "refundAmountCentavos",
        reason:
          "BKL-094 (resolveRequestedRefundCentavos, ops-resolver.ts) — " +
          "the TOP-priority alias: a caller that already knows the exact " +
          "integer-centavos figure (e.g. this repo's own e2e test " +
          "helpers, or a future typed caller) may supply it directly, " +
          "skipping the reais->centavos coercion this schema's own " +
          "`amount` field exists to avoid asking the MODEL to do.",
      },
      {
        field: "value",
        reason:
          "BKL-094 OPS_REFUND_REAIS_ALIASES (ops-resolver.ts) — a REAIS " +
          "alias for `amount`, live-observed: a model occasionally " +
          "spontaneously names the figure `value` instead of `amount`.",
      },
      {
        field: "valor",
        reason:
          "BKL-094 OPS_REFUND_REAIS_ALIASES (ops-resolver.ts) — the pt-BR " +
          "REAIS alias for `amount` (\"valor\" = \"value\"), live-observed " +
          "model output.",
      },
    ],
  };

// Fail closed at import time: a schema that would leak paymentId (or any
// other identifier / PII field) can never even be loaded onto the wire.
assertSoundExtractionSchema(PAYMENT_REFUND_ISSUE_EXTRACTION_SCHEMA);
