/**
 * Recommendations domain — types.
 *
 * Shared interfaces for the recommendation API responses.
 * Mirrors the backend intelligence output shapes.
 */

export interface RecommendedProduct {
  id: string
  title: string
  price: number       // centavos
  imageUrl?: string
  reason?: string     // e.g. "Baseado nas suas preferências"
}

export interface RecommendationsResponse {
  products: RecommendedProduct[]
  label: string       // e.g. "Recomendado para você"
}

export interface AlsoAddedResponse {
  products: RecommendedProduct[]
  label: string       // "Clientes também adicionam"
}
