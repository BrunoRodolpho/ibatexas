// add_to_cart tool — add a product variant to the Medusa cart

import { AddToCartInputSchema, type AddToCartInput, type AgentContext } from "@ibatexas/types";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { MedusaRequestError } from "../medusa/client.js";
import { invalidateAllQueryCache } from "../cache/query-cache.js";
import { isAvailableNow, describeAvailabilityWindow } from "../catalog/availability.js";
import { getTypesenseClient, COLLECTION } from "../typesense/client.js";
import { assertCartOwnership } from "./assert-cart-ownership.js";
import { medusaStoreFetch } from "./_shared.js";

/** Lightweight lookup: get a product's availability window from its variant ID via Typesense.
 *  Medusa v2 removed /store/variants/{id} — search Typesense's variantsJson field instead.
 */
async function lookupProductByVariant(variantId: string): Promise<{ availabilityWindow: string } | null> {
  try {
    const client = getTypesenseClient();
    const results = await client.collections(COLLECTION).documents().search({
      q: variantId,
      query_by: "variantsJson",
      filter_by: "status:published",
      per_page: 1,
    });
    const doc = results.hits?.[0]?.document as { availabilityWindow?: string } | undefined;
    return doc?.availabilityWindow ? { availabilityWindow: doc.availabilityWindow } : null;
  } catch {
    // Fail-open: if Typesense is unavailable or no match found,
    // skip availability check and let the actual line-items POST determine validity.
    return null;
  }
}

export async function addToCart(
  input: AddToCartInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = AddToCartInputSchema.parse(input);

  await assertCartOwnership(parsed.cartId, ctx.customerId);

  // Guard: check availability window before adding to cart
  const product = await lookupProductByVariant(parsed.variantId);

  if (product && !isAvailableNow(product.availabilityWindow)) {
    const windowDesc = describeAvailabilityWindow(product.availabilityWindow);
    return {
      success: false,
      message: `Este produto só está disponível no horário de ${windowDesc}. Tente novamente nesse horário!`,
    };
  }

  let data: unknown;
  try {
    data = await medusaStoreFetch(`/store/carts/${parsed.cartId}/line-items`, {
      method: "POST",
      body: JSON.stringify({ variant_id: parsed.variantId, quantity: parsed.quantity }),
    });
  } catch (err) {
    const isMedusaErr = err instanceof MedusaRequestError;
    const isStaleVariant = isMedusaErr && (err.statusCode === 400 || err.statusCode === 404)
      && err.responseText.includes("do not exist");

    if (isStaleVariant) {
      void invalidateAllQueryCache().catch((e) =>
        console.warn("[add_to_cart] Cache invalidation failed:", (e as Error).message)
      );
      return {
        success: false,
        staleVariant: true,
        message: "Este produto não está mais disponível. Vou buscar opções atualizadas.",
      };
    }

    console.error("[add_to_cart] Medusa error:", (err as Error).message);
    return { success: false, message: "Erro ao adicionar item ao carrinho. Verifique o produto e tente novamente." };
  }

  // TODO: Add subscriber for cart.item_added when cart analytics pipeline is built
  void publishNatsEvent("cart.item_added", {
    eventType: "cart.item_added",
    cartId: parsed.cartId,
    variantId: parsed.variantId,
    quantity: parsed.quantity,
    customerId: ctx.customerId,
    sessionId: ctx.sessionId,
  }).catch((err) => console.error("[add_to_cart] NATS publish error:", (err as Error).message));

  return data;
}

export const AddToCartTool = {
  name: "add_to_cart",
  description:
    "Adiciona um produto ao carrinho. Use o variantId obtido de search_products ou get_product_details.",
  inputSchema: {
    type: "object",
    properties: {
      cartId: { type: "string", description: "ID do carrinho" },
      variantId: { type: "string", description: "ID da variante do produto" },
      quantity: { type: "number", description: "Quantidade a adicionar (mínimo 1)" },
    },
    required: ["cartId", "variantId", "quantity"],
  },
} as const;
