// get_also_added tool
// "Clientes também adicionam" — global co-purchase affinity from Redis sorted set.
// Reads ZREVRANGEBYSCORE rk('copurchase:{productId}'), fetches details from Typesense.

import { GetAlsoAddedInputSchema, type GetAlsoAddedInput, type AgentContext } from "@ibatexas/types";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { queryProductsByIds } from "./query-products-by-ids.js";

export async function getAlsoAdded(
  input: GetAlsoAddedInput,
  _ctx: AgentContext,
): Promise<{
  products: Array<{ id: string; title: string; price: number; imageUrl?: string }>;
  label: string;
}> {
  const parsed = GetAlsoAddedInputSchema.parse(input);
  const limit = parsed.limit ?? 6;

  const redis = await getRedisClient();
  const key = rk(`copurchase:${parsed.productId}`);

  const topIds = await redis.zRangeWithScores(key, 0, limit - 1, { REV: true });

  if (topIds.length === 0) {
    return { products: [], label: "Clientes também adicionam" };
  }

  const productIds = topIds.map((e: { value: string; score: number }) => e.value);
  const products = await queryProductsByIds(productIds, limit);

  return { products, label: "Clientes também adicionam" };
}

export const GetAlsoAddedTool = {
  name: "get_also_added",
  description:
    "Retorna produtos que outros clientes costumam pedir junto com o produto especificado. Útil para sugestões após adicionar ao carrinho.",
  inputSchema: {
    type: "object",
    properties: {
      productId: { type: "string", description: "ID do produto principal" },
      limit: { type: "number", description: "Número de sugestões (padrão: 6)" },
    },
    required: ["productId"],
  },
} as const;
