// get_recommendations tool
// Returns personalized product list based on customer profile.
// Fallback: bestsellers/most-ordered for new customers.

import type { AgentContext } from "@ibatexas/types";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { getTypesenseClient, COLLECTION } from "../typesense/client.js";
import type { TypesenseProductDoc } from "../mappers/product-mapper.js";

export interface GetRecommendationsOutput {
  products: Array<{
    id: string;
    title: string;
    price: number;
    imageUrl?: string;
    reason: string;
  }>;
  message: string;
}

export async function buildPersonalizedQuery(
  customerId: string,
  limit = 10,
): Promise<{ filterBy: string; sortBy: string }> {
  const redis = await getRedisClient();
  const profileKey = rk(`customer:profile:${customerId}`);
  const prefsRaw = await redis.hGet(profileKey, "preferences");
  const prefs = prefsRaw
    ? (JSON.parse(prefsRaw) as { allergenExclusions?: string[]; favoriteCategories?: string[] })
    : null;

  const filters: string[] = ["inStock:=true", "published:=true"];

  if (prefs?.allergenExclusions && prefs.allergenExclusions.length > 0) {
    filters.push(`allergens:!=[${prefs.allergenExclusions.join(",")}]`);
  }

  let sortBy = "_vector_distance:asc";

  if (prefs?.favoriteCategories && prefs.favoriteCategories.length > 0) {
    // Prefer products from favorite categories via boost
    sortBy = `_eval(categoryHandle:in [${prefs.favoriteCategories.slice(0, 3).join(",")}]):desc,rating:desc`;
  }

  return {
    filterBy: filters.join(" && "),
    sortBy,
  };
}

export async function getRecommendations(
  input: { context?: string; limit?: number },
  ctx: AgentContext,
): Promise<GetRecommendationsOutput> {
  const limit = input.limit ?? 10;

  const typesense = getTypesenseClient();

  // Authenticated: use profile-based query
  if (ctx.customerId) {
    const { filterBy, sortBy } = await buildPersonalizedQuery(ctx.customerId, limit);

    const results = await typesense
      .collections<TypesenseProductDoc>(COLLECTION)
      .documents()
      .search({
        q: "*",
        query_by: "title",
        filter_by: filterBy,
        sort_by: sortBy,
        per_page: limit,
      });

    const products = (results.hits ?? []).map((hit) => ({
      id: hit.document.id,
      title: hit.document.title,
      price: hit.document.price ?? 0,
      imageUrl: hit.document.imageUrl ?? undefined,
      reason: "Baseado nas suas preferências",
    }));

    return {
      products,
      message:
        products.length > 0
          ? `Encontrei ${products.length} produto(s) que combinam com o seu perfil!`
          : "Nenhum produto personalizado encontrado. Veja nosso cardápio completo.",
    };
  }

  // Guest: return global bestsellers from product:global:score
  const redis = await getRedisClient();
  const globalKey = rk("product:global:score");
  const topIds = await redis.zRangeWithScores(globalKey, 0, limit - 1, { REV: true });

  if (topIds.length > 0) {
    const productIds = topIds.map((e: { value: string; score: number }) => e.value);
    const results = await typesense
      .collections<TypesenseProductDoc>(COLLECTION)
      .documents()
      .search({
        q: "*",
        query_by: "title",
        filter_by: `id:[${productIds.join(",")}] && inStock:=true && published:=true`,
        per_page: limit,
      });

    const products = (results.hits ?? []).map((hit) => ({
      id: hit.document.id,
      title: hit.document.title,
      price: hit.document.price ?? 0,
      imageUrl: hit.document.imageUrl ?? undefined,
      reason: "Mais pedidos",
    }));

    if (products.length > 0) {
      return {
        products,
        message: `Confira os produtos mais pedidos!`,
      };
    }
  }

  // Cold start fallback: highest-rated products with reviewCount >= 5
  const fallbackResults = await typesense
    .collections<TypesenseProductDoc>(COLLECTION)
    .documents()
    .search({
      q: "*",
      query_by: "title",
      filter_by: "inStock:=true && published:=true && reviewCount:>=5",
      sort_by: "rating:desc",
      per_page: limit,
    });

  const products = (fallbackResults.hits ?? []).map((hit) => ({
    id: hit.document.id,
    title: hit.document.title,
    price: hit.document.price ?? 0,
    imageUrl: hit.document.imageUrl ?? undefined,
    reason: "Bem avaliado por outros clientes",
  }));

  return {
    products,
    message:
      products.length > 0
        ? "Confira os produtos mais bem avaliados!"
        : "Explore nosso cardápio completo.",
  };
}

export const GetRecommendationsTool = {
  name: "get_recommendations",
  description:
    "Retorna produtos recomendados personalizados para o cliente ou os mais pedidos para visitantes. Chame ao iniciar uma conversa com cliente que já comprou antes.",
  inputSchema: {
    type: "object",
    properties: {
      context: {
        type: "string",
        enum: ["homepage", "cart", "product_page"],
        description: "Contexto da recomendação",
      },
      limit: { type: "number", description: "Número de produtos (padrão: 10)" },
    },
    required: [],
  },
} as const;
