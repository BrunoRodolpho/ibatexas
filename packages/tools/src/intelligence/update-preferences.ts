// update_preferences tool
// Writes to both Prisma (via CustomerService) and Redis profile hash.
// Allergens must always be an explicit array — never inferred (CLAUDE.md hard rule).

import { UpdatePreferencesInputSchema, NonRetryableError, type UpdatePreferencesInput, type AgentContext } from "@ibatexas/types";
import { createCustomerService } from "@ibatexas/domain";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";
import { PROFILE_TTL_SECONDS } from "./types.js";

export async function updatePreferences(
  input: UpdatePreferencesInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  const parsed = UpdatePreferencesInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para atualizar preferências.");
  }

  const svc = createCustomerService();
  const prefs = await svc.updatePreferences(ctx.customerId, parsed);

  // Update Redis profile hash + reset TTL (cache layer — stays in tools)
  const redis = await getRedisClient();
  const profileKey = rk(`customer:profile:${ctx.customerId}`);

  const pipeline = redis.multi();
  pipeline.hSet(profileKey, "preferences", JSON.stringify(prefs));
  pipeline.expire(profileKey, PROFILE_TTL_SECONDS);
  await pipeline.exec();

  const parts: string[] = [];
  if (prefs.allergenExclusions.length > 0)
    parts.push(`alérgenos excluídos: ${prefs.allergenExclusions.join(", ")}`);
  if (prefs.dietaryRestrictions.length > 0)
    parts.push(`restrições: ${prefs.dietaryRestrictions.join(", ")}`);
  if (prefs.favoriteCategories.length > 0)
    parts.push(`categorias favoritas: ${prefs.favoriteCategories.join(", ")}`);

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
