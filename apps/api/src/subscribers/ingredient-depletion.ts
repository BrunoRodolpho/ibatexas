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
// NOTE: emitting an ops-alert on a stock shortfall is split to NEW-037 — this
// subscriber only logs a structured warn (it does NOT touch the ops-alert /
// FROZEN_OPS_CAUSES plane).

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { createIngredientService, createRecipeService } from "@ibatexas/domain";
import type { FastifyBaseLogger } from "fastify";
import { withDedup } from "./dedup.js";
import { pushToDlq } from "./dlq.js";

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
                // Structured warn only — the ops-alert wiring is NEW-037.
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
