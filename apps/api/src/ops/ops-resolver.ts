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
//   - order.note.add → the pack-orders `OrderState` (mirrors `adjudicateAdminNote`
//       in routes/admin/_shared-actions.ts), projected from the order projection.
//       A missing order yields a state with `ctx.orderId: null` so pack-orders'
//       `requireOrderIdForMutation` REFUSEs `no_order` (never a thrown turn).
//
// The envelope is REBUILT via `buildEnvelope` with the SAME kind/payload/actor/
// taint/nonce/createdAt (mirrors ibatexas-resolver.ts), so the kernel's
// intentHash re-derivation passes and the actor/taint the planner stamped
// (`admin:<staffId>` + role, UNTRUSTED) are preserved verbatim — the ops
// authority the composed `staffRoleGuard` gates on is unchanged.
//
// v1 posture: there is NO NL→id resolution for orders here (the chat plane's
// resolve-and-assemble is customer-scoped and not reused). A `payload.orderId`
// that is not a real id resolves to null → an honest REFUSE. NL→id order
// resolution on the ops plane is a registered follow-up.
//
// The two lookups are INJECTED (testable with fakes) and FAIL-CLOSED: a lookup
// throw is captured and treated as "not found" (never propagated), so a
// transient read error degrades to a clean REFUSE rather than crashing the turn.

import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import type { ResolvedEnvelope, ResolverPort } from "@claustrum/core";
import { logger } from "../lib/logger.js";

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
 * Build the per-kind ops `SystemState` for one planned envelope. Returns
 * `undefined` for an unrecognized kind so the loop falls back to the turn's
 * `resolution.state` (the composed router still REFUSEs an off-surface kind via
 * `staffRoleGuard`'s de-vacuum, so this never widens authority).
 */
async function opsStateForEnvelope(
  deps: OpsResolverDeps,
  envelope: IntentEnvelope,
): Promise<unknown> {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;

  if (envelope.kind === "product.availability.set") {
    const productId =
      typeof payload.productId === "string" ? payload.productId : "";
    const product =
      productId === ""
        ? null
        : await safeLookup(() => deps.lookupProduct(productId), "product");
    return {
      ctx: {
        channel: "staff",
        customerId: null,
        staffId: deps.staffId,
        tenantId: deps.tenantId,
      },
      product,
    };
  }

  if (envelope.kind === "order.note.add") {
    const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
    const order =
      orderId === ""
        ? null
        : await safeLookup(() => deps.lookupOrder(orderId), "order");
    // Mirror adjudicateAdminNote's noteOrderState (the proven admin-note state).
    // Missing order ⇒ orderId:null ⇒ requireOrderIdForMutation REFUSEs no_order.
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

  if (envelope.kind === "order.status.transition") {
    const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
    const order =
      orderId === ""
        ? null
        : await safeLookup(() => deps.lookupOrder(orderId), "order");
    // The pack-orders OrderState the BKL-090 `requireLegalStatusTransition`
    // guard reads: `ctx.orderId` (requireOrderIdForMutation) + the CURRENT
    // `ctx.fulfillmentStatus` (the legality guard). Missing order ⇒ orderId:null
    // ⇒ requireOrderIdForMutation REFUSEs `no_order` BEFORE the legality guard;
    // and an absent status on this `admin:` plane fails the legality guard closed.
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

  // Unrecognized kind — no per-envelope state (falls back to resolution.state;
  // the composed router REFUSEs an off-surface staff kind regardless).
  return undefined;
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
        const state = await opsStateForEnvelope(deps, env);
        // Rebuild with the SAME actor/taint/nonce/createdAt so the intentHash is
        // canonical and the ops authority (admin:<staffId> + role) is preserved.
        const rebuilt = buildEnvelope({
          kind: env.kind,
          payload: env.payload ?? {},
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
