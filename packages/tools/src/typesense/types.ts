// Typesense-specific types for search and indexing pipelines.

import type { TypesenseProductDoc } from "../mappers/product-mapper.js"

/** A single search hit from Typesense multi_search or search response. */
export interface TypesenseHit {
  document: TypesenseProductDoc
  hybrid_search_info?: { rank_fusion_score?: number }
  text_match_score?: number
  text_match?: number
}

/** Facet count entry from Typesense search response. */
export interface TypesenseFacetCount {
  field_name: string
  counts: Array<{ value: string; count: number }>
}

/** Result of a Typesense batch import operation (per-document). */
export interface TypesenseImportResult {
  success: boolean
  error?: string
  document?: string
}

/** Typesense error shape — errors from the SDK carry httpStatus. */
export interface TypesenseError {
  httpStatus?: number
  message?: string
}

/** Type guard: narrow unknown error to TypesenseError. */
export function isTypesenseError(err: unknown): err is TypesenseError {
  return typeof err === "object" && err !== null && "httpStatus" in err
}
