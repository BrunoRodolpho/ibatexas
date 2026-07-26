// update_preferences tool
// Writes to both Prisma (via CustomerCommandService.updatePreferencesFromEnvelope)
// and Redis profile hash. Allergens must always be an explicit array — never
// inferred (CLAUDE.md hard rule).
//
// ── BKL-242 — this tool is dispatch-only, and dispatch is post-decision ───
//
// The claustrum tool registry (apps/api/src/tools/register-ibatexas-tool-packs.ts)
// is this handler's ONLY caller. The REST profile route (apps/api/src/routes/me.ts)
// does NOT reach it — it calls the domain service's `updatePreferences` itself —
// so there is no second caller to keep a self-adjudicating entry point for, and
// the tool is converted in place rather than split into a twin the way
// `reservation.cancel` was. Registry dispatch runs on a kernel EXECUTE the
// Conductor has ALREADY adjudicated and ledger-claimed.
//
// Pre-fix this handler minted a SECOND `customer.preferences.update` envelope
// (`nonce: randomUUID()`) and re-adjudicated it via
// `updatePreferencesFromEnvelope`. That second adjudication was AUDIT-BLIND:
// `createCustomerService()` was called with no `auditSink`, so the inner run
// emitted NO governance record (live: conductor EXECUTE `intent_audit` 6172 with
// no second row behind it).
//
// Removing the inner run strictly TIGHTENS governance rather than relaxing it.
// The inner run adjudicated against the RAW `customerOnboardingPolicyBundle`;
// the Conductor adjudicates against the COMPOSED router, which is that same
// bundle PLUS the adopter guards — including `refuseAllergenMentionGuard`
// (apps/api/src/claustrum/compose-policy-packs.ts). That guard fires on
// `state.ctx.allergenMentionDetected`, a flag the RESOLVER stamps and this tool
// never set in the state it projected below, so the inner run could reach
// EXECUTE on an allergen-shaped ask that the composed router REFUSEs. The inner
// bundle was therefore a strict subset of the outer one: deleting it removes an
// unaudited decision without removing any guard coverage.
//
// The tool-boundary fail-closed allergen check below is NOT a kernel guard and
// is unchanged — it still runs on every call, before the write.

import { UpdatePreferencesInputSchema, NonRetryableError, type UpdatePreferencesInput, type AgentContext } from "@ibatexas/types"
import { createCustomerService } from "@ibatexas/domain"
import { getRedisClient } from "../redis/client.js"
import { rk } from "../redis/key.js"
import { PROFILE_TTL_SECONDS } from "./types.js"

export async function updatePreferences(
  input: UpdatePreferencesInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  const parsed = UpdatePreferencesInputSchema.parse(input)

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para atualizar preferências.")
  }

  // ── Build the IntentEnvelope ────────────────────────────────────────
  // CLAUDE.md rule #1 (audit-2026-05-24 P1-1): allergens MUST always be
  // an explicit array — never inferred. The previous version coerced an
  // omitted `allergenExclusions` to `[]` before envelope build, hiding
  // the LLM's omission as a deliberate "no exclusions" decision and
  // silently zeroing the customer's stored allergens.
  //
  // Fail-CLOSED at the tool boundary: if the LLM proposal does not
  // include an explicit array, REFUSE here. The customer must say
  // either "no allergens" (explicit `[]`) or list their allergens; the
  // LLM may not omit the field.
  if (!Array.isArray(parsed.allergenExclusions)) {
    throw new NonRetryableError(
      "Por segurança, alergias precisam ser informadas explicitamente. " +
        "Confirme se você tem alergias (ou nenhuma) antes de salvar.",
    )
  }
  const allergenExclusions = parsed.allergenExclusions

  // ── Write under the Conductor's decision ────────────────────────────
  // BKL-242: no envelope is minted here and no second adjudication runs. The
  // registry dispatched this handler because the kernel already returned
  // EXECUTE for this `customer.preferences.update` intent and claimed its
  // execution-ledger key.
  const svc = createCustomerService()
  const prefs = await svc.updatePreferences(ctx.customerId, {
    allergenExclusions,
    ...(parsed.dietaryRestrictions === undefined
      ? {}
      : { dietaryRestrictions: parsed.dietaryRestrictions }),
    ...(parsed.favoriteCategories === undefined
      ? {}
      : { favoriteCategories: parsed.favoriteCategories }),
  })

  // Update Redis profile hash + reset TTL (cache layer — stays in tools)
  const redis = await getRedisClient()
  const profileKey = rk(`customer:profile:${ctx.customerId}`)

  const pipeline = redis.multi()
  pipeline.hSet(profileKey, "preferences", JSON.stringify(prefs))
  pipeline.expire(profileKey, PROFILE_TTL_SECONDS)
  await pipeline.exec()

  const parts: string[] = []
  if (prefs.allergenExclusions.length > 0)
    parts.push(`alérgenos excluídos: ${prefs.allergenExclusions.join(", ")}`)
  if (prefs.dietaryRestrictions.length > 0)
    parts.push(`restrições: ${prefs.dietaryRestrictions.join(", ")}`)
  if (prefs.favoriteCategories.length > 0)
    parts.push(`categorias favoritas: ${prefs.favoriteCategories.join(", ")}`)

  return {
    success: true,
    message:
      parts.length > 0
        ? `Preferências salvas! ${parts.join("; ")}.`
        : "Preferências atualizadas.",
  }
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
} as const
