// update_preferences tool
// Writes to both Redis profile hash and Prisma CustomerPreferences.
// Allergens must always be an explicit array — never inferred (CLAUDE.md hard rule).
// Resets Redis TTL to 30 days in the same pipeline.

import type { AgentContext } from "@ibatexas/types";
import { prisma } from "@ibatexas/domain";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { PROFILE_TTL_SECONDS } from "./types.js";

export interface UpdatePreferencesInput {
  dietaryRestrictions?: string[];
  allergenExclusions?: string[];
  favoriteCategories?: string[];
}

export async function updatePreferences(
  input: UpdatePreferencesInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  if (!ctx.customerId) {
    throw new Error("Autenticação necessária para atualizar preferências.");
  }

  // Validate allergens are explicit arrays (never empty fallback from undefined)
  const allergenExclusions = Array.isArray(input.allergenExclusions)
    ? input.allergenExclusions
    : [];

  const dietaryRestrictions = Array.isArray(input.dietaryRestrictions)
    ? input.dietaryRestrictions
    : [];

  const favoriteCategories = Array.isArray(input.favoriteCategories)
    ? input.favoriteCategories
    : [];

  // Write to Prisma (durable)
  await prisma.customerPreferences.upsert({
    where: { customerId: ctx.customerId },
    create: {
      customerId: ctx.customerId,
      allergenExclusions,
      dietaryRestrictions,
      favoriteCategories,
    },
    update: {
      ...(input.allergenExclusions !== undefined ? { allergenExclusions } : {}),
      ...(input.dietaryRestrictions !== undefined ? { dietaryRestrictions } : {}),
      ...(input.favoriteCategories !== undefined ? { favoriteCategories } : {}),
    },
  });

  // Write to Redis profile hash + reset TTL
  const redis = await getRedisClient();
  const profileKey = rk(`customer:profile:${ctx.customerId}`);

  const prefsPayload = { allergenExclusions, dietaryRestrictions, favoriteCategories };

  const pipeline = redis.multi();
  pipeline.hSet(profileKey, "preferences", JSON.stringify(prefsPayload));
  pipeline.expire(profileKey, PROFILE_TTL_SECONDS);
  await pipeline.exec();

  const parts: string[] = [];
  if (allergenExclusions.length > 0)
    parts.push(`alérgenos excluídos: ${allergenExclusions.join(", ")}`);
  if (dietaryRestrictions.length > 0)
    parts.push(`restrições: ${dietaryRestrictions.join(", ")}`);
  if (favoriteCategories.length > 0)
    parts.push(`categorias favoritas: ${favoriteCategories.join(", ")}`);

  return {
    success: true,
    message:
      parts.length > 0
        ? `Preferências salvas! ${parts.join("; ")}.`
        : "Preferências atualizadas.",
  };
}

export const UpdatePreferencesTool = {
  name: "update_preferences",
  description:
    "Salva as preferências alimentares do cliente (restrições, alérgenos, categorias favoritas). Alérgenos devem sempre ser uma lista explícita — nunca infira pelo nome do prato.",
  inputSchema: {
    type: "object",
    properties: {
      dietaryRestrictions: {
        type: "array",
        items: { type: "string" },
        description: "Ex: ['vegetariano', 'sem glúten']",
      },
      allergenExclusions: {
        type: "array",
        items: { type: "string" },
        description:
          "Lista ANVISA: gluten, lactose, castanhas, amendoim, ovos, peixes, frutos_do_mar, soja",
      },
      favoriteCategories: {
        type: "array",
        items: { type: "string" },
        description: "Handles de categoria, ex: ['churrasco', 'grelhados']",
      },
    },
    required: [],
  },
} as const;
