// Customer profile types for Redis + Prisma intelligence layer

export interface RecentlyViewedItem {
  productId: string;
  viewedAt: string; // ISO 8601
}

export interface CustomerProfileCache {
  recentlyViewed: RecentlyViewedItem[];
  cartItems: string[];  // variant IDs currently in cart
  orderCount: number;
  lastOrderAt: string | null;
  lastOrderedProductIds: string[];
  preferences: {
    dietaryRestrictions: string[];
    allergenExclusions: string[];
    favoriteCategories: string[];
  } | null;
  // orderedProductScore is stored as separate Hash fields (score:{productId})
  // Access via getOrderedProductScores() below
}

export const PROFILE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const RECENTLY_VIEWED_MAX = 20;
