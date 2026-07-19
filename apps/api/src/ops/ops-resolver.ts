// ops-resolver.ts — the OPS-plane pre-adjudication ResolverPort (NEW-032 slice B).
//
// The claustrum resolve stage (plan → RESOLVE → adjudicate) builds the per-
// envelope `SystemState` the kernel guards read. On the ops plane each governed
// kind needs a DIFFERENT state contract, projected from a REAL first-party read
// BEFORE adjudication so the pack guards evaluate against real entity state:
//
//   - product.availability.set → { ctx: {channel:"staff", customerId:null,
//       staffId, tenantId}, product: <lookup by payload.productId> | null }.
//       pack-ops `requireProductExists` REFUSEs `product_not_found` on null.
//       BKL-089: when the direct id lookup MISSES and `listProductsByName` is
//       wired, the productId string is treated as a NAME and resolved
//       deterministically (ops-product-resolution.ts); a UNIQUE match REWRITES
//       payload.productId to the resolved id (the rebuilt envelope's intentHash
//       then covers the resolved payload) and projects `product` PRESENT.
//   - product.price.set → { ctx (as above), priceProduct: <pricing snapshot by
//       payload.productId> | null } (NEW-004). Reuses the SAME BKL-089 name→id
//       resolution, then a pricing lookup projects name + current uniform BRL
//       price + a divergent-variant flag so the pack guards can REFUSE a
//       missing / per-variation product and the UNTRUSTED CONFIRM prompt can show
//       name + old→new. null ⇒ REFUSE product_not_found.
//   - order.note.add / order.status.transition → the pack-orders `OrderState`
//       (mirrors `adjudicateAdminNote` in routes/admin/_shared-actions.ts),
//       projected from the order projection. A missing order yields a state with
//       `ctx.orderId: null` so pack-orders' `requireOrderIdForMutation` REFUSEs
//       `no_order` (never a thrown turn). BKL-089 (orders scope): when the direct
//       id lookup MISSES and `orderReferenceReads` is wired, the orderId string is
//       treated as a staff REFERENCE — the display number ("4242") or a customer
//       name — and resolved deterministically (ops-order-resolution.ts); a UNIQUE
//       match REWRITES payload.orderId to the resolved id (the rebuilt envelope's
//       intentHash then covers the resolved payload) and projects the order state
//       PRESENT. The strictness bar is higher than products: displayId resolves
//       only on an exactly-one match, and a customer name only against a single
//       ACTIVE (non-terminal) order.
//
// The envelope is REBUILT via `buildEnvelope` with the SAME kind/actor/taint/
// nonce/createdAt (mirrors ibatexas-resolver.ts) and the FINAL payload (the
// BKL-089 name-resolution rewrite when it fired, else the envelope's own payload
// verbatim), so the kernel's intentHash re-derivation passes and the actor/taint
// the planner stamped (`admin:<staffId>` + role, UNTRUSTED) are preserved
// verbatim — the ops authority the composed `staffRoleGuard` gates on is
// unchanged, and NL→id resolution never influences the actor.
//
// Reference→id resolution covers PRODUCTS (name, BKL-089 product scope) and
// ORDERS (display number / customer name, BKL-089 orders scope). Both are
// deterministic, fail-closed, and OPTIONAL (absent dep ⇒ byte-identical
// id-literal behaviour); neither ever influences the actor.
//
// The two lookups are INJECTED (testable with fakes) and FAIL-CLOSED: a lookup
// throw is captured and treated as "not found" (never propagated), so a
// transient read error degrades to a clean REFUSE rather than crashing the turn.

import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import type { ResolvedEnvelope, ResolverPort } from "@claustrum/core";
import {
  isTerminalPaymentStatus,
  normalizeOrderStatusToken,
  type PaymentStatus,
} from "@ibatexas/types";
import { OPS_REFUND_DEFAULT_REASON } from "../claustrum/language-engine/payment-refund-issue.schema.js";
import { logger } from "../lib/logger.js";
import { shiftYmd, todayInRestaurantTz } from "../routes/admin/_date-defaults.js";
import {
  resolveProductByName,
  type ListProductsByName,
} from "./ops-product-resolution.js";
import {
  orderReferenceAppearsInMessage,
  resolveMostRecentActiveOrder,
  resolveOrderByReference,
  type OrderReferenceReads,
} from "./ops-order-resolution.js";
import {
  localDateStr,
  resolveOverrideDate,
} from "./ops-schedule-resolution.js";

/** The business timezone the ops schedule-override date normalization uses —
 *  the SAME `RESTAURANT_TIMEZONE` env the customer-facing schedule reads resolve
 *  their local business day against (Hard Rule #3 — never server-local). Read
 *  per-call (not module-load) so a test can set the env before invoking. */
function restaurantTz(): string {
  return process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
}

/** The product snapshot the pack-ops `requireProductExists` guard reads. */
export interface OpsResolverProduct {
  readonly id: string;
  readonly status: string;
}

/**
 * NEW-004 — the product-pricing snapshot the pack-ops `product.price.set` guards
 * read (`OpsPriceProductSnapshot`). Projected from the admin catalog read: `name`
 * for the CONFIRM prompt, `currentPriceCentavos` (the uniform BRL variant price)
 * for the old→new prompt, and `divergentVariantPrices` so
 * `requireUniformVariantPricing` REFUSEs a multi-variation product. `null` ⇒ the
 * product does not exist OR has no BRL-priced variant ⇒ REFUSE product_not_found.
 */
export interface OpsResolverPriceProduct {
  readonly id: string;
  readonly status: string;
  readonly name: string;
  readonly currentPriceCentavos: number;
  readonly divergentVariantPrices: boolean;
}

/**
 * SCN-114 — the product snapshot the pack-ops `menu.special.set` guards read
 * (`OpsSpecialProductSnapshot`). Projected from the admin product read: `id` /
 * `status` prove existence and `name` is the display title the CONFIRM prompt
 * states. `null` ⇒ the product does not exist ⇒ REFUSE product_not_found. NO
 * price field — a daily special's promo price is independent of the product's
 * own price (an item may be featured WITHOUT a discount).
 */
export interface OpsResolverSpecialProduct {
  readonly id: string;
  readonly status: string;
  readonly name: string;
}

/**
 * BKL-088 — the alert snapshot the pack-ops `requireAlertActionable` guard
 * reads for `ops.alert.resolve.staff`. `status` lets the guard fail closed on a
 * terminal (already-resolved) alert. Projected from the OpsAlert read-model
 * (`opsAlertService.get(id)`); `null` ⇒ the alert id does not exist.
 */
export interface OpsResolverAlert {
  readonly id: string;
  readonly status: string;
}

/**
 * BKL-088 — the incident snapshot the pack-ops `requireIncidentActionable`
 * guard reads for `incident.ticket.close.staff`. Same shape/semantics as
 * {@link OpsResolverAlert} over the ConversationIncident read-model.
 */
export interface OpsResolverIncident {
  readonly id: string;
  readonly status: string;
}

/**
 * The active-payment row the BKL-085 refund path reads. Mirrors the fields the
 * admin refund route reads from `paymentQuerySvc.getActiveByOrderId` — the
 * AUTHORITATIVE balance/status/version the ops resolver STAMPS into the refund
 * payload so the kernel adjudicates against DB truth, never a model-forgeable
 * balance (STOP-GATE B). Production wires it to that same query.
 */
export interface OpsResolverPayment {
  readonly paymentId: string;
  /** Current wire status — only `paid` / `partially_refunded` are refundable. */
  readonly status: string;
  /** Original payment amount (centavos). */
  readonly amountInCentavos: number;
  /** Sum already refunded (centavos). */
  readonly refundedAmountCentavos: number;
  readonly method: string;
  readonly version: number;
}

/** The order projection subset the pack-orders `OrderState` is built from. */
export interface OpsResolverOrder {
  readonly customerId: string | null;
  readonly paymentMethod: string | null;
  readonly paymentStatus: string | null;
  readonly totalInCentavos: number;
  /**
   * Current fulfillment status — the CURRENT state the BKL-090
   * `requireLegalStatusTransition` guard reads for `order.status.transition`.
   * `null` when the projection carries none (defensive; the guard fails closed
   * on the `admin:` ops plane rather than trust an absent status).
   */
  readonly fulfillmentStatus: string | null;
}

export interface OpsResolverDeps {
  /** Authenticated staff id (from the JWT) — stamped into the ops ctx. */
  readonly staffId: string;
  /** Tenant this ops turn operates on (env-driven, single-tenant today). */
  readonly tenantId: string;
  /**
   * Fetch a product by id for the availability guard. MUST reuse the same admin
   * product read the products route relies on (medusaAdmin). Returns null when
   * absent; a THROW is treated as null (fail-closed → REFUSE product_not_found).
   */
  readonly lookupProduct: (
    productId: string,
  ) => Promise<OpsResolverProduct | null>;
  /**
   * NEW-004 — fetch a product's PRICING snapshot by id for the `product.price.set`
   * guards. Reads the admin catalog (variant BRL prices) and projects
   * `{id,status,name,currentPriceCentavos,divergentVariantPrices}`. Returns null
   * when absent OR the product has no BRL-priced variant; a THROW is treated as
   * null (fail-closed → REFUSE product_not_found). When ABSENT the price verb
   * REFUSEs every request (priceProduct null) — inert until wired.
   */
  readonly lookupProductPricing?: (
    productId: string,
  ) => Promise<OpsResolverPriceProduct | null>;
  /**
   * SCN-114 — fetch a product's `{id,status,name}` snapshot by id for the
   * `menu.special.set` guards. Reads the admin catalog; returns null when absent
   * (a THROW is treated as null, fail-closed → REFUSE product_not_found). When
   * ABSENT the special verb REFUSEs every request (special product null) — inert
   * until wired. Reuses the SAME name→id resolution (`listProductsByName`) as
   * availability/price when the direct id lookup misses.
   */
  readonly lookupSpecialProduct?: (
    productId: string,
  ) => Promise<OpsResolverSpecialProduct | null>;
  /**
   * Fetch an order projection by id for the note state. Returns null when absent;
   * a THROW is treated as null (fail-closed → REFUSE no_order).
   */
  readonly lookupOrder: (orderId: string) => Promise<OpsResolverOrder | null>;
  /**
   * OPTIONAL deterministic product NAME→id resolution (BKL-089, product scope).
   * When the direct `lookupProduct(payload.productId)` MISSES (the model put a
   * NAME into `productId`, not an id — the persona's guidance when it has no id),
   * the resolver searches the first-party admin catalog by that name and, on a
   * UNIQUE deterministic match, REWRITES `payload.productId` to the resolved id
   * and rebuilds the envelope — so the kernel adjudicates the RESOLVED payload
   * against the PRESENT product state (the intentHash covers the final payload,
   * the chat-plane BKL-028/061 posture). A none/ambiguous outcome leaves the
   * payload untouched ⇒ product stays null ⇒ honest kernel REFUSE. When this dep
   * is ABSENT the resolver is byte-identical to the id-literal v1 (no NL→id).
   */
  readonly listProductsByName?: ListProductsByName;
  /**
   * OPTIONAL deterministic order REFERENCE→id resolution (BKL-089, orders scope).
   * When the direct `lookupOrder(payload.orderId)` MISSES (the model put a staff
   * REFERENCE into `orderId` — the display number "4242" or a customer name, per
   * the persona), the resolver treats that string as a reference and, on a UNIQUE
   * deterministic match, REWRITES `payload.orderId` to the resolved order id and
   * rebuilds the envelope — so the kernel adjudicates the RESOLVED payload against
   * the PRESENT order state (the intentHash covers the final payload, the same
   * BKL-028/061 posture as the product path). A none/ambiguous outcome leaves the
   * payload untouched ⇒ `ctx.orderId` stays null ⇒ honest kernel REFUSE `no_order`.
   * When this dep is ABSENT the order paths are byte-identical to the id-literal
   * v1 (no reference resolution). Higher strictness bar than products — a
   * wrong-order write is harmful — see ops-order-resolution.ts.
   */
  readonly orderReferenceReads?: OrderReferenceReads;
  /**
   * BKL-085 — fetch the ACTIVE payment for an order id (the SAME deterministic
   * read the admin refund route uses: `paymentQuerySvc.getActiveByOrderId`).
   * Returns null when the order has no active (non-terminal) payment; a THROW is
   * treated as null (fail-closed → REFUSE). The resolver reads
   * amountInCentavos/refundedAmountCentavos/status/method/version from THIS row
   * (never the model payload) and stamps the forgeable balance fields from it.
   * When this dep is ABSENT the refund path REFUSEs every request (exists:false)
   * — the refund verb is inert until wired.
   */
  readonly lookupActivePayment?: (
    orderId: string,
  ) => Promise<OpsResolverPayment | null>;
  /**
   * BKL-088 — fetch an ops-alert by id for `ops.alert.resolve.staff`. Returns
   * null when absent; a THROW is treated as null (fail-closed → REFUSE
   * not_actionable). The resolver projects `{id,status}` so the pack guard fails
   * closed on an absent / terminal alert. When this dep is ABSENT the alert
   * verb REFUSEs every request (alert null) — inert until wired. NO NL→id
   * resolution: alerts are referred by the id the ops_snapshot lists (id-literal
   * v1, per BKL-088 deliverable 4).
   */
  readonly lookupAlert?: (alertId: string) => Promise<OpsResolverAlert | null>;
  /**
   * BKL-088 — fetch a conversation-incident by id for
   * `incident.ticket.close.staff`. Same fail-closed / id-literal contract as
   * {@link lookupAlert}.
   */
  readonly lookupIncident?: (
    incidentId: string,
  ) => Promise<OpsResolverIncident | null>;
  /**
   * SCN-127 — the clock the `schedule.override.set` branch reads for NL-date
   * normalization ("amanhã" → concrete ISO in RESTAURANT_TIMEZONE) AND the
   * today-or-future reference it projects into `state.schedule.today`. Injected
   * so date resolution is frozen-clock testable; defaults to `() => new Date()`.
   */
  readonly now?: () => Date;
}

/**
 * The payment statuses money can legitimately be refunded from (mirrors the
 * admin route's `refundableStatuses` gate + pack-payments'
 * `REFUNDABLE_PAYMENT_STATUSES`). Every other active status (awaiting_payment /
 * cash_pending / switching_method / …) is NOT refundable — the resolver
 * fails closed (exists:false ⇒ kernel REFUSE) rather than surface it and risk an
 * executor `canTransition` throw on the resumed EXECUTE.
 */
const OPS_REFUNDABLE_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "partially_refunded",
]);

/** Cap a model-supplied refund reason (defensive; mirrors the admin route's
 *  500-char zod bound). Recorded on the status-history row, never executed. */
const OPS_REFUND_REASON_MAX = 500;

/**
 * BKL-094 — the ops-plane refund-amount aliases the models actually emit. The
 * planner persona asks for `refundAmountCentavos` (integer centavos), but live
 * proof shows both the 4B and Sonnet put the spoken figure under
 * `amount`/`value`/`valor` in REAIS ("reembolsa 10 reais" → `{amount: 10}`). We
 * accept those as a fallback, converting REAIS → integer centavos EXACTLY. Order
 * is priority: the first alias that parses to a clean money value wins.
 */
const OPS_REFUND_REAIS_ALIASES = ["amount", "value", "valor"] as const;

/**
 * Parse a REAIS refund amount (from an alias field) into EXACT integer centavos,
 * or `null` when it is not a clean positive money value. Money-safe by
 * construction:
 *   - accepts a number (10, 10.5, 10.55) or a string ("10", "10.50", pt-BR
 *     "10,50", "R$ 10,50") — models emit numbers, strings are defensive;
 *   - converts via integer arithmetic on the decimal STRING (whole×100 + frac),
 *     NEVER `reais * 100` (IEEE-754: `10.55 * 100 === 1054.9999999999998`);
 *   - rejects >2 fractional digits, NaN/Infinity, ≤0, signs, exponents, thousands
 *     groupings, and any non-numeric text → `null`, so the caller keeps the
 *     confirm-gated full-balance default rather than a silently wrong number.
 * NEVER clamps to the balance: an over-balance amount passes through so the pack's
 * over-balance guard REFUSEs honestly (never silently reduce what staff asked).
 */
function parseRefundReaisToCentavos(raw: unknown): number | null {
  let text: string;
  if (typeof raw === "number") {
    // A finite decimal stringifies canonically ("10.55"); NaN/Infinity stringify
    // to non-numeric text ("NaN"/"Infinity") that the regex below rejects anyway.
    text = String(raw);
  } else if (typeof raw === "string") {
    text = raw.trim();
  } else {
    return null;
  }
  // Drop internal spaces + a leading currency marker the model may add.
  text = text.replace(/\s+/g, "").replace(/^r\$/i, "");
  // pt-BR decimal comma → dot, ONLY when there is no dot already (an ambiguous
  // "1.000,50" thousands grouping keeps both separators and the regex rejects it).
  if (text.includes(",") && !text.includes(".")) {
    text = text.replace(",", ".");
  }
  // A single positive decimal with AT MOST two fractional digits.
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return null;
  const centavos =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(centavos) && centavos > 0 ? centavos : null;
}

/**
 * BKL-094 — derive the REQUESTED refund amount (integer centavos) from the model
 * payload, priority: schema-correct `refundAmountCentavos` (integer centavos) →
 * the REAIS aliases `amount`/`value`/`valor` (×100, exact) → the confirm-gated
 * FULL refundable balance when nothing usable is present (a bare "reembolsa o
 * pedido X" is a full refund). The result is the amount the staff CONFIRMS; it is
 * NEVER clamped — an over-balance figure passes through so the pack REFUSEs.
 */
function resolveRequestedRefundCentavos(
  payload: Record<string, unknown>,
  fullRefundableBalance: number,
): number {
  const rawCentavos = payload.refundAmountCentavos;
  if (
    typeof rawCentavos === "number" &&
    Number.isInteger(rawCentavos) &&
    rawCentavos > 0
  ) {
    return rawCentavos;
  }
  for (const key of OPS_REFUND_REAIS_ALIASES) {
    const centavos = parseRefundReaisToCentavos(payload[key]);
    if (centavos !== null) return centavos;
  }
  return fullRefundableBalance;
}

/**
 * FE-T10 — the money-tier extraction schema for `payment.refund.issue`
 * (`payment-refund-issue.schema.ts`) narrows the model-facing payload to
 * `{orderReference, amount, reason}`; `orderReference` is DELIBERATELY not
 * named `orderId` on that schema (FORBIDDEN_EXTRACTION_FIELD_NAMES — an
 * unresolved NL reference is Directive class, not the resolved identifier the
 * forbidden-name lint guards against). `resolveOrderTarget` below still only
 * reads `payload.orderId`, so ADD `orderReference` as an ADDITIVE alias
 * (BKL-094's exact shape: prefer the schema-correct name, fall back to the
 * alias) before calling it — this is the ONLY change refund resolution needs:
 * the pre-existing (unguided, `inputSchema: {}`) refund path, where a model
 * has always been free to put a reference under `orderId` with no schema
 * guiding it, keeps working byte-identically (an `orderId` payload key still
 * wins outright); the NEW typed-schema path, where the model can ONLY emit
 * `orderReference` (the narrowed schema forbids `orderId`), now also resolves.
 * Pure projection — never mutates the caller's `payload`.
 */
function withOrderReferenceAlias(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof payload.orderId === "string" && payload.orderId !== "") {
    return payload;
  }
  const reference = payload.orderReference;
  if (typeof reference !== "string" || reference === "") return payload;
  return { ...payload, orderId: reference };
}

/**
 * The pack-payments `PaymentState` the refund guards adjudicate against, built
 * from a live payment row. SHARED by the plan-stage resolver (below) and the
 * BKL-085 resume re-projection ({@link buildOpsRefundResumeState}) so a parked
 * refund is re-adjudicated on "sim" against the SAME state shape it parked with.
 * `isTerminal` is DERIVED from the (fresh) status — a payment that reached a
 * terminal status since parking (e.g. already fully refunded) then REFUSEs via
 * `refuseTerminalTransition` on resume (money-safety).
 */
function buildRefundPaymentState(opts: {
  status: string;
  amountInCentavos: number;
  refundedAmountCentavos: number;
  method: string;
  version: number;
  orderId: string | null;
  tenantId: string;
}): unknown {
  return {
    ctx: {
      actor: { principal: "admin" },
      tenantId: opts.tenantId,
      exists: true,
      currentStatus: opts.status,
      currentMethod: opts.method,
      version: opts.version,
      orderId: opts.orderId,
      isTerminal: isTerminalPaymentStatus(opts.status as PaymentStatus),
      refundedAmountCentavos: opts.refundedAmountCentavos,
      amountInCentavos: opts.amountInCentavos,
    },
  };
}

/**
 * BKL-085 — re-project the pack-payments `PaymentState` for a parked refund on
 * the RESUME path ("sim, confirma"). The claustrum resume path re-adjudicates the
 * VERBATIM parked envelope, but the SHARED customer-plane resume-state enrichment
 * (`resolveAndAssemble`) is scoped to a real `customerId` — the ops plane's
 * `staff:<id>` owns no customer resources, so it would project `exists:false` and
 * REFUSE a legitimate confirm-resume. This builder re-projects from the payment
 * row read by the parked (DB-stamped, trusted) `paymentId` instead. A FRESH read
 * ⇒ money-safe: a since-parked terminal / partial refund REFUSEs (terminal guard /
 * the magnitude guard's divergence check reads THIS live `refundedAmountCentavos`).
 * `payment === null` ⇒ `exists:false` ⇒ clean `payment_not_found` REFUSE.
 *
 * FIX 2 (AUT-017 review) — RE-APPLY `OPS_REFUNDABLE_STATUSES` on resume, exactly
 * like the plan-stage resolver (`resolveOpsRefund` ~:689). A resume projects the
 * LIVE status; if the payment left a refundable state since parking (e.g. a charge
 * that went `disputed` via the Stripe webhook — non-terminal + `canTransition
 * ("disputed","refunded") === true`, so the terminal guard alone would NOT catch
 * it), returning `exists:true` here would leave the refundability gate inert and
 * EXECUTE a refund on a chargeback (double-payment). We fail closed to
 * `exists:false` (⇒ kernel REFUSE ⇒ `denied_by_kernel`) for any non-refundable
 * status — the resume can only refund a payment that is refundable RIGHT NOW.
 */
export function buildOpsRefundResumeState(
  payment: {
    status: string;
    amountInCentavos: number;
    refundedAmountCentavos: number;
    method: string;
    version: number;
    orderId?: string | null;
  } | null,
  tenantId: string,
): unknown {
  if (payment === null || !OPS_REFUNDABLE_STATUSES.has(payment.status)) {
    return { ctx: { exists: false } };
  }
  return buildRefundPaymentState({
    status: payment.status,
    amountInCentavos: payment.amountInCentavos,
    refundedAmountCentavos: payment.refundedAmountCentavos,
    method: payment.method,
    version: payment.version,
    orderId: payment.orderId ?? null,
    tenantId,
  });
}

/**
 * The per-envelope resolution: the projected kernel `state` (undefined ⇒ no
 * per-envelope state) plus an OPTIONAL rewritten `payload`. The payload is set
 * ONLY when the availability name-resolution rewrote `productId` (BKL-089);
 * every other kind leaves it unset so the rebuild uses `envelope.payload`
 * verbatim (byte-identical hash).
 */
interface OpsEnvelopeResolution {
  readonly state?: unknown;
  readonly payload?: Record<string, unknown>;
}

/** Fail-closed lookup: a throw degrades to null (logged), never propagated. */
async function safeLookup<T>(
  run: () => Promise<T | null>,
  what: string,
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    logger.warn(
      { component: "ops-resolver", lookup: what, err: (err as Error).message },
      "ops resolver lookup failed — treating as not-found (fail-closed REFUSE)",
    );
    return null;
  }
}

/**
 * Resolve the availability target: direct id lookup first; on a MISS, the
 * BKL-089 deterministic name→id resolution (when wired). Returns the resolved
 * product snapshot (null ⇒ REFUSE product_not_found) and, when a name resolved,
 * the rewritten payload (productId ← resolved id; NOTHING else changes).
 */
async function resolveAvailabilityTarget(
  deps: OpsResolverDeps,
  payload: Record<string, unknown>,
): Promise<{ product: OpsResolverProduct | null; payload?: Record<string, unknown> }> {
  const productId =
    typeof payload.productId === "string" ? payload.productId : "";
  const direct =
    productId === ""
      ? null
      : await safeLookup(() => deps.lookupProduct(productId), "product");
  if (direct !== null || productId === "" || deps.listProductsByName === undefined) {
    return { product: direct };
  }

  // Direct id lookup MISSED and a name-resolver is wired: treat the productId
  // string as a NAME candidate (the persona fills productId with the product
  // name when it has no id). A UNIQUE deterministic match rewrites the payload's
  // productId to the resolved id; none/ambiguous leaves the payload untouched
  // (→ product stays null → honest REFUSE product_not_found).
  const resolution = await resolveProductByName(productId, deps.listProductsByName);
  if (resolution.kind === "resolved") {
    logger.info(
      {
        component: "ops-resolver",
        event: "product.availability.name_resolved",
        from: productId,
        to: resolution.product.id,
      },
      "ops product name resolved to id (payload productId rewritten before adjudication)",
    );
    // BKL-156 — stamp the resolved display name (a by-product of name→id
    // resolution) so the deterministic EXECUTE render can name the product
    // truthfully. Only on the name-resolved path — a direct-id hit's
    // `lookupProduct` projection carries no name (that wiring lives in the
    // FENCED bootstrap), so it degrades to the generic render, never fabricated.
    const productName = resolution.product.title.trim();
    return {
      product: { id: resolution.product.id, status: resolution.product.status },
      payload: {
        ...payload,
        productId: resolution.product.id,
        ...(productName !== "" ? { productName } : {}),
      },
    };
  }
  logger.info(
    {
      component: "ops-resolver",
      event: "product.availability.name_unresolved",
      from: productId,
      outcome: resolution.kind,
      ...(resolution.kind === "ambiguous"
        ? { candidateCount: resolution.candidates.length }
        : {}),
    },
    "ops product name did not resolve to a unique id (kernel will REFUSE product_not_found)",
  );
  return { product: null };
}

/**
 * NEW-004 — resolve the price target: direct id pricing-lookup first; on a MISS,
 * the BKL-089 deterministic name→id resolution (when wired), then a pricing
 * lookup by the resolved id. Returns the projected pricing snapshot (null ⇒
 * REFUSE product_not_found) and, when a name resolved to a PRICEABLE product,
 * the rewritten payload (productId ← resolved id; NOTHING else changes). The
 * payload is rewritten ONLY when the resolved product is priceable (pricing
 * present) — a name that resolves to a BRL-priceless product leaves the payload
 * untouched (→ priceProduct null → honest REFUSE), same posture as availability.
 */
async function resolvePriceTarget(
  deps: OpsResolverDeps,
  payload: Record<string, unknown>,
): Promise<{
  priceProduct: OpsResolverPriceProduct | null;
  payload?: Record<string, unknown>;
}> {
  if (deps.lookupProductPricing === undefined) {
    return { priceProduct: null };
  }
  const lookupPricing = deps.lookupProductPricing;
  const productId =
    typeof payload.productId === "string" ? payload.productId : "";
  const direct =
    productId === ""
      ? null
      : await safeLookup(() => lookupPricing(productId), "product-pricing");
  if (direct !== null || productId === "" || deps.listProductsByName === undefined) {
    return { priceProduct: direct };
  }

  // Direct id lookup MISSED and a name-resolver is wired: treat productId as a
  // NAME candidate (BKL-089, reusing the SAME catalog list read the availability
  // path uses). A UNIQUE match → pricing lookup by the resolved id; a priceable
  // result rewrites payload.productId to the resolved id. none/ambiguous, or a
  // resolved-but-BRL-priceless product, leaves the payload untouched → null →
  // honest REFUSE product_not_found.
  const resolution = await resolveProductByName(productId, deps.listProductsByName);
  if (resolution.kind === "resolved") {
    const pricing = await safeLookup(
      () => lookupPricing(resolution.product.id),
      "product-pricing",
    );
    if (pricing !== null) {
      logger.info(
        {
          component: "ops-resolver",
          event: "product.price.name_resolved",
          from: productId,
          to: resolution.product.id,
        },
        "ops product name resolved to id (price payload productId rewritten before adjudication)",
      );
      return {
        priceProduct: pricing,
        payload: { ...payload, productId: resolution.product.id },
      };
    }
  }
  logger.info(
    {
      component: "ops-resolver",
      event: "product.price.name_unresolved",
      from: productId,
      outcome: resolution.kind,
      ...(resolution.kind === "ambiguous"
        ? { candidateCount: resolution.candidates.length }
        : {}),
    },
    "ops product name did not resolve to a priceable product (kernel will REFUSE product_not_found)",
  );
  return { priceProduct: null };
}

/**
 * SCN-114 — the reais aliases the models emit for a daily-special PROMO price.
 * The persona asks for `promoPriceCentavos` (integer centavos), but — like the
 * BKL-094 refund path — live models also put the spoken figure under
 * `promoPrice`/`price`/`preco`/`valor`/`amount` in REAIS. Priority order; the
 * first that parses to a clean money value wins.
 */
const OPS_SPECIAL_PRICE_REAIS_ALIASES = [
  "promoPrice",
  "price",
  "preco",
  "valor",
  "amount",
] as const;

/**
 * Derive the promo price (integer centavos) from a `menu.special.set` payload, or
 * `undefined` when the owner gave no usable price (⇒ the special is featured
 * WITHOUT a discount). Priority: schema-correct `promoPriceCentavos` (positive
 * integer centavos) → the REAIS aliases (×100, EXACT via the shared
 * {@link parseRefundReaisToCentavos} integer-string arithmetic, NEVER `reais *
 * 100`). NEVER a float; an unparseable value degrades to `undefined` (no discount)
 * — the UNTRUSTED confirm prompt shows the parsed price (or "sem desconto"), so a
 * misparse is caught by the operator before it writes.
 */
function resolveSpecialPromoCentavos(
  payload: Record<string, unknown>,
): number | undefined {
  const raw = payload.promoPriceCentavos;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  for (const key of OPS_SPECIAL_PRICE_REAIS_ALIASES) {
    const centavos = parseRefundReaisToCentavos(payload[key]);
    if (centavos !== null) return centavos;
  }
  return undefined;
}

/**
 * Resolve a spoken business-day reference into a concrete `YYYY-MM-DD` in
 * RESTAURANT_TIMEZONE, relative to `todayYmd`. Accepts the relative tokens the
 * persona emits ("hoje"/"amanhã"/"depois de amanhã", accent-insensitive) and
 * passes an already-concrete `YYYY-MM-DD` through verbatim. Anything else is
 * returned UNCHANGED (the pack's `validateMenuSpecialPayload` then REFUSEs it as a
 * non-YYYY-MM-DD date — fail-closed, never a silent guess).
 */
function resolveSpecialDateYmd(raw: string, todayYmd: string): string {
  const norm = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, ""); // strip accents: "amanhã" → "amanha"
  if (norm === "hoje" || norm === "hj") return todayYmd;
  if (norm === "amanha") return shiftYmd(todayYmd, 1);
  if (norm === "depois de amanha") return shiftYmd(todayYmd, 2);
  return raw.trim();
}

/**
 * Resolve the `menu.special.set` target: direct id lookup first; on a MISS, the
 * BKL-089 deterministic name→id resolution (when `listProductsByName` is wired),
 * reusing the SAME catalog list read availability/price use. Returns the projected
 * `{id,status,name}` snapshot (null ⇒ REFUSE product_not_found). The caller
 * rewrites `payload.productId` to `product.id` when a product resolved (a name →
 * its id; a direct id hit is a no-op rewrite), else leaves the raw string (→ null
 * → honest REFUSE).
 */
async function resolveSpecialTarget(
  deps: OpsResolverDeps,
  productIdRaw: string,
): Promise<{ product: OpsResolverSpecialProduct | null }> {
  if (deps.lookupSpecialProduct === undefined) return { product: null };
  const lookup = deps.lookupSpecialProduct;
  const direct =
    productIdRaw === ""
      ? null
      : await safeLookup(() => lookup(productIdRaw), "special-product");
  if (direct !== null) return { product: direct };
  if (productIdRaw === "" || deps.listProductsByName === undefined) {
    return { product: null };
  }
  const resolution = await resolveProductByName(
    productIdRaw,
    deps.listProductsByName,
  );
  if (resolution.kind === "resolved") {
    const snap = await safeLookup(
      () => lookup(resolution.product.id),
      "special-product",
    );
    if (snap !== null) {
      logger.info(
        {
          component: "ops-resolver",
          event: "menu.special.name_resolved",
          from: productIdRaw,
          to: resolution.product.id,
        },
        "ops special product name resolved to id (payload productId rewritten before adjudication)",
      );
      return { product: snap };
    }
  }
  logger.info(
    {
      component: "ops-resolver",
      event: "menu.special.name_unresolved",
      from: productIdRaw,
      outcome: resolution.kind,
      ...(resolution.kind === "ambiguous"
        ? { candidateCount: resolution.candidates.length }
        : {}),
    },
    "ops special product name did not resolve to a unique id (kernel will REFUSE product_not_found)",
  );
  return { product: null };
}

/**
 * Resolve the order target shared by `order.note.add` / `order.status.transition`
 * (the resolution branch is IDENTICAL for both — only the per-kind ctx projection
 * differs). Direct id lookup first; on a MISS, the BKL-089 deterministic
 * REFERENCE→id resolution (when wired). Returns the projected order state (null ⇒
 * REFUSE no_order), the EFFECTIVE order id for the ctx (the resolved id when a
 * reference resolved, the original id on a direct hit, null on a miss), and — when
 * a reference resolved — the rewritten payload (orderId ← resolved id; NOTHING
 * else changes; actor/taint/nonce untouched by the caller's rebuild).
 */
async function resolveOrderTarget(
  deps: OpsResolverDeps,
  envelope: IntentEnvelope,
  payload: Record<string, unknown>,
): Promise<{
  order: OpsResolverOrder | null;
  orderId: string | null;
  payload?: Record<string, unknown>;
}> {
  const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
  const direct =
    orderId === ""
      ? null
      : await safeLookup(() => deps.lookupOrder(orderId), "order");
  if (direct !== null) return { order: direct, orderId };
  if (orderId === "" || deps.orderReferenceReads === undefined) {
    return { order: null, orderId: null };
  }

  // Direct id lookup MISSED and reference reads are wired: treat the orderId
  // string as a staff REFERENCE (display number or customer name). A UNIQUE
  // deterministic match rewrites payload.orderId to the resolved id; none/
  // ambiguous leaves the payload untouched (→ ctx.orderId null → honest REFUSE).
  const resolution = await resolveOrderByReference(orderId, deps.orderReferenceReads);
  if (resolution.kind === "resolved") {
    logger.info(
      {
        component: "ops-resolver",
        event: "order.ref_resolved",
        kind: envelope.kind,
        via: resolution.via,
        from: orderId,
        to: resolution.order.id,
      },
      "ops order reference resolved to id (payload orderId rewritten before adjudication)",
    );
    const o = resolution.order;
    return {
      order: {
        customerId: o.customerId,
        paymentMethod: o.paymentMethod,
        paymentStatus: o.paymentStatus,
        totalInCentavos: o.totalInCentavos,
        fulfillmentStatus: o.fulfillmentStatus,
      },
      orderId: o.id,
      payload: { ...payload, orderId: o.id },
    };
  }
  logger.info(
    {
      component: "ops-resolver",
      event: "order.ref_unresolved",
      kind: envelope.kind,
      ...(resolution.via ? { via: resolution.via } : {}),
      from: orderId,
      outcome: resolution.kind,
      ...(resolution.kind === "ambiguous"
        ? { candidateCount: resolution.candidates.length }
        : {}),
    },
    "ops order reference did not resolve to a unique id (kernel will REFUSE no_order)",
  );
  return { order: null, orderId: null };
}

/**
 * FE-T05 — resolve the `order.status.transition` target. Under the FE-1.1
 * extraction schema for this capability the model is NEVER shown an
 * `orderId`/order-reference field (see
 * `language-engine/order-status-transition.schema.ts`), so `payload.orderId`
 * is always empty on this path today; the resolution below is written to
 * degrade gracefully if a future rollout slice re-adds an explicit reference
 * field to this schema.
 *
 *   1. Try the SAME explicit-reference resolution `order.note.add` uses
 *      (`resolveOrderTarget` — direct id, then BKL-089 displayId/name). A hit
 *      here is an EXPLICIT reference the staff gave ⇒ `authoritative`.
 *   2. On a miss (including the empty-orderId case, which is this tracer's
 *      only live path), fall back to the DETERMINISTIC "most recent active
 *      order" resolution (`resolveMostRecentActiveOrder`) — a GUESS ⇒
 *      `grounded`. The resolved id is REWRITTEN onto the payload (mirrors the
 *      BKL-089 rewrite idiom) so the envelope's `intentHash` covers it and a
 *      confirm-resume re-adjudicates the SAME order rather than re-guessing.
 *   3. No candidate either way ⇒ `orderId: null` (honest `no_order` REFUSE —
 *      never silently guessed).
 */
async function resolveStatusTransitionOrderTarget(
  deps: OpsResolverDeps,
  envelope: IntentEnvelope,
  payload: Record<string, unknown>,
  requestText: string,
): Promise<{
  order: OpsResolverOrder | null;
  orderId: string | null;
  /** Absent when no order resolved (nothing to gate the confirm guard on). */
  orderResolutionTrust?: "authoritative" | "grounded";
  /**
   * FE-T05 review (MAJOR-2) — the resolved order's DISPLAY number, present
   * ONLY on the `"grounded"` (auto-resolved) path. Threaded into the
   * `OrderState` ctx so `requireConfirmationOnGroundedStatusTransition`
   * (pack-orders) can NAME the order in its confirmation prompt — a staff
   * member confirming a GUESSED target must be able to recognize (and
   * reject) a wrong one; a bare "vou usar o pedido mais recente" names
   * nothing an operator could catch. Absent on the `"authoritative"` path:
   * the staff already gave an explicit reference, so no re-identification
   * is needed there (and that path never confirms).
   */
  displayId?: number;
  /**
   * BKL-190 — present ONLY on the `"grounded"` path: did the CURRENT staff
   * message actually contain the resolved order's display number (the
   * `orderReferenceAppearsInMessage` check the BKL-150a scrub uses)? The model
   * cannot pass a reference through for this capability (the FE-1.1 schema has
   * no field), so a staff message that DID name the order still lands here —
   * the confirm prompt must not then claim "não me disseram qual pedido".
   */
  orderNamedInMessage?: boolean;
  payload?: Record<string, unknown>;
}> {
  const direct = await resolveOrderTarget(deps, envelope, payload);
  if (direct.orderId !== null) {
    return { ...direct, orderResolutionTrust: "authoritative" };
  }
  if (deps.orderReferenceReads === undefined) {
    return { order: null, orderId: null };
  }
  const guess = await resolveMostRecentActiveOrder(deps.orderReferenceReads);
  if (guess.kind !== "resolved") {
    return { order: null, orderId: null };
  }
  logger.info(
    {
      component: "ops-resolver",
      event: "order.status_transition.most_recent_resolved",
      kind: envelope.kind,
      to: guess.order.id,
      displayId: guess.order.displayId,
    },
    "ops order.status.transition: no explicit reference — auto-resolved the most recent active order (grounded; forces confirmation)",
  );
  const o = guess.order;
  return {
    order: {
      customerId: o.customerId,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      totalInCentavos: o.totalInCentavos,
      fulfillmentStatus: o.fulfillmentStatus,
    },
    orderId: o.id,
    orderResolutionTrust: "grounded",
    displayId: o.displayId,
    orderNamedInMessage: orderReferenceAppearsInMessage(
      String(o.displayId),
      requestText,
    ),
    payload: { ...payload, orderId: o.id },
  };
}

/**
 * BKL-085 — resolve a refunds-by-message envelope into (a) the pack-payments
 * `PaymentState` the refund guards adjudicate against and (b) a fully-STAMPED
 * `PaymentRefundIssuePayload`. The model controls ONLY the order reference, the
 * amount, and the reason; EVERYTHING security-critical (paymentId, the three
 * balance fields, actor, actorId) is STAMPED from the DB payment row + the
 * authenticated Capsule staffId (STOP-GATE B — the model-forgeable
 * refundableBalanceCentavos / currentRefundedCentavos / amountInCentavos are
 * OVERWRITTEN from live DB truth so the kernel decides on the real balance).
 *
 * Fail-closed to `exists:false` (⇒ pack `requirePaymentExists` REFUSEs
 * `payment_not_found`, a clean kernel REFUSE, never an executor throw) when: the
 * order reference does not resolve; the order has no active payment; the active
 * payment is not in a refundable state; or the lookup dep is absent.
 *
 * The refund payload uses the model's `orderId` as the order REFERENCE (display
 * number / customer name / id — the same field the other order verbs use); the
 * resolver resolves it, locates the order's active refundable payment, and stamps
 * the canonical payload. The requested amount threads via
 * {@link resolveRequestedRefundCentavos} (BKL-094): `refundAmountCentavos`
 * (centavos) OR the REAIS aliases the models actually emit (`amount`/`value`/
 * `valor` ×100, exact); it defaults to the FULL refundable balance when the model
 * gives nothing usable (a bare "reembolsa o pedido X" is a full refund) — the
 * UNTRUSTED taint overlay parks it for confirmation regardless, so the staff still
 * confirms the exact number.
 */
async function resolveRefundTarget(
  deps: OpsResolverDeps,
  envelope: IntentEnvelope,
  payload: Record<string, unknown>,
): Promise<OpsEnvelopeResolution> {
  // A payment-not-found state ⇒ pack requirePaymentExists REFUSEs cleanly.
  const refuseNotFound: OpsEnvelopeResolution = {
    state: { ctx: { exists: false } },
  };

  if (deps.lookupActivePayment === undefined) {
    logger.info(
      { component: "ops-resolver", event: "refund.lookup_unwired", kind: envelope.kind },
      "ops refund lookup dep absent — refund REFUSEs (verb inert until wired)",
    );
    return refuseNotFound;
  }

  // Resolve the order REFERENCE → real order id (reuses the BKL-089 order
  // resolution: direct id, then displayId / customer-name). We need only the
  // id. FE-T10: `orderReference` (the money-tier extraction schema's field
  // name) is accepted as an alias for `orderId` first (withOrderReferenceAlias).
  const { orderId } = await resolveOrderTarget(
    deps,
    envelope,
    withOrderReferenceAlias(payload),
  );
  if (orderId === null) {
    logger.info(
      { component: "ops-resolver", event: "refund.order_unresolved" },
      "ops refund: order reference did not resolve — REFUSE payment_not_found",
    );
    return refuseNotFound;
  }

  const payment = await safeLookup(
    () => deps.lookupActivePayment!(orderId),
    "active-payment",
  );
  if (payment === null || !OPS_REFUNDABLE_STATUSES.has(payment.status)) {
    logger.info(
      {
        component: "ops-resolver",
        event: "refund.not_refundable",
        orderId,
        status: payment?.status ?? null,
      },
      "ops refund: no active refundable payment — REFUSE payment_not_found",
    );
    return refuseNotFound;
  }

  // STOP-GATE B — STAMP the forgeable balance fields from the DB row. The model
  // controls only the amount + reason. BKL-094: the requested amount threads from
  // `refundAmountCentavos` (centavos) OR the REAIS aliases the models actually
  // emit (amount/value/valor ×100, exact); an unusable value keeps the confirm-
  // gated full-balance default; an over-balance figure is NOT clamped (the pack's
  // over-balance guard REFUSEs it honestly on the true DB balance below).
  const refundableBalance =
    payment.amountInCentavos - payment.refundedAmountCentavos;
  const modelAmount = resolveRequestedRefundCentavos(payload, refundableBalance);
  const rawReason = payload.reason;
  const reason =
    typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.slice(0, OPS_REFUND_REASON_MAX)
      : OPS_REFUND_DEFAULT_REASON;

  const stampedPayload: Record<string, unknown> = {
    // Model controls: the amount (numbers the staff confirms) + reason.
    refundAmountCentavos: modelAmount,
    reason,
    // STAMPED from DB / Capsule — never the model:
    paymentId: payment.paymentId,
    refundableBalanceCentavos: refundableBalance,
    amountInCentavos: payment.amountInCentavos,
    currentRefundedCentavos: payment.refundedAmountCentavos,
    actor: "admin",
    actorId: deps.staffId,
  };

  return {
    state: buildRefundPaymentState({
      status: payment.status,
      amountInCentavos: payment.amountInCentavos,
      refundedAmountCentavos: payment.refundedAmountCentavos,
      method: payment.method,
      version: payment.version,
      orderId,
      tenantId: deps.tenantId,
    }),
    payload: stampedPayload,
  };
}

/**
 * NEW-004 — build the `product.price.set` ops SystemState for the RESUME path
 * ("sim, confirma"). Like the refund resume ({@link buildOpsRefundResumeState}),
 * the ops confirm-resume re-adjudicates the VERBATIM parked envelope, but the
 * customer-plane resume enrichment (`resolveAndAssemble`) is scoped to a real
 * customerId — the ops plane's `staff:<id>` owns no products, so it would project
 * `priceProduct:undefined` and REFUSE a valid "sim". This builder re-projects the
 * SAME `{ ctx, priceProduct }` shape the plan-stage resolver builds, from a FRESH
 * pricing read of the parked (resolver-rewritten, trusted) productId — money-safe:
 * a since-parked change to divergent variants / a vanished product REFUSEs on
 * resume. `pricing === null` ⇒ `priceProduct:null` ⇒ clean product_not_found REFUSE.
 */
export function buildOpsPriceResumeState(
  pricing: OpsResolverPriceProduct | null,
  opts: { staffId: string; tenantId: string },
): unknown {
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId: opts.staffId,
      tenantId: opts.tenantId,
    },
    priceProduct: pricing,
  };
}

/**
 * SCN-114 — build the `menu.special.set` ops SystemState for the RESUME path
 * ("sim"). Like the price resume ({@link buildOpsPriceResumeState}), the ops
 * confirm-resume re-adjudicates the VERBATIM parked envelope, but the shared
 * customer-plane resume enrichment is scoped to a real `customerId` — the ops
 * plane's `staff:<id>` owns no products, so it would project `special:undefined`
 * and REFUSE a valid "sim". This builder re-projects the SAME `{ ctx, special }`
 * shape from a FRESH product read of the parked (resolver-rewritten, trusted)
 * productId + a FRESH `todayYmd` — date-safe: a special parked for a day that is
 * now in the past REFUSEs on resume via `requireSpecialDateNotPast`.
 * `product === null` ⇒ clean product_not_found REFUSE.
 */
export function buildOpsSpecialResumeState(
  product: OpsResolverSpecialProduct | null,
  opts: { staffId: string; tenantId: string },
): unknown {
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId: opts.staffId,
      tenantId: opts.tenantId,
    },
    special: { product, todayYmd: todayInRestaurantTz() },
  };
}

/**
 * FE-T05b (live-disproof follow-up) — map a raw first-party order-projection
 * read into the {@link OpsResolverOrder} shape. Pulled out as a named,
 * SHARED function (rather than the inline object-literal each call site
 * previously hand-rolled) so the plan-stage `lookupOrder` wiring and the
 * `order.status.transition` RESUME re-projection
 * ({@link buildOpsOrderStatusTransitionResumeState}) read the SAME shape
 * off the SAME first-party fields — the two paths must never independently
 * drift on what "the order's ops-relevant state" means.
 */
export function toOpsResolverOrder(order: {
  readonly customerId: string | null;
  readonly paymentMethod: unknown;
  readonly paymentStatus: string | null;
  readonly totalInCentavos: number;
  readonly fulfillmentStatus: unknown;
}): OpsResolverOrder {
  return {
    customerId: order.customerId,
    paymentMethod: (order.paymentMethod as string | null) ?? null,
    paymentStatus: order.paymentStatus,
    totalInCentavos: order.totalInCentavos,
    fulfillmentStatus: (order.fulfillmentStatus as string | null) ?? null,
  };
}

/**
 * FE-T05b (live-disproof follow-up) — build the `order.status.transition` ops
 * `SystemState` for the RESUME path ("sim"). Live-disproved (intent_audit
 * 3362/3366): the ops confirm-resume re-adjudicates the VERBATIM parked
 * envelope, but the SHARED customer-plane resume enrichment
 * (`resolveAndAssemble` in claustrum-bootstrap.ts) is scoped to a REAL
 * `customerId` — the ops plane's `staff:<id>` is not one, so that path's type
 * guard silently no-ops (returns the capsule's bare `{channel:"system",
 * customerId:"staff:<id>"}` state, carrying NO `ctx.orderId` at all) and
 * `requireOrderIdForMutation` REFUSEs `order.not_found` on EVERY resume, even
 * though the order exists and the parked payload carries its (resolver-
 * pinned, trusted) id. This builder re-projects the SAME `{ ctx }` shape the
 * plan-stage resolver's `order.status.transition` branch builds
 * (`opsStateForEnvelope`, mirrors `toOpsResolverOrder`'s field set) from a
 * FRESH read of the PINNED `orderId` — money/state-safe: an order that
 * vanished or changed status since parking REFUSEs on resume via
 * `requireOrderIdForMutation` (null order) / `requireLegalStatusTransition`
 * (a FRESH `fulfillmentStatus` that no longer permits the parked target).
 * `orderResolutionTrust` / `displayId` are deliberately OMITTED here (unlike
 * the plan-stage projection): the id is no longer a guess by resume time — it
 * was already confirmed once — so `requireConfirmationOnGroundedStatusTransition`
 * must NOT fire a second time; omitting the field is a no-op for that guard
 * (its engagement predicate is `=== "grounded"`), and the transition falls
 * through to the ordinary EXECUTE path once legality passes.
 */
export function buildOpsOrderStatusTransitionResumeState(
  orderId: string,
  order: OpsResolverOrder | null,
): unknown {
  return {
    ctx: {
      channel: "web",
      customerId: order?.customerId ?? null,
      cartId: null,
      orderId: order === null ? null : orderId,
      fulfillmentStatus: order?.fulfillmentStatus ?? null,
    },
  };
}

/**
 * FE-D14 — build the `order.note.add` ops `SystemState` for the RESUME path.
 * `order.note.add` shares the SAME latent `enrichResumeState` gap FE-T05b
 * live-disproved (intent_audit 3362/3366) for `order.status.transition`: the
 * ops confirm-resume re-adjudicates the VERBATIM parked envelope, but the
 * SHARED customer-plane resume enrichment (`resolveAndAssemble` in
 * claustrum-bootstrap.ts) is scoped to a REAL `customerId` — the ops plane's
 * `staff:<id>` is not one, so that path's type guard silently no-ops (returns
 * the capsule's bare `{channel:"system", customerId:"staff:<id>"}` state,
 * carrying NO `ctx.orderId` at all) and `requireOrderIdForMutation` REFUSEs
 * `order.not_found` on EVERY resume, even though the order exists and the
 * parked payload carries its (resolver-pinned, trusted) id. UNREACHABLE today
 * (no confirm-forcing guard parks an `order.note.add`, so no resume cycle is
 * ever exercised — unlike `order.status.transition`'s
 * `requireConfirmationOnGroundedStatusTransition`), but pre-wired so ANY
 * future confirm/park on this ops order kind resumes correctly instead of a
 * spurious `order.not_found` REFUSE. Re-projects the SAME `{ ctx }` shape the
 * plan-stage resolver's `order.note.add` branch builds (`opsStateForEnvelope`,
 * mirrors `adjudicateAdminNote`'s `noteOrderState`) from a FRESH read of the
 * PINNED `orderId` — state-safe: an order that vanished since parking REFUSEs
 * on resume via `requireOrderIdForMutation` (null order ⇒ orderId:null).
 */
export function buildOpsOrderNoteAddResumeState(
  orderId: string,
  order: OpsResolverOrder | null,
): unknown {
  return {
    ctx: {
      channel: "web",
      customerId: order?.customerId ?? null,
      cartId: null,
      orderId: order === null ? null : orderId,
      paymentMethod: order?.paymentMethod ?? null,
      paymentStatus: order?.paymentStatus ?? null,
      totalInCentavos: order?.totalInCentavos ?? 0,
    },
  };
}

// ── BKL-164 — the four remaining ops kinds, PRE-WIRED for confirm-resume ──────
//
// product.availability.set / ops.alert.resolve.staff / incident.ticket.close.
// staff / schedule.override.set share the SAME latent `enrichResumeState` hole
// FE-T05b (order.status.transition) + FE-D14 (order.note.add) already fixed: the
// customer-scoped `resolveAndAssemble` resume fallback no-ops for the ops
// plane's `staff:<id>` "customerId" (never a real one), so it would project the
// per-kind state absent and REFUSE a valid "sim". These are LATENT today — NO
// confirm-forcing guard parks any of them (unlike order.status.transition's
// `requireConfirmationOnGroundedStatusTransition`), so no resume cycle is ever
// exercised live — but pre-wired via the shared `enrichResumeState` table so
// that ANY future confirm/park on one of these kinds resumes correctly (from a
// FRESH re-read of the parked, resolver-trusted reference) instead of a spurious
// REFUSE. Each re-projects the SAME per-kind `{ ctx, <slot> }` shape its
// plan-stage branch in `opsStateForEnvelope` builds; a null read ⇒ the clean
// not-found REFUSE the plan stage would also give.

/**
 * BKL-164 — `product.availability.set` RESUME state. Mirrors the plan-stage
 * `{ ctx, product }` (a FRESH product read of the parked productId; null ⇒
 * product_not_found REFUSE). LATENT — see the header above.
 */
export function buildOpsAvailabilityResumeState(
  product: OpsResolverProduct | null,
  opts: { staffId: string; tenantId: string },
): unknown {
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId: opts.staffId,
      tenantId: opts.tenantId,
    },
    product,
  };
}

/**
 * BKL-164 — `ops.alert.resolve.staff` RESUME state. Mirrors the plan-stage
 * `{ ctx, alert }` (a FRESH alert read of the parked alertId; null ⇒
 * not_actionable REFUSE). LATENT — see the header above.
 */
export function buildOpsAlertResumeState(
  alert: OpsResolverAlert | null,
  opts: { staffId: string; tenantId: string },
): unknown {
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId: opts.staffId,
      tenantId: opts.tenantId,
    },
    alert,
  };
}

/**
 * BKL-164 — `incident.ticket.close.staff` RESUME state. Mirrors the plan-stage
 * `{ ctx, incident }` (a FRESH incident read of the parked incidentId; null ⇒
 * not_actionable REFUSE). LATENT — see the header above.
 */
export function buildOpsIncidentResumeState(
  incident: OpsResolverIncident | null,
  opts: { staffId: string; tenantId: string },
): unknown {
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId: opts.staffId,
      tenantId: opts.tenantId,
    },
    incident,
  };
}

/**
 * BKL-164 — `schedule.override.set` RESUME state. Mirrors the plan-stage
 * `{ ctx, schedule: { today } }`. This kind is a keyless UPSERT — no entity to
 * re-read — so the resume re-projects the ctx + a FRESH `today` (RESTAURANT_
 * TIMEZONE) that `requireScheduleDateActionable` re-reads on resume, so a
 * parked date that is now in the past REFUSEs. LATENT — see the header above.
 */
export function buildOpsScheduleResumeState(
  opts: { staffId: string; tenantId: string },
): unknown {
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId: opts.staffId,
      tenantId: opts.tenantId,
    },
    schedule: { today: todayInRestaurantTz() },
  };
}

/** The ops order-mutation kinds whose `payload.orderId` the model can bleed
 *  across turns from the conversation-history block (BKL-150a). */
const ORDER_REF_BLEED_KINDS: ReadonlySet<string> = new Set([
  "order.status.transition",
  "order.note.add",
]);

/**
 * BKL-150(a) — detect a STALE cross-turn order-reference BLEED: on a staff
 * session the model can copy a PRIOR turn's order reference (a display NUMBER or
 * a customer NAME) out of the fenced conversation-history block (ops-history.ts,
 * prompt CONTEXT only) into a NEW turn's `payload.orderId`, even when the CURRENT
 * message names no such order — the resolver would then resolve that stale
 * reference authoritatively and the guard would REFUSE (order not found /
 * illegal), MASKING the staff's actual request.
 *
 * A model-supplied reference is HONORED only when it is grounded in the current
 * message (`orderReferenceAppearsInMessage` — display-id digits, or every
 * normalized name token, present); a reference the message does not contain is a
 * bleed. Fail-safe: an absent/empty message ⇒ NOT a bleed (we cannot classify,
 * so we HONOR the reference exactly as before — production always supplies the
 * text; every text-less caller/test stays byte-identical).
 */
function isStaleOrderRefBleed(
  rawOrderId: unknown,
  requestText: string,
): boolean {
  if (typeof rawOrderId !== "string" || rawOrderId.trim() === "") return false;
  if (requestText.trim() === "") return false; // no message → cannot classify → honor (legacy)
  return !orderReferenceAppearsInMessage(rawOrderId, requestText);
}

/**
 * BKL-150(a) — strip a stale cross-turn order-reference bleed from an ops
 * order-mutation payload BEFORE resolution, so the turn never silently acts on
 * (or refuses because of) a prior-turn order. With `orderId` gone,
 * `order.status.transition` falls through to the auto-resolve-most-recent path
 * (a GROUNDED target that FORCES a confirmation NAMING the order — a wrong one is
 * catchable, never silently acted on — demote-only, never a bleed-specific hard
 * refuse), and `order.note.add` (which has no auto-resolve) REFUSEs `no_order`
 * honestly ("which order?") — the same honest path any unresolvable note-add
 * takes, never a silent write to the stale order. Only the two
 * {@link ORDER_REF_BLEED_KINDS} are scrubbed; every other kind (and a reference
 * the current message DOES contain) is returned verbatim.
 */
function scrubStaleOrderBleed(
  kind: string,
  payload: Record<string, unknown>,
  requestText: string,
): Record<string, unknown> {
  if (!ORDER_REF_BLEED_KINDS.has(kind)) return payload;
  if (!isStaleOrderRefBleed(payload.orderId, requestText)) return payload;
  logger.info(
    {
      component: "ops-resolver",
      event: "order.stale_ref_bleed_scrubbed",
      kind,
      from: payload.orderId,
    },
    "ops order reference is a stale cross-turn bleed (absent from the current message) — scrubbed so this turn does not act on a prior-turn order (BKL-150a)",
  );
  const { orderId: _dropped, ...rest } = payload;
  return rest;
}

/**
 * Build the per-kind ops `SystemState` for one planned envelope, plus an
 * OPTIONAL rewritten payload (BKL-089 availability name-resolution). Returns
 * `state: undefined` for an unrecognized kind so the loop falls back to the
 * turn's `resolution.state` (the composed router still REFUSEs an off-surface
 * kind via `staffRoleGuard`'s de-vacuum, so this never widens authority).
 *
 * `requestText` is the CURRENT staff message (`cognition.perception.text`) —
 * used ONLY by the BKL-150a stale-order-number-bleed scrub; empty when a caller
 * supplies no perception (then the scrub is inert, legacy behavior).
 */
async function opsStateForEnvelope(
  deps: OpsResolverDeps,
  envelope: IntentEnvelope,
  requestText: string,
): Promise<OpsEnvelopeResolution> {
  const rawPayload = (envelope.payload ?? {}) as Record<string, unknown>;
  const payload = scrubStaleOrderBleed(envelope.kind, rawPayload, requestText);
  // A stale-bleed scrub must reach the WIRE (not only the resolution), so a
  // branch that otherwise leaves the payload untouched still emits the scrubbed
  // one — the audited envelope never carries the dropped stale number.
  const wasScrubbed = payload !== rawPayload;

  if (envelope.kind === "product.availability.set") {
    const { product, payload: rewritten } = await resolveAvailabilityTarget(
      deps,
      payload,
    );
    return {
      state: {
        ctx: {
          channel: "staff",
          customerId: null,
          staffId: deps.staffId,
          tenantId: deps.tenantId,
        },
        product,
      },
      ...(rewritten ? { payload: rewritten } : {}),
    };
  }

  if (envelope.kind === "product.price.set") {
    // NEW-004 — project the pricing snapshot (name + current uniform price +
    // divergent-variant flag) so the pack guards can REFUSE a
    // missing/per-variation product and the UNTRUSTED CONFIRM prompt can show
    // name + old→new. Reuses the SAME BKL-089 name→id resolution as availability
    // (persona fills productId with the product name when it has no id).
    const { priceProduct, payload: rewritten } = await resolvePriceTarget(
      deps,
      payload,
    );
    // BKL-156 — stamp the resolved display name for the EXECUTE render, ONLY on
    // the name-resolved path (`rewritten` present), mirroring availability: a
    // direct-id hit stays byte-identical (the render degrades to the generic
    // form). Absent/blank name ⇒ no stamp (degrade, never fabricate).
    const priceName = priceProduct?.name?.trim();
    const pricePayload =
      rewritten !== undefined && priceName !== undefined && priceName !== ""
        ? { ...rewritten, productName: priceName }
        : rewritten;
    return {
      state: {
        ctx: {
          channel: "staff",
          customerId: null,
          staffId: deps.staffId,
          tenantId: deps.tenantId,
        },
        priceProduct,
      },
      ...(pricePayload ? { payload: pricePayload } : {}),
    };
  }

  if (envelope.kind === "menu.special.set") {
    // SCN-114 — resolve product (name→id), date ("hoje"/"amanhã" → concrete
    // YYYY-MM-DD in RESTAURANT_TIMEZONE) and the promo price (reais → integer
    // centavos, BKL-094 shape). Build a CANONICAL payload so the closed-key guard
    // sees ONLY {productId, date, promoPriceCentavos?} and the kernel adjudicates
    // + the executor writes the RESOLVED values (the rebuilt intentHash covers
    // them). Project today's date so `requireSpecialDateNotPast` reads an
    // auditable clock reading, never its own.
    const productIdRaw =
      typeof payload.productId === "string" ? payload.productId : "";
    const dateRaw = typeof payload.date === "string" ? payload.date : "";
    const todayYmd = todayInRestaurantTz();
    const { product } = await resolveSpecialTarget(deps, productIdRaw);
    const promoCentavos = resolveSpecialPromoCentavos(payload);
    // BKL-156 — the special product lookup carries the display name; stamp it
    // for the EXECUTE render (blank/absent ⇒ no stamp, degrade never fabricate).
    const specialName = product?.name?.trim();
    const canonical: Record<string, unknown> = {
      productId: product ? product.id : productIdRaw,
      date: resolveSpecialDateYmd(dateRaw, todayYmd),
      ...(promoCentavos !== undefined
        ? { promoPriceCentavos: promoCentavos }
        : {}),
      ...(specialName !== undefined && specialName !== ""
        ? { productName: specialName }
        : {}),
    };
    return {
      state: {
        ctx: {
          channel: "staff",
          customerId: null,
          staffId: deps.staffId,
          tenantId: deps.tenantId,
        },
        special: { product, todayYmd },
      },
      payload: canonical,
    };
  }

  if (envelope.kind === "order.note.add") {
    const { order, orderId, payload: rewritten } = await resolveOrderTarget(
      deps,
      envelope,
      payload,
    );
    // Mirror adjudicateAdminNote's noteOrderState (the proven admin-note state).
    // Missing order ⇒ orderId:null ⇒ requireOrderIdForMutation REFUSEs no_order.
    return {
      state: {
        ctx: {
          channel: "web",
          customerId: order?.customerId ?? null,
          cartId: null,
          orderId,
          paymentMethod: order?.paymentMethod ?? null,
          paymentStatus: order?.paymentStatus ?? null,
          totalInCentavos: order?.totalInCentavos ?? 0,
        },
      },
      ...(rewritten ? { payload: rewritten } : wasScrubbed ? { payload } : {}),
    };
  }

  if (envelope.kind === "order.status.transition") {
    const {
      order,
      orderId,
      orderResolutionTrust,
      displayId,
      orderNamedInMessage,
      payload: resolvedPayload,
    } = await resolveStatusTransitionOrderTarget(deps, envelope, payload, requestText);
    // BKL-150(b) — normalize a locale/pt-BR status token (cancelled → canceled;
    // cancelado/pronto/… → the en-US enum) via the single-source
    // `normalizeOrderStatusToken` (@ibatexas/types) so the strict BKL-090 guard
    // sees the canonical token. Applied over the (possibly orderId-rewritten)
    // payload; only rewrites when the token actually differs, else the payload
    // passes through unchanged (byte-identical). An UNKNOWN token is returned
    // verbatim by the normalizer, so the guard still fails closed on it.
    const base = resolvedPayload ?? payload;
    const rawNewStatus = base.newStatus;
    const normStatus =
      typeof rawNewStatus === "string"
        ? normalizeOrderStatusToken(rawNewStatus)
        : rawNewStatus;
    const statusChanged =
      typeof rawNewStatus === "string" && normStatus !== rawNewStatus;
    const rewritten = statusChanged
      ? { ...base, newStatus: normStatus }
      : (resolvedPayload ?? (wasScrubbed ? payload : undefined));
    if (statusChanged) {
      logger.info(
        {
          component: "ops-resolver",
          event: "order.status_transition.token_normalized",
          from: rawNewStatus,
          to: normStatus,
        },
        "ops order.status.transition: normalized a locale/pt-BR status token to the canonical en-US enum before adjudication (BKL-150b)",
      );
    }
    // The pack-orders OrderState the BKL-090 `requireLegalStatusTransition`
    // guard reads: `ctx.orderId` (requireOrderIdForMutation) + the CURRENT
    // `ctx.fulfillmentStatus` (the legality guard). Missing order ⇒ orderId:null
    // ⇒ requireOrderIdForMutation REFUSEs `no_order` BEFORE the legality guard;
    // and an absent status on this `admin:` plane fails the legality guard closed.
    // FE-T05 — `orderResolutionTrust` is the HydratedIntentIR provenance signal
    // the pack-orders `requireConfirmationOnGroundedStatusTransition` guard
    // reads: a `grounded` (auto-resolved "most recent order") target forces a
    // REQUEST_CONFIRMATION; `authoritative` (an explicit staff reference) does
    // not. Absent (no order resolved at all) is a no-op — requireOrderIdForMutation
    // REFUSEs first. `displayId` (MAJOR-2 review fix) rides alongside it so the
    // confirm guard can NAME the order in its prompt.
    return {
      state: {
        ctx: {
          channel: "web",
          customerId: order?.customerId ?? null,
          cartId: null,
          orderId,
          fulfillmentStatus: order?.fulfillmentStatus ?? null,
          ...(orderResolutionTrust ? { orderResolutionTrust } : {}),
          ...(displayId !== undefined ? { displayId } : {}),
          ...(orderNamedInMessage !== undefined ? { orderNamedInMessage } : {}),
        },
      },
      ...(rewritten ? { payload: rewritten } : {}),
    };
  }

  if (envelope.kind === "payment.refund.issue") {
    // BKL-085 refunds-by-message — order-ref → active refundable payment →
    // DB-stamped balance payload (STOP-GATE B). The stamped payload is the FINAL
    // payload the envelope is rebuilt with (intentHash covers it).
    return resolveRefundTarget(deps, envelope, payload);
  }

  if (envelope.kind === "ops.alert.resolve.staff") {
    // BKL-088 — project the alert `{id,status}` from the OpsAlert read-model so
    // pack-ops' `requireAlertActionable` fails closed on an absent / terminal
    // alert BEFORE the staff-verb EXECUTE. id-literal (no NL→id): the persona
    // quotes the alert id from ops_snapshot. Absent dep / absent id ⇒ null ⇒
    // honest REFUSE not_actionable.
    const alertId = typeof payload.alertId === "string" ? payload.alertId : "";
    const alert =
      alertId === "" || deps.lookupAlert === undefined
        ? null
        : await safeLookup(() => deps.lookupAlert!(alertId), "alert");
    return {
      state: {
        ctx: {
          channel: "staff",
          customerId: null,
          staffId: deps.staffId,
          tenantId: deps.tenantId,
        },
        alert,
      },
    };
  }

  if (envelope.kind === "incident.ticket.close.staff") {
    // BKL-088 — project the incident `{id,status}` from the ConversationIncident
    // read-model so pack-ops' `requireIncidentActionable` fails closed on an
    // absent / terminal incident. Same id-literal / fail-closed contract as the
    // alert branch above.
    const incidentId =
      typeof payload.incidentId === "string" ? payload.incidentId : "";
    const incident =
      incidentId === "" || deps.lookupIncident === undefined
        ? null
        : await safeLookup(
            () => deps.lookupIncident!(incidentId),
            "incident",
          );
    return {
      state: {
        ctx: {
          channel: "staff",
          customerId: null,
          staffId: deps.staffId,
          tenantId: deps.tenantId,
        },
        incident,
      },
    };
  }

  if (envelope.kind === "schedule.override.set") {
    // SCN-127 — an UPSERT: no entity lookup. Normalize the owner's day reference
    // ("amanhã"/"sexta"/an ISO date) to a CONCRETE ISO date in RESTAURANT_TIMEZONE
    // and STAMP it into the payload (rebuilt below with the SAME actor/taint/
    // nonce/createdAt, so the intentHash covers the resolved date) — the kernel
    // adjudicates a concrete date, never a relative word. A word we cannot resolve
    // is left VERBATIM ⇒ pack `validateScheduleOverridePayload` REFUSEs it (not an
    // ISO date) — fail-closed, never a guessed date. Project `schedule.today` so
    // pack `requireScheduleDateActionable` fails closed on a PAST date
    // deterministically (the SAME `now`/tz used to normalize the date).
    const tz = restaurantTz();
    const now = deps.now?.() ?? new Date();
    const today = localDateStr(now, tz);
    const resolvedDate = resolveOverrideDate(payload.date, tz, now);
    const rewritten =
      resolvedDate !== null && resolvedDate !== payload.date
        ? { ...payload, date: resolvedDate }
        : undefined;
    return {
      state: {
        ctx: {
          channel: "staff",
          customerId: null,
          staffId: deps.staffId,
          tenantId: deps.tenantId,
        },
        schedule: { today },
      },
      ...(rewritten ? { payload: rewritten } : {}),
    };
  }

  // Unrecognized kind — no per-envelope state (falls back to resolution.state;
  // the composed router REFUSEs an off-surface staff kind regardless).
  return {};
}

/**
 * The ops-plane ResolverPort. Composed PER REQUEST inside `composeOpsConductor`
 * (closes over the authenticated `staffId`/`tenantId`), mirroring how the
 * per-request planner closes over `staffEnvelopeActor`.
 */
export function createOpsResolver(deps: OpsResolverDeps): ResolverPort {
  return {
    async resolve({ plan, cognition }): Promise<ReadonlyArray<ResolvedEnvelope>> {
      // BKL-150a — the CURRENT staff message, used only by the stale-order-
      // number-bleed scrub. Read defensively (a text-less caller/test supplies
      // no perception ⇒ "" ⇒ the scrub is inert, byte-identical legacy path).
      const perceptionText = (
        cognition as { perception?: { text?: unknown } } | undefined
      )?.perception?.text;
      const requestText = typeof perceptionText === "string" ? perceptionText : "";
      const out: ResolvedEnvelope[] = [];
      for (const env of plan.envelopes) {
        const { state, payload } = await opsStateForEnvelope(deps, env, requestText);
        // Rebuild with the SAME actor/taint/nonce/createdAt so the intentHash is
        // canonical and the ops authority (admin:<staffId> + role) is preserved.
        // `payload` is the BKL-089 name-resolution rewrite when it fired (the
        // hash then covers the RESOLVED productId); otherwise the envelope's own
        // payload is used verbatim (byte-identical rebuild, unchanged hash).
        const rebuilt = buildEnvelope({
          kind: env.kind,
          payload: payload ?? env.payload ?? {},
          actor: env.actor,
          taint: env.taint,
          nonce: env.nonce,
          createdAt: env.createdAt,
        }) as IntentEnvelope;
        out.push(
          state === undefined
            ? { envelope: rebuilt }
            : { envelope: rebuilt, state },
        );
      }
      return out;
    },
  };
}
