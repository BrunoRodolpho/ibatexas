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
