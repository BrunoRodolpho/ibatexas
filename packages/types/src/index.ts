// @ibatexas/types
// Shared TypeScript types across all apps and packages.

export interface ApiResponse<T> {
  data: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  timestamp: string;
}

export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: string;
}
// Agent types
export type { AgentContext, AgentMessage, StreamChunk } from "./agent.types.js"

// Admin types
export type {
  AdminDashboardMetrics,
  AdminProductRow,
  OrderSummary,
} from "./admin.types.js"

// Product types
export {
  AvailabilityWindow,
  ProductType,
  Channel,
  type ProductDTO,
  type ProductVariant,
  type SearchProductsInput,
  type SearchProductsOutput,
  type ProductEmbedding,
  type QueryCacheEntry,
  type QueryLogEntry,
  type ProductIndexedEvent,
  type ProductSearchedEvent,
  type ProductViewedEvent,
  SearchProductsInputSchema,
} from "./product.types.js"
