// get_customer_profile tool
// Redis hot-path: read profile hash from rk('customer:profile:{customerId}')
// Prisma fallback (via CustomerService): on cache miss, hydrate from DB and populate Redis.
// Every read resets the 30-day sliding TTL.

import { GetCustomerProfileInputSchema, NonRetryableError, type GetCustomerProfileInput, type AgentContext } from "@ibatexas/types";
import { createCustomerService } from "@ibatexas/domain";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import type { CustomerProfileCache } from "./types.js";
import { PROFILE_TTL_SECONDS } from "./types.js";

const _PROFILE_FIELDS = [
  "recentlyViewed",
  "cartItems",
  "orderCount",
  "lastOrderAt",
  "lastOrderedProductIds",
  "preferences",
] as const;

export type GetCustomerProfileOutput = CustomerProfileCache & {
  customerId: string;
  orderedProductScore: Record<string, number>;
};

export async function getCustomerProfile(
  input: GetCustomerProfileInput,
  ctx: AgentContext,
): Promise<GetCustomerProfileOutput> {
  GetCustomerProfileInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para acessar perfil.");
  }

  const redis = await getRedisClient();
  const profileKey = rk(`customer:profile:${ctx.customerId}`);

  // Try Redis first
  const rawHash = await redis.hGetAll(profileKey);

  if (rawHash && Object.keys(rawHash).length > 0) {
    // Reset sliding TTL on read
    await redis.expire(profileKey, PROFILE_TTL_SECONDS);
    return parseRedisProfile(ctx.customerId, rawHash);
  }

  // Cache miss — hydrate from Prisma via CustomerService
  const svc = createCustomerService();
  const { customerPrefs, orderItems } = await svc.getProfileData(ctx.customerId);

  // Build orderedProductScore with decay formula: Σ(quantity / max(1, daysSinceOrder))
  const now = Date.now();
  const scoreMap: Record<string, number> = {};
  for (const item of orderItems) {
    const daysSince = Math.floor((now - item.orderedAt.getTime()) / (1000 * 60 * 60 * 24));
    const contribution = item.quantity / Math.max(1, daysSince);
    scoreMap[item.productId] = (scoreMap[item.productId] ?? 0) + contribution;
  }

  // Get last order's product IDs
  const lastOrderItems = orderItems.filter(
    (i) => i.medusaOrderId === orderItems[0]?.medusaOrderId,
  );

  const profile: CustomerProfileCache = {
    recentlyViewed: [],
    cartItems: [],
    orderCount: new Set(orderItems.map((i) => i.medusaOrderId)).size,
    lastOrderAt: orderItems[0]?.orderedAt.toISOString() ?? null,
    lastOrderedProductIds: lastOrderItems.map((i) => i.productId),
    preferences: customerPrefs
      ? {
          dietaryRestrictions: customerPrefs.dietaryRestrictions,
          allergenExclusions: customerPrefs.allergenExclusions,
          favoriteCategories: customerPrefs.favoriteCategories,
        }
      : null,
  };

  // Write to Redis hash
  const pipeline = redis.multi();
  pipeline.hSet(profileKey, "recentlyViewed", JSON.stringify(profile.recentlyViewed));
  pipeline.hSet(profileKey, "cartItems", JSON.stringify(profile.cartItems));
  pipeline.hSet(profileKey, "orderCount", String(profile.orderCount));
  pipeline.hSet(profileKey, "lastOrderAt", profile.lastOrderAt ?? "");
  pipeline.hSet(profileKey, "lastOrderedProductIds", JSON.stringify(profile.lastOrderedProductIds));
  pipeline.hSet(profileKey, "preferences", JSON.stringify(profile.preferences));

  for (const [productId, score] of Object.entries(scoreMap)) {
    pipeline.hSet(profileKey, `score:${productId}`, String(score));
  }

  pipeline.expire(profileKey, PROFILE_TTL_SECONDS);
  await pipeline.exec();

  return {
    ...profile,
    customerId: ctx.customerId,
    orderedProductScore: scoreMap,
  };
}

function parseRedisProfile(
  customerId: string,
  hash: Record<string, string>,
): GetCustomerProfileOutput {
  const orderedProductScore: Record<string, number> = {};
  for (const [key, value] of Object.entries(hash)) {
    if (key.startsWith("score:")) {
      orderedProductScore[key.slice(6)] = Number.parseFloat(value);
    }
  }

  return {
    customerId,
    recentlyViewed: safeParseJson(hash["recentlyViewed"], []),
    cartItems: safeParseJson(hash["cartItems"], []),
    orderCount: Number.parseInt(hash["orderCount"] ?? "0", 10),
    lastOrderAt: hash["lastOrderAt"] || null,
    lastOrderedProductIds: safeParseJson(hash["lastOrderedProductIds"], []),
    preferences: safeParseJson(hash["preferences"], null),
    orderedProductScore,
  };
}

function safeParseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const GetCustomerProfileTool = {
  name: "get_customer_profile",
  description:
    "Retorna o perfil do cliente: preferências alimentares, histórico de pedidos e produtos visualizados recentemente.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
} as const;
