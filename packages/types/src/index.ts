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
