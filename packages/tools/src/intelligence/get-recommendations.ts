// get_recommendations tool
// Returns personalized product list based on customer profile.
// Fallback: bestsellers/most-ordered for new customers.

import type { AgentContext } from "@ibatexas/types";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { getTypesenseClient, COLLECTION } from "../typesense/client.js";
import type { TypesenseProductDoc } from "../mappers/product-mapper.js";
import { queryProductsByIds } from "./query-products-by-ids.js";

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

// BKL-137 — the POSITIVE dietary-tag filter vocabulary. These are catalog TAGS the
// owner attached to products (Typesense `tags` facet — seeded data carries
// vegetariano/vegano/sem_gluten today), NOT allergen inferences: filtering by an
// owner-attested tag is a search narrowing, never a "não contém X" assurance
// (allergen assurances stay behind the BKL-143/123 owner gate).
export const DIETARY_TAGS = ["vegetariano", "vegano", "sem_gluten", "sem_lactose"] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];

const DIETARY_TAG_LABELS: Record<DietaryTag, string> = {
  vegetariano: "vegetarianas",
  vegano: "veganas",
  sem_gluten: "sem glúten",
  sem_lactose: "sem lactose",
};

function isDietaryTag(v: unknown): v is DietaryTag {
  return typeof v === "string" && (DIETARY_TAGS as readonly string[]).includes(v);
}

export async function buildPersonalizedQuery(
  customerId: string,
  _limit = 10,
): Promise<{ filterBy: string; sortBy: string }> {
  const redis = await getRedisClient();
  const profileKey = rk(`customer:profile:${customerId}`);
  const prefsRaw = await redis.hGet(profileKey, "preferences");
  const prefs = prefsRaw
    ? (JSON.parse(prefsRaw) as { allergenExclusions?: string[]; favoriteCategories?: string[] })
    : null;

  // "status:=published" matches the Typesense schema field (not "published:=true")
  const filters: string[] = ["inStock:=true", "status:=published"];

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
  input: { context?: string; limit?: number; dietaryTag?: string },
  ctx: AgentContext,
): Promise<GetRecommendationsOutput> {
  const limit = input.limit ?? 10;

  const typesense = getTypesenseClient();

  // BKL-137 — positive dietary filter. An out-of-vocabulary value is DROPPED (the
  // model never invents a tag the facet doesn't index); a valid tag narrows every
  // Typesense path below AND bypasses the Redis bestseller path (its zset carries
  // no tag facets to filter on).
  const dietaryTag = isDietaryTag(input.dietaryTag) ? input.dietaryTag : undefined;
  const dietaryFilter = dietaryTag === undefined ? undefined : `tags:=[${dietaryTag}]`;
  const dietaryLabel = dietaryTag === undefined ? undefined : DIETARY_TAG_LABELS[dietaryTag];

  // Authenticated: use profile-based query
  if (ctx.customerId) {
    const { filterBy, sortBy } = await buildPersonalizedQuery(ctx.customerId, limit);

    const results = await typesense
      .collections<TypesenseProductDoc>(COLLECTION)
      .documents()
      .search({
        q: "*",
        query_by: "title",
        filter_by: dietaryFilter === undefined ? filterBy : `${filterBy} && ${dietaryFilter}`,
        sort_by: sortBy,
        per_page: limit,
      });

    const products = (results.hits ?? []).map((hit) => ({
      id: hit.document.id,
      title: hit.document.title,
      price: hit.document.price ?? 0,
      imageUrl: hit.document.imageUrl ?? undefined,
      reason:
        dietaryLabel === undefined ? "Baseado nas suas preferências" : `Opções ${dietaryLabel}`,
    }));

    return {
      products,
      message:
        products.length > 0
          ? dietaryLabel === undefined
            ? `Encontrei ${products.length} produto(s) que combinam com o seu perfil!`
            : `Encontrei ${products.length} opção(ões) ${dietaryLabel} para você!`
          : dietaryLabel === undefined
            ? "Nenhum produto personalizado encontrado. Veja nosso cardápio completo."
            : `Não encontrei opções ${dietaryLabel} no momento. Veja nosso cardápio completo.`,
    };
  }

  // BKL-137 — a dietary-filtered GUEST ask skips the Redis bestseller zset (no tag
  // facets there) and goes straight to the filtered Typesense query below.
  if (dietaryFilter !== undefined) {
    const filtered = await typesense
      .collections<TypesenseProductDoc>(COLLECTION)
      .documents()
      .search({
        q: "*",
        query_by: "title",
        filter_by: `inStock:=true && status:=published && ${dietaryFilter}`,
        sort_by: "rating:desc",
        per_page: limit,
      });
    const products = (filtered.hits ?? []).map((hit) => ({
      id: hit.document.id,
      title: hit.document.title,
      price: hit.document.price ?? 0,
      imageUrl: hit.document.imageUrl ?? undefined,
      reason: `Opções ${dietaryLabel}`,
    }));
    return {
      products,
      message:
        products.length > 0
          ? `Confira nossas opções ${dietaryLabel}!`
          : `Não encontrei opções ${dietaryLabel} no momento. Veja nosso cardápio completo.`,
    };
  }

  // Guest: return global bestsellers from product:global:score
  const redis = await getRedisClient();
  const globalKey = rk("product:global:score");
  const topIds = await redis.zRangeWithScores(globalKey, 0, limit - 1, { REV: true });

  if (topIds.length > 0) {
    const productIds = topIds.map((e: { value: string; score: number }) => e.value);
    const summaries = await queryProductsByIds(productIds, limit);
    const products = summaries.map((p) => ({ ...p, reason: "Mais pedidos" }));

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
      filter_by: "inStock:=true && status:=published && reviewCount:>=5",
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
    "Retorna produtos recomendados personalizados para o cliente ou os mais pedidos para visitantes. Chame ao iniciar uma conversa com cliente que já comprou antes. Também responde perguntas dietéticas (ex.: 'tem opção vegetariana?') via dietaryTag.",
  inputSchema: {
    type: "object",
    properties: {
      context: {
        type: "string",
        enum: ["homepage", "cart", "product_page"],
        description: "Contexto da recomendação",
      },
      limit: { type: "number", description: "Número de produtos (padrão: 10)" },
      dietaryTag: {
        type: "string",
        enum: ["vegetariano", "vegano", "sem_gluten", "sem_lactose"],
        description:
          "Filtro dietético POSITIVO por tag do catálogo (use quando o cliente pedir opções vegetarianas/veganas/sem glúten/sem lactose). NÃO é garantia de ausência de alérgenos.",
      },
    },
    required: [],
  },
} as const;
