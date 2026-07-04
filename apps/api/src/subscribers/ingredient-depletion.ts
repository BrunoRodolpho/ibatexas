// NATS subscriber: per-dish ingredient stock depletion (NEW-036).
//
// Listens for:
//   ibatexas.order.placed → for each ordered line, look up the product's recipe/
//                           BOM and decrement each ingredient's stock by
//                           qtyMilli × quantity.
//
// NON-KERNEL by design. Raw-ingredient stock is admin-ops inventory, NOT a
// customer money/safety path (see ingredient.service.ts header), so depletion
// calls the domain service DIRECTLY — it does NOT build a system-actor envelope
// and does NOT go through adjudicate. This is symmetric with cart-intelligence's
// own direct CustomerOrderItem writes (which reserve buildSystemEnvelope for the
// genuinely governed kinds like loyalty.stamp.add). Ingredient stock is not a
// governed intent kind.
//
// Its OWN consumer: an independent queue group ("ingredient-depletion", parallel
// to cart-intelligence's "cart-intelligence") and an independent dedup namespace
// (`depletion:${orderId}`, independent of cart-intelligence's `order:${orderId}`)
// — each queue group receives its own copy of order.placed and dedups it
// separately.
//
// FAIL-ISOLATED (mirrors cart-intelligence's order.placed handler): the body runs
// inside withDedup; a handler error is logged + routed to the DLQ and NEVER
// rethrown into the order flow. A product with no recipe (Recipe table empty
// today) is a silent no-op — not every menu item is BOM-modeled.
//
// NEW-037 — on a stock shortfall (shortfallMilli > 0) this subscriber now, IN
// ADDITION to the structured warn, OPENS a first-class ops-alert on the NEW-025
// ops-alert plane (cause `ops_ingredient_underflow`) so a manager SEES the
// underflow in the ops-alerts inbox + admin UI instead of only a log line.
//
// The depletion itself stays NON-KERNEL (direct depleteStock); the ops-alert is a
// GOVERNED kind (`ops.alert.open`) built via buildSystemEnvelope + adjudicated by
// the SYSTEM-only ops-alert policy bundle (openAlertFromEnvelope) — that split is
// intentional. The ops-alert emission is BEST-EFFORT: it runs inside its OWN
// try/catch and NEVER rethrows, so a kernel/DB failure raising it can never abort
// depletion of the remaining lines nor route the whole order.placed to the DLQ
// (depletion is the critical path). Mirrors cart-intelligence's best-effort
// awardLoyaltyStamp/updateCheckoutMetrics isolation.

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import {
  createIngredientService,
  createRecipeService,
  createOpsAlertService,
  OPS_ALERT_CAUSE_LABELS_PT,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import type { FastifyBaseLogger } from "fastify";
import { withDedup } from "./dedup.js";
import { pushToDlq } from "./dlq.js";
import { buildSystemEnvelope } from "./__shared__/system-actor-envelope.js";

type OrderPlacedItem = {
  productId: string;
  variantId: string;
  quantity: number;
  priceInCentavos?: number;
};

export async function startIngredientDepletionSubscriber(
  log?: FastifyBaseLogger,
): Promise<void> {
  // Construct the domain services ONCE (closure scope) — not per event.
  const recipeSvc = createRecipeService();
  const ingredientSvc = createIngredientService();
  // Audited ops-alert service (governed ops.alert.* chokepoint). NEW-037.
  const opsAlertSvc = createOpsAlertService({ auditSink: getAuditSink(), log });

  await subscribeNatsEvent(
    "order.placed",
    async (payload) => {
      const { orderId, items } = payload as {
        orderId: string;
        items: OrderPlacedItem[];
      };

      // Idempotency: own dedup namespace (`depletion:${orderId}`), independent of
      // cart-intelligence's `order:${orderId}`. Fail-closed two-phase guard.
      const processed = await withDedup(`depletion:${orderId}`, async () => {
        try {
          for (const item of items) {
            // A product with NO recipe → no-op (not every item is BOM-modeled).
            const recipe = await recipeSvc.getByProduct(item.productId);
            if (!recipe) continue;

            for (const line of recipe.ingredients) {
              const consumeMilli = line.qtyMilli * item.quantity;
              const res = await ingredientSvc.depleteStock(line.ingredientId, consumeMilli);
              if (res && res.shortfallMilli > 0) {
                // Stock went below what the order required (write clamped at 0).
                // (1) Structured warn — the existing NEW-036 diagnostic signal.
                log?.warn(
                  {
                    order_id: orderId,
                    product_id: item.productId,
                    ingredient_id: line.ingredientId,
                    consume_milli: consumeMilli,
                    shortfall_milli: res.shortfallMilli,
                  },
                  "[ingredient-depletion] ingredient depleted below zero — stock accuracy issue",
                );

                // (2) NEW-037 — promote the shortfall into a first-class ops-alert
                // on the NEW-025 ops-alert plane so a manager SEES it. BEST-EFFORT:
                // its OWN try/catch that logs a warn and NEVER rethrows — a kernel/DB
                // failure emitting the alert must never abort depletion of the
                // remaining lines nor route order.placed to the DLQ (mirrors
                // cart-intelligence's awardLoyaltyStamp best-effort isolation).
                try {
                  const dedupeKey = `ops_ingredient_underflow:${line.ingredientId}`;
                  const envelope = buildSystemEnvelope({
                    kind: "ops.alert.open" as const,
                    payload: {
                      cause: "ops_ingredient_underflow" as const,
                      severity: "medium" as const,
                      source: "ingredient-depletion",
                      scope: line.ingredientId,
                      title: `${OPS_ALERT_CAUSE_LABELS_PT.ops_ingredient_underflow}: ${res.name}`,
                      detail: `O insumo "${res.name}" ficou ${res.shortfallMilli} milésimos de ${res.unit} abaixo do necessário para o pedido ${orderId}.`,
                      context: {
                        orderId,
                        productId: item.productId,
                        ingredientId: line.ingredientId,
                        consumeMilli,
                        shortfallMilli: res.shortfallMilli,
                        unit: res.unit,
                      },
                      dedupeKey,
                    },
                    sourceSubject: "ingredient-depletion",
                    eventId: `ops_ingredient_underflow:${line.ingredientId}:${orderId}`,
                  });
                  const outcome = await opsAlertSvc.openAlertFromEnvelope(envelope, {});
                  if (outcome.decision.kind !== "EXECUTE") {
                    log?.warn(
                      { ingredient_id: line.ingredientId, decision: outcome.decision.kind },
                      "[ingredient-depletion] ops-alert open not authorized — skipping",
                    );
                  }
                } catch (alertErr) {
                  log?.warn(
                    {
                      order_id: orderId,
                      ingredient_id: line.ingredientId,
                      error: String(alertErr),
                    },
                    "[ingredient-depletion] ops-alert emission failed — depletion not affected",
                  );
                }
              }
            }
          }
        } catch (err) {
          // Fail-isolated: NEVER rethrow into the order flow. Route to the DLQ for
          // recovery (mirrors cart-intelligence order.placed lines ~902-910).
          log?.error(
            { order_id: orderId, error: String(err) },
            "[ingredient-depletion] order.placed handler error",
          );
          await pushToDlq("order.placed", payload as Record<string, unknown>, err, log);
        }
      });

      if (!processed) {
        log?.info({ order_id: orderId }, "[ingredient-depletion] order.placed duplicate — skipping");
      }
    },
    { queueGroup: "ingredient-depletion" },
  );
}
