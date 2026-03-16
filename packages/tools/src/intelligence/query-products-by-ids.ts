// Shared Typesense query helper — fetches product summaries by ID array.
// Used by get-also-added, get-recommendations, and get-ordered-together.

import { getTypesenseClient, COLLECTION } from "../typesense/client.js";
import type { TypesenseProductDoc } from "../mappers/product-mapper.js";

export interface ProductSummary {
  id: string;
  title: string;
  price: number;
  imageUrl?: string;
}

export async function queryProductsByIds(
  productIds: string[],
  limit: number,
): Promise<ProductSummary[]> {
  if (productIds.length === 0) return [];

  const typesense = getTypesenseClient();

  const results = await typesense
    .collections<TypesenseProductDoc>(COLLECTION)
    .documents()
    .search({
      q: "*",
      query_by: "title",
      filter_by: `id:[${productIds.join(",")}] && inStock:=true && published:=true`,
      per_page: limit,
    });

  return (results.hits ?? []).map((hit) => ({
    id: hit.document.id,
    title: hit.document.title,
    price: hit.document.price ?? 0,
    imageUrl: hit.document.imageUrl ?? undefined,
  }));
}
