// get_also_added tool
// "Clientes também adicionam" — global co-purchase affinity from Redis sorted set.
// Reads ZREVRANGEBYSCORE rk('copurchase:{productId}'), fetches details from Typesense.

import type { AgentContext } from "@ibatexas/types";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { getTypesenseClient, COLLECTION } from "../typesense/client.js";

export async function getAlsoAdded(
  input: { productId: string; limit?: number },
  _ctx: AgentContext,
): Promise<{
  products: Array<{ id: string; title: string; price: number; imageUrl?: string }>;
  label: string;
}> {
  const limit = input.limit ?? 6;

  const redis = await getRedisClient();
  const key = rk(`copurchase:${input.productId}`);

  const topIds = await redis.zRangeWithScores(key, 0, limit - 1, { REV: true });

  if (topIds.length === 0) {
    return { products: [], label: "Clientes também adicionam" };
  }

  const productIds = topIds.map((e: { value: string; score: number }) => e.value);
  const typesense = getTypesenseClient();

  const results = await typesense
    .collections<Record<string, unknown>>(COLLECTION)
    .documents()
    .search({
      q: "*",
      query_by: "title",
      filter_by: `id:[${productIds.join(",")}] && inStock:=true && published:=true`,
      per_page: limit,
    });

  const products = (results.hits ?? []).map((hit) => ({
    id: String(hit.document["id"] ?? ""),
    title: String(hit.document["title"] ?? ""),
    price: Number(hit.document["price"] ?? 0),
    imageUrl: hit.document["imageUrl"] as string | undefined,
  }));

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
