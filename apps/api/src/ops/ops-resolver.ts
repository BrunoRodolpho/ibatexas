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
import { isTerminalPaymentStatus, type PaymentStatus } from "@ibatexas/types";
import { logger } from "../lib/logger.js";
import {
  resolveProductByName,
  type ListProductsByName,
} from "./ops-product-resolution.js";
import {
  resolveOrderByReference,
  type OrderReferenceReads,
} from "./ops-order-resolution.js";

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
  if (payment === null) return { ctx: { exists: false } };
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
    return {
      product: { id: resolution.product.id, status: resolution.product.status },
      payload: { ...payload, productId: resolution.product.id },
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
 * the canonical payload. `refundAmountCentavos` defaults to the FULL refundable
 * balance when the model omits it (a bare "reembolsa o pedido X" is a full
 * refund) — the UNTRUSTED taint overlay parks it for confirmation regardless, so
 * the staff still confirms the exact number.
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
  // resolution: direct id, then displayId / customer-name). We need only the id.
  const { orderId } = await resolveOrderTarget(deps, envelope, payload);
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
  // controls only the amount (defaulting to the full refundable balance) + reason.
  const refundableBalance =
    payment.amountInCentavos - payment.refundedAmountCentavos;
  const rawAmount = payload.refundAmountCentavos;
  const modelAmount =
    typeof rawAmount === "number" &&
    Number.isInteger(rawAmount) &&
    rawAmount > 0
      ? rawAmount
      : refundableBalance;
  const rawReason = payload.reason;
  const reason =
    typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.slice(0, OPS_REFUND_REASON_MAX)
      : "Reembolso solicitado pela operação (ops).";

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
 * Build the per-kind ops `SystemState` for one planned envelope, plus an
 * OPTIONAL rewritten payload (BKL-089 availability name-resolution). Returns
 * `state: undefined` for an unrecognized kind so the loop falls back to the
 * turn's `resolution.state` (the composed router still REFUSEs an off-surface
 * kind via `staffRoleGuard`'s de-vacuum, so this never widens authority).
 */
async function opsStateForEnvelope(
  deps: OpsResolverDeps,
  envelope: IntentEnvelope,
): Promise<OpsEnvelopeResolution> {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;

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
      ...(rewritten ? { payload: rewritten } : {}),
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
      ...(rewritten ? { payload: rewritten } : {}),
    };
  }

  if (envelope.kind === "order.status.transition") {
    const { order, orderId, payload: rewritten } = await resolveOrderTarget(
      deps,
      envelope,
      payload,
    );
    // The pack-orders OrderState the BKL-090 `requireLegalStatusTransition`
    // guard reads: `ctx.orderId` (requireOrderIdForMutation) + the CURRENT
    // `ctx.fulfillmentStatus` (the legality guard). Missing order ⇒ orderId:null
    // ⇒ requireOrderIdForMutation REFUSEs `no_order` BEFORE the legality guard;
    // and an absent status on this `admin:` plane fails the legality guard closed.
    return {
      state: {
        ctx: {
          channel: "web",
          customerId: order?.customerId ?? null,
          cartId: null,
          orderId,
          fulfillmentStatus: order?.fulfillmentStatus ?? null,
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
    async resolve({ plan }): Promise<ReadonlyArray<ResolvedEnvelope>> {
      const out: ResolvedEnvelope[] = [];
      for (const env of plan.envelopes) {
        const { state, payload } = await opsStateForEnvelope(deps, env);
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
